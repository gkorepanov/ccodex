import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeService } from "../../src/claude/service.js";
import type { HybridConfig } from "../../src/config/config.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import { MetricsRegistry } from "../../src/observability/metrics.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";

const directories: string[] = [];

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "ccodex-goal-"));
  directories.push(value);
  return value;
}

function config(dataDir: string): HybridConfig {
  return {
    realCodex: "/bin/false", claudeBinary: "/bin/false", dataDir,
    publicSocket: join(dataDir, "gateway.sock"), modelPrefix: "claude:",
    idleTimeoutSeconds: 900, modelCacheSeconds: 300, logLevel: "error",
    logPrompts: false, debugCapture: false, debugLogMaxBytes: 1_048_576,
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

type RegisteredGoalTool = {
  description: string;
  handler: (input: Record<string, unknown>, extra: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
};

function goalTools(fake: FakeClaudeQuery): Record<string, RegisteredGoalTool> {
  const server = fake.inputs[0]?.options.mcpServers?.ccodex_goal as unknown as {
    instance: { _registeredTools: Record<string, RegisteredGoalTool> };
  };
  return server.instance._registeredTools;
}

async function callGoalTool(
  fake: FakeClaudeQuery,
  name: string,
  input: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await goalTools(fake)[name]!.handler(input, {});
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

afterEach(() => {
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Claude goal lifecycle", () => {
  it("validates mutations and lets the gateway respond before the native goal notification", async () => {
    const root = directory();
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(root), hub, new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), new FakeClaudeQuery().factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    const order: string[] = [];
    const notifications: unknown[] = [];
    hub.subscribe(started.thread.id, "test", (method, params) => {
      if (method === "thread/goal/updated") {
        order.push("notification");
        notifications.push(params);
      }
      if (method === "thread/goal/cleared") order.push("notification");
    });

    const prepared = await service.prepareGoalSet({
      threadId: started.thread.id, objective: "  ship exact goals  ", tokenBudget: 10,
    });
    order.push("response");
    await prepared.notify();
    expect(order).toEqual(["response", "notification"]);
    expect(prepared.response).toEqual({ goal: {
      threadId: started.thread.id, objective: "ship exact goals", status: "active", tokenBudget: 10,
      tokensUsed: 0, timeUsedSeconds: 0, createdAt: expect.any(Number), updatedAt: expect.any(Number),
    } });
    expect(notifications).toEqual([{ threadId: started.thread.id, turnId: null, goal: prepared.response.goal }]);
    expect(JSON.stringify(prepared.response)).not.toContain("goalId");
    await expect(service.prepareGoalSet({ threadId: started.thread.id, objective: "   " })).rejects.toThrow("goal objective must not be empty");
    await expect(service.prepareGoalSet({ threadId: started.thread.id, objective: "x".repeat(4_001) })).rejects.toThrow("at most 4000 characters");
    await expect(service.prepareGoalSet({ threadId: started.thread.id, tokenBudget: 0 })).rejects.toThrow("goal budgets must be positive");
    expect((await service.getGoal(started.thread.id))).toEqual(prepared.response);

    const budgetCleared = await service.prepareGoalSet({ threadId: started.thread.id, tokenBudget: null });
    await budgetCleared.notify();
    expect(budgetCleared.response.goal).toMatchObject({ objective: "ship exact goals", tokenBudget: null });
    order.length = 0;
    const cleared = await service.prepareGoalClear(started.thread.id);
    order.push("response");
    await cleared.notify();
    expect(cleared.response).toEqual({ cleared: true });
    expect(order).toEqual(["response", "notification"]);
    expect((await service.getGoal(started.thread.id))).toEqual({ goal: null });
    expect((await service.prepareGoalClear(started.thread.id)).response).toEqual({ cleared: false });

    const ephemeral = await service.startThread({ model: "claude:haiku", cwd: root, ephemeral: true });
    await expect(service.prepareGoalSet({ threadId: ephemeral.thread.id, objective: "nope" })).rejects.toThrow("ephemeral thread does not support goals");
    const ephemeralResume = await service.prepareResume({ threadId: ephemeral.thread.id });
    const ephemeralNotifications: string[] = [];
    await ephemeralResume.notifyGoalSnapshot((method) => ephemeralNotifications.push(method));
    expect(ephemeralResume.response.thread.id).toBe(ephemeral.thread.id);
    expect(ephemeralNotifications).toEqual([]);
    await service.close();
  });

  it("charges cache creation but excludes cache reads and crosses the budget exactly once", async () => {
    const root = directory();
    const result = {
      type: "result", subtype: "success", duration_ms: 10, duration_api_ms: 8,
      is_error: false, num_turns: 1, result: "OK", stop_reason: "end_turn", total_cost_usd: 0,
      usage: { input_tokens: 4, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 100 },
      modelUsage: {}, permission_denials: [], uuid: randomUUID(), session_id: "session",
    } as unknown as SDKMessage;
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, result);
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(root), hub, new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    const goalEvents: Array<{ goal: { status: string; tokensUsed: number } }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => {
      if (method === "thread/goal/updated") goalEvents.push(params as typeof goalEvents[number]);
    });
    const goal = await service.prepareGoalSet({ threadId: started.thread.id, objective: "fit budget", tokenBudget: 5 });
    await goal.notify();
    const turn = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "go", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(async () => (await service.getGoal(started.thread.id)).goal?.status === "budgetLimited", "budget limit");

    expect((await service.getGoal(started.thread.id))).toMatchObject({ goal: { tokensUsed: 9, tokenBudget: 5, status: "budgetLimited" } });
    expect(goalEvents.filter((event) => event.goal.status === "budgetLimited")).toHaveLength(1);
    expect(fake.inputs[0]?.options.mcpServers).toHaveProperty("ccodex_goal");
    await service.close();
  });

  it("starts an automatic continuation with no synthetic user item and stops at the budget", async () => {
    const root = directory();
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    const prepared = await service.prepareGoalSet({ threadId: started.thread.id, objective: "automatic work", tokenBudget: 5 });
    await prepared.notify();

    await waitFor(async () => (await service.getGoal(started.thread.id)).goal?.status === "budgetLimited", "automatic budget limit");
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed", "goal turn completion");

    const turn = service.readThread(started.thread.id, true).thread.turns[0]!;
    expect(turn.items.some((item) => item.type === "userMessage")).toBe(false);
    expect(fake.prompts[0]?.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("Continue working toward the active thread goal") }),
    ]));
    expect((await service.getGoal(started.thread.id)).goal).toMatchObject({ status: "budgetLimited", tokensUsed: 10 });
    await service.close();
  });

  it("preserves a goal-derived preview when a loaded runtime completes", async () => {
    const root = directory();
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    await service.resumeThread(started.thread.id);
    expect(service.readThread(started.thread.id, false).thread.preview).toBe("");

    await (await service.prepareGoalSet({
      threadId: started.thread.id, objective: "preview survives completion", tokenBudget: 5,
    })).notify();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "goal preview turn completion");

    expect(service.readThread(started.thread.id, false).thread.preview).toBe("preview survives completion");
    await service.close();
  });

  it("starts one initial continuation when an active goal is set on an unloaded durable thread", async () => {
    const root = directory();
    const path = join(root, "state.sqlite");
    const initial = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(path), new FakeClaudeQuery().factory,
    );
    const started = await initial.startThread({ model: "claude:haiku", cwd: root });
    await initial.close();

    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery();
    const resumed = new ClaudeService(config(root), hub, new Logger("error"), new SqliteHybridStore(path), fake.factory);
    const order: string[] = [];
    hub.subscribe(started.thread.id, "test", (method) => order.push(method));

    const prepared = await resumed.prepareGoalSet({
      threadId: started.thread.id, objective: "start after gateway restart", tokenBudget: 5,
    });
    order.push("response");
    await prepared.notify();


    const resume = await resumed.prepareResume({ threadId: started.thread.id });
    await resume.notifyGoalSnapshot((method) => order.push(method));

    await waitFor(async () => (await resumed.getGoal(started.thread.id)).goal?.status === "budgetLimited", "unloaded goal continuation");
    await waitFor(() => resumed.readThread(started.thread.id, true).thread.turns[0]?.status === "completed", "unloaded goal turn");

    expect(order[0]).toBe("response");
    expect(order[1]).toBe("thread/goal/updated");
    expect(order.indexOf("turn/started")).toBeGreaterThan(1);
    expect(order.filter((method) => method === "turn/started")).toHaveLength(1);
    expect(resumed.readThread(started.thread.id, true).thread.turns).toHaveLength(1);
    expect(fake.prompts[0]?.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("start after gateway restart") }),
    ]));
    await resumed.close();
  });

  it("blocks an active goal exactly once when its unloaded runtime cannot be materialized", async () => {
    const root = directory();
    const path = join(root, "state.sqlite");
    const initial = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(path), new FakeClaudeQuery().factory,
    );
    const started = await initial.startThread({ model: "claude:haiku", cwd: root });
    await initial.close();

    const hub = new SubscriptionHub();
    const updates: Array<{ goal: { status: string } }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => {
      if (method === "thread/goal/updated") updates.push(params as typeof updates[number]);
    });
    let rejectInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => { rejectInitialization = resolve; });
    const fake = new FakeClaudeQuery();
    const delayedFailure: typeof fake.factory = (input) => {
      const query = fake.factory(input);
      return new Proxy(query, {
        get(target, property) {
          if (property === "initializationResult") return async () => {
            await initialization;
            throw new Error("runtime authentication failed");
          };
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const failed = new ClaudeService(
      config(root), hub, new Logger("error"), new SqliteHybridStore(path), delayedFailure,
    );
    const prepared = await failed.prepareGoalSet({ threadId: started.thread.id, objective: "cannot start" });
    await prepared.notify();
    await waitFor(() => fake.inputs.length === 1, "runtime initialization");
    rejectInitialization();

    await waitFor(async () => (await failed.getGoal(started.thread.id)).goal?.status === "blocked", "failed runtime goal status");
    expect(updates.map((update) => update.goal.status)).toEqual(["active", "blocked"]);
    await (await failed.prepareGoalSet({ threadId: started.thread.id, status: "active" })).notify();
    await waitFor(() => fake.inputs.length === 2, "reactivated runtime initialization");
    await waitFor(async () => (await failed.getGoal(started.thread.id)).goal?.status === "blocked",
      "reactivated runtime goal status");
    expect(updates.map((update) => update.goal.status)).toEqual(["active", "blocked", "active", "blocked"]);
    await failed.close();
  });

  it("does not publish a goal runtime that finishes loading after its thread was deleted", async () => {
    const root = directory();
    const path = join(root, "state.sqlite");
    const initial = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(path), new FakeClaudeQuery().factory,
    );
    const started = await initial.startThread({ model: "claude:haiku", cwd: root });
    await initial.close();

    let releaseInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => { releaseInitialization = resolve; });
    const fake = new FakeClaudeQuery();
    const delayedFactory: typeof fake.factory = (input) => {
      const query = fake.factory(input);
      return new Proxy(query, {
        get(target, property) {
          if (property === "initializationResult") {
            return async () => {
              await initialization;
              return target.initializationResult();
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const metrics = new MetricsRegistry();
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(path), delayedFactory, undefined, metrics,
    );
    const prepared = await service.prepareGoalSet({ threadId: started.thread.id, objective: "delete during load" });
    await prepared.notify();

    await waitFor(() => fake.inputs.length === 1, "runtime initialization");

    await service.deleteThread(started.thread.id);
    releaseInitialization();
    await waitFor(() => fake.returnCalls === 1, "deleted runtime disposal");

    expect(service.ownsThread(started.thread.id)).toBe(false);
    expect(metrics.snapshot()).toMatchObject({
      gauges: { loadedClaudeRuntimes: 0 },
      counters: { claudeRuntimeStarts: 0 },
    });
    await service.close();
  });

  it("rejects runtime materialization after service shutdown begins", async () => {
    const root = directory();
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")),
      new FakeClaudeQuery().factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });

    const closing = service.close();
    await expect(service.resumeThread(started.thread.id)).rejects.toThrow("Claude service is closing.");
    await closing;
  });

  it("keeps budget wrap-up queued when assistant usage crosses the limit before terminal result", async () => {
    const root = directory();
    const messageStart = {
      type: "stream_event", event: { type: "message_start", message: {} },
      parent_tool_use_id: null, uuid: randomUUID(), session_id: "session",
    } as unknown as SDKMessage;
    const assistant = {
      type: "assistant", message: {
        role: "assistant", content: [],
        usage: { input_tokens: 4, output_tokens: 3, cache_creation_input_tokens: 2, cache_read_input_tokens: 100 },
      }, parent_tool_use_id: null, uuid: randomUUID(), session_id: "session",
    } as unknown as SDKMessage;
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, [messageStart, assistant]);
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    await (await service.prepareGoalSet({ threadId: started.thread.id, objective: "wrap after assistant", tokenBudget: 5 })).notify();
    const turn = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "work", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(() => fake.prompts.length === 2, "budget wrap prompt");
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed", "assistant-budget wrap");
    expect(fake.prompts).toHaveLength(2);
    expect(JSON.stringify(fake.prompts[1])).toContain("has reached its token budget");
    expect((await service.getGoal(started.thread.id)).goal).toMatchObject({ status: "budgetLimited", tokensUsed: 14 });
    await service.close();
  });

  it.each([
    ["rate limit exceeded", "usageLimited"],
    ["provider exploded", "blocked"],
    ["request interrupted", "paused"],
  ] as const)("maps terminal failure '%s' to %s", async (error, expectedStatus) => {
    const root = directory();
    const result = {
      type: "result", subtype: "error_during_execution", is_error: true,
      terminal_reason: error.includes("interrupted") ? "aborted_streaming" : "api_error",
      errors: [error], uuid: randomUUID(), session_id: "session",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 100 },
    } as unknown as SDKMessage;
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")),
      new FakeClaudeQuery(undefined, undefined, [], false, undefined, result).factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    await (await service.prepareGoalSet({ threadId: started.thread.id, objective: "terminal transition" })).notify();
    const turn = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "go", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(async () => (await service.getGoal(started.thread.id)).goal?.status === expectedStatus, expectedStatus);
    expect((await service.getGoal(started.thread.id)).goal).toMatchObject({ status: expectedStatus, tokensUsed: 3 });
    await service.close();
  });

  it("does not account or auto-continue in plan mode", async () => {
    const root = directory();
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    const goal = await service.prepareGoalSet({ threadId: started.thread.id, objective: "plan only" });
    await goal.notify();
    const turn = await service.prepareTurn({
      threadId: started.thread.id,
      collaborationMode: {
        mode: "plan",
        settings: { model: "claude:haiku", reasoning_effort: null, developer_instructions: null },
      },
      input: [{ type: "text", text: "make a plan", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed", "plan turn");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect((await service.getGoal(started.thread.id)).goal).toMatchObject({ status: "active", tokensUsed: 0, timeUsedSeconds: 0 });
    expect(fake.prompts).toHaveLength(1);
    await service.close();
  });

  it("keeps paused goals idle and resumes automatic work only when explicitly activated", async () => {
    const root = directory();
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    const paused = await service.prepareGoalSet({
      threadId: started.thread.id, objective: "resume me", status: "paused", tokenBudget: 5,
    });
    await paused.notify();

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(fake.prompts).toHaveLength(0);

    const resumed = await service.prepareGoalSet({ threadId: started.thread.id, status: "active" });
    await resumed.notify();

    await waitFor(async () => (await service.getGoal(started.thread.id)).goal?.status === "budgetLimited", "resumed goal budget");
    expect(fake.prompts.length).toBeGreaterThan(0);
    await service.close();
  });

  it("steers a mid-turn objective replacement without adding a visible user item", async () => {
    const root = directory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const messageStart = {
      type: "stream_event", event: { type: "message_start", message: {} },
      parent_tool_use_id: null, uuid: randomUUID(), session_id: "session",
    } as unknown as SDKMessage;
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, [messageStart], {
      afterIndex: 0, wait: gate,
    });
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    await (await service.prepareGoalSet({ threadId: started.thread.id, objective: "old objective" })).notify();
    const turn = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "work", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(() => fake.prompts.length === 1, "paused provider response");
    const changed = await service.prepareGoalSet({ threadId: started.thread.id, objective: "new <objective>" });
    await changed.notify();

    const paused = await service.prepareGoalSet({ threadId: started.thread.id, status: "paused" });
    await paused.notify();

    release();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed", "steered turn");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(JSON.stringify(fake.prompts)).toContain("The active thread goal objective was edited by the user");
    expect(JSON.stringify(fake.prompts)).toContain("new &lt;objective&gt;");
    const visible = service.readThread(started.thread.id, true).thread.turns[0]!;
    expect(visible.items.filter((item) => item.type === "userMessage")).toHaveLength(1);
    await service.close();
  });

  it("flushes monotonic wall time and pauses an interrupted active goal", async () => {
    const root = directory();
    let entered = false;
    const gate = new Promise<void>(() => undefined);
    const fake = new FakeClaudeQuery(undefined, {
      name: "Read", input: { file_path: "README.md" }, execute: async () => { entered = true; await gate; },
    });
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    await (await service.prepareGoalSet({ threadId: started.thread.id, objective: "interrupt accounting" })).notify();
    const turn = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "wait", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(() => entered, "interruptible tool");
    await new Promise<void>((resolve) => setTimeout(resolve, 1_050));
    await service.interruptTurn(started.thread.id);
    expect((await service.getGoal(started.thread.id)).goal).toMatchObject({ status: "paused", timeUsedSeconds: 1 });
    await service.close();
  });

  it("accounts assistant and terminal aggregate usage once, including subtask totals", async () => {
    const root = directory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const usageMessage = {
      type: "assistant", message: {
        role: "assistant", content: [],
        usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 2, cache_read_input_tokens: 90 },
      }, parent_tool_use_id: "subtask", uuid: randomUUID(), session_id: "session",
    } as unknown as SDKMessage;
    const result = {
      type: "result", subtype: "success", duration_ms: 10, duration_api_ms: 8,
      is_error: false, num_turns: 1, result: "OK", stop_reason: "end_turn", total_cost_usd: 0,
      usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 2, cache_read_input_tokens: 90 },
      modelUsage: {}, permission_denials: [], uuid: randomUUID(), session_id: "session",
    } as unknown as SDKMessage;
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, result, undefined, [usageMessage], {
      afterIndex: 0, wait: gate,
    });
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    await (await service.prepareGoalSet({ threadId: started.thread.id, objective: "aggregate usage" })).notify();
    const turn = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "work", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(async () => (await service.getGoal(started.thread.id)).goal?.tokensUsed === 7, "assistant usage");
    await (await service.prepareGoalSet({ threadId: started.thread.id, status: "paused" })).notify();
    release();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed", "aggregate turn");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect((await service.getGoal(started.thread.id)).goal).toMatchObject({ tokensUsed: 7, status: "paused" });
    await service.close();
  });

  it("exposes exact hidden goal tools and enforces their lifecycle", async () => {
    const root = directory();
    const fake = new FakeClaudeQuery(
      undefined,
      undefined,
      [],
      false,
      undefined,
      undefined,
      undefined,
      [{
        type: "system",
        subtype: "status",
        status: "working",
        permissionMode: "default",
        uuid: randomUUID(),
        session_id: "session",
      }] as unknown as SDKMessage[],
      { afterIndex: 0, wait: new Promise<void>(() => undefined) },
    );
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    const turn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "exercise goal tools", text_elements: [] }],
    });
    await turn.announce();
    turn.start();
    await waitFor(() => fake.prompts.length === 1, "active goal-tool turn");
    expect(await callGoalTool(fake, "get_goal")).toEqual({ goal: null, remainingTokens: null, completionBudgetReport: null });
    expect(goalTools(fake).update_goal!.description).toContain("three consecutive goal turns");
    const created = await callGoalTool(fake, "create_goal", { objective: "  model goal  ", token_budget: 20 });
    expect(created).toMatchObject({ goal: { objective: "model goal", status: "active", tokenBudget: 20 }, remainingTokens: 20 });
    await expect(callGoalTool(fake, "create_goal", { objective: "illegal replacement" })).rejects.toThrow("unfinished goal");
    const completed = await callGoalTool(fake, "update_goal", { status: "complete" });
    expect(completed).toMatchObject({ goal: { status: "complete" }, completionBudgetReport: "0 of 20 goal tokens used" });
    expect(await callGoalTool(fake, "create_goal", { objective: "replacement" })).toMatchObject({
      goal: { objective: "replacement", status: "active", tokensUsed: 0 },
    });
    expect(service.readThread(started.thread.id, true).thread.turns).toHaveLength(1);
    await service.close();
  });

  it("matches pinned prompt-only blocker audit behavior across restart and resume", async () => {
    const root = directory();
    const path = join(root, "state.sqlite");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstFake = new FakeClaudeQuery(
      undefined,
      undefined,
      [],
      false,
      undefined,
      undefined,
      undefined,
      [{
        type: "system",
        subtype: "status",
        status: "working",
        permissionMode: "default",
        uuid: randomUUID(),
        session_id: "session",
      }] as unknown as SDKMessage[],
      { afterIndex: 0, wait: firstGate },
    );
    const first = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(path), firstFake.factory,
    );
    const started = await first.startThread({ model: "claude:haiku", cwd: root });
    const firstTurn = await first.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "first blocked audit", text_elements: [] }],
    });
    await firstTurn.announce();
    firstTurn.start();
    await waitFor(() => firstFake.prompts.length === 1, "first blocked audit turn");
    await callGoalTool(firstFake, "create_goal", { objective: "blocked policy" });
    expect(await callGoalTool(firstFake, "update_goal", { status: "blocked" })).toMatchObject({
      goal: { status: "blocked" },
    });
    releaseFirst();
    await waitFor(
      () => first.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "first blocked audit completion",
    );
    await first.close();
    const seed = new SqliteHybridStore(path);
    seed.setGoal(started.thread.id, { status: "active" });
    seed.close();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const boundary = {
      type: "stream_event", event: { type: "message_start", message: {} },
      parent_tool_use_id: null, uuid: randomUUID(), session_id: "session",
    } as unknown as SDKMessage;
    const resumedFake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined, [boundary], { afterIndex: 0, wait: gate },
    );
    const resumed = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(path), resumedFake.factory,
    );
    const resume = await resumed.prepareResume({ threadId: started.thread.id });
    expect(goalTools(resumedFake).update_goal!.description).toContain("fresh blocked audit");
    await resume.notifyGoalSnapshot(() => undefined);
    await waitFor(() => resumedFake.prompts.length === 1, "fresh blocked audit continuation");
    expect(JSON.stringify(resumedFake.prompts[0])).toContain("fresh blocked audit");
    const paused = await resumed.prepareGoalSet({ threadId: started.thread.id, status: "paused" });
    await paused.notify();
    expect(await callGoalTool(resumedFake, "update_goal", { status: "blocked" })).toMatchObject({
      goal: { status: "blocked" },
    });

    release();
    await waitFor(() => resumed.readThread(started.thread.id, true).thread.turns[0]?.status === "completed", "blocked audit turn");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await resumed.close();
  });

  it("provider-auto-allows goal MCP plumbing without rendering a technical tool card", async () => {
    const root = directory();
    const stop = {
      type: "stream_event", event: { type: "content_block_stop", index: 0 },
      parent_tool_use_id: null, uuid: randomUUID(), session_id: "session",
    } as unknown as SDKMessage;
    const fake = new FakeClaudeQuery(
      { name: "mcp__ccodex_goal__get_goal", input: {} }, undefined, [], false, undefined, undefined, undefined, [stop],
    );
    fake.streamPermissionTool = true;
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    const turn = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "inspect", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed", "hidden MCP turn");
    expect(fake.inputs[0]?.options.allowedTools).toBeUndefined();
    expect(fake.providerAllowedTools).toEqual([]);
    expect(fake.providerHookAllowedTools).toEqual(["mcp__ccodex_goal__get_goal"]);
    expect(fake.permissionResults).toEqual([]);
    expect(service.readThread(started.thread.id, true).thread.turns[0]!.items.some((item) => item.type === "dynamicToolCall")).toBe(false);
    await service.close();
  });

  it.each([
    { name: "dontAsk", approvalPolicy: "never", sandbox: "read-only", approvalsReviewer: "user", permissionMode: "dontAsk" },
    { name: "bypass", approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user", permissionMode: "bypassPermissions" },
    { name: "on-request", approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user", permissionMode: "default" },
    { name: "auto", approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review", permissionMode: "auto" },
  ] as const)("trusts goal MCP locally without replacing user/project tool policy in $name mode", async ({ approvalPolicy, sandbox, approvalsReviewer, permissionMode }) => {
    const root = directory();
    const fake = new FakeClaudeQuery({ name: "mcp__ccodex_goal__get_goal", input: {} });
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root, approvalPolicy, sandbox, approvalsReviewer });
    const turn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "inspect goal", text_elements: [] }],
    });
    await turn.announce();
    turn.start();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed", "goal permission turn");
    expect(fake.inputs[0]?.options.permissionMode).toBe(permissionMode);
    expect(fake.inputs[0]?.options.allowedTools).toBeUndefined();
    expect(fake.inputs[0]?.options.tools).toBeUndefined();
    expect(fake.inputs[0]?.options.settingSources).toEqual(["user", "project", "local"]);
    expect(fake.inputs[0]?.options.strictMcpConfig).not.toBe(true);
    expect(fake.inputs[0]?.options.mcpServers).toHaveProperty("ccodex_goal");
    expect(fake.providerHookAllowedTools).toEqual(["mcp__ccodex_goal__get_goal"]);
    await service.close();
  });

  it("keeps user/project mcp__codex__ tools discoverable and governed by the task permission policy", async () => {
    const root = directory();
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery({ name: "mcp__codex__search", input: { query: "needle" } });
    const service = new ClaudeService(
      config(root), hub, new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root, approvalPolicy: "on-request" });
    const approvals: string[] = [];
    hub.subscribe(started.thread.id, "external-mcp", () => undefined, (id) => approvals.push(id));
    const turn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "use project MCP", text_elements: [] }],
    });
    await turn.announce();
    turn.start();
    await waitFor(() => approvals.length === 1, "external MCP approval");
    await service.resolveServerRequest(approvals[0]!, { decision: "accept" });
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed", "external MCP turn");

    expect(fake.inputs[0]?.options.allowedTools).toBeUndefined();
    expect(fake.inputs[0]?.options.tools).toBeUndefined();
    expect(fake.inputs[0]?.options.settingSources).toEqual(["user", "project", "local"]);
    expect(fake.inputs[0]?.options.strictMcpConfig).not.toBe(true);
    expect(fake.providerHookAllowedTools).toEqual([]);
    expect(fake.permissionResults).toMatchObject([{ behavior: "allow" }]);
    await service.close();
  });

  it("executes update_goal exactly once and completes the turn without an App approval", async () => {
    const root = directory();
    const hub = new SubscriptionHub();
    let fake!: FakeClaudeQuery;
    let toolCalls = 0;
    fake = new FakeClaudeQuery(
      { name: "mcp__ccodex_goal__update_goal", input: { status: "complete" } },
      {
        name: "mcp__ccodex_goal__update_goal", input: { status: "complete" },
        execute: async () => {
          toolCalls += 1;
          await callGoalTool(fake, "update_goal", { status: "complete" });
        },
      },
    );
    fake.streamPermissionTool = true;
    const service = new ClaudeService(
      config(root), hub, new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:haiku", cwd: root, approvalPolicy: "never", sandbox: "read-only",
    });
    const updates: unknown[] = [];
    const approvalIds: string[] = [];
    hub.subscribe(started.thread.id, "test", (method, params) => {
      if (method === "thread/goal/updated") updates.push(params);
    }, (id) => approvalIds.push(id));
    await (await service.prepareGoalSet({ threadId: started.thread.id, objective: "finish once", status: "paused" })).notify();
    updates.length = 0;

    const turn = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "finish", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed", "trusted update_goal turn");

    expect(fake.providerAllowedTools).toEqual([]);
    expect(fake.providerHookAllowedTools).toContain("mcp__ccodex_goal__update_goal");
    expect(fake.permissionResults).toEqual([]);
    expect(approvalIds).toEqual([]);
    expect(toolCalls).toBe(1);
    expect((await service.getGoal(started.thread.id)).goal).toMatchObject({ objective: "finish once", status: "complete" });
    expect(updates).toHaveLength(1);
    expect(service.readThread(started.thread.id, true).thread.turns[0]!.items.some((item) => item.type === "dynamicToolCall")).toBe(false);
    await service.close();
  });

  it("returns an internal goal tool failure to Claude and still completes without an App approval", async () => {
    const root = directory();
    const hub = new SubscriptionHub();
    let fake!: FakeClaudeQuery;
    fake = new FakeClaudeQuery(
      { name: "mcp__ccodex_goal__update_goal", input: { status: "complete" } },
      {
        name: "mcp__ccodex_goal__update_goal", input: { status: "complete" },
        execute: async () => { await callGoalTool(fake, "update_goal", { status: "complete" }); },
      },
    );
    const service = new ClaudeService(
      config(root), hub, new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:haiku", cwd: root, approvalPolicy: "never", sandbox: "read-only",
    });
    const approvalIds: string[] = [];
    hub.subscribe(started.thread.id, "test", () => undefined, (id) => approvalIds.push(id));
    const turn = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "finish absent goal", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed", "failed trusted goal tool turn");

    expect(fake.providerAllowedTools).toEqual([]);
    expect(fake.providerHookAllowedTools).toContain("mcp__ccodex_goal__update_goal");
    expect(fake.toolExecutionErrors).toEqual(["cannot update goal because this thread has no goal"]);
    expect(approvalIds).toEqual([]);
    expect((await service.getGoal(started.thread.id))).toEqual({ goal: null });
    await service.close();
  });

  it("serializes set, clear, stale accounting, and continuation decisions per thread", async () => {
    const root = directory();
    const store = new SqliteHybridStore(join(root, "state.sqlite"));
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(config(root), new SubscriptionHub(), new Logger("error"), store, fake.factory);
    const started = await service.startThread({ model: "claude:haiku", cwd: root });

    await Promise.all([
      Promise.resolve().then(async () => {
        const set = await service.prepareGoalSet({ threadId: started.thread.id, objective: "racing goal" });
        await set.notify();

      }),
      Promise.resolve().then(async () => {
        const clear = await service.prepareGoalClear(started.thread.id);
        await clear.notify();
      }),
    ]);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect((await service.getGoal(started.thread.id))).toEqual({ goal: null });
    expect(fake.prompts).toHaveLength(0);

    const original = store.setGoal(started.thread.id, { objective: "old" });
    let replacement = original;
    await Promise.all([
      Promise.resolve().then(async () => { replacement = store.setGoal(started.thread.id, { objective: "new", replace: true }); }),
      Promise.resolve().then(() => store.accountGoalUsage({
        threadId: started.thread.id, expectedGoalId: original.goalId, tokenDelta: 99, timeDeltaSeconds: 9,
        checkpointKey: "stale",
      })),
      Promise.resolve().then(() => store.setGoal(started.thread.id, { status: "paused" })),
    ]);
    expect(store.getGoal(started.thread.id)).toMatchObject({
      goalId: replacement.goalId, objective: "new", status: "paused", tokensUsed: 0, timeUsedSeconds: 0,
    });
    await service.close();
  });

  it("attaches a simultaneous goal set to the pending user turn without starting a duplicate continuation", async () => {
    const root = directory();
    let releaseResult!: () => void;
    const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined,
      [{
        type: "system", subtype: "status", status: "requesting", permissionMode: "default",
        uuid: randomUUID(), session_id: "goal-pending-user-turn",
      } as unknown as SDKMessage],
      { afterIndex: 0, wait: resultGate },
    );
    const hub = new SubscriptionHub();
    const events: string[] = [];
    const service = new ClaudeService(
      config(root), hub, new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    hub.subscribe(started.thread.id, "test", (method) => events.push(method));

    const preparing = service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "work on the goal", text_elements: [] }],
    });
    const goal = await service.prepareGoalSet({ threadId: started.thread.id, objective: "one user turn, never two" });
    await goal.notify();

    const turn = await preparing;
    await turn.announce();
    turn.start();

    await waitFor(() => fake.prompts.length === 1, "pending user turn prompt");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(fake.prompts).toHaveLength(1);
    expect(service.readThread(started.thread.id, true).thread.turns).toHaveLength(1);
    expect(events.filter((method) => method === "turn/started")).toHaveLength(1);

    const paused = await service.prepareGoalSet({ threadId: started.thread.id, status: "paused" });
    await paused.notify();

    releaseResult();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed", "pending user turn completion");
    expect(fake.prompts).toHaveLength(1);
    expect(events.filter((method) => method === "turn/started")).toHaveLength(1);
    await service.close();
  });

  it("keeps the capture-derived goal generation terminal across resume, clear, and user-turn completion", async () => {
    const root = directory();
    let releaseResult!: () => void;
    const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined,
      [{
        type: "system", subtype: "status", status: "requesting", permissionMode: "default",
        uuid: randomUUID(), session_id: "goal-terminal-clear-race",
      } as unknown as SDKMessage],
      { afterIndex: 0, wait: resultGate },
    );
    const hub = new SubscriptionHub();
    const events: Array<{ method: string; params: unknown }> = [];
    const store = new SqliteHybridStore(join(root, "state.sqlite"));
    const service = new ClaudeService(config(root), hub, new Logger("error"), store, fake.factory);
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    hub.subscribe(started.thread.id, "goal-terminal-clear", (method, params) => events.push({ method, params }));

    const preparing = service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "finish this goal", text_elements: [] }],
    });
    const goal = await service.prepareGoalSet({
      threadId: started.thread.id, objective: "complete once and stay complete",
    });
    await goal.notify();

    const turn = await preparing;
    await turn.announce();
    turn.start();
    await waitFor(() => fake.prompts.length === 1, "capture-derived goal user turn");

    const resume = await service.prepareResume({ threadId: started.thread.id });
    await resume.notifyGoalSnapshot((method, params) => events.push({ method, params }));
    expect(resume.response.thread.status).toEqual({ type: "active", activeFlags: [] });
    expect(fake.prompts).toHaveLength(1);

    const completed = await service.prepareGoalSet({ threadId: started.thread.id, status: "complete" });
    await completed.notify();
    const cleared = await service.prepareGoalClear(started.thread.id);
    await cleared.notify();
    expect(cleared.response).toEqual({ cleared: true });
    const terminalFence = events.length;

    releaseResult();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "capture-derived goal user-turn terminal",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(fake.prompts).toHaveLength(1);
    expect(store.listTurns(started.thread.id)).toEqual([
      expect.objectContaining({ id: turn.response.turn.id, status: "completed" }),
    ]);
    expect(events
      .filter(({ method }) => method === "turn/started" || method === "turn/completed")
      .map(({ method, params }) => ({
        method,
        turnId: (params as { turn: { id: string } }).turn.id,
      }))).toEqual([
      { method: "turn/started", turnId: turn.response.turn.id },
      { method: "turn/completed", turnId: turn.response.turn.id },
    ]);
    expect(events.filter(({ method, params }) =>
      method === "thread/goal/updated"
      && (params as { goal?: { status?: string } }).goal?.status === "complete")).toHaveLength(1);
    expect(events.filter(({ method }) => method === "thread/goal/cleared")).toHaveLength(1);
    expect(events.slice(terminalFence).some(({ method }) =>
      method === "thread/goal/cleared"
      || method === "turn/started"
      || method === "thread/goal/updated")).toBe(false);
    expect(await service.getGoal(started.thread.id)).toEqual({ goal: null });
    await service.close();
  });

  it("keeps reconnect snapshots connection-local and schedules one continuation after terminal emission", async () => {
    const root = directory();
    const path = join(root, "state.sqlite");
    const initial = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(path), new FakeClaudeQuery().factory,
    );
    const started = await initial.startThread({ model: "claude:haiku", cwd: root });
    await (await initial.prepareGoalSet({ threadId: started.thread.id, objective: "multi-client continuation" })).notify();
    await initial.close();

    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(config(root), hub, new Logger("error"), new SqliteHybridStore(path), fake.factory);
    const clientA: string[] = [];
    const clientB: string[] = [];
    let startedTurns = 0;
    hub.subscribe(started.thread.id, "a", async (method) => {
      clientA.push(method);
      if (method === "turn/started" && ++startedTurns === 2) {
        const paused = await service.prepareGoalSet({ threadId: started.thread.id, status: "paused" });
        queueMicrotask(async () => { await paused.notify(); });
      }
    });
    hub.subscribe(started.thread.id, "b", (method) => clientB.push(method));

    const snapshotA: string[] = [];
    const snapshotB: string[] = [];
    const resumeA = await service.prepareResume({ threadId: started.thread.id });
    const resumeB = await service.prepareResume({ threadId: started.thread.id });
    await resumeA.notifyGoalSnapshot((method) => snapshotA.push(method));
    expect(fake.prompts).toHaveLength(0);
    await resumeB.notifyGoalSnapshot((method) => snapshotB.push(method));
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns.length === 2
      && service.readThread(started.thread.id, true).thread.turns.every((turn) => turn.status === "completed"), "two serialized continuations");

    expect(snapshotA).toEqual(["thread/goal/updated"]);
    expect(snapshotB).toEqual(["thread/goal/updated"]);
    expect(fake.prompts).toHaveLength(2);
    expect(clientA.filter((method) => method === "turn/started")).toHaveLength(2);
    expect(clientB.filter((method) => method === "turn/started")).toHaveLength(2);
    const firstCompleted = clientA.indexOf("turn/completed");
    const secondStarted = clientA.indexOf("turn/started", clientA.indexOf("turn/started") + 1);
    expect(firstCompleted).toBeLessThan(secondStarted);
    expect(clientA.filter((method) => method === "thread/goal/updated")).toHaveLength(
      clientB.filter((method) => method === "thread/goal/updated").length,
    );
    expect((await service.getGoal(started.thread.id)).goal).toMatchObject({ status: "paused", tokensUsed: 5 });
    await service.close();
  });

  it("waits for background Bash, native subagent, approval, and tool-result quiescence before one continuation", async () => {
    const root = directory();
    const outputFile = join(root, "background.output");
    writeFileSync(outputFile, "BACKGROUND_OK\n");
    const base = { session_id: "goal-quiescence-session" };
    const backgroundTool = "goal-background-bash";
    const backgroundTask = "goal-background-task";
    const agentTool = "goal-native-agent";
    const agentTask = "goal-native-agent-task";
    const result = (origin?: { kind: string }) => ({
      type: "result", subtype: "success", duration_ms: 10, duration_api_ms: 8,
      is_error: false, num_turns: 1, result: "OK", stop_reason: "end_turn", total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {}, permission_denials: [], uuid: randomUUID(), ...base, ...(origin ? { origin } : {}),
    }) as unknown as SDKMessage;
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const beforeResult = [
      { type: "command_lifecycle", command_uuid: randomUUID(), state: "queued", uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: {
          type: "tool_use", id: backgroundTool, name: "Bash", input: { command: "sleep 1", run_in_background: true },
        } },
      },
      {
        type: "user", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        message: { role: "user", content: [{
          type: "tool_result", tool_use_id: backgroundTool,
          content: `Command running in background with ID: ${backgroundTask}. Output is being written to: ${outputFile}.`,
        }] },
        tool_use_result: { stdout: "", stderr: "", backgroundTaskId: backgroundTask },
      },
      { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: backgroundTask, task_type: "bash", description: "sleep 1" }], uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_started", task_id: backgroundTask, tool_use_id: backgroundTool, task_type: "bash", description: "sleep 1", uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: {
          type: "tool_use", id: agentTool, name: "Agent", input: { prompt: "Inspect in parallel" },
        } },
      },
      {
        type: "system", subtype: "task_started", task_id: agentTask, tool_use_id: agentTool,
        task_type: "agent", subagent_type: "Explore", description: "Inspect in parallel", prompt: "Inspect in parallel",
        uuid: randomUUID(), ...base,
      },
      { type: "command_lifecycle", command_uuid: randomUUID(), state: "completed", uuid: randomUUID(), ...base },
    ] as unknown as SDKMessage[];
    const afterResult = [
      { type: "system", subtype: "status", status: null, permissionMode: "default", uuid: randomUUID(), ...base },
      { type: "system", subtype: "background_tasks_changed", tasks: [], uuid: randomUUID(), ...base },
      {
        type: "system", subtype: "task_notification", task_id: backgroundTask, tool_use_id: backgroundTool,
        status: "completed", output_file: outputFile, summary: "Background command completed (exit code 0)",
        usage: { total_tokens: 0, tool_uses: 1, duration_ms: 10 }, uuid: randomUUID(), ...base,
      },
      {
        type: "system", subtype: "task_notification", task_id: agentTask, tool_use_id: agentTool,
        status: "completed", output_file: join(root, "agent.output"), summary: "Agent completed",
        uuid: randomUUID(), ...base,
      },
      { type: "system", subtype: "status", status: "requesting", permissionMode: "default", uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "assistant", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "text", text: "All concurrent work drained." }] },
      },
      result({ kind: "task-notification" }),
    ] as unknown as SDKMessage[];
    const fake = new FakeClaudeQuery(
      { name: "Bash", input: { command: "curl example.com" } }, undefined,
      afterResult, false, undefined, result(), undefined, beforeResult,
    );
    fake.streamPermissionTool = true;
    fake.deferPermissionResultUntilAfterPrimaryResult = true;
    fake.afterResultPause = { afterIndex: 0, wait: drainGate };
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(root), hub, new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root, approvalPolicy: "on-request" });
    const approvalIds: string[] = [];
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(
      started.thread.id, "test",
      async (method, params) => {
        events.push({ method, params });
        if (method === "turn/started" && events.filter((event) => event.method === "turn/started").length === 2) {
          const paused = await service.prepareGoalSet({ threadId: started.thread.id, status: "paused" });
          queueMicrotask(async () => { await paused.notify(); });
        }
      },
      (id) => {
        approvalIds.push(id);
      },
    );
    await (await service.prepareGoalSet({ threadId: started.thread.id, objective: "finish after all concurrent work" })).notify();
    const turn = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "run concurrent work", text_elements: [] }],
    });
    turn.announce();
    turn.start();

    await waitFor(async () => approvalIds.length === 1 && (await service.getGoal(started.thread.id)).goal!.tokensUsed === 2, "early terminal result with approval open");
    expect(fake.prompts).toHaveLength(1);
    expect(service.readThread(started.thread.id, true).thread.turns[0]?.status).toBe("inProgress");
    expect(events.filter((event) => event.method === "turn/started")).toHaveLength(1);

    await expect(service.resolveServerRequest(approvalIds[0]!, { decision: "accept" })).resolves.toBe(true);
    await waitFor(() => fake.permissionResults.length === 1, "approval tool result");
    expect(fake.prompts).toHaveLength(1);
    expect(service.readThread(started.thread.id, true).thread.turns[0]?.status).toBe("inProgress");
    releaseDrain();

    await waitFor(() => events.filter((event) => event.method === "turn/started").length === 2, "single goal continuation");
    await service.interruptTurn(started.thread.id);
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[1]?.status === "interrupted", "continuation stop");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(fake.prompts).toHaveLength(2);
    expect(events.filter((event) => event.method === "turn/started")).toHaveLength(2);
    expect((await service.getGoal(started.thread.id)).goal?.status).toBe("paused");
    const turns = service.readThread(started.thread.id, true).thread.turns;
    expect(turns).toHaveLength(2);
    expect(turns[0]?.id).toBe(turn.response.turn.id);
    expect(turns[1]?.items.some((item) => item.type === "userMessage")).toBe(false);
    const firstCompleted = events.findIndex((event) => event.method === "turn/completed"
      && (event.params as { turn?: { id?: string } }).turn?.id === turn.response.turn.id);
    const continuationStarted = events.findIndex((event, index) => index > firstCompleted && event.method === "turn/started");
    const completedTaskItems = events.filter((event) => event.method === "item/completed"
      && [backgroundTool, agentTool].includes((event.params as { item?: { id?: string } }).item?.id ?? ""));
    expect(completedTaskItems).toHaveLength(2);
    expect(events.filter((event) => event.method === "turn/completed"
      && (event.params as { turn?: { id?: string } }).turn?.id === turn.response.turn.id)).toHaveLength(1);
    expect(firstCompleted).toBeGreaterThan(events.findIndex((event) => event.method === "serverRequest/resolved"));
    expect(continuationStarted).toBeGreaterThan(firstCompleted);
    await service.close();
  });

  it("hydrates resume response before the goal snapshot and continuation", async () => {
    const root = directory();
    const path = join(root, "state.sqlite");
    const first = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(path), new FakeClaudeQuery().factory,
    );
    const started = await first.startThread({ model: "claude:haiku", cwd: root });
    await (await first.prepareGoalSet({ threadId: started.thread.id, objective: "resume automatically", tokenBudget: 5 })).notify();
    await first.close();

    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery();
    const resumed = new ClaudeService(config(root), hub, new Logger("error"), new SqliteHybridStore(path), fake.factory);
    const order: string[] = [];
    hub.subscribe(started.thread.id, "test", (method) => order.push(method));
    const resume = await resumed.prepareResume({ threadId: started.thread.id });
    expect(resume.response.thread.id).toBe(started.thread.id);
    expect(order).not.toContain("thread/goal/updated");
    const notification = (method: string) => {
      order.push(method);
      throw new Error("connection closed during snapshot");
    };
    await expect(resume.notifyGoalSnapshot(notification)).rejects.toThrow("connection closed during snapshot");
    await expect(resume.notifyGoalSnapshot(notification)).rejects.toThrow("connection closed during snapshot");
    expect(order.filter((method) => method === "thread/goal/updated")).toHaveLength(1);
    await waitFor(() => fake.prompts.length > 0, "resumed continuation");
    expect(order.indexOf("thread/goal/updated")).toBeLessThan(order.indexOf("turn/started"));
    expect(fake.prompts[0]?.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("resume automatically") }),
    ]));
    await resumed.close();
  });

  it("does not inherit goals into forks or auto-run an archived active goal", async () => {
    const root = directory();
    const fake = new FakeClaudeQuery();
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(root), hub, new Logger("error"), new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: root });
    const paused = await service.prepareGoalSet({ threadId: started.thread.id, objective: "source only", status: "paused" });
    await paused.notify();

    const fork = await service.forkThread({ threadId: started.thread.id });
    expect((await service.getGoal(fork.thread.id))).toEqual({ goal: null });

    const archived = await service.startThread({ model: "claude:haiku", cwd: root });
    await (await service.prepareGoalSet({
      threadId: archived.thread.id, objective: "archive then resume", status: "paused",
    })).notify();
    await service.archiveThread(archived.thread.id);
    const active = await service.prepareGoalSet({
      threadId: archived.thread.id, status: "active", tokenBudget: 5,
    });
    await active.notify();

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect((await service.getGoal(archived.thread.id)).goal?.status).toBe("active");
    expect(fake.prompts).toHaveLength(0);

    service.unarchiveThread(archived.thread.id);
    const resumedEvents: string[] = [];
    hub.subscribe(archived.thread.id, "resume-test", (method) => resumedEvents.push(method));
    const resumed = await service.prepareResume({ threadId: archived.thread.id });
    await resumed.notifyGoalSnapshot(() => undefined);
    const continuations = () => fake.prompts.filter((prompt) =>
      JSON.stringify(prompt).includes("Continue working toward the active thread goal"));
    await waitFor(() => continuations().length === 1, "unarchived goal continuation");
    expect(continuations()).toHaveLength(1);
    expect(resumedEvents.filter((method) => method === "turn/started")).toHaveLength(1);
    await waitFor(async () => (await service.getGoal(archived.thread.id)).goal?.status === "budgetLimited",
      "unarchived goal budget");
    await service.close();
  });

  it("persists goal identity and rejects stale usage after replacement", () => {
    const root = directory();
    const path = join(root, "state.sqlite");
    const store = new SqliteHybridStore(path);
    const now = Math.floor(Date.now() / 1_000);
    store.createThread({
      thread: {
        id: "thread", extra: null, sessionId: "session", forkedFromId: null, parentThreadId: null,
        preview: "", ephemeral: false, historyMode: "legacy", modelProvider: "claude", createdAt: now,
        updatedAt: now, recencyAt: now, status: { type: "idle" }, path: null, cwd: root,
        cliVersion: "test", source: "appServer", threadSource: null, agentNickname: null, agentRole: null,
        gitInfo: null, name: null, turns: [],
      },
      claudeSessionId: "claude", modelPickerId: "claude:haiku", claudeModelValue: "haiku",
      serviceTier: null, approvalPolicy: "on-request", approvalsReviewer: "user",
      sandboxPolicy: { type: "workspaceWrite" }, baseInstructions: null, developerInstructions: null,
      personality: null, resolvedModel: null, lastClaudeMessageUuid: null, lastCompletedTurnId: null,
      claudeCodeVersion: null, reasoningEffort: null, reasoningSummary: null, collaborationMode: null,
      outputSchema: null, tokenUsageTotal: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      tokenUsageLast: null, modelContextWindow: null,
    });
    const original = store.setGoal("thread", { objective: "old", tokenBudget: 100 });
    const replacement = store.setGoal("thread", { objective: "new", replace: true, tokenBudget: 10 });
    store.accountGoalUsage({ threadId: "thread", expectedGoalId: original.goalId, tokenDelta: 50, timeDeltaSeconds: 5 });
    expect(store.getGoal("thread")).toEqual(replacement);
    store.accountGoalUsage({
      threadId: "thread", expectedGoalId: replacement.goalId, tokenDelta: 4, timeDeltaSeconds: 2, checkpointKey: "event-1",
    });
    store.accountGoalUsage({
      threadId: "thread", expectedGoalId: replacement.goalId, tokenDelta: 4, timeDeltaSeconds: 2, checkpointKey: "event-1",
    });
    expect(store.getGoal("thread")).toMatchObject({ tokensUsed: 4, timeUsedSeconds: 2 });
    store.close();

    const reopened = new SqliteHybridStore(path);
    expect(reopened.getGoal("thread")).toMatchObject({ goalId: replacement.goalId, objective: "new", tokensUsed: 4 });
    reopened.deleteThread("thread");
    expect(reopened.getGoal("thread")).toBeUndefined();
    reopened.close();
  });
});
