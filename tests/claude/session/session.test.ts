import { describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread } from "../../../src/codex/generated/v2/Thread.js";
import type { ThreadSettings } from "../../../src/codex/generated/v2/ThreadSettings.js";
import type { Turn } from "../../../src/codex/generated/v2/Turn.js";
import type {
  ClaudeThreadRecord,
  EventPersistence,
  ThreadStateCommit,
} from "../../../src/store/HybridStore.js";
import { MemoryHybridStore } from "../../../src/store/memoryStore.js";
import { SubscriptionHub } from "../../../src/gateway/subscriptions.js";
import type {
  ClaudeSessionCommand, DesiredSettingsUpdate, GoalEffect, MainStreamFact, MainStreamProjection,
  PreparedGoalMutation, ProviderEventAdmission, RuntimeFactSource, RuntimeInspection, SessionLifecycleUpdate,
} from "../../../src/claude/session/commands.js";
import { ClaudeOutputAdapter } from "../../../src/claude/session/outputAdapter.js";
import { ClaudeSessionRepository } from "../../../src/claude/session/repository.js";
import { ClaudeSession } from "../../../src/claude/session/session.js";
import { ClaudeSessionRegistry } from "../../../src/claude/sessionRegistry.js";
import { MetricsRegistry } from "../../../src/observability/metrics.js";
import type { ClaudeHookRun } from "../../../src/claude/hookMapper.js";
import type { BackgroundOutputReader } from "../../../src/claude/session/backgroundOutput.js";

function record(threadId: string): ClaudeThreadRecord {
  const thread: Thread = {
    id: threadId,
    extra: null,
    sessionId: `session-${threadId}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    historyMode: "legacy",
    modelProvider: "claude",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    cliVersion: "claude-code",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
  return {
    thread,
    claudeSessionId: `claude-${threadId}`,
    modelPickerId: "claude:sonnet",
    claudeModelValue: "sonnet",
    serviceTier: null,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    baseInstructions: null,
    developerInstructions: null,
    personality: null,
    resolvedModel: null,
    lastClaudeMessageUuid: null,
    lastCompletedTurnId: null,
    claudeCodeVersion: null,
    reasoningEffort: null,
    reasoningSummary: null,
    collaborationMode: null,
    outputSchema: null,
    tokenUsageTotal: {
      totalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    tokenUsageLast: null,
    modelContextWindow: null,
  };
}

class ProvenanceStore extends MemoryHybridStore {
  public readonly sources: Array<{ method: string; providerEventId: string | null; providerEventType: string | null }> = [];

  public override appendEvent(
    threadId: string,
    turnId: string | null,
    method: string,
    params: unknown,
    persistence?: EventPersistence,
  ): number {
    this.sources.push({
      method,
      providerEventId: persistence?.providerEventId ?? null,
      providerEventType: persistence?.providerEventType ?? null,
    });
    return super.appendEvent(threadId, turnId, method, params, persistence);
  }
}

class TerminalCommitFailureStore extends MemoryHybridStore {
  public failTerminalCommit = false;
  public failCompactionCommit = false;
  public failBoundaryCommit = false;
  public failUsageCommit = false;

  public override commitThreadState(commit: ThreadStateCommit): number[] {
    if (this.failTerminalCommit && commit.events.some((event) => event.method === "turn/completed")) {
      throw new Error("injected terminal commit failure");
    }
    if (this.failCompactionCommit && commit.events.some((event) => event.method === "thread/compacted")) {
      throw new Error("injected compaction commit failure");
    }
    if (this.failBoundaryCommit && commit.providerBoundary) {
      throw new Error("injected provider boundary commit failure");
    }
    if (this.failUsageCommit && commit.events.some((event) => event.method === "thread/tokenUsage/updated")) {
      throw new Error("injected usage commit failure");
    }
    return super.commitThreadState(commit);
  }
}

function harness(
  onLifecycle: (update: SessionLifecycleUpdate) => void = () => undefined,
  store = new MemoryHybridStore(),
  backgroundOutputReader?: BackgroundOutputReader,
) {
  const hub = new SubscriptionHub();
  const repository = new ClaudeSessionRepository(store);
  const output = new ClaudeOutputAdapter(hub);
  const metrics = new MetricsRegistry();
  const registry = new ClaudeSessionRegistry<ClaudeSessionCommand, ClaudeSession>(
    (threadId) => new ClaudeSession(
      threadId, repository, output, undefined, metrics, onLifecycle,
      undefined, undefined, undefined, backgroundOutputReader,
    ),
  );
  return { store, hub, registry, metrics };
}

describe("ClaudeSession Phase 3 slice", () => {
  it.each(["shell", "compaction"] as const)(
    "does not persist or emit a partial %s terminal lifecycle when its atomic commit fails",
    async (kind) => {
      const store = new TerminalCommitFailureStore();
      const { hub, registry } = harness(undefined, store);
      const emitted: string[] = [];
      hub.subscribe("thread-1", "terminal-atomicity", (method) => emitted.push(method));
      await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
      await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });

      let turnId: string;
      let complete: () => Promise<unknown>;
      if (kind === "shell") {
        const started = await registry.submit<{ operationId: string; turnId: string }>(
          "thread-1",
          { type: "startShell", command: "printf done" },
        );
        turnId = started.turnId;
        complete = () => registry.submit("thread-1", {
          type: "finishShell",
          operationId: started.operationId,
          exitCode: 0,
        });
      } else {
        const started = await registry.submit<{ turnId: string }>("thread-1", { type: "startCompact" });
        turnId = started.turnId;
        complete = () => registry.submit("thread-1", {
          type: "compactBoundary",
          runtimeGeneration: 1,
          trigger: "manual",
          boundary: "summary-boundary",
          source: { providerEventId: "boundary", providerEventType: "compact_boundary" },
        });
      }

      const beforeTerminal = store.listEventsAfter("thread-1", 0).length;
      store.failTerminalCommit = true;
      await expect(complete()).rejects.toThrow("injected terminal commit failure");

      expect(store.getThreadRecord("thread-1", false)?.thread.status).toMatchObject({ type: "active" });
      expect(store.getTurn("thread-1", turnId)?.status).toBe("inProgress");
      expect(store.getThreadRecord("thread-1", false)?.lastClaudeMessageUuid).toBeNull();
      expect(store.getTurnClaudeMessageUuid("thread-1", turnId)).toBeUndefined();
      expect(store.listEventsAfter("thread-1", 0).slice(beforeTerminal)).toEqual([]);
      expect(emitted.slice(beforeTerminal)).toEqual([]);
      await registry.close();
    },
  );

  it("commits an automatic compaction boundary, provider tip, turn, and event through one session write", async () => {
    const store = new TerminalCommitFailureStore();
    const { registry } = harness(undefined, store);
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "compact automatically", text_elements: [] }],
      },
    });
    const before = store.listEventsAfter("thread-1", 0).length;
    store.failCompactionCommit = true;
    await expect(registry.submit("thread-1", {
      type: "compactBoundary",
      runtimeGeneration: 1,
      trigger: "auto",
      boundary: "auto-boundary",
      source: { providerEventId: "auto", providerEventType: "compact_boundary" },
    })).rejects.toThrow("injected compaction commit failure");

    expect(store.getThreadRecord("thread-1", false)?.lastClaudeMessageUuid).toBeNull();
    expect(store.getTurnClaudeMessageUuid("thread-1", prepared.turn.id)).toBeUndefined();
    expect(store.listEventsAfter("thread-1", 0).slice(before)).toEqual([]);
    await registry.close();
  });

  it("commits a provider boundary, root tip, and item correlations through one session write", async () => {
    const store = new TerminalCommitFailureStore();
    const { registry } = harness(undefined, store);
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "provider response", text_elements: [] }],
      },
    });
    store.failBoundaryCommit = true;
    await expect(registry.submit("thread-1", {
      type: "providerBoundary",
      runtimeGeneration: 1,
      providerMessageId: "provider-boundary",
      itemIds: ["item-1"],
    })).rejects.toThrow("injected provider boundary commit failure");

    expect(store.getThreadRecord("thread-1", false)?.lastClaudeMessageUuid).toBeNull();
    expect(store.getTurnClaudeMessageUuid("thread-1", prepared.turn.id)).toBeUndefined();
    expect(store.listProviderItemCorrelations("thread-1", ["provider-boundary"])).toEqual([]);
    await registry.close();
  });

  it("atomically commits a projected child boundary without changing the root provider tip", async () => {
    const store = new TerminalCommitFailureStore();
    const { registry } = harness(undefined, store);
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "prepareTurn",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "spawn a child", text_elements: [] }],
      },
    });
    await registry.submit("thread-1", {
      type: "providerBoundary",
      runtimeGeneration: 1,
      providerMessageId: "root-boundary",
      itemIds: [],
    });
    const spawned = await registry.submit<MainStreamProjection>("thread-1", {
      type: "mainStream",
      runtimeGeneration: 1,
      source: { providerEventId: "spawn", providerEventType: "task_started" },
      fact: {
        kind: "taskStart",
        taskId: "child-task",
        providerId: "spawn-tool",
        description: "child",
        subagentType: "general-purpose",
      },
    });
    const childThreadId = spawned.childThreadId!;
    const childTurnId = store.listTurns(childThreadId)[0]!.id;
    store.failBoundaryCommit = true;
    await expect(registry.submit("thread-1", {
      type: "providerBoundary",
      runtimeGeneration: 1,
      providerMessageId: "child-boundary",
      ownerThreadId: childThreadId,
      itemIds: ["child-item"],
    })).rejects.toThrow("injected provider boundary commit failure");

    expect(store.getThreadRecord("thread-1", false)?.lastClaudeMessageUuid).toBe("root-boundary");
    expect(store.getTurnClaudeMessageUuid(childThreadId, childTurnId)).toBeUndefined();
    expect(store.listProviderItemCorrelations("thread-1", ["child-boundary"])).toEqual([]);

    store.failBoundaryCommit = false;
    await registry.submit("thread-1", {
      type: "providerBoundary",
      runtimeGeneration: 1,
      providerMessageId: "child-boundary",
      ownerThreadId: childThreadId,
      itemIds: ["child-item"],
    });
    expect(store.getThreadRecord("thread-1", false)?.lastClaudeMessageUuid).toBe("root-boundary");
    expect(store.getTurnClaudeMessageUuid(childThreadId, childTurnId)).toBe("child-boundary");
    expect(store.listProviderItemCorrelations("thread-1", ["child-boundary"])).toMatchObject([{
      providerMessageId: "child-boundary",
      ownerThreadId: childThreadId,
      turnId: childTurnId,
      itemId: "child-item",
    }]);
    await registry.close();
  });

  it("keeps an auto-backgrounded MCP call on one item through progress and completion", async () => {
    const { store, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "run slow MCP", text_elements: [] }],
      },
    });
    const source = { providerEventId: "slow-mcp", providerEventType: "test" };
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "toolStart", index: 0,
        block: { type: "mcp_tool_use", id: "mcp-tool", name: "mcp__server__slow", input: {} },
      },
    });
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "taskStart", taskId: "mcp-task", providerId: "mcp-tool",
        description: "Slow MCP call", confirmed: true,
      },
    });
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: { kind: "taskProgress", taskId: "mcp-task", description: "Still running", durationMs: 120_000 },
    });
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "taskComplete", taskId: "mcp-task", providerId: "mcp-tool",
        status: "completed", summary: "MCP completed", durationMs: 121_000,
      },
    });

    expect(store.getTurn("thread-1", prepared.turn.id)?.items.filter((item) => item.id === "mcp-tool"))
      .toEqual([expect.objectContaining({
        type: "mcpToolCall", id: "mcp-tool", status: "completed", durationMs: 121_000,
      })]);
    const events = store.listEventsAfter("thread-1", 0);
    expect(events.filter((event) => event.method === "item/started"
      && (event.params as { item?: { id?: string } }).item?.id === "mcp-tool")).toHaveLength(1);
    expect(events.filter((event) => event.method === "item/mcpToolCall/progress"
      && (event.params as { itemId?: string }).itemId === "mcp-tool")).toHaveLength(1);
    expect(events.filter((event) => event.method === "item/completed"
      && (event.params as { item?: { id?: string } }).item?.id === "mcp-tool")).toHaveLength(1);
    await registry.close();
  });

  it("holds goal continuation behind every pending resume snapshot", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { store, registry } = harness((update) => lifecycle.push(update));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    store.setGoal("thread-1", { objective: "resume safely" });

    const snapshot = await registry.submit<{ reservationId: string }>("thread-1", {
      type: "goal", command: { kind: "resume" },
    });
    expect(snapshot).toMatchObject({ reservationId: expect.any(String) });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    expect(lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect) => effect.kind === "continue")).toHaveLength(0);

    await registry.submit("thread-1", {
      type: "goal", command: { kind: "resumeSnapshot", reservationId: snapshot.reservationId },
    });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "resumeSnapshot", reservationId: snapshot.reservationId },
    });
    expect(lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect) => effect.kind === "continue")).toHaveLength(1);
    await registry.close();
  });

  it("reads the current goal at the resume snapshot boundary", async () => {
    const { store, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    store.setGoal("thread-1", { objective: "old", status: "paused" });
    const first = await registry.submit<{ reservationId: string }>("thread-1", {
      type: "goal", command: { kind: "resume" },
    });
    const replacement = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", objective: "new" } },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation: replacement } });
    await expect(registry.submit("thread-1", {
      type: "goal", command: { kind: "resumeSnapshot", reservationId: first.reservationId },
    })).resolves.toMatchObject({ goal: { objective: "new" } });

    const second = await registry.submit<{ reservationId: string }>("thread-1", {
      type: "goal", command: { kind: "resume" },
    });
    const cleared = await registry.submit<Extract<PreparedGoalMutation, { kind: "clear" }>>("thread-1", {
      type: "goal", command: { kind: "prepareClear" },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation: cleared } });
    await expect(registry.submit("thread-1", {
      type: "goal", command: { kind: "resumeSnapshot", reservationId: second.reservationId },
    })).resolves.toBeUndefined();
    await registry.close();
  });

  it("returns no goal for projected children while mutations stay rejected and resume stays harmless", async () => {
    const { store, registry } = harness();
    const parent = record("parent");
    const child = record("child");
    child.thread.parentThreadId = parent.thread.id;
    await registry.submit("parent", { type: "createThread", record: parent });
    await registry.submit("child", { type: "createThread", record: child });
    store.setGoal("parent", { objective: "parent goal", status: "paused" });

    await expect(registry.submit("child", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "child", objective: "child goal" } },
    })).rejects.toThrow("projected Claude subagent thread does not support goals");
    await expect(registry.submit("child", {
      type: "goal", command: { kind: "get" },
    })).resolves.toBeUndefined();
    await expect(registry.submit("child", {
      type: "goal", command: { kind: "resume" },
    })).resolves.toBeUndefined();
    expect(store.getGoal("child")).toBeUndefined();
    expect(store.getGoal("parent")?.objective).toBe("parent goal");
    await registry.close();
  });

  it("wakes one archived goal after unarchive, runtime readiness, and snapshot release", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { store, registry } = harness((update) => lifecycle.push(update));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    store.setThreadArchived("thread-1", true);
    const mutation = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: {
        kind: "prepareSet", params: { threadId: "thread-1", objective: "wake", tokenBudget: 5 },
      },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation } });
    expect(lifecycle.flatMap((update) => update.goalEffects ?? [])).toEqual([]);

    store.setThreadArchived("thread-1", false);
    const snapshot = await registry.submit<{ reservationId: string }>("thread-1", {
      type: "goal", command: { kind: "resume" },
    });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "resumeSnapshot", reservationId: snapshot.reservationId },
    });
    expect(lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect) => effect.kind === "continue")).toHaveLength(1);
    await registry.close();
  });

  it("keeps synthetic status turns outside goal accounting and continuation", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { store, registry } = harness((update) => lifecycle.push(update));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    const goal = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", objective: "stay untouched" } },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation: goal } });
    const stale = lifecycle.flatMap((update) => update.goalEffects ?? [])
      .find((effect): effect is Extract<GoalEffect, { kind: "continue" }> => effect.kind === "continue")!;
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "/status", text_elements: [] }] },
      synthetic: "status",
    });
    await registry.submit("thread-1", {
      type: "completeSynthetic",
      turnId: prepared.turn.id,
      status: "completed",
      codexErrorInfo: null,
    });

    expect(store.getGoal("thread-1")).toEqual(goal.goal);
    const continuations = lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect): effect is Extract<GoalEffect, { kind: "continue" }> => effect.kind === "continue");
    expect(continuations).toHaveLength(2);
    const fresh = continuations[1]!;
    expect(await registry.submit("thread-1", {
      type: "prepareTurn", params: { threadId: "thread-1", input: [] },
      hiddenInput: true, goalOperation: stale,
    })).toBeUndefined();
    expect(await registry.submit("thread-1", {
      type: "prepareTurn", params: { threadId: "thread-1", input: [] },
      hiddenInput: true, goalOperation: fresh,
    })).toBeDefined();
    expect(store.getThreadRecord("thread-1", true)?.thread.turns
      .filter((turn) => turn.status === "inProgress")).toHaveLength(1);
    await registry.close();
  });

  it("rejects a queued continuation when compaction starts before admission", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { store, registry } = harness((update) => lifecycle.push(update));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    const mutation = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", objective: "compact race" } },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation } });
    const effect = lifecycle.flatMap((update) => update.goalEffects ?? [])
      .find((candidate): candidate is Extract<GoalEffect, { kind: "continue" }> =>
        candidate.kind === "continue")!;

    await registry.submit("thread-1", { type: "startCompact" });
    expect(await registry.submit<boolean>("thread-1", {
      type: "goal", command: { kind: "admitEffect", operationId: effect.operationId },
    })).toBe(false);
    await registry.submit("thread-1", {
      type: "goal", command: {
        kind: "effectFailed", goalId: effect.goalId,
        operationId: effect.operationId, runtimeGeneration: effect.runtimeGeneration,
      },
    });
    expect(store.getGoal("thread-1")?.status).toBe("active");
    await registry.close();
  });

  it("replaces a queued continuation prompt after an active goal patch", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { registry } = harness((update) => lifecycle.push(update));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    const oldMutation = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", objective: "old objective" } },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation: oldMutation } });
    const stale = lifecycle.flatMap((update) => update.goalEffects ?? [])
      .find((effect): effect is Extract<GoalEffect, { kind: "continue" }> => effect.kind === "continue")!;

    const nextMutation = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", objective: "new objective" } },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation: nextMutation } });
    expect(await registry.submit("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [] },
      hiddenInput: true,
      goalOperation: stale,
    })).toBeUndefined();
    const current = lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect): effect is Extract<GoalEffect, { kind: "continue" }> => effect.kind === "continue").at(-1)!;
    expect(current.operationId).not.toBe(stale.operationId);
    expect(current.prompt).toContain("new objective");
    await registry.close();
  });

  it("reschedules after a late transport drain rejects atomic continuation admission", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { registry } = harness((update) => lifecycle.push(update));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    const mutation = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", objective: "wait for drain" } },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation } });
    const stale = lifecycle.flatMap((update) => update.goalEffects ?? [])
      .find((effect): effect is Extract<GoalEffect, { kind: "continue" }> => effect.kind === "continue")!;
    const source = { providerEventId: null, providerEventType: null } as const;
    await registry.submit("thread-1", {
      type: "runtimeInputQueueChanged",
      runtimeGeneration: 1,
      pendingInputs: 1,
    });
    expect(await registry.submit("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [] },
      hiddenInput: true,
      goalOperation: stale,
    })).toBeUndefined();
    await registry.submit("thread-1", {
      type: "runtimeInputQueueChanged",
      runtimeGeneration: 1,
      pendingInputs: 0,
    });
    const continuations = lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect) => effect.kind === "continue");
    expect(continuations).toHaveLength(2);
    expect(continuations[1]!.operationId).not.toBe(stale.operationId);
    await registry.close();
  });

  it("fences queued goal effects when a user turn reserves the session", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { store, registry } = harness((update) => lifecycle.push(update));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    const mutation = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", objective: "ship" } },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation } });
    const effect = lifecycle.flatMap((update) => update.goalEffects ?? [])
      .find((candidate): candidate is Extract<GoalEffect, { kind: "ensureRuntime" }> =>
        candidate.kind === "ensureRuntime")!;

    await registry.submit("thread-1", { type: "goal", command: { kind: "reserveTurn" } });
    expect(await registry.submit<boolean>("thread-1", {
      type: "goal", command: { kind: "admitEffect", operationId: effect.operationId },
    })).toBe(false);
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "effectFailed", goalId: effect.goalId, operationId: effect.operationId },
    });
    expect(store.getGoal("thread-1")?.status).toBe("active");
    await registry.close();
  });

  it("binds staged input to the latest desired settings generation atomically", async () => {
    const { registry } = harness();
    const initial = record("thread-1");
    initial.thread.ephemeral = true;
    await registry.submit("thread-1", { type: "createThread", record: initial });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const candidate = { ...initial, claudeModelValue: "claude-new" };
    await registry.submit("thread-1", {
      type: "updateDesiredSettings",
      expectedGeneration: 0,
      candidate,
      threadSettings: { model: initial.modelPickerId } as ThreadSettings,
    });
    expect(await registry.submit("thread-1", {
      type: "stageRuntimeTurn",
      runtimeGeneration: 1,
      settingsGeneration: 0,
      messageUuid: "stale-stage",
    })).toMatchObject({
      kind: "stale",
      settings: { model: "claude-new", settingsGeneration: 1 },
    });
    expect(await registry.submit("thread-1", {
      type: "stageRuntimeTurn",
      runtimeGeneration: 1,
      settingsGeneration: 1,
      messageUuid: "bound-stage",
    })).toEqual({ kind: "staged" });
    expect(await registry.submit<RuntimeInspection>("thread-1", {
      type: "inspectRuntime", runtimeGeneration: 1,
    })).toMatchObject({ quiescent: false, canRestartEphemeral: false });
    await registry.submit("thread-1", {
      type: "cancelRuntimeTurnStage", runtimeGeneration: 1, messageUuid: "bound-stage",
    });
    await registry.close();
  });

  it("admits a staged goal continuation without regenerating the effect loop", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { registry } = harness((update) => lifecycle.push(update));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", { type: "runtimeReady", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    const mutation = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: {
        kind: "prepareSet", params: { threadId: "thread-1", objective: "continue once" },
      },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation } });
    const effect = lifecycle.flatMap((update) => update.goalEffects ?? [])
      .find((candidate): candidate is Extract<GoalEffect, { kind: "continue" }> =>
        candidate.kind === "continue")!;

    await registry.submit("thread-1", {
      type: "stageRuntimeTurn",
      runtimeGeneration: 1,
      settingsGeneration: 0,
      messageUuid: "rejected-stage",
    });
    await expect(registry.submit("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [] },
      hiddenInput: true,
      goalOperation: { ...effect, operationId: "stale-operation" },
      stagedMessageUuid: "rejected-stage",
    })).resolves.toBeUndefined();
    await expect(registry.submit("thread-1", {
      type: "cancelRuntimeTurnStage",
      runtimeGeneration: 1,
      messageUuid: "rejected-stage",
    })).resolves.toBe(false);
    await registry.submit("thread-1", {
      type: "stageRuntimeTurn",
      runtimeGeneration: 1,
      settingsGeneration: 0,
      messageUuid: "goal-stage",
    });
    await expect(registry.submit("thread-1", {
      type: "stageRuntimeTurn",
      runtimeGeneration: 1,
      settingsGeneration: 0,
      messageUuid: "goal-stage",
    })).resolves.toEqual({ kind: "staged" });
    await expect(registry.submit("thread-1", {
      type: "stageRuntimeTurn",
      runtimeGeneration: 1,
      settingsGeneration: 0,
      messageUuid: "competing-stage",
    })).resolves.toEqual({ kind: "busy" });
    await expect(registry.submit("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [] },
      hiddenInput: true,
      goalOperation: effect,
      stagedMessageUuid: "goal-stage",
    })).resolves.toMatchObject({ turn: { status: "inProgress" } });
    expect(lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((candidate) => candidate.kind === "continue")).toHaveLength(1);
    await expect(registry.submit("thread-1", {
      type: "cancelRuntimeTurnStage",
      runtimeGeneration: 1,
      messageUuid: "goal-stage",
    })).resolves.toBe(false);
    await registry.close();
  });

  it("fences continuation effects and readiness from replaced runtime generations", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { store, registry } = harness((update) => lifecycle.push(update));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    const mutation = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", objective: "ship" } },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation } });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    const stale = lifecycle.flatMap((update) => update.goalEffects ?? [])
      .find((candidate): candidate is Extract<GoalEffect, { kind: "continue" }> =>
        candidate.kind === "continue")!;

    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 2 });
    expect(await registry.submit<boolean>("thread-1", {
      type: "goal", command: { kind: "admitEffect", operationId: stale.operationId },
    })).toBe(false);
    await registry.submit("thread-1", {
      type: "goal", command: {
        kind: "effectFailed", goalId: stale.goalId, operationId: stale.operationId, runtimeGeneration: 1,
      },
    });
    const beforeReady = lifecycle.flatMap((update) => update.goalEffects ?? []).length;
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    expect(lifecycle.flatMap((update) => update.goalEffects ?? [])).toHaveLength(beforeReady);
    expect(store.getGoal("thread-1")?.status).toBe("active");

    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 2 },
    });
    expect(lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect) => effect.kind === "continue")).toHaveLength(2);
    await registry.close();
  });

  it("invalidates goal work across plan settings and silent runtime retirement", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { registry } = harness((update) => lifecycle.push(update));
    const initial = record("thread-1");
    await registry.submit("thread-1", { type: "createThread", record: initial });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    const goal = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", objective: "settings race" } },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation: goal } });
    const stale = lifecycle.flatMap((update) => update.goalEffects ?? [])
      .find((effect): effect is Extract<GoalEffect, { kind: "continue" }> => effect.kind === "continue")!;

    const planCandidate = {
      ...initial,
      collaborationMode: {
        mode: "plan",
        settings: { model: initial.modelPickerId, reasoning_effort: null, developer_instructions: null },
      },
    };
    const plan = await registry.submit<DesiredSettingsUpdate>("thread-1", {
      type: "updateDesiredSettings",
      expectedGeneration: 0,
      candidate: planCandidate,
      threadSettings: { model: initial.modelPickerId } as ThreadSettings,
    });
    expect(lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect) => effect.kind === "continue")).toHaveLength(1);
    await expect(registry.submit("thread-1", {
      type: "runtimeDetached", runtimeGeneration: 1,
    })).resolves.toBe(true);
    expect(await registry.submit("thread-1", {
      type: "prepareTurn", params: { threadId: "thread-1", input: [] },
      hiddenInput: true, goalOperation: stale,
    })).toBeUndefined();

    const defaultCandidate = {
      ...plan.record,
      collaborationMode: {
        mode: "default",
        settings: { model: initial.modelPickerId, reasoning_effort: null, developer_instructions: null },
      },
    };
    await registry.submit("thread-1", {
      type: "updateDesiredSettings",
      expectedGeneration: 1,
      candidate: defaultCandidate,
      threadSettings: { model: initial.modelPickerId } as ThreadSettings,
    });
    expect(lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect) => effect.kind === "ensureRuntime")).toHaveLength(1);
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 2 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 2 },
    });
    expect(lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect) => effect.kind === "continue")).toHaveLength(2);
    await registry.close();
  });

  it("does not admit an operation from a retired session incarnation", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { store, registry } = harness((update) => lifecycle.push(update));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    const mutation = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", objective: "survive retire" } },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation } });
    const stale = lifecycle.flatMap((update) => update.goalEffects ?? [])
      .find((effect): effect is Extract<GoalEffect, { kind: "continue" }> => effect.kind === "continue")!;

    await registry.retire("thread-1");
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 2 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 2 },
    });
    const current = lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect): effect is Extract<GoalEffect, { kind: "continue" }> => effect.kind === "continue").at(-1)!;
    expect(current.operationId).not.toBe(stale.operationId);
    expect(await registry.submit<boolean>("thread-1", {
      type: "goal", command: { kind: "admitEffect", operationId: stale.operationId },
    })).toBe(false);
    await registry.submit("thread-1", {
      type: "goal", command: {
        kind: "effectFailed", goalId: stale.goalId,
        operationId: stale.operationId, runtimeGeneration: stale.runtimeGeneration,
      },
    });
    expect(store.getGoal("thread-1")?.status).toBe("active");
    await registry.close();
  });

  it("clears a queued continuation when rollback detaches its silent runtime", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { registry } = harness((update) => lifecycle.push(update));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    const mutation = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", objective: "rollback safely" } },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation } });
    const stale = lifecycle.flatMap((update) => update.goalEffects ?? [])
      .find((effect): effect is Extract<GoalEffect, { kind: "continue" }> => effect.kind === "continue")!;
    const snapshot = await registry.submit<{ revision: string }>("thread-1", { type: "snapshotBranch" });
    await registry.submit("thread-1", {
      type: "commitRollback",
      expectedRevision: snapshot.revision,
      replacementSessionId: "replacement",
      keepCount: 0,
      sourceBoundaries: [],
      uuidMap: [],
    });
    await expect(registry.submit("thread-1", {
      type: "runtimeDetached", runtimeGeneration: 1,
    })).resolves.toBe(true);
    expect(await registry.submit("thread-1", {
      type: "prepareTurn", params: { threadId: "thread-1", input: [] },
      hiddenInput: true, goalOperation: stale,
    })).toBeUndefined();
    expect(lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect) => effect.kind === "ensureRuntime")).toHaveLength(1);
    await registry.close();
  });

  it("keeps resume gated after a raced silent detach", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { registry } = harness((update) => lifecycle.push(update));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    const mutation = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", objective: "resume race" } },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation } });
    const resume = await registry.submit<{ reservationId: string }>("thread-1", {
      type: "goal", command: { kind: "resume" },
    });
    await registry.submit("thread-1", { type: "runtimeDetached", runtimeGeneration: 1 });
    expect(lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect) => effect.kind === "ensureRuntime")).toHaveLength(0);
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "resumeSnapshot", reservationId: resume.reservationId },
    });
    expect(lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect) => effect.kind === "ensureRuntime")).toHaveLength(1);
    await registry.close();
  });

  it("steers once for concurrent byte-identical goal mutations", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { store, registry } = harness((update) => lifecycle.push(update));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    store.setGoal("thread-1", { objective: "old" });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    await registry.submit("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "work", text_elements: [] }] },
    });
    const first = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", objective: "new" } },
    });
    const second = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", objective: "new" } },
    });
    for (const mutation of [first, second]) {
      await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation } });
    }
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation: second } });

    expect(store.listEventsAfter("thread-1", 0)
      .filter((event) => event.method === "thread/goal/updated")).toHaveLength(3);
    expect(lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect) => effect.kind === "steer")).toHaveLength(1);
    await registry.close();
  });

  it("accounts repeated external mutations in one active turn with unique checkpoints", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const { store, registry } = harness();
      await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
      store.setGoal("thread-1", { objective: "account every interval" });
      await registry.submit("thread-1", {
        type: "prepareTurn",
        params: { threadId: "thread-1", input: [{ type: "text", text: "work", text_elements: [] }] },
      });

      for (const [elapsed, tokenBudget] of [[1_100, 10], [2_200, 20]] as const) {
        now = elapsed;
        const mutation = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
          type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", tokenBudget } },
        });
        await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation } });
      }

      expect(store.getGoal("thread-1")?.timeUsedSeconds).toBe(2);
      await registry.close();
    } finally {
      clock.mockRestore();
    }
  });

  it("uses a fresh accounting epoch when one turn pauses and reactivates a goal", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const { store, registry } = harness();
      await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
      store.setGoal("thread-1", { objective: "survive ABA" });
      await registry.submit("thread-1", {
        type: "prepareTurn",
        params: { threadId: "thread-1", input: [{ type: "text", text: "work", text_elements: [] }] },
      });
      for (const [elapsed, params] of [
        [1_100, { status: "paused" as const }],
        [2_200, { status: "active" as const }],
        [3_300, { tokenBudget: 100 }],
      ] as const) {
        now = elapsed;
        const mutation = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
          type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", ...params } },
        });
        await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation } });
      }
      expect(store.getGoal("thread-1")?.timeUsedSeconds).toBe(2);
      await registry.close();
    } finally {
      clock.mockRestore();
    }
  });

  it("steers one budget wrap-up when an active turn lowers its budget below usage", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { registry } = harness((update) => lifecycle.push(update));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    const created = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", objective: "fit budget" } },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation: created } });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "work", text_elements: [] }] },
    });
    await registry.submit("thread-1", {
      type: "goal", command: { kind: "usage", turnId: prepared.turn.id, eventId: "usage", tokenDelta: 10 },
    });
    const lowered = await registry.submit<Extract<PreparedGoalMutation, { kind: "set" }>>("thread-1", {
      type: "goal", command: { kind: "prepareSet", params: { threadId: "thread-1", tokenBudget: 5 } },
    });
    await registry.submit("thread-1", { type: "goal", command: { kind: "finalize", mutation: lowered } });
    const steers = lifecycle.flatMap((update) => update.goalEffects ?? [])
      .filter((effect): effect is Extract<GoalEffect, { kind: "steer" }> => effect.kind === "steer");
    expect(steers).toHaveLength(1);
    expect(steers[0]!.prompt).toContain("has reached its token budget");
    await registry.close();
  });

  it("creates, reads, and announces a thread through one session without an SDK runtime", async () => {
    const { store, hub, registry } = harness();
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe("thread-1", "test", (method, params) => events.push({ method, params }));

    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    const persisted = await registry.submit<ClaudeThreadRecord>(
      "thread-1",
      { type: "readThread", includeTurns: true },
    );
    expect(persisted.thread).toMatchObject({ id: "thread-1", status: { type: "idle" }, turns: [] });

    await registry.submit("thread-1", { type: "announceThread" });
    expect(store.listEventsAfter("thread-1", 0)).toMatchObject([{
      method: "thread/started",
      params: { thread: { id: "thread-1", status: { type: "idle" } } },
    }]);
    expect(events).toMatchObject([{
      method: "thread/started",
      params: { thread: { id: "thread-1", status: { type: "idle" } } },
    }]);
    await registry.close();
  });

  it("rejects duplicate or cross-session creation and remains usable after command errors", async () => {
    const { registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await expect(registry.submit(
      "thread-1",
      { type: "createThread", record: record("thread-1") },
    )).rejects.toThrow("already exists");
    await expect(registry.submit(
      "thread-2",
      { type: "createThread", record: record("wrong") },
    )).rejects.toThrow("Cannot create thread");
    expect((await registry.submit<ClaudeThreadRecord>(
      "thread-1",
      { type: "readThread", includeTurns: false },
    )).thread.id).toBe("thread-1");
    await registry.close();
  });

  it("rejects missing, duplicate, and wrong-turn fork provenance before either branch commit", async () => {
    const { store, registry } = harness();
    await registry.submit("source", { type: "createThread", record: record("source") });
    const one: Turn = {
      id: "one", items: [], itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    };
    const two = { ...one, id: "two" };
    store.createTurn("source", one);
    store.createTurn("source", two);
    store.setTurnClaudeMessageUuid("source", "one", "old-one");
    store.setTurnClaudeMessageUuid("source", "two", "old-two");
    const snapshot = await registry.submit<{
      record: ClaudeThreadRecord;
      revision: string;
    }>("source", { type: "snapshotBranch" });

    const target = record("target");
    for (const command of [
      {
        type: "commitForkTarget" as const, record: target, turns: [one],
        sourceBoundaries: [{ turnId: "one", messageUuid: "old-one" }], uuidMap: [],
      },
      {
        type: "commitForkTarget" as const, record: target, turns: [one],
        sourceBoundaries: [
          { turnId: "one", messageUuid: "old-one" },
          { turnId: "one", messageUuid: "old-two" },
        ],
        uuidMap: [["old-one", "new-one"], ["old-two", "new-two"]] as const,
      },
      {
        type: "commitForkTarget" as const, record: target, turns: [one],
        sourceBoundaries: [{ turnId: "two", messageUuid: "old-two" }],
        uuidMap: [["old-two", "new-two"]] as const,
      },
    ]) {
      await expect(registry.submit("target", command)).rejects.toThrow("invalid provenance");
      expect(store.hasThread("target")).toBe(false);
    }

    for (const sourceBoundaries of [
      [{ turnId: "one", messageUuid: "old-one" }],
      [
        { turnId: "one", messageUuid: "old-one" },
        { turnId: "one", messageUuid: "old-two" },
      ],
      [{ turnId: "two", messageUuid: "old-two" }],
    ]) {
      await expect(registry.submit("source", {
        type: "commitRollback",
        expectedRevision: snapshot.revision,
        replacementSessionId: "replacement",
        keepCount: 1,
        sourceBoundaries,
        uuidMap: sourceBoundaries.length === 1 && sourceBoundaries[0]!.messageUuid === "old-one"
          ? [] : [["old-one", "new-one"], ["old-two", "new-two"]],
      })).rejects.toThrow("invalid provenance");
      expect(store.getThreadRecord("source", true)?.thread.turns.map((turn) => turn.id)).toEqual(["one", "two"]);
    }
    await registry.close();
  });

  it("persists the started event before publishing it live", async () => {
    const { store, hub, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    hub.subscribe("thread-1", "test", () => {
      expect(store.listEventsAfter("thread-1", 0).at(-1)?.method).toBe("thread/started");
    });
    await registry.submit("thread-1", { type: "announceThread" });
    await registry.close();
  });

  it("owns validated settings commits with generation fencing and persistence-before-publication", async () => {
    const { store, hub, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    const advertised: string[] = [];
    hub.subscribe("thread-1", "settings", (method, params) => {
      if (method !== "thread/settings/updated") return;
      const model = (params as { threadSettings: { model: string } }).threadSettings.model;
      expect(store.getThreadRecord("thread-1")?.modelPickerId).toBe(model);
      expect(store.listEventsAfter("thread-1", 0).at(-1)?.method).toBe(method);
      advertised.push(model);
    });

    const initial = record("thread-1");
    const opusCandidate = {
      ...initial,
      modelPickerId: "claude:claude-opus-4-8",
      claudeModelValue: "claude-opus-4-8",
      reasoningEffort: "high",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "claude:claude-opus-4-8",
          reasoning_effort: "high",
          developer_instructions: null,
        },
      },
    };
    const opus = await registry.submit<{
      record: ClaudeThreadRecord;
      changed: boolean;
      conflict: boolean;
    }>("thread-1", {
      type: "updateDesiredSettings",
      expectedGeneration: 0,
      candidate: opusCandidate,
      threadSettings: { model: opusCandidate.modelPickerId } as ThreadSettings,
    });
    expect(opus).toMatchObject({
      changed: true,
      conflict: false,
      record: {
        settingsGeneration: 1,
        modelPickerId: "claude:claude-opus-4-8",
        reasoningEffort: "high",
        collaborationMode: {
          settings: { model: "claude:claude-opus-4-8", reasoning_effort: "high" },
        },
      },
    });

    await expect(registry.submit("thread-1", {
      type: "updateDesiredSettings",
      expectedGeneration: 0,
      candidate: { ...initial, reasoningEffort: "low" },
      threadSettings: { model: initial.modelPickerId } as ThreadSettings,
    })).resolves.toMatchObject({ changed: false, conflict: true });
    expect(store.getThreadRecord("thread-1")).toMatchObject({
      settingsGeneration: 1,
      modelPickerId: "claude:claude-opus-4-8",
      reasoningEffort: "high",
    });

    const sonnetCandidate = {
      ...opus.record,
      modelPickerId: "claude:sonnet",
      claudeModelValue: "sonnet",
      reasoningEffort: "low",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "claude:sonnet",
          reasoning_effort: "low",
          developer_instructions: null,
        },
      },
    };
    await expect(registry.submit("thread-1", {
      type: "updateDesiredSettings",
      expectedGeneration: 1,
      candidate: sonnetCandidate,
      threadSettings: { model: sonnetCandidate.modelPickerId } as ThreadSettings,
    })).resolves.toMatchObject({
      changed: true,
      conflict: false,
      record: { settingsGeneration: 2, modelPickerId: "claude:sonnet", reasoningEffort: "low" },
    });
    expect(advertised).toEqual(["claude:claude-opus-4-8", "claude:sonnet"]);
    await registry.close();
  });

  it("owns turn creation, active thread state, and ordered start projection", async () => {
    const { store, hub, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    const events: Array<{ method: string; persisted: string[] }> = [];
    hub.subscribe("thread-1", "test", (method) => {
      events.push({
        method,
        persisted: store.listEventsAfter("thread-1", 0).map((event) => event.method),
      });
    });

    const prepared = await registry.submit<{ record: ClaudeThreadRecord; turn: Turn }>(
      "thread-1",
      {
        type: "prepareTurn",
        params: {
          threadId: "thread-1",
          clientUserMessageId: "client-1",
          input: [{ type: "text", text: "hello", text_elements: [] }],
        },
      },
    );
    expect(prepared.record.thread).toMatchObject({
      preview: "hello",
      status: { type: "active", activeFlags: [] },
    });
    expect(store.getTurn("thread-1", prepared.turn.id)).toMatchObject({
      status: "inProgress",
      items: [{ type: "userMessage", clientId: "client-1" }],
    });
    expect(events.map((event) => event.method)).toEqual(["thread/status/changed"]);

    await registry.submit("thread-1", { type: "announceTurn", turnId: prepared.turn.id });
    await registry.submit("thread-1", { type: "announceTurn", turnId: prepared.turn.id });
    expect(events.map((event) => event.method)).toEqual([
      "thread/status/changed",
      "turn/started",
      "item/started",
      "item/completed",
    ]);
    for (const event of events) expect(event.persisted).toContain(event.method);
    await registry.close();

    const rematerialized = new ClaudeSessionRegistry<ClaudeSessionCommand, ClaudeSession>(
      (threadId) => new ClaudeSession(
        threadId,
        new ClaudeSessionRepository(store),
        new ClaudeOutputAdapter(hub),
      ),
    );
    await rematerialized.submit("thread-1", { type: "announceTurn", turnId: prepared.turn.id });
    expect(events.map((event) => event.method)).toEqual([
      "thread/status/changed",
      "turn/started",
      "item/started",
      "item/completed",
    ]);
    await rematerialized.close();
  });

  it("fences facts from a retired runtime generation", async () => {
    const { store, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 4 });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 5 });
    await expect(registry.submit(
      "thread-1",
      { type: "attachRuntime", runtimeGeneration: 3 },
    )).rejects.toThrow("stale Claude runtime generation");
    await expect(registry.submit(
      "thread-1",
      {
        type: "runtimeInitialized",
        runtimeGeneration: 5,
        providerSessionId: "wrong",
        model: "haiku",
        cliVersion: "2.1.215",
      },
    )).rejects.toThrow("expected 'claude-thread-1'");
    await registry.submit("thread-1", {
      type: "runtimeInitialized",
      runtimeGeneration: 5,
      providerSessionId: "claude-thread-1",
      model: "claude-haiku-4-5",
      cliVersion: "2.1.215",
    });
    expect(store.getThreadRecord("thread-1")).toMatchObject({
      resolvedModel: "claude-haiku-4-5",
      claudeCodeVersion: "2.1.215",
      thread: { cliVersion: "2.1.215" },
    });
    await registry.submit("thread-1", {
      type: "runtimeInitialized",
      runtimeGeneration: 4,
      providerSessionId: "claude-thread-1",
      model: "stale",
      cliVersion: "stale",
    });
    expect(store.getThreadRecord("thread-1")?.resolvedModel).toBe("claude-haiku-4-5");
    await registry.close();
  });

  it("drops a late background-output chunk after runtime retirement", async () => {
    const { store, registry } = harness();
    const outputFile = join(mkdtempSync(join(tmpdir(), "ccodex-session-tailer-stop-")), "task.output");
    writeFileSync(outputFile, "");
    const source = { providerEventId: "tailer", providerEventType: "background_output" };
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "background", text_elements: [] }] },
    });
    await registry.submit("thread-1", {
      type: "mainStream",
      runtimeGeneration: 1,
      source,
      fact: {
        kind: "toolStart",
        index: 0,
        block: {
          type: "tool_use",
          id: "background-bash",
          name: "Bash",
          input: { command: "sleep 1; echo late", run_in_background: true },
        },
      },
    });
    await registry.submit("thread-1", {
      type: "mainStream",
      runtimeGeneration: 1,
      source,
      fact: {
        kind: "taskStart",
        taskId: "background-task",
        providerId: "background-bash",
        description: "background Bash",
        taskType: "bash",
        outputFile,
      },
    });
    await registry.submit("thread-1", { type: "runtimeDetached", runtimeGeneration: 1 });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 2 });
    appendFileSync(outputFile, "late from file\n");
    await registry.submit("thread-1", {
      type: "mainStream",
      runtimeGeneration: 1,
      source,
      fact: { kind: "taskOutput", taskId: "background-task", delta: "late\n" },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(store.getTurn("thread-1", prepared.turn.id)?.items).toContainEqual(expect.objectContaining({
      type: "commandExecution",
      id: "background-bash",
      aggregatedOutput: null,
    }));
    await registry.close();
  });

  it("drains background output before the command terminal and turn terminal", async () => {
    const { store, hub, registry } = harness();
    const outputFile = join(mkdtempSync(join(tmpdir(), "ccodex-session-tailer-")), "task.output");
    writeFileSync(outputFile, "first\n");
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "background", text_elements: [] }] },
    });
    const methods: string[] = [];
    hub.subscribe("thread-1", "tailer", (method) => methods.push(method));
    const source = { providerEventId: "task", providerEventType: "task_notification" };
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "toolStart", index: 0,
        block: { type: "tool_use", id: "bash", name: "Bash", input: { command: "ticks" } },
      },
    });
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "taskStart", taskId: "task", providerId: "bash",
        description: "ticks", taskType: "bash", outputFile,
      },
    });
    await vi.waitFor(() => expect(store.getTurn("thread-1", prepared.turn.id)?.items)
      .toContainEqual(expect.objectContaining({ id: "bash", aggregatedOutput: "first\n" })));
    appendFileSync(outputFile, "second\n");
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "taskComplete", taskId: "task", providerId: "bash", status: "completed",
        summary: "completed (exit code 0)", outputFile,
      },
    });
    await registry.submit("thread-1", {
      type: "lifecycle", runtimeGeneration: 1, source,
      fact: { type: "result", status: "completed", codexErrorInfo: null, origin: null },
    });
    expect(store.getTurn("thread-1", prepared.turn.id)).toMatchObject({
      status: "completed",
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "bash", status: "completed", aggregatedOutput: "first\nsecond\n", exitCode: 0,
        }),
      ]),
    });
    expect(methods.indexOf("item/commandExecution/outputDelta")).toBeLessThan(methods.indexOf("item/completed"));
    expect(methods.indexOf("item/completed")).toBeLessThan(methods.indexOf("turn/completed"));
    await registry.close();
  });

  it("waits for confirmed background task identity after approval before publishing the command", async () => {
    const { store, hub, registry } = harness();
    const events: Array<{ method: string; params: unknown }> = [];
    const source: RuntimeFactSource = { providerEventId: "background", providerEventType: "test" };
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "background", text_elements: [] }] },
    });
    hub.subscribe("thread-1", "background-confirmation", (method, params) => events.push({ method, params }));
    const stream = (fact: MainStreamFact) => registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source, fact,
    });
    await stream({
      kind: "toolStart",
      index: 0,
      block: {
        type: "tool_use",
        id: "background-bash",
        name: "Bash",
        input: { command: "sleep 5; echo done", run_in_background: true },
      },
    });
    await stream({ kind: "toolBegin", providerId: "background-bash" });
    expect(events.filter((event) => event.method === "item/started")).toEqual([]);

    await stream({
      kind: "taskStart",
      taskId: "background-task",
      providerId: "background-bash",
      description: "sleep 5; echo done",
      taskType: "bash",
      confirmed: true,
    });
    const starts = events.filter((event) => event.method === "item/started");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.params).toMatchObject({
      threadId: "thread-1",
      turnId: prepared.turn.id,
      item: {
        id: "background-bash",
        type: "commandExecution",
        command: "sleep 5; echo done",
        status: "inProgress",
        processId: "background-task",
      },
    });

    await stream({ kind: "taskOutput", taskId: "background-task", delta: "done\n" });
    await stream({
      kind: "taskComplete",
      taskId: "background-task",
      providerId: "background-bash",
      status: "completed",
      summary: "completed (exit code 0)",
    });
    expect(events.filter((event) => event.method === "item/started")).toHaveLength(1);
    expect(events.filter((event) => event.method === "item/commandExecution/outputDelta")).toHaveLength(1);
    expect(events.filter((event) => event.method === "item/completed")).toHaveLength(1);
    expect(store.getTurn("thread-1", prepared.turn.id)?.items).toContainEqual(expect.objectContaining({
      id: "background-bash",
      processId: "background-task",
      status: "completed",
      aggregatedOutput: "done\n",
    }));
    await registry.close();
  });

  it("keeps the mailbox responsive while ordering a slow background drain before task terminal", async () => {
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseRead = resolve; });
    let calls = 0;
    const reader: BackgroundOutputReader = async (_path, offset, consume) => {
      if (calls++ === 0) {
        markReadStarted();
        await release;
        await consume(Buffer.from("slow output\n"));
        return offset + Buffer.byteLength("slow output\n");
      }
      return offset;
    };
    const { hub, registry } = harness(undefined, undefined, reader);
    const methods: string[] = [];
    hub.subscribe("thread-1", "slow-tailer", (method) => methods.push(method));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "background", text_elements: [] }] },
    });
    const source = { providerEventId: "task", providerEventType: "task_notification" };
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "toolStart", index: 0,
        block: { type: "tool_use", id: "bash", name: "Bash", input: { command: "slow" } },
      },
    });
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "taskStart", taskId: "task", providerId: "bash",
        description: "slow", taskType: "bash", outputFile: "/ignored-by-test-reader",
      },
    });
    await readStarted;
    let terminalSettled = false;
    const terminal = registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "taskComplete", taskId: "task", providerId: "bash", status: "completed",
        summary: "completed (exit code 0)", outputFile: "/ignored-by-test-reader",
      },
    }).then(() => { terminalSettled = true; });

    await expect(registry.submit<RuntimeInspection>("thread-1", {
      type: "inspectRuntime", runtimeGeneration: 1,
    })).resolves.toMatchObject({ activeTurnId: expect.any(String) });
    expect(terminalSettled).toBe(false);

    releaseRead();
    await terminal;
    expect(methods.indexOf("item/commandExecution/outputDelta")).toBeLessThan(methods.indexOf("item/completed"));
    await registry.close();
  });

  it("owns file snapshot correlation and hook display order across provider callbacks", async () => {
    const { store, registry } = harness();
    const cwd = mkdtempSync(join(tmpdir(), "ccodex-session-file-hook-"));
    const path = join(cwd, "example.txt");
    writeFileSync(path, "before\n");
    const initial = record("thread-1");
    initial.thread.cwd = cwd;
    await registry.submit("thread-1", { type: "createThread", record: initial });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "edit", text_elements: [] }] },
    });
    const source = { providerEventId: "hook", providerEventType: "system/hook" };
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "toolStart", index: 0,
        block: { type: "tool_use", id: "edit", name: "Edit", input: { file_path: path } },
      },
    });
    await expect(registry.submit("thread-1", {
      type: "captureToolFileBefore", runtimeGeneration: 1,
      providerId: "edit", toolName: "Edit", input: { file_path: path },
    })).resolves.toBe(true);
    writeFileSync(path, "after\n");
    await expect(registry.submit("thread-1", {
      type: "captureToolFileAfter", runtimeGeneration: 1, providerId: "edit",
    })).resolves.toBe(true);
    for (const [hookId, hookName] of [["hook-1", "first.sh"], ["hook-2", "second.sh"]] as const) {
      await registry.submit("thread-1", {
        type: "hook", runtimeGeneration: 1, source,
        fact: {
          kind: "started", hookId, hookEvent: "PostToolUse", hookName,
        },
      });
      await registry.submit("thread-1", {
        type: "hook", runtimeGeneration: 1, source,
        fact: {
          kind: "progress", hookId,
          output: "", stdout: `${hookName} output`, stderr: "",
        },
      });
      await registry.submit("thread-1", {
        type: "hook", runtimeGeneration: 1, source,
        fact: {
          kind: "response", hookId,
          output: "", stdout: "", stderr: "", outcome: "success", exitCode: 0,
        },
      });
    }
    expect(store.getTurn("thread-1", prepared.turn.id)?.items).toContainEqual(expect.objectContaining({
      id: "edit",
      type: "fileChange",
      changes: [expect.objectContaining({ path, diff: expect.stringContaining("-before") })],
    }));
    const hookEvents = store.listEventsAfter("thread-1", 0)
      .filter((event) => event.method === "hook/completed")
      .map((event) => (event.params as { run: ClaudeHookRun }).run);
    expect(hookEvents).toMatchObject([
      { id: "hook-1", displayOrder: 0, entries: [{ text: "first.sh output" }] },
      { id: "hook-2", displayOrder: 1, entries: [{ text: "second.sh output" }] },
    ]);
    await registry.close();
  });

  it("keeps an out-of-band lifecycle diagnostic out of the App event stream", async () => {
    const store = new ProvenanceStore();
    const { registry } = harness(() => undefined, store);
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "wait", text_elements: [] }] },
    });
    const providerSource = { providerEventId: "provider-a", providerEventType: "task_notification" };
    await registry.submit("thread-1", {
      type: "lifecycle",
      runtimeGeneration: 1,
      source: providerSource,
      fact: { type: "taskNotification" },
    });
    await registry.submit("thread-1", {
      type: "lifecycle",
      runtimeGeneration: 1,
      source: providerSource,
      fact: { type: "result", status: "completed", codexErrorInfo: null, origin: null },
    });
    const beforeTimer = store.sources.length;
    await registry.submit("thread-1", {
      type: "lifecycle",
      runtimeGeneration: 1,
      source: { providerEventId: null, providerEventType: null },
      fact: { type: "timer", generation: 1 },
    });

    expect(store.sources.slice(beforeTimer)).toEqual([]);
    await registry.close();
  });

  it("owns main text/reasoning reconciliation and persists each projection before publication", async () => {
    const { store, hub, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "work", text_elements: [] }] },
    });
    const methods: string[] = [];
    hub.subscribe("thread-1", "stream", (method) => {
      methods.push(method);
      if (method === "item/agentMessage/delta") {
        expect(store.getTurn("thread-1", prepared.turn.id)?.items).toContainEqual(
          expect.objectContaining({ type: "agentMessage", text: "Working" }),
        );
        expect(store.listEventsAfter("thread-1", 0).at(-1)?.method).toBe(method);
      }
    });
    const source = { providerEventId: "provider-1", providerEventType: "stream_event" };
    const stream = (fact: MainStreamFact) => registry.submit(
      "thread-1",
      { type: "mainStream", runtimeGeneration: 1, source, fact },
    );

    await stream({ kind: "messageStart" });
    await stream({ kind: "blockStart", index: 0, block: "text" });
    await stream({ kind: "blockDelta", index: 0, block: "text", delta: "Working" });
    await stream({
      kind: "assistant",
      blocks: [{ block: "text", text: "Working" }],
      completeAsCommentary: false,
    });
    await stream({ kind: "messageStart" });
    await stream({ kind: "blockStart", index: 0, block: "reasoning" });
    await stream({ kind: "blockDelta", index: 0, block: "reasoning", delta: "Inspecting" });
    await stream({ kind: "blockStop", index: 0 });
    await stream({ kind: "blockStart", index: 1, block: "reasoning" });
    await stream({ kind: "blockDelta", index: 1, block: "reasoning", delta: "Drafting" });
    await stream({
      kind: "assistant",
      blocks: [
        { block: "reasoning", text: "Inspecting" },
        { block: "reasoning", text: "Drafting" },
      ],
      completeAsCommentary: false,
    });
    await stream({ kind: "finish" });

    expect(store.getTurn("thread-1", prepared.turn.id)?.items).toEqual([
      expect.objectContaining({ type: "userMessage" }),
      expect.objectContaining({ type: "agentMessage", text: "Working", phase: "commentary" }),
      expect.objectContaining({ type: "reasoning", summary: ["Inspecting", "Drafting"], content: [] }),
    ]);
    expect(methods.filter((method) => method === "item/reasoning/summaryPartAdded")).toHaveLength(1);
    expect(methods.filter((method) => method === "item/completed")).toHaveLength(2);
    await registry.close();
  });

  it("owns usage, exact terminal state, and visible error ordering", async () => {
    const { store, hub, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 2 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "fail", text_elements: [] }] },
    });
    const methods: string[] = [];
    hub.subscribe("thread-1", "terminal", (method) => {
      methods.push(method);
      if (method === "thread/status/changed") {
        expect(store.listEventsAfter("thread-1", 0).slice(-3).map((event) => event.method)).toEqual([
          "thread/status/changed",
          "error",
          "turn/completed",
        ]);
      }
      if (method === "turn/completed") {
        expect(store.getTurn("thread-1", prepared.turn.id)).toMatchObject({
          status: "failed",
          error: { message: "provider failed", codexErrorInfo: "badRequest" },
        });
      }
    });
    await registry.submit("thread-1", {
      type: "accountUsage",
      runtimeGeneration: 2,
      costUsd: 0.75,
      aggregate: {
        totalTokens: 12,
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 2,
        reasoningOutputTokens: 0,
      },
    });
    const usage = {
      type: "publishUsage" as const,
      runtimeGeneration: 2,
      turnId: prepared.turn.id,
      last: {
        totalTokens: 8,
        inputTokens: 6,
        cachedInputTokens: 4,
        outputTokens: 2,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 200_000,
    };
    await registry.submit("thread-1", usage);
    await registry.submit("thread-1", usage);
    await registry.submit("thread-1", {
      type: "lifecycle",
      runtimeGeneration: 2,
      fact: {
        type: "result", status: "failed", errorMessage: "provider failed",
        codexErrorInfo: "badRequest", origin: null,
      },
      source: { providerEventId: "result-1", providerEventType: "result" },
    });

    expect(methods).toEqual([
      "thread/tokenUsage/updated",
      "thread/status/changed",
      "error",
      "turn/completed",
    ]);
    expect(store.getThreadRecord("thread-1")).toMatchObject({
      lastCompletedTurnId: prepared.turn.id,
      tokenUsageTotal: { totalTokens: 12 },
      tokenUsageLast: { totalTokens: 8 },
      modelContextWindow: 200_000,
      providerCostUsdTotal: 0.75,
      thread: { status: { type: "idle" } },
    });
    await registry.close();
  });

  it("commits usage state and its replayable event atomically before live publication", async () => {
    const store = new TerminalCommitFailureStore();
    const { hub, registry } = harness(undefined, store);
    const emitted: string[] = [];
    hub.subscribe("thread-1", "usage-atomicity", (method) => emitted.push(method));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const usage = {
      type: "publishUsage" as const,
      runtimeGeneration: 1,
      turnId: "usage-turn",
      last: {
        totalTokens: 8,
        inputTokens: 6,
        cachedInputTokens: 4,
        outputTokens: 2,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 200_000,
    };

    store.failUsageCommit = true;
    await expect(registry.submit("thread-1", usage)).rejects.toThrow("injected usage commit failure");
    expect(store.getThreadRecord("thread-1", false)).toMatchObject({
      tokenUsageLast: null,
      modelContextWindow: null,
    });
    expect(store.listEventsAfter("thread-1", 0)).toEqual([]);
    expect(emitted).toEqual([]);

    store.failUsageCommit = false;
    await registry.submit("thread-1", usage);
    expect(store.getThreadRecord("thread-1", false)).toMatchObject({
      tokenUsageLast: { totalTokens: 8 },
      modelContextWindow: 200_000,
    });
    expect(store.listEventsAfter("thread-1", 0).map((event) => event.method))
      .toEqual(["thread/tokenUsage/updated"]);
    expect(emitted).toEqual(["thread/tokenUsage/updated"]);
    await registry.close();
  });

  it("keeps tool correlation alive across stream finish until its late result", async () => {
    const { store, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "run", text_elements: [] }] },
    });
    const stream = (fact: MainStreamFact) => registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1,
      source: { providerEventId: "late-tool", providerEventType: "stream_event" }, fact,
    });
    await stream({ kind: "toolStart", index: 0, block: {
      type: "tool_use", id: "late-bash", name: "Bash", input: { command: "printf OK" },
    } });
    await stream({ kind: "finish" });
    await stream({ kind: "toolComplete", providerId: "late-bash", output: "OK", isError: false });
    expect(store.getTurn("thread-1", prepared.turn.id)?.items).toContainEqual(expect.objectContaining({
      type: "commandExecution", id: "late-bash", status: "completed", aggregatedOutput: "OK",
    }));
    await registry.close();
  });

  it("owns child approvals and resolves them through the root session rail", async () => {
    const { store, hub, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "delegate", text_elements: [] }] },
    });
    const child = await registry.submit<{ childThreadId: string }>("thread-1", {
      type: "mainStream", runtimeGeneration: 1,
      source: { providerEventId: "child-start", providerEventType: "task_started" },
      fact: {
        kind: "taskStart", taskId: "child-task", description: "inspect",
        prompt: "inspect", taskType: "agent", subagentType: "Explore",
      },
    });
    const requests: string[] = [];
    hub.subscribe(child.childThreadId, "child-approval", () => undefined, (id) => requests.push(id));
    const opened = await registry.submit<{ requestId: string }>("thread-1", {
      type: "openInteraction",
      runtimeGeneration: 1,
      request: {
        threadId: child.childThreadId, turnId: store.listTurns(child.childThreadId)[0]!.id,
        claudeRequestId: "child-provider-request", method: "item/commandExecution/requestApproval",
        params: { command: "curl example.com" },
      },
    });
    await registry.submit("thread-1", {
      type: "announceInteraction", runtimeGeneration: 1, requestId: opened.requestId,
    });
    const response = registry.submit("thread-1", {
      type: "waitInteraction",
      runtimeGeneration: 1,
      requestId: opened.requestId,
    });
    expect(requests).toEqual([opened.requestId]);
    expect(store.getThreadRecord(child.childThreadId)?.thread.status).toEqual({
      type: "active", activeFlags: ["waitingOnApproval"],
    });
    await expect(registry.submit("thread-1", {
      type: "resolveInteraction", requestId: opened.requestId, response: { decision: "accept" },
    })).resolves.toBe(true);
    await expect(response).resolves.toEqual({ decision: "accept" });
    expect(store.getThreadRecord(child.childThreadId)?.thread.status).toEqual({
      type: "active", activeFlags: [],
    });
    await registry.close();
  });

  it("owns main interaction persistence, delivery, and idempotent resolution", async () => {
    const { store, hub, registry, metrics } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "work", text_elements: [] }] },
    });
    const requests: Array<{ id: string; method: string }> = [];
    const resolved: string[] = [];
    hub.subscribe(
      "thread-1",
      "interaction",
      (method) => resolved.push(method),
      (id, method) => requests.push({ id, method }),
    );
    const opened = await registry.submit<{ requestId: string; pending: boolean }>("thread-1", {
      type: "openInteraction",
      runtimeGeneration: 1,
      request: {
        threadId: "thread-1",
        turnId: prepared.turn.id,
        claudeRequestId: "claude-request-1",
        method: "item/commandExecution/requestApproval",
        params: { command: "curl example.com" },
      },
    });
    await registry.submit("thread-1", {
      type: "announceInteraction",
      runtimeGeneration: 1,
      requestId: opened.requestId,
    });
    const response = registry.submit("thread-1", {
      type: "waitInteraction",
      runtimeGeneration: 1,
      requestId: opened.requestId,
    });
    expect(store.getThreadRecord("thread-1")?.thread.status).toEqual({
      type: "active",
      activeFlags: ["waitingOnApproval"],
    });
    expect(requests).toEqual([{
      id: opened.requestId,
      method: "item/commandExecution/requestApproval",
    }]);
    const source = { providerEventId: "approval-result", providerEventType: "test" };
    for (const fact of [
      { kind: "blockStart", index: 0, block: "text" },
      { kind: "blockDelta", index: 0, block: "text", delta: "Approved work" },
      { kind: "assistant", blocks: [{ block: "text", text: "Approved work" }], completeAsCommentary: true },
    ] as MainStreamFact[]) {
      await registry.submit("thread-1", { type: "mainStream", runtimeGeneration: 1, source, fact });
    }
    await expect(registry.submit("thread-1", {
      type: "lifecycle",
      runtimeGeneration: 1,
      fact: { type: "result", status: "completed", codexErrorInfo: null, origin: null },
      source,
    })).resolves.toBeUndefined();
    expect(store.getTurn("thread-1", prepared.turn.id)?.status).toBe("inProgress");
    await expect(registry.submit("thread-1", {
      type: "resolveInteraction",
      requestId: opened.requestId,
      response: { decision: "accept" },
    })).resolves.toBe(true);
    await expect(response).resolves.toEqual({ decision: "accept" });
    await expect(registry.submit("thread-1", {
      type: "resolveInteraction",
      requestId: opened.requestId,
      response: { decision: "decline" },
    })).resolves.toBe(false);
    expect(store.getPendingRequest(opened.requestId)).toMatchObject({
      status: "resolved",
      response: { decision: "accept" },
    });
    expect(store.getThreadRecord("thread-1")?.thread.status).toEqual({ type: "idle" });
    expect(store.getTurn("thread-1", prepared.turn.id)?.status).toBe("completed");
    expect(store.getTurn("thread-1", prepared.turn.id)?.items).toContainEqual(
      expect.objectContaining({ type: "agentMessage", text: "Approved work", phase: "final_answer" }),
    );
    expect(resolved).toEqual([
      "thread/status/changed",
      "item/started",
      "item/agentMessage/delta",
      "item/completed",
      "serverRequest/resolved",
      "thread/status/changed",
      "thread/status/changed",
      "turn/completed",
    ]);
    expect((metrics.snapshot().gauges as { pendingApprovals: number }).pendingApprovals).toBe(0);
    await registry.close();
  });

  it("delivers an interaction resolved between announce and runtime wait", async () => {
    const { registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "approve", text_elements: [] }] },
    });
    const opened = await registry.submit<{ requestId: string }>("thread-1", {
      type: "openInteraction",
      runtimeGeneration: 1,
      request: {
        threadId: "thread-1",
        turnId: prepared.turn.id,
        claudeRequestId: "fast-approval",
        method: "item/commandExecution/requestApproval",
        params: {},
      },
    });
    await registry.submit("thread-1", {
      type: "resolveInteraction",
      requestId: opened.requestId,
      response: { decision: "accept" },
    });
    await expect(registry.submit("thread-1", {
      type: "waitInteraction",
      runtimeGeneration: 1,
      requestId: opened.requestId,
    })).resolves.toEqual({ decision: "accept" });
    await registry.close();
  });

  it("rejects stale interaction open, announce, and wait after runtime replacement", async () => {
    const { store, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "approve", text_elements: [] }] },
    });
    await registry.submit("thread-1", { type: "runtimeDetached", runtimeGeneration: 1 });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 2 });
    const staleOpen = {
      type: "openInteraction",
      runtimeGeneration: 1,
      request: {
        threadId: "thread-1",
        turnId: prepared.turn.id,
        claudeRequestId: "stale-open",
        method: "item/commandExecution/requestApproval",
        params: {},
      },
    } as ClaudeSessionCommand;
    await expect(registry.submit("thread-1", staleOpen)).resolves.toMatchObject({
      requestId: "",
      pending: false,
      response: { cancelled: true },
    });
    expect(store.listPendingRequests("thread-1")).toEqual([]);

    const current = await registry.submit<{ requestId: string }>("thread-1", {
      type: "openInteraction",
      runtimeGeneration: 2,
      request: {
        threadId: "thread-1",
        turnId: prepared.turn.id,
        claudeRequestId: "current",
        method: "item/commandExecution/requestApproval",
        params: {},
      },
    } as ClaudeSessionCommand);
    await registry.submit("thread-1", { type: "runtimeDetached", runtimeGeneration: 2 });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 3 });
    await expect(registry.submit("thread-1", {
      type: "announceInteraction",
      runtimeGeneration: 2,
      requestId: current.requestId,
    } as ClaudeSessionCommand)).resolves.toBe(false);
    await expect(registry.submit("thread-1", {
      type: "waitInteraction",
      runtimeGeneration: 2,
      requestId: current.requestId,
    } as ClaudeSessionCommand)).resolves.toEqual({ cancelled: true });
    await registry.close();
  });

  it("correlates the exact input/command UUID and accepts idle when completed is omitted", async () => {
    const updates: SessionLifecycleUpdate[] = [];
    const { store, registry } = harness((update) => updates.push(update));
    const source: RuntimeFactSource = { providerEventId: "lifecycle", providerEventType: "test" };
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const first = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "one", text_elements: [] }] },
    });
    const fact = (value: Extract<ClaudeSessionCommand, { type: "lifecycle" }>["fact"]) =>
      registry.submit("thread-1", { type: "lifecycle", runtimeGeneration: 1, fact: value, source });
    await fact({ type: "expectedCommand", id: "input-command-1" });
    await fact({ type: "command", state: "queued", id: "input-command-1" });
    await fact({ type: "result", status: "completed", codexErrorInfo: null, origin: null });
    await fact({ type: "command", state: "completed", id: "wrong-command" });
    expect(store.getTurn("thread-1", first.turn.id)?.status).toBe("inProgress");
    await fact({ type: "command", state: "cancelled", id: "input-command-1" });
    expect(store.getTurn("thread-1", first.turn.id)?.status).toBe("completed");

    const second = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "two", text_elements: [] }] },
    });
    await fact({ type: "expectedCommand", id: "input-command-2" });
    await fact({ type: "command", state: "queued", id: "input-command-2" });
    await fact({ type: "result", status: "completed", codexErrorInfo: null, origin: null });
    await fact({ type: "taskNotification" });
    await fact({ type: "session", state: "idle" });
    expect(store.getTurn("thread-1", second.turn.id)?.status).toBe("completed");
    const third = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "three", text_elements: [] }] },
    });
    await fact({ type: "expectedCommand", id: "input-command-3" });
    await fact({ type: "command", state: "queued", id: "input-command-3" });
    await fact({ type: "result", status: "failed", errorMessage: "discarded", codexErrorInfo: "other", origin: null });
    await fact({ type: "command", state: "discarded", id: "input-command-3" });
    expect(store.getTurn("thread-1", third.turn.id)?.status).toBe("failed");
    expect(updates.filter((update) => update.completed)).toHaveLength(3);
    await registry.close();
  });

  it("fences Stop until ack, ignores late facts, and reopens only through exact turn admission", async () => {
    const updates: SessionLifecycleUpdate[] = [];
    const { store, registry } = harness((update) => updates.push(update));
    const source: RuntimeFactSource = { providerEventId: "stop", providerEventType: "test" };
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const command = (fact: Extract<ClaudeSessionCommand, { type: "lifecycle" }>["fact"]) =>
      registry.submit("thread-1", { type: "lifecycle", runtimeGeneration: 1, fact, source });
    const first = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "stop", text_elements: [] }] },
    });
    await command({ type: "expectedCommand", id: "old" });
    await command({ type: "interrupt" });
    expect(updates.at(-1)?.acceptProviderFacts).toBe(false);
    await command({ type: "result", status: "completed", codexErrorInfo: null, origin: null });
    await command({ type: "interruptAck" });
    expect(store.getTurn("thread-1", first.turn.id)?.status).toBe("interrupted");

    const second = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "again", text_elements: [] }] },
    });
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: { kind: "instantAgent", text: "late-old-output" },
    });
    expect(JSON.stringify(store.getTurn("thread-1", second.turn.id))).not.toContain("late-old-output");
    await command({ type: "expectedCommand", id: "new" });
    expect(updates.at(-1)?.acceptProviderFacts).toBe(false);
    await registry.submit("thread-1", {
      type: "prepareRuntimeInput",
      runtimeGeneration: 1,
      messageUuid: "new",
      kind: "turn",
      turnId: second.turn.id,
    });
    await registry.submit("thread-1", {
      type: "completeRuntimeInput",
      runtimeGeneration: 1,
      messageUuid: "new",
      sent: true,
    });
    expect(updates.at(-1)?.acceptProviderFacts).toBe(true);
    await command({ type: "command", state: "completed", id: "old" });
    await command({ type: "command", state: "queued", id: "new" });
    await command({ type: "result", status: "completed", codexErrorInfo: null, origin: null });
    await command({ type: "command", state: "completed", id: "new" });
    expect(store.getTurn("thread-1", second.turn.id)?.status).toBe("completed");
    await registry.close();
  });

  it("orders Stop and provider input admission in the session mailbox", async () => {
    const { store, registry } = harness();
    const source: RuntimeFactSource = { providerEventId: "race", providerEventType: "test" };
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const first = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "stop wins", text_elements: [] }] },
    });
    expect(await registry.submit("thread-1", {
      type: "fenceCurrentRuntimeStop", expectedTurnId: first.turn.id,
    })).toBe(true);
    expect(await registry.submit("thread-1", {
      type: "prepareRuntimeInput", runtimeGeneration: 1, messageUuid: "late",
      kind: "turn", turnId: first.turn.id,
    })).toBeUndefined();
    expect(await registry.submit("thread-1", {
      type: "steer", runtimeGeneration: 1, messageUuid: "late-steer",
      expectedTurnId: first.turn.id, input: [],
    })).toBeUndefined();
    await registry.submit("thread-1", {
      type: "lifecycle", runtimeGeneration: 1, fact: { type: "interrupt" }, source,
    });
    await registry.submit("thread-1", {
      type: "lifecycle", runtimeGeneration: 1, fact: { type: "interruptAck" }, source,
    });
    expect(store.getTurn("thread-1", first.turn.id)?.status).toBe("interrupted");

    const second = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "send wins", text_elements: [] }] },
    });
    expect(await registry.submit("thread-1", {
      type: "prepareRuntimeInput", runtimeGeneration: 1, messageUuid: "early",
      kind: "turn", turnId: second.turn.id,
    })).toMatchObject({ messageUuid: "early", turnId: second.turn.id });
    expect(await registry.submit("thread-1", {
      type: "completeRuntimeInput", runtimeGeneration: 1, messageUuid: "early", sent: true,
    })).toBe(true);
    expect(await registry.submit("thread-1", {
      type: "fenceCurrentRuntimeStop", expectedTurnId: second.turn.id,
    })).toBe(true);
    await registry.submit("thread-1", {
      type: "lifecycle", runtimeGeneration: 1, fact: { type: "interrupt" }, source,
    });
    await registry.submit("thread-1", {
      type: "lifecycle", runtimeGeneration: 1, fact: { type: "interruptAck" }, source,
    });
    expect(store.getTurn("thread-1", second.turn.id)?.status).toBe("interrupted");
    await registry.close();
  });

  it("keeps no-query and session-owned background drains terminal, but treats an unmatched empty result as real", async () => {
    const { store, registry } = harness();
    const source: RuntimeFactSource = { providerEventId: "drain", providerEventType: "test" };
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const command = (fact: Extract<ClaudeSessionCommand, { type: "lifecycle" }>["fact"]) =>
      registry.submit("thread-1", { type: "lifecycle", runtimeGeneration: 1, fact, source });
    const start = async (text: string) => registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text, text_elements: [] }] },
    });
    const noQuery = await start("prelude");
    await command({ type: "noQuery" });
    await command({ type: "result", status: "completed", codexErrorInfo: null, origin: null });
    expect(store.getTurn("thread-1", noQuery.turn.id)?.status).toBe("inProgress");
    await command({ type: "noQueryAck" });
    expect(store.getTurn("thread-1", noQuery.turn.id)?.status).toBe("completed");

    const drain = await start("drain");
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "toolStart", index: 0,
        block: { type: "tool_use", id: "background-bash", name: "Bash", input: { command: "sleep 1" } },
      },
    });
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "taskStart", taskId: "background-task", providerId: "background-bash",
        description: "sleep 1", outputFile: "/tmp/missing-background-output",
      },
    });
    await command({ type: "result", status: "completed", codexErrorInfo: null, origin: null });
    expect(store.getTurn("thread-1", drain.turn.id)?.status).toBe("inProgress");
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: { kind: "taskStop", taskIds: ["background-task"], reason: "done" },
    });
    expect(store.getTurn("thread-1", drain.turn.id)?.status).toBe("completed");

    const empty = await start("empty");
    await command({ type: "noQueryAck" });
    expect(store.getTurn("thread-1", empty.turn.id)?.status).toBe("completed");
    await registry.close();
  });

  it("stops a nested task whose child owner already completed without crashing the runtime", async () => {
    const { store, registry } = harness();
    const source: RuntimeFactSource = { providerEventId: "nested-stop", providerEventType: "test" };
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "nested stop", text_elements: [] }] },
    });
    const outer = await registry.submit<{ childThreadId: string }>("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "taskStart", taskId: "outer-task", providerId: "outer-tool",
        description: "outer child", subagentType: "general-purpose", taskType: "agent",
      },
    });
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, ownerThreadId: outer.childThreadId, source,
      fact: { kind: "taskStart", taskId: "nested-task", description: "nested background" },
    });
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "taskComplete", taskId: "outer-task", status: "completed", summary: "outer done",
      },
    });

    await registry.submit("thread-1", {
      type: "lifecycle", runtimeGeneration: 1, fact: { type: "interrupt" }, source,
    });
    await expect(registry.submit("thread-1", {
      type: "lifecycle", runtimeGeneration: 1, fact: { type: "interruptAck" }, source,
    })).resolves.toBeUndefined();
    expect(store.getTurn("thread-1", prepared.turn.id)?.status).toBe("interrupted");
    await registry.close();
  });

  it("rolls back a failed raw injection only while its staged provider tip is still current", async () => {
    const { store, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const stage = (messageUuid: string) => registry.submit("thread-1", {
      type: "stageInjection" as const,
      runtimeGeneration: 1,
      messageUuid,
      waitForAcknowledgement: false,
      replayablePrelude: false,
      items: [],
    });
    expect(await stage("first"))
      .toMatchObject({ previous: null, record: { lastClaudeMessageUuid: "first" } });
    expect(await registry.submit("thread-1", {
      type: "cancelInjection", runtimeGeneration: 1, messageUuid: "first", previous: null,
      reason: "failed", rollbackBoundary: true,
    })).toBe(true);
    expect(store.getThreadRecord("thread-1", false)?.lastClaudeMessageUuid).toBeNull();
    await stage("second");
    await stage("newer");
    expect(await registry.submit("thread-1", {
      type: "cancelInjection", runtimeGeneration: 1, messageUuid: "second", previous: null,
      reason: "failed", rollbackBoundary: true,
    })).toBe(true);
    expect(store.getThreadRecord("thread-1", false)?.lastClaudeMessageUuid).toBe("newer");
    await registry.close();
  });

  it("closes review mode with rendered output or fallback before every terminal event", async () => {
    const { store, registry } = harness();
    const source: RuntimeFactSource = { providerEventId: "review", providerEventType: "test" };
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const start = async () => registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn", review: "current changes",
      params: { threadId: "thread-1", input: [{ type: "text", text: "current changes", text_elements: [] }] },
    });
    const lifecycle = (fact: Extract<ClaudeSessionCommand, { type: "lifecycle" }>["fact"]) =>
      registry.submit("thread-1", { type: "lifecycle", runtimeGeneration: 1, fact, source });

    const completed = await start();
    expect(completed.turn).toMatchObject({
      items: [
        { type: "enteredReviewMode", review: "current changes" },
        { type: "userMessage", id: completed.turn.id },
      ],
    });
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: { kind: "assistant", blocks: [{ block: "text", text: "P1 finding" }], completeAsCommentary: false },
    });
    await lifecycle({ type: "result", status: "completed", codexErrorInfo: null, origin: null });
    expect(store.getTurn("thread-1", completed.turn.id)?.items.at(-1)).toMatchObject({
      type: "exitedReviewMode", review: "P1 finding",
    });

    const interrupted = await start();
    await lifecycle({ type: "interrupt" });
    await lifecycle({ type: "interruptAck" });
    expect(store.getTurn("thread-1", interrupted.turn.id)?.items.at(-1)).toMatchObject({
      type: "exitedReviewMode", review: "Reviewer failed to output a response.",
    });
    const events = store.listEventsAfter("thread-1", 0);
    for (const turnId of [completed.turn.id, interrupted.turn.id]) {
      const methods = events.filter((event) => event.turnId === turnId).map((event) => event.method);
      expect(methods.lastIndexOf("item/completed")).toBeLessThan(methods.indexOf("turn/completed"));
    }
    await registry.close();
  });

  it("runtime exit force-settles open blocks, tools, and child tasks exactly once", async () => {
    const { store, registry } = harness();
    const source: RuntimeFactSource = { providerEventId: "exit", providerEventType: "test" };
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "exit", text_elements: [] }] },
    });
    const stream = (fact: MainStreamFact) => registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source, fact,
    });
    await stream({ kind: "blockStart", index: 0, block: "text" });
    await stream({ kind: "toolPrepare", providerId: "tool", name: "Bash", input: { command: "sleep 10" } });
    await stream({ kind: "taskStart", taskId: "task", providerId: "tool", description: "sleeping" });
    await registry.submit("thread-1", {
      type: "lifecycle", runtimeGeneration: 1,
      fact: { type: "runtimeExit", message: "gone", codexErrorInfo: "other" }, source,
    });
    expect(store.getTurn("thread-1", prepared.turn.id)).toMatchObject({
      status: "failed", error: { message: "gone" },
    });
    expect(store.getTurn("thread-1", prepared.turn.id)?.items).toContainEqual(
      expect.objectContaining({ id: "tool", status: "failed" }),
    );
    expect(store.listEventsAfter("thread-1", 0).filter((event) => event.method === "turn/completed")).toHaveLength(1);
    await registry.close();
  });

  it("treats canonical assistant as the boundary when content_block_stop is omitted", async () => {
    const { store, registry } = harness();
    const source: RuntimeFactSource = { providerEventId: "assistant", providerEventType: "test" };
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "answer", text_elements: [] }] },
    });
    for (const fact of [
      { kind: "blockStart", index: 0, block: "text" },
      { kind: "blockDelta", index: 0, block: "text", delta: "done" },
      { kind: "assistant", blocks: [{ block: "text", text: "done" }], completeAsCommentary: false },
    ] as MainStreamFact[]) {
      await registry.submit("thread-1", { type: "mainStream", runtimeGeneration: 1, source, fact });
    }
    await registry.submit("thread-1", {
      type: "lifecycle", runtimeGeneration: 1,
      fact: { type: "result", status: "completed", codexErrorInfo: null, origin: null }, source,
    });
    expect(store.getTurn("thread-1", prepared.turn.id)?.status).toBe("completed");
    await registry.close();
  });

  it("replays root and child interactions once per App connection and resolves each once", async () => {
    const { store, hub, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const rootTurn = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "delegate", text_elements: [] }] },
    });
    const child = await registry.submit<{ childThreadId: string }>("thread-1", {
      type: "mainStream",
      runtimeGeneration: 1,
      source: { providerEventId: "child", providerEventType: "task_started" },
      fact: {
        kind: "taskStart",
        taskId: "child-task",
        description: "inspect",
        taskType: "agent",
        subagentType: "Explore",
      },
    });
    const childTurn = store.listTurns(child.childThreadId)[0]!;
    const rootRequest = await registry.submit<{ requestId: string }>("thread-1", {
      type: "openInteraction",
      runtimeGeneration: 1,
      request: {
        threadId: "thread-1",
        turnId: rootTurn.turn.id,
        claudeRequestId: "root-request",
        method: "item/commandExecution/requestApproval",
        params: { command: "root" },
      },
    });
    const childRequest = await registry.submit<{ requestId: string }>("thread-1", {
      type: "openInteraction",
      runtimeGeneration: 1,
      request: {
        threadId: child.childThreadId,
        turnId: childTurn.id,
        claudeRequestId: "child-request",
        method: "item/commandExecution/requestApproval",
        params: { command: "child" },
      },
    });
    const requests = new Map<string, string[]>();
    const resolved = new Map<string, string[]>();
    for (const connectionId of ["desktop", "mobile"]) {
      requests.set(connectionId, []);
      resolved.set(connectionId, []);
      hub.attach(
        connectionId,
        (method) => resolved.get(connectionId)!.push(method),
        (id) => requests.get(connectionId)!.push(id),
      );
      await registry.submit("thread-1", { type: "replayInteractions", connectionId });
    }
    expect(requests.get("desktop")).toEqual([rootRequest.requestId, childRequest.requestId]);
    expect(requests.get("mobile")).toEqual([rootRequest.requestId, childRequest.requestId]);
    for (const requestId of [rootRequest.requestId, childRequest.requestId]) {
      await expect(registry.submit("thread-1", {
        type: "resolveInteraction",
        requestId,
        response: { decision: "accept" },
      })).resolves.toBe(true);
      await expect(registry.submit("thread-1", {
        type: "resolveInteraction",
        requestId,
        response: { decision: "decline" },
      })).resolves.toBe(false);
    }
    expect(resolved.get("desktop")?.filter((method) => method === "serverRequest/resolved")).toHaveLength(2);
    expect(resolved.get("mobile")?.filter((method) => method === "serverRequest/resolved")).toHaveLength(2);
    await registry.close();
  });

  it("fences reverse rename completion and composes metadata with settings from current state", async () => {
    const { store, registry } = harness();
    const initial = { ...record("thread-1"), lastClaudeMessageUuid: "provider-boundary" };
    await registry.submit("thread-1", { type: "createThread", record: initial });
    const first = await registry.submit<{ operationId: string }>("thread-1", {
      type: "threadAdmin",
      command: { kind: "prepare", operation: "rename", name: "first" },
    });
    const second = await registry.submit<{ operationId: string }>("thread-1", {
      type: "threadAdmin",
      command: { kind: "prepare", operation: "rename", name: "second" },
    });
    const staleCandidate = { ...initial, reasoningEffort: "high" };
    await registry.submit("thread-1", {
      type: "threadAdmin",
      command: { kind: "metadata", gitInfo: { branch: "main", sha: "abc123" } },
    });
    await registry.submit("thread-1", {
      type: "updateDesiredSettings",
      expectedGeneration: 0,
      candidate: staleCandidate,
      threadSettings: { model: "claude:sonnet", effort: "high" } as ThreadSettings,
    });
    await expect(registry.submit("thread-1", {
      type: "threadAdmin",
      command: { kind: "finish", operationId: second.operationId },
    })).resolves.toBe(true);
    await expect(registry.submit("thread-1", {
      type: "threadAdmin",
      command: { kind: "finish", operationId: first.operationId },
    })).resolves.toBe(false);
    expect(store.getThreadRecord("thread-1")).toMatchObject({
      reasoningEffort: "high",
      thread: { name: "second", gitInfo: { branch: "main", sha: "abc123" } },
    });
    expect(store.listEventsAfter("thread-1", 0)
      .filter((event) => event.method === "thread/name/updated")).toHaveLength(1);
    await registry.close();
  });

  it("keeps rename failure non-durable", async () => {
    const { store, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    const prepared = await registry.submit<{ operationId: string }>("thread-1", {
      type: "threadAdmin",
      command: { kind: "prepare", operation: "rename", name: "failed" },
    });
    await expect(registry.submit("thread-1", {
      type: "threadAdmin",
      command: { kind: "abort", operationId: prepared.operationId },
    })).resolves.toBe(true);
    expect(store.getThreadRecord("thread-1")?.thread.name).toBeNull();
    expect(store.listEventsAfter("thread-1", 0)
      .filter((event) => event.method === "thread/name/updated")).toEqual([]);
    await registry.close();
  });

  it("fences an active goal before archive stop facts and wakes it once after unarchive", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const { store, registry } = harness((update) => lifecycle.push(update));
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    store.setGoal("thread-1", { objective: "continue after archive" });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "goal",
      command: { kind: "runtimeReady", runtimeGeneration: 1 },
    });
    const active = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "work", text_elements: [] }] },
    });
    const prepared = await registry.submit<{ operationId: string }>("thread-1", {
      type: "threadAdmin",
      command: { kind: "prepare", operation: "archive" },
    });
    await registry.submit("thread-1", {
      type: "goal",
      command: { kind: "detach", checkpoint: "archive" },
    });
    const effectCount = lifecycle.flatMap((update) => update.goalEffects ?? []).length;
    await registry.submit("thread-1", {
      type: "mainStream",
      runtimeGeneration: 1,
      source: { providerEventId: "late", providerEventType: "stream_event" },
      fact: { kind: "instantAgent", text: "must be dropped" },
    });
    await registry.submit("thread-1", {
      type: "lifecycle",
      runtimeGeneration: 1,
      source: { providerEventId: "exit", providerEventType: "runtime" },
      fact: { type: "runtimeExit", message: "archived", codexErrorInfo: null },
    });
    expect(lifecycle.flatMap((update) => update.goalEffects ?? [])).toHaveLength(effectCount);
    await registry.submit("thread-1", {
      type: "threadAdmin",
      command: { kind: "finish", operationId: prepared.operationId },
    });
    expect(store.isThreadArchived("thread-1")).toBe(true);
    expect(JSON.stringify(store.getTurn("thread-1", active.turn.id))).not.toContain("must be dropped");
    const beforeUnarchive = lifecycle.flatMap((update) => update.goalEffects ?? []).length;
    await registry.submit("thread-1", { type: "threadAdmin", command: { kind: "unarchive" } });
    const afterUnarchive = lifecycle.flatMap((update) => update.goalEffects ?? []).slice(beforeUnarchive);
    expect(afterUnarchive).toEqual([
      expect.objectContaining({ kind: "ensureRuntime" }),
    ]);
    await registry.submit("thread-1", { type: "threadAdmin", command: { kind: "unarchive" } });
    expect(lifecycle.flatMap((update) => update.goalEffects ?? []).slice(beforeUnarchive)).toHaveLength(1);
    await registry.close();
  });

  it("persists unarchive before publishing and drops late active/background/approval facts on delete", async () => {
    const { store, hub, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    store.setThreadArchived("thread-1", true);
    let archivedAtPublish: boolean | undefined;
    const resolved: string[] = [];
    hub.attach("observer", (method) => {
      resolved.push(method);
      if (method === "thread/unarchived") archivedAtPublish = store.isThreadArchived("thread-1");
    });
    await registry.submit("thread-1", { type: "threadAdmin", command: { kind: "unarchive" } });
    expect(archivedAtPublish).toBe(false);
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const active = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "run", text_elements: [] }] },
    });
    await registry.submit("thread-1", {
      type: "mainStream",
      runtimeGeneration: 1,
      source: { providerEventId: "task", providerEventType: "task_started" },
      fact: { kind: "taskStart", taskId: "background", description: "sleep" },
    });
    hub.subscribe("thread-1", "observer", (method) => resolved.push(method), () => undefined);
    const interaction = await registry.submit<{ requestId: string }>("thread-1", {
      type: "openInteraction",
      runtimeGeneration: 1,
      request: {
        threadId: "thread-1",
        turnId: active.turn.id,
        claudeRequestId: "approval",
        method: "item/commandExecution/requestApproval",
        params: { command: "curl" },
      },
    });
    await registry.submit("thread-1", {
      type: "announceInteraction",
      runtimeGeneration: 1,
      requestId: interaction.requestId,
    });
    const removal = await registry.submit<{ operationId: string }>("thread-1", {
      type: "threadAdmin",
      command: { kind: "beginRemoval", removalKind: "delete" },
    });
    expect(store.getPendingRequest(interaction.requestId)?.status).toBe("cancelled");
    await registry.submit("thread-1", {
      type: "mainStream",
      runtimeGeneration: 1,
      source: { providerEventId: "late-task", providerEventType: "task_notification" },
      fact: {
        kind: "taskComplete",
        taskId: "background",
        status: "completed",
        summary: "too late",
      },
    });
    await registry.submit("thread-1", {
      type: "lifecycle",
      runtimeGeneration: 1,
      source: { providerEventId: "late-result", providerEventType: "result" },
      fact: { type: "result", status: "completed", codexErrorInfo: null, origin: null },
    });
    await registry.submit("thread-1", {
      type: "lifecycle",
      runtimeGeneration: 1,
      source: { providerEventId: "exit", providerEventType: "runtime" },
      fact: { type: "runtimeExit", message: "deleted", codexErrorInfo: null },
    });
    const removedThreadIds = await registry.submit<string[]>("thread-1", {
      type: "threadAdmin",
      command: { kind: "providerSucceeded", operationId: removal.operationId },
    });
    expect(store.hasThread("thread-1")).toBe(false);
    expect(removedThreadIds).toEqual(["thread-1"]);
    expect(resolved.filter((method) => method === "serverRequest/resolved")).toHaveLength(1);
    expect(resolved.filter((method) => method === "thread/deleted")).toHaveLength(1);
    await registry.close();
  });

  it("keeps ambiguous provider failure quarantined and commits recovered deletion child to root", async () => {
    const { store, hub, registry } = harness();
    await registry.submit("root", { type: "createThread", record: record("root") });
    store.createThread({
      ...record("child"),
      thread: { ...record("child").thread, parentThreadId: "root" },
    });
    const deleted: string[] = [];
    for (const threadId of ["root", "child"]) {
      hub.subscribe(threadId, "observer", (method) => {
        if (method === "thread/deleted") deleted.push(threadId);
      });
    }

    const removal = await registry.submit<{ operationId: string }>("root", {
      type: "threadAdmin",
      command: { kind: "beginRemoval", removalKind: "delete" },
    });
    expect(store.listPendingThreadRemovals()).toEqual([expect.objectContaining({
      rootThreadId: "root",
      kind: "delete",
    })]);
    await registry.submit("root", {
      type: "threadAdmin",
      command: {
        kind: "providerFailed",
        operationId: removal.operationId,
        providerAttempted: true,
      },
    });
    expect(store.hasThread("root")).toBe(true);
    expect(store.listPendingThreadRemovals()).toHaveLength(1);
    expect(deleted).toEqual([]);

    const recovery = await registry.submit<{ operationId: string }>("root", {
      type: "threadAdmin",
      command: { kind: "recoverRemoval" },
    });
    await registry.submit("root", {
      type: "threadAdmin",
      command: { kind: "providerSucceeded", operationId: recovery.operationId },
    });
    expect(store.listPendingThreadRemovals()).toEqual([]);
    expect(store.hasThread("root")).toBe(false);
    expect(store.hasThread("child")).toBe(false);
    expect(deleted).toEqual(["child", "root"]);
    await registry.close();
  });

  it("cancels durable removal intent only when the provider was never attempted", async () => {
    const { store, registry } = harness();
    await registry.submit("root", { type: "createThread", record: record("root") });
    const removal = await registry.submit<{ operationId: string }>("root", {
      type: "threadAdmin",
      command: { kind: "beginRemoval", removalKind: "delete" },
    });
    await registry.submit("root", {
      type: "threadAdmin",
      command: {
        kind: "providerFailed",
        operationId: removal.operationId,
        providerAttempted: false,
      },
    });
    expect(store.listPendingThreadRemovals()).toEqual([]);
    await expect(registry.submit("root", {
      type: "goal",
      command: { kind: "get" },
    })).resolves.toBeUndefined();
    expect(store.hasThread("root")).toBe(true);
    await registry.close();
  });

  it("publishes an owned archive cascade only after every flag and durable event commits", async () => {
    const { store, hub, registry } = harness();
    await registry.submit("root", { type: "createThread", record: record("root") });
    store.createThread({
      ...record("child"),
      thread: { ...record("child").thread, parentThreadId: "root" },
    });
    const observations: Array<{ method: string; threadId: string; archived: boolean; durable: boolean }> = [];
    hub.attach("observer", (method, params) => {
      if (method !== "thread/archived" && method !== "thread/unarchived") return;
      const threadId = (params as { threadId: string }).threadId;
      observations.push({
        method,
        threadId,
        archived: store.isThreadArchived(threadId),
        durable: store.listEventsAfter(threadId, 0).some((event) => event.method === method),
      });
    });

    const prepared = await registry.submit<{ operationId: string }>("root", {
      type: "threadAdmin",
      command: { kind: "prepare", operation: "archive" },
    });
    await registry.submit("root", {
      type: "threadAdmin",
      command: { kind: "finish", operationId: prepared.operationId },
    });
    await registry.submit("root", { type: "threadAdmin", command: { kind: "unarchive" } });

    expect(observations).toEqual([
      { method: "thread/archived", threadId: "root", archived: true, durable: true },
      { method: "thread/archived", threadId: "child", archived: true, durable: true },
      { method: "thread/unarchived", threadId: "root", archived: false, durable: true },
      { method: "thread/unarchived", threadId: "child", archived: false, durable: true },
    ]);
    await registry.close();
  });

  it("cannot revive an ephemeral thread from late effect or runtime completion", async () => {
    const { store, registry } = harness();
    const ephemeral = record("side");
    ephemeral.thread.ephemeral = true;
    await registry.submit("side", { type: "createThread", record: ephemeral });
    await registry.submit("side", { type: "attachRuntime", runtimeGeneration: 7 });
    const removal = await registry.submit<{ operationId: string }>("side", {
      type: "threadAdmin",
      command: { kind: "beginRemoval", removalKind: "release" },
    });
    await registry.submit("side", {
      type: "threadAdmin",
      command: { kind: "providerSucceeded", operationId: removal.operationId },
    });
    for (const command of [
      {
        type: "runtimeInitialized",
        runtimeGeneration: 7,
        providerSessionId: ephemeral.claudeSessionId,
        model: "sonnet",
        cliVersion: "late",
      },
      {
        type: "mainStream",
        runtimeGeneration: 7,
        source: { providerEventId: "late", providerEventType: "stream_event" },
        fact: { kind: "instantAgent", text: "revive" },
      },
      {
        type: "lifecycle",
        runtimeGeneration: 7,
        source: { providerEventId: "late-exit", providerEventType: "runtime" },
        fact: { type: "runtimeExit", message: "late", codexErrorInfo: null },
      },
    ] as ClaudeSessionCommand[]) {
      await registry.submit("side", command);
    }
    await expect(registry.submit("side", {
      type: "threadAdmin",
      command: { kind: "providerSucceeded", operationId: removal.operationId },
    })).resolves.toBe(false);
    expect(store.hasThread("side")).toBe(false);
    expect(store.listThreads({ limit: 10 })).toEqual([]);
    await registry.close();
  });

  it("owns runtime readiness, failure, and exit status behind the generation fence", async () => {
    const { store, registry } = harness();
    const initial = record("thread-1");
    initial.thread.status = { type: "notLoaded" };
    await registry.submit("thread-1", { type: "createThread", record: initial });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 2 });
    await expect(registry.submit("thread-1", {
      type: "runtimeReady", runtimeGeneration: 1,
    })).resolves.toBe(false);
    expect(store.getThreadRecord("thread-1")?.thread.status.type).toBe("notLoaded");
    await expect(registry.submit("thread-1", {
      type: "runtimeReady", runtimeGeneration: 2,
    })).resolves.toBe(true);
    expect(store.getThreadRecord("thread-1")?.thread.status.type).toBe("idle");
    await expect(registry.submit("thread-1", {
      type: "runtimeExited", runtimeGeneration: 1, message: "stale", codexErrorInfo: null,
    })).resolves.toBe(false);
    expect(store.getThreadRecord("thread-1")?.thread.status.type).toBe("idle");
    await expect(registry.submit("thread-1", {
      type: "runtimeFailed", runtimeGeneration: 2, message: "auth failed", codexErrorInfo: "badRequest",
    })).resolves.toBe(true);
    expect(store.getThreadRecord("thread-1")?.thread.status.type).toBe("systemError");
    await registry.close();
  });

  it("owns provider journal admission, deduplication, and terminal disposition", async () => {
    const { store, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 3 });
    const admitted = await registry.submit<ProviderEventAdmission>("thread-1", {
      type: "providerEventStarted", runtimeGeneration: 3, processEpoch: "process",
      providerSequence: 1, providerEventType: "assistant", providerEventId: "provider-1",
      payload: { type: "assistant" },
    });
    expect(admitted).toMatchObject({ project: true, finish: true, sequence: expect.any(Number) });
    await registry.submit("thread-1", {
      type: "providerEventFinished", runtimeGeneration: 3, sequence: admitted.sequence,
      source: admitted.source, disposition: "projected",
    });
    const duplicate = await registry.submit<ProviderEventAdmission>("thread-1", {
      type: "providerEventStarted", runtimeGeneration: 3, processEpoch: "replacement",
      providerSequence: 99, providerEventType: "assistant", providerEventId: "provider-1",
      payload: { type: "assistant", replay: true },
    });
    expect(duplicate).toMatchObject({ sequence: admitted.sequence, project: false, finish: false });
    const stale = await registry.submit<ProviderEventAdmission>("thread-1", {
      type: "providerEventStarted", runtimeGeneration: 2, processEpoch: "stale",
      providerSequence: 1, providerEventType: "assistant", providerEventId: "stale",
      payload: {},
    });
    expect(stale).toMatchObject({ sequence: 0, project: false, finish: false });
    expect(store.listProviderEvents("thread-1")).toEqual([
      expect.objectContaining({ providerEventId: "provider-1", disposition: "projected" }),
    ]);
    expect(store.hasProcessedProviderEvent("thread-1", "provider-1")).toBe(true);
    await registry.close();
  });

  it("retracts the current root tip to its previous boundary with projection and child cleanup", async () => {
    const { store, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    store.createTurn("thread-1", {
      id: "prior-turn", items: [], itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    });
    store.setTurnClaudeMessageUuid("thread-1", "prior-turn", "prior-message");
    store.updateThread({
      ...store.getThreadRecord("thread-1", false)!,
      lastClaudeMessageUuid: "prior-message",
      lastCompletedTurnId: "prior-turn",
    });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "work", text_elements: [] }] },
    });
    const source = { providerEventId: "message-1", providerEventType: "assistant" };
    const projection = await registry.submit<MainStreamProjection>("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: { kind: "instantAgent", text: "replace me" },
    });
    const projectedItemIds = projection.itemIds.filter((id): id is string => Boolean(id));
    expect(projectedItemIds).toHaveLength(1);
    const active = store.getTurn("thread-1", prepared.turn.id)!;
    active.items.push({
      type: "collabAgentToolCall", id: "retracted-spawn", tool: "spawnAgent", status: "completed",
      senderThreadId: "thread-1", receiverThreadIds: ["retracted-child"], prompt: "temporary child",
      model: null, reasoningEffort: null,
      agentsStates: { "retracted-child": { status: "completed", message: "temporary" } },
    });
    store.updateTurn("thread-1", active);
    const child = record("retracted-child");
    child.thread.parentThreadId = "thread-1";
    store.createThread(child);
    store.createTurn("retracted-child", {
      id: "retracted-child-turn", items: [], itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    });
    const itemIds = [...projectedItemIds, "retracted-spawn"];
    await registry.submit("thread-1", {
      type: "providerBoundary", runtimeGeneration: 1,
      providerMessageId: "message-1", itemIds,
    });
    expect(store.getTurnClaudeMessageUuid("thread-1", prepared.turn.id)).toBe("message-1");
    expect(store.getThreadRecord("thread-1")?.lastClaudeMessageUuid).toBe("message-1");
    expect(store.listProviderItemCorrelations("thread-1", ["message-1"])).toHaveLength(2);
    await registry.submit("thread-1", {
      type: "providerRetract", runtimeGeneration: 1,
      providerMessageIds: ["message-1"], source,
    });
    expect(store.getTurn("thread-1", prepared.turn.id)?.items
      .some((item) => itemIds.includes(item.id))).toBe(false);
    expect(store.getTurnClaudeMessageUuid("thread-1", prepared.turn.id)).toBeUndefined();
    expect(store.getTurnClaudeMessageUuid("thread-1", "prior-turn")).toBe("prior-message");
    expect(store.getThreadRecord("thread-1")?.lastClaudeMessageUuid).toBe("prior-message");
    expect(store.getThreadRecord("retracted-child", true)).toBeUndefined();
    expect(store.listProviderItemCorrelations("thread-1", ["message-1"])).toEqual([]);
    await registry.close();
  });

  it("preserves an unrepresented root tip when retracting only a child boundary", async () => {
    const { store, registry } = harness();
    const root = { ...record("thread-1"), lastClaudeMessageUuid: "unrepresented-user-tip" };
    await registry.submit("thread-1", { type: "createThread", record: root });
    store.createTurn("thread-1", {
      id: "root-turn", items: [], itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    });
    store.setTurnClaudeMessageUuid("thread-1", "root-turn", "root-boundary");
    const child = record("child");
    child.thread.parentThreadId = "thread-1";
    store.createThread(child);
    store.createTurn("child", {
      id: "child-turn",
      items: [{ type: "agentMessage", id: "child-item", text: "temporary", phase: null, memoryCitation: null }],
      itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    });
    store.setTurnClaudeMessageUuid("child", "child-turn", "child-boundary");
    store.linkProviderItems("thread-1", "child-boundary", "child", "child-turn", ["child-item"]);
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });

    await registry.submit("thread-1", {
      type: "providerRetract", runtimeGeneration: 1,
      providerMessageIds: ["child-boundary"],
      source: { providerEventId: "retract-child", providerEventType: "assistant" },
    });

    expect(store.getThreadRecord("thread-1")?.lastClaudeMessageUuid).toBe("unrepresented-user-tip");
    expect(store.getTurnClaudeMessageUuid("child", "child-turn")).toBeUndefined();
    expect(store.getTurn("child", "child-turn")?.items).toEqual([]);
    await registry.close();
  });

  it("preserves an unrepresented current tip when retracting an older root boundary", async () => {
    const { store, registry } = harness();
    const root = { ...record("thread-1"), lastClaudeMessageUuid: "unrepresented-current-tip" };
    await registry.submit("thread-1", { type: "createThread", record: root });
    store.createTurn("thread-1", {
      id: "older-turn",
      items: [{ type: "agentMessage", id: "older-item", text: "old", phase: null, memoryCitation: null }],
      itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    });
    store.setTurnClaudeMessageUuid("thread-1", "older-turn", "older-boundary");
    store.linkProviderItems("thread-1", "older-boundary", "thread-1", "older-turn", ["older-item"]);
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });

    await registry.submit("thread-1", {
      type: "providerRetract", runtimeGeneration: 1,
      providerMessageIds: ["older-boundary"],
      source: { providerEventId: "retract-old", providerEventType: "assistant" },
    });

    expect(store.getThreadRecord("thread-1")?.lastClaudeMessageUuid).toBe("unrepresented-current-tip");
    expect(store.getTurnClaudeMessageUuid("thread-1", "older-turn")).toBeUndefined();
    expect(store.getTurn("thread-1", "older-turn")?.items).toEqual([]);
    await registry.close();
  });

  it("owns conversation reset, model fallback, notices, and runtime notifications", async () => {
    const { store, registry } = harness();
    const initial = record("thread-1");
    initial.thread.name = "old title";
    await registry.submit("thread-1", { type: "createThread", record: initial });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "work", text_elements: [] }] },
    });
    const source = { providerEventId: "system-1", providerEventType: "system" };
    await registry.submit("thread-1", {
      type: "conversationReset", runtimeGeneration: 1,
      providerSessionId: "replacement-session", source,
    });
    await registry.submit("thread-1", {
      type: "modelFallback", runtimeGeneration: 1,
      model: "haiku", fromModel: "sonnet", source,
    });
    await registry.submit("thread-1", {
      type: "systemNotice", runtimeGeneration: 1,
      text: "retrying", noticeKind: "info", source,
    });
    await registry.submit("thread-1", {
      type: "runtimeNotification", runtimeGeneration: 1,
      method: "hook/started", params: { run: { id: "hook-1" } }, source,
    });
    expect(store.getThreadRecord("thread-1")).toMatchObject({
      claudeSessionId: "replacement-session",
      lastClaudeMessageUuid: null,
      resolvedModel: "haiku",
      thread: { name: null },
    });
    expect(JSON.stringify(store.getTurn("thread-1", prepared.turn.id))).toContain("retrying");
    const methods = store.listEventsAfter("thread-1", 0).map((event) => event.method);
    expect(methods).toEqual(expect.arrayContaining([
      "thread/name/updated", "model/rerouted", "hook/started",
    ]));
    await registry.close();
  });

  it("owns steer persistence and validates the active turn in one command", async () => {
    const { store, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    const prepared = await registry.submit<{ turn: Turn }>("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "first", text_elements: [] }] },
    });
    await expect(registry.submit("thread-1", {
      type: "steer", runtimeGeneration: 1, messageUuid: "steer-1", expectedTurnId: prepared.turn.id,
      clientUserMessageId: "client-steer",
      input: [{ type: "text", text: "second", text_elements: [] }],
    })).resolves.toMatchObject({ messageUuid: "steer-1", turnId: prepared.turn.id });
    await registry.submit("thread-1", {
      type: "completeRuntimeInput", runtimeGeneration: 1, messageUuid: "steer-1", sent: true,
    });
    expect(store.getTurn("thread-1", prepared.turn.id)?.items
      .filter((item) => item.type === "userMessage")).toEqual([
      expect.objectContaining({ content: [expect.objectContaining({ text: "first" })] }),
      expect.objectContaining({ clientId: "client-steer", content: [expect.objectContaining({ text: "second" })] }),
    ]);
    await expect(registry.submit("thread-1", {
      type: "steer", runtimeGeneration: 1, messageUuid: "steer-2", expectedTurnId: "wrong",
      input: [{ type: "text", text: "must fail", text_elements: [] }],
    })).rejects.toThrow("does not match");
    await registry.close();
  });

  it("keeps task, child, and tool ownership solely in the session inspection", async () => {
    const { registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "spawn", text_elements: [] }] },
    });
    const source = { providerEventId: "task-1", providerEventType: "task_started" };
    const spawned = await registry.submit<MainStreamProjection>("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "taskStart", taskId: "root-task", providerId: "spawn-tool",
        description: "child", subagentType: "general-purpose",
      },
    });
    expect(spawned.childThreadId).toEqual(expect.any(String));
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, ownerThreadId: spawned.childThreadId!,
      source,
      fact: { kind: "taskStart", taskId: "nested-task", description: "sleep" },
    });
    await expect(registry.submit<RuntimeInspection>("thread-1", {
      type: "inspectRuntime", runtimeGeneration: 1, providerId: "spawn-tool",
    })).resolves.toMatchObject({
      ownerThreadId: "thread-1",
      childThreadId: spawned.childThreadId,
    });
    await expect(registry.submit<RuntimeInspection>("thread-1", {
      type: "inspectRuntime", runtimeGeneration: 1, providerId: "nested-task",
    })).resolves.toMatchObject({
      ownerThreadId: spawned.childThreadId,
      taskId: null,
    });
    const all = await registry.submit<RuntimeInspection>("thread-1", {
      type: "inspectRuntime", runtimeGeneration: 1,
    });
    expect([...all.taskIds].sort()).toEqual(["nested-task", "root-task"]);
    await registry.close();
  });

  it("drops every stale runtime-owned mutation after replacement", async () => {
    const { store, registry } = harness();
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 2 });
    const source = { providerEventId: "stale", providerEventType: "system" };
    const commands: ClaudeSessionCommand[] = [
      {
        type: "providerBoundary", runtimeGeneration: 1,
        providerMessageId: "stale-boundary", itemIds: [],
      },
      {
        type: "conversationReset", runtimeGeneration: 1,
        providerSessionId: "stale-session", source,
      },
      {
        type: "modelFallback", runtimeGeneration: 1,
        model: "stale-model", fromModel: "sonnet", source,
      },
      {
        type: "systemNotice", runtimeGeneration: 1,
        text: "stale notice", noticeKind: "error", source,
      },
      {
        type: "runtimeNotification", runtimeGeneration: 1,
        method: "stale/event", params: {}, source,
      },
      {
        type: "runtimeExited", runtimeGeneration: 1,
        message: "stale exit", codexErrorInfo: null,
      },
    ];
    for (const command of commands) await registry.submit("thread-1", command);
    expect(store.getThreadRecord("thread-1")).toMatchObject({
      claudeSessionId: "claude-thread-1",
      resolvedModel: null,
      lastClaudeMessageUuid: null,
      thread: { status: { type: "idle" } },
    });
    expect(JSON.stringify(store.listEventsAfter("thread-1", 0))).not.toContain("stale");
    await registry.close();
  });
});
