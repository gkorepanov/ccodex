import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import type { ClaudeThreadRecord } from "../../src/store/HybridStore.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";

const directories: string[] = [];

function createStore(): SqliteHybridStore {
  const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-store-"));
  directories.push(directory);
  return new SqliteHybridStore(join(directory, "state.sqlite"));
}

function thread(id: string): Thread {
  return {
    id,
    extra: null,
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "hello",
    ephemeral: false,
    historyMode: "legacy",
    modelProvider: "claude",
    createdAt: 10,
    updatedAt: 10,
    recencyAt: 10,
    status: { type: "idle" },
    path: null,
    cwd: "/tmp/project",
    cliVersion: "2.1.207",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function record(id = "thread-1") {
  return {
    thread: thread(id),
    claudeSessionId: "claude-session-1",
    modelPickerId: "claude:sonnet",
    claudeModelValue: "sonnet",
    serviceTier: null,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "workspaceWrite" },
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
    tokenUsageTotal: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    tokenUsageLast: null,
    modelContextWindow: null,
  } as const;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SqliteHybridStore", () => {
  it("persists provider-reported cumulative cost with runtime usage state", () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-store-cost-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const store = new SqliteHybridStore(path);
    store.createThread({ ...record(), providerCostUsdTotal: 1.84 });
    store.close();

    const reopened = new SqliteHybridStore(path);
    expect(reopened.getThreadRecord("thread-1")?.providerCostUsdTotal).toBe(1.84);
    reopened.close();
  });

  it("loads legacy runtime settings without a persisted resident usage snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-store-legacy-usage-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const store = new SqliteHybridStore(path);
    store.createThread(record());
    store.close();

    const database = new DatabaseSync(path);
    const row = database.prepare("SELECT runtime_settings_json FROM threads WHERE id = ?").get("thread-1") as { runtime_settings_json: string };
    const runtime = JSON.parse(row.runtime_settings_json) as Record<string, unknown>;
    delete runtime.tokenUsageLast;
    delete runtime.modelContextWindow;
    database.prepare("UPDATE threads SET runtime_settings_json = ? WHERE id = ?").run(JSON.stringify(runtime), "thread-1");
    database.close();

    const reopened = new SqliteHybridStore(path);
    expect(reopened.getThreadRecord("thread-1")).toMatchObject({ tokenUsageLast: null, modelContextWindow: null });
    reopened.close();
  });

  it("persists thread metadata and durable turns", () => {
    const store = createStore();
    const stored = record();
    store.createThread(stored);

    const turn: Turn = {
      id: "turn-1",
      items: [],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: 11,
      completedAt: null,
      durationMs: null,
    };
    store.createTurn(stored.thread.id, turn);
    store.updateTurn(stored.thread.id, { ...turn, status: "completed", completedAt: 12, durationMs: 1000 });

    expect(store.hasThread(stored.thread.id)).toBe(true);
    expect(store.getThreadRecord(stored.thread.id, true)).toMatchObject({
      claudeSessionId: "claude-session-1",
      thread: { id: "thread-1", turns: [{ id: "turn-1", status: "completed" }] },
    });
    store.close();
  });

  it("preserves a newer desired-settings generation across stale runtime writes", () => {
    const store = createStore();
    const original = record();
    store.createThread(original);
    store.updateThread({
      ...original,
      modelPickerId: "claude:opus",
      claudeModelValue: "opus",
      serviceTier: "fast",
      reasoningEffort: "high",
      settingsGeneration: 2,
    });
    store.updateThread({
      ...original,
      claudeSessionId: "runtime-session-after-turn",
      lastClaudeMessageUuid: "runtime-boundary",
      lastCompletedTurnId: "runtime-turn",
      thread: { ...original.thread, status: { type: "idle" }, updatedAt: 20 },
      reasoningEffort: "medium",
      settingsGeneration: 1,
    });

    expect(store.getThreadRecord(original.thread.id, false)).toMatchObject({
      claudeSessionId: "runtime-session-after-turn",
      lastClaudeMessageUuid: "runtime-boundary",
      lastCompletedTurnId: "runtime-turn",
      modelPickerId: "claude:opus",
      claudeModelValue: "opus",
      serviceTier: "fast",
      reasoningEffort: "high",
      settingsGeneration: 2,
    });
    store.close();
  });

  it("preserves archive state across runtime record updates", () => {
    const store = createStore();
    const original = record();
    store.createThread(original);
    store.setThreadArchived(original.thread.id, true);
    store.updateThread({
      ...original,
      thread: { ...original.thread, status: { type: "idle" }, updatedAt: 20 },
    });

    expect(store.isThreadArchived(original.thread.id)).toBe(true);
    expect(store.listThreads({ archived: true })).toEqual([
      expect.objectContaining({ id: original.thread.id }),
    ]);
    store.close();
  });

  it("stores preserved fork turn and item ids under their owning thread", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-store-fork-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const store = new SqliteHybridStore(path);
    store.createThread(record("source"));
    store.createThread(record("fork"));
    const sharedTurn: Turn = {
      id: "shared-turn",
      items: [{ type: "agentMessage", id: "shared-item", text: "hello", phase: null, memoryCitation: null }],
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: 11,
      completedAt: 12,
      durationMs: 1000,
    };
    store.createTurn("source", sharedTurn);
    store.createTurn("fork", structuredClone(sharedTurn));
    store.setTurnClaudeMessageUuid("source", sharedTurn.id, "source-message");
    store.setTurnClaudeMessageUuid("fork", sharedTurn.id, "fork-message");

    expect(store.getTurn("source", sharedTurn.id)?.items[0]?.id).toBe("shared-item");
    expect(store.getTurn("fork", sharedTurn.id)?.items[0]?.id).toBe("shared-item");
    expect(store.getTurnClaudeMessageUuid("source", sharedTurn.id)).toBe("source-message");
    expect(store.getTurnClaudeMessageUuid("fork", sharedTurn.id)).toBe("fork-message");
    store.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const turnPk = database.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string; pk: number }>;
    const itemPk = database.prepare("PRAGMA table_info(items)").all() as Array<{ name: string; pk: number }>;
    expect(turnPk.filter((column) => column.pk > 0).map((column) => column.name)).toEqual(["id", "thread_id"]);
    expect(itemPk.filter((column) => column.pk > 0).map((column) => column.name)).toEqual(["id", "thread_id"]);
    database.close();
  });

  it("rolls back an entire fork creation when a later turn insert fails", () => {
    const store = createStore();
    store.createThread(record("source"));
    const forkRecord = record("fork");
    const copied: Turn = {
      id: "duplicate-turn", items: [], itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    };

    expect(() => store.commitForkedThread(forkRecord, [copied, copied], [])).toThrow();
    expect(store.getThreadRecord("fork", true)).toBeUndefined();
    expect(store.getThreadRecord("source", true)).toBeDefined();
    store.close();
  });

  it("atomically commits a durable fork with stable turn/item ids and remapped provider boundaries", () => {
    const store = createStore();
    store.createThread(record("source"));
    const shared: Turn = {
      id: "shared-turn", items: [{
        type: "agentMessage", id: "shared-item", text: "shared history", phase: null, memoryCitation: null,
      }],
      itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    };
    store.createTurn("source", shared);
    store.setTurnClaudeMessageUuid("source", shared.id, "source-boundary");

    store.commitForkedThread(record("fork"), [structuredClone(shared)], [{
      turnId: shared.id, messageUuid: "fork-boundary",
    }]);

    expect(store.getTurn("source", shared.id)?.items[0]?.id).toBe("shared-item");
    expect(store.getTurn("fork", shared.id)?.items[0]?.id).toBe("shared-item");
    expect(store.getTurnClaudeMessageUuid("source", shared.id)).toBe("source-boundary");
    expect(store.getTurnClaudeMessageUuid("fork", shared.id)).toBe("fork-boundary");
    store.close();
  });

  it("restores truncated turns and provider UUIDs when rollback metadata persistence fails", () => {
    const store = createStore();
    const original = record("source");
    store.createThread(original);
    const turns = ["turn-1", "turn-2", "turn-3"].map((id): Turn => ({
      id, items: [], itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    }));
    for (const candidate of turns) {
      store.createTurn("source", candidate);
      store.setTurnClaudeMessageUuid("source", candidate.id, `old-${candidate.id}`);
    }
    const removedChild = record("removed-child");
    removedChild.thread.parentThreadId = "source";
    store.createThread(removedChild);
    store.createTurn("removed-child", {
      id: "child-turn", items: [], itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const invalid = {
      ...original,
      claudeSessionId: "replacement-session",
      thread: { ...original.thread, extra: circular },
    } as unknown as ClaudeThreadRecord;

    expect(() => store.commitThreadRollback(
      invalid,
      1,
      [{ turnId: "turn-1", messageUuid: "new-turn-1" }],
      ["removed-child"],
    )).toThrow();
    expect(store.getThreadRecord("source")?.claudeSessionId).toBe(original.claudeSessionId);
    expect(store.listTurns("source").map((candidate) => candidate.id)).toEqual(turns.map((candidate) => candidate.id));
    expect(turns.map((candidate) => store.getTurnClaudeMessageUuid("source", candidate.id)))
      .toEqual(turns.map((candidate) => `old-${candidate.id}`));
    expect(store.getThreadRecord("removed-child", true)?.thread.turns.map((turn) => turn.id))
      .toEqual(["child-turn"]);
    store.close();
  });

  it("atomically retracts persisted projection, boundary correlation, and thread tip after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-store-retract-restart-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const first = new SqliteHybridStore(path);
    const root = record("source");
    first.createThread(root);
    const one: Turn = {
      id: "turn-1",
      items: [{ type: "agentMessage", id: "item-1", text: "keep", phase: null, memoryCitation: null }],
      itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    };
    const two: Turn = {
      ...one,
      id: "turn-2",
      items: [{ type: "agentMessage", id: "item-2", text: "retract", phase: null, memoryCitation: null }],
    };
    first.createTurn("source", one);
    first.createTurn("source", two);
    first.setTurnClaudeMessageUuid("source", "turn-1", "message-1");
    first.setTurnClaudeMessageUuid("source", "turn-2", "message-2");
    first.linkProviderItems("source", "message-2", "source", "turn-2", ["item-2"]);
    first.updateThread({
      ...root, lastClaudeMessageUuid: "message-2", lastCompletedTurnId: "turn-2",
    });
    const projectedChild = record("projected-child");
    projectedChild.thread.parentThreadId = "source";
    first.createThread(projectedChild);
    first.createTurn("projected-child", {
      id: "projected-child-turn", items: [], itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    });
    first.close();

    const restarted = new SqliteHybridStore(path);
    const mutation = { ...restarted.getTurn("source", "turn-2")!, items: [] };
    const updated = {
      ...restarted.getThreadRecord("source", false)!,
      lastClaudeMessageUuid: "message-1",
    };
    const injector = new DatabaseSync(path);
    injector.exec(`
      CREATE TRIGGER fail_provider_retraction
      BEFORE DELETE ON provider_item_correlations
      BEGIN SELECT RAISE(ABORT, 'injected provider retraction failure'); END;
    `);
    injector.close();

    expect(() => restarted.commitProviderRetraction(updated, ["message-2"], [{
      ownerThreadId: "source", turn: mutation, clearBoundary: true,
    }], ["projected-child"])).toThrow("injected provider retraction failure");
    expect(restarted.getTurn("source", "turn-2")?.items.map((item) => item.id)).toEqual(["item-2"]);
    expect(restarted.getTurnClaudeMessageUuid("source", "turn-2")).toBe("message-2");
    expect(restarted.getThreadRecord("source")?.lastClaudeMessageUuid).toBe("message-2");
    expect(restarted.listProviderItemCorrelations("source", ["message-2"])).toHaveLength(1);
    expect(restarted.getThreadRecord("projected-child", true)?.thread.turns).toHaveLength(1);

    const repair = new DatabaseSync(path);
    repair.exec("DROP TRIGGER fail_provider_retraction");
    repair.close();
    restarted.commitProviderRetraction(updated, ["message-2"], [{
      ownerThreadId: "source", turn: mutation, clearBoundary: true,
    }], ["projected-child"]);
    expect(restarted.getTurn("source", "turn-2")?.items).toEqual([]);
    expect(restarted.getTurnClaudeMessageUuid("source", "turn-2")).toBeUndefined();
    expect(restarted.getTurnClaudeMessageUuid("source", "turn-1")).toBe("message-1");
    expect(restarted.getThreadRecord("source")?.lastClaudeMessageUuid).toBe("message-1");
    expect(restarted.listProviderItemCorrelations("source", ["message-2"])).toEqual([]);
    expect(restarted.getThreadRecord("projected-child", true)).toBeUndefined();
    restarted.close();
  });

  it("migrates existing global turn/item primary keys without losing rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-store-v2-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations VALUES (1), (2);
      CREATE TABLE threads (id TEXT PRIMARY KEY);
      INSERT INTO threads VALUES ('source');
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        turn_json TEXT NOT NULL,
        last_claude_message_uuid TEXT,
        UNIQUE(thread_id, ordinal)
      );
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT,
        payload_json TEXT NOT NULL,
        provider_item_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(turn_id, ordinal)
      );
      INSERT INTO turns VALUES ('turn-1', 'source', 0, 'completed', '{}', 'provider-1');
      INSERT INTO items VALUES ('item-1', 'source', 'turn-1', 0, 'agentMessage', NULL, '{}', NULL, 1, 1);
    `);
    legacy.close();

    const migrated = new SqliteHybridStore(path);
    migrated.close();
    const database = new DatabaseSync(path, { readOnly: true });
    expect((database.prepare("SELECT COUNT(*) AS count FROM turns").get() as { count: number }).count).toBe(1);
    expect((database.prepare("SELECT COUNT(*) AS count FROM items").get() as { count: number }).count).toBe(1);
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 3").get()).toEqual({ version: 3 });
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 5").get()).toEqual({ version: 5 });
    expect((database.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>)
      .some((column) => column.name === "deletion_pending")).toBe(true);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("commits a turn snapshot and event atomically and deduplicates lifecycle events", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-store-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const store = new SqliteHybridStore(path);
    const stored = record();
    store.createThread(stored);
    const turn: Turn = {
      id: "turn-1", items: [], itemsView: "full", status: "inProgress",
      error: null, startedAt: 11, completedAt: null, durationMs: null,
    };
    store.createTurn(stored.thread.id, turn);

    const injector = new DatabaseSync(path);
    injector.exec("CREATE TRIGGER fail_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;");
    injector.close();
    const changed: Turn = {
      ...turn,
      items: [{ type: "agentMessage", id: "item-1", text: "hello", phase: null, memoryCitation: null }],
    };
    expect(() => store.appendEvent(stored.thread.id, turn.id, "item/completed", { item: changed.items[0] }, {
      turn: changed, dedupKey: "item/completed:item-1",
    })).toThrow("injected event failure");
    expect(store.getTurn(stored.thread.id, turn.id)?.items).toEqual([]);

    const repair = new DatabaseSync(path);
    repair.exec("DROP TRIGGER fail_events");
    repair.close();
    expect(store.appendEvent(stored.thread.id, turn.id, "item/completed", { item: changed.items[0] }, {
      turn: changed, dedupKey: "item/completed:item-1",
    })).toBeGreaterThan(0);
    const snapshotHighWatermark = store.eventHighWatermark(stored.thread.id);
    store.appendEvent(stored.thread.id, turn.id, "item/agentMessage/delta", { delta: "after snapshot" });
    store.appendEvent(stored.thread.id, turn.id, "hybrid/providerMessage/processed", {});
    expect(store.listEventsAfter(stored.thread.id, snapshotHighWatermark)).toMatchObject([{
      method: "item/agentMessage/delta", params: { delta: "after snapshot" },
    }]);
    expect(store.appendEvent(stored.thread.id, turn.id, "item/completed", { item: changed.items[0] }, {
      turn: changed, dedupKey: "item/completed:item-1",
    })).toBe(0);
    store.close();

    const database = new DatabaseSync(path, { readOnly: true });
    expect((database.prepare("SELECT COUNT(*) AS count FROM items").get() as { count: number }).count).toBe(1);
    expect((database.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count).toBe(3);
    database.close();
  });

  it("rolls back thread state and terminal event batches together across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-store-thread-state-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    let store = new SqliteHybridStore(path);
    const original = record();
    store.createThread(original);

    const renameInjector = new DatabaseSync(path);
    renameInjector.exec(`
      CREATE TRIGGER fail_name_event BEFORE INSERT ON events
      WHEN NEW.method = 'thread/name/updated'
      BEGIN SELECT RAISE(ABORT, 'injected name event failure'); END;
    `);
    renameInjector.close();
    const renamed: ClaudeThreadRecord = {
      ...original,
      thread: { ...original.thread, name: "atomic name", updatedAt: 11 },
    };
    expect(() => store.commitThreadState({
      record: renamed,
      events: [{
        turnId: null,
        method: "thread/name/updated",
        params: { threadId: original.thread.id, threadName: "atomic name" },
      }],
    })).toThrow("injected name event failure");
    store.close();

    store = new SqliteHybridStore(path);
    expect(store.getThreadRecord(original.thread.id)?.thread.name).toBeNull();
    expect(store.listEventsAfter(original.thread.id, 0)).toEqual([]);
    const repair = new DatabaseSync(path);
    repair.exec("DROP TRIGGER fail_name_event");
    repair.close();

    const turn: Turn = {
      id: "turn-atomic", items: [], itemsView: "full", status: "inProgress",
      error: null, startedAt: 12, completedAt: null, durationMs: null,
    };
    const active: ClaudeThreadRecord = {
      ...original,
      thread: { ...original.thread, status: { type: "active", activeFlags: [] }, updatedAt: 12 },
    };
    const startCommit = {
      record: active,
      turn,
      insertTurn: true,
      events: [{
        turnId: turn.id,
        method: "thread/status/changed",
        params: { threadId: original.thread.id, status: active.thread.status },
      }],
    } as const;
    const startInjector = new DatabaseSync(path);
    startInjector.exec(`
      CREATE TRIGGER fail_start_event BEFORE INSERT ON events
      WHEN NEW.method = 'thread/status/changed'
      BEGIN SELECT RAISE(ABORT, 'injected start event failure'); END;
    `);
    startInjector.close();
    expect(() => store.commitThreadState(startCommit)).toThrow("injected start event failure");
    store.close();
    store = new SqliteHybridStore(path);
    expect(store.getThreadRecord(original.thread.id)?.thread.status).toEqual({ type: "idle" });
    expect(store.getTurn(original.thread.id, turn.id)).toBeUndefined();
    const startRepair = new DatabaseSync(path);
    startRepair.exec("DROP TRIGGER fail_start_event");
    startRepair.close();
    store.commitThreadState(startCommit);

    const terminalInjector = new DatabaseSync(path);
    terminalInjector.exec(`
      CREATE TRIGGER fail_terminal_event BEFORE INSERT ON events
      WHEN NEW.method = 'turn/completed'
      BEGIN SELECT RAISE(ABORT, 'injected terminal event failure'); END;
    `);
    terminalInjector.close();
    const completed: Turn = {
      ...turn, status: "completed", completedAt: 13, durationMs: 1_000,
    };
    const idle: ClaudeThreadRecord = {
      ...active,
      lastCompletedTurnId: turn.id,
      thread: { ...active.thread, status: { type: "idle" }, updatedAt: 13, recencyAt: 13 },
    };
    expect(() => store.commitThreadState({
      record: idle,
      turn: completed,
      events: [
        {
          turnId: turn.id,
          method: "thread/status/changed",
          params: { threadId: original.thread.id, status: idle.thread.status },
        },
        {
          turnId: turn.id,
          method: "turn/completed",
          params: { threadId: original.thread.id, turn: completed },
        },
      ],
    })).toThrow("injected terminal event failure");
    store.close();

    store = new SqliteHybridStore(path);
    expect(store.getThreadRecord(original.thread.id)?.thread.status).toEqual({
      type: "active", activeFlags: [],
    });
    expect(store.getTurn(original.thread.id, turn.id)?.status).toBe("inProgress");
    expect(store.listEventsAfter(original.thread.id, 0).map((event) => event.method))
      .toEqual(["thread/status/changed"]);
    const terminalRepair = new DatabaseSync(path);
    terminalRepair.exec("DROP TRIGGER fail_terminal_event");
    terminalRepair.close();
    store.commitThreadState({
      record: idle,
      turn: completed,
      events: [
        {
          turnId: turn.id,
          method: "thread/status/changed",
          params: { threadId: original.thread.id, status: idle.thread.status },
        },
        {
          turnId: turn.id,
          method: "turn/completed",
          params: { threadId: original.thread.id, turn: completed },
        },
      ],
    });
    store.close();

    const restarted = new SqliteHybridStore(path);
    expect(restarted.getThreadRecord(original.thread.id)?.thread.status).toEqual({ type: "idle" });
    expect(restarted.getTurn(original.thread.id, turn.id)?.status).toBe("completed");
    expect(restarted.listEventsAfter(original.thread.id, 0).map((event) => event.method)).toEqual([
      "thread/status/changed",
      "thread/status/changed",
      "turn/completed",
    ]);
    restarted.close();
  });

  it("commits provider tip, boundary, correlations, terminal state, and events atomically across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-store-provider-boundary-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    let store = new SqliteHybridStore(path);
    const original = record();
    store.createThread(original);
    const activeTurn: Turn = {
      id: "compact-turn",
      items: [{ type: "contextCompaction", id: "compact-item" }],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: 12,
      completedAt: null,
      durationMs: null,
    };
    const active: ClaudeThreadRecord = {
      ...original,
      thread: { ...original.thread, status: { type: "active", activeFlags: [] }, updatedAt: 12 },
    };
    store.commitThreadState({
      record: active,
      turn: activeTurn,
      insertTurn: true,
      events: [{
        turnId: activeTurn.id,
        method: "thread/status/changed",
        params: { threadId: original.thread.id, status: active.thread.status },
      }],
    });
    const completedTurn: Turn = {
      ...activeTurn,
      status: "completed",
      completedAt: 13,
      durationMs: 1_000,
    };
    const idle: ClaudeThreadRecord = {
      ...active,
      lastClaudeMessageUuid: "compact-boundary",
      lastCompletedTurnId: activeTurn.id,
      thread: { ...active.thread, status: { type: "idle" }, updatedAt: 13, recencyAt: 13 },
    };
    const terminal = {
      record: idle,
      turn: completedTurn,
      providerBoundary: {
        ownerThreadId: original.thread.id,
        turnId: activeTurn.id,
        messageUuid: "compact-boundary",
        itemIds: ["compact-item"],
      },
      events: [
        {
          turnId: activeTurn.id,
          method: "thread/compacted",
          params: { threadId: original.thread.id, turnId: activeTurn.id },
        },
        {
          turnId: activeTurn.id,
          method: "turn/completed",
          params: { threadId: original.thread.id, turn: completedTurn },
        },
      ],
    } as const;
    const injector = new DatabaseSync(path);
    injector.exec(`
      CREATE TRIGGER fail_compaction_event BEFORE INSERT ON events
      WHEN NEW.method = 'turn/completed'
      BEGIN SELECT RAISE(ABORT, 'injected compaction event failure'); END;
    `);
    injector.close();
    expect(() => store.commitThreadState(terminal)).toThrow("injected compaction event failure");
    store.close();

    store = new SqliteHybridStore(path);
    expect(store.getThreadRecord(original.thread.id, false)).toMatchObject({
      lastClaudeMessageUuid: null,
      lastCompletedTurnId: null,
      thread: { status: { type: "active" } },
    });
    expect(store.getTurn(original.thread.id, activeTurn.id)?.status).toBe("inProgress");
    expect(store.getTurnClaudeMessageUuid(original.thread.id, activeTurn.id)).toBeUndefined();
    expect(store.listProviderItemCorrelations(original.thread.id, ["compact-boundary"])).toEqual([]);
    expect(store.listEventsAfter(original.thread.id, 0).map((event) => event.method))
      .toEqual(["thread/status/changed"]);
    const repair = new DatabaseSync(path);
    repair.exec("DROP TRIGGER fail_compaction_event");
    repair.close();
    store.commitThreadState(terminal);
    store.close();

    const reopened = new SqliteHybridStore(path);
    expect(reopened.getThreadRecord(original.thread.id, false)).toMatchObject({
      lastClaudeMessageUuid: "compact-boundary",
      lastCompletedTurnId: activeTurn.id,
      thread: { status: { type: "idle" } },
    });
    expect(reopened.getTurn(original.thread.id, activeTurn.id)?.status).toBe("completed");
    expect(reopened.getTurnClaudeMessageUuid(original.thread.id, activeTurn.id)).toBe("compact-boundary");
    expect(reopened.listProviderItemCorrelations(original.thread.id, ["compact-boundary"]))
      .toEqual([{
        providerMessageId: "compact-boundary",
        ownerThreadId: original.thread.id,
        turnId: activeTurn.id,
        itemId: "compact-item",
      }]);
    expect(reopened.listEventsAfter(original.thread.id, 0).map((event) => event.method)).toEqual([
      "thread/status/changed",
      "thread/compacted",
      "turn/completed",
    ]);
    reopened.close();
  });

  it("commits archive cascades and their events atomically across failure and restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-store-archive-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    let store = new SqliteHybridStore(path);
    const root = record("root");
    const child = { ...record("child"), thread: { ...thread("child"), parentThreadId: "root" } };
    store.createThread(root);
    store.createThread(child);

    const injector = new DatabaseSync(path);
    injector.exec(`
      CREATE TRIGGER fail_child_archive BEFORE INSERT ON events
      WHEN NEW.thread_id = 'child' AND NEW.method = 'thread/archived'
      BEGIN SELECT RAISE(ABORT, 'injected child archive failure'); END;
    `);
    injector.close();
    expect(() => store.commitThreadsArchived(["root", "child"], true))
      .toThrow("injected child archive failure");
    expect(store.isThreadArchived("root")).toBe(false);
    expect(store.isThreadArchived("child")).toBe(false);
    expect(store.listEventsAfter("root", 0)).toEqual([]);
    expect(store.listEventsAfter("child", 0)).toEqual([]);
    store.close();
    store = new SqliteHybridStore(path);
    expect(store.isThreadArchived("root")).toBe(false);
    expect(store.isThreadArchived("child")).toBe(false);
    expect(store.listEventsAfter("root", 0)).toEqual([]);
    expect(store.listEventsAfter("child", 0)).toEqual([]);

    const archiveRepair = new DatabaseSync(path);
    archiveRepair.exec("DROP TRIGGER fail_child_archive");
    archiveRepair.close();
    store.commitThreadsArchived(["root", "child"], true);
    expect(store.isThreadArchived("root")).toBe(true);
    expect(store.isThreadArchived("child")).toBe(true);

    const unarchiveInjector = new DatabaseSync(path);
    unarchiveInjector.exec(`
      CREATE TRIGGER fail_child_unarchive BEFORE INSERT ON events
      WHEN NEW.thread_id = 'child' AND NEW.method = 'thread/unarchived'
      BEGIN SELECT RAISE(ABORT, 'injected child unarchive failure'); END;
    `);
    unarchiveInjector.close();
    expect(() => store.commitThreadsArchived(["root", "child"], false))
      .toThrow("injected child unarchive failure");
    expect(store.isThreadArchived("root")).toBe(true);
    expect(store.isThreadArchived("child")).toBe(true);
    expect(store.listEventsAfter("root", 0).map((event) => event.method)).toEqual(["thread/archived"]);
    expect(store.listEventsAfter("child", 0).map((event) => event.method)).toEqual(["thread/archived"]);
    store.close();
    store = new SqliteHybridStore(path);
    expect(store.isThreadArchived("root")).toBe(true);
    expect(store.isThreadArchived("child")).toBe(true);

    const unarchiveRepair = new DatabaseSync(path);
    unarchiveRepair.exec("DROP TRIGGER fail_child_unarchive");
    unarchiveRepair.close();
    store.commitThreadsArchived(["root", "child"], false);
    store.close();

    const restarted = new SqliteHybridStore(path);
    expect(restarted.isThreadArchived("root")).toBe(false);
    expect(restarted.isThreadArchived("child")).toBe(false);
    for (const threadId of ["root", "child"]) {
      expect(restarted.listEventsAfter(threadId, 0).map((event) => event.method))
        .toEqual(["thread/archived", "thread/unarchived"]);
    }
    restarted.close();
  });

  it("journals provider payloads before projection and deduplicates provider UUIDs", () => {
    const store = createStore();
    store.createThread(record());
    const input = {
      threadId: "thread-1", processEpoch: "epoch-1", providerSequence: 1,
      providerEventType: "system/task_started", providerEventId: "event-1",
      payload: { type: "system", subtype: "task_started", task_id: "task-1" }, createdAt: 123,
    } as const;

    const first = store.appendProviderEvent(input);
    const duplicate = store.appendProviderEvent({ ...input, processEpoch: "epoch-2", providerSequence: 99 });
    expect(first.inserted).toBe(true);
    expect(duplicate).toEqual({ record: first.record, inserted: false });
    expect(store.listProviderEvents("thread-1", "pending")).toEqual([first.record]);

    store.completeProviderEvent("thread-1", first.record.sequence, "projected");
    expect(store.listProviderEvents("thread-1")).toMatchObject([{
      providerEventId: "event-1", disposition: "projected", payload: input.payload, error: null,
    }]);
    expect(store.listProviderEvents("thread-1", "pending")).toEqual([]);
    store.close();
  });

  it("bounds completed provider payloads while preserving diagnostic records", () => {
    const store = createStore();
    store.createThread(record());
    const append = (index: number) => store.appendProviderEvent({
      threadId: "thread-1", processEpoch: "epoch-1", providerSequence: index,
      providerEventType: `event/${index}`, providerEventId: `event-${index}`,
      payload: { index, text: "🙂".repeat(index) }, createdAt: index,
    }).record;
    for (let index = 1; index <= 6; index += 1) {
      const event = append(index);
      store.completeProviderEvent("thread-1", event.sequence, "projected");
    }
    const failed = append(7);
    store.completeProviderEvent("thread-1", failed.sequence, "failed", "projection failed");
    const abandoned = append(8);
    store.completeProviderEvent("thread-1", abandoned.sequence, "abandoned", "process exited");
    append(9);

    expect(store.pruneProviderEvents("thread-1", 2, 1_000_000)).toBe(4);
    expect(store.listProviderEvents("thread-1").map((event) => event.providerEventId)).toEqual([
      "event-5", "event-6", "event-7", "event-8", "event-9",
    ]);

    const oversized = append(10);
    store.completeProviderEvent("thread-1", oversized.sequence, "stateOnly");
    store.pruneProviderEvents("thread-1", 10, 1);
    expect(store.listProviderEvents("thread-1").map((event) => event.providerEventId)).toEqual([
      "event-7", "event-8", "event-9", "event-10",
    ]);
    store.close();
  });

  it("persists provider message to projected item correlations", () => {
    const store = createStore();
    store.createThread(record());
    store.linkProviderItems("thread-1", "provider-message", "thread-1", "turn-1", ["item-1", "item-2", "item-1"]);
    expect(store.listProviderItemCorrelations("thread-1", ["provider-message"])).toEqual([
      { providerMessageId: "provider-message", ownerThreadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
      { providerMessageId: "provider-message", ownerThreadId: "thread-1", turnId: "turn-1", itemId: "item-2" },
    ]);
    store.deleteProviderItemCorrelations("thread-1", ["provider-message"]);
    expect(store.listProviderItemCorrelations("thread-1", ["provider-message"])).toEqual([]);
    store.close();
  });

  it("restores a corrupt database from the last consistent backup", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-store-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const store = new SqliteHybridStore(path);
    store.createThread(record());
    store.close();
    writeFileSync(path, "not a sqlite database");

    const recovered = new SqliteHybridStore(path);
    expect(recovered.hasThread("thread-1")).toBe(true);
    expect(readdirSync(directory).some((name) => name.startsWith("state.sqlite.corrupt-"))).toBe(true);
    recovered.close();
  });
});
