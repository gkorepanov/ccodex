import { describe, expect, it } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import type { ClaudeThreadRecord } from "../../src/store/HybridStore.js";
import { LayeredHybridStore, MemoryHybridStore } from "../../src/store/memoryStore.js";

function record(): ClaudeThreadRecord {
  const thread: Thread = {
    id: "thread-1",
    extra: null,
    sessionId: "session-1",
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
    claudeSessionId: "claude-session-1",
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

describe("MemoryHybridStore thread-state commits", () => {
  it("keeps an ephemeral root deletion atomic inside the process-local layer", () => {
    const durable = new MemoryHybridStore();
    const store = new LayeredHybridStore(durable);
    const durableRecord = record();
    durable.createThread(durableRecord);
    const ephemeralRoot = {
      ...durableRecord,
      claudeSessionId: "ephemeral-provider",
      thread: { ...durableRecord.thread, id: "ephemeral-root", ephemeral: true },
    };
    const ephemeralChild = {
      ...ephemeralRoot,
      thread: { ...ephemeralRoot.thread, id: "ephemeral-child", parentThreadId: "ephemeral-root" },
    };
    store.createThread(ephemeralRoot);
    store.createThread(ephemeralChild);

    store.beginThreadRemoval({
      rootThreadId: "ephemeral-root",
      claudeSessionId: "ephemeral-provider",
      cwd: "/tmp",
      kind: "release",
    });
    store.commitThreadRemoval("ephemeral-root", ["ephemeral-root", "ephemeral-child"]);

    expect(store.hasThread("ephemeral-root")).toBe(false);
    expect(store.hasThread("ephemeral-child")).toBe(false);
    expect(store.listPendingThreadRemovals()).toEqual([]);
    expect(durable.hasThread(durableRecord.thread.id)).toBe(true);
  });

  it("commits a turn, thread state, and ordered events as one product mutation", () => {
    const store = new MemoryHybridStore();
    const original = record();
    store.createThread(original);
    const turn: Turn = {
      id: "turn-1", items: [], itemsView: "full", status: "inProgress",
      error: null, startedAt: 2, completedAt: null, durationMs: null,
    };
    const active: ClaudeThreadRecord = {
      ...original,
      thread: { ...original.thread, status: { type: "active", activeFlags: [] }, updatedAt: 2 },
    };
    expect(store.commitThreadState({
      record: active,
      turn,
      insertTurn: true,
      events: [
        { turnId: turn.id, method: "thread/status/changed", params: { status: active.thread.status } },
        { turnId: turn.id, method: "turn/started", params: { turn } },
      ],
    })).toHaveLength(2);

    expect(store.getThreadRecord(original.thread.id)?.thread.status).toEqual({
      type: "active", activeFlags: [],
    });
    expect(store.getTurn(original.thread.id, turn.id)).toEqual(turn);
    expect(store.listEventsAfter(original.thread.id, 0).map((event) => event.method))
      .toEqual(["thread/status/changed", "turn/started"]);
  });
});
