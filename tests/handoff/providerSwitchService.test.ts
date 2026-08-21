import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { CrossProviderForks } from "../../src/handoff/service.js";
import { LineageStore } from "../../src/handoff/lineageStore.js";
import { HandoffStore } from "../../src/handoff/store.js";

function turn(id: string, text: string): Turn {
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

function thread(id: string, provider: string, turns: Turn[] = []): Thread {
  return {
    id, extra: null, sessionId: id, forkedFromId: null, parentThreadId: null, canAcceptDirectInput: true,
    preview: "hello", ephemeral: false, isPinned: false, historyMode: "legacy", modelProvider: provider,
    createdAt: 1, updatedAt: 2, recencyAt: 2, status: { type: "idle" }, path: null,
    cwd: "/tmp/project", cliVersion: "test", source: "cli", threadSource: "user",
    agentNickname: null, agentRole: null, gitInfo: null, name: "Migrated", turns,
  };
}

describe("provider switch service", () => {
  it("drops incomplete provisional records from the app catalog", () => {
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    store.createLogicalThread({
      thread: thread("provisional-public", "claude"),
      epoch: {
        id: "epoch-provisional", provider: "claude",
        backendThreadId: "ccodex-provisional:pending-fork",
        model: "sonnet", settings: {}, createdAt: 10,
      },
    });
    const service = new CrossProviderForks(store, {} as never);
    // createLogicalThread persists only the thread identity; a stalled fork
    // leaves that stub as the only record, and serving it to the app crashes
    // the thread list ("Cannot use 'in' operator...").
    expect(service.projectThreadCatalog([], []).map((value) => value.id)).toEqual([]);
  });
  it("continues overlay pagination from a stable turn anchor after live turns are appended", async () => {
    const inheritedTurns = Array.from({ length: 20 }, (_, index) => turn(`overlay-${index + 1}`, "history"));
    const target = thread("overlay-target", "openai");
    const source = thread("overlay-source", "claude", inheritedTurns);
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    store.setOverlay({
      threadId: target.id,
      sourceThreadId: source.id,
      sourceThread: source,
      inheritedTurns,
    });
    let liveTurns: Turn[] = [];
    const stock = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/read") return { thread: { ...target, turns: liveTurns } };
        return {};
      }),
    };
    const service = new CrossProviderForks(store, {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: () => false,
    } as never);

    const first = await service.turnsOverlay({
      threadId: target.id, limit: 5, sortDirection: "desc", itemsView: "full",
    }, stock as never);
    expect(first.data.map((value) => value.id))
      .toEqual(["overlay-20", "overlay-19", "overlay-18", "overlay-17", "overlay-16"]);
    expect(first.nextCursor).toBe(JSON.stringify({ turnId: "overlay-16", includeAnchor: false }));

    liveTurns = Array.from({ length: 9 }, (_, index) => turn(`overlay-${index + 21}`, "live"));
    const second = await service.turnsOverlay({
      threadId: target.id,
      cursor: first.nextCursor,
      limit: 5,
      sortDirection: "desc",
      itemsView: "full",
    }, stock as never);
    expect(second.data.map((value) => value.id))
      .toEqual(["overlay-15", "overlay-14", "overlay-13", "overlay-12", "overlay-11"]);
    expect(new Set([...first.data, ...second.data].map((value) => value.id)).size).toBe(10);
    service.close();
  });

  it("renames the native target before revealing a provider switch", async () => {
    const source = { ...thread("rename-public", "openai", [turn("rename-source-turn", "source")]), name: "Native title" };
    const target = { ...thread("rename-claude-target", "claude"), name: null };
    const targetTurn = turn("rename-target-turn", "target");
    const order: string[] = [];
    const databasePath = join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite");
    const store = new HandoffStore(databasePath);
    const hub = new SubscriptionHub();
    const appEvents: Array<{ method: string; params: unknown }> = [];
    hub.attach("app", (method, params) => {
      appEvents.push({ method, params });
      if (method === "thread/started") order.push("reveal");
    });
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: () => false,
      startHiddenThread: vi.fn(async () => ({ thread: target })),
      updateThreadSettings: vi.fn(async () => ({})),
      prepareTurn: vi.fn(async () => ({
        response: { turn: targetTurn },
        startAndWait: vi.fn(async () => undefined),
        announce: vi.fn(async () => undefined),
      })),
      setThreadName: vi.fn(async () => { order.push("native-rename"); return {}; }),
      deleteThread: vi.fn(async () => ({})),
    };
    const stock = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/read") return { thread: source };
        if (method === "thread/resume") return {
          thread: { ...source, turns: [] }, model: "gpt-5.6-sol", modelProvider: "openai",
          cwd: source.cwd, reasoningEffort: "high",
        };
        return {};
      }),
    };
    const service = new CrossProviderForks(store, claude as never);
    service.configureSubscriptions(hub);
    (service as unknown as { providerSwitchSummary: () => Promise<string> }).providerSwitchSummary =
      vi.fn(async () => "portable summary");
    service.interceptSettings({ threadId: source.id, model: "claude:sonnet" });

    await service.switchProviderTurn({
      threadId: source.id,
      model: "claude:sonnet",
      input: [{ type: "text", text: "continue", text_elements: [] }],
    }, turn("rename-compact", ""), stock as never, "client", vi.fn());

    expect(claude.setThreadName).toHaveBeenCalledWith({ threadId: target.id, name: source.name });
    expect(order.indexOf("native-rename")).toBeLessThan(order.indexOf("reveal"));
    expect(service.logical(source.id)).toMatchObject({
      epoch: { provider: "claude", backendThreadId: target.id },
    });
    expect(appEvents).toContainEqual({
      method: "thread/name/updated",
      params: { threadId: source.id, threadName: source.name },
    });
    service.close();

  });

  it("keeps the source projection unchanged when native target rename fails", async () => {
    const source = { ...thread("rename-failure-public", "openai", [turn("rename-failure-source", "source")]), name: "Source truth" };
    const target = { ...thread("rename-failure-target", "claude"), name: null };
    const targetTurn = turn("rename-failure-turn", "target");
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    const hub = new SubscriptionHub();
    const appEvents: Array<{ method: string; params: unknown }> = [];
    hub.attach("app", (method, params) => appEvents.push({ method, params }));
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: () => false,
      startHiddenThread: vi.fn(async () => ({ thread: target })),
      updateThreadSettings: vi.fn(async () => ({})),
      prepareTurn: vi.fn(async () => ({
        response: { turn: targetTurn },
        startAndWait: vi.fn(async () => undefined),
        announce: vi.fn(async () => undefined),
      })),
      setThreadName: vi.fn(async () => { throw new Error("native rename unavailable"); }),
      deleteThread: vi.fn(async () => ({})),
    };
    const stock = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/read") return { thread: source };
        if (method === "thread/resume") return {
          thread: { ...source, turns: [] }, model: "gpt-5.6-sol", modelProvider: "openai",
          cwd: source.cwd, reasoningEffort: "high",
        };
        return {};
      }),
    };
    const service = new CrossProviderForks(store, claude as never);
    service.configureSubscriptions(hub);
    (service as unknown as { providerSwitchSummary: () => Promise<string> }).providerSwitchSummary =
      vi.fn(async () => "portable summary");
    service.interceptSettings({ threadId: source.id, model: "claude:sonnet" });

    await expect(service.switchProviderTurn({
      threadId: source.id,
      model: "claude:sonnet",
      input: [{ type: "text", text: "must not cut over", text_elements: [] }],
    }, turn("rename-failure-compact", ""), stock as never, "client", vi.fn()))
      .rejects.toThrow("native rename unavailable");

    expect(service.logical(source.id)).toMatchObject({
      epoch: { provider: "stock", backendThreadId: source.id },
    });
    expect(claude.deleteThread).toHaveBeenCalledWith(target.id);
    expect(appEvents.filter(({ method }) => method === "thread/started" || method === "thread/name/updated"))
      .toEqual([]);
    expect(store.getProviderSwitchJob("rename-failure-compact")).toMatchObject({ status: "failed" });
    service.close();
  });

  it("retries an official sealed-stock archive after restart", async () => {
    const source = thread("archive-retry-public", "openai", [turn("archive-retry-source", "source")]);
    const target = thread("archive-retry-target", "claude");
    const targetTurn = turn("archive-retry-turn", "target");
    const database = join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite");
    let store = new HandoffStore(database);
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: () => false,
      startHiddenThread: vi.fn(async () => ({ thread: target })),
      updateThreadSettings: vi.fn(async () => ({})),
      prepareTurn: vi.fn(async () => ({
        response: { turn: targetTurn },
        startAndWait: vi.fn(async () => undefined),
        announce: vi.fn(async () => undefined),
      })),
      deleteThread: vi.fn(async () => ({})),
    };
    const firstStock = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/read") return { thread: source };
        if (method === "thread/resume") return {
          thread: { ...source, turns: [] }, model: "gpt-5.6-sol", modelProvider: "openai",
          cwd: source.cwd, reasoningEffort: "high",
        };
        if (method === "thread/archive") throw new Error("stock archive temporarily unavailable");
        return {};
      }),
    };
    let service = new CrossProviderForks(store, claude as never);
    (service as unknown as { providerSwitchSummary: () => Promise<string> }).providerSwitchSummary =
      vi.fn(async () => "portable summary");
    service.interceptSettings({ threadId: source.id, model: "claude:sonnet" });

    await service.switchProviderTurn({
      threadId: source.id,
      model: "claude:sonnet",
      input: [{ type: "text", text: "continue", text_elements: [] }],
    }, turn("archive-retry-compact", ""), firstStock as never, "client", vi.fn());

    expect(firstStock.request).toHaveBeenCalledWith("thread/archive", { threadId: source.id });
    expect(store.pendingStockArchives()).toMatchObject([{ backendThreadId: source.id, archivePending: true }]);
    service.close();

    store = new HandoffStore(database);
    const retryStock = { request: vi.fn(async () => ({})) };
    service = new CrossProviderForks(store, {
      ownsModel: (model: string) => model.startsWith("claude:"),
    } as never);
    service.configureDaemonStock(retryStock as never);
    await vi.waitFor(() => expect(store.pendingStockArchives()).toEqual([]));

    expect(retryStock.request).toHaveBeenCalledTimes(1);
    expect(retryStock.request).toHaveBeenCalledWith("thread/archive", { threadId: source.id });
    expect(service.logical(source.id)?.epoch).toMatchObject({
      provider: "claude", backendThreadId: target.id,
    });
    service.close();
  });

  it("resumes a partially failed logical delete and publishes exactly one public tombstone", async () => {
    const publicThread = thread("delete-public", "openai", [turn("delete-source-turn", "source")]);
    const claudeTarget = thread("delete-claude-target", "claude");
    const database = join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite");
    const store = new HandoffStore(database);
    store.createLogicalThread({
      thread: publicThread,
      epoch: {
        id: "delete-stock-epoch", provider: "stock", backendThreadId: publicThread.id,
        model: "gpt-5.6-sol", settings: {},
      },
    });
    const pending = store.stageProviderSwitch({
      pending: {
        threadId: publicThread.id, sourceProvider: "stock", targetProvider: "claude",
        targetModel: "claude:sonnet", settings: { threadId: publicThread.id, model: "claude:sonnet" },
      },
      expectedEpochId: "delete-stock-epoch",
    })!;
    store.createProviderSwitchJob({
      id: "delete-switch", publicThreadId: publicThread.id, expectedEpochId: "delete-stock-epoch",
      pendingRevision: pending.revision!, targetProvider: "claude", targetModel: "claude:sonnet",
      settings: pending.settings,
      turnParams: { threadId: publicThread.id, input: [] },
      compactionTurn: turn("delete-compact", ""),
    });
    store.claimProviderSwitchJob("delete-switch");
    store.checkpointProviderSwitchTarget("delete-switch", {
      backendThreadId: claudeTarget.id, providerTurnId: "delete-target-turn",
    });
    expect(store.commitProviderSwitch({
      jobId: "delete-switch",
      targetEpoch: {
        id: "delete-claude-epoch", provider: "claude", backendThreadId: claudeTarget.id,
        model: "claude:sonnet", settings: {},
      },
      sourceTurns: [],
      thread: { ...claudeTarget, id: publicThread.id, sessionId: publicThread.sessionId },
    })).toBeDefined();
    store.markStockArchived("delete-stock-epoch");

    let claudeDeleteAttempt = 0;
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      deleteThread: vi.fn(async () => {
        claudeDeleteAttempt += 1;
        if (claudeDeleteAttempt === 1) throw new Error("Claude delete temporarily unavailable");
        return {};
      }),
    };
    const stock = { request: vi.fn(async () => ({})) };
    const service = new CrossProviderForks(store, claude as never);
    const hub = new SubscriptionHub();
    const deleted: Array<{ method: string; params: unknown }> = [];
    hub.attach("app", (method, params) => {
      if (method === "thread/deleted") deleted.push({ method, params });
    });
    service.configureSubscriptions(hub);

    await expect(service.requestLogical("thread/delete", {
      threadId: publicThread.id,
    }, stock as never)).rejects.toThrow("Claude delete temporarily unavailable");

    expect(service.logical(publicThread.id)).toBeDefined();
    expect(store.listBackendMappings()).toHaveLength(2);
    expect(store.listEpochs(publicThread.id)).toMatchObject([
      { backendThreadId: publicThread.id, deleteDone: true },
      { backendThreadId: claudeTarget.id, deleteDone: false },
    ]);
    expect(deleted).toEqual([]);

    await expect(service.requestLogical("thread/delete", {
      threadId: publicThread.id,
    }, stock as never)).resolves.toMatchObject({ result: {} });

    expect(stock.request).toHaveBeenCalledTimes(1);
    expect(stock.request).toHaveBeenCalledWith("thread/delete", { threadId: publicThread.id });
    expect(claude.deleteThread).toHaveBeenCalledTimes(2);
    expect(service.logical(publicThread.id)).toBeUndefined();
    expect(store.listBackendMappings()).toEqual([]);
    expect(deleted).toEqual([{
      method: "thread/deleted", params: { threadId: publicThread.id },
    }]);
    service.close();
  });

  it("creates a real Claude fork immediately when App selects the latest completed turn", async () => {
    const sourceTurn = turn("claude-source-turn", "source answer");
    const source = thread("claude-source", "claude", [sourceTurn]);
    const nativeFork = {
      ...thread("claude-native-fork", "claude", [sourceTurn]),
      forkedFromId: source.id,
    };
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    store.createLogicalThread({
      thread: source,
      epoch: {
        id: "claude-source-epoch",
        provider: "claude",
        backendThreadId: source.id,
        model: "claude:sonnet",
        settings: { effort: "high" },
      },
    });
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: (id: string) => id === source.id || id === nativeFork.id,
      readThread: vi.fn((id: string) => ({ thread: id === source.id ? source : nativeFork })),
      currentThreadSettings: vi.fn(() => ({ model: "claude:sonnet", effort: "high" })),
      forkThread: vi.fn(async () => ({ thread: nativeFork })),
      announceThread: vi.fn(async () => undefined),
      deleteThread: vi.fn(async () => ({})),
    };
    const service = new CrossProviderForks(store, claude as never);
    const stock = { request: vi.fn() };

    const forked = await service.forkLogical({ threadId: source.id }, stock as never);

    expect(claude.forkThread).toHaveBeenCalledWith({
      threadId: source.id,
      lastTurnId: sourceTurn.id,
      model: "claude:sonnet",
    }, source.id);
    expect(forked.thread.turns.map((value) => value.id)).toEqual([sourceTurn.id]);
    expect(forked.thread.sessionId).toBe(forked.thread.id);
    expect(forked.thread.sessionId).not.toBe(source.sessionId);
    expect(service.logical(forked.thread.id)?.epoch).toMatchObject({
      provider: "claude",
      backendThreadId: nativeFork.id,
    });
    expect(store.getForkSelection(forked.thread.id)).toBeUndefined();
    service.close();
  });

  it("always removes a legacy provisional fork when App archives it", async () => {
    const source = thread("legacy-source", "claude", [turn("legacy-turn", "answer")]);
    const target = { ...thread("legacy-target", "claude"), forkedFromId: source.id };
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    store.createLogicalThread({
      thread: source,
      epoch: {
        id: "legacy-source-epoch",
        provider: "claude",
        backendThreadId: source.id,
        model: "claude:sonnet",
        settings: {},
      },
    });
    store.createLogicalThread({
      thread: target,
      epoch: {
        id: "legacy-provisional-epoch",
        provider: "claude",
        backendThreadId: "ccodex-provisional:legacy",
        model: "claude:sonnet",
        settings: {},
      },
    });
    store.createForkSelection({
      targetPublicThreadId: target.id,
      sourcePublicThreadId: source.id,
      provisionalEpochId: "legacy-provisional-epoch",
    });
    const service = new CrossProviderForks(store, {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: () => false,
    } as never);

    await expect(service.requestLogical("thread/archive", {
      threadId: target.id,
    }, { request: vi.fn() } as never)).resolves.toMatchObject({ result: {} });
    expect(service.logical(target.id)).toBeUndefined();
    expect(store.getForkSelection(target.id)).toBeUndefined();
    service.close();
  });

  it("makes archive win atomically over a staged provider switch", async () => {
    const sourceTurn = turn("archive-source-turn", "answer");
    const source = thread("archive-source", "claude", [sourceTurn]);
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    store.createLogicalThread({
      thread: source,
      epoch: {
        id: "archive-source-epoch",
        provider: "claude",
        backendThreadId: source.id,
        model: "claude:sonnet",
        settings: {},
      },
    });
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: (id: string) => id === source.id,
      archiveThread: vi.fn(async () => ({})),
      currentThreadSettings: vi.fn(() => ({
        model: "claude:sonnet",
        modelProvider: "claude",
        sandboxPolicy: { type: "readOnly" },
        collaborationMode: { mode: "default", settings: {} },
      })),
    };
    const service = new CrossProviderForks(store, claude as never);
    service.interceptSettings({ threadId: source.id, model: "gpt-5.6-sol" });
    const pending = store.stageProviderSwitch({
      pending: store.getPending(source.id)!,
      expectedEpochId: "archive-source-epoch",
    })!;
    const job = store.createProviderSwitchJob({
      id: "archive-switch-job",
      publicThreadId: source.id,
      expectedEpochId: "archive-source-epoch",
      pendingRevision: pending.revision!,
      targetProvider: "stock",
      targetModel: "gpt-5.6-sol",
      settings: pending.settings,
      turnParams: {
        threadId: source.id,
        input: [{ type: "text", text: "switch", text_elements: [] }],
      },
      compactionTurn: { ...turn("archive-compact", ""), status: "inProgress" },
    })!;
    store.claimProviderSwitchJob(job.id);

    await service.requestLogical("thread/archive", {
      threadId: source.id,
    }, { request: vi.fn() } as never);

    expect(claude.archiveThread).toHaveBeenCalledWith(source.id);
    expect(store.getPending(source.id)).toBeUndefined();
    expect(store.getProviderSwitchJob(job.id)).toMatchObject({
      status: "failed",
      error: "Task archived.",
    });
    service.close();
  });

  it("unarchives a migrated stock backend before attempting to hydrate it", async () => {
    const backend = thread("stock-backend", "openai", [turn("stock-turn", "answer")]);
    const publicThread = { ...backend, id: "public-thread", sessionId: "public-thread" };
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    store.createLogicalThread({
      thread: publicThread,
      epoch: {
        id: "stock-epoch",
        provider: "stock",
        backendThreadId: backend.id,
        model: "gpt-5.4-mini",
        settings: {},
      },
    });
    let archived = false;
    const calls: string[] = [];
    const stock = {
      request: vi.fn(async (method: string) => {
        calls.push(method);
        if ((method === "thread/read" || method === "thread/resume") && archived) {
          throw new Error(`session ${backend.id} is archived`);
        }
        if (method === "thread/read") return { thread: backend };
        if (method === "thread/resume") return { thread: backend, model: "gpt-5.4-mini" };
        if (method === "thread/archive") { archived = true; return {}; }
        if (method === "thread/unarchive") { archived = false; return {}; }
        return {};
      }),
    };
    const service = new CrossProviderForks(store, {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: () => false,
    } as never);

    await service.requestLogical("thread/archive", { threadId: publicThread.id }, stock as never);
    const beforeUnarchive = calls.length;
    await expect(service.requestLogical("thread/unarchive", {
      threadId: publicThread.id,
    }, stock as never)).resolves.toMatchObject({ provider: "stock", result: {} });

    expect(calls.slice(beforeUnarchive)).toEqual(["thread/unarchive"]);
    expect(archived).toBe(false);
    service.close();
  });

  it("rolls back an established logical Claude thread with ordinary App edit semantics", async () => {
    const first = turn("claude-turn-1", "first answer");
    const second = turn("claude-turn-2", "answer being edited");
    const backend = thread("claude-backend", "claude", [first, second]);
    const publicThread = { ...backend, id: "public-thread", sessionId: "public-thread" };
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    store.createLogicalThread({
      thread: publicThread,
      epoch: {
        id: "claude-epoch",
        provider: "claude",
        backendThreadId: backend.id,
        model: "claude:sonnet",
        settings: { effort: "high" },
      },
    });
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: (id: string) => id === backend.id,
      readThread: vi.fn(() => ({ thread: backend })),
      rollbackThread: vi.fn(async () => ({ thread: { ...backend, turns: [first] } })),
    };
    const stock = { request: vi.fn() };
    const service = new CrossProviderForks(store, claude as never);

    const rolled = await service.rollbackLogicalThread({
      threadId: publicThread.id,
      numTurns: 1,
    }, stock as never);

    expect(claude.rollbackThread).toHaveBeenCalledWith({
      threadId: backend.id,
      numTurns: 1,
    });
    expect(stock.request).not.toHaveBeenCalled();
    expect(rolled.thread.id).toBe(publicThread.id);
    expect(rolled.thread.turns.map((value) => value.id)).toEqual([first.id]);
    expect(service.logical(publicThread.id)?.epoch).toMatchObject({
      id: "claude-epoch",
      backendThreadId: backend.id,
      state: "current",
    });
    expect(store.getForkSelection(publicThread.id)).toBeUndefined();
    service.close();
  });

  it("lets an explicit source-provider turn cancel a switch staged by another client", () => {
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: () => false,
    };
    const service = new CrossProviderForks(store, claude as never);
    service.interceptSettings({ threadId: "stock-thread", model: "claude:sonnet" });

    expect(service.stageTurnSwitch({
      threadId: "stock-thread",
      model: "gpt-5.6-sol",
      input: [{ type: "text", text: "stay on stock", text_elements: [] }],
    })).toBeUndefined();
    expect(service.pending("stock-thread")).toBeUndefined();
    service.close();
  });

  it("atomically switches Claude to stock, keeps the public id, and persists the epoch boundary", async () => {
    const historicalStockTurn = {
      ...turn("historical-stock-turn", "historical stock answer"),
      items: [{ ...turn("unused", "").items[0]!, id: "item-1", text: "historical stock answer" }],
    } as Turn;
    const historicalStock = thread("historical-stock", "openai", [historicalStockTurn]);
    const historicalCompact = turn("historical-compact", "");
    const sourceTurn = turn("claude-turn", "source answer");
    const source = thread("public-thread", "claude", [sourceTurn]);
    const hidden = thread("hidden-compact", "claude", [sourceTurn]);
    const target = thread("stock-target", "openai");
    const targetTurn = {
      ...turn("stock-target-turn", "new provider answer"),
      items: [{ ...turn("unused", "").items[0]!, id: "item-1", text: "new provider answer" }],
    } as Turn;
    const stockFork = {
      ...thread("stock-fork", "openai", [targetTurn]),
      forkedFromId: target.id,
    };
    const oldEpochFork = { ...thread("old-epoch-fork", "claude", [sourceTurn]), forkedFromId: source.id };
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: (id: string) => id === source.id || id === hidden.id,
      readThread: vi.fn((id: string) => ({ thread: id === hidden.id ? hidden : source })),
      handoffSource: vi.fn(async (id: string) => ({
        thread: id === hidden.id ? hidden : source,
        turns: id === hidden.id ? hidden.turns : source.turns,
        settings: {
          cwd: source.cwd, approvalPolicy: "on-request", approvalsReviewer: "user",
          sandboxPolicy: { type: "readOnly" }, activePermissionProfile: null,
          model: "claude:sonnet", modelProvider: "claude", serviceTier: "default",
          effort: "high", summary: "auto", collaborationMode: { mode: "default", settings: {} },
          multiAgentMode: "explicitRequestOnly", personality: null,
        },
      })),
      currentThreadSettings: vi.fn(() => ({
        cwd: source.cwd, approvalPolicy: "on-request", approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly" }, activePermissionProfile: null,
        model: "claude:sonnet", modelProvider: "claude", serviceTier: "default",
        effort: "high", summary: "auto", collaborationMode: { mode: "default", settings: {} },
        multiAgentMode: "explicitRequestOnly", personality: null,
      })),
      forkThread: vi.fn(async (params: { ephemeral?: boolean }) => ({
        thread: params.ephemeral ? hidden : oldEpochFork,
      })),
      compactForHandoff: vi.fn(async () => "portable native summary"),
      discardHandoffThread: vi.fn(async () => undefined),
      deleteThread: vi.fn(async () => ({})),
      announceThread: vi.fn(async () => undefined),
    };
    const requests: Array<{ method: string; params: any }> = [];
    let service!: CrossProviderForks;
    const stock = {
      request: vi.fn(async (method: string, params: any) => {
        requests.push({ method, params });
        if (method === "thread/start") {
          const startedTarget = { ...target, threadSource: params.threadSource };
          const message = { method: "thread/started", params: { thread: startedTarget } };
          expect(service.suppressStockTargetMessage("remote-client", message)).toBe(true);
          expect(service.suppressStockTargetMessage("client", message)).toBe(true);
          return {
            thread: startedTarget, model: "gpt-5.6-sol", modelProvider: "openai", serviceTier: "default",
          };
        }
        if (method === "turn/start") {
          service.suppressStockTargetMessage("client", {
            method: "turn/started", params: { threadId: target.id, turn: targetTurn },
          });
          service.suppressStockTargetMessage("client", {
            method: "item/started",
            params: {
              threadId: target.id,
              turnId: targetTurn.id,
              item: {
                type: "userMessage",
                id: "target-user",
                clientId: "client-user",
                content: input,
              },
            },
          });
          return { turn: { id: targetTurn.id } };
        }
        if (method === "thread/read" && params.threadId === target.id) {
          return { thread: { ...target, turns: [targetTurn] } };
        }
        if (method === "thread/read" && params.threadId === historicalStock.id) {
          return { thread: historicalStock };
        }
        if (method === "thread/read" && params.threadId === stockFork.id) {
          return { thread: stockFork };
        }
        if (method === "thread/resume" && params.threadId === target.id) {
          return {
            thread: { ...target, turns: [] },
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            serviceTier: "default",
            cwd: target.cwd,
            runtimeWorkspaceRoots: [],
            instructionSources: [],
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandbox: { type: "readOnly" },
            activePermissionProfile: null,
            reasoningEffort: "xhigh",
            multiAgentMode: "explicitRequestOnly",
            initialTurnsPage: null,
          };
        }
        if (method === "thread/fork" && params.threadId === target.id) {
          return {
            thread: stockFork,
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            serviceTier: "default",
          };
        }
        return {};
      }),
    };
    const providerLineagePath = join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite");
    const store = new HandoffStore(providerLineagePath);
    const lineage = new LineageStore(providerLineagePath);
    lineage.finalizeLegacyMigration(new Set());
    lineage.createTask({
      publicThreadId: source.id,
      currentEpochId: "historical-stock-epoch",
      sessionId: source.sessionId,
      createdAt: source.createdAt,
    }, {
      epochId: "historical-stock-epoch",
      provider: "stock",
      backendThreadId: historicalStock.id,
    });
    expect(lineage.commitEpoch(
      source.id,
      "historical-stock-epoch",
      1,
      { startTurnId: historicalStockTurn.id, endTurnId: historicalStockTurn.id },
      { epochId: "claude-source-epoch", provider: "claude", backendThreadId: source.id },
      [{ publicTurnId: historicalCompact.id, turn: historicalCompact }],
    )).toBeDefined();
    service = new CrossProviderForks(store, claude as never, undefined, lineage);
    const subscriptions = new SubscriptionHub();
    const projected: Array<{ method: string; params: unknown }> = [];
    subscriptions.subscribe(source.id, "app", (method, params) => projected.push({ method, params }));
    service.configureSubscriptions(subscriptions);
    service.interceptSettings({
      threadId: source.id, model: "gpt-5.6-sol", effort: "xhigh", serviceTier: "priority",
    });
    const compact = turn("migration-compact", "");
    const completed = vi.fn();
    const input = [{ type: "text" as const, text: "continue verbatim", text_elements: [] }];

    await service.switchProviderTurn({
      threadId: source.id, model: "gpt-5.6-sol", effort: "xhigh", serviceTier: "priority", input,
    }, { ...compact, status: "inProgress", completedAt: null, durationMs: null }, stock as never, "client", completed);

    expect(completed).toHaveBeenCalledOnce();
    expect(claude.compactForHandoff).toHaveBeenCalledWith(hidden.id, expect.stringContaining("/compact"));
    for (const request of requests.filter(({ method }) =>
      method === "thread/start" || method === "thread/settings/update" || method === "turn/start")) {
      expect(request.params).toMatchObject({
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        permissions: ":read-only",
      });
      expect(request.params).not.toHaveProperty("sandbox");
      expect(request.params).not.toHaveProperty("sandboxPolicy");
    }
    expect(requests).toContainEqual({
      method: "turn/start",
      params: expect.objectContaining({ threadId: target.id, input }),
    });
    expect(requests.find(({ method }) => method === "thread/start")?.params.threadSource)
      .toMatch(/^ccodexProviderSwitch:/u);
    expect(service.logical(source.id)?.epoch).toMatchObject({
      provider: "stock", backendThreadId: target.id,
    });
    expect(lineage.listSegments(source.id)).toMatchObject([
      {
        kind: "provider", epochId: "historical-stock-epoch",
        startTurnId: historicalStockTurn.id, endTurnId: historicalStockTurn.id,
      },
      { kind: "synthetic", publicTurnId: historicalCompact.id },
      { kind: "provider", epochId: expect.any(String), startTurnId: sourceTurn.id, endTurnId: sourceTurn.id },
      { kind: "synthetic", publicTurnId: compact.id },
    ]);
    expect(store.listLogicalTurns(source.id)).toEqual([]);
    expect(service.pending(source.id)).toBeUndefined();
    expect(projected).toContainEqual({
      method: "turn/started",
      params: expect.objectContaining({ threadId: source.id }),
    });
    expect(projected).toContainEqual({
      method: "thread/started",
      params: { thread: expect.objectContaining({ id: source.id, modelProvider: "openai" }) },
    });
    expect(projected.some((event) => event.method === "item/started"
      && (event.params as { item?: { type?: string } }).item?.type === "userMessage")).toBe(false);
    const read = await service.requestLogical("thread/read", {
      threadId: source.id,
      includeTurns: true,
    }, stock as never) as { result: { thread: Thread } };
    expect(read.result.thread.id).toBe(source.id);
    expect(read.result.thread.turns.map((value) => value.id))
      .toEqual([historicalStockTurn.id, historicalCompact.id, sourceTurn.id, compact.id, targetTurn.id]);
    const publicItemIds = read.result.thread.turns.flatMap((value) => value.items.map((item) => item.id));
    expect(new Set(publicItemIds).size).toBe(publicItemIds.length);
    expect(read.result.thread.turns[0]!.items[0]!.id)
      .not.toBe(read.result.thread.turns.at(-1)!.items[0]!.id);
    const liveTarget = projected.find((event) => event.method === "turn/started"
      && (event.params as { turn?: Turn }).turn?.id === targetTurn.id);
    expect((liveTarget!.params as { turn: Turn }).turn.items[0]!.id)
      .toBe(read.result.thread.turns.at(-1)!.items[0]!.id);
    const resumed = await service.requestLogical("thread/resume", {
      threadId: source.id,
      excludeTurns: true,
      initialTurnsPage: { limit: 5, sortDirection: "desc", itemsView: "full" },
    }, stock as never) as { result: { initialTurnsPage: { data: Turn[] } } };
    expect(resumed.result.initialTurnsPage.data.map((value) => value.id))
      .toEqual([targetTurn.id, compact.id, sourceTurn.id, historicalCompact.id, historicalStockTurn.id]);
    const repeatedResume = await service.requestLogical("thread/resume", {
      threadId: source.id,
      excludeTurns: true,
      initialTurnsPage: { limit: 5, sortDirection: "desc", itemsView: "full" },
    }, stock as never) as { result: { initialTurnsPage: { data: Turn[] } } };
    expect(repeatedResume.result.initialTurnsPage.data.flatMap((value) => value.items.map((item) => item.id)))
      .toEqual(resumed.result.initialTurnsPage.data.flatMap((value) => value.items.map((item) => item.id)));
    expect(service.projectThreadCatalog([target], [source])).toMatchObject([{
      id: source.id,
      modelProvider: "openai",
    }]);

    const forked = await service.forkLogical({ threadId: source.id }, stock as never);
    expect(forked.thread.turns.map((value) => value.id))
      .toEqual([historicalStockTurn.id, historicalCompact.id, sourceTurn.id, compact.id, targetTurn.id]);
    expect(service.projectThreadCatalog([], [], {
      ancestorThreadId: forked.thread.id,
      sourceKinds: ["subAgentThreadSpawn"],
    })).toEqual([]);
    const forkRead = await service.requestLogical("thread/read", {
      threadId: forked.thread.id,
      includeTurns: true,
    }, stock as never) as { result: { thread: Thread } };
    expect(forkRead.result.thread.turns.map((value) => value.id))
      .toEqual([historicalStockTurn.id, historicalCompact.id, sourceTurn.id, compact.id, targetTurn.id]);
    expect(requests.some((request) => String(request.params?.threadId).startsWith("ccodex-provisional:")))
      .toBe(false);
    const rolledBack = await service.rollbackLogicalThread({
      threadId: forked.thread.id,
      numTurns: 2,
    }, stock as never);
    expect(claude.forkThread).toHaveBeenLastCalledWith(expect.objectContaining({
      threadId: source.id,
      lastTurnId: sourceTurn.id,
      model: "claude:sonnet",
    }));
    expect(service.logical(forked.thread.id)?.epoch).toMatchObject({
      provider: "claude", backendThreadId: oldEpochFork.id,
    });
    expect(rolledBack.thread.turns.map((value) => value.id))
      .toEqual([historicalStockTurn.id, historicalCompact.id, sourceTurn.id]);
    service.close();

    const database = new DatabaseSync(providerLineagePath);
    expect(database.prepare("SELECT COUNT(*) AS count FROM logical_threads").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM provider_epochs").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM provider_switch_jobs_v2").get()).toEqual({ count: 0 });
    database.close();

    const reopenedStore = new HandoffStore(providerLineagePath);
    const reopenedLineage = new LineageStore(providerLineagePath);
    const reopened = new CrossProviderForks(reopenedStore, claude as never, undefined, reopenedLineage);
    const afterRestart = await reopened.requestLogical("thread/read", {
      threadId: source.id,
      includeTurns: true,
    }, stock as never) as { result: { thread: Thread } };
    expect(afterRestart.result.thread.turns.map((value) => value.id))
      .toEqual([historicalStockTurn.id, historicalCompact.id, sourceTurn.id, compact.id, targetTurn.id]);
    reopened.close();
  });

  it("switches stock to Claude and commits only after starting the untouched input", async () => {
    const sourceTurn = turn("stock-source-turn", "stock answer");
    const source = { ...thread("stock-public", "openai", [sourceTurn]), isPinned: true };
    const target = thread("claude-target", "claude");
    const targetTurn = turn("claude-target-turn", "claude answer");
    const order: string[] = [];
    const hub = new SubscriptionHub();
    const appEvents: Array<{ method: string; params: unknown }> = [];
    const sink = (method: string, params: unknown) => appEvents.push({ method, params });
    hub.attach("app", sink);
    hub.subscribe(source.id, "app", sink);
    const prepared = {
      response: { turn: targetTurn },
      announce: vi.fn(async () => {
        order.push("announce");
        hub.emit(target.id, "turn/started", { threadId: target.id, turn: targetTurn });
      }),
      start: vi.fn(() => { order.push("start"); }),
      startAndWait: vi.fn(async () => {
        order.push("start");
        hub.emit(target.id, "thread/status/changed", {
          threadId: target.id, status: { type: "active" },
        });
      }),
    };
    let service!: CrossProviderForks;
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: () => false,
      startHiddenThread: vi.fn(async (_params: unknown) => {
        hub.suppress(target.id);
        hub.emit(target.id, "thread/started", { thread: target });
        expect(service.projectThreadCatalog([], [target])).toEqual([]);
        return { thread: target, model: "claude:sonnet" };
      }),
      updateThreadSettings: vi.fn(async (_params: unknown) => {
        hub.emit(target.id, "thread/settings/updated", {
          threadId: target.id, threadSettings: { model: "claude:sonnet" },
        });
        return {};
      }),
      prepareTurn: vi.fn(async (_params: unknown) => prepared),
      readThread: vi.fn((id: string) => ({ thread: id === target.id ? target : source })),
      currentThreadSettings: vi.fn(() => ({ model: "claude:sonnet", effort: "high" })),
      deleteThread: vi.fn(async () => ({})),
    };
    const stock = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/read") return { thread: source };
        if (method === "thread/resume") return {
          thread: { ...source, turns: [] }, model: "gpt-5.6-sol", modelProvider: "openai",
          serviceTier: "default", cwd: source.cwd, approvalPolicy: "never",
          approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" },
          activePermissionProfile: { id: ":danger-full-access", extends: null },
          reasoningEffort: "high", multiAgentMode: "explicitRequestOnly",
          runtimeWorkspaceRoots: [source.cwd, "/tmp/extra"], instructionSources: [], initialTurnsPage: null,
        };
        return {};
      }),
    };
    const providerLineagePath = join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite");
    const store = new HandoffStore(providerLineagePath);
    const lineage = new LineageStore(providerLineagePath);
    lineage.finalizeLegacyMigration(new Set());
    service = new CrossProviderForks(store, claude as never, undefined, lineage);
    service.configureSubscriptions(hub);
    (service as unknown as { providerSwitchSummary: () => Promise<string> }).providerSwitchSummary =
      vi.fn(async () => "stock compact summary");
    service.interceptSettings({ threadId: source.id, model: "claude:sonnet", effort: "high" });
    const compact = { ...turn("stock-compact", ""), status: "inProgress" as const, completedAt: null, durationMs: null };
    const input = [{ type: "text" as const, text: "send exactly once", text_elements: [] }];
    const completed = vi.fn(() => { order.push("compact-completed"); });

    await service.switchProviderTurn({
      threadId: source.id, model: "claude:sonnet", effort: "high", input,
    }, compact, stock as never, "client", completed);

    const explicitFullAccess = {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      permissions: ":danger-full-access",
    };
    expect(claude.startHiddenThread).toHaveBeenCalledWith(expect.objectContaining(explicitFullAccess));
    expect(claude.startHiddenThread).toHaveBeenCalledWith(expect.objectContaining({
      cwd: source.cwd,
      runtimeWorkspaceRoots: [source.cwd, "/tmp/extra"],
    }));
    expect(claude.updateThreadSettings).toHaveBeenCalledWith(expect.objectContaining(explicitFullAccess));
    expect(claude.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: target.id,
      input,
      ...explicitFullAccess,
    }));
    expect(claude.startHiddenThread.mock.calls[0]?.[0]).not.toHaveProperty("sandbox");
    expect(claude.updateThreadSettings.mock.calls[0]?.[0]).not.toHaveProperty("sandboxPolicy");
    expect(claude.prepareTurn.mock.calls[0]?.[0]).not.toHaveProperty("sandboxPolicy");
    expect(order).toEqual(["start", "compact-completed", "announce"]);
    const serializedEvents = JSON.stringify(appEvents);
    expect(serializedEvents).not.toContain(`"threadId":"${target.id}"`);
    expect(serializedEvents).not.toContain(`"id":"${target.id}"`);
    expect(appEvents).toContainEqual({
      method: "turn/started",
      params: expect.objectContaining({ threadId: source.id }),
    });
    expect(service.projectThreadCatalog([], [{ ...target, turns: [targetTurn] }])).toMatchObject([{
      id: source.id, isPinned: true,
    }]);
    expect(service.logical(source.id)?.epoch).toMatchObject({
      provider: "claude", backendThreadId: target.id,
    });
    expect(lineage.listSegments(source.id)).toMatchObject([
      { kind: "provider", startTurnId: sourceTurn.id, endTurnId: sourceTurn.id },
      { kind: "synthetic", publicTurnId: compact.id },
    ]);
    expect(store.listLogicalTurns(source.id)).toEqual([]);
    service.close();

    const database = new DatabaseSync(providerLineagePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM logical_threads").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM provider_epochs").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM provider_switch_jobs_v2").get()).toEqual({ count: 0 });
    database.close();
  });

  it("explicitly forwards and retains permissions when App omits them on later logical turns", async () => {
    const backend = thread("logical-claude-backend", "claude");
    const publicThread = { ...backend, id: "logical-public", sessionId: "logical-public" };
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    store.createLogicalThread({
      thread: publicThread,
      epoch: {
        id: "logical-claude-epoch",
        provider: "claude",
        backendThreadId: backend.id,
        model: "claude:sonnet",
        settings: {
          approvalPolicy: "never",
          approvalsReviewer: "user",
          permissions: ":danger-full-access",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      },
    });
    const prepared = {
      response: { turn: turn("logical-turn", "answer") },
      announce: vi.fn(async () => undefined),
      start: vi.fn(),
    };
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: (id: string) => id === backend.id,
      readThread: vi.fn(() => ({ thread: backend })),
      currentThreadSettings: vi.fn(() => ({
        model: "claude:sonnet",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: ":danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      })),
      prepareTurn: vi.fn(async (_params: unknown) => prepared),
    };
    const service = new CrossProviderForks(store, claude as never);

    await service.requestLogical("turn/start", {
      threadId: publicThread.id,
      input: [{ type: "text", text: "continue", text_elements: [] }],
    }, { request: vi.fn() } as never);

    expect(claude.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: backend.id,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      permissions: ":danger-full-access",
    }));
    expect(claude.prepareTurn.mock.calls[0]?.[0]).not.toHaveProperty("sandboxPolicy");
    service.close();
  });

  it("publishes one ready logical stock fork without waiting for rollback", async () => {
    const sourceTurn = turn("stock-source-turn", "stock answer");
    const source = thread("stock-source", "openai", [sourceTurn]);
    const nativeFork = {
      ...thread("native-stock-fork", "openai", [sourceTurn]),
      forkedFromId: source.id,
    };
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    store.createLogicalThread({
      thread: source,
      epoch: {
        id: "stock-epoch",
        provider: "stock",
        backendThreadId: source.id,
        model: "gpt-5.6-sol",
        settings: { effort: "medium" },
      },
    });
    const hub = new SubscriptionHub();
    const started: string[] = [];
    hub.attach("app", (method, params) => {
      if (method === "thread/started") started.push((params as { thread: Thread }).thread.id);
    });
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: () => false,
    };
    const service = new CrossProviderForks(store, claude as never);
    service.configureSubscriptions(hub);
    const stock = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/read") return { thread: source };
        if (method === "thread/fork") {
          const message = { method: "thread/started", params: { thread: nativeFork } };
            if (!service.suppressStockTargetMessage("client", message)
              && !service.ownsStockBackendMessage(message)) {
            hub.emit(nativeFork.id, message.method, message.params);
          }
          return {
            thread: nativeFork,
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            serviceTier: "default",
          };
        }
        return {};
      }),
    };

    const forked = await service.forkLogical({ threadId: source.id }, stock as never, "client");
    expect(started).toEqual([forked.thread.id]);
    await service.rollbackLogicalThread({
      threadId: forked.thread.id,
      numTurns: 0,
    }, stock as never, "client");
    const lateStarted = { method: "thread/started", params: { thread: nativeFork } };
    expect(service.suppressStockTargetMessage("client", lateStarted)).toBe(true);

    expect(started).toEqual([forked.thread.id]);
    expect(service.logical(forked.thread.id)?.epoch).toMatchObject({
      provider: "stock",
      backendThreadId: nativeFork.id,
    });
    service.close();
  });

  it("falls back to an ephemeral handoff summary when native Claude compaction rejects a short thread", async () => {
    const sourceTurn = turn("short-turn", "one short answer");
    const source = thread("short-public", "claude", [sourceTurn]);
    const hidden = thread("short-hidden", "claude", [sourceTurn]);
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: (id: string) => id === source.id || id === hidden.id,
      readThread: vi.fn((id: string) => ({ thread: id === hidden.id ? hidden : source })),
      handoffSource: vi.fn(async () => ({
        thread: source,
        turns: source.turns,
        settings: {
          model: "claude:sonnet", sandboxPolicy: { type: "readOnly" },
          collaborationMode: { mode: "default", settings: {} },
        },
      })),
      currentThreadSettings: vi.fn(() => ({
        model: "claude:sonnet", sandboxPolicy: { type: "readOnly" },
        collaborationMode: { mode: "default", settings: {} },
      })),
      forkThread: vi.fn(async () => ({ thread: hidden })),
      compactForHandoff: vi.fn(async () => {
        throw new Error("Not enough messages to compact.");
      }),
      summarizeHandoff: vi.fn(async () => "short portable summary"),
      discardHandoffThread: vi.fn(async () => undefined),
      deleteThread: vi.fn(async () => ({})),
    };
    const target = thread("short-stock-target", "openai");
    const targetTurn = turn("short-stock-turn", "stock answer");
    let service!: CrossProviderForks;
    const stock = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") return { thread: target };
        if (method === "turn/start") return { turn: { id: targetTurn.id } };
        return {};
      }),
    };
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    service = new CrossProviderForks(store, claude as never);
    service.interceptSettings({ threadId: source.id, model: "gpt-5.6-sol" });

    await service.switchProviderTurn({
      threadId: source.id,
      model: "gpt-5.6-sol",
      input: [{ type: "text", text: "continue", text_elements: [] }],
    }, {
      ...turn("short-compact", ""), status: "inProgress", completedAt: null, durationMs: null,
    }, stock as never, "client", vi.fn());

    expect(claude.summarizeHandoff).toHaveBeenCalledWith(
      source.id,
      expect.stringContaining("one short answer"),
    );
    expect(claude.discardHandoffThread).toHaveBeenCalledWith(hidden.id);
    expect(service.logical(source.id)?.epoch).toMatchObject({
      provider: "stock", backendThreadId: target.id,
    });
    service.close();
  });

  it("commits an already-delivered target turn after gateway restart without sending it twice", async () => {
    const sourceTurn = turn("source-turn", "source answer");
    const source = thread("public-recovery", "openai", [sourceTurn]);
    const targetTurn = turn("delivered-turn", "target answer");
    const target = thread("claude-recovery", "claude", [targetTurn]);
    const database = join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite");
    let store = new HandoffStore(database);
    store.createLogicalThread({
      thread: source,
      epoch: {
        id: "source-epoch", provider: "stock", backendThreadId: source.id,
        model: "gpt-5.6-sol", settings: { effort: "high" },
      },
    });
    const pending = store.stageProviderSwitch({
      pending: {
        threadId: source.id, sourceProvider: "stock", targetProvider: "claude",
        targetModel: "claude:sonnet", settings: { threadId: source.id, model: "claude:sonnet" },
      },
      expectedEpochId: "source-epoch",
    })!;
    store.createProviderSwitchJob({
      id: "recovery-job", publicThreadId: source.id, expectedEpochId: "source-epoch",
      pendingRevision: pending.revision!, targetProvider: "claude", targetModel: "claude:sonnet",
      settings: pending.settings,
      turnParams: {
        threadId: source.id,
        input: [{ type: "text", text: "deliver once", text_elements: [] }],
      },
      compactionTurn: turn("recovery-compact", ""),
    });
    store.claimProviderSwitchJob("recovery-job");
    store.checkpointProviderSwitchTarget("recovery-job", {
      backendThreadId: target.id, summary: "persisted compact summary",
      providerTurnId: targetTurn.id,
    });
    store.close();

    store = new HandoffStore(database);
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: (id: string) => id === target.id,
      readThread: vi.fn(() => ({ thread: target })),
      deleteThread: vi.fn(async () => ({})),
      startHiddenThread: vi.fn(),
      prepareTurn: vi.fn(),
    };
    const stock = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/read") return { thread: source };
        if (method === "thread/resume") return {
          thread: { ...source, turns: [] }, model: "gpt-5.6-sol", modelProvider: "openai",
          cwd: source.cwd, reasoningEffort: "high",
        };
        return {};
      }),
    };
    const service = new CrossProviderForks(store, claude as never);
    const hub = new SubscriptionHub();
    const appEvents: Array<{ method: string; params: unknown }> = [];
    const sink = (method: string, params: unknown) => appEvents.push({ method, params });
    hub.attach("app", sink);
    hub.subscribe(source.id, "app", sink);
    service.configureSubscriptions(hub);
    expect(hub.isSuppressed(target.id)).toBe(true);
    hub.emit(target.id, "thread/status/changed", {
      threadId: target.id, status: { type: "active" },
    });
    expect(appEvents).toEqual([]);
    expect(service.projectThreadCatalog([source], [target])).toMatchObject([{ id: source.id }]);
    service.configureDaemonStock(stock as never);
    await service.drain();

    hub.emit(target.id, "turn/started", {
      threadId: target.id, turn: targetTurn,
    });

    expect(store.getProviderSwitchJob("recovery-job")?.status).toBe("committed");
    expect(service.logical(source.id)?.epoch).toMatchObject({
      provider: "claude", backendThreadId: target.id,
    });
    expect(claude.startHiddenThread).not.toHaveBeenCalled();
    expect(claude.prepareTurn).not.toHaveBeenCalled();
    expect(stock.request).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(appEvents).toContainEqual({
      method: "turn/started",
      params: expect.objectContaining({ threadId: source.id }),
    });
    expect(JSON.stringify(appEvents)).not.toContain(`"threadId":"${target.id}"`);
    service.close();
  });

  it("keeps a failed Claude target hidden when cleanup cannot delete it", async () => {
    const source = thread("failed-public", "openai", [turn("source-turn", "source")]);
    const target = thread("failed-claude-target", "claude");
    const hub = new SubscriptionHub();
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: () => false,
      startHiddenThread: vi.fn(async () => {
        hub.suppress(target.id);
        return { thread: target };
      }),
      updateThreadSettings: vi.fn(async () => { throw new Error("target unavailable"); }),
      deleteThread: vi.fn(async () => { throw new Error("cleanup unavailable"); }),
    };
    const stock = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/read") return { thread: source };
        if (method === "thread/resume") return {
          thread: { ...source, turns: [] }, model: "gpt-5.6-sol", modelProvider: "openai",
          cwd: source.cwd, reasoningEffort: "high",
        };
        return {};
      }),
    };
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    const service = new CrossProviderForks(store, claude as never);
    service.configureSubscriptions(hub);
    (service as unknown as { providerSwitchSummary: () => Promise<string> }).providerSwitchSummary =
      vi.fn(async () => "portable summary");
    service.interceptSettings({ threadId: source.id, model: "claude:sonnet" });

    await expect(service.switchProviderTurn({
      threadId: source.id,
      model: "claude:sonnet",
      input: [{ type: "text", text: "must remain unsent", text_elements: [] }],
    }, turn("failed-compact", ""), stock as never, "client", vi.fn())).rejects.toThrow("target unavailable");

    expect(service.logical(source.id)?.epoch).toMatchObject({
      provider: "stock", backendThreadId: source.id,
    });
    expect(service.pending(source.id)).toBeUndefined();
    expect(store.getProviderSwitchJob("failed-compact")).toMatchObject({
      status: "failed", targetBackendThreadId: target.id,
    });
    expect(claude.deleteThread).toHaveBeenCalledOnce();
    expect(hub.isSuppressed(target.id)).toBe(true);
    expect(service.projectThreadCatalog([source], [target])).toMatchObject([{ id: source.id }]);
    expect(stock.request).not.toHaveBeenCalledWith("turn/start", expect.anything());
    service.close();
  });

  it("round-trips stock approval request ids through a logical thread alias", async () => {
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    store.createLogicalThread({
      thread: thread("public-approval", "openai"),
      epoch: {
        id: "stock-approval-epoch", provider: "stock", backendThreadId: "stock-approval-backend",
        model: "gpt-5.6-sol", settings: {},
      },
    });
    const service = new CrossProviderForks(store, {
      ownsModel: (model: string) => model.startsWith("claude:"),
    } as never);
    const hub = new SubscriptionHub();
    const requests: Array<{ id: string; params: unknown }> = [];
    const notifications: unknown[] = [];
    hub.subscribe(
      "public-approval",
      "app",
      (method, params) => { if (method === "serverRequest/resolved") notifications.push(params); },
      (id, _method, params) => requests.push({ id, params }),
    );
    service.configureSubscriptions(hub);
    const stock = { request: vi.fn(), respond: vi.fn(async () => undefined) };
    service.configureDaemonStock(stock as never);

    expect(service.projectStockMessage({
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "stock-approval-backend", turnId: "stock-turn" },
    })).toBe(true);
    expect(requests).toEqual([{
      id: expect.stringMatching(/^logical-stock:/),
      params: expect.objectContaining({ threadId: "public-approval" }),
    }]);
    await expect(service.resolveStockServerRequest(requests[0]!.id, { decision: "accept" })).resolves.toBe(true);
    expect(stock.respond).toHaveBeenCalledWith(42, { decision: "accept" });

    expect(service.projectStockMessage({
      method: "serverRequest/resolved",
      params: { threadId: "stock-approval-backend", requestId: 42 },
    })).toBe(true);
    expect(notifications).toEqual([expect.objectContaining({
      threadId: "public-approval",
      requestId: requests[0]!.id,
    })]);
    service.close();
  });
});
