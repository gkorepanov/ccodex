import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import { initializeHandoffPersistence } from "../../src/handoff/startupMigration.js";
import { HandoffStore } from "../../src/handoff/store.js";

const directories: string[] = [];

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), "ccodex-startup-migration-"));
  directories.push(directory);
  return join(directory, "handoffs.sqlite");
}

function thread(id: string): Thread {
  return {
    id,
    extra: null,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    canAcceptDirectInput: true,
    preview: `private ${id}`,
    ephemeral: false,
    section: null, sectionEnteredAt: null, projectId: null,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "idle" },
    path: `/private/${id}.jsonl`,
    cwd: "/private/workspace",
    cliVersion: "0.149.1",
    source: "appServer",
    threadSource: "user",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: `private ${id}`,
    turns: [],
  };
}

function legacyDatabase(databasePath: string): void {
  const store = new HandoffStore(databasePath);
  store.createLogicalThread({
    thread: thread("stock-public"),
    epoch: {
      id: "stock-epoch",
      provider: "stock",
      backendThreadId: "stock-backend",
      model: "gpt-5.6-sol",
      settings: { privateStock: true },
    },
  });
  store.createLogicalThread({
    thread: thread("claude-public"),
    epoch: {
      id: "claude-epoch",
      provider: "claude",
      backendThreadId: "claude-backend",
      model: "claude:sonnet",
      settings: { privateClaude: true },
    },
  });
  store.close();
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE logical_threads SET thread_json = ? WHERE public_thread_id = ?")
    .run(JSON.stringify(thread("stock-public")), "stock-public");
  database.prepare("UPDATE logical_threads SET thread_json = ? WHERE public_thread_id = ?")
    .run(JSON.stringify(thread("claude-public")), "claude-public");
  database.prepare("UPDATE provider_epochs SET model = ?, settings_json = ? WHERE epoch_id = ?")
    .run("gpt-5.6-sol", JSON.stringify({ privateStock: true }), "stock-epoch");
  database.prepare("UPDATE provider_epochs SET model = ?, settings_json = ? WHERE epoch_id = ?")
    .run("claude:sonnet", JSON.stringify({ privateClaude: true }), "claude-epoch");
  database.close();
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("initializeHandoffPersistence", () => {
  it("initializes stock, validates every native backend, then backs up and scrubs legacy state", async () => {
    const databasePath = path();
    legacyDatabase(databasePath);
    const calls: string[] = [];
    const stock = {
      async initialize() { calls.push("stock:initialize"); },
      async request(method: string, params: unknown) {
        calls.push(`stock:${method}:${(params as { threadId: string }).threadId}`);
        return { thread: thread("stock-backend") };
      },
    };
    const claude = {
      readThread(threadId: string) {
        calls.push(`claude:thread/read:${threadId}`);
        return { thread: thread(threadId) };
      },
    };

    const persistence = await initializeHandoffPersistence(databasePath, stock, claude);
    expect(calls[0]).toBe("stock:initialize");
    expect(calls).toContain("stock:thread/read:stock-backend");
    expect(calls).toContain("claude:thread/read:claude-backend");
    expect(persistence.lineage.needsLegacyMigration()).toBe(false);
    expect(persistence.lineage.listTasks()).toHaveLength(2);
    expect(existsSync(`${databasePath}.pre-lineage-v2.bak`)).toBe(true);
    persistence.lineage.close();
    persistence.operational.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const serialized = JSON.stringify({
      threads: database.prepare("SELECT * FROM logical_threads").all(),
      epochs: database.prepare("SELECT * FROM provider_epochs").all(),
    });
    expect(serialized).not.toContain("privateStock");
    expect(serialized).not.toContain("privateClaude");
    database.close();
  });

  it("checks every backend and aborts without backup or scrub when one is missing", async () => {
    const databasePath = path();
    legacyDatabase(databasePath);
    const calls: string[] = [];
    const stock = {
      async initialize() { calls.push("stock:initialize"); },
      async request(_method: string, params: unknown) {
        const threadId = (params as { threadId: string }).threadId;
        calls.push(`stock:read:${threadId}`);
        throw new Error("native stock session missing");
      },
    };
    const claude = {
      readThread(threadId: string) {
        calls.push(`claude:read:${threadId}`);
        return { thread: thread(threadId) };
      },
    };

    await expect(initializeHandoffPersistence(databasePath, stock, claude)).rejects.toThrow(
      "stock:stock-backend (native stock session missing)",
    );
    expect(calls).toContain("claude:read:claude-backend");
    expect(calls).toContain("stock:read:stock-backend");
    expect(existsSync(`${databasePath}.pre-lineage-v2.bak`)).toBe(false);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect((database.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version)
      .toBe(0);
    expect(JSON.stringify(database.prepare("SELECT * FROM provider_epochs").all())).toContain("privateStock");
    expect(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lineage_tasks'`).get())
      .toBeUndefined();
    database.close();
  });

  it("does not open or migrate the database when stock initialization fails", async () => {
    const databasePath = path();
    legacyDatabase(databasePath);
    let providerRead = false;
    await expect(initializeHandoffPersistence(databasePath, {
      async initialize() { throw new Error("stock initialize failed"); },
      async request() { providerRead = true; },
    }, {
      readThread() { providerRead = true; },
    })).rejects.toThrow("stock initialize failed");
    expect(providerRead).toBe(false);
    expect(existsSync(`${databasePath}.pre-lineage-v2.bak`)).toBe(false);
  });
});
