import { chmodSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { ClaudeModelCatalog } from "../claude/modelCatalog.js";
import { ClaudeService } from "../claude/service.js";
import { DEFAULT_FEATURES, type HybridConfig } from "../config/config.js";
import { startStockProcess } from "../codex/stockProcess.js";
import type { Logger } from "../observability/logger.js";
import { attachClientConnection } from "./clientConnection.js";
import { acquireSocketStartupLock, prepareUnixSocket } from "./socket.js";
import { SubscriptionHub } from "./subscriptions.js";
import { CursorCodec } from "../protocol/cursor.js";
import { probeHostCompatibility } from "../compatibility/probe.js";
import { MetricsRegistry } from "../observability/metrics.js";
import { RpcRecorder } from "../observability/rpcRecorder.js";
import { RemoteControlHub } from "./remoteControlHub.js";
import { startRemoteRelay, type RemoteRelay } from "./remoteRelay.js";
import { remoteControlEnabled } from "./remoteControlMode.js";
import { HandoffStore } from "../handoff/store.js";
import { CrossProviderForks, HANDOFF_DAEMON_CONNECTION_ID } from "../handoff/service.js";
import {
  ProviderAvailabilityService,
} from "../runtime/providerAvailability.js";
import { StockStateTracker } from "../state/stockStateTracker.js";
import { connectStock } from "../codex/stockConnection.js";
import { StockRpc } from "./stockRpc.js";
import { isRequest, parseRpcMessage } from "../protocol/envelopes.js";
import { StockSideThreads } from "./stockSideThreads.js";
import { OptimisticSideThreads } from "./optimisticSideThreads.js";

export interface GatewayServer {
  stop(): Promise<void>;
}

async function startGatewayOwner(
  config: HybridConfig,
  socketPath: string,
  stockArgs: readonly string[],
  logger: Logger,
): Promise<GatewayServer> {
  await probeHostCompatibility(config, logger);
  await prepareUnixSocket(socketPath);
  const relayEnabled = remoteControlEnabled(stockArgs);
  const stock = await startStockProcess(config, stockArgs.filter((arg) => arg !== "--remote-control"), logger);
  const metrics = new MetricsRegistry();
  const recorder = new RpcRecorder(config);
  const remoteControl = relayEnabled ? new RemoteControlHub() : undefined;
  const claudeModels = new ClaudeModelCatalog(config, logger, metrics);
  await claudeModels.list().catch((error: unknown) => {
    logger.warn("compatibility.claude-unavailable", { error: error instanceof Error ? error.message : String(error) });
  });
  const subscriptions = new SubscriptionHub();
  const cursors = CursorCodec.load(config.dataDir);
  const providerAvailability = new ProviderAvailabilityService(config);
  const stockState = new StockStateTracker();
  const claude = new ClaudeService(
    config,
    subscriptions,
    logger,
    undefined,
    undefined,
    claudeModels,
    metrics,
    undefined,
    undefined,
    undefined,
    async () => {
      const availability = await providerAvailability.read("claude");
      return availability.state === "ready" ? availability : providerAvailability.refresh("claude");
    },
  );
  await claude.ready();
  const features = config.features ?? DEFAULT_FEATURES;
  const handoffs = new CrossProviderForks(
    new HandoffStore(join(config.dataDir, "handoffs.sqlite")),
    claude,
    config.renamePrompt ?? null,
  );
  handoffs.configureSubscriptions(subscriptions);
  const handoffStock = connectStock(stock.socketPath);
  const handoffStockRpc = new StockRpc(handoffStock);
  const stockSideThreads = new StockSideThreads(
    features.sideChatPromotion,
    handoffStockRpc,
    logger,
  );
  handoffStock.on("message", (data, isBinary) => {
    const message = isBinary ? undefined : parseRpcMessage(data);
    if (!message || handoffStockRpc.handle(message) || !("method" in message)) return;
    const internal = handoffs.captureInternalStockMessage(HANDOFF_DAEMON_CONNECTION_ID, message);
    const target = !internal
      && handoffs.suppressStockTargetMessage(HANDOFF_DAEMON_CONNECTION_ID, message);
    const projected = !internal && !target && handoffs.projectStockMessage(message);
    const side = !internal && !target && !projected
      && stockSideThreads.captureDaemonMessage(message, subscriptions);
    if ((internal || target || side) && !projected && isRequest(message) && handoffStock.readyState === WebSocket.OPEN) {
      if (side) return;
      handoffStock.send(JSON.stringify({ id: message.id, result: { decision: "decline" } }));
    }
  });
  await handoffStockRpc.initialize();
  handoffs.configureDaemonStock(handoffStockRpc);
  const optimisticSideThreads = new OptimisticSideThreads();
  await stockSideThreads.recover().catch((error: unknown) => {
    logger.warn("stock.side.recovery-failed", { error: String(error) });
  });
  const webSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  const connectionCleanups = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    if (request.url === "/readyz" || (request.url === "/healthz" && !request.headers.origin)) {
      response.writeHead(200).end("ok\n");
      return;
    }
    if (request.url === "/metrics" && !request.headers.origin) {
      response.writeHead(200, { "content-type": "application/json" }).end(`${JSON.stringify(metrics.snapshot())}\n`);
      return;
    }
    response.writeHead(request.headers.origin ? 403 : 404).end();
  });

  server.on("upgrade", (request, socket: Socket, head) => {
    if (request.url !== "/rpc") {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (client) => {
      const connection = attachClientConnection(
        client,
        stock.socketPath,
        claudeModels,
        claude,
        handoffs,
        subscriptions,
        logger,
        cursors,
        metrics,
        recorder,
        remoteControl,
        features,
        providerAvailability,
        stockState,
        stockSideThreads,
        features.optimisticSideStartup ? optimisticSideThreads : undefined,
      );
      connectionCleanups.add(connection.closed);
      const untrack = () => connectionCleanups.delete(connection.closed);
      void connection.closed.then(untrack, (error: unknown) => {
        untrack();
        logger.error("connection.cleanup.failed", { error: String(error) });
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  chmodSync(socketPath, 0o600);
  const closeConnections = async () => {
    for (const client of webSockets.clients) client.close(1001, "Gateway shutting down");
    const websocketClosed = new Promise<void>((resolve) => webSockets.close(() => resolve()));
    const force = setTimeout(() => {
      for (const client of webSockets.clients) client.terminate();
    }, 1_000);
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      websocketClosed,
    ]);
    clearTimeout(force);
    await Promise.allSettled(connectionCleanups);
  };
  let relay: RemoteRelay | undefined;
  try {
    if (remoteControl) relay = await startRemoteRelay(socketPath, remoteControl, logger);
  } catch (error) {
    stockSideThreads.close();
    optimisticSideThreads.close();
    await closeConnections();
    await handoffs.drain();
    handoffStockRpc.close(new Error("Gateway startup failed."));
    if (handoffStock.readyState === WebSocket.OPEN || handoffStock.readyState === WebSocket.CONNECTING) {
      handoffStock.close();
    }
    handoffs.close();
    await claude.close();
    await stock.stop();
    rmSync(socketPath, { force: true });
    throw error;
  }
  logger.info("gateway.started", { socketPath, stockSocket: stock.socketPath });

  return {
    async stop(): Promise<void> {
      await relay?.stop();
      stockSideThreads.close();
      optimisticSideThreads.close();
      await closeConnections();
      await handoffs.drain();
      handoffStockRpc.close(new Error("Gateway shutting down."));
      if (handoffStock.readyState === WebSocket.OPEN || handoffStock.readyState === WebSocket.CONNECTING) {
        handoffStock.close();
      }
      handoffs.close();
      await claude.close();
      await stock.stop();
      rmSync(socketPath, { force: true });
      logger.info("metrics.final", metrics.snapshot());
      recorder.lifecycle("recorder.stopped", { pid: process.pid });
      logger.info("gateway.stopped", { socketPath });
    },
  };
}

export async function startGateway(
  config: HybridConfig,
  socketPath: string,
  stockArgs: readonly string[],
  logger: Logger,
): Promise<GatewayServer> {
  const release = await acquireSocketStartupLock(socketPath);
  try {
    return await startGatewayOwner(config, socketPath, stockArgs, logger);
  } finally {
    release();
  }
}
