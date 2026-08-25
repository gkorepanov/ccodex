import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { unlink } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  attachClientConnection,
  type ClientConnectionHandle,
} from "../../src/gateway/clientConnection.js";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import { DEFAULT_FEATURES } from "../../src/config/config.js";
import { CursorCodec } from "../../src/protocol/cursor.js";
import { MetricsRegistry } from "../../src/observability/metrics.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { RemoteControlController } from "../../src/gateway/remoteControlController.js";

function thread(id: string, name: string, modelProvider = "openai"): Thread {
  return {
    id,
    extra: null,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    canAcceptDirectInput: true,
    preview: name,
    ephemeral: false,
    section: null, sectionEnteredAt: null, projectId: null,
    historyMode: "paginated",
    modelProvider,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    recencyAt: 1_700_000_100,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    cliVersion: "0.149.1",
    source: "appServer",
    threadSource: "user",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name,
    turns: [],
  };
}

class FakeClient extends EventEmitter {
  public readyState: number = WebSocket.OPEN;
  public readonly sent: unknown[] = [];

  public send(data: unknown): void {
    this.sent.push(JSON.parse(String(data)));
  }

  public close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  public request(id: string, method: string, params?: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify({
      id,
      method,
      ...(params === undefined ? {} : { params }),
    })), false);
  }
}

interface ConnectionHarness {
  readonly client: FakeClient;
  readonly connection: ClientConnectionHandle;
  close(): Promise<void>;
}

interface StockHarness {
  readonly socket: string;
  readonly server: Server;
  readonly wss: WebSocketServer;
  readonly clients: Set<WebSocket>;
  readonly requests: string[];
  close(): Promise<void>;
}

const connections: ConnectionHarness[] = [];
const stocks: StockHarness[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(stocks.splice(0).map((stock) => stock.close()));
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function stockHarness(active: Thread[], archived: Thread[]): Promise<StockHarness> {
  const socket = `/tmp/ccrc-${randomUUID().slice(0, 8)}.sock`;
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  const requests: string[] = [];
  server.on("upgrade", (request, connection, head) => {
    wss.handleUpgrade(request, connection, head, (client) => {
      clients.add(client);
      client.on("close", () => clients.delete(client));
      client.on("message", (data) => {
        const request = JSON.parse(String(data)) as {
          id: string;
          method: string;
          params?: { archived?: boolean };
        };
        requests.push(request.method);
        if (request.method === "thread/list") {
          client.send(JSON.stringify({
            id: request.id,
            result: {
              data: request.params?.archived ? archived : active,
              nextCursor: null,
              backwardsCursor: null,
            },
          }));
          return;
        }
        client.send(JSON.stringify({ id: request.id, result: {} }));
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  const harness: StockHarness = {
    socket,
    server,
    wss,
    clients,
    requests,
    async close() {
      for (const client of clients) client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      wss.close();
      await unlink(socket).catch(() => undefined);
    },
  };
  stocks.push(harness);
  return harness;
}

function fakeClaude(active: Thread[], archived: Thread[]) {
  return {
    listThreads: vi.fn((params: { archived?: boolean }) => params.archived ? archived : active),
    loadedThreadIds: vi.fn(() => []),
    subscribeRateLimits: vi.fn(),
    unsubscribeRateLimits: vi.fn(),
    cancelEphemeralRelease: vi.fn(),
    scheduleEphemeralRelease: vi.fn(),
    ownsThread: vi.fn(() => false),
    ownsModel: vi.fn(() => false),
    isChildProjection: vi.fn(() => false),
    resolveServerRequest: vi.fn(async () => false),
  };
}

function handoffs(activePublic: Thread, archivedPublic: Thread, readable = activePublic) {
  return {
    logical: (id: string) => id === activePublic.id || id === archivedPublic.id
      ? { epoch: { provider: "claude", backendThreadId: `${id}-backend` } }
      : undefined,
    projectThreadCatalog: (stock: Thread[], _claude: Thread[], params?: { archived?: boolean }) => [
      ...stock.filter((candidate) => candidate.id.startsWith("stock-public")),
      params?.archived ? archivedPublic : activePublic,
    ],
    projectLoadedThreadIds: (stock: string[], claude: string[]) => [...stock, ...claude],
    requestLogical: vi.fn(async (method: string, params: { threadId?: string }) => {
      if (method === "thread/read" && params.threadId === readable.id) {
        return { provider: "claude", result: { thread: readable } };
      }
      throw new Error(`unexpected logical request ${method}`);
    }),
    ownsSystemEphemeral: vi.fn(() => false),
    captureInternalStockMessage: vi.fn(() => false),
    rewriteTitleMessages: vi.fn(() => undefined),
    suppressStockTargetMessage: vi.fn(() => false),
    ownsStockBackendMessage: vi.fn(() => false),
    detachConnection: vi.fn(async () => undefined),
  };
}

async function connect(
  stock: StockHarness,
  claude: ReturnType<typeof fakeClaude>,
  logical: ReturnType<typeof handoffs>,
  subscriptions: SubscriptionHub,
  remoteControl?: RemoteControlController,
): Promise<ConnectionHarness> {
  const client = new FakeClient();
  const connection = attachClientConnection(
    client as never,
    stock.socket,
    {} as never,
    claude as never,
    logical as never,
    subscriptions,
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    new CursorCodec(Buffer.alloc(32, 9)),
    new MetricsRegistry(),
    { connection: vi.fn(), frame: vi.fn(), lifecycle: vi.fn() } as never,
    remoteControl,
    DEFAULT_FEATURES,
  );
  while (stock.clients.size === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  const harness: ConnectionHarness = {
    client,
    connection,
    async close() {
      client.emit("close", 1000, Buffer.from("done"));
      await connection.closed.catch(() => undefined);
    },
  };
  connections.push(harness);
  return harness;
}

function notifications(client: FakeClient) {
  return client.sent.filter((message): message is { method: string; params: Record<string, unknown> } =>
    Boolean(message && typeof message === "object" && "method" in message && !("id" in message)));
}

function reduceCatalog(events: ReturnType<typeof notifications>) {
  const catalog = new Map<string, { name: string | null; archived: boolean }>();
  for (const event of events) {
    if (event.method === "thread/started") {
      const value = event.params.thread as Thread;
      catalog.set(value.id, { name: value.name, archived: false });
    } else if (event.method === "thread/name/updated") {
      const threadId = event.params.threadId as string;
      const current = catalog.get(threadId) ?? { name: null, archived: false };
      catalog.set(threadId, {
        ...current,
        name: typeof event.params.threadName === "string" ? event.params.threadName : null,
      });
    } else if (event.method === "thread/archived") {
      const threadId = event.params.threadId as string;
      const current = catalog.get(threadId) ?? { name: null, archived: false };
      catalog.set(threadId, { ...current, archived: true });
    } else if (event.method === "thread/unarchived") {
      const threadId = event.params.threadId as string;
      const current = catalog.get(threadId) ?? { name: null, archived: false };
      catalog.set(threadId, { ...current, archived: false });
    } else if (event.method === "thread/deleted") {
      catalog.delete(event.params.threadId as string);
    }
  }
  return catalog;
}

describe("remote provider-owned thread catalog", () => {
  it("backfills only codex-backend with public active/archive state and hides physical epochs", async () => {
    const stockActive = thread("stock-public-active", "📈 Stock task");
    const stockArchived = thread("stock-public-archived", "📦 Stock archive");
    const physicalCurrent = thread("physical-current", "stale current");
    const physicalSealed = thread("physical-sealed", "stale sealed");
    const publicActive = thread("public-active", "❤️ XRP fable (3)", "claude");
    const publicArchived = thread("public-archived", "🧭 Old task", "claude");
    const stock = await stockHarness(
      [stockActive, physicalCurrent, physicalSealed],
      [stockArchived],
    );
    const claude = fakeClaude([], []);
    const logical = handoffs(publicActive, publicArchived);
    const subscriptions = new SubscriptionHub();
    const desktop = await connect(stock, claude, logical, subscriptions);
    const remote = await connect(stock, claude, logical, subscriptions);

    desktop.client.request("desktop-init", "initialize", {
      clientInfo: { name: "codex_app", title: "Codex Desktop", version: "1" },
    });
    remote.client.request("remote-init", "initialize", {
      clientInfo: { name: "codex-backend", title: "Codex Remote Control", version: "unknown" },
    });
    await settle();

    expect(notifications(desktop.client)).toEqual([]);
    const remoteEvents = notifications(remote.client);
    expect(remoteEvents.filter((event) => event.method === "thread/started")).toEqual(expect.arrayContaining([
      { method: "thread/started", params: { thread: stockActive } },
      { method: "thread/started", params: { thread: publicActive } },
      { method: "thread/started", params: { thread: stockArchived } },
      { method: "thread/started", params: { thread: publicArchived } },
    ]));
    expect(remoteEvents.filter((event) => event.method === "thread/name/updated")).toEqual(expect.arrayContaining([
      { method: "thread/name/updated", params: { threadId: stockActive.id, threadName: stockActive.name } },
      { method: "thread/name/updated", params: { threadId: publicActive.id, threadName: publicActive.name } },
      { method: "thread/name/updated", params: { threadId: stockArchived.id, threadName: stockArchived.name } },
      { method: "thread/name/updated", params: { threadId: publicArchived.id, threadName: publicArchived.name } },
    ]));
    expect(remoteEvents.filter((event) => event.method === "thread/deleted")).toEqual(expect.arrayContaining([
      { method: "thread/deleted", params: { threadId: physicalCurrent.id } },
      { method: "thread/deleted", params: { threadId: physicalSealed.id } },
    ]));
    expect(remoteEvents.filter((event) => event.method === "thread/archived")).toEqual(expect.arrayContaining([
      { method: "thread/archived", params: { threadId: publicArchived.id } },
    ]));

    const catalog = reduceCatalog(remoteEvents);
    expect(catalog.get(stockActive.id)).toEqual({ name: stockActive.name, archived: false });
    expect(catalog.get(publicActive.id)).toEqual({ name: publicActive.name, archived: false });
    expect(catalog.get(stockArchived.id)).toEqual({ name: stockArchived.name, archived: true });
    expect(catalog.get(publicArchived.id)).toEqual({ name: publicArchived.name, archived: true });
    expect(catalog.has(physicalCurrent.id)).toBe(false);
    expect(catalog.has(physicalSealed.id)).toBe(false);
  });

  it("is idempotent on repeated initialize and converges identically after reconnect", async () => {
    const physical = thread("physical", "stale title");
    const publicActive = thread("public", "🧪 Public title", "claude");
    const publicArchived = thread("archived", "📦 Archived title", "claude");
    const stock = await stockHarness([physical], []);
    const claude = fakeClaude([], []);
    const logical = handoffs(publicActive, publicArchived);
    const subscriptions = new SubscriptionHub();
    const first = await connect(stock, claude, logical, subscriptions);

    const initialize = {
      clientInfo: { name: "codex-backend", title: "Codex Remote Control", version: "unknown" },
    };
    first.client.request("init-1", "initialize", initialize);
    await settle();
    const firstPass = notifications(first.client);
    expect(firstPass).not.toEqual([]);
    first.client.request("init-2", "initialize", initialize);
    await settle();
    const repeatedPass = notifications(first.client).slice(firstPass.length);
    expect(repeatedPass).toEqual(firstPass);

    const second = await connect(stock, claude, logical, subscriptions);
    second.client.request("init-3", "initialize", initialize);
    await settle();
    const secondPass = notifications(second.client);

    expect(reduceCatalog([...firstPass, ...repeatedPass])).toEqual(reduceCatalog(firstPass));
    expect(reduceCatalog(secondPass)).toEqual(reduceCatalog(firstPass));
    expect(secondPass).toEqual(firstPass);
  });

  it("routes App-enabled remote control through the gateway projection and never enables stock transport", async () => {
    const physicalCurrent = thread("physical-current", "only epoch B");
    const turns = [
      { id: "turn-a", status: "completed", items: [{ type: "agentMessage", text: "CATALOG_STOCK_A" }] },
      { id: "turn-claude", status: "completed", items: [{ type: "agentMessage", text: "CATALOG_CLAUDE" }] },
      { id: "turn-b", status: "completed", items: [{ type: "agentMessage", text: "CATALOG_STOCK_B" }] },
    ];
    const publicThread = { ...thread("public", "Some title", "openai"), turns } as Thread;
    const archived = thread("archived", "Archived", "claude");
    const stock = await stockHarness([physicalCurrent], []);
    const claude = fakeClaude([], []);
    const logical = handoffs(publicThread, archived, publicThread);
    const subscriptions = new SubscriptionHub();
    const relayStop = vi.fn(async () => undefined);
    const relayStart = vi.fn(async (_socket, hub) => {
      hub.update({
        status: "connected",
        serverName: "ccodex-lab",
        installationId: "installation",
        environmentId: "environment",
      });
      return { child: {} as never, stop: relayStop };
    });
    const remoteControl = new RemoteControlController(
      stock.socket,
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      false,
      relayStart,
      vi.fn(),
    );
    const desktop = await connect(stock, claude, logical, subscriptions, remoteControl);
    desktop.client.request("desktop-init", "initialize", {
      clientInfo: { name: "codex_app", title: "Codex Desktop", version: "1" },
    });
    desktop.client.request("enable", "remoteControl/enable", { ephemeral: false });
    await settle();

    expect(relayStart).toHaveBeenCalledTimes(1);
    expect(stock.requests).not.toContain("remoteControl/enable");
    expect(desktop.client.sent).toContainEqual({ id: "enable", result: expect.objectContaining({ status: "connected" }) });

    const remote = await connect(stock, claude, logical, subscriptions, remoteControl);
    remote.client.request("remote-init", "initialize", {
      clientInfo: { name: "codex-backend", title: "Codex Remote Control", version: "unknown" },
    });
    remote.client.request("read", "thread/read", { threadId: publicThread.id, includeTurns: true });
    await settle();

    expect(remote.client.sent).toContainEqual({ id: "read", result: { thread: publicThread } });
    expect(JSON.stringify(remote.client.sent)).toContain("CATALOG_STOCK_A");
    expect(JSON.stringify(remote.client.sent)).toContain("CATALOG_CLAUDE");
    expect(JSON.stringify(remote.client.sent)).toContain("CATALOG_STOCK_B");
    expect(reduceCatalog(notifications(remote.client)).has(physicalCurrent.id)).toBe(false);
    expect(stock.requests).not.toContain("remoteControl/enable");
  });
});
