import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncQueue } from "../../src/claude/asyncQueue.js";
import type { ClaudeQueryFactory, ClaudeQueryInput } from "../../src/claude/queryFactory.js";
import { ClaudeService } from "../../src/claude/service.js";
import type { HybridConfig } from "../../src/config/config.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import type { ClaudeThreadRecord } from "../../src/store/HybridStore.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";

const directories: string[] = [];
const sessionId = "autonomous-continuation-session";
const base = { session_id: sessionId };

function config(dataDir: string): HybridConfig {
  return {
    realCodex: "/bin/false",
    claudeBinary: "/bin/false",
    dataDir,
    publicSocket: join(dataDir, "gateway.sock"),
    modelPrefix: "claude:",
    idleTimeoutSeconds: 900,
    modelCacheSeconds: 300,
    logLevel: "error",
    logPrompts: false,
    debugCapture: false,
    debugLogMaxBytes: 1_048_576,
  };
}

function command(state: "queued" | "started" | "completed"): SDKMessage {
  return { type: "command_lifecycle", command_uuid: "primary", state, uuid: randomUUID(), ...base } as unknown as SDKMessage;
}

function status(value: "requesting" | null): SDKMessage {
  return {
    type: "system", subtype: "status", status: value, permissionMode: "default", uuid: randomUUID(), ...base,
  } as unknown as SDKMessage;
}

function sessionState(state: "idle" | "running"): SDKMessage {
  return { type: "system", subtype: "session_state_changed", state, uuid: randomUUID(), ...base } as unknown as SDKMessage;
}

function taskStarted(taskId: string): SDKMessage {
  return {
    type: "system", subtype: "task_started", task_id: taskId, task_type: "bash",
    description: `background ${taskId}`, uuid: randomUUID(), ...base,
  } as unknown as SDKMessage;
}

function tasksChanged(taskIds: string[]): SDKMessage {
  return {
    type: "system", subtype: "background_tasks_changed",
    tasks: taskIds.map((task_id) => ({ task_id, task_type: "bash", description: `background ${task_id}` })),
    uuid: randomUUID(), ...base,
  } as unknown as SDKMessage;
}

function taskNotification(taskId: string): SDKMessage {
  return {
    type: "system", subtype: "task_notification", task_id: taskId, status: "completed",
    summary: `${taskId} completed`, uuid: randomUUID(), ...base,
  } as unknown as SDKMessage;
}

function messageStart(): SDKMessage {
  return {
    type: "stream_event", event: { type: "message_start", message: {} },
    parent_tool_use_id: null, uuid: randomUUID(), ...base,
  } as unknown as SDKMessage;
}

function streamedBlock(index: number, block: Record<string, unknown>): SDKMessage[] {
  return [
    {
      type: "stream_event", event: { type: "content_block_start", index, content_block: block },
      parent_tool_use_id: null, uuid: randomUUID(), ...base,
    },
    {
      type: "stream_event", event: { type: "content_block_stop", index },
      parent_tool_use_id: null, uuid: randomUUID(), ...base,
    },
  ] as unknown as SDKMessage[];
}

function streamedText(index: number, text: string): SDKMessage[] {
  return [
    {
      type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
      parent_tool_use_id: null, uuid: randomUUID(), ...base,
    },
    {
      type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
      parent_tool_use_id: null, uuid: randomUUID(), ...base,
    },
    {
      type: "stream_event", event: { type: "content_block_stop", index },
      parent_tool_use_id: null, uuid: randomUUID(), ...base,
    },
  ] as unknown as SDKMessage[];
}

function toolResult(toolUseId: string): SDKMessage {
  return {
    type: "user", parent_tool_use_id: null, uuid: randomUUID(), ...base,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
  } as unknown as SDKMessage;
}

function assistant(content: Array<Record<string, unknown>>): SDKMessage {
  return {
    type: "assistant", parent_tool_use_id: null, uuid: randomUUID(), ...base,
    message: { role: "assistant", content },
  } as unknown as SDKMessage;
}

function assistantText(text: string): SDKMessage {
  return assistant([{ type: "text", text }]);
}

function result(origin?: "task-notification"): SDKMessage {
  return {
    type: "result", subtype: "success", duration_ms: 10, duration_api_ms: 8,
    is_error: false, num_turns: 1, result: "OK", stop_reason: "end_turn", total_cost_usd: 0,
    usage: { input_tokens: 4, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {}, permission_denials: [], uuid: randomUUID(), ...base,
    ...(origin ? { origin: { kind: origin } } : {}),
  } as unknown as SDKMessage;
}

class ControlledClaudeQuery {
  readonly output = new AsyncQueue<SDKMessage>();
  readonly inputs: ClaudeQueryInput[] = [];
  interruptCalls = 0;
  returnCalls = 0;
  reinitializeCalls = 0;

  readonly factory: ClaudeQueryFactory = (input) => {
    this.inputs.push(input);
    const runtimeSessionId = input.options.resume ?? input.options.sessionId ?? sessionId;
    void (async () => { for await (const _message of input.prompt) { /* consume streaming input */ } })();
    const iterator = this.output[Symbol.asyncIterator]();
    const query = {
      next: () => iterator.next(),
      return: async () => {
        this.returnCalls += 1;
        this.output.close();
        return { value: undefined, done: true };
      },
      throw: async (error?: unknown) => Promise.reject(error),
      [Symbol.asyncIterator]() { return this; },
      initializationResult: async () => ({}),
      getContextUsage: async () => ({ totalTokens: 10, maxTokens: 200_000 }),
      reinitialize: async () => { this.reinitializeCalls += 1; },
      setModel: async () => undefined,
      stopTask: async () => undefined,
      interrupt: async () => { this.interruptCalls += 1; },
      close: () => this.output.close(),
    } as unknown as Query;
    this.push({
      type: "system", subtype: "init", model: input.options.model ?? "haiku", claude_code_version: "test",
      session_id: runtimeSessionId, uuid: randomUUID(), apiKeySource: "none", cwd: input.options.cwd ?? process.cwd(),
      tools: [], mcp_servers: [], permissionMode: input.options.permissionMode ?? "default", slash_commands: [],
      output_style: "default", skills: [], plugins: [],
    } as unknown as SDKMessage);
    return query;
  };

  push(...messages: SDKMessage[]): void {
    for (const message of messages) this.output.push(message);
  }
}

type RecordedEvent = { method: string; params: unknown };

async function flush(): Promise<void> {
  for (let index = 0; index < 300; index += 1) await Promise.resolve();
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 1_000 && !predicate(); index += 1) await Promise.resolve();
  expect(predicate()).toBe(true);
}

async function fixture(): Promise<{
  service: ClaudeService;
  provider: ControlledClaudeQuery;
  threadId: string;
  turnId: string;
  events: RecordedEvent[];
}> {
  const directory = mkdtempSync(join(tmpdir(), "ccodex-autonomous-continuation-"));
  directories.push(directory);
  const provider = new ControlledClaudeQuery();
  const hub = new SubscriptionHub();
  const service = new ClaudeService(
    config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), provider.factory,
  );
  const started = await service.startThread({ model: "claude:haiku", cwd: directory });
  const events: RecordedEvent[] = [];
  hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));
  const prepared = await service.prepareTurn({
    threadId: started.thread.id, input: [{ type: "text", text: "continue after background work", text_elements: [] }],
  });
  prepared.announce();
  prepared.start();
  provider.push(command("queued"));
  await flush();
  return { service, provider, threadId: started.thread.id, turnId: prepared.response.turn.id, events };
}

function primeInitialResult(provider: ControlledClaudeQuery, taskIds: string[], commentary = "Waiting for background work."): void {
  provider.push(
    messageStart(),
    ...streamedText(0, commentary),
    ...taskIds.map(taskStarted),
    tasksChanged(taskIds),
    assistantText(commentary),
    result(),
    command("completed"),
  );
}

function terminalEvents(events: RecordedEvent[]): RecordedEvent[] {
  return events.filter((event) => event.method === "turn/completed");
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Claude autonomous continuation lifecycle", () => {
  it("keeps the captured 6047ms requesting TTFT in one original turn", async () => {
    vi.useFakeTimers();
    const { service, provider, threadId, turnId, events } = await fixture();
    primeInitialResult(provider, ["calibration"]);
    provider.push(tasksChanged([]), taskNotification("calibration"), status("requesting"));
    await flush();

    await vi.advanceTimersByTimeAsync(6_047);
    await flush();
    expect(service.readThread(threadId, true).thread.turns).toEqual([
      expect.objectContaining({ id: turnId, status: "inProgress" }),
    ]);
    expect(terminalEvents(events)).toHaveLength(0);
    expect(events.some((event) => event.method === "thread/status/changed"
      && (event.params as { status?: { type?: string } }).status?.type === "idle")).toBe(false);
    expect(JSON.stringify(service.readThread(threadId, true))).not.toContain("did not emit a request");

    const bashId = "continuation-bash";
    const editId = "continuation-edit";
    provider.push(
      messageStart(),
      ...streamedBlock(0, { type: "thinking", thinking: "Inspecting calibration output." }),
      ...streamedBlock(1, { type: "tool_use", id: bashId, name: "Bash", input: { command: "printf calibrated" } }),
      toolResult(bashId),
      ...streamedBlock(2, { type: "tool_use", id: editId, name: "Edit", input: { file_path: "/tmp/result.txt", old_string: "a", new_string: "b" } }),
      toolResult(editId),
      assistant([
        { type: "thinking", thinking: "Inspecting calibration output." },
        { type: "tool_use", id: bashId, name: "Bash", input: { command: "printf calibrated" } },
        { type: "tool_use", id: editId, name: "Edit", input: { file_path: "/tmp/result.txt", old_string: "a", new_string: "b" } },
      ]),
      messageStart(),
      ...streamedText(0, "Calibration and both checks are complete."),
      assistantText("Calibration and both checks are complete."),
      result("task-notification"),
    );
    await flushUntil(() => terminalEvents(events).length === 1);

    const turns = service.readThread(threadId, true).thread.turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ id: turnId, status: "completed" });
    expect(turns[0]?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning" }),
      expect.objectContaining({ type: "commandExecution" }),
      expect.objectContaining({ type: "fileChange" }),
      expect.objectContaining({ type: "agentMessage", text: "Waiting for background work.", phase: "commentary" }),
      expect.objectContaining({ type: "agentMessage", text: "Calibration and both checks are complete.", phase: "final_answer" }),
    ]));
    expect(events.filter((event) => event.method === "turn/started")).toHaveLength(1);
    expect(terminalEvents(events)).toHaveLength(1);
    expect((terminalEvents(events)[0]?.params as { turn: { id: string } }).turn.id).toBe(turnId);
    await service.close();
  });

  it.each([
    ["notification then requesting", false],
    ["requesting then notification", true],
  ])("fences the legal %s ordering", async (_label, requestFirst) => {
    vi.useFakeTimers();
    const { service, provider, threadId, events } = await fixture();
    primeInitialResult(provider, ["ordered"]);
    await flush();
    provider.push(tasksChanged([]));
    provider.push(...(requestFirst ? [status("requesting"), taskNotification("ordered")] : [taskNotification("ordered"), status("requesting")]));
    await flush();
    await vi.advanceTimersByTimeAsync(6_047);
    expect(terminalEvents(events)).toHaveLength(0);
    expect(service.readThread(threadId, true).thread.turns[0]?.status).toBe("inProgress");
    provider.push(messageStart(), ...streamedText(0, "Done."), assistantText("Done."), result("task-notification"));
    await flush();
    expect(service.readThread(threadId, true).thread.turns[0]?.status).toBe("completed");
    expect(terminalEvents(events)).toHaveLength(1);
    await service.close();
  });

  it("acknowledges multiple pre-request notifications with one continuation", async () => {
    const { service, provider, threadId, events } = await fixture();
    primeInitialResult(provider, ["a", "b"]);
    await flush();
    provider.push(tasksChanged([]), taskNotification("a"), taskNotification("b"), status("requesting"), messageStart(),
      ...streamedText(0, "Both complete."), assistantText("Both complete."), result("task-notification"));
    await flushUntil(() => service.readThread(threadId, true).thread.turns[0]?.status === "completed");
    expect(service.readThread(threadId, true).thread.turns).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(events.filter((event) => event.method === "turn/started")).toHaveLength(1);
    expect(terminalEvents(events)).toHaveLength(1);
    await service.close();
  });

  it("retains a notification arriving during a request for the next request generation", async () => {
    const { service, provider, threadId, turnId, events } = await fixture();
    primeInitialResult(provider, ["first"]);
    await flush();
    provider.push(tasksChanged([]), taskNotification("first"), status("requesting"), messageStart(), taskStarted("third"),
      taskNotification("third"), ...streamedText(0, "First continuation."), assistantText("First continuation."), result("task-notification"));
    await flush();
    expect(service.readThread(threadId, true).thread.turns[0]).toMatchObject({ id: turnId, status: "inProgress" });
    expect(terminalEvents(events)).toHaveLength(0);
    provider.push(status("requesting"), messageStart(), ...streamedText(0, "Third notification handled."),
      assistantText("Third notification handled."), result("task-notification"));
    await flushUntil(() => service.readThread(threadId, true).thread.turns[0]?.status === "completed");
    expect(service.readThread(threadId, true).thread.turns).toEqual([
      expect.objectContaining({ id: turnId, status: "completed" }),
    ]);
    expect(events.filter((event) => event.method === "turn/started")).toHaveLength(1);
    expect(terminalEvents(events)).toHaveLength(1);
    await service.close();
  });

  it("completes when a later request generation covers a notification that arrived during the command", async () => {
    vi.useFakeTimers();
    const { service, provider, threadId, turnId, events } = await fixture();
    primeInitialResult(provider, ["captured-race"]);
    await flush();

    provider.push(
      status("requesting"),
      messageStart(),
      tasksChanged([]),
      taskNotification("captured-race"),
      status("requesting"),
      messageStart(),
      ...streamedText(0, "Captured final answer."),
      assistantText("Captured final answer."),
      result(),
      command("completed"),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();

    const turn = service.readThread(threadId, true).thread.turns[0];
    expect(turn).toMatchObject({ id: turnId, status: "completed" });
    expect(turn?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agentMessage",
        text: "Captured final answer.",
        phase: "final_answer",
      }),
    ]));
    expect(JSON.stringify(turn)).not.toContain("did not emit a request");
    expect(terminalEvents(events)).toHaveLength(1);
    await service.close();
  });

  it("uses explicit idle as the no-follow-up compatibility boundary", async () => {
    vi.useFakeTimers();
    const { service, provider, threadId, events } = await fixture();
    primeInitialResult(provider, ["idle-compatible"]);
    await flush();
    provider.push(tasksChanged([]), taskNotification("idle-compatible"), sessionState("idle"));
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.readThread(threadId, true).thread.turns[0]?.status).toBe("completed");
    expect(terminalEvents(events)).toHaveLength(1);
    expect(JSON.stringify(service.readThread(threadId, true))).not.toContain("did not emit a request");
    await service.close();
  });

  it("keeps a signal-less legacy provider active without fabricating UI output or success", async () => {
    vi.useFakeTimers();
    const { service, provider, threadId, turnId, events } = await fixture();
    primeInitialResult(provider, ["signal-less"]);
    await flush();
    provider.push(tasksChanged([]), taskNotification("signal-less"));
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    const thread = service.readThread(threadId, true).thread;
    expect(thread.turns).toEqual([expect.objectContaining({ id: turnId, status: "inProgress" })]);
    expect(terminalEvents(events)).toHaveLength(0);
    expect(JSON.stringify(thread)).not.toContain("did not emit a request");
    await service.interruptTurn({ threadId, turnId });
    expect(service.readThread(threadId, true).thread.turns[0]?.status).toBe("interrupted");
    await service.close();
  });

  it("Stop during delayed requesting completes once and fences every late provider event", async () => {
    vi.useFakeTimers();
    const { service, provider, threadId, turnId, events } = await fixture();
    primeInitialResult(provider, ["stop-delayed"]);
    await flush();
    provider.push(tasksChanged([]), taskNotification("stop-delayed"), status("requesting"));
    await flush();
    await vi.advanceTimersByTimeAsync(6_047);
    await service.interruptTurn({ threadId, turnId });
    provider.push(messageStart(), taskStarted("late"), taskNotification("late"), ...streamedText(0, "Too late."), result("task-notification"));
    await flush();
    expect(service.readThread(threadId, true).thread.turns).toEqual([
      expect.objectContaining({ id: turnId, status: "interrupted" }),
    ]);
    expect(terminalEvents(events)).toHaveLength(1);
    expect((terminalEvents(events)[0]?.params as { turn: { status: string } }).turn.status).toBe("interrupted");
    expect(events.filter((event) => event.method === "turn/started")).toHaveLength(1);
    expect(JSON.stringify(service.readThread(threadId, true))).not.toContain("Too late");
    await service.close();
  });

  it("reconnects during requesting to the same durable in-progress turn", async () => {
    vi.useFakeTimers();
    const { service, provider, threadId, turnId, events } = await fixture();
    primeInitialResult(provider, ["reconnect"]);
    await flush();
    provider.push(tasksChanged([]), taskNotification("reconnect"), status("requesting"));
    await flush();
    const resumed = await service.resumeThread({
      threadId, initialTurnsPage: { limit: 10, sortDirection: "desc", itemsView: "full" },
    });
    expect(resumed.thread.status).toEqual({ type: "active", activeFlags: [] });
    expect(resumed.initialTurnsPage?.data).toEqual([expect.objectContaining({ id: turnId, status: "inProgress" })]);
    expect(provider.reinitializeCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(6_047);
    expect(terminalEvents(events)).toHaveLength(0);
    provider.push(messageStart(), ...streamedText(0, "After reconnect."), assistantText("After reconnect."), result("task-notification"));
    await flush();
    expect(service.readThread(threadId, true).thread.turns).toEqual([
      expect.objectContaining({ id: turnId, status: "completed" }),
    ]);
    expect(events.filter((event) => event.method === "turn/started")).toHaveLength(1);
    expect(terminalEvents(events)).toHaveLength(1);
    await service.close();
  });

  it("keeps one turn identity when reconnect is followed by Stop during delayed requesting", async () => {
    vi.useFakeTimers();
    const { service, provider, threadId, turnId, events } = await fixture();
    primeInitialResult(provider, ["reconnect-stop"]);
    await flush();
    provider.push(tasksChanged([]), taskNotification("reconnect-stop"), status("requesting"));
    await flush();

    const resumed = await service.resumeThread({
      threadId, initialTurnsPage: { limit: 10, sortDirection: "desc", itemsView: "full" },
    });
    expect(resumed.thread.status).toEqual({ type: "active", activeFlags: [] });
    expect(resumed.initialTurnsPage?.data).toEqual([
      expect.objectContaining({ id: turnId, status: "inProgress" }),
    ]);

    await vi.advanceTimersByTimeAsync(6_047);
    expect(terminalEvents(events)).toHaveLength(0);
    await service.interruptTurn({ threadId, turnId });
    provider.push(
      messageStart(),
      taskStarted("late-after-reconnect-stop"),
      taskNotification("late-after-reconnect-stop"),
      ...streamedText(0, "Too late after reconnect."),
      assistantText("Too late after reconnect."),
      result("task-notification"),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();

    expect(service.readThread(threadId, true).thread.turns).toEqual([
      expect.objectContaining({ id: turnId, status: "interrupted" }),
    ]);
    expect(events.filter((event) => event.method === "turn/started")).toHaveLength(1);
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          turn: expect.objectContaining({ id: turnId, status: "interrupted" }),
        }),
      }),
    ]);
    expect(JSON.stringify(service.readThread(threadId, true))).not.toContain("Too late after reconnect.");
    await service.close();
  });

  it("reconciles a gateway restart as one failed original turn, never success or revival", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-autonomous-restart-"));
    directories.push(directory);
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const createdAt = Math.floor(Date.now() / 1_000);
    const threadId = randomUUID();
    const turnId = randomUUID();
    const record: ClaudeThreadRecord = {
      thread: {
        id: threadId, extra: null, sessionId: threadId, forkedFromId: null, parentThreadId: null,
        preview: "restart fence", ephemeral: false, historyMode: "legacy",
        modelProvider: "claude", createdAt, updatedAt: createdAt, recencyAt: createdAt,
        status: { type: "active", activeFlags: [] }, path: null, cwd: directory, cliVersion: "test",
        source: "appServer", threadSource: null, agentNickname: null, agentRole: null, gitInfo: null,
        name: null, turns: [],
      },
      claudeSessionId: sessionId, modelPickerId: "claude:haiku", claudeModelValue: "haiku", serviceTier: null,
      approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite", writableRoots: [directory] },
      baseInstructions: null, developerInstructions: null, personality: null, resolvedModel: "haiku",
      lastClaudeMessageUuid: randomUUID(), lastCompletedTurnId: null, claudeCodeVersion: "test",
      reasoningEffort: null, reasoningSummary: null, collaborationMode: null, outputSchema: null,
      tokenUsageTotal: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      tokenUsageLast: null, modelContextWindow: 200_000,
    };
    store.createThread(record);
    store.createTurn(threadId, {
      id: turnId, items: [{ type: "userMessage", id: randomUUID(), clientId: null, content: [] }],
      itemsView: "full", status: "inProgress", error: null, startedAt: createdAt, completedAt: null, durationMs: null,
    });
    store.close();

    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), new ControlledClaudeQuery().factory,
    );
    await service.ready();
    const restarted = service.readThread(threadId, true).thread;
    expect(restarted.turns).toEqual([
      expect.objectContaining({ id: turnId, status: "failed", error: expect.objectContaining({ message: expect.stringContaining("Gateway restarted") }) }),
    ]);
    expect(restarted.status).toEqual({ type: "systemError" });
    const completions = service.eventsAfter(threadId, 0).filter((event) => event.method === "turn/completed");
    expect(completions).toHaveLength(1);
    expect((completions[0]?.params as { turn: { id: string; status: string } }).turn).toMatchObject({ id: turnId, status: "failed" });
    expect(service.eventsAfter(threadId, 0).filter((event) => event.method === "turn/started")).toHaveLength(0);
    await service.close();
  });
});
