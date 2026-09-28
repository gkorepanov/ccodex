import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { ClaudeModelCatalog } from "../../src/claude/modelCatalog.js";
import { ClaudeService } from "../../src/claude/service.js";
import type { HybridConfig } from "../../src/config/config.js";
import { attachClientConnection } from "../../src/gateway/clientConnection.js";
import { CursorCodec } from "../../src/protocol/cursor.js";
import { CrossProviderForks } from "../../src/handoff/service.js";
import { HandoffStore } from "../../src/handoff/store.js";
import { MetricsRegistry } from "../../src/observability/metrics.js";
import { Logger } from "../../src/observability/logger.js";
import { RpcRecorder } from "../../src/observability/rpcRecorder.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";

const directories: string[] = [];
const servers: Server[] = [];

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "ccodex-stock-resume-"));
  directories.push(value);
  return value;
}

function config(dataDir: string): HybridConfig {
  return {
    realCodex: "/bin/false", claudeBinary: "/bin/false", dataDir,
    publicSocket: join(dataDir, "gateway.sock"), modelPrefix: "claude:",
    idleTimeoutSeconds: 900, modelCacheSeconds: 300, logLevel: "error",
    logPrompts: false, debugCapture: false, debugLogMaxBytes: 1_048_576, rpcCapture: false,
  };
}

async function listen(server: Server, path?: string): Promise<void> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (path) server.listen(path, resolve);
    else server.listen(0, "127.0.0.1", resolve);
  });
}

type RpcMessage = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

async function connect(url: string): Promise<{ socket: WebSocket; messages: RpcMessage[]; waitFor: (p: (m: RpcMessage) => boolean) => Promise<RpcMessage> }> {
  const socket = new WebSocket(url);
  const messages: RpcMessage[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as RpcMessage));
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const waitFor = async (predicate: (m: RpcMessage) => boolean): Promise<RpcMessage> => {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const match = messages.find(predicate);
      if (match) return match;
      if (Date.now() >= deadline) throw new Error("timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  };
  return { socket, messages, waitFor };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("stock thread resume-and-replay", () => {
  const threadId = "01a0e151-982a-7fc0-bc7f-5b8f5681aaf9";

  async function gateway(stockHandler: (request: RpcMessage, reply: (m: unknown) => void) => void) {
    const root = directory();
    const cfg = config(root);
    const stockSocket = join(root, "stock.sock");
    const stockServer = createServer();
    new WebSocketServer({ server: stockServer }).on("connection", (socket) => socket.on("message", (data) => {
      stockHandler(JSON.parse(data.toString()) as RpcMessage, (m) => socket.send(JSON.stringify(m)));
    }));
    await listen(stockServer, stockSocket);
    const subscriptions = new SubscriptionHub();
    const logger = new Logger("error");
    const claude = new ClaudeService(cfg, subscriptions, logger, new SqliteHybridStore(join(root, "state.sqlite")), new FakeClaudeQuery().factory);
    const handoffs = new CrossProviderForks(new HandoffStore(join(root, "handoffs.sqlite")), claude);
    const gatewayServer = createServer();
    new WebSocketServer({ server: gatewayServer }).on("connection", (socket) => attachClientConnection(
      socket, stockSocket, { list: async () => [] } as unknown as ClaudeModelCatalog, claude, handoffs, subscriptions, logger,
      CursorCodec.load(root), new MetricsRegistry(), new RpcRecorder(cfg),
    ));
    await listen(gatewayServer);
    const address = gatewayServer.address();
    if (!address || typeof address === "string") throw new Error("no TCP address");
    return connect(`ws://127.0.0.1:${address.port}`);
  }

  it("resumes an unloaded stock thread and replays turn/start once, without a banner", async () => {
    const stockRequests: RpcMessage[] = [];
    const client = await gateway((request, reply) => {
      stockRequests.push(request);
      const starts = stockRequests.filter((r) => r.method === "turn/start").length;
      if (request.method === "turn/start" && starts === 1) {
        reply({ id: request.id, error: { code: -32600, message: `thread not found: ${threadId}` } });
      } else if (request.method === "thread/resume") {
        reply({ id: request.id, result: { thread: { id: threadId, turns: [] } } });
      } else if (request.method === "turn/start") {
        reply({ id: request.id, result: { turn: { id: "turn-2", items: [], status: "inProgress" } } });
      } else {
        reply({ id: request.id, error: { code: -32602, message: `Unknown stock request '${request.method}'.` } });
      }
    });
    client.socket.send(JSON.stringify({ id: "app-7", method: "turn/start", params: { threadId, input: [{ type: "text", text: "hi" }] } }));
    const response = await client.waitFor((m) => m.id === "app-7");
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ turn: { id: "turn-2" } });
    const threadCalls = stockRequests.filter((r) => ["turn/start", "thread/resume"].includes(r.method ?? ""));
    expect(threadCalls.map((r) => r.method)).toEqual(["turn/start", "thread/resume", "turn/start"]);
    expect(threadCalls[2]?.id).toBe("app-7");
    expect((threadCalls[1]?.params as { threadId?: string })?.threadId).toBe(threadId);
    expect(client.messages.filter((m) => m.method === "item/completed")).toHaveLength(0);
    client.socket.close();
  });

  it("surfaces the original error when the resume itself fails, and never retries twice", async () => {
    const stockRequests: RpcMessage[] = [];
    const client = await gateway((request, reply) => {
      stockRequests.push(request);
      if (request.method === "thread/resume") reply({ id: request.id, error: { code: -32600, message: `thread not found: ${threadId}` } });
      else reply({ id: request.id, error: { code: -32600, message: `thread not found: ${threadId}` } });
    });
    client.socket.send(JSON.stringify({ id: "app-9", method: "turn/start", params: { threadId, input: [] } }));
    const response = await client.waitFor((m) => m.id === "app-9");
    expect(response.error?.message).toContain("thread not found");
    expect(stockRequests.filter((r) => ["turn/start", "thread/resume"].includes(r.method ?? "")).map((r) => r.method))
      .toEqual(["turn/start", "thread/resume"]);
    client.socket.close();
  });
});
