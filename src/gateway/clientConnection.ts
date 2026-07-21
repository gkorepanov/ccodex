import { validate as isUuid, v7 as uuidv7 } from "uuid";
import type WebSocket from "ws";
import { WebSocket as WebSocketState } from "ws";
import type { ModelListParams } from "../codex/generated/v2/ModelListParams.js";
import type { ThreadListParams } from "../codex/generated/v2/ThreadListParams.js";
import type { ThreadLoadedListParams } from "../codex/generated/v2/ThreadLoadedListParams.js";
import type { ThreadReadParams } from "../codex/generated/v2/ThreadReadParams.js";
import type { ThreadReadResponse } from "../codex/generated/v2/ThreadReadResponse.js";
import type { ThreadResumeParams } from "../codex/generated/v2/ThreadResumeParams.js";
import type { ThreadStartParams } from "../codex/generated/v2/ThreadStartParams.js";
import type { ThreadTurnsListParams } from "../codex/generated/v2/ThreadTurnsListParams.js";
import type { ThreadSetNameParams } from "../codex/generated/v2/ThreadSetNameParams.js";
import type { ThreadMetadataUpdateParams } from "../codex/generated/v2/ThreadMetadataUpdateParams.js";
import type { ThreadItemsListParams } from "../codex/generated/v2/ThreadItemsListParams.js";
import type { ThreadGoalSetParams } from "../codex/generated/v2/ThreadGoalSetParams.js";
import type { ThreadForkParams } from "../codex/generated/v2/ThreadForkParams.js";
import type { ThreadRollbackParams } from "../codex/generated/v2/ThreadRollbackParams.js";
import type { ThreadSettingsUpdateParams } from "../codex/generated/v2/ThreadSettingsUpdateParams.js";
import type { ThreadSettings } from "../codex/generated/v2/ThreadSettings.js";
import type { ThreadInjectItemsParams } from "../codex/generated/v2/ThreadInjectItemsParams.js";
import type { ThreadShellCommandParams } from "../codex/generated/v2/ThreadShellCommandParams.js";
import type { ReviewStartParams } from "../codex/generated/v2/ReviewStartParams.js";
import type { TurnInterruptParams } from "../codex/generated/v2/TurnInterruptParams.js";
import type { TurnStartParams } from "../codex/generated/v2/TurnStartParams.js";
import type { TurnSteerParams } from "../codex/generated/v2/TurnSteerParams.js";
import type { ThreadBackgroundTerminalsCleanParams } from "../codex/generated/v2/ThreadBackgroundTerminalsCleanParams.js";
import type { ThreadBackgroundTerminalsListParams } from "../codex/generated/v2/ThreadBackgroundTerminalsListParams.js";
import type { ThreadBackgroundTerminalsTerminateParams } from "../codex/generated/v2/ThreadBackgroundTerminalsTerminateParams.js";
import type { GetAccountRateLimitsResponse } from "../codex/generated/v2/GetAccountRateLimitsResponse.js";
import type { ClaudeModelCatalog } from "../claude/modelCatalog.js";
import type { ClaudeService } from "../claude/service.js";
import { connectStock } from "../codex/stockConnection.js";
import type { Logger } from "../observability/logger.js";
import { isRequest, isResponse, parseRpcMessage } from "../protocol/envelopes.js";
import { RpcError, rpcCodexErrorInfo, rpcError } from "../protocol/errors.js";
import { mergedModelList } from "./modelList.js";
import { StockRpc } from "./stockRpc.js";
import type { SubscriptionHub } from "./subscriptions.js";
import type { CursorCodec } from "../protocol/cursor.js";
import { mergedLoadedList, mergedThreadList } from "./threadList.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import type { RpcRecorder } from "../observability/rpcRecorder.js";
import type { RemoteControlHub } from "./remoteControlHub.js";
import { ServerRequestIds } from "./serverRequestIds.js";
import type { CrossProviderForks } from "../handoff/service.js";
import {
  providerMigrationCompleted, providerMigrationFailed, providerMigrationNotice, transientCommandNotice, transientSystemNotice,
  type SystemNoticeKind, type TransientNotice,
} from "./transientNotice.js";
import { rateLimitNotifications, type ClaudeRateLimitsResponse } from "../claude/rateLimits.js";
import { formatCCodexStatus, isCCodexStatusCommand } from "../claude/statusCommand.js";
import { claudeCompactCommand } from "../claude/compactCommand.js";
import { DEFAULT_FEATURES, type FeatureConfig } from "../config/config.js";
import type { ProviderAvailabilityService } from "../runtime/providerAvailability.js";
import { providerUnavailableMessage } from "../runtime/providerAvailability.js";
import { formatCCodexState, isCCodexStateCommand } from "../state/stateCommand.js";
import { StockStateTracker } from "../state/stockStateTracker.js";
import { STOCK_SIDE_THREAD_SOURCE, type StockSideThreads } from "./stockSideThreads.js";

type ForegroundProvider = "codex" | "claude";
type FastSettings = Pick<ThreadSettings, "model" | "serviceTier">;

function requestedFast(serviceTier: string | null | undefined): boolean {
  return serviceTier === "fast" || serviceTier === "priority";
}

function claudeModelNoticeName(model: string): string {
  const name = model.replace(/^claude:/u, "").replace(/^claude-/u, "").split("-")[0] ?? model;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function fastTransitionNotice(
  before: FastSettings | undefined,
  after: FastSettings,
  requestedTier: string | null | undefined,
): string | undefined {
  const effectiveRequest = requestedTier === undefined ? before?.serviceTier : requestedTier;
  if (before && !requestedFast(before.serviceTier) && requestedFast(after.serviceTier)) {
    return "Fast mode is on — usage limits may be consumed faster.";
  }
  if (requestedFast(effectiveRequest) && !requestedFast(after.serviceTier)) {
    return `Fast was requested, but ${claudeModelNoticeName(after.model)} does not support it — continuing in Standard.`;
  }
  return undefined;
}

export interface ClientConnectionHandle {
  readonly closed: Promise<void>;
}

export function attachClientConnection(
  client: WebSocket,
  stockSocket: string,
  claudeModels: ClaudeModelCatalog,
  claude: ClaudeService,
  handoffs: CrossProviderForks,
  subscriptions: SubscriptionHub,
  logger: Logger,
  cursors: CursorCodec,
  metrics: MetricsRegistry,
  recorder: RpcRecorder,
  remoteControl?: RemoteControlHub,
  features: FeatureConfig = DEFAULT_FEATURES,
  providerAvailability?: Pick<ProviderAvailabilityService, "read" | "refresh" | "refreshAll">,
  sharedStockState?: StockStateTracker,
  stockSideThreads?: StockSideThreads,
): ClientConnectionHandle {
  const connectionId = uuidv7();
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => undefined);
  let connectionAlive = true;
  const stock = connectStock(stockSocket);
  const stockRpc = new StockRpc(stock);
  const stockState = sharedStockState ?? new StockStateTracker();
  const queued: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
  const requestStarted = new Map<string, number>();
  const forwardedRequests = new Map<string, {
    method: string;
    threadId?: string;
    systemEphemeral?: ThreadStartParams | ThreadForkParams;
    foreground?: ForegroundProvider;
    clearForeground?: boolean;
  }>();
  const recentSystemErrors = new Map<string, number>();
  const serverRequestIds = new ServerRequestIds();
  const requestKey = (id: string | number) => `${typeof id}:${id}`;
  const completeLatency = (id: string | number, provider: "stock" | "claude") => {
    const key = requestKey(id);
    const started = requestStarted.get(key);
    if (started === undefined) return;
    requestStarted.delete(key);
    metrics.observeLatency(provider, performance.now() - started);
  };
  const trackForwardedRequest = (message: ReturnType<typeof parseRpcMessage>) => {
    if (!message || !isRequest(message)) return;
    const params = message.params && typeof message.params === "object"
      ? message.params as { threadId?: unknown; ephemeral?: unknown; threadSource?: unknown }
      : undefined;
    const systemEphemeral = (message.method === "thread/start" || message.method === "thread/fork")
      && params?.ephemeral === true
      && (params.threadSource === "system" || (message.method === "thread/start" && params.threadSource !== "user"));
    const internalEphemeralThread = typeof params?.threadId === "string"
      && handoffs.ownsSystemEphemeral(connectionId, params.threadId);
    const stockSide = params?.threadSource === STOCK_SIDE_THREAD_SOURCE;
    const foreground = !systemEphemeral && !internalEphemeralThread && !stockSide
      && ["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(message.method)
      ? "codex" as const
      : undefined;
    forwardedRequests.set(requestKey(message.id), {
      method: message.method,
      ...(typeof params?.threadId === "string" ? { threadId: params.threadId } : {}),
      ...(systemEphemeral
        ? { systemEphemeral: message.params as ThreadStartParams | ThreadForkParams }
        : {}),
      ...(foreground ? { foreground } : {}),
      ...(["thread/delete", "thread/unsubscribe"].includes(message.method) ? { clearForeground: true } : {}),
    });
  };

  metrics.connectionOpened();
  logger.info("connection.opened", { connectionId });
  recorder.connection("opened", connectionId);

  const sendJson = (message: unknown) => {
    if (client.readyState !== WebSocketState.OPEN) return;
    const data = JSON.stringify(message);
    recorder.frame(connectionId, "gateway_to_client", data, false);
    client.send(data);
  };

  const emitNotice = (notice: TransientNotice) => {
    for (const notification of notice.notifications) sendJson(notification);
  };
  const emitTransientNotice = (threadId: string, text: string, kind: SystemNoticeKind = "info") => {
    const notice = transientSystemNotice(threadId, text, kind);
    emitNotice(notice);
    return notice;
  };
  const emitFastTransition = (
    threadId: string,
    before: FastSettings | undefined,
    after: FastSettings,
    requestedTier: string | null | undefined,
  ) => {
    const text = fastTransitionNotice(before, after, requestedTier);
    if (text) emitTransientNotice(threadId, text);
  };
  const emitSystemError = (threadId: string, message: string) => {
    const now = Date.now();
    const key = `${threadId}\u0000${message}`;
    if (now - (recentSystemErrors.get(key) ?? 0) < 1_000) return;
    recentSystemErrors.set(key, now);
    if (recentSystemErrors.size > 64) {
      for (const [candidate, timestamp] of recentSystemErrors) {
        if (now - timestamp >= 1_000) recentSystemErrors.delete(candidate);
      }
    }
    emitTransientNotice(threadId, message, "error");
  };

  const sendResult = (id: string | number, result: unknown) => {
    completeLatency(id, "claude");
    sendJson({ id, result });
  };
  const sendError = (id: string | number, code: number, error: unknown) => {
    completeLatency(id, "claude");
    sendJson({ id, error: { code, message: error instanceof Error ? error.message : String(error) } });
  };
  let foreground: { provider: ForegroundProvider; threadId: string } | undefined;
  let foregroundGeneration = 0;
  let unknownStatusDiagnosed = false;
  const emitRateLimits = (response: ClaudeRateLimitsResponse) => {
    for (const notification of rateLimitNotifications(response)) sendJson(notification);
  };
  const emitStockRateLimits = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const result = value as { rateLimits?: unknown; rateLimitsByLimitId?: Record<string, unknown> | null };
    const buckets = result.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : [];
    const snapshots = buckets.length > 0 ? buckets : result.rateLimits ? [result.rateLimits] : [];
    for (const rateLimits of snapshots) sendJson({ method: "account/rateLimits/updated", params: { rateLimits } });
  };
  const combinedStatus = async (threadId?: string) => {
    const availability = providerAvailability
      ? await providerAvailability.refreshAll()
      : {
          claude: { provider: "claude" as const, state: "ready" as const },
          codex: { provider: "codex" as const, state: "ready" as const },
        };
    const [claudeUsage, codexRateLimits] = await Promise.all([
      availability.claude.state === "ready"
        ? claude.readRateLimitStatus(threadId).catch((error: unknown) => ({
            rateLimits: claude.cachedRateLimits(),
            unavailableReason: error instanceof Error ? error.message : String(error),
          }))
        : undefined,
      availability.codex.state === "ready"
        ? stockRpc.request("account/rateLimits/read", undefined).catch(() => undefined)
        : undefined,
    ]);
    return formatCCodexStatus({
      claude: { availability: availability.claude, ...(claudeUsage ? { usage: claudeUsage } : {}) },
      codex: {
        availability: availability.codex,
        ...(codexRateLimits ? { rateLimits: codexRateLimits as GetAccountRateLimitsResponse } : {}),
      },
    });
  };
  const threadState = async (threadId: string) => {
    const logical = handoffs.logical?.(threadId);
    if (logical?.epoch.provider === "claude") {
      return formatCCodexState(claude.stateSnapshot(logical.epoch.backendThreadId));
    }
    if (claude.ownsThread(threadId)) return formatCCodexState(claude.stateSnapshot(threadId));
    let response: ThreadReadResponse;
    try {
      response = logical
        ? (await handoffs.requestLogical("thread/read", { threadId, includeTurns: true }, stockRpc)).result as ThreadReadResponse
        : await stockRpc.request("thread/read", { threadId, includeTurns: true }) as ThreadReadResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("includeTurns is unavailable")
        && !message.includes("ephemeral threads do not support includeTurns")) throw error;
      response = logical
        ? (await handoffs.requestLogical("thread/read", { threadId, includeTurns: false }, stockRpc)).result as ThreadReadResponse
        : await stockRpc.request("thread/read", { threadId, includeTurns: false }) as ThreadReadResponse;
    }
    return formatCCodexState(stockState.snapshot(response.thread));
  };
  const publishForegroundRateLimits = (generation: number) => {
    const selected = foreground;
    if (!selected) return;
    if (selected.provider === "claude") {
      const backend = handoffs.logical?.(selected.threadId)?.epoch.backendThreadId ?? selected.threadId;
      void claude.readRateLimits(backend).then((response) => {
        if (foregroundGeneration === generation && foreground?.provider === "claude") emitRateLimits(response);
      }).catch((error) => logger.warn("claude.rate-limits.publish-failed", { connectionId, error: String(error) }));
      return;
    }
    void (async () => {
      if (providerAvailability && (await providerAvailability.read("codex")).state !== "ready") return;
      const response = await stockRpc.request("account/rateLimits/read", undefined);
      if (foregroundGeneration === generation && foreground?.provider === "codex") emitStockRateLimits(response);
    })().catch((error) => logger.warn("codex.rate-limits.publish-failed", { connectionId, error: String(error) }));
  };
  const selectForeground = (provider: ForegroundProvider, threadId: string) => {
    foreground = { provider, threadId };
    unknownStatusDiagnosed = false;
    foregroundGeneration += 1;
    publishForegroundRateLimits(foregroundGeneration);
  };
  const clearForeground = (threadId: string) => {
    if (foreground?.threadId !== threadId) return;
    foreground = undefined;
    foregroundGeneration += 1;
  };
  const diagnoseUnknownStatus = (signal: string) => {
    if (unknownStatusDiagnosed) return;
    unknownStatusDiagnosed = true;
    logger.warn("provider.status.unknown", {
      connectionId,
      signal,
      behavior: "preserving provider-labelled stock payload until a foreground operation succeeds",
    });
  };
  const notificationSink = (method: string, params: unknown) => {
    if (method === "error" && params && typeof params === "object") {
      const failure = params as { threadId?: unknown; error?: { message?: unknown } };
      if (typeof failure.threadId === "string" && typeof failure.error?.message === "string") {
        emitSystemError(failure.threadId, failure.error.message);
        if (claude.ownsThread(failure.threadId)) return;
      }
    }
    if (method === "serverRequest/resolved" && params && typeof params === "object") {
      const requestId = (params as { requestId?: unknown }).requestId;
      if (typeof requestId === "string") {
        const wireParams = { ...params as Record<string, unknown>, requestId: serverRequestIds.wireId(requestId) };
        sendJson({ method, params: wireParams });
        serverRequestIds.release(requestId);
        return;
      }
    }
    sendJson({ method, params });
  };
  const serverRequestSink = (id: string, method: string, params: unknown) => {
    sendJson({ id: serverRequestIds.wireId(id), method, params });
  };
  subscriptions.attach(connectionId, notificationSink, serverRequestSink);
  claude.subscribeRateLimits(connectionId, (response) => {
    if (foreground?.provider === "claude") emitRateLimits(response);
  });
  const subscribedClaudeThreads = new Set<string>();
  const subscribeClaude = (threadId: string) => {
    if (!connectionAlive
      || !subscriptions.subscribe(threadId, connectionId, notificationSink, serverRequestSink)) return false;
    subscribedClaudeThreads.add(threadId);
    claude.cancelEphemeralRelease(threadId);
    return true;
  };
  const muteClaudeDuringSnapshot = (threadId: string) => {
    subscribeClaude(threadId);
    subscriptions.mute(threadId, connectionId);
  };

  client.on("message", async (data, isBinary) => {
    recorder.frame(connectionId, "client_to_gateway", data, isBinary);
    const message = isBinary ? undefined : parseRpcMessage(data);
    const internalServerRequestId = message && isResponse(message)
      ? serverRequestIds.internalId(message.id)
      : undefined;
    if (message && isResponse(message) && internalServerRequestId) {
      const response = "result" in message ? message.result : { rpcError: message.error };
      if (handoffs.resolveStockServerRequest
        && await handoffs.resolveStockServerRequest(internalServerRequestId, response)) return;
      if (!await claude.resolveServerRequest(internalServerRequestId, response)) {
        logger.warn("claude.interaction.unknown-response", { connectionId, requestId: internalServerRequestId });
      }
      return;
    }
    if (message && isRequest(message)) {
      requestStarted.set(requestKey(message.id), performance.now());
      try {
        if (message.method === "remoteControl/status/read" && remoteControl?.current()) {
          sendResult(message.id, remoteControl.current());
          return;
        }
        if (message.method === "model/list") {
          sendResult(message.id, await mergedModelList(
            (message.params ?? {}) as ModelListParams,
            stockRpc,
            claudeModels,
            logger,
            cursors,
          ));
          return;
        }
        if (message.method === "account/rateLimits/read" && foreground?.provider === "claude") {
          const backend = handoffs.logical?.(foreground.threadId)?.epoch.backendThreadId ?? foreground.threadId;
          sendResult(message.id, await claude.readRateLimits(backend));
          return;
        }
        if (message.method === "account/usage/read" && foreground?.provider === "claude") {
          // The captured App status flow does not request this method. If a
          // client does, lifetime/streak Codex statistics have no Claude
          // equivalent and must not be mislabelled as provider usage.
          sendResult(message.id, {
            summary: {
              lifetimeTokens: null,
              peakDailyTokens: null,
              longestRunningTurnSec: null,
              currentStreakDays: null,
              longestStreakDays: null,
            },
            dailyUsageBuckets: null,
          });
          return;
        }
        if (message.method === "account/rateLimits/read" && !foreground) diagnoseUnknownStatus("account/rateLimits/read");
        if (message.method === "thread/list") {
          sendResult(message.id, await mergedThreadList(
            (message.params ?? {}) as ThreadListParams,
            stockRpc,
            claude,
            cursors,
            handoffs,
            stockSideThreads,
          ));
          return;
        }
        if (message.method === "thread/loaded/list") {
          sendResult(message.id, await mergedLoadedList(
            (message.params ?? {}) as ThreadLoadedListParams,
            stockRpc,
            claude,
            cursors,
            handoffs,
            stockSideThreads,
          ));
          return;
        }
        if (message.method === "thread/start") {
          const params = (message.params ?? {}) as ThreadStartParams;
          if (params.model && claude.ownsModel(params.model)) {
            const result = await claude.startThread(params);
            handoffs.observeDurableThread(connectionId, "claude");
            sendResult(message.id, result);
            selectForeground("claude", result.thread.id);
            subscribeClaude(result.thread.id);
            await claude.announceThread(result.thread);
            emitFastTransition(
              result.thread.id,
              undefined,
              claude.currentThreadSettings(result.thread.id),
              params.serviceTier,
            );
            return;
          }
        }

        const params = (message.params ?? {}) as { threadId?: string };
        if (params.threadId && message.method === "turn/start"
          && (claude.ownsThread(params.threadId)
            || handoffs.logical?.(params.threadId)?.epoch.provider === "claude")) {
          const backend = handoffs.logical?.(params.threadId)?.epoch.backendThreadId ?? params.threadId;
          if (!claude.isChildProjection(backend)) {
            const promptedCompact = claudeCompactCommand(
              ((message.params ?? {}) as TurnStartParams).input,
            );
            if (promptedCompact) {
              const prepared = await claude.preparePromptedCompact(backend, promptedCompact);
              sendResult(message.id, prepared.response);
              selectForeground("claude", params.threadId);
              await prepared.announce();
              return;
            }
          }
        }
        if (params.threadId && message.method === "turn/start" && features.statusCommand) {
          const turn = (message.params ?? {}) as TurnStartParams;
          if (isCCodexStateCommand(turn.input)) {
            if (claude.ownsThread(params.threadId) && !claude.isChildProjection(params.threadId)) {
              const prepared = await claude.prepareStateTurn(
                turn,
                () => threadState(params.threadId!),
              );
              sendResult(message.id, prepared.response);
              selectForeground("claude", params.threadId);
              await prepared.announce();
              prepared.start();
            } else {
              const notice = transientCommandNotice(
                params.threadId,
                turn.input,
                await threadState(params.threadId),
                turn.clientUserMessageId ?? null,
              );
              sendResult(message.id, notice.response);
              selectForeground(claude.ownsThread(params.threadId) ? "claude" : "codex", params.threadId);
              emitNotice(notice);
            }
            return;
          }
          if (isCCodexStatusCommand(turn.input)) {
            if (claude.ownsThread(params.threadId) && !claude.isChildProjection(params.threadId)) {
              const prepared = await claude.prepareStatusTurn(
                turn,
                () => combinedStatus(params.threadId),
              );
              sendResult(message.id, prepared.response);
              selectForeground("claude", params.threadId);
              await prepared.announce();
              prepared.start();
            } else {
              const notice = transientCommandNotice(
                params.threadId,
                turn.input,
                await combinedStatus(claude.ownsThread(params.threadId) ? params.threadId : undefined),
                turn.clientUserMessageId ?? null,
              );
              sendResult(message.id, notice.response);
              selectForeground(claude.ownsThread(params.threadId) ? "claude" : "codex", params.threadId);
              emitNotice(notice);
            }
            return;
          }
        }
        if (params.threadId && message.method === "turn/start"
          && (handoffs.logical?.(params.threadId)?.epoch.provider === "stock"
            || (!handoffs.logical?.(params.threadId) && !claude.ownsThread(params.threadId)))
          && providerAvailability) {
          let availability = await providerAvailability.read("codex");
          if (availability.state !== "ready") availability = await providerAvailability.refresh("codex");
          if (availability.state !== "ready") {
            const notice = transientSystemNotice(
              params.threadId,
              providerUnavailableMessage(availability),
              "error",
            );
            sendResult(message.id, notice.response);
            selectForeground("codex", params.threadId);
            emitNotice(notice);
            return;
          }
        }
        if (params.threadId && message.method === "turn/start") {
          handoffs.observeDurableTurn(connectionId, (message.params ?? {}) as TurnStartParams);
        }
        if (params.threadId && message.method === "thread/settings/update") {
          const update = (message.params ?? {}) as ThreadSettingsUpdateParams;
          const staged = handoffs.interceptSettings(update);
          if (staged.handled) {
            sendResult(message.id, {});
            if (staged.notification) sendJson({
              method: "thread/settings/updated",
              params: { threadId: params.threadId, threadSettings: staged.notification },
            });
            return;
          }
        }
        if (params.threadId && message.method === "turn/start") {
          const turn = (message.params ?? {}) as TurnStartParams;
          const pending = handoffs.stageTurnSwitch
            ? handoffs.stageTurnSwitch(turn)
            : handoffs.pending(params.threadId);
          if (pending) {
            subscriptions.subscribe(params.threadId, connectionId, notificationSink, serverRequestSink);
            const migration = providerMigrationNotice(params.threadId);
            sendResult(message.id, migration.response);
            for (const notification of migration.notifications) {
              subscriptions.emitPublic(params.threadId, notification.method, notification.params);
            }
            const execute = async () => {
              const switchProviderTurn = (handoffs as CrossProviderForks & {
                switchProviderTurn?: (
                  params: TurnStartParams,
                  compactionTurn: typeof migration.response.turn,
                  stock: StockRpc,
                  connectionId: string,
                  compacted: () => void,
                ) => Promise<void>;
              }).switchProviderTurn;
              let compacted = false;
              const completeCompaction = () => {
                if (compacted) return;
                compacted = true;
                for (const notification of providerMigrationCompleted(params.threadId!, migration)) {
                  subscriptions.emitPublic(params.threadId!, notification.method, notification.params);
                }
              };
              if (switchProviderTurn) {
                await switchProviderTurn.call(
                  handoffs, turn, migration.response.turn, stockRpc, connectionId, completeCompaction,
                );
                selectForeground(pending.targetProvider === "claude" ? "claude" : "codex", params.threadId!);
                return;
              }
              if (pending.sourceProvider === "claude") {
                const hidden = await claude.forkThread({
                  threadId: params.threadId!, ephemeral: true, threadSource: "subAgent",
                } as ThreadForkParams);
                await claude.compactThread(hidden.thread.id);
                const target = await stockRpc.request("thread/start", {
                  model: pending.targetModel,
                  cwd: turn.cwd,
                  approvalPolicy: turn.approvalPolicy,
                  permissions: turn.permissions,
                }) as { thread: { id: string } };
                completeCompaction();
                await stockRpc.request("turn/start", { ...turn, threadId: target.thread.id });
                selectForeground("codex", params.threadId!);
                return;
              }
              const hidden = await stockRpc.request("thread/fork", {
                threadId: params.threadId, ephemeral: true, excludeTurns: true,
              }) as { thread: { id: string } };
              await stockRpc.request("turn/start", {
                threadId: hidden.thread.id,
                input: [{ type: "text", text: "Compact this task for a provider handoff.", text_elements: [] }],
              });
              const target = await claude.startThread({
                model: pending.targetModel,
                ...(turn.cwd !== undefined ? { cwd: turn.cwd } : {}),
                ...(turn.approvalPolicy !== undefined ? { approvalPolicy: turn.approvalPolicy } : {}),
                ...(turn.permissions !== undefined ? { permissions: turn.permissions } : {}),
              });
              const prepared = await claude.prepareTurn({ ...turn, threadId: target.thread.id });
              completeCompaction();
              await prepared.announce();
              prepared.start();
              selectForeground("claude", params.threadId!);
            };
            void execute().catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              for (const notification of providerMigrationFailed(
                params.threadId!,
                migration,
                message,
              )) subscriptions.emitPublic(params.threadId!, notification.method, notification.params);
              for (const notification of transientSystemNotice(
                params.threadId!,
                `Provider switch failed; your message was not sent\n  ↳ ${message}`,
                "error",
              ).notifications) subscriptions.emitPublic(params.threadId!, notification.method, notification.params);
              const source = handoffs.logical?.(params.threadId!);
              if (source) subscriptions.emitPublic(params.threadId!, "thread/settings/updated", {
                threadId: params.threadId!,
                threadSettings: {
                  ...source.epoch.settings,
                  model: source.epoch.model,
                  modelProvider: source.epoch.provider === "claude" ? "claude" : "openai",
                },
              });
            });
            return;
          }
        }
        if (params.threadId && handoffs.logical?.(params.threadId)
          && message.method !== "thread/fork" && message.method !== "thread/rollback") {
          if (message.method === "thread/unsubscribe") {
            subscriptions.unsubscribe(params.threadId, connectionId);
            sendResult(message.id, { status: "unsubscribed" });
            clearForeground(params.threadId);
            return;
          }
          subscriptions.subscribe(params.threadId, connectionId, notificationSink, serverRequestSink);
          const handled = await handoffs.requestLogical(
            message.method,
            (message.params ?? {}) as Record<string, unknown>,
            stockRpc,
          );
          sendResult(message.id, handled.result);
          selectForeground(handled.provider === "claude" ? "claude" : "codex", params.threadId);
          await handled.after?.();
          return;
        }
        if (params.threadId && message.method === "turn/start") {
          const target = handoffs.blockedTurnTarget((message.params ?? {}) as TurnStartParams);
          if (target) {
            const notice = transientSystemNotice(
              params.threadId,
              `Provider change to '${target}' requires Fork. The source task was not modified. Choose Fork to migrate history, or select a source-provider model to continue here.`,
            );
            sendResult(message.id, notice.response);
            emitNotice(notice);
            return;
          }
        }
        if (params.threadId && message.method === "thread/fork") {
          const forkParams = (message.params ?? {}) as ThreadForkParams;
          if (handoffs.isSystemEphemeralFork(forkParams)) {
            sendResult(message.id, await handoffs.forkSystemEphemeral(forkParams, stockRpc, connectionId));
            return;
          }
          const logicalFork = (handoffs as CrossProviderForks & {
            forkLogical?: (params: ThreadForkParams, stock: StockRpc) => Promise<unknown>;
          }).forkLogical;
          const overlay = handoffs.overlay(params.threadId) as unknown as {
            epochs?: Array<{ provider: "stock" | "claude"; backendThreadId: string; publicTurnIds: string[] }>;
          } | undefined;
          if ((logicalFork && handoffs.logical?.(params.threadId)) || overlay?.epochs) {
            if (logicalFork) {
              sendResult(message.id, await logicalFork.call(handoffs, forkParams, stockRpc));
              return;
            }
            const turns = overlay!.epochs!.flatMap((epoch) =>
              epoch.publicTurnIds.map((id) => ({ id, items: [], status: "completed" })));
            sendResult(message.id, { thread: { id: uuidv7(), forkedFromId: params.threadId, turns } });
            return;
          }
          if (forkParams.model) {
            const sourceProvider = claude.ownsThread(params.threadId) ? "claude" : "stock";
            const targetProvider = claude.ownsModel(forkParams.model) ? "claude" : "stock";
            if (sourceProvider !== targetProvider) {
              throw new RpcError(
                -32602,
                "Fork is same-provider only. Change the model and send a message to switch provider.",
              );
            }
          }
        }
        if (params.threadId && message.method === "thread/delete"
          && handoffs.ownsSystemEphemeral(connectionId, params.threadId)) {
          const result = await stockRpc.request("thread/delete", message.params ?? {});
          handoffs.releaseSystemEphemeral(connectionId, params.threadId);
          sendResult(message.id, result);
          return;
        }
        if (params.threadId && message.method === "thread/unsubscribe"
          && handoffs.ownsSystemEphemeral(connectionId, params.threadId)) {
          const result = await stockRpc.request("thread/unsubscribe", message.params ?? {});
          handoffs.releaseSystemEphemeral(connectionId, params.threadId);
          sendResult(message.id, result);
          return;
        }
        if (params.threadId && message.method === "thread/delete" && !claude.ownsThread(params.threadId)
          && (handoffs.pending(params.threadId) || handoffs.overlay(params.threadId))) {
          const result = await stockRpc.request("thread/delete", message.params ?? {});
          handoffs.clearThread(params.threadId);
          sendResult(message.id, result);
          clearForeground(params.threadId);
          return;
        }
        if (params.threadId && message.method === "thread/rollback" && handoffs.logical?.(params.threadId)) {
          sendResult(message.id, await handoffs.rollbackLogicalFork(
            (message.params ?? {}) as ThreadRollbackParams,
            stockRpc,
            connectionId,
          ));
          return;
        }
        if (params.threadId && handoffs.overlay(params.threadId)) {
          if (message.method === "thread/rollback") {
            const rollback = (message.params ?? {}) as ThreadRollbackParams;
            const logicalRollback = (handoffs as CrossProviderForks & {
              rollbackLogicalFork?: (
                params: ThreadRollbackParams,
                stock: StockRpc,
                connectionId?: string,
              ) => Promise<unknown>;
            }).rollbackLogicalFork;
            if (logicalRollback) {
              sendResult(message.id, await logicalRollback.call(handoffs, rollback, stockRpc, connectionId));
              return;
            }
            const overlay = handoffs.overlay(params.threadId) as unknown as {
              epochs?: Array<{ provider: "stock" | "claude"; backendThreadId: string; publicTurnIds: string[] }>;
            };
            if (overlay.epochs) {
              const turns = overlay.epochs.flatMap((epoch) =>
                epoch.publicTurnIds.map((turnId) => ({ epoch, turnId })));
              const selected = turns.at(turns.length - rollback.numTurns - 1);
              if (!selected) throw new RpcError(-32602, "Fork rollback removed every provider turn.");
              if (selected.epoch.provider === "claude") {
                await claude.forkThread({
                  threadId: selected.epoch.backendThreadId,
                  lastTurnId: selected.turnId,
                } as ThreadForkParams);
              } else {
                await stockRpc.request("thread/fork", {
                  threadId: selected.epoch.backendThreadId,
                  lastTurnId: selected.turnId,
                });
              }
              sendResult(message.id, {});
              return;
            }
          }
          if (message.method === "thread/read") {
            sendResult(message.id, await handoffs.readOverlay((message.params ?? {}) as ThreadReadParams, stockRpc));
            return;
          }
          if (message.method === "thread/resume") {
            sendResult(message.id, await handoffs.resumeOverlay((message.params ?? {}) as ThreadResumeParams, stockRpc));
            selectForeground("codex", params.threadId);
            return;
          }
          if (message.method === "thread/turns/list") {
            sendResult(message.id, await handoffs.turnsOverlay((message.params ?? {}) as ThreadTurnsListParams, stockRpc));
            return;
          }
          if (message.method === "thread/items/list") {
            sendResult(message.id, await handoffs.itemsOverlay((message.params ?? {}) as ThreadItemsListParams, stockRpc));
            return;
          }
        }
        if (params.threadId && claude.ownsThread(params.threadId)) {
          if (message.method === "thread/resume") {
            muteClaudeDuringSnapshot(params.threadId);
            try {
              const prepared = await claude.prepareResume((message.params ?? {}) as ThreadResumeParams);
              const result = prepared.response;
              const snapshotHighWatermark = claude.eventHighWatermark(params.threadId);
              const tokenUsage = claude.latestTokenUsage(params.threadId);
              sendResult(message.id, result);
              selectForeground("claude", params.threadId);
              subscriptions.unmute(params.threadId, connectionId);
              if (tokenUsage && tokenUsage.sequence <= snapshotHighWatermark) {
                notificationSink(tokenUsage.method, tokenUsage.params);
              }
              for (const event of claude.eventsAfter(params.threadId, snapshotHighWatermark)) {
                notificationSink(event.method, event.params);
              }
              await prepared.notifyGoalSnapshot(notificationSink);
              await claude.replayPendingRequests(params.threadId, connectionId);
              const failedFork = handoffs.claimFailedFork(params.threadId);
              if (failedFork) emitTransientNotice(
                params.threadId,
                `Cross-provider fork failed while the App was disconnected: ${failedFork}`,
                "error",
              );
            } catch (error) {
              subscriptions.unmute(params.threadId, connectionId);
              subscriptions.unsubscribe(params.threadId, connectionId);
              throw error;
            }
            return;
          }
          if (message.method === "thread/read") {
            const read = (message.params ?? {}) as ThreadReadParams;
            sendResult(message.id, claude.readThread(read.threadId, read.includeTurns ?? false));
            const failedFork = handoffs.claimFailedFork(params.threadId);
            if (failedFork) emitTransientNotice(
              params.threadId,
              `Cross-provider fork failed while the App was disconnected: ${failedFork}`,
              "error",
            );
            return;
          }
          if (message.method === "thread/turns/list") {
            const list = (message.params ?? {}) as ThreadTurnsListParams;
            sendResult(message.id, claude.turnsPage(list));
            return;
          }
          if (message.method === "thread/items/list") {
            sendResult(message.id, claude.listItems((message.params ?? {}) as ThreadItemsListParams));
            return;
          }
          if (message.method === "thread/unsubscribe") {
            subscriptions.unsubscribe(params.threadId, connectionId);
            subscribedClaudeThreads.delete(params.threadId);
            sendResult(message.id, { status: "unsubscribed" });
            clearForeground(params.threadId);
            if (!subscriptions.hasSubscribers(params.threadId)) await claude.releaseEphemeralThread(params.threadId);
            return;
          }
          if (message.method === "thread/name/set") {
            sendResult(message.id, await claude.setThreadName((message.params ?? {}) as ThreadSetNameParams));
            return;
          }
          if (message.method === "thread/metadata/update") {
            sendResult(message.id, await claude.updateThreadMetadata(
              (message.params ?? {}) as ThreadMetadataUpdateParams,
            ));
            return;
          }
          if (message.method === "thread/settings/update") {
            const update = (message.params ?? {}) as ThreadSettingsUpdateParams;
            const before = claude.currentThreadSettings(params.threadId);
            const result = await claude.updateThreadSettings(update);
            const after = claude.currentThreadSettings(params.threadId);
            sendResult(message.id, result);
            emitFastTransition(params.threadId, before, after, update.serviceTier);
            return;
          }
          if (message.method === "thread/archive") {
            sendResult(message.id, await claude.archiveThread(params.threadId));
            return;
          }
          if (message.method === "thread/unarchive") {
            sendResult(message.id, await claude.unarchiveThread(params.threadId));
            return;
          }
          if (message.method === "thread/delete") {
            const result = await claude.deleteThread(params.threadId);
            handoffs.clearThread(params.threadId);
            sendResult(message.id, result);
            clearForeground(params.threadId);
            return;
          }
          if (message.method === "thread/fork") {
            const result = await claude.forkThread((message.params ?? {}) as ThreadForkParams);
            sendResult(message.id, result);
            selectForeground("claude", result.thread.id);
            subscribeClaude(result.thread.id);
            await claude.announceThread(result.thread);
            return;
          }
          if (message.method === "thread/rollback") {
            sendResult(message.id, await claude.rollbackThread((message.params ?? {}) as ThreadRollbackParams));
            return;
          }
          if (message.method === "thread/compact/start") {
            sendResult(message.id, await claude.compactThread(params.threadId));
            return;
          }
          if (message.method === "thread/inject_items") {
            sendResult(message.id, await claude.injectItems((message.params ?? {}) as ThreadInjectItemsParams));
            return;
          }
          if (message.method === "thread/shellCommand") {
            sendResult(message.id, await claude.shellCommand((message.params ?? {}) as ThreadShellCommandParams));
            return;
          }
          if (message.method === "thread/backgroundTerminals/clean") {
            sendResult(message.id, await claude.cleanBackgroundTerminals(
              (message.params ?? {}) as ThreadBackgroundTerminalsCleanParams,
            ));
            return;
          }
          if (message.method === "thread/backgroundTerminals/list") {
            sendResult(message.id, await claude.listBackgroundTerminals(
              (message.params ?? {}) as ThreadBackgroundTerminalsListParams,
            ));
            return;
          }
          if (message.method === "thread/backgroundTerminals/terminate") {
            sendResult(message.id, await claude.terminateBackgroundTerminal(
              (message.params ?? {}) as ThreadBackgroundTerminalsTerminateParams,
            ));
            return;
          }
          if (message.method === "review/start") {
            const prepared = await claude.prepareReview((message.params ?? {}) as ReviewStartParams);
            if (prepared.forkedThread) {
              subscribeClaude(prepared.forkedThread.id);
              await claude.announceThread(prepared.forkedThread);
            }
            sendResult(message.id, prepared.response);
            await prepared.announce();
            prepared.start();
            return;
          }
          if (message.method === "thread/goal/set") {
            const prepared = await claude.prepareGoalSet((message.params ?? {}) as ThreadGoalSetParams);
            try {
              sendResult(message.id, prepared.response);
            } finally {
              await prepared.notify();
            }
            return;
          }
          if (message.method === "thread/goal/get") {
            sendResult(message.id, await claude.getGoal(params.threadId));
            return;
          }
          if (message.method === "thread/goal/clear") {
            const prepared = await claude.prepareGoalClear(params.threadId);
            try {
              sendResult(message.id, prepared.response);
            } finally {
              await prepared.notify();
            }
            return;
          }
          if (message.method === "turn/start") {
            const turn = (message.params ?? {}) as TurnStartParams;
            const before = claude.currentThreadSettings(params.threadId);
            const prepared = await claude.prepareTurn(turn);
            const after = claude.currentThreadSettings(params.threadId);
            sendResult(message.id, prepared.response);
            selectForeground("claude", params.threadId);
            emitFastTransition(params.threadId, before, after, turn.serviceTier);
            await prepared.announce();
            prepared.start();
            return;
          }
          if (message.method === "turn/interrupt") {
            await claude.interruptTurn((message.params ?? {}) as TurnInterruptParams);
            sendResult(message.id, {});
            return;
          }
          if (message.method === "turn/steer") {
            sendResult(message.id, await claude.steerTurn((message.params ?? {}) as TurnSteerParams));
            return;
          }
          throw new RpcError(-32601, `Method '${message.method}' is not implemented for Claude threads yet.`);
        }
        if (params.threadId && (message.method === "thread/read" || message.method === "thread/resume")) {
          const failedFork = handoffs.claimFailedFork(params.threadId);
          if (failedFork) emitTransientNotice(
            params.threadId,
            `Cross-provider fork failed while the App was disconnected: ${failedFork}`,
            "error",
          );
        }
      } catch (error) {
        const failure = rpcError(error);
        logger.warn("claude.request.failed", {
          connectionId,
          method: message.method,
          code: failure.code,
          error: failure.message,
        });
        const params = message.params && typeof message.params === "object"
          ? message.params as Record<string, unknown>
          : undefined;
        const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
        const childProjection = Boolean(threadId && claude.isChildProjection(threadId));
        if (message.method === "turn/start" && threadId && !childProjection) {
          const notice = transientSystemNotice(threadId, failure.message, "error");
          sendResult(message.id, notice.response);
          emitNotice(notice);
          return;
        }
        if (threadId && !childProjection) emitSystemError(threadId, failure.message);
        sendError(message.id, failure.code, failure.message);
        if (threadId && !childProjection) {
          if (claude.ownsThread(threadId)) {
            await claude.reportError(
              threadId,
              typeof params?.turnId === "string" ? params.turnId : undefined,
              failure.message,
              rpcCodexErrorInfo(failure.code),
            ).catch((diagnosticError: unknown) => {
              logger.warn("claude.request.error-report-failed", {
                connectionId,
                method: message.method,
                originalError: failure.message,
                diagnosticError: diagnosticError instanceof Error
                  ? diagnosticError.message
                  : String(diagnosticError),
              });
            });
          } else {
            sendJson({
              method: "error",
              params: {
                error: { message: failure.message, codexErrorInfo: rpcCodexErrorInfo(failure.code), additionalDetails: null },
                willRetry: false,
                threadId,
                turnId: typeof params?.turnId === "string" ? params.turnId : uuidv7(),
              },
            });
          }
        }
        return;
      }
    }
    let forwarded = message;
    if (message && isRequest(message) && message.method === "turn/start") {
      const params = handoffs.prepareTitleTurn(connectionId, (message.params ?? {}) as TurnStartParams);
      if (params !== message.params) forwarded = { ...message, params };
    }
    if (message && isRequest(message) && message.method === "thread/fork") {
      const params = (message.params ?? {}) as ThreadForkParams;
      if (params.ephemeral !== true && params.threadSource !== "system") {
        const completed = stockState.completeForkParams(params);
        if (completed !== params) forwarded = { ...message, params: completed };
      }
    }
    if (forwarded && stockSideThreads) {
      forwarded = await stockSideThreads.prepareRequest(connectionId, forwarded, stockRpc);
    }
    if (forwarded) stockState.observeRequest(connectionId, forwarded);
    trackForwardedRequest(forwarded);
    if (stock.readyState === WebSocketState.OPEN) {
      stock.send(forwarded === message ? data : JSON.stringify(forwarded), { binary: isBinary });
    } else {
      queued.push({ data: forwarded === message ? data : Buffer.from(JSON.stringify(forwarded)), isBinary });
    }
  });

  stock.once("open", () => {
    for (const message of queued.splice(0)) {
      stock.send(message.data, { binary: message.isBinary });
    }
  });

  stock.on("message", (data, isBinary) => {
    const incoming = isBinary ? undefined : parseRpcMessage(data);
    let message = incoming;
    if (message) {
      stockState.observeResponse(connectionId, message);
      stockState.observeNotification(message);
    }
    if (message && stockRpc.handle(message)) return;
    if (message && stockSideThreads) message = stockSideThreads.projectMessage(connectionId, message);
    let foregroundAfterForward: (() => void) | undefined;
    if (message && "method" in message && !("id" in message) && message.method === "remoteControl/status/changed" && remoteControl) {
      remoteControl.intercept(connectionId, notificationSink, message.params);
      return;
    }
    if (message && isResponse(message)) {
      completeLatency(message.id, "stock");
      const forwarded = forwardedRequests.get(requestKey(message.id));
      forwardedRequests.delete(requestKey(message.id));
      if (forwarded?.systemEphemeral && "result" in message) {
        const result = message.result && typeof message.result === "object"
          ? message.result as { thread?: { id?: unknown } }
          : undefined;
        if (typeof result?.thread?.id === "string") {
          handoffs.registerForwardedEphemeralCandidate(connectionId, result.thread.id, forwarded.systemEphemeral);
        }
      }
      if (forwarded?.threadId && isUuid(forwarded.threadId) && "error" in message) {
        emitSystemError(forwarded.threadId, message.error.message);
      }
      if (forwarded && "result" in message) {
        const result = message.result && typeof message.result === "object"
          ? message.result as { thread?: { id?: unknown } }
          : undefined;
        const resultThreadId = typeof result?.thread?.id === "string" ? result.thread.id : forwarded.threadId;
        if (forwarded.foreground && resultThreadId) {
          handoffs.observeDurableThread(connectionId, "stock");
          foregroundAfterForward = () => selectForeground(forwarded.foreground!, resultThreadId);
        } else if (forwarded.clearForeground && forwarded.threadId) {
          foregroundAfterForward = () => clearForeground(forwarded.threadId!);
        }
      }
    }
    if (message && "method" in message) {
      if (!("id" in message) && message.method === "account/rateLimits/updated" && foreground?.provider === "claude") {
        publishForegroundRateLimits(foregroundGeneration);
        return;
      }
      if (!("id" in message) && message.method === "account/rateLimits/updated" && !foreground) {
        diagnoseUnknownStatus("account/rateLimits/updated");
      }
      if (handoffs.captureInternalStockMessage(connectionId, message)) {
        if (isRequest(message)) stock.send(JSON.stringify({ id: message.id, result: { decision: "decline" } }));
        return;
      }
      const rewritten = handoffs.rewriteTitleMessages(message);
      if (rewritten) {
        for (const output of rewritten) sendJson(output);
        return;
      }
      if (handoffs.suppressStockTargetMessage(connectionId, message)) {
        if (isRequest(message)) stock.send(JSON.stringify({ id: message.id, result: { decision: "decline" } }));
        return;
      }
      if (handoffs.ownsStockBackendMessage?.(message)) {
        if (isRequest(message)) stock.send(JSON.stringify({ id: message.id, result: { decision: "decline" } }));
        return;
      }
      const params = message.params && typeof message.params === "object" ? message.params as Record<string, unknown> : undefined;
      const nestedThread = params?.thread && typeof params.thread === "object"
        ? (params.thread as { id?: unknown }).id
        : undefined;
      const threadId = typeof params?.threadId === "string"
        ? params.threadId
        : typeof nestedThread === "string" ? nestedThread : undefined;
      if (message.method === "error" && threadId) {
        const error = params?.error && typeof params.error === "object"
          ? params.error as { message?: unknown }
          : undefined;
        if (typeof error?.message === "string") emitSystemError(threadId, error.message);
      }
    }
    if (client.readyState === WebSocketState.OPEN) {
      const outbound = message === incoming ? data : JSON.stringify(message);
      recorder.frame(connectionId, "gateway_to_client", outbound, isBinary && message === incoming);
      client.send(outbound, { binary: isBinary && message === incoming });
    }
    foregroundAfterForward?.();
  });

  const closeClient = (code: number, reason: string) => {
    if (client.readyState === WebSocketState.OPEN) client.close(code, reason);
  };
  stock.on("error", (error) => {
    logger.error("connection.stock.error", { connectionId, error: error.message });
    closeClient(1011, "Stock app-server connection failed");
  });
  stock.on("close", () => closeClient(1011, "Stock app-server closed"));
  client.on("error", (error) => logger.warn("connection.client.error", { connectionId, error: error.message }));
  let closeStarted = false;
  client.on("close", (code, reason) => {
    if (closeStarted) return;
    closeStarted = true;
    connectionAlive = false;
    void (async () => {
      metrics.connectionClosed();
      const releasedThreads = [...subscribedClaudeThreads];
      subscribedClaudeThreads.clear();
      subscriptions.detach(connectionId);
      claude.unsubscribeRateLimits(connectionId);
      const releases = await Promise.allSettled(releasedThreads.map(async (threadId) => {
        if (!subscriptions.hasSubscribers(threadId)) claude.scheduleEphemeralRelease(threadId);
      }));
      remoteControl?.detach(connectionId);
      let detach: unknown;
      try {
        await handoffs.detachConnection(connectionId, stockRpc);
      } catch (error) {
        detach = error;
      }
      stockState.detach(connectionId);
      stockSideThreads?.detachConnection(connectionId);
      stockRpc.close(new Error("Client connection closed."));
      if (stock.readyState === WebSocketState.OPEN || stock.readyState === WebSocketState.CONNECTING) {
        stock.close();
      }
      logger.info("connection.closed", { connectionId });
      recorder.connection("closed", connectionId, { code, reason: reason.toString("utf8") });
      const errors = [
        ...releases.flatMap((result) => result.status === "rejected" ? [result.reason] : []),
        ...(detach === undefined ? [] : [detach]),
      ];
      if (errors.length > 0) throw new AggregateError(errors, "Client connection cleanup failed.");
    })().then(resolveClosed, rejectClosed);
  });
  return { closed };
}
