import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeService } from "../../src/claude/service.js";
import type { HybridConfig } from "../../src/config/config.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";
import type { TranscriptBrancher } from "../../src/claude/transcriptBrancher.js";

const directories: string[] = [];
const immediateCompactionBoundary: TranscriptBrancher = {
  forkWithProvenance: async () => { throw new Error("unused transcript fork"); },
  resolveCompactionBoundary: async (_sessionId, _cwd, boundary) => boundary.uuid,
  delete: async () => undefined,
};

function config(dataDir: string): HybridConfig {
  return {
    realCodex: "/bin/false", claudeBinary: "/bin/false", dataDir,
    publicSocket: join(dataDir, "gateway.sock"), modelPrefix: "claude:",
    idleTimeoutSeconds: 900, modelCacheSeconds: 300, logLevel: "error", logPrompts: false,
    debugCapture: false, debugLogMaxBytes: 1_048_576,
  };
}

function successResult(options: {
  numTurns: number;
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  iterations?: Array<{ input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number }>;
  origin?: { kind: string };
}): SDKMessage {
  return {
    type: "result", subtype: "success", duration_ms: 10, duration_api_ms: 8,
    is_error: false, num_turns: options.numTurns, result: "OK", stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: options.input, cache_creation_input_tokens: options.cacheCreation,
      cache_read_input_tokens: options.cacheRead, output_tokens: options.output,
      ...(options.iterations ? { iterations: options.iterations } : {}),
    },
    modelUsage: {
      fable: {
        inputTokens: options.input, outputTokens: options.output,
        cacheReadInputTokens: options.cacheRead, cacheCreationInputTokens: options.cacheCreation,
        webSearchRequests: 0, costUSD: 0, contextWindow: 1_000_000, maxOutputTokens: 64_000,
      },
    },
    permission_denials: [], uuid: randomUUID(), session_id: "session",
    ...(options.origin ? { origin: options.origin } : {}),
  } as unknown as SDKMessage;
}

const finalIteration = {
  input_tokens: 2, cache_creation_input_tokens: 2_268,
  cache_read_input_tokens: 294_219, output_tokens: 1_589,
};

function capturedResult(iterations = true): SDKMessage {
  return successResult({
    numTurns: 9, input: 10, cacheCreation: 8_847, cacheRead: 1_452_364, output: 6_330,
    ...(iterations ? { iterations: [finalIteration] } : {}),
  });
}

async function runTurn(service: ClaudeService, threadId: string, text = "test"): Promise<void> {
  const prepared = await service.prepareTurn({
    threadId, input: [{ type: "text", text, text_elements: [] }],
  });
  prepared.announce();
  prepared.start();
  await waitFor(() => service.readThread(threadId, true).thread.turns.at(-1)?.status === "completed");
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for context usage regression.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function usageEvents(events: Array<{ method: string; params: unknown }>) {
  return events.filter((event) => event.method === "thread/tokenUsage/updated");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Claude context usage", () => {
  it("keeps captured aggregate accounting separate from the authoritative 298k resident snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-context-captured-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, capturedResult());
    fake.contextUsage = { totalTokens: 298_078, maxTokens: 1_000_000 };
    const hub = new SubscriptionHub();
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(config(directory), hub, new Logger("error"), store, fake.factory);
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));

    await runTurn(service, started.thread.id);
    await waitFor(() => usageEvents(events).length === 1);

    expect(usageEvents(events)[0]?.params).toMatchObject({
      tokenUsage: {
        total: { totalTokens: 1_467_551, inputTokens: 1_461_221, cachedInputTokens: 1_452_364, outputTokens: 6_330 },
        last: { totalTokens: 298_078, inputTokens: 296_489, cachedInputTokens: 294_219, outputTokens: 1_589 },
        modelContextWindow: 1_000_000,
      },
    });
    expect(298_078 / 1_000_000).toBeCloseTo(0.298078);
    expect(store.getThreadRecord(started.thread.id)?.tokenUsageLast?.totalTokens).toBe(298_078);
    await service.close();
  });

  it("uses the final/single iteration when the probe fails without delaying or failing the turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-context-single-"));
    directories.push(directory);
    const result = successResult({
      numTurns: 1, input: 2, cacheCreation: 30, cacheRead: 400, output: 18,
      iterations: [{ input_tokens: 2, cache_creation_input_tokens: 30, cache_read_input_tokens: 400, output_tokens: 18 }],
    });
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, result);
    fake.contextUsage = new Error("probe unavailable");
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));

    await runTurn(service, started.thread.id);
    await waitFor(() => usageEvents(events).length === 1);

    expect(usageEvents(events)[0]?.params).toMatchObject({
      tokenUsage: { total: { totalTokens: 450 }, last: { totalTokens: 450 }, modelContextWindow: 1_000_000 },
    });
    expect(events.filter((event) => event.method === "turn/completed")).toHaveLength(1);
    expect(events.some((event) => event.method === "error")).toBe(false);
    await service.close();
  });

  it("does not wait for a stalled context probe before terminal completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-context-stalled-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    let release!: () => void;
    fake.contextUsageWait = new Promise<void>((resolve) => { release = resolve; });
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));

    await runTurn(service, started.thread.id);
    expect(events.filter((event) => event.method === "turn/completed")).toHaveLength(1);
    expect(usageEvents(events)).toHaveLength(0);

    await service.resumeThread(started.thread.id);
    expect(fake.contextUsageCalls).toBe(2);
    release();
    await waitFor(() => usageEvents(events).length === 1);
    expect(usageEvents(events)).toHaveLength(1);
    await service.close();
  });

  it("invalidates a delayed result probe at the next main message_start", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-context-main-iteration-"));
    directories.push(directory);
    const base = { session_id: "session" };
    const before = [
      { type: "command_lifecycle", command_uuid: randomUUID(), state: "queued", uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_started", task_id: "continuation-task", description: "Continue", subagent_type: "Explore", uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_notification", task_id: "continuation-task", status: "completed", summary: "Continue now", uuid: randomUUID(), ...base },
    ] as unknown as SDKMessage[];
    const secondResult = successResult({
      numTurns: 1, input: 20, cacheCreation: 30, cacheRead: 90, output: 10,
      origin: { kind: "task-notification" },
    });
    const after = [
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "content_block_start", index: 7, content_block: { type: "text", text: "" } }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "content_block_delta", index: 7, delta: { type: "text_delta", text: "continued" } }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "content_block_stop", index: 7 }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      { type: "command_lifecycle", command_uuid: randomUUID(), state: "completed", uuid: randomUUID(), ...base },
      secondResult,
    ] as unknown as SDKMessage[];
    const fake = new FakeClaudeQuery(undefined, undefined, after, false, undefined, capturedResult(), undefined, before);
    let releaseProbe!: () => void;
    fake.contextUsageWait = new Promise<void>((resolve) => { releaseProbe = resolve; });
    let releaseContinuation!: () => void;
    fake.afterResultPause = { afterIndex: 2, wait: new Promise<void>((resolve) => { releaseContinuation = resolve; }) };
    fake.contextUsage = { totalTokens: 310_000, maxTokens: 1_000_000 };
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));

    const turn = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "continue", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(() => events.some((event) => event.method === "item/agentMessage/delta"
      && (event.params as { delta?: string }).delta === "continued"));

    releaseProbe();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(usageEvents(events)).toHaveLength(0);

    releaseContinuation();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed");
    await waitFor(() => usageEvents(events).length === 1);
    expect(usageEvents(events)[0]?.params).toMatchObject({
      tokenUsage: { total: { totalTokens: 1_467_701 }, last: { totalTokens: 310_000 } },
    });
    await service.close();
  });

  it("retains the prior resident snapshot for an ambiguous multi-iteration aggregate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-context-retain-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, capturedResult(false));
    fake.contextUsage = { totalTokens: 298_078, maxTokens: 1_000_000 };
    const hub = new SubscriptionHub();
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(config(directory), hub, new Logger("error"), store, fake.factory);
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));
    await runTurn(service, started.thread.id, "seed");
    await waitFor(() => usageEvents(events).length === 1);

    fake.contextUsage = new Error("probe unavailable");
    fake.resultMessage = capturedResult(false);
    await runTurn(service, started.thread.id, "ambiguous");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(usageEvents(events)).toHaveLength(1);
    expect(store.getThreadRecord(started.thread.id)).toMatchObject({
      tokenUsageTotal: { totalTokens: 2_935_102 },
      tokenUsageLast: { totalTokens: 298_078 },
      modelContextWindow: 1_000_000,
    });
    await service.close();
  });

  it("preserves the session-owned context window when a later result must use fallback usage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-context-window-fallback-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, capturedResult());
    fake.contextUsage = { totalTokens: 298_078, maxTokens: 1_000_000 };
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), store, fake.factory,
    );
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory });
    await runTurn(service, started.thread.id, "seed");
    await waitFor(() => store.getThreadRecord(started.thread.id)?.modelContextWindow === 1_000_000);

    const fallback = capturedResult() as SDKMessage & { modelUsage: Record<string, never> };
    fallback.modelUsage = {};
    fake.resultMessage = fallback;
    fake.contextUsage = new Error("probe unavailable");
    await runTurn(service, started.thread.id, "fallback");
    await waitFor(() => store.getThreadRecord(started.thread.id)?.tokenUsageTotal.totalTokens === 2_935_102);

    expect(store.getThreadRecord(started.thread.id)?.modelContextWindow).toBe(1_000_000);
    await service.close();
  });

  it("keeps an automatic compact boundary at 11k across a later >1M aggregate result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-context-auto-compact-"));
    directories.push(directory);
    const compact = {
      type: "system", subtype: "compact_boundary", compact_metadata: {
        trigger: "auto", pre_tokens: 367_463, post_tokens: 11_076,
      },
      uuid: randomUUID(), session_id: "session",
    } as unknown as SDKMessage;
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, capturedResult(false), undefined, [compact]);
    fake.contextUsage = { totalTokens: 11_076, maxTokens: 1_000_000 };
    const hub = new SubscriptionHub();
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), store, fake.factory,
      undefined, undefined, immediateCompactionBoundary,
    );
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));

    await runTurn(service, started.thread.id);
    await waitFor(() => usageEvents(events).length === 2);

    expect(events.filter((event) => event.method === "thread/compacted")).toHaveLength(1);
    expect(usageEvents(events)[0]?.params).toMatchObject({ tokenUsage: { total: { totalTokens: 0 }, last: { totalTokens: 11_076 } } });
    expect(usageEvents(events)[1]?.params).toMatchObject({
      tokenUsage: { total: { totalTokens: 1_467_551 }, last: { totalTokens: 11_076 }, modelContextWindow: 1_000_000 },
    });
    expect(usageEvents(events).every((event) => (event.params as { tokenUsage: { last: { totalTokens: number } } }).tokenUsage.last.totalTokens === 11_076)).toBe(true);
    expect(store.getThreadRecord(started.thread.id)?.tokenUsageLast?.totalTokens).toBe(11_076);

    fake.resultMessage = successResult({ numTurns: 1, input: 100, cacheCreation: 20, cacheRead: 11_000, output: 10 });
    fake.contextUsage = { totalTokens: 12_000, maxTokens: 1_000_000 };
    await runTurn(service, started.thread.id, "next request");
    await waitFor(() => usageEvents(events).length === 3);
    expect(usageEvents(events)[2]?.params).toMatchObject({ tokenUsage: { last: { totalTokens: 12_000 } } });
    await service.close();
  });

  it("lets a main iteration supersede a delayed automatic-compaction probe", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-context-auto-next-iteration-"));
    directories.push(directory);
    const base = { session_id: "session", parent_tool_use_id: null };
    const before = [
      {
        type: "system", subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 367_463, post_tokens: 11_076 },
        uuid: randomUUID(), session_id: "session",
      },
      { type: "stream_event", event: { type: "message_start", message: {} }, uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "content_block_start", index: 8, content_block: { type: "text", text: "" } }, uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "content_block_delta", index: 8, delta: { type: "text_delta", text: "post compact" } }, uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "content_block_stop", index: 8 }, uuid: randomUUID(), ...base },
    ] as unknown as SDKMessage[];
    let releaseResult!: () => void;
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, capturedResult(false), undefined, before,
      { afterIndex: 4, wait: new Promise<void>((resolve) => { releaseResult = resolve; }) },
    );
    let releaseProbe!: () => void;
    fake.contextUsageWait = new Promise<void>((resolve) => { releaseProbe = resolve; });
    fake.contextUsage = { totalTokens: 12_000, maxTokens: 1_000_000 };
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
      undefined, undefined, immediateCompactionBoundary,
    );
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));
    const turn = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "auto compact", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(() => events.some((event) => event.method === "item/agentMessage/delta"
      && (event.params as { delta?: string }).delta === "post compact"));

    releaseProbe();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.filter((event) => event.method === "thread/compacted")).toHaveLength(1);
    expect(usageEvents(events)).toHaveLength(0);

    releaseResult();
    await waitFor(() => usageEvents(events).length === 1);
    expect(usageEvents(events)[0]?.params).toMatchObject({
      tokenUsage: { total: { totalTokens: 1_467_551 }, last: { totalTokens: 12_000 } },
    });
    await service.close();
  });

  it("keeps a late interrupted-manual boundary fenced during the next active turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-context-late-manual-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery(undefined, undefined, [], true);
    fake.compactIdleBeforeBoundary = true;
    let releaseIdle!: () => void;
    fake.compactBoundaryWait = new Promise<void>((resolve) => { releaseIdle = resolve; });
    let releaseLateBoundary!: () => void;
    fake.compactLateBoundaryWait = new Promise<void>((resolve) => { releaseLateBoundary = resolve; });
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));

    await service.compactThread(started.thread.id);
    const compactTurnId = service.readThread(started.thread.id, true).thread.turns[0]!.id;
    await service.interruptTurn({ threadId: started.thread.id, turnId: compactTurnId });
    releaseIdle();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const next = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "normal turn", text_elements: [] }],
    });
    next.announce();
    next.start();
    releaseLateBoundary();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed");
    await waitFor(() => usageEvents(events).length === 1);

    expect(events.filter((event) => event.method === "thread/compacted")).toHaveLength(0);
    expect(usageEvents(events)).toHaveLength(1);
    expect(usageEvents(events)[0]?.params).toMatchObject({ tokenUsage: { last: { totalTokens: 24 } } });
    await service.close();
  });

  it("preserves delayed manual compaction usage and completes its terminal lifecycle independently", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-context-manual-compact-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery(undefined, undefined, [], true);
    fake.contextUsage = { totalTokens: 12_276, maxTokens: 1_000_000 };
    let release!: () => void;
    fake.compactBoundaryWait = new Promise<void>((resolve) => { release = resolve; });
    const hub = new SubscriptionHub();
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), store, fake.factory,
      undefined, undefined, immediateCompactionBoundary,
    );
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));

    await service.compactThread(started.thread.id);
    release();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed");
    await waitFor(() => usageEvents(events).length === 1);

    expect(events.filter((event) => event.method === "thread/compacted")).toHaveLength(1);
    expect(events.filter((event) => event.method === "turn/completed")).toHaveLength(1);
    expect(events.some((event) => event.method === "error")).toBe(false);
    expect(store.getThreadRecord(started.thread.id)).toMatchObject({
      tokenUsageLast: { totalTokens: 12_276 }, modelContextWindow: 1_000_000,
    });
    await service.close();
  });

  it("uses resident semantics for background/autonomous child activity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-context-background-"));
    directories.push(directory);
    const base = { session_id: "session" };
    const taskId = "child-task";
    const lifecycle = [
      { type: "command_lifecycle", command_uuid: randomUUID(), state: "queued", uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_started", task_id: taskId, description: "Inspect", subagent_type: "Explore", uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_notification", task_id: taskId, status: "completed", summary: "Done", uuid: randomUUID(), ...base },
      { type: "command_lifecycle", command_uuid: randomUUID(), state: "completed", uuid: randomUUID(), ...base },
    ] as unknown as SDKMessage[];
    const result = capturedResult();
    (result as unknown as { origin: { kind: string } }).origin = { kind: "task-notification" };
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, result, undefined, lifecycle);
    fake.contextUsage = { totalTokens: 298_078, maxTokens: 1_000_000 };
    const hub = new SubscriptionHub();
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), store, fake.factory,
    );
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));

    await runTurn(service, started.thread.id);
    await waitFor(() => usageEvents(events).length === 1);

    expect(usageEvents(events)[0]?.params).toMatchObject({
      tokenUsage: { total: { totalTokens: 1_467_551 }, last: { totalTokens: 298_078 } },
    });
    const child = service.readThread(started.thread.id, true).thread.turns[0]?.items
      .find((item) => item.type === "collabAgentToolCall");
    expect(child).toMatchObject({ type: "collabAgentToolCall", status: "completed" });
    if (child?.type !== "collabAgentToolCall") throw new Error("Expected a projected child thread.");
    expect(store.getThreadRecord(started.thread.id)?.tokenUsageLast?.totalTokens).toBe(298_078);
    expect(store.getThreadRecord(child.receiverThreadIds[0]!)?.tokenUsageLast).toBeNull();
    await service.close();
  });

  it("replays the same persisted 298k snapshot on reconnect and gateway restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-context-restart-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const firstFake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, capturedResult());
    firstFake.contextUsage = { totalTokens: 298_078, maxTokens: 1_000_000 };
    const first = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(database), firstFake.factory,
    );
    const started = await first.startThread({ model: "claude:claude-fable-5", cwd: directory });
    await runTurn(first, started.thread.id);
    await waitFor(() => first.latestTokenUsage(started.thread.id)?.params !== undefined);

    await first.resumeThread(started.thread.id);
    expect(first.latestTokenUsage(started.thread.id)?.params).toMatchObject({
      tokenUsage: { total: { totalTokens: 1_467_551 }, last: { totalTokens: 298_078 }, modelContextWindow: 1_000_000 },
    });
    await first.close();

    const secondFake = new FakeClaudeQuery();
    secondFake.contextUsage = { totalTokens: 298_078, maxTokens: 1_000_000 };
    const second = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(database), secondFake.factory,
    );
    await second.resumeThread(started.thread.id);
    expect(second.latestTokenUsage(started.thread.id)?.params).toMatchObject({
      tokenUsage: { total: { totalTokens: 1_467_551 }, last: { totalTokens: 298_078 }, modelContextWindow: 1_000_000 },
    });
    expect(secondFake.contextUsageCalls).toBe(1);
    await second.close();
  });
});
