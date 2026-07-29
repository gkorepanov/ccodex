import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import { LineageStore } from "../../src/handoff/lineageStore.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-"));
  directories.push(directory);
  return join(directory, "handoffs.sqlite");
}

function turn(id: string, text = id): Turn {
  return {
    id,
    items: [{ type: "agentMessage", id: `${id}-item`, text, phase: "final_answer", memoryCitation: null }],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1_000,
  };
}

function thread(id: string): Thread {
  return {
    id,
    extra: null,
    sessionId: "public-session",
    forkedFromId: "parent-public",
    parentThreadId: null,
    canAcceptDirectInput: true,
    preview: "PRIVATE PROVIDER PREVIEW",
    ephemeral: false,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "idle" },
    path: "/private/provider/thread.jsonl",
    cwd: "/private/workspace",
    cliVersion: "0.145.0",
    source: "appServer",
    threadSource: "user",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "PRIVATE PROVIDER TITLE",
    turns: [],
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("LineageStore", () => {
  it("repairs duplicated catalog identities only for top-level tasks", () => {
    const path = databasePath();
    const store = new LineageStore(path);
    store.createTask({
      publicThreadId: "top-level", currentEpochId: "top-epoch", sessionId: "shared", createdAt: 1,
    }, { epochId: "top-epoch", provider: "claude", backendThreadId: "top-backend" });
    store.createTask({
      publicThreadId: "child", currentEpochId: "child-epoch", sessionId: "shared", createdAt: 1,
      parentThreadId: "top-level",
    }, { epochId: "child-epoch", provider: "claude", backendThreadId: "child-backend" });
    store.close();

    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA user_version = 2");
    legacy.close();

    const migrated = new LineageStore(path);
    expect(migrated.getTask("top-level")?.sessionId).toBe("top-level");
    expect(migrated.getTask("child")?.sessionId).toBe("shared");
    migrated.close();
  });

  it("stores only public identity, provider boundaries, and synthetic CCodex turns", () => {
    const path = databasePath();
    const store = new LineageStore(path);
    expect(store.createTask({
      publicThreadId: "public",
      currentEpochId: "stock-epoch",
      sessionId: "public",
      createdAt: 1,
      forkedFromId: "parent-public",
    }, {
      epochId: "stock-epoch",
      provider: "stock",
      backendThreadId: "stock-backend",
    })).toMatchObject({ revision: 1 });

    const compact = turn("compact", "CCODEX SYNTHETIC SUMMARY");
    expect(store.commitEpoch(
      "public",
      "stock-epoch",
      1,
      { startTurnId: "stock-turn-1", endTurnId: "stock-turn-9" },
      { epochId: "claude-epoch", provider: "claude", backendThreadId: "claude-backend" },
      [{ publicTurnId: compact.id, turn: compact }],
    )).toMatchObject({ currentEpochId: "claude-epoch", revision: 2 });
    expect(store.listEpochs("public")).toMatchObject([
      {
        epochId: "stock-epoch",
        state: "sealed",
        startTurnId: "stock-turn-1",
        endTurnId: "stock-turn-9",
        archivePending: true,
      },
      { epochId: "claude-epoch", state: "current" },
    ]);
    expect(store.listSegments("public")).toMatchObject([
      {
        kind: "provider",
        epochId: "stock-epoch",
        startTurnId: "stock-turn-1",
        endTurnId: "stock-turn-9",
      },
      { kind: "synthetic", publicTurnId: "compact", turn: { id: "compact" } },
    ]);
    store.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const schema = (database.prepare(`
      SELECT sql FROM sqlite_master WHERE name IN ('lineage_tasks', 'lineage_epochs', 'lineage_segments')
    `).all() as unknown as Array<{ sql: string }>).map((row) => row.sql).join("\n");
    expect(schema).not.toContain("thread_json");
    expect(schema).not.toContain("settings_json");
    expect(schema).not.toContain("turn_json TEXT NOT NULL");
    const dump = JSON.stringify({
      tasks: database.prepare("SELECT * FROM lineage_tasks").all(),
      epochs: database.prepare("SELECT * FROM lineage_epochs").all(),
      segments: database.prepare("SELECT * FROM lineage_segments").all(),
    });
    expect(dump).not.toContain("PRIVATE PROVIDER");
    expect(dump).toContain("CCODEX SYNTHETIC SUMMARY");
    database.close();
  });

  it("migrates copied provider history to compact boundary segments idempotently", () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    createLegacySchema(database);
    database.prepare(`
      INSERT INTO logical_threads (
        public_thread_id, current_epoch_id, thread_json, revision, created_at, updated_at
      ) VALUES (?, ?, ?, 7, 1, 2)
    `).run("public", "claude-epoch", JSON.stringify(thread("public")));
    database.prepare(`
      INSERT INTO provider_epochs (
        epoch_id, public_thread_id, ordinal, provider, backend_thread_id, model,
        settings_json, state, created_at, sealed_at, archive_pending, delete_done
      ) VALUES
        ('stock-epoch', 'public', 0, 'stock', 'stock-backend', 'gpt-secret',
          '{"secret":"STOCK SETTINGS"}', 'sealed', 1, 2, 0, 0),
        ('claude-epoch', 'public', 1, 'claude', 'claude-backend', 'claude-secret',
          '{"secret":"CLAUDE SETTINGS"}', 'current', 2, NULL, 0, 0)
    `).run();
    const insertTurn = database.prepare(`
      INSERT INTO logical_turns (
        public_thread_id, position, public_turn_id, epoch_id, provider_turn_id, turn_json, kind
      ) VALUES ('public', ?, ?, ?, ?, ?, ?)
    `);
    insertTurn.run(0, "stock-1", "stock-epoch", "stock-1", JSON.stringify(turn("stock-1", "PRIVATE TURN 1")), "provider");
    insertTurn.run(1, "stock-2", "stock-epoch", "stock-2", JSON.stringify(turn("stock-2", "PRIVATE TURN 2")), "provider");
    insertTurn.run(2, "compact", null, null, JSON.stringify(turn("compact", "SYNTHETIC HANDOFF")), "migrationCompact");
    insertTurn.run(3, "claude-1", "claude-epoch", "claude-1", JSON.stringify(turn("claude-1", "PRIVATE TURN 3")), "provider");
    const insertJob = database.prepare(`
      INSERT INTO provider_switch_jobs (
        job_id, public_thread_id, expected_epoch_id, expected_thread_revision, pending_revision,
        target_provider, target_model, settings_json, turn_params_json, compaction_turn_json,
        status, summary, target_backend_thread_id, target_provider_turn_id, error, created_at, updated_at
      ) VALUES (?, 'public', 'claude-epoch', 7, 3, 'stock', 'gpt-5.6-sol', ?, ?, ?, ?, ?, ?, ?, NULL, 10, 20)
    `);
    insertJob.run(
      "active-job",
      JSON.stringify({ secret: "ACTIVE SETTINGS" }),
      JSON.stringify({ input: "ACTIVE TURN" }),
      JSON.stringify(turn("active-compact")),
      "targetCreated",
      "active summary",
      "new-stock",
      "new-stock-turn",
    );
    insertJob.run(
      "committed-job",
      JSON.stringify({ secret: "TERMINAL SETTINGS" }),
      JSON.stringify({ input: "TERMINAL TURN" }),
      JSON.stringify(turn("terminal-compact")),
      "committed",
      "done",
      "old-stock",
      "old-stock-turn",
    );
    database.close();

    let store = new LineageStore(path);
    expect(store.needsLegacyMigration()).toBe(true);
    expect(() => store.finalizeLegacyMigration(new Set())).toThrow("validated provider backends");
    expect(store.needsLegacyMigration()).toBe(true);
    store.finalizeLegacyMigration(new Set([
      "stock:stock-backend",
      "claude:claude-backend",
    ]));
    expect(existsSync(`${path}.pre-lineage-v2.bak`)).toBe(true);
    expect(store.getTask("public")).toEqual({
      publicThreadId: "public",
      currentEpochId: "claude-epoch",
      revision: 7,
      sessionId: "public",
      createdAt: 1,
      forkedFromId: "parent-public",
    });
    expect(store.listSegments("public")).toMatchObject([
      { kind: "provider", epochId: "stock-epoch", startTurnId: "stock-1", endTurnId: "stock-2" },
      { kind: "synthetic", publicTurnId: "compact", turn: { id: "compact" } },
    ]);
    store.close();

    const previousVersion = new DatabaseSync(path);
    previousVersion.exec("PRAGMA user_version = 2");
    previousVersion.close();

    store = new LineageStore(path);
    expect(store.listSegments("public")).toHaveLength(2);
    expect(store.listEpochs("public")).toHaveLength(2);
    store.close();

    const migrated = new DatabaseSync(path, { readOnly: true });
    expect((migrated.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version)
      .toBe(3);
    const minimal = JSON.stringify({
      tasks: migrated.prepare("SELECT * FROM lineage_tasks").all(),
      epochs: migrated.prepare("SELECT * FROM lineage_epochs").all(),
      segments: migrated.prepare("SELECT * FROM lineage_segments").all(),
      legacyTasks: migrated.prepare("SELECT * FROM logical_threads").all(),
      legacyEpochs: migrated.prepare("SELECT * FROM provider_epochs").all(),
      legacyTurns: migrated.prepare("SELECT * FROM logical_turns").all(),
    });
    expect(minimal).not.toContain("PRIVATE PROVIDER");
    expect(minimal).not.toContain("PRIVATE TURN");
    expect(minimal).not.toContain("SETTINGS");
    expect(minimal).not.toContain("gpt-secret");
    expect(minimal).not.toContain("claude-secret");
    expect(minimal).toContain("SYNTHETIC HANDOFF");
    migrated.close();
  });

  it("keeps shared provider boundaries until the last fork stops referencing them", () => {
    const store = new LineageStore(databasePath());
    store.createTask({
      publicThreadId: "source",
      currentEpochId: "source-current",
      sessionId: "source",
      createdAt: 1,
    }, {
      epochId: "source-current",
      provider: "stock",
      backendThreadId: "stock-source",
    });
    store.commitEpoch(
      "source",
      "source-current",
      1,
      { startTurnId: "turn-1", endTurnId: "turn-2" },
      { epochId: "source-claude", provider: "claude", backendThreadId: "claude-source" },
    );
    store.createForkTask({
      publicThreadId: "fork",
      currentEpochId: "fork-current",
      sessionId: "fork",
      createdAt: 2,
      forkedFromId: "source",
    }, {
      epochId: "fork-current",
      provider: "claude",
      backendThreadId: "claude-fork",
    }, [{
      kind: "provider",
      epochId: "source-current",
      startTurnId: "turn-1",
      endTurnId: "turn-2",
    }]);

    expect(store.epochBelongsToLineage("fork", "source-current")).toBe(true);
    expect(store.deleteTask("source")).toBe(true);
    expect(store.getEpoch("source-current")).toBeDefined();
    expect(store.listSegments("fork")).toHaveLength(1);
    expect(store.taskEpochs("fork").map((epoch) => epoch.epochId)).toContain("source-current");
    store.markEpochDeleted("source-current");
    store.markEpochDeleted("fork-current");
    expect(store.deleteTask("fork")).toBe(true);
    expect(store.getEpoch("source-current")).toBeUndefined();
    store.close();
  });

  it("commits rollback history and a replacement current epoch under one CAS", () => {
    const store = new LineageStore(databasePath());
    store.createTask({
      publicThreadId: "public",
      currentEpochId: "stock-current",
      sessionId: "public",
      createdAt: 1,
    }, {
      epochId: "stock-current",
      provider: "stock",
      backendThreadId: "stock-backend",
    });
    const retained: Parameters<LineageStore["commitRollback"]>[4] = [{
      kind: "provider",
      epochId: "stock-current",
      startTurnId: "turn-1",
      endTurnId: "turn-2",
    }];
    expect(store.commitRollback("public", "wrong", 1, {
      epochId: "claude-current",
      provider: "claude",
      backendThreadId: "claude-backend",
    }, retained)).toBeUndefined();
    expect(store.commitRollback("public", "stock-current", 1, {
      epochId: "claude-current",
      provider: "claude",
      backendThreadId: "claude-backend",
    }, retained)).toMatchObject({ currentEpochId: "claude-current", revision: 2 });
    expect(store.listSegments("public")).toMatchObject(retained);
    expect(store.getEpoch("stock-current")).toMatchObject({
      state: "sealed",
      startTurnId: "turn-1",
      endTurnId: "turn-2",
      archivePending: true,
    });
    store.close();
  });
});

function createLegacySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE logical_threads (
      public_thread_id TEXT PRIMARY KEY,
      current_epoch_id TEXT NOT NULL,
      thread_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE provider_epochs (
      epoch_id TEXT PRIMARY KEY,
      public_thread_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      provider TEXT NOT NULL,
      backend_thread_id TEXT NOT NULL,
      model TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sealed_at INTEGER,
      archive_pending INTEGER NOT NULL,
      delete_done INTEGER NOT NULL
    );
    CREATE TABLE logical_turns (
      public_thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      public_turn_id TEXT NOT NULL,
      epoch_id TEXT,
      provider_turn_id TEXT,
      turn_json TEXT NOT NULL,
      kind TEXT NOT NULL
    );
    CREATE TABLE provider_switch_jobs (
      job_id TEXT PRIMARY KEY,
      public_thread_id TEXT NOT NULL,
      expected_epoch_id TEXT NOT NULL,
      expected_thread_revision INTEGER NOT NULL,
      pending_revision INTEGER NOT NULL,
      target_provider TEXT NOT NULL,
      target_model TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      turn_params_json TEXT NOT NULL,
      compaction_turn_json TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      target_backend_thread_id TEXT,
      target_provider_turn_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}
