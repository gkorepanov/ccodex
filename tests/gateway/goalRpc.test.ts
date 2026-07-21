import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { ClaudeModelCatalog } from "../../src/claude/modelCatalog.js";
import { ClaudeService } from "../../src/claude/service.js";
import type {
  CompactionBoundary, ForkedTranscript, TranscriptBrancher,
} from "../../src/claude/transcriptBrancher.js";
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
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const directories: string[] = [];

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "ccodex-goal-rpc-"));
  directories.push(value);
  return value;
}

function config(dataDir: string): HybridConfig {
  return {
    realCodex: "/bin/false", claudeBinary: "/bin/false", dataDir,
    publicSocket: join(dataDir, "gateway.sock"), modelPrefix: "claude:",
    idleTimeoutSeconds: 900, modelCacheSeconds: 300, logLevel: "error",
    logPrompts: false, debugCapture: false, debugLogMaxBytes: 1_048_576,
    rpcCapture: false,
  };
}

type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

class RpcClient {
  public readonly messages: RpcMessage[] = [];
  private sequence = 0;

  private constructor(public readonly socket: WebSocket) {
    socket.on("message", (data) => this.messages.push(JSON.parse(data.toString()) as RpcMessage));
  }

  public static async connect(url: string): Promise<RpcClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new RpcClient(socket);
  }

  public async request(method: string, params: unknown): Promise<RpcMessage> {
    const id = `app-${++this.sequence}`;
    this.socket.send(JSON.stringify({ id, method, params }));
    return this.waitFor((message) => message.id === id, `${method} response`);
  }

  public async waitFor(predicate: (message: RpcMessage) => boolean, label: string): Promise<RpcMessage> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const match = this.messages.find(predicate);
      if (match) return match;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  public async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => this.socket.once("close", () => resolve()));
    this.socket.close();
    await closed;
  }
}

class RecordingTranscriptBrancher implements TranscriptBrancher {
  public readonly forks: Array<{
    sourceSessionId: string;
    boundaryUuid: string;
    expectedBoundaries: readonly string[];
    targetSessionId: string;
  }> = [];

  public async forkWithProvenance(
    sourceSessionId: string,
    boundaryUuid: string,
    _cwd: string,
    expectedBoundaries: readonly string[],
  ): Promise<ForkedTranscript> {
    const targetSessionId = randomUUID();
    this.forks.push({ sourceSessionId, boundaryUuid, expectedBoundaries, targetSessionId });
    return {
      sessionId: targetSessionId,
      uuidMap: new Map(expectedBoundaries.map((uuid) => [uuid, `forked-${uuid}`])),
    };
  }

  public async resolveCompactionBoundary(
    _sessionId: string,
    _cwd: string,
    boundary: CompactionBoundary,
  ): Promise<string> {
    return boundary.uuid;
  }

  public async delete(): Promise<void> {}
}

async function listen(server: Server, path?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (path) server.listen(path, resolve);
    else server.listen(0, "127.0.0.1", resolve);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(() => {
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Claude goal gateway RPC", () => {
  it("uses exact wire envelopes, response ordering, CAS identity, errors, and multiple subscribers", async () => {
    const root = directory();
    const cfg = config(root);
    const stockSocket = join(root, "stock.sock");
    const stockServer = createServer();
    const stockWebSockets = new WebSocketServer({ server: stockServer });
    stockWebSockets.on("connection", (socket) => socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { id: string; method: string };
      socket.send(JSON.stringify({ id: request.id, error: { code: -32602, message: `Unknown stock request '${request.method}'.` } }));
    }));
    await listen(stockServer, stockSocket);

    const store = new SqliteHybridStore(join(root, "state.sqlite"));
    const subscriptions = new SubscriptionHub();
    const logger = new Logger("error");
    const metrics = new MetricsRegistry();
    const claude = new ClaudeService(cfg, subscriptions, logger, store, new FakeClaudeQuery().factory);
    const handoffs = new CrossProviderForks(new HandoffStore(join(root, "handoffs.sqlite")), claude);
    const models = { list: async () => [] } as unknown as ClaudeModelCatalog;
    const gatewayServer = createServer();
    const gatewayWebSockets = new WebSocketServer({ server: gatewayServer });
    gatewayWebSockets.on("connection", (socket) => attachClientConnection(
      socket, stockSocket, models, claude, handoffs, subscriptions, logger,
      CursorCodec.load(root), metrics, new RpcRecorder(cfg),
    ));
    await listen(gatewayServer);
    const address = gatewayServer.address();
    if (!address || typeof address === "string") throw new Error("Gateway test server did not bind TCP.");

    const first = await RpcClient.connect(`ws://127.0.0.1:${address.port}`);
    const second = await RpcClient.connect(`ws://127.0.0.1:${address.port}`);
    const startOffset = first.messages.length;
    const started = await first.request("thread/start", {
      model: "claude:haiku", cwd: root, approvalPolicy: "never",
      approvalsReviewer: "user", sandbox: "danger-full-access",
    });
    await first.waitFor(
      (message) => message.method === "thread/started",
      "thread started notification",
    );
    expect(first.messages.slice(startOffset, startOffset + 2).map((message) => message.id ?? message.method))
      .toEqual(["app-1", "thread/started"]);
    expect(started.error).toBeUndefined();
    expect(started.result).toMatchObject({
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
      activePermissionProfile: { id: ":danger-full-access", extends: null },
    });
    const threadId = (started.result as { thread: { id: string } }).thread.id;
    const resumed = await second.request("thread/resume", { threadId, excludeTurns: false });
    expect((resumed.result as { thread: { id: string } }).thread.id).toBe(threadId);
    expect(resumed.result).toMatchObject({
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
      activePermissionProfile: { id: ":danger-full-access", extends: null },
    });

    const missingGet = await first.request("thread/goal/get", { threadId });
    expect(missingGet).toEqual({ id: "app-2", result: { goal: null } });
    const missingUpdate = await first.request("thread/goal/set", { threadId, status: "paused" });
    expect(missingUpdate.error).toEqual({
      code: -32602,
      message: `cannot update goal for thread ${threadId}: no goal exists`,
    });
    const missingClear = await first.request("thread/goal/clear", { threadId });
    expect(missingClear).toEqual({ id: "app-4", result: { cleared: false } });
    expect(first.messages.some((message) => message.method === "thread/goal/cleared")).toBe(false);

    const setStart = first.messages.length;
    const set = await first.request("thread/goal/set", {
      threadId, objective: "  exact gateway goal  ", status: "paused", tokenBudget: 20,
    });
    await first.waitFor((message) => message.method === "thread/goal/updated", "first goal notification");
    await second.waitFor((message) => message.method === "thread/goal/updated", "second goal notification");
    const firstSetFrames = first.messages.slice(setStart);
    expect(firstSetFrames[0]).toEqual(set);
    expect(firstSetFrames[1]).toEqual({
      method: "thread/goal/updated",
      params: { threadId, turnId: null, goal: (set.result as { goal: unknown }).goal },
    });
    expect(set.result).toEqual({ goal: {
      threadId, objective: "exact gateway goal", status: "paused", tokenBudget: 20,
      tokensUsed: 0, timeUsedSeconds: 0, createdAt: expect.any(Number), updatedAt: expect.any(Number),
    } });
    expect(JSON.stringify(set)).not.toContain("goalId");
    const originalGoalId = store.getGoal(threadId)!.goalId;

    const secondNotificationCount = second.messages.filter((message) => message.method === "thread/goal/updated").length;
    const updateStart = second.messages.length;
    const update = await second.request("thread/goal/set", {
      threadId, objective: "updated through second App", tokenBudget: null,
    });
    await second.waitFor(
      (_message) => second.messages.filter((message) => message.method === "thread/goal/updated").length > secondNotificationCount,
      "updated goal notification",
    );
    expect(second.messages.slice(updateStart, updateStart + 2).map((message) => message.id ?? message.method))
      .toEqual(["app-2", "thread/goal/updated"]);
    expect(update.result).toMatchObject({ goal: {
      objective: "updated through second App", status: "paused", tokenBudget: null,
    } });
    expect(store.getGoal(threadId)!.goalId).toBe(originalGoalId);
    const get = await first.request("thread/goal/get", { threadId });
    expect(get.result).toEqual(update.result);

    for (const params of [
      { threadId, objective: "   " },
      { threadId, objective: "x".repeat(4_001) },
      { threadId, tokenBudget: 0 },
    ]) {
      const response = await first.request("thread/goal/set", params);
      expect(response.error?.code).toBe(-32602);
    }

    const ephemeral = await first.request("thread/start", { model: "claude:haiku", cwd: root, ephemeral: true });
    const ephemeralId = (ephemeral.result as { thread: { id: string } }).thread.id;
    const ephemeralGoal = await first.request("thread/goal/set", { threadId: ephemeralId, objective: "nope" });
    expect(ephemeralGoal.error).toEqual({
      code: -32602,
      message: `ephemeral thread does not support goals: ${ephemeralId}`,
    });

    const firstClearCount = first.messages.filter((message) => message.method === "thread/goal/cleared").length;
    const secondClearCount = second.messages.filter((message) => message.method === "thread/goal/cleared").length;
    const clearStart = first.messages.length;
    const clear = await first.request("thread/goal/clear", { threadId });
    await first.waitFor(
      () => first.messages.filter((message) => message.method === "thread/goal/cleared").length > firstClearCount,
      "first clear notification",
    );
    await second.waitFor(
      () => second.messages.filter((message) => message.method === "thread/goal/cleared").length > secondClearCount,
      "second clear notification",
    );
    expect(first.messages.slice(clearStart, clearStart + 2)).toEqual([
      clear,
      { method: "thread/goal/cleared", params: { threadId } },
    ]);
    expect(clear.result).toEqual({ cleared: true });

    const recreated = await second.request("thread/goal/set", {
      threadId, objective: "replacement identity", status: "paused",
    });
    expect(recreated.error).toBeUndefined();
    expect(store.getGoal(threadId)!.goalId).not.toBe(originalGoalId);

    const firstServerSocket = [...gatewayWebSockets.clients][0]!;
    const originalSend = firstServerSocket.send.bind(firstServerSocket);
    const send = vi.spyOn(firstServerSocket, "send").mockImplementation(((data: WebSocket.RawData, ...args: unknown[]) => {
      const frame = JSON.parse(String(data)) as RpcMessage;
      if ((frame.result as { goal?: { objective?: string } } | undefined)?.goal?.objective === "finalize after send") {
        send.mockImplementation(originalSend);
        throw new Error("simulated response send failure");
      }
      return (originalSend as (...values: unknown[]) => unknown)(data, ...args);
    }) as typeof firstServerSocket.send);
    const notificationCount = first.messages.filter((message) => message.method === "thread/goal/updated").length;
    const failedSend = await first.request("thread/goal/set", {
      threadId, objective: "finalize after send", status: "paused",
    });
    expect(failedSend.error?.message).toContain("simulated response send failure");
    await first.waitFor(
      () => first.messages.filter((message) => message.method === "thread/goal/updated").length > notificationCount,
      "goal notification after response send failure",
    );
    expect(store.getGoal(threadId)?.objective).toBe("finalize after send");

    await Promise.all([first.close(), second.close()]);
    const disconnectDeadline = Date.now() + 2_000;
    while ((metrics.snapshot().gauges as { activeAppConnections: number }).activeAppConnections !== 0) {
      if (Date.now() >= disconnectDeadline) throw new Error("Timed out draining gateway disconnect handlers.");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await claude.close();
    handoffs.close();
    for (const socket of gatewayWebSockets.clients) socket.terminate();
    gatewayWebSockets.close();
    await closeServer(gatewayServer);
    for (const socket of stockWebSockets.clients) socket.terminate();
    stockWebSockets.close();
    await closeServer(stockServer);
  });

  it("keeps automatic App metadata RPC compatible with a live Claude child projection", async () => {
    const root = directory();
    const cfg = config(root);
    const stockSocket = join(root, "stock-child.sock");
    const stockServer = createServer();
    const stockWebSockets = new WebSocketServer({ server: stockServer });
    stockWebSockets.on("connection", (socket) => socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { id: string; method: string };
      socket.send(JSON.stringify({
        id: request.id,
        result: request.method === "thread/list"
          ? { data: [], nextCursor: null }
          : {},
      }));
    }));
    await listen(stockServer, stockSocket);

    const toolId = "child-agent-tool";
    const taskId = "child-agent-task";
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const base = { session_id: "child-app-contract", parent_tool_use_id: null };
    const messages = [
      { type: "stream_event", event: { type: "message_start", message: {} }, uuid: randomUUID(), ...base },
      {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: {
          type: "content_block_start", index: 0,
          content_block: { type: "tool_use", id: toolId, name: "Agent", input: { prompt: "Create cosine.svg" } },
        },
      },
      {
        type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolId,
        task_type: "agent", subagent_type: "general-purpose", description: "Create cosine.svg",
        prompt: "Create cosine.svg", uuid: randomUUID(), session_id: base.session_id,
      },
      {
        type: "stream_event", parent_tool_use_id: toolId, uuid: randomUUID(), session_id: base.session_id,
        event: { type: "message_start", message: {} },
      },
      {
        type: "stream_event", parent_tool_use_id: toolId, uuid: randomUUID(), session_id: base.session_id,
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      },
      {
        type: "stream_event", parent_tool_use_id: toolId, uuid: randomUUID(), session_id: base.session_id,
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cosine.svg created" } },
      },
      {
        type: "stream_event", parent_tool_use_id: toolId, uuid: randomUUID(), session_id: base.session_id,
        event: { type: "content_block_stop", index: 0 },
      },
      {
        type: "assistant", parent_tool_use_id: toolId, uuid: randomUUID(), session_id: base.session_id,
        message: { role: "assistant", content: [{ type: "text", text: "cosine.svg created" }] },
      },
      {
        type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: toolId,
        status: "completed", output_file: join(root, "unused"), summary: "cosine.svg created",
        uuid: randomUUID(), session_id: base.session_id,
      },
    ] as unknown as SDKMessage[];
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined, messages,
      { afterIndex: 7, wait: pause },
    );
    const store = new SqliteHybridStore(join(root, "child-state.sqlite"));
    const subscriptions = new SubscriptionHub();
    const logger = new Logger("error");
    const metrics = new MetricsRegistry();
    const claude = new ClaudeService(cfg, subscriptions, logger, store, fake.factory);
    const handoffs = new CrossProviderForks(new HandoffStore(join(root, "child-handoffs.sqlite")), claude);
    const models = { list: async () => [] } as unknown as ClaudeModelCatalog;
    const gatewayServer = createServer();
    const gatewayWebSockets = new WebSocketServer({ server: gatewayServer });
    gatewayWebSockets.on("connection", (socket) => attachClientConnection(
      socket, stockSocket, models, claude, handoffs, subscriptions, logger,
      CursorCodec.load(root), metrics, new RpcRecorder(cfg),
    ));
    await listen(gatewayServer);
    const address = gatewayServer.address();
    if (!address || typeof address === "string") throw new Error("Child gateway did not bind TCP.");
    const client = await RpcClient.connect(`ws://127.0.0.1:${address.port}`);

    const started = await client.request("thread/start", { model: "claude:haiku", cwd: root });
    const parentId = (started.result as { thread: { id: string } }).thread.id;
    const parentName = (started.result as { thread: { name: string | null } }).thread.name;
    const turn = await client.request("turn/start", {
      threadId: parentId,
      input: [{ type: "text", text: "spawn child", text_elements: [] }],
    });
    expect(turn.error).toBeUndefined();
    const childStarted = await client.waitFor((message) =>
      message.method === "thread/started"
      && (message.params as { thread?: { parentThreadId?: string } }).thread?.parentThreadId === parentId,
    "child thread");
    const childId = (childStarted.params as { thread: { id: string } }).thread.id;
    const childContentDeadline = Date.now() + 2_000;
    while (!JSON.stringify(claude.readThread(childId, true).thread.turns).includes("cosine.svg created")) {
      if (Date.now() >= childContentDeadline) throw new Error("Timed out waiting for projected child content.");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    const title = "📈 Построй график cos(x) ✳️";
    const automaticRename = await client.request("thread/name/set", { threadId: childId, name: title });
    const listed = await client.request("thread/list", {
      limit: 200, cursor: null, archived: false, ancestorThreadId: parentId,
      sourceKinds: ["subAgentThreadSpawn"], sortDirection: "desc", sortKey: "created_at",
      useStateDbOnly: true,
    });
    const read = await client.request("thread/read", { threadId: childId, includeTurns: true });
    const resume = await client.request("thread/resume", {
      threadId: childId, excludeTurns: true,
      initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" },
    });
    const goal = await client.request("thread/goal/get", { threadId: childId });
    for (const response of [automaticRename, listed, read, resume, goal]) expect(response.error).toBeUndefined();
    expect(automaticRename.result).toEqual({});
    expect(goal.result).toEqual({ goal: null });
    expect((listed.result as { data: Array<{ id: string; name: string | null }> }).data)
      .toContainEqual(expect.objectContaining({ id: childId, name: title }));
    expect((read.result as { thread: { name: string | null } }).thread.name).toBe(title);
    expect((resume.result as { thread: { name: string | null } }).thread.name).toBe(title);
    expect(claude.readThread(parentId, false).thread.name).toBe(parentName);

    const beforeForbidden = client.messages.length;
    const forbidden = await client.request("thread/archive", { threadId: childId });
    const forbiddenTurn = await client.request("turn/start", {
      threadId: childId,
      input: [{ type: "text", text: "mutate child", text_elements: [] }],
    });
    expect(forbidden.error?.message).toContain("read-only projection");
    expect(forbiddenTurn.error?.message).toContain("read-only projection");
    expect(client.messages.slice(beforeForbidden).filter((message) =>
      message.method === "turn/started"
      || message.method === "item/agentMessage/delta"
      || message.method === "turn/completed")).toEqual([]);

    release();
    await client.waitFor((message) =>
      message.method === "turn/completed"
      && (message.params as { threadId?: string }).threadId === parentId,
    "parent completion");
    await client.waitFor((message) =>
      message.method === "turn/completed"
      && (message.params as { threadId?: string }).threadId === childId,
    "child completion");
    const persistedChild = claude.readThread(childId, true).thread;
    expect(persistedChild.name).toBe(title);
    expect(JSON.stringify(persistedChild.turns)).not.toContain("◆ **CCodex** │ ⚠️");
    expect(claude.readThread(parentId, true).thread.turns.at(-1)?.status).toBe("completed");

    await client.close();
    await claude.close();
    handoffs.close();
    for (const socket of gatewayWebSockets.clients) socket.terminate();
    gatewayWebSockets.close();
    await closeServer(gatewayServer);
    for (const socket of stockWebSockets.clients) socket.terminate();
    stockWebSockets.close();
    await closeServer(stockServer);
  });

  it("replays App fork then rollback for two completed boundaries while a newer Claude turn remains active", async () => {
    const root = directory();
    const cfg = config(root);
    const stockSocket = join(root, "stock-fork-active.sock");
    const stockServer = createServer();
    const stockWebSockets = new WebSocketServer({ server: stockServer });
    stockWebSockets.on("connection", (socket) => socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { id: string; method: string };
      socket.send(JSON.stringify({
        id: request.id,
        error: { code: -32602, message: `Unknown stock request '${request.method}'.` },
      }));
    }));
    await listen(stockServer, stockSocket);

    const pauseSentinel = {
      type: "system", subtype: "status", status: "working",
      uuid: randomUUID(), session_id: "session",
    } as unknown as SDKMessage;
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined, [pauseSentinel],
    );
    const brancher = new RecordingTranscriptBrancher();
    const store = new SqliteHybridStore(join(root, "fork-active-state.sqlite"));
    const subscriptions = new SubscriptionHub();
    const logger = new Logger("error");
    const metrics = new MetricsRegistry();
    const claude = new ClaudeService(
      cfg, subscriptions, logger, store, fake.factory, undefined, metrics, brancher,
    );
    const handoffs = new CrossProviderForks(new HandoffStore(join(root, "fork-active-handoffs.sqlite")), claude);
    const models = { list: async () => [] } as unknown as ClaudeModelCatalog;
    const gatewayServer = createServer();
    const gatewayWebSockets = new WebSocketServer({ server: gatewayServer });
    gatewayWebSockets.on("connection", (socket) => attachClientConnection(
      socket, stockSocket, models, claude, handoffs, subscriptions, logger,
      CursorCodec.load(root), metrics, new RpcRecorder(cfg),
    ));
    await listen(gatewayServer);
    const address = gatewayServer.address();
    if (!address || typeof address === "string") throw new Error("Fork gateway did not bind TCP.");
    const client = await RpcClient.connect(`ws://127.0.0.1:${address.port}`);

    const started = await client.request("thread/start", { model: "claude:haiku", cwd: root });
    const sourceId = (started.result as { thread: { id: string } }).thread.id;
    const turnAResponse = await client.request("turn/start", {
      threadId: sourceId,
      input: [{ type: "text", text: "complete A", text_elements: [] }],
    });
    const turnAId = (turnAResponse.result as { turn: { id: string } }).turn.id;
    await client.waitFor((message) =>
      message.method === "turn/completed"
      && (message.params as { turn?: { id?: string } }).turn?.id === turnAId,
    "turn A completion");
    const boundaryA = store.getTurnClaudeMessageUuid(sourceId, turnAId);
    expect(boundaryA).toBeTruthy();

    const turnBResponse = await client.request("turn/start", {
      threadId: sourceId,
      input: [{ type: "text", text: "complete B", text_elements: [] }],
    });
    const turnBId = (turnBResponse.result as { turn: { id: string } }).turn.id;
    await client.waitFor((message) =>
      message.method === "turn/completed"
      && (message.params as { turn?: { id?: string } }).turn?.id === turnBId,
    "turn B completion");
    const boundaryB = store.getTurnClaudeMessageUuid(sourceId, turnBId);
    expect(boundaryB).toBeTruthy();

    let releaseTurnC!: () => void;
    const holdTurnC = new Promise<void>((resolve) => { releaseTurnC = resolve; });
    Reflect.set(fake, "beforeResultPause", { afterIndex: 0, wait: holdTurnC });
    const turnCResponse = await client.request("turn/start", {
      threadId: sourceId,
      input: [{ type: "text", text: "keep C active", text_elements: [] }],
    });
    const turnCId = (turnCResponse.result as { turn: { id: string } }).turn.id;
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(3));
    for (const message of [
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), session_id: "session",
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), session_id: "session",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "C_PARTIAL_SECRET" } },
      },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), session_id: "session",
        event: { type: "content_block_stop", index: 0 },
      },
    ] as unknown as SDKMessage[]) fake.emit(message, 0);
    await vi.waitFor(() => {
      const turn = claude.readThread(sourceId, true).thread.turns.find((candidate) => candidate.id === turnCId);
      expect(turn).toMatchObject({ status: "inProgress" });
      expect(JSON.stringify(turn)).toContain("C_PARTIAL_SECRET");
    });

    const sourceBeforeFork = structuredClone(claude.readThread(sourceId, true).thread);
    const sourceSessionId = store.getThreadRecord(sourceId, false)!.claudeSessionId;
    const beforeForkMessages = client.messages.length;
    const forkResponse = await client.request("thread/fork", {
      threadId: sourceId,
      lastTurnId: turnAId,
    });
    expect(forkResponse.error).toBeUndefined();
    const targetId = (forkResponse.result as { thread: { id: string } }).thread.id;
    const target = claude.readThread(targetId, true).thread;
    expect(target.turns.map((turn) => turn.id)).toEqual([turnAId]);
    expect(JSON.stringify(target)).not.toContain(turnCId);
    expect(JSON.stringify(target)).not.toContain("C_PARTIAL_SECRET");
    expect(brancher.forks[0]).toEqual(expect.objectContaining({
      sourceSessionId,
      boundaryUuid: boundaryA,
      expectedBoundaries: [boundaryA],
    }));
    expect(store.getTurnClaudeMessageUuid(targetId, turnAId)).toBe(`forked-${boundaryA}`);
    expect(claude.readThread(sourceId, true).thread).toEqual(sourceBeforeFork);
    expect(fake.prompts).toHaveLength(3);
    expect(JSON.stringify(client.messages.slice(beforeForkMessages))).not.toContain("◆ **CCodex** │ ⚠️");

    const forkLatest = await client.request("thread/fork", { threadId: sourceId });
    expect(forkLatest.error).toBeUndefined();
    const latestTargetId = (forkLatest.result as { thread: { id: string } }).thread.id;
    expect(claude.readThread(latestTargetId, true).thread.turns).toMatchObject([
      { id: turnAId, status: "completed" },
      { id: turnBId, status: "completed" },
      { id: turnCId, status: "interrupted" },
    ]);
    expect(JSON.stringify(claude.readThread(latestTargetId, true).thread)).toContain("C_PARTIAL_SECRET");
    const rolledLatest = await client.request("thread/rollback", {
      threadId: latestTargetId,
      numTurns: 1,
    });
    expect(rolledLatest.error).toBeUndefined();
    expect(claude.readThread(latestTargetId, true).thread.turns.map((turn) => turn.id))
      .toEqual([turnAId, turnBId]);
    expect(store.getTurnClaudeMessageUuid(latestTargetId, turnBId)).toBeTruthy();

    const forkOlder = await client.request("thread/fork", { threadId: sourceId });
    expect(forkOlder.error).toBeUndefined();
    const olderTargetId = (forkOlder.result as { thread: { id: string } }).thread.id;
    expect(claude.readThread(olderTargetId, true).thread.turns).toMatchObject([
      { id: turnAId, status: "completed" },
      { id: turnBId, status: "completed" },
      { id: turnCId, status: "interrupted" },
    ]);
    const rolledOlder = await client.request("thread/rollback", {
      threadId: olderTargetId,
      numTurns: 2,
    });
    expect(rolledOlder.error).toBeUndefined();
    expect(claude.readThread(olderTargetId, true).thread.turns.map((turn) => turn.id))
      .toEqual([turnAId]);
    expect(store.getTurnClaudeMessageUuid(olderTargetId, turnAId)).toBeTruthy();

    expect(claude.readThread(sourceId, true).thread).toEqual(sourceBeforeFork);
    expect(JSON.stringify(client.messages.slice(beforeForkMessages))).not.toContain("◆ **CCodex** │ ⚠️");

    await expect(claude.forkThread({ threadId: sourceId, lastTurnId: turnCId }))
      .rejects.toThrow(`Claude turn '${turnCId}' is not completed`);
    await expect(claude.forkThread({ threadId: sourceId, lastTurnId: "unknown-turn" }))
      .rejects.toThrow("Unknown Claude turn 'unknown-turn'");
    releaseTurnC();
    await client.waitFor((message) =>
      message.method === "turn/completed"
      && (message.params as { turn?: { id?: string } }).turn?.id === turnCId,
    "turn C completion");
    expect(claude.readThread(sourceId, true).thread.turns.find((turn) => turn.id === turnCId))
      .toMatchObject({ status: "completed" });
    expect(store.getThreadRecord(sourceId, false)?.claudeSessionId).toBe(sourceSessionId);
    expect(JSON.stringify(claude.readThread(sourceId, true).thread)).not.toContain("◆ **CCodex** │ ⚠️");

    await client.close();
    await claude.close();
    handoffs.close();
    for (const socket of gatewayWebSockets.clients) socket.terminate();
    gatewayWebSockets.close();
    await closeServer(gatewayServer);
    for (const socket of stockWebSockets.clients) socket.terminate();
    stockWebSockets.close();
    await closeServer(stockServer);
  });

  it("replays one byte-identical usage snapshot after each resume and a fresh service restart", async () => {
    const root = directory();
    const cfg = config(root);
    const stockSocket = join(root, "stock-usage.sock");
    const stockServer = createServer();
    const stockWebSockets = new WebSocketServer({ server: stockServer });
    stockWebSockets.on("connection", (socket) => socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { id: string };
      socket.send(JSON.stringify({ id: request.id, result: {} }));
    }));
    await listen(stockServer, stockSocket);

    const database = join(root, "usage-state.sqlite");
    const logger = new Logger("error");
    const models = { list: async () => [] } as unknown as ClaudeModelCatalog;
    const makeService = (fake: FakeClaudeQuery) => {
      const subscriptions = new SubscriptionHub();
      const store = new SqliteHybridStore(database);
      return {
        subscriptions,
        store,
        service: new ClaudeService(cfg, subscriptions, logger, store, fake.factory),
      };
    };
    const gateways: Array<{
      client: RpcClient;
      server: Server;
      webSockets: WebSocketServer;
      metrics: MetricsRegistry;
      handoffs: CrossProviderForks;
    }> = [];
    const connect = async (service: ClaudeService, subscriptions: SubscriptionHub, name: string) => {
      const metrics = new MetricsRegistry();
      const handoffs = new CrossProviderForks(
        new HandoffStore(join(root, `handoffs-${name}.sqlite`)),
        service,
      );
      const server = createServer();
      const webSockets = new WebSocketServer({ server });
      webSockets.on("connection", (socket) => attachClientConnection(
        socket, stockSocket, models, service, handoffs, subscriptions, logger,
        CursorCodec.load(root), metrics, new RpcRecorder(cfg),
      ));
      await listen(server);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Usage gateway did not bind TCP.");
      const client = await RpcClient.connect(`ws://127.0.0.1:${address.port}`);
      gateways.push({ client, server, webSockets, metrics, handoffs });
      return client;
    };
    const closeGateway = async (gateway: (typeof gateways)[number]) => {
      await gateway.client.close();
      const deadline = Date.now() + 2_000;
      while ((gateway.metrics.snapshot().gauges as { activeAppConnections: number }).activeAppConnections !== 0) {
        if (Date.now() >= deadline) throw new Error("Timed out draining usage gateway.");
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      for (const socket of gateway.webSockets.clients) socket.terminate();
      gateway.webSockets.close();
      await closeServer(gateway.server);
      gateway.handoffs.close();
    };
    const resumeSnapshot = async (client: RpcClient, threadId: string, postWatermarkMessage: string) => {
      const offset = client.messages.length;
      const response = await client.request("thread/resume", { threadId, excludeTurns: false });
      await client.waitFor(
        (message) => message.method === "thread/goal/updated",
        "goal snapshot after token usage",
      );
      const frames = client.messages.slice(offset);
      const responseIndex = frames.indexOf(response);
      const usageIndexes = frames.flatMap((message, index) =>
        message.method === "thread/tokenUsage/updated" ? [index] : []);
      const postWatermarkIndex = frames.findIndex((message) =>
        message.method === "warning"
        && (message.params as { message?: string } | undefined)?.message === postWatermarkMessage);
      const goalIndex = frames.findIndex((message) => message.method === "thread/goal/updated");
      expect(responseIndex).toBe(0);
      expect(usageIndexes).toHaveLength(1);
      expect(usageIndexes[0]).toBeGreaterThan(responseIndex);
      expect(postWatermarkIndex).toBeGreaterThan(usageIndexes[0]!);
      expect(goalIndex).toBeGreaterThan(postWatermarkIndex);
      return frames[usageIndexes[0]!]!.params;
    };
    const appendDuringSnapshot = (
      service: ClaudeService,
      store: SqliteHybridStore,
      turnId: string,
      message: string,
    ) => {
      const latest = service.latestTokenUsage.bind(service);
      let appended = false;
      vi.spyOn(service, "latestTokenUsage").mockImplementation((threadId) => {
        const snapshot = latest(threadId);
        if (!appended) {
          appended = true;
          store.appendEvent(threadId, turnId, "warning", { threadId, message });
        }
        return snapshot;
      });
    };

    const firstFake = new FakeClaudeQuery();
    firstFake.contextUsage = { totalTokens: 298_078, maxTokens: 1_000_000 };
    const firstHarness = makeService(firstFake);
    const first = firstHarness.service;
    const started = await first.startThread({ model: "claude:haiku", cwd: root });
    const turn = await first.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "seed resident usage", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    const usageDeadline = Date.now() + 2_000;
    while ((first.latestTokenUsage(started.thread.id)?.params as {
      tokenUsage?: { last?: { totalTokens?: number } };
    } | undefined)?.tokenUsage?.last?.totalTokens !== 298_078) {
      if (Date.now() >= usageDeadline) throw new Error("Timed out persisting resident usage.");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await (await first.prepareGoalSet({
      threadId: started.thread.id, objective: "hold snapshot ordering", status: "paused",
    })).notify();
    appendDuringSnapshot(first, firstHarness.store, turn.response.turn.id, "first post-watermark");

    const firstClient = await connect(first, firstHarness.subscriptions, "first");
    const firstSnapshot = await resumeSnapshot(firstClient, started.thread.id, "first post-watermark");
    await closeGateway(gateways.shift()!);
    await first.close();

    const secondFake = new FakeClaudeQuery();
    secondFake.contextUsage = { totalTokens: 298_078, maxTokens: 1_000_000 };
    const secondHarness = makeService(secondFake);
    const second = secondHarness.service;
    await second.ready();
    appendDuringSnapshot(second, secondHarness.store, turn.response.turn.id, "second post-watermark");
    const secondClient = await connect(second, secondHarness.subscriptions, "second");
    const secondSnapshot = await resumeSnapshot(secondClient, started.thread.id, "second post-watermark");

    expect(JSON.stringify(secondSnapshot)).toBe(JSON.stringify(firstSnapshot));
    expect(secondSnapshot).toMatchObject({
      threadId: started.thread.id,
      turnId: turn.response.turn.id,
      tokenUsage: {
        last: { totalTokens: 298_078 },
        modelContextWindow: 1_000_000,
      },
    });

    await closeGateway(gateways.shift()!);
    await second.close();
    for (const socket of stockWebSockets.clients) socket.terminate();
    stockWebSockets.close();
    await closeServer(stockServer);
  });
});
