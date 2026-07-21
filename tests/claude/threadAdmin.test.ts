import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { HybridConfig } from "../../src/config/config.js";
import {
  ClaudeService,
  EPHEMERAL_DISCONNECT_GRACE_MS,
  type ClaudeThreadAdminEffects,
} from "../../src/claude/service.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import type { ClaudeThreadRecord, HybridStore } from "../../src/store/HybridStore.js";
import { MemoryHybridStore } from "../../src/store/memoryStore.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";

const directories: string[] = [];

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  while (!predicate()) await new Promise<void>((resolve) => setTimeout(resolve, 1));
};

class DeleteCommitFailureStore extends MemoryHybridStore {
  public failDeleteCommit = true;
  private deleteCalls = 0;

  public override deleteThread(threadId: string): void {
    super.deleteThread(threadId);
    this.deleteCalls += 1;
    if (this.failDeleteCommit && this.deleteCalls === 1) {
      throw new Error("injected deletion commit failure");
    }
  }
}

function seedProjectedSubtree(store: HybridStore, root: ClaudeThreadRecord): void {
  for (const [id, parentThreadId] of [
    ["projected-child", root.thread.id],
    ["projected-grandchild", "projected-child"],
  ] as const) {
    store.createThread({
      ...root,
      claudeSessionId: `${id}-session`,
      thread: { ...root.thread, id, parentThreadId, turns: [] },
    });
  }
}

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

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Claude thread admin session cutover", () => {
  it("keeps reverse SDK rename completion and failure from overwriting durable state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-admin-rename-"));
    directories.push(directory);
    const store = new MemoryHybridStore();
    const calls: Array<{ name: string; operation: ReturnType<typeof deferred> }> = [];
    const effects: ClaudeThreadAdminEffects = {
      rename: async (_sessionId, name) => {
        const operation = deferred();
        calls.push({ name, operation });
        return operation.promise;
      },
      delete: async () => undefined,
    };
    const hub = new SubscriptionHub();
    const events: string[] = [];
    const service = new ClaudeService(
      config(directory),
      hub,
      new Logger("error"),
      store,
      new FakeClaudeQuery().factory,
      undefined,
      undefined,
      undefined,
      effects,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    const current = store.getThreadRecord(started.thread.id)!;
    store.updateThread({ ...current, lastClaudeMessageUuid: "provider-boundary" });
    hub.subscribe(started.thread.id, "desktop", (method) => events.push(method));

    const first = service.setThreadName({ threadId: started.thread.id, name: "first" });
    await waitFor(() => calls.length === 1);
    await service.updateThreadMetadata({
      threadId: started.thread.id,
      gitInfo: { branch: "main", sha: "abc123" },
    });
    const second = service.setThreadName({ threadId: started.thread.id, name: "second" });
    await waitFor(() => calls.length === 2);
    calls[1]!.operation.resolve();
    await second;
    calls[0]!.operation.resolve();
    await first;

    expect(service.readThread(started.thread.id, false).thread).toMatchObject({
      name: "second",
      gitInfo: { branch: "main", sha: "abc123" },
    });
    expect(events.filter((method) => method === "thread/name/updated")).toHaveLength(1);

    const failed = service.setThreadName({ threadId: started.thread.id, name: "failed" });
    await waitFor(() => calls.length === 3);
    calls[2]!.operation.reject(new Error("provider rename failed"));
    await expect(failed).rejects.toThrow("provider rename failed");
    expect(service.readThread(started.thread.id, false).thread.name).toBe("second");
    expect(events.filter((method) => method === "thread/name/updated")).toHaveLength(1);
    await service.close();
  });

  it("keeps the mailbox responsive while runtime stop is pending and archives only after stop", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-admin-archive-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const store = new MemoryHybridStore();
    const service = new ClaudeService(
      config(directory),
      new SubscriptionHub(),
      new Logger("error"),
      store,
      fake.factory,
      undefined,
      undefined,
      undefined,
      { rename: async () => undefined, delete: async () => undefined },
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    const turn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "load runtime", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed");
    const stop = deferred();
    fake.returnWait = stop.promise;

    const archive = service.archiveThread(started.thread.id);
    await waitFor(() => fake.returnCalls === 1);
    await expect(Promise.race([
      service.getGoal(started.thread.id),
      new Promise((_, reject) => setTimeout(() => reject(new Error("mailbox blocked")), 50)),
    ])).resolves.toEqual({ goal: null });
    expect(store.isThreadArchived(started.thread.id)).toBe(false);
    stop.resolve();
    await archive;
    expect(store.isThreadArchived(started.thread.id)).toBe(true);
    await service.close();
  });

  it.each(["rename", "archive", "delete"] as const)(
    "waits for an already-running idle retirement before %s",
    async (operation) => {
      const directory = mkdtempSync(join(tmpdir(), `ccodex-admin-idle-${operation}-`));
      directories.push(directory);
      const stop = deferred();
      const providerCalls: string[] = [];
      const store = new MemoryHybridStore();
      const fake = new FakeClaudeQuery();
      const service = new ClaudeService(
        { ...config(directory), idleTimeoutSeconds: -1 },
        new SubscriptionHub(),
        new Logger("error"),
        store,
        fake.factory,
        undefined,
        undefined,
        undefined,
        {
          rename: async (_sessionId, name) => { providerCalls.push(`rename:${name}`); },
          delete: async () => { providerCalls.push("delete"); },
        },
      );
      const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
      await service.resumeThread(started.thread.id);
      const loaded = store.getThreadRecord(started.thread.id, false)!;
      store.updateThread({ ...loaded, lastClaudeMessageUuid: "provider-boundary" });
      fake.returnWait = stop.promise;

      const unload = (service as unknown as {
        unloadIdleRuntimes(): Promise<void>;
      }).unloadIdleRuntimes();
      await waitFor(() => fake.returnCalls === 1);
      const admin = operation === "rename"
        ? service.setThreadName({ threadId: started.thread.id, name: "after retirement" })
        : operation === "archive"
          ? service.archiveThread(started.thread.id)
          : service.deleteThread(started.thread.id);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(providerCalls).toEqual([]);
      expect(store.hasThread(started.thread.id)).toBe(true);
      expect(store.isThreadArchived(started.thread.id)).toBe(false);

      stop.resolve();
      await Promise.all([unload, admin]);
      if (operation === "rename") {
        expect(providerCalls).toEqual(["rename:after retirement"]);
        expect(service.readThread(started.thread.id, false).thread.name).toBe("after retirement");
      } else if (operation === "archive") {
        expect(providerCalls).toEqual([]);
        expect(store.isThreadArchived(started.thread.id)).toBe(true);
      } else {
        expect(providerCalls).toEqual(["delete"]);
        expect(store.hasThread(started.thread.id)).toBe(false);
      }
      await service.close();
    },
  );

  it.each(["archive", "delete"] as const)(
    "continues %s after idle retirement absorbs a provider return failure",
    async (operation) => {
      const directory = mkdtempSync(join(tmpdir(), `ccodex-admin-idle-failure-${operation}-`));
      directories.push(directory);
      const stop = deferred();
      const store = new MemoryHybridStore();
      const fake = new FakeClaudeQuery();
      fake.returnWait = stop.promise;
      fake.returnError = new Error("injected idle retirement failure");
      const service = new ClaudeService(
        { ...config(directory), idleTimeoutSeconds: -1 },
        new SubscriptionHub(),
        new Logger("error"),
        store,
        fake.factory,
        undefined,
        undefined,
        undefined,
        {
          rename: async () => undefined,
          delete: async () => undefined,
        },
      );
      const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
      await service.resumeThread(started.thread.id);
      const serviceState = service as unknown as { unloadIdleRuntimes(): Promise<void> };

      const unload = serviceState.unloadIdleRuntimes();
      await waitFor(() => fake.returnCalls === 1);
      const admin = operation === "archive"
        ? service.archiveThread(started.thread.id)
        : service.deleteThread(started.thread.id);
      stop.resolve();
      const [unloadResult, adminResult] = await Promise.allSettled([unload, admin]);

      expect(unloadResult).toMatchObject({ status: "fulfilled" });
      expect(adminResult).toMatchObject({ status: "fulfilled" });
      expect(service.loadedThreadIds()).not.toContain(started.thread.id);
      if (operation === "archive") {
        expect(store.hasThread(started.thread.id)).toBe(true);
        expect(store.isThreadArchived(started.thread.id)).toBe(true);
      } else {
        expect(store.hasThread(started.thread.id)).toBe(false);
      }
      await service.close();
    },
  );

  it("rematerializes a new runtime generation after provider return failure is absorbed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-admin-idle-return-failure-"));
    directories.push(directory);
    const first = new FakeClaudeQuery();
    first.returnError = new Error("provider return failed");
    const second = new FakeClaudeQuery();
    let generations = 0;
    const service = new ClaudeService(
      { ...config(directory), idleTimeoutSeconds: -1 },
      new SubscriptionHub(),
      new Logger("error"),
      new MemoryHybridStore(),
      (input) => (++generations === 1 ? first : second).factory(input),
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    await service.resumeThread(started.thread.id);

    await (service as unknown as { unloadIdleRuntimes(): Promise<void> }).unloadIdleRuntimes();
    expect(first.returnCalls).toBe(1);
    expect(service.loadedThreadIds()).not.toContain(started.thread.id);

    await service.resumeThread(started.thread.id);
    expect(generations).toBe(2);
    expect(second.inputs).toHaveLength(1);
    await service.close();
  });

  it("reserves admin ownership before its first await so idle unload cannot overtake it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-admin-before-idle-"));
    directories.push(directory);
    const rename = deferred();
    let renameCalls = 0;
    const store = new MemoryHybridStore();
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      { ...config(directory), idleTimeoutSeconds: -1 },
      new SubscriptionHub(),
      new Logger("error"),
      store,
      fake.factory,
      undefined,
      undefined,
      undefined,
      {
        rename: async () => {
          renameCalls += 1;
          await rename.promise;
        },
        delete: async () => undefined,
      },
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    await service.resumeThread(started.thread.id);
    const loaded = store.getThreadRecord(started.thread.id, false)!;
    store.updateThread({ ...loaded, lastClaudeMessageUuid: "provider-boundary" });
    const runtime = service as unknown as { unloadIdleRuntimes(): Promise<void> };

    const admin = service.setThreadName({ threadId: started.thread.id, name: "reserved" });
    await waitFor(() => renameCalls === 1);
    await runtime.unloadIdleRuntimes();
    expect(fake.returnCalls).toBe(0);

    rename.resolve();
    await admin;
    await runtime.unloadIdleRuntimes();
    expect(fake.returnCalls).toBe(1);
    expect(service.loadedThreadIds()).toEqual([]);
    await service.close();
  });

  it("keeps the idle-retirement barrier until both overlapping admins release their tokens", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-admin-refcount-"));
    directories.push(directory);
    const renames = [deferred(), deferred()];
    let renameCalls = 0;
    const store = new MemoryHybridStore();
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      { ...config(directory), idleTimeoutSeconds: -1 },
      new SubscriptionHub(),
      new Logger("error"),
      store,
      fake.factory,
      undefined,
      undefined,
      undefined,
      {
        rename: async () => renames[renameCalls++]!.promise,
        delete: async () => undefined,
      },
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    await service.resumeThread(started.thread.id);
    const loaded = store.getThreadRecord(started.thread.id, false)!;
    store.updateThread({ ...loaded, lastClaudeMessageUuid: "provider-boundary" });
    const serviceState = service as unknown as { unloadIdleRuntimes(): Promise<void> };

    const first = service.setThreadName({ threadId: started.thread.id, name: "first" });
    const second = service.setThreadName({ threadId: started.thread.id, name: "second" });
    await waitFor(() => renameCalls === 2);
    await serviceState.unloadIdleRuntimes();
    expect(fake.returnCalls).toBe(0);

    renames[0]!.resolve();
    await first;
    await serviceState.unloadIdleRuntimes();
    expect(fake.returnCalls).toBe(0);

    renames[1]!.resolve();
    await second;
    await serviceState.unloadIdleRuntimes();
    expect(fake.returnCalls).toBe(1);
    await service.close();
  });

  it("keeps local rows while provider delete is pending or fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-admin-delete-"));
    directories.push(directory);
    const operation = deferred();
    const effects: ClaudeThreadAdminEffects = {
      rename: async () => undefined,
      delete: () => operation.promise,
    };
    const store = new MemoryHybridStore();
    const service = new ClaudeService(
      config(directory),
      new SubscriptionHub(),
      new Logger("error"),
      store,
      new FakeClaudeQuery().factory,
      undefined,
      undefined,
      undefined,
      effects,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    const root = store.getThreadRecord(started.thread.id)!;
    seedProjectedSubtree(store, root);
    const deletion = service.deleteThread(started.thread.id);
    await expect(service.getGoal(started.thread.id)).rejects.toThrow(
      `Claude thread '${started.thread.id}' is pending delete`,
    );
    expect(service.ownsThread(started.thread.id)).toBe(true);
    operation.reject(new Error("provider delete failed"));
    await expect(deletion).rejects.toThrow("provider delete failed");
    expect(service.ownsThread(started.thread.id)).toBe(true);
    expect(service.ownsThread("projected-child")).toBe(true);
    expect(service.ownsThread("projected-grandchild")).toBe(true);
    expect(store.listPendingThreadRemovals()).toEqual([expect.objectContaining({
      rootThreadId: started.thread.id,
      kind: "delete",
    })]);
    await service.close();
  });

  it("quarantines an ambiguous Memory delete and emits each committed deletion exactly once after retry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-admin-delete-quarantine-"));
    directories.push(directory);
    let providerDeletes = 0;
    const store = new MemoryHybridStore();
    const hub = new SubscriptionHub();
    const deleted: string[] = [];
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), store, new FakeClaudeQuery().factory,
      undefined, undefined, undefined, {
        rename: async () => undefined,
        delete: async () => {
          providerDeletes += 1;
          if (providerDeletes === 1) throw new Error("provider outcome unknown");
        },
      },
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    seedProjectedSubtree(store, store.getThreadRecord(started.thread.id)!);
    for (const threadId of [started.thread.id, "projected-child", "projected-grandchild"]) {
      hub.subscribe(threadId, "desktop", (method) => {
        if (method === "thread/deleted") deleted.push(threadId);
      });
    }

    await expect(service.deleteThread(started.thread.id)).rejects.toThrow("provider outcome unknown");
    expect(deleted).toEqual([]);
    expect(service.listThreads({}).map((thread) => thread.id)).not.toContain(started.thread.id);
    for (const threadId of [started.thread.id, "projected-child"]) {
      expect(() => service.readThread(threadId, false)).toThrow(`Claude thread '${threadId}' is pending delete`);
    }
    await expect(service.resumeThread(started.thread.id)).rejects.toThrow("is pending delete");
    await expect(service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "blocked", text_elements: [] }],
    })).rejects.toThrow("is pending delete");
    await expect(service.forkThread({ threadId: started.thread.id }))
      .rejects.toThrow("is pending delete");
    await expect(service.compactThread(started.thread.id)).rejects.toThrow("is pending delete");
    expect(() => service.listItems({ threadId: started.thread.id }))
      .toThrow("is pending delete");

    await service.deleteThread(started.thread.id);
    expect(providerDeletes).toBe(2);
    expect(deleted).toEqual(["projected-grandchild", "projected-child", started.thread.id]);
    expect(store.listPendingThreadRemovals()).toEqual([]);
    await expect(service.deleteThread(started.thread.id)).rejects.toThrow("Unknown Claude thread");
    expect(deleted).toHaveLength(3);
    await service.close();
  });

  it("publishes no delete event before the atomic Memory commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-admin-delete-event-order-"));
    directories.push(directory);
    const provider = deferred();
    const store = new MemoryHybridStore();
    const hub = new SubscriptionHub();
    const deleted: string[] = [];
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), store, new FakeClaudeQuery().factory,
      undefined, undefined, undefined, {
        rename: async () => undefined,
        delete: () => provider.promise,
      },
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    seedProjectedSubtree(store, store.getThreadRecord(started.thread.id)!);
    for (const threadId of [started.thread.id, "projected-child", "projected-grandchild"]) {
      hub.subscribe(threadId, "desktop", (method) => {
        if (method === "thread/deleted") deleted.push(threadId);
      });
    }

    const deletion = service.deleteThread(started.thread.id);
    await waitFor(() => store.listPendingThreadRemovals().length === 1);
    expect(deleted).toEqual([]);
    expect(store.hasThread(started.thread.id)).toBe(true);
    provider.resolve();
    await deletion;
    expect(deleted).toEqual(["projected-grandchild", "projected-child", started.thread.id]);
    await service.close();
  });

  it("recovers a provider-deleted root and child subtree after a Memory commit fault and restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-admin-delete-memory-restart-"));
    directories.push(directory);
    const store = new DeleteCommitFailureStore();
    let providerDeletes = 0;
    const effects: ClaudeThreadAdminEffects = {
      rename: async () => undefined,
      delete: async () => {
        providerDeletes += 1;
        if (providerDeletes === 2) throw new Error("provider temporarily unavailable");
        if (providerDeletes > 2) throw new Error("provider session not found");
      },
    };
    const hub = new SubscriptionHub();
    const deleted: string[] = [];
    const first = new ClaudeService(
      config(directory), hub, new Logger("error"), store, new FakeClaudeQuery().factory,
      undefined, undefined, undefined, effects,
    );
    const started = await first.startThread({ model: "claude:sonnet", cwd: directory });
    const root = store.getThreadRecord(started.thread.id)!;
    seedProjectedSubtree(store, root);
    for (const threadId of [started.thread.id, "projected-child", "projected-grandchild"]) {
      hub.subscribe(threadId, "desktop", (method) => {
        if (method === "thread/deleted") deleted.push(threadId);
      });
    }

    await expect(first.deleteThread(started.thread.id)).rejects.toThrow("injected deletion commit failure");
    expect(providerDeletes).toBe(1);
    expect(store.listPendingThreadRemovals().map((removal) => removal.rootThreadId)).toEqual([started.thread.id]);
    expect(store.hasThread(started.thread.id)).toBe(true);
    expect(store.hasThread("projected-child")).toBe(true);
    expect(store.hasThread("projected-grandchild")).toBe(true);
    expect(deleted).toEqual([]);

    store.failDeleteCommit = false;
    const restarted = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), store, new FakeClaudeQuery().factory,
      undefined, undefined, undefined, effects,
    );
    await restarted.ready();
    expect(providerDeletes).toBe(2);
    expect(store.hasThread(started.thread.id)).toBe(true);
    expect(store.listPendingThreadRemovals().map((removal) => removal.rootThreadId)).toEqual([started.thread.id]);
    expect(() => restarted.readThread(started.thread.id, false)).toThrow("is pending delete");
    expect(restarted.listThreads({}).map((thread) => thread.id)).not.toContain(started.thread.id);

    await restarted.deleteThread(started.thread.id);
    expect(providerDeletes).toBe(3);
    expect(store.hasThread(started.thread.id)).toBe(false);
    expect(store.hasThread("projected-child")).toBe(false);
    expect(store.hasThread("projected-grandchild")).toBe(false);
    expect(store.listPendingThreadRemovals()).toEqual([]);
    await restarted.close();
    await first.close();
  });

  it("rolls back a SQLite subtree delete fault and finishes provider-delete recovery after reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-admin-delete-sqlite-restart-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    let store = new SqliteHybridStore(path);
    let providerDeletes = 0;
    const effects: ClaudeThreadAdminEffects = {
      rename: async () => undefined,
      delete: async () => {
        providerDeletes += 1;
        if (providerDeletes === 2) throw new Error("provider temporarily unavailable");
        if (providerDeletes > 2) throw new Error("provider session not found");
      },
    };
    const hub = new SubscriptionHub();
    const deleted: string[] = [];
    const first = new ClaudeService(
      config(directory), hub, new Logger("error"), store, new FakeClaudeQuery().factory,
      undefined, undefined, undefined, effects,
    );
    const started = await first.startThread({ model: "claude:sonnet", cwd: directory });
    const root = store.getThreadRecord(started.thread.id)!;
    seedProjectedSubtree(store, root);
    for (const threadId of [started.thread.id, "projected-child", "projected-grandchild"]) {
      hub.subscribe(threadId, "desktop", (method) => {
        if (method === "thread/deleted") deleted.push(threadId);
      });
    }
    const injector = new DatabaseSync(path);
    injector.exec(`
      CREATE TRIGGER fail_projected_child_delete BEFORE DELETE ON threads
      WHEN OLD.id = 'projected-child'
      BEGIN SELECT RAISE(ABORT, 'injected projected child delete failure'); END;
    `);
    injector.close();

    await expect(first.deleteThread(started.thread.id))
      .rejects.toThrow("injected projected child delete failure");
    expect(providerDeletes).toBe(1);
    expect(store.listPendingThreadRemovals().map((removal) => removal.rootThreadId)).toEqual([started.thread.id]);
    expect(store.hasThread(started.thread.id)).toBe(true);
    expect(store.hasThread("projected-child")).toBe(true);
    expect(store.hasThread("projected-grandchild")).toBe(true);
    expect(deleted).toEqual([]);
    await first.close();

    const repair = new DatabaseSync(path);
    repair.exec("DROP TRIGGER fail_projected_child_delete");
    repair.close();
    store = new SqliteHybridStore(path);
    expect(store.listPendingThreadRemovals().map((removal) => removal.rootThreadId)).toEqual([started.thread.id]);
    expect(store.hasThread(started.thread.id)).toBe(true);
    expect(store.hasThread("projected-child")).toBe(true);
    expect(store.hasThread("projected-grandchild")).toBe(true);

    const restarted = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), store, new FakeClaudeQuery().factory,
      undefined, undefined, undefined, effects,
    );
    await restarted.ready();
    expect(providerDeletes).toBe(2);
    expect(store.hasThread(started.thread.id)).toBe(true);
    expect(store.listPendingThreadRemovals().map((removal) => removal.rootThreadId)).toEqual([started.thread.id]);
    expect(() => restarted.readThread(started.thread.id, false)).toThrow("is pending delete");

    await restarted.deleteThread(started.thread.id);
    expect(providerDeletes).toBe(3);
    expect(store.hasThread(started.thread.id)).toBe(false);
    expect(store.hasThread("projected-child")).toBe(false);
    expect(store.hasThread("projected-grandchild")).toBe(false);
    expect(store.listPendingThreadRemovals()).toEqual([]);
    await restarted.close();
  });

  it("deduplicates ephemeral release and waits for it before idempotent shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-admin-disconnect-close-"));
    directories.push(directory);
    const deletion = deferred();
    let deleteCalls = 0;
    const store = new MemoryHybridStore();
    const service = new ClaudeService(
      config(directory),
      new SubscriptionHub(),
      new Logger("error"),
      store,
      new FakeClaudeQuery().factory,
      undefined,
      undefined,
      undefined,
      {
        rename: async () => undefined,
        delete: async () => {
          deleteCalls += 1;
          await deletion.promise;
        },
      },
    );
    const started = await service.startThread({
      model: "claude:sonnet",
      cwd: directory,
      ephemeral: true,
    });

    const first = service.releaseEphemeralThread(started.thread.id);
    const duplicate = service.releaseEphemeralThread(started.thread.id);
    expect(duplicate).toBe(first);
    await waitFor(() => deleteCalls === 1);
    const close = service.close();
    expect(service.close()).toBe(close);
    let closed = false;
    void close.then(() => { closed = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    deletion.resolve();
    await Promise.all([first, duplicate, close]);
    expect(deleteCalls).toBe(1);
    expect(store.hasThread(started.thread.id)).toBe(false);
  });

  it("keeps an ephemeral side task reconnectable for the one-hour disconnect grace period", async () => {
    expect(EPHEMERAL_DISCONNECT_GRACE_MS).toBe(60 * 60_000);
    const directory = mkdtempSync(join(tmpdir(), "ccodex-side-lease-"));
    directories.push(directory);
    const store = new MemoryHybridStore();
    const service = new ClaudeService(
      config(directory),
      new SubscriptionHub(),
      new Logger("error"),
      store,
      new FakeClaudeQuery().factory,
    );
    await service.ready();
    const started = await service.startThread({
      model: "claude:sonnet",
      cwd: directory,
      ephemeral: true,
    });

    service.scheduleEphemeralRelease(started.thread.id, 20);
    service.cancelEphemeralRelease(started.thread.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(service.readThread(started.thread.id, false).thread.id).toBe(started.thread.id);

    service.scheduleEphemeralRelease(started.thread.id, 10);
    await waitFor(() => {
      try {
        service.readThread(started.thread.id, false);
        return false;
      } catch {
        return true;
      }
    });
    await service.close();
  });

  it("coalesces only the same removal kind before the durable removal ledger begins", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-admin-removal-kind-race-"));
    directories.push(directory);
    const beginEntered = deferred();
    const allowBegin = deferred();
    let deleteCalls = 0;
    const store = new MemoryHybridStore();
    const service = new ClaudeService(
      config(directory),
      new SubscriptionHub(),
      new Logger("error"),
      store,
      new FakeClaudeQuery().factory,
      undefined,
      undefined,
      undefined,
      {
        rename: async () => undefined,
        delete: async () => { deleteCalls += 1; },
      },
    );
    const started = await service.startThread({
      model: "claude:sonnet",
      cwd: directory,
      ephemeral: true,
    });
    const internals = service as unknown as {
      pendingThreadRemoval(threadId: string): undefined;
      sessions: {
        submit<Result>(threadId: string, command: unknown): Promise<Result>;
      };
    };
    const originalPendingLookup = internals.pendingThreadRemoval.bind(service);
    const originalSubmit = internals.sessions.submit.bind(internals.sessions);
    internals.pendingThreadRemoval = () => undefined;
    internals.sessions.submit = async <Result>(threadId: string, command: unknown): Promise<Result> => {
      const kind = (command as { command?: { kind?: string } }).command?.kind;
      if (kind === "beginRemoval") {
        beginEntered.resolve();
        await allowBegin.promise;
      }
      return originalSubmit<Result>(threadId, command);
    };

    const deletion = service.deleteThread(started.thread.id);
    await beginEntered.promise;
    expect(store.listPendingThreadRemovals()).toEqual([]);
    const duplicateDeletion = service.deleteThread(started.thread.id);
    await expect(service.releaseEphemeralThread(started.thread.id)).rejects.toThrow(
      `Claude thread '${started.thread.id}' is pending delete`,
    );
    expect(store.listPendingThreadRemovals()).toEqual([]);

    allowBegin.resolve();
    await Promise.all([deletion, duplicateDeletion]);
    expect(deleteCalls).toBe(1);
    internals.pendingThreadRemoval = originalPendingLookup;
    internals.sessions.submit = originalSubmit;
    await service.close();
  });

  it("retains a durable Layered release intent and retries the ephemeral provider cleanup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-admin-release-retry-"));
    directories.push(directory);
    let deleteCalls = 0;
    const durable = new MemoryHybridStore();
    const service = new ClaudeService(
      config(directory),
      new SubscriptionHub(),
      new Logger("error"),
      durable,
      new FakeClaudeQuery().factory,
      undefined,
      undefined,
      undefined,
      {
        rename: async () => undefined,
        delete: async () => {
          deleteCalls += 1;
          if (deleteCalls === 1) throw new Error("release outcome unknown");
        },
      },
    );
    const started = await service.startThread({
      model: "claude:sonnet",
      cwd: directory,
      ephemeral: true,
    });

    await expect(service.releaseEphemeralThread(started.thread.id)).rejects.toThrow("release outcome unknown");
    expect(durable.listPendingThreadRemovals()).toEqual([expect.objectContaining({
      rootThreadId: started.thread.id,
      kind: "release",
    })]);
    expect(() => service.readThread(started.thread.id, false)).toThrow("is pending release");

    await service.releaseEphemeralThread(started.thread.id);
    expect(deleteCalls).toBe(2);
    expect(durable.listPendingThreadRemovals()).toEqual([]);
    expect(service.ownsThread(started.thread.id)).toBe(false);
    await service.close();
  });
});
