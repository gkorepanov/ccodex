import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { CrossProviderForks } from "../../src/handoff/service.js";
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
    id, extra: null, sessionId: id, forkedFromId: null, parentThreadId: null,
    preview: "hello", ephemeral: false, historyMode: "legacy", modelProvider: provider,
    createdAt: 1, updatedAt: 2, recencyAt: 2, status: { type: "idle" }, path: null,
    cwd: "/tmp/project", cliVersion: "test", source: "cli", threadSource: "user",
    agentNickname: null, agentRole: null, gitInfo: null, name: "Migrated", turns,
  };
}

describe("provider switch service", () => {
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
    const sourceTurn = turn("claude-turn", "source answer");
    const source = thread("public-thread", "claude", [sourceTurn]);
    const hidden = thread("hidden-compact", "claude", [sourceTurn]);
    const target = thread("stock-target", "openai");
    const targetTurn = turn("stock-target-turn", "new provider answer");
    const oldEpochFork = { ...thread("old-epoch-fork", "claude", [sourceTurn]), forkedFromId: source.id };
    const claude = {
      ownsModel: (model: string) => model.startsWith("claude:"),
      ownsThread: (id: string) => id === source.id || id === hidden.id,
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
          service.suppressStockTargetMessage("client", {
            method: "thread/started", params: { thread: target },
          });
          return {
            thread: target, model: "gpt-5.6-sol", modelProvider: "openai", serviceTier: "default",
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
        return {};
      }),
    };
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    service = new CrossProviderForks(store, claude as never);
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
    expect(requests).toContainEqual({
      method: "turn/start",
      params: expect.objectContaining({ threadId: target.id, input }),
    });
    expect(service.logical(source.id)?.epoch).toMatchObject({
      provider: "stock", backendThreadId: target.id, model: "gpt-5.6-sol",
    });
    expect(store.listLogicalTurns(source.id).map((value) => [value.publicTurnId, value.kind]))
      .toEqual([[sourceTurn.id, "provider"], [compact.id, "migrationCompact"]]);
    expect(service.pending(source.id)).toBeUndefined();
    expect(projected).toContainEqual({
      method: "turn/started",
      params: expect.objectContaining({ threadId: source.id }),
    });
    expect(projected.some((event) => event.method === "thread/started")).toBe(false);
    expect(projected.some((event) => event.method === "item/started"
      && (event.params as { item?: { type?: string } }).item?.type === "userMessage")).toBe(false);
    const read = await service.requestLogical("thread/read", {
      threadId: source.id,
      includeTurns: true,
    }, stock as never) as { result: { thread: Thread } };
    expect(read.result.thread.id).toBe(source.id);
    expect(read.result.thread.turns.map((value) => value.id))
      .toEqual([sourceTurn.id, compact.id, targetTurn.id]);
    const resumed = await service.requestLogical("thread/resume", {
      threadId: source.id,
      excludeTurns: true,
      initialTurnsPage: { limit: 5, sortDirection: "desc", itemsView: "full" },
    }, stock as never) as { result: { initialTurnsPage: { data: Turn[] } } };
    expect(resumed.result.initialTurnsPage.data.map((value) => value.id))
      .toEqual([targetTurn.id, compact.id, sourceTurn.id]);
    expect(service.projectThreadCatalog([target], [source])).toMatchObject([{
      id: source.id,
      modelProvider: "openai",
    }]);

    const forked = await service.forkLogical({ threadId: source.id }, stock as never);
    expect(forked.thread.turns.map((value) => value.id))
      .toEqual([sourceTurn.id, compact.id, targetTurn.id]);
    expect(service.projectThreadCatalog([], [], {
      ancestorThreadId: forked.thread.id,
      sourceKinds: ["subAgentThreadSpawn"],
    })).toEqual([]);
    const provisional = await service.requestLogical("thread/read", {
      threadId: forked.thread.id,
      includeTurns: true,
    }, stock as never) as { result: { thread: Thread } };
    expect(provisional.result.thread.turns.map((value) => value.id))
      .toEqual([sourceTurn.id, compact.id, targetTurn.id]);
    expect(requests.some((request) => String(request.params?.threadId).startsWith("ccodex-provisional:")))
      .toBe(false);
    const rolledBack = await service.rollbackLogicalFork({
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
    expect(rolledBack.thread.turns.map((value) => value.id)).toEqual([sourceTurn.id]);
    service.close();
  });

  it("switches stock to Claude and commits only after starting the untouched input", async () => {
    const sourceTurn = turn("stock-source-turn", "stock answer");
    const source = thread("stock-public", "openai", [sourceTurn]);
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
      startHiddenThread: vi.fn(async () => {
        hub.suppress(target.id);
        hub.emit(target.id, "thread/started", { thread: target });
        expect(service.projectThreadCatalog([], [target])).toEqual([]);
        return { thread: target, model: "claude:sonnet" };
      }),
      updateThreadSettings: vi.fn(async () => {
        hub.emit(target.id, "thread/settings/updated", {
          threadId: target.id, threadSettings: { model: "claude:sonnet" },
        });
        return {};
      }),
      prepareTurn: vi.fn(async () => prepared),
      deleteThread: vi.fn(async () => ({})),
    };
    const stock = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/read") return { thread: source };
        if (method === "thread/resume") return {
          thread: { ...source, turns: [] }, model: "gpt-5.6-sol", modelProvider: "openai",
          serviceTier: "default", cwd: source.cwd, approvalPolicy: "on-request",
          approvalsReviewer: "user", sandbox: { type: "readOnly" }, activePermissionProfile: null,
          reasoningEffort: "high", multiAgentMode: "explicitRequestOnly",
          runtimeWorkspaceRoots: [], instructionSources: [], initialTurnsPage: null,
        };
        return {};
      }),
    };
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-switch-")), "handoffs.sqlite"));
    service = new CrossProviderForks(store, claude as never);
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

    expect(claude.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: target.id, input }));
    expect(order).toEqual(["start", "compact-completed", "announce"]);
    const serializedEvents = JSON.stringify(appEvents);
    expect(serializedEvents).not.toContain(`"threadId":"${target.id}"`);
    expect(serializedEvents).not.toContain(`"id":"${target.id}"`);
    expect(appEvents).toContainEqual({
      method: "turn/started",
      params: expect.objectContaining({ threadId: source.id }),
    });
    expect(service.projectThreadCatalog([], [{ ...target, turns: [targetTurn] }])).toMatchObject([{
      id: source.id,
    }]);
    expect(service.logical(source.id)?.epoch).toMatchObject({
      provider: "claude", backendThreadId: target.id, model: "claude:sonnet",
    });
    expect(store.listLogicalTurns(source.id).map((value) => value.publicTurnId))
      .toEqual([sourceTurn.id, compact.id]);
    service.close();
  });

  it("publishes one logical thread when rollback materializes an old stock epoch", async () => {
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
          if (!service.suppressStockTargetMessage("observer", message)
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

    const provisional = await service.forkLogical({ threadId: source.id }, stock as never);
    started.length = 0;
    await service.rollbackLogicalFork({
      threadId: provisional.thread.id,
      numTurns: 0,
    }, stock as never, "client");
    const lateStarted = { method: "thread/started", params: { thread: nativeFork } };
    expect(service.suppressStockTargetMessage("client", lateStarted)).toBe(true);

    expect(started).toEqual([provisional.thread.id]);
    expect(service.logical(provisional.thread.id)?.epoch).toMatchObject({
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
