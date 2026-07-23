import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  attachClientConnection,
  type ClientConnectionHandle,
} from "../../src/gateway/clientConnection.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { MetricsRegistry } from "../../src/observability/metrics.js";
import {
  mapClaudeUsage,
  unavailableClaudeRateLimits,
  type ClaudeRateLimitTransition,
  type ClaudeRateLimitsResponse,
} from "../../src/claude/rateLimits.js";
import { DEFAULT_FEATURES, type FeatureConfig } from "../../src/config/config.js";
import { STOCK_SIDE_THREAD_SOURCE, StockSideThreads } from "../../src/gateway/stockSideThreads.js";
import { Logger } from "../../src/observability/logger.js";
import { CursorCodec } from "../../src/protocol/cursor.js";
import { OptimisticSideThreads } from "../../src/gateway/optimisticSideThreads.js";

const claudeSnapshot: ClaudeRateLimitsResponse = mapClaudeUsage({
  session: {
    total_cost_usd: 0,
    total_api_duration_ms: 0,
    total_duration_ms: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    model_usage: {},
  },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 23, resets_at: "2027-01-15T08:00:00Z" },
    seven_day: { utilization: 45, resets_at: "2027-01-16T11:46:40Z" },
    model_scoped: [{
      display_name: "Fable",
      utilization: 31,
      resets_at: "2027-01-17T15:33:20Z",
    }],
  },
});

const stockSnapshot = {
  rateLimits: {
    limitId: "codex", limitName: null,
    primary: { usedPercent: 11, windowDurationMins: 10_080, resetsAt: 1_900_000_000 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null, planType: "pro", rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
};

function stockThread(id: string) {
  return {
    id, extra: null, sessionId: id, forkedFromId: null, parentThreadId: null,
    preview: "hello", ephemeral: false, historyMode: "paginated", modelProvider: "openai",
    createdAt: 1_700_000_000, updatedAt: 1_700_000_100, recencyAt: 1_700_000_100,
    status: { type: "idle" }, path: null, cwd: "/tmp", cliVersion: "0.144.4",
    source: "appServer", threadSource: "user", agentNickname: null, agentRole: null,
    gitInfo: null, name: null,
    turns: [{
      id: "stock-turn", itemsView: "full", status: "completed", error: null,
      startedAt: 1_700_000_010, completedAt: 1_700_000_020, durationMs: 10_000,
      items: [
        {
          type: "userMessage", id: "stock-user", clientId: null,
          content: [{ type: "text", text: "hello", text_elements: [] }],
        },
        {
          type: "agentMessage", id: "stock-agent", text: "hi",
          phase: "final_answer", memoryCitation: null,
        },
      ],
    }],
  };
}

function sideSnapshot(sourceId: string, targetId: string, provider: "claude" | "stock") {
  return {
    thread: {
      ...stockThread(targetId),
      sessionId: sourceId,
      forkedFromId: sourceId,
      ephemeral: true,
      modelProvider: provider === "claude" ? "claude" : "openai",
      threadSource: "user",
      path: null,
      name: "Side",
      turns: [],
    },
    model: provider === "claude" ? "claude:sonnet" : "gpt-5.6-terra",
    modelProvider: provider === "claude" ? "claude" : "openai",
    serviceTier: null,
    cwd: "/tmp",
    runtimeWorkspaceRoots: ["/tmp"],
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly" },
    activePermissionProfile: null,
    reasoningEffort: "high",
    multiAgentMode: "explicitRequestOnly",
  };
}

class FakeClient extends EventEmitter {
  public readyState: number = WebSocket.OPEN;
  public readonly sent: unknown[] = [];
  public readonly rawSent: string[] = [];
  public send(data: unknown): void {
    this.rawSent.push(String(data));
    this.sent.push(JSON.parse(String(data)));
  }
  public close(): void { this.readyState = WebSocket.CLOSED; }
  public request(id: string, method: string, params?: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })), false);
  }
}

interface Harness {
  readonly client: FakeClient;
  readonly stockClients: Set<WebSocket>;
  readonly stockRequests: Array<{ method: string; id: string; params?: unknown }>;
  readonly claude: ReturnType<typeof fakeClaude>;
  readonly logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  readonly connection: ClientConnectionHandle;
  readonly subscriptions: SubscriptionHub;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];
afterEach(async () => Promise.all(harnesses.splice(0).map((harness) => harness.close())));

function fakeClaude() {
  const threads = new Set<string>();
  const listeners = new Map<string, (
    response: ClaudeRateLimitsResponse,
    transition?: ClaudeRateLimitTransition,
  ) => void>();
  const settings = new Map<string, {
    model: string; serviceTier: string | null; effort: string | null;
  }>();
  let sequence = 0;
  return {
    threads, settings,
    listeners,
    readRateLimits: vi.fn(async (_threadId?: string) => claudeSnapshot),
    readRateLimitStatus: vi.fn(async (_threadId?: string) => ({
      rateLimits: claudeSnapshot,
      unavailableReason: null,
    })),
    cachedRateLimits: vi.fn(() => claudeSnapshot),
    subscribeRateLimits: vi.fn((id: string, listener: (
      response: ClaudeRateLimitsResponse,
      transition?: ClaudeRateLimitTransition,
    ) => void) => listeners.set(id, listener)),
    unsubscribeRateLimits: vi.fn((id: string) => listeners.delete(id)),
    ownsModel: (model: string) => model.startsWith("claude:"),
    ownsThread: (threadId: string) => threads.has(threadId),
    listThreads: vi.fn(() => []),
    loadedThreadIds: vi.fn(() => []),
    isChildProjection: () => false,
    startThread: vi.fn(async (params: {
      model?: string; serviceTier?: string | null; effort?: string | null;
    }) => {
      const id = `claude-${++sequence}`;
      threads.add(id);
      settings.set(id, {
        model: params.model ?? "claude:sonnet",
        serviceTier: params.serviceTier ?? "default",
        effort: params.effort ?? "low",
      });
      return {
        thread: { id },
        model: settings.get(id)!.model,
        modelProvider: "claude",
        serviceTier: settings.get(id)!.serviceTier,
        reasoningEffort: settings.get(id)!.effort,
      };
    }),
    prepareResume: vi.fn(async (params: { threadId: string }) => ({
      response: { thread: { id: params.threadId } },
      notifyGoalSnapshot: vi.fn(),
    })),
    forkThread: vi.fn(async (params: { threadId: string; ephemeral?: boolean; threadSource?: string }, visible?: string) => {
      const id = `claude-${++sequence}`;
      threads.add(id);
      return {
        thread: {
          ...stockThread(id),
          forkedFromId: visible ?? params.threadId,
          ephemeral: params.ephemeral ?? false,
          modelProvider: "claude",
          threadSource: params.threadSource ?? "user",
        },
      };
    }),
    rollbackThread: vi.fn(async () => ({})),
    compactThread: vi.fn(async () => ({})),
    injectItems: vi.fn(async () => ({})),
    getGoal: vi.fn(async () => ({ goal: null })),
    currentThreadSettings: vi.fn((threadId: string) => settings.get(threadId)),
    updateThreadSettings: vi.fn(async (params: {
      threadId: string; model?: string | null; serviceTier?: string | null; effort?: string | null;
    }) => {
      const before = settings.get(params.threadId)!;
      settings.set(params.threadId, {
        model: params.model ?? before.model,
        serviceTier: params.serviceTier === undefined ? before.serviceTier : params.serviceTier,
        effort: params.effort === undefined ? before.effort : params.effort,
      });
      return {};
    }),
    prepareTurn: vi.fn(async (params: { threadId: string }) => ({
      response: { turn: { id: `turn-${params.threadId}` } },
      announce: vi.fn(),
      start: vi.fn(),
    })),
    prepareStatusTurn: vi.fn((params: { threadId: string }) => ({
      response: { turn: { id: `status-${params.threadId}` } },
      announce: vi.fn(),
      start: vi.fn(),
    })),
    prepareStateTurn: vi.fn((params: { threadId: string }) => ({
      response: { turn: { id: `state-${params.threadId}` } },
      announce: vi.fn(),
      start: vi.fn(),
    })),
    preparePromptedCompact: vi.fn((threadId: string) => ({
      response: {
        turn: {
          id: `compact-${threadId}`,
          items: [{ type: "contextCompaction", id: `compact-item-${threadId}` }],
          status: "inProgress",
        },
      },
      announce: vi.fn(),
    })),
    steerTurn: vi.fn(async (params: { expectedTurnId: string }) => ({ turnId: params.expectedTurnId })),
    stateSnapshot: vi.fn((threadId: string) => ({
      provider: "claude", model: "Claude Sonnet 4.6", effort: "high", serviceTier: "default",
      approvalPolicy: "on-request", approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      thread: stockThread(threadId), tokenUsage: null, providerCostUsd: 0,
    })),
    deleteThread: vi.fn(async (threadId: string) => { threads.delete(threadId); return {}; }),
    releaseEphemeralThread: vi.fn(async () => undefined),
    scheduleEphemeralRelease: vi.fn(),
    cancelEphemeralRelease: vi.fn(),
    reportError: vi.fn(async () => false),
    announceThread: vi.fn(),
    eventHighWatermark: () => 0,
    latestTokenUsage: () => undefined,
    eventsAfter: () => [],
    replayPendingRequests: vi.fn(),
  };
}

async function makeHarness(
  sharedClaude = fakeClaude(),
  overlayThreadId?: string,
  crossProviderTarget?: "claude" | "codex",
  features: FeatureConfig = DEFAULT_FEATURES,
  handoffsOverride: Record<string, unknown> = {},
  availability?: {
    read(provider: "claude" | "codex"): Promise<{ provider: "claude" | "codex"; state: string; action?: string }>;
    refresh(provider: "claude" | "codex"): Promise<{ provider: "claude" | "codex"; state: string; action?: string }>;
    refreshAll(): Promise<Record<"claude" | "codex", { provider: "claude" | "codex"; state: string; action?: string }>>;
  },
  stockForkResult: unknown | ((params: Record<string, any>) => unknown | Promise<unknown>) = { thread: { id: "stock-fork" } },
  sideThreads?: StockSideThreads,
  optimisticSides?: OptimisticSideThreads,
  sharedSubscriptions?: SubscriptionHub,
): Promise<Harness> {
  const socket = join(tmpdir(), `ccodex-rate-${randomUUID()}.sock`);
  const server: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const stockClients = new Set<WebSocket>();
  const stockRequests: Array<{ method: string; id: string; params?: unknown }> = [];
  server.on("upgrade", (request, connection, head) => wss.handleUpgrade(request, connection, head, (ws) => {
    stockClients.add(ws);
    ws.on("close", () => stockClients.delete(ws));
    ws.on("message", (data) => {
      const request = JSON.parse(String(data)) as { method: string; id: string; params?: unknown };
      stockRequests.push(request);
      if (request.method === "account/rateLimits/read") ws.send(JSON.stringify({ id: request.id, result: stockSnapshot }));
      else if (request.method === "thread/start") ws.send(JSON.stringify({ id: request.id, result: { thread: { id: "stock-thread" } } }));
      else if (request.method === "thread/list") ws.send(JSON.stringify({
        id: request.id,
        result: { data: [], nextCursor: null, backwardsCursor: null },
      }));
      else if (request.method === "thread/resume") {
        const threadId = (request.params as any).threadId;
        ws.send(JSON.stringify({
          id: request.id,
          result: threadId === "captured-stock-fork-source" ? {
            thread: stockThread(threadId),
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            serviceTier: "default",
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            sandbox: {
              type: "workspaceWrite", writableRoots: ["/tmp"], networkAccess: false,
              excludeTmpdirEnvVar: false, excludeSlashTmp: false,
            },
            reasoningEffort: "medium",
          } : threadId === "stock-state" ? {
            thread: stockThread(threadId),
            model: "gpt-5.6-sol",
            serviceTier: "priority",
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            sandbox: {
              type: "workspaceWrite", writableRoots: ["/tmp"], networkAccess: false,
              excludeTmpdirEnvVar: false, excludeSlashTmp: false,
            },
            reasoningEffort: "xhigh",
          } : { thread: { id: threadId } },
        }));
        if (threadId === "stock-state") ws.send(JSON.stringify({
          method: "thread/tokenUsage/updated",
          params: {
            threadId, turnId: "stock-turn",
            tokenUsage: {
              total: {
                totalTokens: 412_000, inputTokens: 312_000, cachedInputTokens: 277_680,
                outputTokens: 100_000, reasoningOutputTokens: 20_000,
              },
              last: {
                totalTokens: 68_000, inputTokens: 60_000, cachedInputTokens: 50_000,
                outputTokens: 8_000, reasoningOutputTokens: 1_000,
              },
              modelContextWindow: 200_000,
            },
          },
        }));
      }
      else if (request.method === "thread/fork") {
        const result = typeof stockForkResult === "function"
          ? stockForkResult(request.params as Record<string, any>)
          : stockForkResult;
        void Promise.resolve(result).then((resolved) => ws.send(JSON.stringify({
          id: request.id,
          result: resolved,
        })));
      }
      else if (request.method === "thread/read") ws.send(JSON.stringify({
        id: request.id,
        result: { thread: stockThread((request.params as any).threadId) },
      }));
      else ws.send(JSON.stringify({ id: request.id, result: {} }));
    });
  }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  const client = new FakeClient();
  const subscriptions = sharedSubscriptions ?? new SubscriptionHub();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const systemEphemeralThreads = new Set<string>();
  const noHandoffs = {
    observeDurableThread() {}, observeDurableTurn() {}, interceptSettings: () => ({ handled: false }),
    blockedTurnTarget: () => undefined,
    isSystemEphemeralFork: () => false, shouldFork: () => crossProviderTarget !== undefined,
    fork: async () => {
      const id = crossProviderTarget === "claude" ? "claude-cross-fork" : "stock-cross-fork";
      if (crossProviderTarget === "claude") sharedClaude.threads.add(id);
      return { thread: { id } };
    },
    forkDurable: async () => {
      const id = crossProviderTarget === "claude" ? "claude-cross-fork" : "stock-cross-fork";
      if (crossProviderTarget === "claude") sharedClaude.threads.add(id);
      return { thread: { id } };
    },
    claimFailedFork: () => undefined,
    ownsSystemEphemeral: (_connectionId: string, threadId: string) => systemEphemeralThreads.has(threadId),
    registerForwardedEphemeralCandidate: (_connectionId: string, threadId: string) => systemEphemeralThreads.add(threadId),
    pending: () => undefined, overlay: (threadId: string) => threadId === overlayThreadId ? { threadId } : undefined,
    projectThreadCatalog: (stock: unknown[], claudeThreads: unknown[]) => [...stock, ...claudeThreads],
    projectLoadedThreadIds: (stock: string[], claudeThreads: string[]) => [...stock, ...claudeThreads],
    sideSnapshot: () => undefined,
    resumeOverlay: async (params: { threadId: string }) => ({ thread: { id: params.threadId } }),
    clearThread() {}, prepareTitleTurn: (_id: string, params: unknown) => params,
    rewriteTitleMessages: () => undefined, suppressStockTargetMessage: () => false, ownsInternalStockThread: () => false,
    captureInternalStockMessage: () => false, recordInternalStockMessage() {},
    detachConnection: async () => undefined,
    ...handoffsOverride,
  };
  const connection = attachClientConnection(
    client as never,
    socket,
    {} as never,
    sharedClaude as never,
    noHandoffs as never,
    subscriptions,
    logger as never,
    new CursorCodec(Buffer.alloc(32, 7)),
    new MetricsRegistry(),
    {
      connection: vi.fn(),
      frame: vi.fn((_connectionId: string, _direction: string, data: unknown) => {
        if (data === undefined) throw new TypeError("RPC recorder received an undefined frame");
      }),
    } as never,
    undefined,
    features,
    availability as never,
    undefined,
    sideThreads,
    optimisticSides,
  );
  while (stockClients.size === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  const harness: Harness = {
    client, stockClients, stockRequests, claude: sharedClaude, logger, connection, subscriptions,
    async close() {
      client.emit("close", 1000, Buffer.from("done"));
      await connection.closed.catch(() => undefined);
      for (const ws of stockClients) ws.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      wss.close();
      await unlink(socket).catch(() => undefined);
      sideThreads?.close();
      optimisticSides?.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function messages(harness: Harness, method: string): any[] {
  return harness.client.sent.filter((value: any) => value.method === method || (value.id === method));
}

function availability(
  codexState: "ready" | "notAuthenticated" | "notInstalled",
) {
  const claude = { provider: "claude" as const, state: "ready" as const };
  const codex = {
    provider: "codex" as const,
    state: codexState,
    ...(codexState === "ready" ? {} : {
      action: codexState === "notInstalled" ? "npm i -g @openai/codex" : "codex login",
    }),
  };
  return {
    read: vi.fn(async (provider: "claude" | "codex") => provider === "claude" ? claude : codex),
    refresh: vi.fn(async (provider: "claude" | "codex") => provider === "claude" ? claude : codex),
    refreshAll: vi.fn(async () => ({ claude, codex })),
  };
}

describe("provider-aware rate-limit gateway routing", () => {
  it("shows one branded notice when a Claude task switches Standard to Fast", async () => {
    const harness = await makeHarness();
    harness.client.request("start-fast-task", "thread/start", {
      model: "claude:claude-opus-4-8", serviceTier: "default", effort: "high",
    });
    await settle();
    const threadId = "claude-1";
    const beforeFast = harness.client.sent.length;
    harness.client.request("enable-fast", "thread/settings/update", {
      threadId, model: "claude:claude-opus-4-8", serviceTier: "fast", effort: "high",
    });
    await settle();

    expect(messages(harness, "enable-fast")[0]).toEqual({ id: "enable-fast", result: {} });
    expect(harness.claude.settings.get(threadId)).toEqual({
      model: "claude:claude-opus-4-8", serviceTier: "fast", effort: "high",
    });
    const notices = (harness.client.sent.slice(beforeFast) as any[]).filter((message) =>
      message.method === "item/agentMessage/delta"
      && String(message.params?.delta).includes("Fast mode is on"));
    expect(notices).toEqual([expect.objectContaining({
      params: expect.objectContaining({
        threadId,
        delta: "◆ **CCodex** │ Fast mode is on — usage limits may be consumed faster.",
      }),
    })]);

    harness.client.request("fast-turn", "turn/start", {
      threadId, model: null, serviceTier: "priority", effort: "high",
      input: [{ type: "text", text: "Reply exactly OK", text_elements: [] }],
    });
    await settle();
    expect(harness.claude.prepareTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      threadId, serviceTier: "priority", effort: "high",
    }));

    const beforeStandard = harness.client.sent.length;
    harness.client.request("disable-fast", "thread/settings/update", {
      threadId, model: "claude:claude-opus-4-8", serviceTier: "default", effort: "high",
    });
    await settle();
    expect((harness.client.sent.slice(beforeStandard) as any[]).some((message) =>
      String(message.params?.delta).includes("Model changed"))).toBe(false);
    expect(harness.claude.settings.get(threadId)).toEqual({
      model: "claude:claude-opus-4-8", serviceTier: "default", effort: "high",
    });
  });

  it("shows one branded downgrade notice and continues an unsupported Fast turn", async () => {
    const harness = await makeHarness();
    harness.client.request("start-fable", "thread/start", {
      model: "claude:claude-fable-5", serviceTier: null, effort: "xhigh",
    });
    await settle();
    const threadId = "claude-1";
    const beforeTurn = harness.client.sent.length;
    harness.client.request("fable-fast-turn", "turn/start", {
      threadId, model: "claude:claude-fable-5", serviceTier: "priority", effort: "xhigh",
      input: [{ type: "text", text: "Reply exactly OK", text_elements: [] }],
    });
    await settle();

    expect(messages(harness, "fable-fast-turn")[0]).toMatchObject({
      result: { turn: { id: `turn-${threadId}` } },
    });
    expect(harness.claude.prepareTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      threadId, model: "claude:claude-fable-5", serviceTier: "priority", effort: "xhigh",
    }));
    const notices = (harness.client.sent.slice(beforeTurn) as any[]).filter((message) =>
      message.method === "item/agentMessage/delta"
      && String(message.params?.delta).includes("Fast was requested"));
    expect(notices).toEqual([expect.objectContaining({
      params: expect.objectContaining({
        threadId,
        delta: "◆ **CCodex** │ Fast was requested, but Fable does not support it — continuing in Standard.",
      }),
    })]);
  });

  it("keeps captured stock source settings when App forks with omitted settings", async () => {
    const leakedGlobalDefaults = (params: Record<string, any>) => ({
      thread: stockThread("captured-stock-fork-target"),
      model: params.model ?? "claude:claude-opus-4-8",
      modelProvider: "openai",
      serviceTier: params.serviceTier ?? null,
      reasoningEffort: params.config?.model_reasoning_effort ?? "low",
    });
    const harness = await makeHarness(
      fakeClaude(), undefined, undefined, DEFAULT_FEATURES, {}, undefined, leakedGlobalDefaults,
    );
    harness.client.request("resume-source", "thread/resume", {
      threadId: "captured-stock-fork-source",
      model: null,
      modelProvider: null,
      serviceTier: null,
      excludeTurns: true,
    });
    await settle();
    expect(messages(harness, "resume-source")[0]).toMatchObject({
      result: {
        model: "gpt-5.6-sol", modelProvider: "openai",
        serviceTier: "default", reasoningEffort: "medium",
      },
    });

    harness.client.request("fork-source", "thread/fork", {
      threadId: "captured-stock-fork-source",
      path: null,
      cwd: "/tmp",
      threadSource: "user",
    });
    await settle();
    expect(messages(harness, "fork-source")[0]).toMatchObject({
      result: {
        thread: { id: "captured-stock-fork-target" },
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        serviceTier: "default",
        reasoningEffort: "medium",
      },
    });
    expect(harness.stockRequests.find((request) => request.id === "fork-source")?.params).toMatchObject({
      model: "gpt-5.6-sol",
      serviceTier: "default",
      config: { model_reasoning_effort: "medium" },
    });
  });

  it("returns Claude quota after successful Claude foreground start and suppresses late stock updates", async () => {
    const harness = await makeHarness();
    harness.client.request("start", "thread/start", { model: "claude:sonnet" });
    await settle();
    expect(messages(harness, "start")[0]).toMatchObject({ result: { thread: { id: "claude-1" } } });
    expect(harness.client.sent.findIndex((message: any) => message.id === "start")).toBeLessThan(
      harness.client.sent.findIndex((message: any) => message.method === "account/rateLimits/updated"),
    );
    expect(messages(harness, "account/rateLimits/updated").map((message) => message.params.rateLimits.limitId)).toEqual([
      "claude-model-fable",
      "claude",
    ]);
    expect(messages(harness, "account/rateLimits/updated").at(-1)).toMatchObject({
      params: { rateLimits: { limitId: "claude", limitName: "Claude", primary: { usedPercent: 23 } } },
    });

    harness.client.request("limits", "account/rateLimits/read");
    await settle();
    expect(messages(harness, "limits")[0]).toMatchObject({ result: { rateLimits: { limitId: "claude" } } });
    expect(harness.stockRequests.filter((request) => request.method === "account/rateLimits/read")).toHaveLength(0);
    harness.client.request("usage", "account/usage/read");
    await settle();
    expect(messages(harness, "usage")[0]).toEqual({
      id: "usage",
      result: {
        summary: {
          lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null,
          currentStreakDays: null, longestStreakDays: null,
        },
        dailyUsageBuckets: null,
      },
    });
    expect(harness.stockRequests.some((request) => request.method === "account/usage/read")).toBe(false);

    const before = harness.client.sent.length;
    for (const ws of harness.stockClients) ws.send(JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: stockSnapshot.rateLimits } }));
    await settle();
    const late = harness.client.sent.slice(before) as any[];
    expect(late.some((message) =>
      message.params?.rateLimits?.limitId === "codex" && message.params?.rateLimits?.limitName === null)).toBe(false);
    expect(late.some((message) => message.params?.rateLimits?.limitId === "claude")).toBe(true);
    expect(late.at(-1)).toMatchObject({
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: "claude", limitName: "Claude" } },
    });
  });

  it("shows a normalized transient Claude limit notice only for a foreground Claude thread", async () => {
    const claude = fakeClaude();
    const background = await makeHarness(claude);
    for (const listener of claude.listeners.values()) {
      listener(claudeSnapshot, {
        bucket: "claude:primary",
        status: "allowed_warning",
        resetsAt: 1_785_034_800,
      });
    }
    expect(messages(background, "item/agentMessage/delta")).toEqual([]);

    background.client.request("start", "thread/start", { model: "claude:sonnet" });
    await settle();
    const before = messages(background, "item/agentMessage/delta").length;
    for (const listener of claude.listeners.values()) {
      listener(claudeSnapshot, {
        bucket: "claude:primary",
        status: "allowed_warning",
        resetsAt: 1_785_034_800,
      });
    }
    background.subscriptions.emit("claude-1", "turn/started", {
      threadId: "claude-1",
      turn: { id: "active-warning-turn" },
    });
    await settle();
    expect(messages(background, "item/agentMessage/delta").slice(before)).toMatchObject([{
      params: {
        threadId: "claude-1",
        turnId: "active-warning-turn",
        delta: "◆ **CCodex** │ ⚠️ Claude usage is nearing its limit\n  ↳ resets 2026-07-26 03:00 UTC",
      },
    }]);
  });

  it("shows a rejected Claude limit as a transient error without completing the active turn", async () => {
    const claude = fakeClaude();
    const harness = await makeHarness(claude);
    harness.client.request("start", "thread/start", { model: "claude:sonnet" });
    await settle();
    harness.client.request("turn", "turn/start", {
      threadId: "claude-1",
      input: [{ type: "text", text: "keep working", text_elements: [] }],
    });
    await settle();
    harness.subscriptions.emit("claude-1", "turn/started", {
      threadId: "claude-1",
      turn: { id: "active-rejected-turn" },
    });
    await settle();
    const completedBefore = messages(harness, "turn/completed").length;
    const deltasBefore = messages(harness, "item/agentMessage/delta").length;

    for (const listener of claude.listeners.values()) {
      listener(claudeSnapshot, {
        bucket: "claude:primary",
        status: "rejected",
        resetsAt: 1_785_034_800,
      });
    }

    expect(messages(harness, "item/agentMessage/delta").slice(deltasBefore)).toMatchObject([{
      params: {
        threadId: "claude-1",
        turnId: "active-rejected-turn",
        delta: "◆ **CCodex** │ ❌ Claude rate limit reached\n  ↳ resets 2026-07-26 03:00 UTC",
      },
    }]);
    expect(messages(harness, "turn/completed")).toHaveLength(completedBefore);
    expect(claude.prepareTurn).toHaveBeenCalledTimes(1);
  });

  it("publishes explicit unavailable state without fabricating a Codex alias", async () => {
    const claude = fakeClaude();
    const unavailable = unavailableClaudeRateLimits();
    claude.readRateLimits.mockResolvedValue(unavailable);
    claude.cachedRateLimits.mockReturnValue(unavailable);
    const harness = await makeHarness(claude);

    harness.client.request("stock", "thread/start", { model: "gpt-5.6-sol" });
    await settle();
    expect(messages(harness, "account/rateLimits/updated").at(-1)).toMatchObject({
      params: { rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 11 } } },
    });

    const beforeClaude = harness.client.sent.length;
    harness.client.request("claude", "thread/start", { model: "claude:sonnet" });
    await settle();
    const switched = harness.client.sent.slice(beforeClaude) as any[];
    expect(switched.findIndex((message) => message.id === "claude")).toBeLessThan(
      switched.findIndex((message) => message.method === "account/rateLimits/updated"),
    );
    expect(switched.filter((message) => message.method === "account/rateLimits/updated")).toEqual([{
      method: "account/rateLimits/updated",
      params: { rateLimits: unavailable.rateLimits },
    }]);

    const beforeStockPush = harness.client.sent.length;
    for (const ws of harness.stockClients) {
      ws.send(JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: stockSnapshot.rateLimits } }));
    }
    await settle();
    expect((harness.client.sent.slice(beforeStockPush) as any[])
      .filter((message) => message.method === "account/rateLimits/updated")).toEqual([{
      method: "account/rateLimits/updated",
      params: { rateLimits: unavailable.rateLimits },
    }]);
  });

  it("preserves stock response and notification bytes in Codex context and switches immediately", async () => {
    const harness = await makeHarness();
    harness.client.request("start", "thread/start", { model: "gpt-5.6-sol" });
    await settle();
    expect(messages(harness, "start")[0]).toEqual({ id: "start", result: { thread: { id: "stock-thread" } } });
    expect(harness.client.rawSent).toContain(JSON.stringify({ id: "start", result: { thread: { id: "stock-thread" } } }));
    expect(messages(harness, "account/rateLimits/updated").at(-1)).toEqual({
      method: "account/rateLimits/updated", params: { rateLimits: stockSnapshot.rateLimits },
    });
    harness.client.request("limits", "account/rateLimits/read");
    await settle();
    expect(messages(harness, "limits")[0]).toEqual({ id: "limits", result: stockSnapshot });
    for (const ws of harness.stockClients) ws.send(JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: stockSnapshot.rateLimits } }));
    await settle();
    expect(messages(harness, "account/rateLimits/updated").at(-1)).toEqual({
      method: "account/rateLimits/updated", params: { rateLimits: stockSnapshot.rateLimits },
    });
    expect(harness.client.rawSent.at(-1)).toBe(JSON.stringify({
      method: "account/rateLimits/updated", params: { rateLimits: stockSnapshot.rateLimits },
    }));
  });

  it("suppresses every internal stock compact event before generic error rendering", async () => {
    const captured: unknown[] = [];
    const harness = await makeHarness(fakeClaude(), undefined, undefined, DEFAULT_FEATURES, {
      captureInternalStockMessage: (_connectionId: string, message: { params?: unknown }) => {
        const params = message.params && typeof message.params === "object"
          ? message.params as { threadId?: unknown; thread?: { id?: unknown } }
          : undefined;
        const threadId = typeof params?.threadId === "string" ? params.threadId : params?.thread?.id;
        if (threadId !== "internal-compact") return false;
        captured.push(message);
        return true;
      },
    });
    const before = harness.client.sent.length;
    const sequence = [
      { method: "thread/started", params: { thread: { id: "internal-compact" } } },
      {
        method: "error",
        params: {
          threadId: "internal-compact", turnId: "compact-turn",
          error: { message: "Reconnecting... 2/5" }, willRetry: true,
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "internal-compact", turnId: "compact-turn",
          item: { type: "agentMessage", id: "summary", text: "compact handoff" },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "internal-compact",
          turn: { id: "compact-turn", status: "completed", items: [] },
        },
      },
    ];
    for (const message of sequence) {
      for (const ws of harness.stockClients) ws.send(JSON.stringify(message));
    }
    await settle();

    expect(captured).toEqual(sequence);
    expect(harness.client.sent.slice(before)).toEqual([]);
  });

  it("does not let sidebar reads steal foreground context and clears it on unsubscribe/delete", async () => {
    const harness = await makeHarness();
    harness.client.request("start", "thread/start", { model: "claude:sonnet" });
    await settle();
    harness.client.request("sidebar", "thread/read", { threadId: "stock-sidebar", includeTurns: false });
    await settle();
    harness.client.request("limits-1", "account/rateLimits/read");
    await settle();
    expect(messages(harness, "limits-1")[0]).toMatchObject({ result: { rateLimits: { limitId: "claude" } } });

    harness.client.request("unsubscribe", "thread/unsubscribe", { threadId: "claude-1" });
    await settle();
    harness.client.request("limits-2", "account/rateLimits/read");
    await settle();
    expect(messages(harness, "limits-2")[0]).toEqual({ id: "limits-2", result: stockSnapshot });

    harness.client.request("start-2", "thread/start", { model: "claude:sonnet" });
    await settle();
    harness.client.request("delete", "thread/delete", { threadId: "claude-2" });
    await settle();
    harness.client.request("limits-3", "account/rateLimits/read");
    await settle();
    expect(messages(harness, "limits-3")[0]).toEqual({ id: "limits-3", result: stockSnapshot });
  });

  it("keeps two App connections on different providers isolated", async () => {
    const claude = fakeClaude();
    const desktop = await makeHarness(claude);
    const mobile = await makeHarness(claude);
    desktop.client.request("d-start", "thread/start", { model: "claude:sonnet" });
    mobile.client.request("m-start", "thread/start", { model: "gpt-5.6-sol" });
    await settle();
    desktop.client.request("d-limits", "account/rateLimits/read");
    mobile.client.request("m-limits", "account/rateLimits/read");
    await settle();
    expect(messages(desktop, "d-limits")[0]).toMatchObject({ result: { rateLimits: { limitId: "claude" } } });
    expect(messages(mobile, "m-limits")[0]).toMatchObject({ result: { rateLimits: { limitId: "codex" } } });
    for (const listener of claude.listeners.values()) listener(claudeSnapshot);
    await settle();
    expect(messages(desktop, "account/rateLimits/updated").at(-1)).toMatchObject({
      params: { rateLimits: { limitId: "claude", limitName: "Claude" } },
    });
    expect(messages(mobile, "account/rateLimits/updated").at(-1)).toMatchObject({ params: { rateLimits: { limitId: "codex" } } });
  });

  it("restores Claude attribution on a new App connection after resume without a turn", async () => {
    const claude = fakeClaude();
    claude.threads.add("claude-resumed");
    const reconnected = await makeHarness(claude);
    reconnected.client.request("resume", "thread/resume", { threadId: "claude-resumed" });
    await settle();
    const responseIndex = reconnected.client.sent.findIndex((message: any) => message.id === "resume");
    const statusIndex = reconnected.client.sent.findIndex((message: any) => message.method === "account/rateLimits/updated");
    expect(responseIndex).toBeGreaterThanOrEqual(0);
    expect(statusIndex).toBeGreaterThan(responseIndex);
    reconnected.client.request("limits", "account/rateLimits/read");
    await settle();
    expect(messages(reconnected, "limits")[0]).toMatchObject({ result: { rateLimits: { limitId: "claude" } } });
    expect(claude.readRateLimits).toHaveBeenCalledWith("claude-resumed");
    expect(claude.prepareTurn).not.toHaveBeenCalled();
  });

  it("updates attribution for successful Claude turns and intercepted stock overlay resumes", async () => {
    const claude = fakeClaude();
    claude.threads.add("claude-existing");
    const harness = await makeHarness(claude, "stock-overlay");
    harness.client.request("turn", "turn/start", { threadId: "claude-existing", input: [] });
    await settle();
    harness.client.request("claude-limits", "account/rateLimits/read");
    await settle();
    expect(messages(harness, "claude-limits")[0]).toMatchObject({ result: { rateLimits: { limitId: "claude" } } });

    harness.client.request("resume-overlay", "thread/resume", { threadId: "stock-overlay" });
    await settle();
    harness.client.request("stock-limits", "account/rateLimits/read");
    await settle();
    expect(messages(harness, "stock-limits")[0]).toEqual({ id: "stock-limits", result: stockSnapshot });
  });

  it("intercepts exact CCodex status commands on both providers without a model turn", async () => {
    const claude = fakeClaude();
    claude.threads.add("claude-existing");
    const harness = await makeHarness(claude);

    harness.client.request("status", "turn/start", {
      threadId: "claude-existing",
      input: [{ type: "text", text: "  CCODEX STATUS ", text_elements: [] }],
    });
    await settle();
    expect(messages(harness, "status")[0]).toMatchObject({ result: { turn: { id: "status-claude-existing" } } });
    expect(claude.prepareStatusTurn).toHaveBeenCalledOnce();
    expect(claude.prepareTurn).not.toHaveBeenCalled();

    harness.client.request("normal", "turn/start", {
      threadId: "claude-existing",
      input: [{ type: "text", text: "Can you explain CCodex status?", text_elements: [] }],
    });
    await settle();
    expect(claude.prepareTurn).toHaveBeenCalledOnce();
    expect(claude.prepareStatusTurn).toHaveBeenCalledOnce();

    harness.client.request("stock-status", "turn/start", {
      threadId: "stock-existing",
      clientUserMessageId: "stock-status-user",
      input: [{ type: "text", text: "/ccstatus", text_elements: [] }],
    });
    await settle();
    expect(messages(harness, "stock-status")[0]).toMatchObject({
      result: {
        turn: {
          status: "inProgress",
          items: [{ type: "userMessage", clientId: "stock-status-user" }],
        },
      },
    });
    expect(harness.stockRequests.some((request) =>
      request.id === "stock-status" && request.method === "turn/start")).toBe(false);
    const completed = messages(harness, "turn/completed").at(-1);
    expect(completed).toMatchObject({
      params: {
        threadId: "stock-existing",
        turn: {
          status: "completed",
          items: [
            { type: "userMessage" },
            { type: "agentMessage", text: expect.stringContaining("❋ **Claude** · ✅ ready") },
          ],
        },
      },
    });
    expect((completed.params.turn.items[1] as { text: string }).text)
      .toContain("֎ **Codex** · ✅ ready");
    expect(claude.prepareStatusTurn).toHaveBeenCalledOnce();
  });

  it("renders /ccstate from observed stock protocol state without starting a model turn", async () => {
    const harness = await makeHarness();
    harness.client.request("resume-state", "thread/resume", { threadId: "stock-state" });
    await settle();
    harness.client.request("state", "turn/start", {
      threadId: "stock-state",
      clientUserMessageId: "state-user",
      input: [{ type: "text", text: "/ccstate", text_elements: [] }],
    });
    await settle();

    expect(messages(harness, "state")[0]).toMatchObject({
      result: {
        turn: {
          status: "inProgress",
          items: [{ type: "userMessage", clientId: "state-user" }],
        },
      },
    });
    expect(harness.stockRequests.some((request) =>
      request.id === "state" && request.method === "turn/start")).toBe(false);
    expect(harness.stockRequests.some((request) =>
      request.method === "thread/read"
      && (request.params as { threadId?: string })?.threadId === "stock-state")).toBe(true);
    const text = messages(harness, "turn/completed").at(-1).params.turn.items.at(-1).text as string;
    expect(text).toContain("◆ **CCodex** │ /ccstate");
    expect(text).toContain("֎ **Codex 5.6 Sol** · xhigh · ⚡ fast");
    expect(text).toContain("context   ▸ ▰▰▰▱▱▱▱▱▱▱ 34% · 68k/200k");
    expect(text).toContain("messages  ▸ 1 user / 1 assistant / 2 total");
    expect(text).toContain("mode      ▸ ᗢ approve for me");
    expect(text).toContain("cost      ▸ unavailable for subscription");
  });

  it("turns Claude-only `/compact <prompt>` into native compaction lifecycle", async () => {
    const claude = fakeClaude();
    claude.threads.add("claude-existing");
    const harness = await makeHarness(claude);

    harness.client.request("prompted-compact", "turn/start", {
      threadId: "claude-existing",
      clientUserMessageId: "compact-user",
      input: [{
        type: "text",
        text: "/compact запомни только первое сообщение\n",
        text_elements: [],
      }],
    });
    await settle();

    expect(messages(harness, "prompted-compact")[0]).toMatchObject({
      result: {
        turn: {
          id: "compact-claude-existing",
          status: "inProgress",
          items: [{ type: "contextCompaction" }],
        },
      },
    });
    expect(claude.preparePromptedCompact).toHaveBeenCalledWith(
      "claude-existing",
      "/compact запомни только первое сообщение",
    );
    expect(claude.preparePromptedCompact.mock.results[0]?.value.announce).toHaveBeenCalledOnce();
    expect(claude.prepareTurn).not.toHaveBeenCalled();
    expect(harness.stockRequests.some((request) => request.id === "prompted-compact")).toBe(false);

    harness.client.request("stock-compact", "turn/start", {
      threadId: "stock-existing",
      input: [{ type: "text", text: "/compact stock has no prompt", text_elements: [] }],
    });
    await settle();
    expect(harness.stockRequests).toContainEqual(expect.objectContaining({
      id: "stock-compact",
      method: "turn/start",
    }));
  });

  it("renders provider health in /ccstatus and blocks unavailable stock turns with one actionable notice", async () => {
    const providers = availability("notAuthenticated");
    const harness = await makeHarness(
      fakeClaude(), undefined, undefined, DEFAULT_FEATURES, {}, providers,
    );

    harness.client.request("status", "turn/start", {
      threadId: "stock-existing",
      input: [{ type: "text", text: "/ccstatus", text_elements: [] }],
    });
    await settle();
    const status = messages(harness, "turn/completed").at(-1).params.turn.items.at(-1).text as string;
    expect(status).toContain("❋ **Claude** · ✅ ready");
    expect(status).toContain("֎ **Codex** · ⚠️ not authenticated\n  ↳ `codex login`");
    expect(harness.stockRequests.filter((request) => request.method === "account/rateLimits/read"))
      .toHaveLength(0);

    const before = harness.client.sent.length;
    harness.client.request("turn", "turn/start", {
      threadId: "stock-existing",
      input: [{ type: "text", text: "hello", text_elements: [] }],
    });
    await settle();
    expect(messages(harness, "turn")[0]).toMatchObject({ result: { turn: { status: "inProgress" } } });
    const notice = (harness.client.sent.slice(before) as any[])
      .find((message) => message.method === "item/agentMessage/delta");
    expect(notice.params.delta).toBe(
      "◆ **CCodex** │ ⚠️ Codex is not authenticated\n  ↳ `codex login`",
    );
    expect(harness.stockRequests.some((request) => request.id === "turn")).toBe(false);
  });

  it("routes CCodex status through an ordinary Claude turn when the feature is disabled", async () => {
    const claude = fakeClaude();
    claude.threads.add("claude-existing");
    const harness = await makeHarness(
      claude,
      undefined,
      undefined,
      {
        statusCommand: false, sideChatPromotion: true, optimisticSideStartup: true, interactiveQuestions: true,
      },
    );

    harness.client.request("status", "turn/start", {
      threadId: "claude-existing",
      input: [{ type: "text", text: "CCodex status", text_elements: [] }],
    });
    await settle();
    expect(messages(harness, "status")[0]).toMatchObject({ result: { turn: { id: "turn-claude-existing" } } });
    harness.client.request("state", "turn/start", {
      threadId: "claude-existing",
      input: [{ type: "text", text: "/ccstate", text_elements: [] }],
    });
    await settle();
    expect(messages(harness, "state")[0]).toMatchObject({ result: { turn: { id: "turn-claude-existing" } } });
    expect(claude.prepareTurn).toHaveBeenCalledTimes(2);
    expect(claude.prepareStatusTurn).not.toHaveBeenCalled();
    expect(claude.prepareStateTurn).not.toHaveBeenCalled();
  });

  it("updates provider after a same-provider fork succeeds", async () => {
    const same = await makeHarness();
    same.client.request("start", "thread/start", { model: "claude:sonnet" });
    await settle();
    same.client.request("fork", "thread/fork", { threadId: "claude-1", model: "claude:sonnet" });
    await settle();
    expect(messages(same, "fork")[0]).toMatchObject({ result: { thread: { id: "claude-2" } } });
    same.client.request("same-limits", "account/rateLimits/read");
    await settle();
    expect(messages(same, "same-limits")[0]).toMatchObject({ result: { rateLimits: { limitId: "claude" } } });
  });

  describe("provider switch on the next visible turn", () => {
    function stagedSwitch(sourceProvider: "claude" | "stock", targetModel: string) {
      let pending = false;
      return {
        interceptSettings: vi.fn((params: { model?: string | null }) => {
          pending = params.model === targetModel;
          return { handled: true };
        }),
        blockedTurnTarget: vi.fn(() => undefined),
        pending: vi.fn(() => pending ? { sourceProvider, targetModel } : undefined),
      };
    }

    function compactionItemIds(harness: Harness, threadId: string): string[] {
      const items = (harness.client.sent as any[]).flatMap((message) => {
        const responseItems = message.result?.turn?.items ?? [];
        if (message.params?.threadId !== threadId) return responseItems;
        return [...responseItems, ...(message.params?.turn?.items ?? []), message.params?.item].filter(Boolean);
      });
      return [...new Set(items.flatMap((item) =>
        item.type === "contextCompaction" && typeof item.id === "string" ? [item.id] : []))];
    }

    it.each([
      ["Claude", "claude-source", "gpt-5.6-sol"],
      ["Codex", "stock-source", "claude:sonnet"],
    ])("rejects a cross-provider thread/fork from %s", async (_provider, threadId, model) => {
      const claude = fakeClaude();
      if (threadId === "claude-source") claude.threads.add(threadId);
      const harness = await makeHarness(claude);

      harness.client.request(`cross-fork-${threadId}`, "thread/fork", { threadId, model });
      await settle();

      expect(messages(harness, `cross-fork-${threadId}`)[0]).toMatchObject({
        error: { code: -32602, message: expect.stringMatching(/same.provider/i) },
      });
      expect(claude.forkThread).not.toHaveBeenCalled();
      expect(harness.stockRequests.some((request) => request.method === "thread/fork")).toBe(false);
    });

    it("stages Claude-to-Codex settings and migrates on Send without changing the public thread id", async () => {
      const claude = fakeClaude();
      claude.threads.add("public-claude");
      claude.settings.set("public-claude", {
        model: "claude:sonnet", serviceTier: "default", effort: "high",
      });
      const staged = stagedSwitch("claude", "gpt-5.6-sol");
      const harness = await makeHarness(claude, undefined, undefined, DEFAULT_FEATURES, staged);

      harness.client.request("select-codex", "thread/settings/update", {
        threadId: "public-claude", model: "gpt-5.6-sol", effort: "xhigh",
      });
      await settle();
      expect(messages(harness, "select-codex")[0]).toEqual({ id: "select-codex", result: {} });
      expect(claude.updateThreadSettings).not.toHaveBeenCalled();

      const input = [{ type: "text", text: "continue in Codex", text_elements: [] }];
      harness.client.request("migrate-to-codex", "turn/start", {
        threadId: "public-claude", model: "gpt-5.6-sol", effort: "xhigh", input,
      });
      await settle();

      expect(messages(harness, "migrate-to-codex")[0]).toMatchObject({
        result: { turn: { status: "inProgress", items: expect.arrayContaining([
          expect.objectContaining({ type: "contextCompaction" }),
        ]) } },
      });
      expect(compactionItemIds(harness, "public-claude")).toHaveLength(1);
      expect(claude.forkThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "public-claude" }));
      const hiddenClaudeId = claude.forkThread.mock.results[0]?.value
        ? (await claude.forkThread.mock.results[0].value).thread.id
        : undefined;
      expect(claude.compactThread).toHaveBeenCalledWith(hiddenClaudeId);
      expect(harness.stockRequests).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: "thread/start", params: expect.objectContaining({ model: "gpt-5.6-sol" }) }),
        expect.objectContaining({ method: "turn/start", params: expect.objectContaining({ input }) }),
      ]));
      expect(harness.stockRequests.some((request) =>
        request.method === "turn/start" && (request.params as any)?.threadId === "public-claude")).toBe(false);
      expect(claude.prepareTurn).not.toHaveBeenCalledWith(expect.objectContaining({
        threadId: "public-claude", input,
      }));
      expect(claude.threads.has("public-claude")).toBe(true);
    });

    it("stages Codex-to-Claude settings and sends the untouched user input after hidden native compaction", async () => {
      const claude = fakeClaude();
      const staged = stagedSwitch("stock", "claude:sonnet");
      const harness = await makeHarness(claude, undefined, undefined, DEFAULT_FEATURES, staged);

      harness.client.request("select-claude", "thread/settings/update", {
        threadId: "public-stock", model: "claude:sonnet", effort: "high",
      });
      await settle();
      expect(messages(harness, "select-claude")[0]).toEqual({ id: "select-claude", result: {} });

      const input = [{ type: "text", text: "continue in Claude verbatim", text_elements: [] }];
      harness.client.request("migrate-to-claude", "turn/start", {
        threadId: "public-stock", model: "claude:sonnet", effort: "high", input,
      });
      await settle();

      expect(messages(harness, "migrate-to-claude")[0]).toMatchObject({
        result: { turn: { status: "inProgress", items: expect.arrayContaining([
          expect.objectContaining({ type: "contextCompaction" }),
        ]) } },
      });
      expect(compactionItemIds(harness, "public-stock")).toHaveLength(1);
      const hiddenFork = harness.stockRequests.find((request) => request.method === "thread/fork");
      expect(hiddenFork).toMatchObject({ params: { threadId: "public-stock" } });
      expect(harness.stockRequests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "turn/start",
          params: expect.objectContaining({ threadId: expect.not.stringMatching(/^public-stock$/) }),
        }),
      ]));
      expect(claude.startThread).toHaveBeenCalledWith(expect.objectContaining({ model: "claude:sonnet" }));
      const targetClaudeId = (await claude.startThread.mock.results[0]!.value).thread.id;
      expect(claude.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
        threadId: targetClaudeId, input,
      }));
      expect(harness.stockRequests.some((request) =>
        request.method === "turn/start"
        && (request.params as any)?.threadId === "public-stock"
        && JSON.stringify((request.params as any)?.input) === JSON.stringify(input))).toBe(false);
    });

    it("keeps the source provider usable when target creation fails", async () => {
      const claude = fakeClaude();
      claude.startThread.mockRejectedValueOnce(new Error("injected Claude target failure"));
      const staged = stagedSwitch("stock", "claude:sonnet");
      const harness = await makeHarness(claude, undefined, undefined, DEFAULT_FEATURES, staged);

      harness.client.request("select-failing-claude", "thread/settings/update", {
        threadId: "public-stock", model: "claude:sonnet",
      });
      await settle();
      harness.client.request("failed-migration", "turn/start", {
        threadId: "public-stock", model: "claude:sonnet",
        input: [{ type: "text", text: "must not reach source", text_elements: [] }],
      });
      await settle();

      expect(claude.startThread).toHaveBeenCalledOnce();
      expect(compactionItemIds(harness, "public-stock")).toHaveLength(1);
      expect(JSON.stringify(messages(harness, "turn/completed"))).toContain("injected Claude target failure");
      expect(JSON.stringify(harness.client.sent)).toContain(
        "◆ **CCodex** │ ⚠️ Provider switch failed; your message was not sent",
      );
      expect(JSON.stringify(harness.client.sent)).toContain("↳ injected Claude target failure");
      expect(harness.stockRequests.some((request) =>
        request.id === "failed-migration" && request.method === "turn/start")).toBe(false);

      harness.client.request("restore-stock", "thread/settings/update", {
        threadId: "public-stock", model: "gpt-5.6-sol",
      });
      await settle();
      harness.client.request("source-still-works", "turn/start", {
        threadId: "public-stock", model: "gpt-5.6-sol",
        input: [{ type: "text", text: "source still works", text_elements: [] }],
      });
      await settle();
      expect(harness.stockRequests).toContainEqual(expect.objectContaining({
        id: "source-still-works", method: "turn/start",
      }));
    });

    it("materializes a native fork from the old provider epoch only after App rollback selects it", async () => {
      const claude = fakeClaude();
      claude.threads.add("migrated-public");
      const epochs = [{
        provider: "stock", backendThreadId: "stock-epoch-backend", publicTurnIds: ["old-stock-turn"],
      }, {
        provider: "claude", backendThreadId: "claude-epoch-backend", publicTurnIds: ["compact-turn", "new-claude-turn"],
      }];
      const overlays = new Map<string, unknown>([["migrated-public", { threadId: "migrated-public", epochs }]]);
      const harness = await makeHarness(claude, undefined, undefined, DEFAULT_FEATURES, {
        overlay: (threadId: string) => overlays.get(threadId),
      });

      harness.client.request("fork-migrated", "thread/fork", { threadId: "migrated-public" });
      await settle();
      const provisional = messages(harness, "fork-migrated")[0]?.result?.thread;
      expect(provisional?.turns).toMatchObject([
        { id: "old-stock-turn" }, { id: "compact-turn" }, { id: "new-claude-turn" },
      ]);
      expect(harness.stockRequests.some((request) => request.method === "thread/fork")).toBe(false);

      overlays.set(provisional.id, { threadId: provisional.id, epochs });
      harness.client.request("select-old-epoch", "thread/rollback", {
        threadId: provisional.id, numTurns: 2,
      });
      await settle();

      expect(messages(harness, "select-old-epoch")[0]).toEqual({ id: "select-old-epoch", result: {} });
      expect(harness.stockRequests).toContainEqual(expect.objectContaining({
        method: "thread/fork",
        params: expect.objectContaining({ threadId: "stock-epoch-backend", lastTurnId: "old-stock-turn" }),
      }));
      expect(claude.forkThread).not.toHaveBeenCalled();
      expect(compactionItemIds(harness, provisional.id)).toEqual([]);
    });

    it("routes App rollback for every logical thread to the universal history rollback", async () => {
      const rollbackLogicalThread = vi.fn(async () => ({
        thread: stockThread("public-fork"),
      }));
      const harness = await makeHarness(fakeClaude(), undefined, undefined, DEFAULT_FEATURES, {
        logical: (threadId: string) => threadId === "public-fork" ? { epoch: { provider: "stock" } } : undefined,
        rollbackLogicalThread,
      });

      harness.client.request("select-history-boundary", "thread/rollback", {
        threadId: "public-fork",
        numTurns: 2,
      });
      await settle();

      expect(rollbackLogicalThread).toHaveBeenCalledWith(
        { threadId: "public-fork", numTurns: 2 },
        expect.anything(),
        expect.any(String),
      );
      expect(messages(harness, "select-history-boundary")[0]).toMatchObject({
        result: { thread: { id: "public-fork" } },
      });
      expect(harness.stockRequests.some((request) => request.method === "thread/rollback")).toBe(false);
    });
  });

  it("does not let a system-ephemeral title worker steal Claude foreground", async () => {
    const harness = await makeHarness();
    harness.client.request("claude", "thread/start", { model: "claude:sonnet", threadSource: "user" });
    await settle();
    harness.client.request("title-start", "thread/start", {
      model: "gpt-5.4-mini", ephemeral: true, threadSource: "system",
    });
    await settle();
    harness.client.request("title-turn", "turn/start", { threadId: "stock-thread", input: [] });
    await settle();
    harness.client.request("limits-after-title", "account/rateLimits/read");
    await settle();
    expect(messages(harness, "limits-after-title")[0]).toMatchObject({ result: { rateLimits: { limitId: "claude" } } });
  });

  it("preserves labelled stock data in unknown context and records one structured diagnostic", async () => {
    const harness = await makeHarness();
    harness.client.request("unknown-1", "account/rateLimits/read");
    harness.client.request("unknown-2", "account/rateLimits/read");
    await settle();
    expect(messages(harness, "unknown-1")[0]).toEqual({ id: "unknown-1", result: stockSnapshot });
    expect(harness.logger.warn.mock.calls.filter(([message]) => message === "provider.status.unknown")).toEqual([[
      "provider.status.unknown",
      expect.objectContaining({ signal: "account/rateLimits/read", behavior: expect.stringContaining("provider-labelled stock") }),
    ]]);
  });

  it("leases an ephemeral side task for reconnect instead of deleting it on a transient disconnect", async () => {
    const claude = fakeClaude();
    claude.threads.add("claude-ephemeral");
    const harness = await makeHarness(claude);
    harness.client.request("resume-cleanup", "thread/resume", { threadId: "claude-ephemeral" });
    await settle();
    expect(claude.cancelEphemeralRelease).toHaveBeenCalledWith("claude-ephemeral");

    harness.client.emit("close", 1001, Buffer.from("shutdown"));
    harness.client.emit("close", 1001, Buffer.from("duplicate"));
    await harness.connection.closed;
    expect(claude.scheduleEphemeralRelease).toHaveBeenCalledTimes(1);
    expect(claude.scheduleEphemeralRelease).toHaveBeenCalledWith("claude-ephemeral");
    expect(claude.releaseEphemeralThread).not.toHaveBeenCalled();
  });

  it("promotes a stock /side chat through a hidden native rollout without leaking its marker", async () => {
    const cleanup = { request: vi.fn(async (method: string) =>
      method === "thread/list" ? { data: [], nextCursor: null } : {}) };
    const sides = new StockSideThreads(true, cleanup as never, new Logger("error"));
    let fork = 0;
    const harness = await makeHarness(
      fakeClaude(), undefined, undefined, DEFAULT_FEATURES, {}, undefined,
      (params: Record<string, any>) => {
        fork += 1;
        const projected = stockThread(fork === 1 ? "stock-side" : "stock-promoted");
        return { thread: {
          ...projected,
          forkedFromId: params.threadId,
          ephemeral: params.ephemeral,
          threadSource: params.threadSource,
          path: `/rollouts/${projected.id}.jsonl`,
        } };
      },
      sides,
    );

    harness.client.request("side", "thread/fork", {
      threadId: "stock-source", ephemeral: true, excludeTurns: true, threadSource: "user",
    });
    await settle();
    expect(harness.stockRequests.find((request) => request.id === "side")?.params).toMatchObject({
      ephemeral: false, excludeTurns: true, threadSource: STOCK_SIDE_THREAD_SOURCE,
    });
    expect(messages(harness, "side")[0]).toMatchObject({ result: { thread: {
      id: "stock-side", ephemeral: true, path: null, threadSource: "user",
    } } });

    harness.client.request("promote", "thread/fork", {
      threadId: "stock-side", path: null, cwd: "/tmp", threadSource: "user",
    });
    await settle();
    expect(harness.stockRequests.find((request) => request.id === "promote")?.params).toMatchObject({
      threadId: "stock-side", ephemeral: false, threadSource: "user",
    });
    expect(messages(harness, "promote")[0]).toMatchObject({ result: { thread: {
      id: "stock-promoted", ephemeral: false, threadSource: "user",
    } } });
    expect(harness.client.rawSent.join("\n")).not.toContain(STOCK_SIDE_THREAD_SOURCE);
    expect(harness.client.sent.some((message: any) =>
      message.method === "item/agentMessage/delta" && String(message.params?.delta).includes("CCodex ERROR")))
      .toBe(false);
  });

  it("routes captured /side params on a logical Claude task to one native ephemeral fork", async () => {
    const claude = fakeClaude();
    claude.threads.add("claude-backend");
    const forkLogical = vi.fn();
    const harness = await makeHarness(claude, undefined, undefined, DEFAULT_FEATURES, {
      logical: (threadId: string) => threadId === "public-thread"
        ? { epoch: { provider: "claude", backendThreadId: "claude-backend" } }
        : undefined,
      forkLogical,
    });

    harness.client.request("side", "thread/fork", {
      threadId: "public-thread",
      cwd: "/tmp",
      threadSource: "user",
      excludeTurns: true,
      ephemeral: true,
    });
    await settle();

    expect(claude.forkThread).toHaveBeenCalledWith({
      threadId: "claude-backend",
      cwd: "/tmp",
      threadSource: "user",
      excludeTurns: true,
      ephemeral: true,
    }, "public-thread");
    expect(forkLogical).not.toHaveBeenCalled();
    const child = messages(harness, "side")[0]?.result?.thread;
    expect(child).toMatchObject({
      forkedFromId: "public-thread",
      ephemeral: true,
      threadSource: "user",
    });

    harness.client.request("boundary", "thread/inject_items", {
      threadId: child.id,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Side conversation boundary." }] }],
    });
    harness.client.request("goal", "thread/goal/get", { threadId: child.id });
    await settle();
    expect(messages(harness, "boundary")[0]).toEqual({ id: "boundary", result: {} });
    expect(messages(harness, "goal")[0]).toEqual({ id: "goal", result: { goal: null } });
    expect(harness.client.rawSent.join("\n")).not.toContain("waiting for Codex App");
    expect(harness.stockRequests.some((request) => request.method === "thread/fork")).toBe(false);
  });

  it("routes /side on a logical stock task through the hidden native rollout", async () => {
    const cleanup = { request: vi.fn(async (method: string) =>
      method === "thread/list" ? { data: [], nextCursor: null } : {}) };
    const sides = new StockSideThreads(true, cleanup as never, new Logger("error"));
    const harness = await makeHarness(
      fakeClaude(),
      undefined,
      undefined,
      DEFAULT_FEATURES,
      {
        logical: (threadId: string) => threadId === "public-stock"
          ? { epoch: { provider: "stock", backendThreadId: "stock-backend" } }
          : undefined,
        forkLogical: vi.fn(),
      },
      undefined,
      (params: Record<string, any>) => ({
        thread: {
          ...stockThread("stock-side"),
          forkedFromId: params.threadId,
          ephemeral: params.ephemeral,
          threadSource: params.threadSource,
          path: "/rollouts/stock-side.jsonl",
        },
      }),
      sides,
    );

    harness.client.request("stock-side", "thread/fork", {
      threadId: "public-stock",
      threadSource: "user",
      excludeTurns: true,
      ephemeral: true,
    });
    await settle();

    expect(harness.stockRequests).toContainEqual(expect.objectContaining({
      method: "thread/fork",
      params: expect.objectContaining({
        threadId: "stock-backend",
        ephemeral: false,
        excludeTurns: true,
        threadSource: STOCK_SIDE_THREAD_SOURCE,
      }),
    }));
    expect(messages(harness, "stock-side")[0]).toMatchObject({ result: { thread: {
      id: "stock-side",
      forkedFromId: "public-stock",
      ephemeral: true,
      path: null,
      threadSource: "user",
    } } });
  });

  it("replays the authoritative logical title to a newly connected App client", async () => {
    const renamed = {
      ...stockThread("public-thread"),
      modelProvider: "claude",
      name: "🧭 XRP fable убегание",
    };
    const harness = await makeHarness(fakeClaude(), undefined, undefined, DEFAULT_FEATURES, {
      logical: (threadId: string) => threadId === renamed.id
        ? { epoch: { provider: "claude", backendThreadId: "claude-backend" } }
        : undefined,
      projectThreadCatalog: () => [renamed],
    });

    harness.client.request("list", "thread/list", {
      limit: 200,
      cursor: null,
      archived: false,
      sortDirection: "desc",
      sortKey: "created_at",
    });
    await settle();

    expect(messages(harness, "list")[0]).toMatchObject({
      result: { data: [{ id: renamed.id, name: renamed.name }] },
    });
    expect(messages(harness, "thread/name/updated")).toContainEqual({
      method: "thread/name/updated",
      params: { threadId: renamed.id, threadName: renamed.name },
    });
  });

  it("opens a logical Claude /side before provider readiness and queues boundary before Send", async () => {
    const claude = fakeClaude();
    claude.threads.add("claude-backend");
    let finish!: (value: any) => void;
    claude.forkThread.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const optimistic = new OptimisticSideThreads();
    const harness = await makeHarness(
      claude,
      undefined,
      undefined,
      DEFAULT_FEATURES,
      {
        logical: (threadId: string) => threadId === "public-thread"
          ? { epoch: { provider: "claude", backendThreadId: "claude-backend" } }
          : undefined,
        sideSnapshot: (params: { threadId: string }, targetId: string) =>
          sideSnapshot(params.threadId, targetId, "claude"),
        forkLogical: vi.fn(),
      },
      undefined,
      undefined,
      undefined,
      optimistic,
    );

    harness.client.request("side-open", "thread/fork", {
      threadId: "public-thread",
      threadSource: "user",
      excludeTurns: true,
      ephemeral: true,
    });
    await settle();
    const opened = messages(harness, "side-open")[0]?.result;
    const publicSideId = opened?.thread?.id;
    expect(opened?.thread).toMatchObject({
      forkedFromId: "public-thread",
      ephemeral: true,
      turns: [],
    });
    expect(messages(harness, "thread/started").filter((value) =>
      value.params?.thread?.id === publicSideId)).toHaveLength(1);

    harness.client.request("boundary", "thread/inject_items", {
      threadId: publicSideId,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Side conversation boundary." }] }],
    });
    harness.client.request("send", "turn/start", {
      threadId: publicSideId,
      input: [{ type: "text", text: "answer after readiness", text_elements: [] }],
    });
    await settle();
    expect(messages(harness, "boundary")[0]).toEqual({ id: "boundary", result: {} });
    expect(messages(harness, "send")).toEqual([]);
    expect(claude.injectItems).not.toHaveBeenCalled();
    expect(claude.prepareTurn).not.toHaveBeenCalled();

    finish(sideSnapshot("public-thread", "claude-side-backend", "claude"));
    await settle();
    expect(messages(harness, "boundary")).toHaveLength(1);
    expect(messages(harness, "send")[0]).toMatchObject({ result: { turn: { id: "turn-claude-side-backend" } } });
    expect(claude.injectItems.mock.invocationCallOrder[0])
      .toBeLessThan(claude.prepareTurn.mock.invocationCallOrder[0]!);
    expect((harness.client.sent as any[]).some((message) =>
      message.params?.threadId === "claude-side-backend"
      || message.params?.thread?.id === "claude-side-backend"
      || message.result?.thread?.id === "claude-side-backend")).toBe(false);
  });

  it("opens a logical stock /side before the hidden rollout is ready and preserves FIFO", async () => {
    let finish!: (value: unknown) => void;
    const providerFork = new Promise((resolve) => { finish = resolve; });
    const sideRequests: string[] = [];
    const stockSides = {
      prepareOptimisticSide: vi.fn(async () => {
        await providerFork;
        return { response: {}, backendThreadId: "stock-side-backend" };
      }),
      request: vi.fn(async (method: string) => {
        sideRequests.push(method);
        return {};
      }),
      discardOptimistic: vi.fn(async () => undefined),
      resolveServerRequest: vi.fn(async () => false),
      projectMessage: (_connectionId: string, message: unknown) => ({ kind: "forward", message }),
      filterThreads: (threads: unknown[]) => threads,
      detachConnection: vi.fn(),
      close: vi.fn(),
    } as unknown as StockSideThreads;
    const optimistic = new OptimisticSideThreads();
    const harness = await makeHarness(
      fakeClaude(),
      undefined,
      undefined,
      DEFAULT_FEATURES,
      {
        logical: (threadId: string) => threadId === "public-stock"
          ? { epoch: { provider: "stock", backendThreadId: "stock-backend" } }
          : undefined,
        sideSnapshot: (params: { threadId: string }, targetId: string) =>
          sideSnapshot(params.threadId, targetId, "stock"),
        forkLogical: vi.fn(),
      },
      undefined,
      undefined,
      stockSides,
      optimistic,
    );

    harness.client.request("side-open", "thread/fork", {
      threadId: "public-stock",
      threadSource: "user",
      excludeTurns: true,
      ephemeral: true,
    });
    await settle();
    const publicSideId = messages(harness, "side-open")[0]?.result?.thread?.id;
    expect(publicSideId).toEqual(expect.any(String));

    harness.client.request("boundary", "thread/inject_items", {
      threadId: publicSideId,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "boundary" }] }],
    });
    harness.client.request("send", "turn/start", {
      threadId: publicSideId,
      input: [{ type: "text", text: "queued", text_elements: [] }],
    });
    await settle();
    expect(messages(harness, "boundary")[0]).toEqual({ id: "boundary", result: {} });
    expect(sideRequests).not.toContain("thread/inject_items");
    expect(sideRequests).not.toContain("turn/start");

    finish({});
    await settle();
    expect(messages(harness, "boundary")).toHaveLength(1);
    expect(messages(harness, "send")[0]).toEqual({ id: "send", result: {} });
    expect(sideRequests.indexOf("thread/inject_items")).toBeLessThan(sideRequests.indexOf("turn/start"));
    expect(JSON.stringify(harness.client.sent)).not.toContain("stock-side-backend");
  });

  it("drops the native optimistic stock thread/started without crashing before queued inject", async () => {
    let finishFork!: (value: unknown) => void;
    const providerFork = new Promise((resolve) => { finishFork = resolve; });
    const stockRequests: string[] = [];
    const cleanup = {
      request: vi.fn(async (method: string) => {
        stockRequests.push(method);
        if (method === "thread/fork") return providerFork;
        return {};
      }),
      respond: vi.fn(async () => undefined),
    };
    const stockSides = new StockSideThreads(true, cleanup as never, new Logger("error"));
    const optimistic = new OptimisticSideThreads();
    const harness = await makeHarness(
      fakeClaude(),
      undefined,
      undefined,
      DEFAULT_FEATURES,
      {
        logical: (threadId: string) => threadId === "public-stock"
          ? { epoch: { provider: "stock", backendThreadId: "stock-backend" } }
          : undefined,
        sideSnapshot: (params: { threadId: string }, targetId: string) =>
          sideSnapshot(params.threadId, targetId, "stock"),
        forkLogical: vi.fn(),
      },
      undefined,
      undefined,
      stockSides,
      optimistic,
    );

    harness.client.request("side-open", "thread/fork", {
      threadId: "public-stock",
      threadSource: "user",
      excludeTurns: true,
      ephemeral: true,
    });
    await settle();
    const publicSideId = messages(harness, "side-open")[0]?.result?.thread?.id;
    harness.client.request("boundary", "thread/inject_items", {
      threadId: publicSideId,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "boundary" }] }],
    });

    const backend = {
      ...stockThread("stock-side-backend"),
      forkedFromId: "stock-backend",
      ephemeral: false,
      threadSource: STOCK_SIDE_THREAD_SOURCE,
      path: "/rollouts/stock-side-backend.jsonl",
    };
    finishFork({
      thread: backend,
      model: "gpt-5.6-terra",
      modelProvider: "openai",
      serviceTier: null,
    });
    await settle();
    for (const stock of harness.stockClients) {
      stock.send(JSON.stringify({ method: "thread/started", params: { thread: backend } }));
    }
    await settle();

    expect(harness.client.readyState).toBe(WebSocket.OPEN);
    expect(messages(harness, "boundary")[0]).toEqual({ id: "boundary", result: {} });
    expect(stockRequests).toEqual(["thread/fork", "thread/inject_items"]);
    expect(JSON.stringify(harness.client.sent)).not.toContain("stock-side-backend");
    expect(harness.logger.error).not.toHaveBeenCalledWith(
      "connection.stock.message-failed",
      expect.anything(),
    );
  });

  it("keeps a queued Claude side turn across App disconnect and resumes the same public side", async () => {
    const claude = fakeClaude();
    claude.threads.add("claude-backend");
    let finish!: (value: any) => void;
    claude.forkThread.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const optimistic = new OptimisticSideThreads();
    const subscriptions = new SubscriptionHub();
    const handoffs = {
      logical: (threadId: string) => threadId === "public-thread"
        ? { epoch: { provider: "claude", backendThreadId: "claude-backend" } }
        : undefined,
      sideSnapshot: (params: { threadId: string }, targetId: string) =>
        sideSnapshot(params.threadId, targetId, "claude"),
      forkLogical: vi.fn(),
    };
    const first = await makeHarness(
      claude, undefined, undefined, DEFAULT_FEATURES, handoffs,
      undefined, undefined, undefined, optimistic, subscriptions,
    );

    first.client.request("side-open", "thread/fork", {
      threadId: "public-thread",
      threadSource: "user",
      excludeTurns: true,
      ephemeral: true,
    });
    await settle();
    const publicSideId = messages(first, "side-open")[0]?.result?.thread?.id;
    first.client.request("boundary", "thread/inject_items", {
      threadId: publicSideId,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "boundary" }] }],
    });
    first.client.request("send", "turn/start", {
      threadId: publicSideId,
      input: [{ type: "text", text: "queued before disconnect", text_elements: [] }],
    });
    await settle();
    first.client.readyState = WebSocket.CLOSED;
    first.client.emit("close", 1006, Buffer.from("transport lost"));
    await first.connection.closed;

    finish(sideSnapshot("public-thread", "claude-side-backend", "claude"));
    await settle();
    expect(claude.injectItems).toHaveBeenCalledTimes(1);
    expect(claude.prepareTurn).toHaveBeenCalledTimes(1);

    const second = await makeHarness(
      claude, undefined, undefined, DEFAULT_FEATURES, handoffs,
      undefined, undefined, undefined, optimistic, subscriptions,
    );
    second.client.request("resume", "thread/resume", {
      threadId: publicSideId,
      excludeTurns: false,
    });
    await settle();

    expect(messages(second, "resume")[0]).toMatchObject({
      result: { thread: { id: publicSideId } },
    });
    expect(claude.prepareResume).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "claude-side-backend",
    }));
    expect(claude.replayPendingRequests).toHaveBeenCalledWith("claude-side-backend", expect.any(String));
    expect(JSON.stringify(second.client.sent)).not.toContain("claude-side-backend");
  });

  it("reports a preparation failure once after reconnect instead of losing it with the old socket", async () => {
    const claude = fakeClaude();
    claude.threads.add("claude-backend");
    let fail!: (error: Error) => void;
    claude.forkThread.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const optimistic = new OptimisticSideThreads();
    const subscriptions = new SubscriptionHub();
    const handoffs = {
      logical: (threadId: string) => threadId === "public-thread"
        ? { epoch: { provider: "claude", backendThreadId: "claude-backend" } }
        : undefined,
      sideSnapshot: (params: { threadId: string }, targetId: string) =>
        sideSnapshot(params.threadId, targetId, "claude"),
      forkLogical: vi.fn(),
    };
    const first = await makeHarness(
      claude, undefined, undefined, DEFAULT_FEATURES, handoffs,
      undefined, undefined, undefined, optimistic, subscriptions,
    );
    first.client.request("side-open", "thread/fork", {
      threadId: "public-thread", threadSource: "user", excludeTurns: true, ephemeral: true,
    });
    await settle();
    const publicSideId = messages(first, "side-open")[0]?.result?.thread?.id;
    first.client.readyState = WebSocket.CLOSED;
    first.client.emit("close", 1006, Buffer.from("transport lost"));
    await first.connection.closed;
    fail(new Error("provider fork exploded"));
    await settle();

    const second = await makeHarness(
      claude, undefined, undefined, DEFAULT_FEATURES, handoffs,
      undefined, undefined, undefined, optimistic, subscriptions,
    );
    second.client.request("resume-1", "thread/resume", { threadId: publicSideId });
    second.client.request("resume-2", "thread/resume", { threadId: publicSideId });
    await settle();

    expect(messages(second, "resume-1")[0]).toMatchObject({
      result: { thread: { id: publicSideId } },
    });
    expect(second.client.sent.filter((message: any) =>
      message.method === "item/agentMessage/delta"
      && String(message.params?.delta).includes("provider fork exploded"))).toHaveLength(1);
  });

  it("keeps synchronous side startup when the optimistic feature is disabled", async () => {
    const claude = fakeClaude();
    claude.threads.add("claude-backend");
    let finish!: (value: any) => void;
    claude.forkThread.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const features = { ...DEFAULT_FEATURES, optimisticSideStartup: false };
    const harness = await makeHarness(claude, undefined, undefined, features, {
      logical: (threadId: string) => threadId === "public-thread"
        ? { epoch: { provider: "claude", backendThreadId: "claude-backend" } }
        : undefined,
      sideSnapshot: (params: { threadId: string }, targetId: string) =>
        sideSnapshot(params.threadId, targetId, "claude"),
      forkLogical: vi.fn(),
    });

    harness.client.request("side-open", "thread/fork", {
      threadId: "public-thread",
      threadSource: "user",
      excludeTurns: true,
      ephemeral: true,
    });
    await settle();
    expect(messages(harness, "side-open")).toEqual([]);

    finish(sideSnapshot("public-thread", "claude-side-backend", "claude"));
    await settle();
    expect(messages(harness, "side-open")[0]).toMatchObject({
      result: { thread: { id: "claude-side-backend", ephemeral: true } },
    });
  });

  it("does not let a late async fork completion resurrect a detached subscription", async () => {
    const claude = fakeClaude();
    claude.threads.add("claude-source");
    let finish!: (result: any) => void;
    claude.forkThread.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const harness = await makeHarness(claude);
    harness.client.request("late-fork", "thread/fork", { threadId: "claude-source" });
    await settle();

    harness.client.emit("close", 1006, Buffer.from("transport lost"));
    await harness.connection.closed;
    claude.threads.add("late-target");
    finish({ thread: { id: "late-target" } });
    await settle();

    expect(harness.subscriptions.hasSubscribers("late-target")).toBe(false);
  });

  it("keeps the original RPC error when diagnostic persistence races shutdown", async () => {
    const claude = fakeClaude();
    claude.threads.add("claude-terminal");
    claude.reportError.mockRejectedValue(new Error("Claude session registry is closed."));
    const harness = await makeHarness(claude);
    harness.client.request("terminal-error", "thread/metadata/update", {
      threadId: "claude-terminal",
      gitInfo: null,
    });
    await settle();

    expect(messages(harness, "terminal-error")[0]).toMatchObject({
      id: "terminal-error",
      error: { message: expect.any(String) },
    });
    expect(harness.logger.warn).toHaveBeenCalledWith(
      "claude.request.error-report-failed",
      expect.objectContaining({
        originalError: expect.any(String),
        diagnosticError: "Claude session registry is closed.",
      }),
    );
  });

  it("keeps an active Claude turn active when an App RPC fails", async () => {
    const claude = fakeClaude();
    claude.threads.add("claude-active");
    claude.reportError.mockResolvedValue(true);
    const harness = await makeHarness(claude);

    harness.client.request("bad-rpc", "thread/metadata/update", {
      threadId: "claude-active",
      gitInfo: null,
    });
    await settle();

    expect(messages(harness, "bad-rpc")[0]).toMatchObject({
      id: "bad-rpc",
      error: { message: expect.any(String) },
    });
    expect(claude.reportError).toHaveBeenCalledTimes(1);
    expect(harness.client.sent).not.toContainEqual(expect.objectContaining({ method: "turn/started" }));
    expect(harness.client.sent).not.toContainEqual(expect.objectContaining({ method: "turn/completed" }));
    expect(harness.client.sent).not.toContainEqual(expect.objectContaining({ method: "item/agentMessage/delta" }));
  });
});
