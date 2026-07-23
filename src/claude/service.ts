import { join, resolve } from "node:path";
import { statSync } from "node:fs";
import {
  deleteSession, renameSession, type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { v7 as uuidv7 } from "uuid";
import type { Thread } from "../codex/generated/v2/Thread.js";
import type { ThreadReadResponse } from "../codex/generated/v2/ThreadReadResponse.js";
import type { ThreadSetNameParams } from "../codex/generated/v2/ThreadSetNameParams.js";
import type { ThreadMetadataUpdateParams } from "../codex/generated/v2/ThreadMetadataUpdateParams.js";
import type { ThreadItemsListParams } from "../codex/generated/v2/ThreadItemsListParams.js";
import type { ThreadItemsListResponse } from "../codex/generated/v2/ThreadItemsListResponse.js";
import type { ThreadGoal } from "../codex/generated/v2/ThreadGoal.js";
import type { ThreadGoalSetParams } from "../codex/generated/v2/ThreadGoalSetParams.js";
import type { ThreadForkParams } from "../codex/generated/v2/ThreadForkParams.js";
import type { ThreadForkResponse } from "../codex/generated/v2/ThreadForkResponse.js";
import type { ThreadRollbackParams } from "../codex/generated/v2/ThreadRollbackParams.js";
import type { ThreadRollbackResponse } from "../codex/generated/v2/ThreadRollbackResponse.js";
import type { ThreadSettingsUpdateParams } from "../codex/generated/v2/ThreadSettingsUpdateParams.js";
import type { ThreadSettings } from "../codex/generated/v2/ThreadSettings.js";
import type { ThreadInjectItemsParams } from "../codex/generated/v2/ThreadInjectItemsParams.js";
import type { ThreadShellCommandParams } from "../codex/generated/v2/ThreadShellCommandParams.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import type { CodexErrorInfo } from "../codex/generated/v2/CodexErrorInfo.js";
import type { ThreadItem } from "../codex/generated/v2/ThreadItem.js";
import type { ReviewStartParams } from "../codex/generated/v2/ReviewStartParams.js";
import type { ReviewStartResponse } from "../codex/generated/v2/ReviewStartResponse.js";
import type { ThreadResumeResponse } from "../codex/generated/v2/ThreadResumeResponse.js";
import type { ThreadResumeParams } from "../codex/generated/v2/ThreadResumeParams.js";
import type { ThreadTurnsListParams } from "../codex/generated/v2/ThreadTurnsListParams.js";
import type { ThreadTurnsListResponse } from "../codex/generated/v2/ThreadTurnsListResponse.js";
import type { ThreadStartParams } from "../codex/generated/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "../codex/generated/v2/ThreadStartResponse.js";
import type { SandboxMode } from "../codex/generated/v2/SandboxMode.js";
import type { SandboxPolicy } from "../codex/generated/v2/SandboxPolicy.js";
import type { ActivePermissionProfile } from "../codex/generated/v2/ActivePermissionProfile.js";
import type { TurnStartParams } from "../codex/generated/v2/TurnStartParams.js";
import type { TurnStartResponse } from "../codex/generated/v2/TurnStartResponse.js";
import type { ApprovalsReviewer } from "../codex/generated/v2/ApprovalsReviewer.js";
import type { TurnSteerParams } from "../codex/generated/v2/TurnSteerParams.js";
import type { TurnInterruptParams } from "../codex/generated/v2/TurnInterruptParams.js";
import type { ThreadBackgroundTerminalsCleanParams } from "../codex/generated/v2/ThreadBackgroundTerminalsCleanParams.js";
import type { ThreadBackgroundTerminalsCleanResponse } from "../codex/generated/v2/ThreadBackgroundTerminalsCleanResponse.js";
import type { ThreadBackgroundTerminalsListParams } from "../codex/generated/v2/ThreadBackgroundTerminalsListParams.js";
import type { ThreadBackgroundTerminalsListResponse } from "../codex/generated/v2/ThreadBackgroundTerminalsListResponse.js";
import type { ThreadBackgroundTerminalsTerminateParams } from "../codex/generated/v2/ThreadBackgroundTerminalsTerminateParams.js";
import type { ThreadBackgroundTerminalsTerminateResponse } from "../codex/generated/v2/ThreadBackgroundTerminalsTerminateResponse.js";
import type { HybridConfig } from "../config/config.js";
import type { SubscriptionHub } from "../gateway/subscriptions.js";
import type { Logger } from "../observability/logger.js";
import type {
  ClaudeThreadRecord, HybridStore, PendingThreadRemoval, TurnProviderBoundary,
} from "../store/HybridStore.js";
import { settingsGeneration, withSettingsFrom } from "../store/HybridStore.js";
import { SqliteHybridStore } from "../store/sqliteStore.js";
import { LayeredHybridStore } from "../store/memoryStore.js";
import { createClaudeQuery, type ClaudeQueryFactory } from "./queryFactory.js";
import { claudeEnvironment } from "./environment.js";
import type { Model } from "../codex/generated/v2/Model.js";
import type { JsonValue } from "../codex/generated/serde_json/JsonValue.js";
import { invalidParams } from "../protocol/errors.js";
import { MetricsRegistry } from "../observability/metrics.js";
import { SdkTranscriptBrancher, type TranscriptBrancher } from "./transcriptBrancher.js";
import {
  ClaudeRateLimitCoordinator,
  type ClaudeRateLimitStatus,
  type ClaudeRateLimitsResponse,
} from "./rateLimits.js";
import { isClaudeStatusCommand } from "./statusCommand.js";
import { systemNoticeText } from "../gateway/transientNotice.js";
import {
  claudeCatalogId,
  normalizeClaudeModelIdentifier,
  normalizeClaudeServiceTier,
  resolveClaudeModel,
} from "./modelSelection.js";
import type {
  ClaudeSessionCommand,
  DesiredSettingsUpdate,
  PreparedGoalMutation,
  PreparedSessionTurn,
  RestartRecovery,
  PreparedThreadAdmin,
  PreparedThreadRemoval,
  SessionBranchSnapshot,
  ShellCancellation,
  ThreadAdminOperation,
  ThreadRemovalKind,
} from "./session/commands.js";
import { ClaudeOutputAdapter } from "./session/outputAdapter.js";
import { branchRevision, ClaudeSessionRepository } from "./session/repository.js";
import { ClaudeSession } from "./session/session.js";
import { ShellRunner } from "./session/shellRunner.js";
import { ClaudeSessionRegistry } from "./sessionRegistry.js";
import { validateResponseItems } from "./responseItemValidation.js";
import {
  providerUnavailableMessage,
  type ProviderAvailabilityProbe,
} from "../runtime/providerAvailability.js";
import {
  isCCodexStateCommand,
  stateModelName,
  type ThreadStateSnapshot,
} from "../state/stateCommand.js";

interface ModelCatalog {
  list(): Promise<Model[]>;
  invalidate?(): void;
}

type PreparedGoalHandle<T> = { readonly response: T; notify(): Promise<void> };
type PreparedResume = {
  readonly response: ThreadResumeResponse;
  notifyGoalSnapshot(notify: (method: string, params: unknown) => void): Promise<void>;
};

async function* idleUsagePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

export interface ClaudeHandoffSource {
  readonly thread: Thread;
  readonly turns: Turn[];
  readonly settings: ThreadSettings;
}

export interface ClaudeThreadAdminEffects {
  rename(sessionId: string, name: string, cwd: string): Promise<void>;
  delete(sessionId: string, cwd: string): Promise<void>;
}

const sdkThreadAdminEffects: ClaudeThreadAdminEffects = {
  rename: async (sessionId, name, cwd) => renameSession(sessionId, name, { dir: cwd }),
  delete: async (sessionId, cwd) => deleteSession(sessionId, { dir: cwd }),
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function existingThreadCwd(value: string): string {
  const cwd = resolve(value);
  try {
    if (statSync(cwd).isDirectory()) return cwd;
  } catch {
    // Project moves should surface as a precise protocol error, not the Claude
    // SDK's misleading native-binary/libc spawn diagnostic.
  }
  throw invalidParams(`Claude thread cwd '${cwd}' does not exist or is not a directory.`);
}

function syncedCollaborationMode(
  value: unknown | null | undefined,
  model: string,
  effort: ThreadSettings["effort"],
): ThreadSettings["collaborationMode"] {
  const mode = (value ?? {
    mode: "default",
    settings: { model, reasoning_effort: effort, developer_instructions: null },
  }) as ThreadSettings["collaborationMode"];
  return { ...mode, settings: { ...mode.settings, model, reasoning_effort: effort } };
}

function turnReasoningEffort(params: TurnStartParams): TurnStartParams["effort"] | undefined {
  return params.collaborationMode?.settings.reasoning_effort ?? params.effort ?? undefined;
}

function sandboxPolicy(mode: SandboxMode | null | undefined, cwd: string): SandboxPolicy {
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function permissionProfileSandboxPolicy(profile: string, cwd: string): SandboxPolicy {
  if (profile === ":read-only") return sandboxPolicy("read-only", cwd);
  if (profile === ":workspace") return sandboxPolicy("workspace-write", cwd);
  if (profile === ":danger-full-access") return sandboxPolicy("danger-full-access", cwd);
  throw invalidParams(`Claude threads do not support Codex permission profile '${profile}'.`);
}

function activePermissionProfile(policy: SandboxPolicy): ActivePermissionProfile | null {
  if (policy.type === "readOnly") return { id: ":read-only", extends: null };
  if (policy.type === "workspaceWrite") return { id: ":workspace", extends: null };
  if (policy.type === "dangerFullAccess") return { id: ":danger-full-access", extends: null };
  return null;
}

function approvalsReviewer(value: ApprovalsReviewer | null | undefined, fallback: ApprovalsReviewer = "user"): ApprovalsReviewer {
  return value ?? fallback;
}

function threadSettings(record: ClaudeThreadRecord): ThreadSettings {
  const sandboxPolicy = record.sandboxPolicy as ThreadSettings["sandboxPolicy"];
  return {
    cwd: record.thread.cwd,
    approvalPolicy: record.approvalPolicy as ThreadSettings["approvalPolicy"],
    approvalsReviewer: record.approvalsReviewer,
    sandboxPolicy,
    activePermissionProfile: activePermissionProfile(sandboxPolicy),
    model: record.modelPickerId,
    modelProvider: "claude",
    serviceTier: record.serviceTier,
    effort: record.reasoningEffort as ThreadSettings["effort"],
    summary: record.reasoningSummary as ThreadSettings["summary"],
    collaborationMode: syncedCollaborationMode(
      record.collaborationMode,
      record.modelPickerId,
      record.reasoningEffort as ThreadSettings["effort"],
    ),
    multiAgentMode: "explicitRequestOnly",
    personality: record.personality as ThreadSettings["personality"],
  };
}

function threadResponse(record: ClaudeThreadRecord, includeTurns: boolean): ThreadStartResponse {
  const {
    sandboxPolicy: sandbox, effort: reasoningEffort, summary: _summary,
    collaborationMode: _collaborationMode, personality: _personality, ...settings
  } = threadSettings(record);
  return {
    ...settings,
    thread: { ...record.thread, turns: includeTurns ? record.thread.turns : [] },
    runtimeWorkspaceRoots: [record.thread.cwd],
    instructionSources: [],
    sandbox,
    reasoningEffort,
  };
}

function clonedTurn(turn: ReturnType<HybridStore["listTurns"]>[number]): Turn {
  return structuredClone(turn);
}

function forkProjection(turn: Turn, targetThreadId: string): Turn {
  const cloned = clonedTurn(turn);
  if (cloned.status === "inProgress") {
    const completedAt = nowSeconds();
    cloned.status = "interrupted";
    cloned.completedAt = completedAt;
    cloned.durationMs = cloned.startedAt === null
      ? null
      : Math.max(0, (completedAt - cloned.startedAt) * 1_000);
  }
  const items: ThreadItem[] = [];
  for (const item of cloned.items) {
    if (item.type === "subAgentActivity") continue;
    items.push(item.type === "collabAgentToolCall" ? {
      ...item,
      senderThreadId: targetThreadId,
      receiverThreadIds: [],
      agentsStates: {},
    } : item);
  }
  cloned.items = items;
  return cloned;
}

function sideReferenceItem(item: ThreadItem): JsonValue {
  const reference: Record<string, JsonValue> = { type: item.type };
  if (item.type === "userMessage") reference.content = item.content as JsonValue;
  if (item.type === "agentMessage") {
    reference.text = item.text;
    reference.phase = item.phase;
  }
  if (item.type === "reasoning") reference.summary = item.summary;
  if (item.type === "commandExecution") {
    reference.command = item.command;
    reference.cwd = item.cwd;
  }
  if (item.type === "fileChange") reference.changes = item.changes as JsonValue;
  if (item.type === "collabAgentToolCall") reference.prompt = item.prompt;
  if (item.type === "dynamicToolCall") reference.tool = item.tool;
  if (item.type === "mcpToolCall") {
    reference.server = item.server;
    reference.tool = item.tool;
  }
  if (item.type === "webSearch") reference.query = item.query;
  if ("status" in item) reference.status = item.status;
  return reference;
}

function sideReferenceSnapshot(sourceThreadId: string, turn: Turn): JsonValue {
  return {
    type: "ccodex_side_parent_snapshot",
    sourceThreadId,
    note: "Reference-only snapshot of the parent turn at fork time. Do not continue or control its live tools.",
    turn: {
      status: turn.status,
      items: turn.items.map(sideReferenceItem),
    },
  };
}

function selectedBoundaryIsStable(
  turn: Turn | undefined,
): turn is Turn {
  return turn?.status === "completed";
}

export const EPHEMERAL_DISCONNECT_GRACE_MS = 60 * 60_000;

export class ClaudeService {
  private readonly ephemeralReleases = new Map<string, Promise<void>>();
  private readonly ephemeralReleaseTimers = new Map<string, NodeJS.Timeout>();
  private readonly removalRetries = new Map<
    string,
    { readonly kind: ThreadRemovalKind; readonly promise: Promise<void> }
  >();
  private readonly terminalAdmins = new Map<string, number>();
  private readonly idleTimer: NodeJS.Timeout;
  private readonly store: HybridStore;
  private readonly sessionOutput: ClaudeOutputAdapter;
  private readonly sessions: ClaudeSessionRegistry<ClaudeSessionCommand, ClaudeSession>;
  private readonly rateLimits: ClaudeRateLimitCoordinator;
  private idleSweep: Promise<void> = Promise.resolve();
  private readonly restartRecovery: Promise<void>;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private standaloneStatusRead: Promise<ClaudeRateLimitStatus> | undefined;

  public constructor(
    private readonly config: HybridConfig,
    private readonly hub: SubscriptionHub,
    private readonly logger: Logger,
    durableStore: HybridStore = new SqliteHybridStore(join(config.dataDir, "state.sqlite")),
    private readonly queryFactory: ClaudeQueryFactory = createClaudeQuery,
    private readonly modelCatalog?: ModelCatalog,
    private readonly metrics: MetricsRegistry = new MetricsRegistry(),
    private readonly transcripts: TranscriptBrancher = new SdkTranscriptBrancher(),
    private readonly threadAdminEffects: ClaudeThreadAdminEffects = sdkThreadAdminEffects,
    shellRunner: ShellRunner = new ShellRunner(),
    private readonly availabilityProbe: ProviderAvailabilityProbe = async () => ({
      provider: "claude",
      state: "ready",
    }),
  ) {
    this.store = new LayeredHybridStore(durableStore);
    const sessionRepository = new ClaudeSessionRepository(this.store);
    this.sessionOutput = new ClaudeOutputAdapter(hub);
    this.rateLimits = new ClaudeRateLimitCoordinator(logger);
    this.sessions = new ClaudeSessionRegistry(
      (threadId) => new ClaudeSession(
        threadId,
        sessionRepository,
        this.sessionOutput,
        undefined,
        metrics,
        undefined,
        (childThreadId) => this.sessions.registerChild(childThreadId, threadId),
        (childThreadId) => this.sessions.unregisterChild(childThreadId),
        shellRunner,
        undefined,
        {
          claudeBinary: this.config.claudeBinary,
          logger: this.logger,
          queryFactory: this.queryFactory,
          transcripts: this.transcripts,
          rateLimits: this.rateLimits,
          invalidateModelCatalog: () => this.modelCatalog?.invalidate?.(),
          isClosing: () => this.closing,
          persistUserSideSessions: this.config.features?.sideChatPromotion ?? true,
          interactiveQuestions: this.config.features?.interactiveQuestions ?? true,
          resolveChildModel: (model) => {
            const value = normalizeClaudeModelIdentifier(model);
            const modelPickerId = value.startsWith(this.config.modelPrefix)
              ? value : `${this.config.modelPrefix}${value}`;
            const claudeModelValue = resolveClaudeModel(this.config, modelPickerId);
            return claudeModelValue ? { modelPickerId, claudeModelValue } : undefined;
          },
        },
      ),
    );
    const records = this.store.allThreadRecords();
    const pendingRemovals = this.store.listPendingThreadRemovals();
    const pendingRemovalIds = new Set(pendingRemovals.map((removal) => removal.rootThreadId));
    const byId = new Map(records.map((record) => [record.thread.id, record]));
    const orphanProjectionIds = new Set<string>();
    for (const record of records) {
      if (!record.thread.parentThreadId) continue;
      const seen = new Set([record.thread.id]);
      let owner = record;
      while (owner.thread.parentThreadId) {
        const parent = byId.get(owner.thread.parentThreadId);
        if (!parent || seen.has(parent.thread.id)) {
          owner = record;
          break;
        }
        seen.add(parent.thread.id);
        owner = parent;
      }
      if (owner === record) {
        this.logger.warn("claude.orphan-projection.removed", { threadId: record.thread.id });
        orphanProjectionIds.add(record.thread.id);
        continue;
      }
      this.sessions.registerChild(record.thread.id, owner.thread.id);
    }
    const restartRecoveryRootIds = new Set<string>();
    for (const record of records) {
      if (orphanProjectionIds.has(record.thread.id)) continue;
      if (pendingRemovalIds.has(this.sessions.ownerOf(record.thread.id))) continue;
      if (record.thread.status.type === "active"
        || this.store.listTurns(record.thread.id).some((turn) => turn.status === "inProgress")
        || this.store.listPendingRequests(record.thread.id).length > 0
        || this.store.listProviderEvents(record.thread.id, "pending").length > 0) {
        restartRecoveryRootIds.add(this.sessions.ownerOf(record.thread.id));
      }
    }
    this.restartRecovery = this.resumeThreadRemovals(pendingRemovals.map((removal) => removal.rootThreadId))
      .then(() => this.reconcileAfterRestart(orphanProjectionIds, restartRecoveryRootIds))
      .then(() => {
        for (const record of this.store.allThreadRecords()) {
          if (record.thread.ephemeral && !record.thread.parentThreadId) {
            this.scheduleEphemeralRelease(record.thread.id);
          }
        }
      });
    for (const record of this.store.allThreadRecords()) {
      if (orphanProjectionIds.has(record.thread.id)) continue;
      for (const request of this.store.listPendingRequests(record.thread.id)) {
        this.metrics.pendingOpened(request.requestId, request.createdAt);
      }
    }
    const intervalMs = Math.max(1_000, Math.min(config.idleTimeoutSeconds * 500, 60_000));
    this.idleTimer = setInterval(() => {
      this.idleSweep = this.idleSweep.then(() => this.unloadIdleRuntimes());
    }, intervalMs);
    this.idleTimer.unref();
  }

  public ownsThread(threadId: string): boolean {
    return this.store.hasThread(threadId);
  }

  public ready(): Promise<void> {
    return this.restartRecovery;
  }

  public ownsModel(modelId: string): boolean {
    return resolveClaudeModel(this.config, modelId) !== undefined;
  }

  public async readRateLimits(foregroundThreadId?: string): Promise<ClaudeRateLimitsResponse> {
    if (!this.rateLimits.hasLiveSource && foregroundThreadId && this.ownsThread(foregroundThreadId)) {
      await (await this.sessions.getOrCreate(foregroundThreadId)).ensureRuntime();
    }
    return this.rateLimits.read();
  }

  public async readRateLimitStatus(foregroundThreadId?: string): Promise<ClaudeRateLimitStatus> {
    if (!this.rateLimits.hasLiveSource && foregroundThreadId && this.ownsThread(foregroundThreadId)) {
      await (await this.sessions.getOrCreate(foregroundThreadId)).ensureRuntime();
    }
    if (!this.rateLimits.hasLiveSource) {
      this.standaloneStatusRead ??= this.readStandaloneRateLimitStatus()
        .finally(() => { this.standaloneStatusRead = undefined; });
      return this.standaloneStatusRead;
    }
    return this.rateLimits.readStatus();
  }

  public cachedRateLimits(): ClaudeRateLimitsResponse {
    return this.rateLimits.cached();
  }

  public subscribeRateLimits(connectionId: string, listener: (response: ClaudeRateLimitsResponse) => void): void {
    this.rateLimits.subscribe(connectionId, listener);
  }

  public unsubscribeRateLimits(connectionId: string): void {
    this.rateLimits.unsubscribe(connectionId);
  }

  public async handoffSource(threadId: string, lastTurnId?: string | null): Promise<ClaudeHandoffSource> {
    this.requireIndependentThread(threadId, "create a handoff from");
    const snapshot = await this.sessions.submit<SessionBranchSnapshot>(threadId, { type: "snapshotBranch" });
    const through = lastTurnId
      ? snapshot.record.thread.turns.findIndex((turn) => turn.id === lastTurnId)
      : snapshot.record.thread.turns.length - 1;
    if (lastTurnId && through < 0) throw invalidParams(`Unknown Claude turn '${lastTurnId}'.`);
    const turns = snapshot.record.thread.turns.slice(0, through + 1);
    return {
      thread: { ...snapshot.record.thread, turns },
      turns,
      settings: threadSettings(snapshot.record),
    };
  }

  public currentThreadSettings(threadId: string): ThreadSettings {
    return threadSettings(this.requireRecord(threadId, false));
  }

  public loadedThreadIds(): string[] {
    const loaded = new Set(this.sessions.loadedOwnerIds());
    for (const record of this.store.allThreadRecords()) {
      if (record.thread.ephemeral || record.thread.status.type === "active") {
        loaded.add(this.sessions.ownerOf(record.thread.id));
      }
    }
    return [...loaded]
      .filter((threadId) => this.store.hasThread(threadId)
        && !this.store.isThreadArchived(threadId)
        && !this.pendingThreadRemoval(threadId)
        && !this.hub.isSuppressed(threadId));
  }

  public async reportError(
    threadId: string,
    requestedTurnId: string | undefined,
    message: string,
    codexErrorInfo: CodexErrorInfo,
  ): Promise<boolean> {
    if (this.closing || !this.ownsThread(threadId)
      || this.pendingThreadRemoval(threadId) || this.terminalAdmins.has(threadId)) return false;
    try {
      return await this.sessions.submit<boolean>(threadId, {
        type: "reportError",
        threadId,
        ...(requestedTurnId ? { requestedTurnId } : {}),
        message,
        codexErrorInfo,
      });
    } catch (error) {
      if (!this.closing && this.ownsThread(threadId)) throw error;
      return false;
    }
  }

  public async startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    let record = await this.newThreadRecord(params);
    record = await this.sessions.submit(record.thread.id, { type: "createThread", record });
    return threadResponse(record, false);
  }

  public async startHiddenThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    let record = await this.newThreadRecord(params);
    this.sessionOutput.suppress(record.thread.id);
    try {
      record = await this.sessions.submit(record.thread.id, { type: "createThread", record });
      return threadResponse(record, false);
    } catch (error) {
      this.sessionOutput.unsuppress(record.thread.id);
      throw error;
    }
  }

  public async announceThread(thread: Thread): Promise<void> {
    this.requireIndependentThread(thread.id, "announce");
    await this.sessions.submit(thread.id, { type: "announceThread" });
  }

  public async resumeThread(params: ThreadResumeParams | string): Promise<ThreadResumeResponse> {
    if (this.closing) throw invalidParams("Claude service is closing.");
    const resume = typeof params === "string" ? { threadId: params } : params;
    const { threadId } = resume;
    this.assertThreadAvailable(threadId);
    let record = this.store.getThreadRecord(threadId, true);
    if (!record) throw invalidParams(`Unknown Claude thread '${threadId}'.`);
    if (record.thread.parentThreadId) {
      return {
        ...threadResponse(record, !resume.excludeTurns),
        initialTurnsPage: resume.initialTurnsPage
          ? this.turnsPage({
            threadId,
            ...(resume.initialTurnsPage.limit !== undefined ? { limit: resume.initialTurnsPage.limit } : {}),
            ...(resume.initialTurnsPage.sortDirection !== undefined ? { sortDirection: resume.initialTurnsPage.sortDirection } : {}),
            ...(resume.initialTurnsPage.itemsView !== undefined ? { itemsView: resume.initialTurnsPage.itemsView } : {}),
          })
          : null,
      };
    }
    await (await this.sessions.getOrCreate(threadId)).materializeRuntime();
    record = await this.sessions.submit<ClaudeThreadRecord>(
      threadId,
      { type: "readThread", includeTurns: true },
    );
    return {
      ...threadResponse(record, !resume.excludeTurns),
      initialTurnsPage: resume.initialTurnsPage
        ? this.turnsPage({
          threadId,
          ...(resume.initialTurnsPage.limit !== undefined ? { limit: resume.initialTurnsPage.limit } : {}),
          ...(resume.initialTurnsPage.sortDirection !== undefined ? { sortDirection: resume.initialTurnsPage.sortDirection } : {}),
          ...(resume.initialTurnsPage.itemsView !== undefined ? { itemsView: resume.initialTurnsPage.itemsView } : {}),
        })
        : null,
    };
  }

  public async prepareResume(params: ThreadResumeParams): Promise<PreparedResume> {
    if (this.requireRecord(params.threadId, false).thread.parentThreadId) {
      return {
        response: await this.resumeThread(params),
        notifyGoalSnapshot: () => Promise.resolve(),
      };
    }
    const snapshot = await this.sessions.submit<{ reservationId: string } | undefined>(
      params.threadId, { type: "goal", command: { kind: "resume" } },
    );
    try {
      const response = await this.resumeThread(params);
      let notified: Promise<void> | undefined;
      return {
        response,
        notifyGoalSnapshot: (notify) => notified ??= snapshot
          ? this.sessions.submit<unknown>(params.threadId, {
            type: "goal", command: { kind: "resumeSnapshot", reservationId: snapshot.reservationId },
          }).then((current) => {
            if (current) notify("thread/goal/updated", current);
          })
          : Promise.resolve(),
      };
    } catch (error) {
      if (snapshot) await this.sessions.submit(params.threadId, {
        type: "goal", command: { kind: "resumeSnapshot", reservationId: snapshot.reservationId },
      }).catch(() => undefined);
      throw error;
    }
  }

  public readThread(threadId: string, includeTurns: boolean): ThreadReadResponse {
    this.assertThreadAvailable(threadId);
    const record = this.store.getThreadRecord(threadId, includeTurns);
    if (!record) throw invalidParams(`Unknown Claude thread '${threadId}'.`);
    return { thread: record.thread };
  }

  public async prepareTurn(
    params: TurnStartParams,
    review?: { label: string; display: string },
  ): Promise<{
    response: TurnStartResponse;
    announce: () => Promise<void>;
    start: () => void;
    startAndWait: () => Promise<void>;
  }> {
    this.requireIndependentThread(params.threadId, "start a turn in");
    const availability = await this.availabilityProbe();
    if (availability.state !== "ready") throw invalidParams(providerUnavailableMessage(availability));
    await this.sessions.submit(params.threadId, { type: "goal", command: { kind: "reserveTurn" } });
    let preparedTurn = false;
    let staged: Awaited<ReturnType<ClaudeSession["prepareRuntimeTurn"]>> | undefined;
    let session: ClaudeSession | undefined;
    try {
      await this.applyTurnOverrides(params);
      session = await this.sessions.getOrCreate(params.threadId);
      staged = await session.prepareRuntimeTurn(params, Boolean(review));
      const projectedParams = review
        ? { ...params, input: [{ type: "text" as const, text: review.display, text_elements: [] }] }
        : params;
      const prepared = await this.sessions.submit<PreparedSessionTurn>(
        params.threadId,
        {
          type: "prepareTurn",
          params: projectedParams,
          ...(review ? { review: review.label } : {}),
          stagedMessageUuid: staged.messageUuid,
          readOnly: staged.readOnly,
        },
      );
      preparedTurn = true;
      const startRuntime = staged.attach(prepared.turn);
      let announcement: Promise<void> | undefined;
      const startAndWait = () => announcement ? announcement.then(startRuntime) : startRuntime();
      return {
        response: { turn: prepared.turn },
        announce: () => announcement ??= this.sessions.submit(
          params.threadId,
          { type: "announceTurn", turnId: prepared.turn.id },
        ),
        start: () => {
          void startAndWait().catch((error) =>
            this.logger.error("claude.turn.start-failed", { threadId: params.threadId, error: String(error) }));
        },
        startAndWait,
      };
    } catch (error) {
      if (staged) await staged.discard();
      if (!preparedTurn) await this.sessions.submit(
        params.threadId, { type: "goal", command: { kind: "cancelTurn" } },
      );
      throw error;
    }
  }

  public async prepareStatusTurn(params: TurnStartParams, render: () => Promise<string>): Promise<{
    response: TurnStartResponse;
    announce: () => Promise<void>;
    start: () => void;
  }> {
    this.requireIndependentThread(params.threadId, "start a status turn in");
    if (!isClaudeStatusCommand(params.input)) throw invalidParams("Not a CCodex status command.");
    return this.prepareSyntheticCommandTurn(params, "status", render);
  }

  public async prepareStateTurn(params: TurnStartParams, render: () => Promise<string>): Promise<{
    response: TurnStartResponse;
    announce: () => Promise<void>;
    start: () => void;
  }> {
    this.requireIndependentThread(params.threadId, "start a state turn in");
    if (!isCCodexStateCommand(params.input)) throw invalidParams("Not a CCodex state command.");
    return this.prepareSyntheticCommandTurn(params, "state", render);
  }

  public stateSnapshot(threadId: string): ThreadStateSnapshot {
    this.assertThreadAvailable(threadId);
    const record = this.requireRecord(threadId, true);
    return {
      provider: "claude",
      model: stateModelName("claude", record.modelPickerId),
      effort: record.reasoningEffort,
      serviceTier: record.serviceTier,
      approvalPolicy: record.approvalPolicy as ThreadSettings["approvalPolicy"],
      approvalsReviewer: record.approvalsReviewer,
      sandboxPolicy: record.sandboxPolicy as ThreadSettings["sandboxPolicy"],
      thread: record.thread,
      tokenUsage: record.tokenUsageLast ? {
        total: record.tokenUsageTotal,
        last: record.tokenUsageLast,
        modelContextWindow: record.modelContextWindow,
      } : null,
      providerCostUsd: record.providerCostUsdTotal ?? 0,
    };
  }

  private async prepareSyntheticCommandTurn(
    params: TurnStartParams,
    synthetic: "status" | "state",
    render: () => Promise<string>,
  ): Promise<{
    response: TurnStartResponse;
    announce: () => Promise<void>;
    start: () => void;
  }> {
    const prepared = await this.sessions.submit<PreparedSessionTurn>(
      params.threadId, { type: "prepareTurn", params, synthetic },
    );
    let started = false;
    return {
      response: { turn: prepared.turn },
      announce: () => this.sessions.submit(params.threadId, { type: "announceTurn", turnId: prepared.turn.id }),
      start: () => {
        if (started) return;
        started = true;
        void this.completeCommandTurn(params.threadId, prepared.turn.id, synthetic, render);
      },
    };
  }

  public async interruptTurn(value: string | TurnInterruptParams): Promise<void> {
    const params = typeof value === "string" ? { threadId: value, turnId: undefined } : value;
    const initial = this.requireRecord(params.threadId, false);
    if (initial.thread.parentThreadId && params.turnId) {
      const selected = this.store.listTurns(params.threadId).find((turn) => turn.id === params.turnId);
      if (selected && selected.status !== "inProgress") return;
    }
    const activeOwnerSession = !initial.thread.parentThreadId
      ? this.sessions.resolvedSession(params.threadId)
      : undefined;
    const stopFence = activeOwnerSession?.fenceCurrentRuntimeStop(params.turnId);
    const ownerSession = !initial.thread.parentThreadId
      ? activeOwnerSession ?? await this.sessions.getOrCreate(params.threadId)
      : undefined;
    if (stopFence) await stopFence;
    const shell = await this.sessions.submit<ShellCancellation | undefined>(params.threadId, {
      type: "prepareShellCancellation",
      ...(params.turnId ? { turnId: params.turnId } : {}),
    });
    if (shell) return;
    if (await this.sessions.submit<boolean>(params.threadId, {
      type: "completeSynthetic", ...(params.turnId ? { turnId: params.turnId } : {}),
      status: "interrupted", codexErrorInfo: null,
    })) return;
    const record = this.requireRecord(params.threadId, false);
    if (record.thread.parentThreadId) {
      await (await this.sessions.getOrCreate(params.threadId))
        .interruptChildRuntime(params.threadId, params.turnId);
      return;
    }
    await ownerSession!.interruptRuntime(params.turnId);
  }

  public async cleanBackgroundTerminals(
    params: ThreadBackgroundTerminalsCleanParams,
  ): Promise<ThreadBackgroundTerminalsCleanResponse> {
    await (await this.sessions.getOrCreate(params.threadId)).cleanBackgroundTerminals(params.threadId);
    return {};
  }

  public async listBackgroundTerminals(
    params: ThreadBackgroundTerminalsListParams,
  ): Promise<ThreadBackgroundTerminalsListResponse> {
    const terminals = await (await this.sessions.getOrCreate(params.threadId)).listBackgroundTerminals(params.threadId);
    const offset = params.cursor === undefined || params.cursor === null ? 0 : Number(params.cursor.replace(/^claude-bg:/u, ""));
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalidParams(`Invalid Claude background-terminal cursor '${params.cursor}'.`);
    const limit = Math.min(100, Math.max(1, params.limit ?? 50));
    const data = terminals.slice(offset, offset + limit);
    const next = offset + data.length;
    return { data, nextCursor: next < terminals.length ? `claude-bg:${next}` : null };
  }

  public async terminateBackgroundTerminal(
    params: ThreadBackgroundTerminalsTerminateParams,
  ): Promise<ThreadBackgroundTerminalsTerminateResponse> {
    const terminated = await (await this.sessions.getOrCreate(params.threadId))
      .terminateBackgroundTerminal(params.threadId, params.processId);
    return { terminated };
  }

  public async steerTurn(params: TurnSteerParams): Promise<{ turnId: string }> {
    return { turnId: await (await this.sessions.getOrCreate(params.threadId)).steerRuntime(params) };
  }

  public async compactThread(threadId: string): Promise<Record<string, never>> {
    this.requireIndependentThread(threadId, "compact");
    await (await this.sessions.getOrCreate(threadId)).compactRuntime();
    return {};
  }

  public async compactForHandoff(threadId: string, prompt = "/compact"): Promise<string> {
    this.requireIndependentThread(threadId, "compact for handoff");
    return (await this.sessions.getOrCreate(threadId)).compactRuntimeForHandoff(prompt);
  }

  public async discardHandoffThread(threadId: string): Promise<void> {
    await this.discardThreadSilently(threadId);
  }

  public async preparePromptedCompact(
    threadId: string,
    input: string,
  ): Promise<{ response: TurnStartResponse; announce: () => Promise<void> }> {
    this.requireIndependentThread(threadId, "compact");
    const prepared = await (await this.sessions.getOrCreate(threadId))
      .preparePromptedCompaction(input);
    return {
      response: { turn: prepared.turn },
      announce: prepared.announce,
    };
  }

  public async updateThreadSettings(params: ThreadSettingsUpdateParams): Promise<Record<string, never>> {
    this.requireIndependentThread(params.threadId, "update settings for");
    await this.applySettings(params);
    return {};
  }

  public async injectItems(params: ThreadInjectItemsParams): Promise<Record<string, never>> {
    this.requireIndependentThread(params.threadId, "inject items into");
    validateResponseItems(params.items);
    await (await this.sessions.getOrCreate(params.threadId)).injectRuntimeItems(params.items);
    return {};
  }

  public async summarizeHandoff(threadId: string, prompt: string): Promise<string> {
    this.requireIndependentThread(threadId, "summarize a handoff from");
    const source = this.requireRecord(threadId, false);
    const started = await this.startThread({
      model: source.modelPickerId,
      serviceTier: source.serviceTier,
      cwd: source.thread.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: "Create a portable conversation handoff. Do not call tools or mutate the workspace.",
      ephemeral: true,
      threadSource: "subAgent",
    });
    const temporaryId = started.thread.id;
    return this.sessionOutput.withInternalThreadHidden(temporaryId, async () => {
      try {
        const prepared = await this.prepareTurn({
          threadId: temporaryId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
        });
        prepared.announce();
        prepared.start();
        const completed = await new Promise<Turn>((resolve, reject) => {
          const timeout = setTimeout(() => {
            clearInterval(poll);
            reject(new Error("Claude compact handoff timed out."));
          }, 120_000);
          const poll = setInterval(() => {
            const turn = this.store.listTurns(temporaryId).at(-1);
            if (!turn || turn.status === "inProgress") return;
            clearTimeout(timeout);
            clearInterval(poll);
            if (turn.status !== "completed") reject(new Error(turn.error?.message ?? "Claude compact handoff failed."));
            else resolve(turn);
          }, 25);
        });
        const text = completed.items.flatMap((item) =>
          item.type === "agentMessage" ? [item.text] : []).join("\n").trim();
        if (!text) throw new Error("Claude compact handoff returned no text.");
        return text;
      } finally {
        await this.discardThreadSilently(temporaryId);
      }
    });
  }

  public async shellCommand(params: ThreadShellCommandParams): Promise<Record<string, never>> {
    this.requireIndependentThread(params.threadId, "run a shell command in");
    await this.sessions.submit(params.threadId, { type: "runShell", command: params.command });
    return {};
  }

  public async prepareReview(params: ReviewStartParams): Promise<{
    response: ReviewStartResponse;
    announce: () => void;
    start: () => void;
    forkedThread?: Thread;
  }> {
    const value = (text: string, field: string) => {
      const trimmed = text.trim();
      if (!trimmed) throw invalidParams(`Review ${field} must not be empty.`);
      return trimmed;
    };
    const review = params.target.type === "uncommittedChanges"
      ? "current changes"
      : params.target.type === "baseBranch"
        ? `changes against '${value(params.target.branch, "branch")}'`
        : params.target.type === "commit"
          ? `commit ${value(params.target.sha, "sha").slice(0, 7)}${
            params.target.title?.trim() ? `: ${params.target.title.trim()}` : ""}`
          : value(params.target.instructions, "instructions");
    const prompt = params.target.type === "custom"
      ? review
      : `Review ${review}. Inspect the repository and report concrete bugs, regressions, and risks with file and line references. Do not modify files.`;
    let reviewThreadId = params.threadId;
    let forkedThread: Thread | undefined;
    if (params.delivery === "detached") {
      const fork = await this.forkThread({ threadId: params.threadId, excludeTurns: false });
      reviewThreadId = fork.thread.id;
      forkedThread = fork.thread;
    }
    try {
      const prepared = await this.prepareTurn({
        threadId: reviewThreadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      }, { label: review, display: review });
      const userItem = prepared.response.turn.items.find((item) => item.type === "userMessage");
      return {
        response: {
          turn: {
            ...prepared.response.turn,
            items: userItem ? [userItem] : [],
            itemsView: "notLoaded",
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
          reviewThreadId,
        },
        announce: prepared.announce,
        start: prepared.start,
        ...(forkedThread ? { forkedThread } : {}),
      };
    } catch (error) {
      if (forkedThread) await this.discardThreadSilently(reviewThreadId);
      throw error;
    }
  }

  public listTurns(threadId: string) {
    this.assertThreadAvailable(threadId);
    return this.store.listTurns(threadId);
  }

  public turnsPage(params: ThreadTurnsListParams): ThreadTurnsListResponse {
    this.assertThreadAvailable(params.threadId);
    const turns = this.listTurns(params.threadId);
    const ordered = params.sortDirection === "asc" ? turns : [...turns].reverse();
    if (params.cursor && !params.cursor.startsWith("hyb-turn:")) throw invalidParams("Invalid Claude turn cursor.");
    const offset = params.cursor?.startsWith("hyb-turn:") ? Number(params.cursor.slice("hyb-turn:".length)) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw invalidParams("Invalid Claude turn cursor.");
    const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
    const itemsView = params.itemsView ?? "summary";
    const data = ordered.slice(offset, offset + limit).map((turn) => ({
      ...turn,
      itemsView,
      ...(itemsView === "notLoaded" ? { items: [] } : {}),
    }));
    return {
      data,
      nextCursor: offset + data.length < ordered.length ? `hyb-turn:${offset + data.length}` : null,
      backwardsCursor: data.length > 0 ? `hyb-turn:${Math.max(0, offset - limit)}` : null,
    };
  }

  public listThreads(params: Parameters<HybridStore["listThreads"]>[0]): Thread[] {
    return this.store.listThreads(params)
      .filter((thread) => !this.pendingThreadRemoval(thread.id) && !this.hub.isSuppressed(thread.id));
  }

  public async setThreadName(params: ThreadSetNameParams): Promise<Record<string, never>> {
    const record = this.requireRecord(params.threadId, false);
    if (record.thread.parentThreadId) {
      await this.sessions.submit(params.threadId, {
        type: "threadAdmin",
        command: { kind: "renameProjection", threadId: params.threadId, name: params.name },
      });
      return {};
    }
    await this.threadAdminEffect(params.threadId, "rename", async (prepared) => {
      if (prepared.providerRename) {
        await this.threadAdminEffects.rename(
          prepared.record.claudeSessionId,
          params.name,
          prepared.record.thread.cwd,
        );
      }
    }, params.name);
    return {};
  }

  public updateThreadMetadata(params: ThreadMetadataUpdateParams): Promise<{ thread: Thread }> {
    this.requireIndependentThread(params.threadId, "update metadata for");
    return this.sessions.submit(params.threadId, {
      type: "threadAdmin",
      command: { kind: "metadata", gitInfo: params.gitInfo },
    });
  }

  public async archiveThread(threadId: string): Promise<Record<string, never>> {
    this.requireIndependentThread(threadId, "archive");
    this.terminalAdmins.set(threadId, (this.terminalAdmins.get(threadId) ?? 0) + 1);
    try {
      await this.threadAdminEffect(threadId, "archive", async (prepared) => {
        await this.failStatusTurnForUnload(threadId, "Claude thread archived during an active turn.");
        await this.sessions.submit(threadId, { type: "goal", command: { kind: "detach", checkpoint: "unload" } });
        if (!prepared.record.thread.ephemeral) {
          await (await this.sessions.getOrCreate(threadId))
            .retireRuntime("Claude thread archived during an active turn.");
        }
      });
      await this.sessions.retire(threadId);
      return {};
    } finally {
      const remaining = this.terminalAdmins.get(threadId)! - 1;
      if (remaining) this.terminalAdmins.set(threadId, remaining);
      else this.terminalAdmins.delete(threadId);
    }
  }

  public unarchiveThread(threadId: string): Promise<{ thread: Thread }> {
    this.requireIndependentThread(threadId, "unarchive");
    return this.sessions.submit(threadId, {
      type: "threadAdmin",
      command: { kind: "unarchive" },
    });
  }

  public async deleteThread(threadId: string): Promise<Record<string, never>> {
    const pending = this.pendingThreadRemoval(threadId);
    if (pending) {
      if (pending.rootThreadId !== threadId || pending.kind !== "delete") this.throwPendingRemoval(threadId, pending);
      await this.resumeThreadRemoval(threadId);
      return {};
    }
    this.requireIndependentThread(threadId, "delete");
    await this.removeThread(threadId, "delete", "Claude thread deleted during an active turn.");
    return {};
  }

  public releaseEphemeralThread(threadId: string): Promise<void> {
    this.cancelEphemeralRelease(threadId);
    const existing = this.ephemeralReleases.get(threadId);
    if (existing) return existing;
    if (this.closing) return Promise.resolve();
    const release = this.releaseEphemeralThreadOnce(threadId);
    this.ephemeralReleases.set(threadId, release);
    const remove = () => {
      if (this.ephemeralReleases.get(threadId) === release) this.ephemeralReleases.delete(threadId);
    };
    void release.then(remove, remove);
    return release;
  }

  public scheduleEphemeralRelease(threadId: string, delayMs = EPHEMERAL_DISCONNECT_GRACE_MS): void {
    if (this.closing || this.ephemeralReleaseTimers.has(threadId)) return;
    const record = this.store.getThreadRecord(threadId, false);
    if (!record?.thread.ephemeral || record.thread.parentThreadId) return;
    const timer = setTimeout(() => {
      this.ephemeralReleaseTimers.delete(threadId);
      void this.releaseEphemeralThread(threadId).catch((error: unknown) => {
        this.logger.warn("claude.ephemeral.release-failed", {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);
    timer.unref();
    this.ephemeralReleaseTimers.set(threadId, timer);
  }

  public cancelEphemeralRelease(threadId: string): void {
    const timer = this.ephemeralReleaseTimers.get(threadId);
    if (!timer) return;
    clearTimeout(timer);
    this.ephemeralReleaseTimers.delete(threadId);
  }

  private async releaseEphemeralThreadOnce(threadId: string): Promise<void> {
    const pending = this.pendingThreadRemoval(threadId);
    if (pending) {
      if (pending.rootThreadId !== threadId || pending.kind !== "release") this.throwPendingRemoval(threadId, pending);
      await this.resumeThreadRemoval(threadId);
      return;
    }
    const record = this.store.getThreadRecord(threadId, false);
    if (record?.thread.parentThreadId) {
      throw invalidParams(`Cannot release Claude subagent thread '${threadId}'; it is a read-only projection.`);
    }
    if (!record?.thread.ephemeral) return;
    await this.removeThread(threadId, "release", "Ephemeral side thread released.");
  }

  public listItems(params: ThreadItemsListParams): ThreadItemsListResponse {
    this.assertThreadAvailable(params.threadId);
    const items = this.store.listTurns(params.threadId)
      .flatMap((turn) => params.turnId && turn.id !== params.turnId ? [] : turn.items);
    const ordered = params.sortDirection === "desc" ? [...items].reverse() : items;
    if (params.cursor && !params.cursor.startsWith("hyb-item:")) throw invalidParams("Invalid Claude item cursor.");
    const offset = params.cursor?.startsWith("hyb-item:") ? Number(params.cursor.slice("hyb-item:".length)) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw invalidParams("Invalid Claude item cursor.");
    const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
    const data = ordered.slice(offset, offset + limit);
    return {
      data,
      nextCursor: offset + data.length < ordered.length ? `hyb-item:${offset + data.length}` : null,
      backwardsCursor: data.length > 0 ? `hyb-item:${Math.max(0, offset - limit)}` : null,
    };
  }

  public async forkThread(
    params: ThreadForkParams,
    visibleForkedFromId: string = params.threadId,
  ): Promise<ThreadForkResponse> {
    if (params.path) throw invalidParams("Claude thread forks must use threadId, not a Codex rollout path.");
    this.requireIndependentThread(params.threadId, "fork");
    const source = await this.sessions.submit<SessionBranchSnapshot>(params.threadId, { type: "snapshotBranch" });
    const sourceRecord = source.record;
    const sidePromotion = Boolean(
      (this.config.features?.sideChatPromotion ?? true)
      && sourceRecord.thread.ephemeral
      && sourceRecord.thread.threadSource === "user"
      && params.ephemeral !== true
    );
    if (sourceRecord.thread.ephemeral && !sidePromotion) {
      throw invalidParams("Forking this ephemeral Claude source thread is not supported.");
    }
    const modelPickerId = params.model ?? sourceRecord.modelPickerId;
    const claudeModelValue = resolveClaudeModel(this.config, modelPickerId);
    if (!claudeModelValue) throw invalidParams("Cannot fork a Claude thread to a Codex model.");
    const activeSideFork = Boolean(params.ephemeral === true && params.excludeTurns === true
      && params.threadSource === "user" && !params.lastTurnId);
    if (params.permissions && params.sandbox) throw invalidParams("Claude thread fork cannot combine permissions with sandbox.");
    const activeIndex = sourceRecord.thread.turns.findIndex((turn) => turn.status === "inProgress");
    const selectedIndex = params.lastTurnId
      ? sourceRecord.thread.turns.findIndex((turn) => turn.id === params.lastTurnId)
      : -1;
    if (params.lastTurnId && selectedIndex < 0) throw invalidParams(`Unknown Claude turn '${params.lastTurnId}'.`);
    const selectedTurn = selectedIndex >= 0 ? sourceRecord.thread.turns[selectedIndex] : undefined;
    const selectedBoundary = params.lastTurnId
      ? source.boundaries.find((entry) => entry.turnId === params.lastTurnId)
      : undefined;
    if (params.lastTurnId && !selectedBoundaryIsStable(selectedTurn)) {
      throw invalidParams(`Claude turn '${params.lastTurnId}' is not completed and cannot be used as a fork boundary.`);
    }
    const through = activeSideFork || sidePromotion
      ? activeIndex >= 0 ? activeIndex - 1 : sourceRecord.thread.turns.length - 1
      : params.lastTurnId
        ? selectedIndex
        : sourceRecord.thread.turns.length - 1;
    if (sidePromotion && through < 0) {
      throw invalidParams("Cannot promote a Claude side chat before it has a completed turn.");
    }
    const sourceTurns = sourceRecord.thread.turns.slice(0, through + 1);
    const selectedIds = new Set(sourceTurns.map((turn) => turn.id));
    const unstableProjectionIds = new Set(sourceTurns
      .filter((turn) => turn.status === "inProgress")
      .map((turn) => turn.id));
    const stableSelectedIds = new Set([...selectedIds]
      .filter((turnId) => !unstableProjectionIds.has(turnId)));
    const sourceBoundaries = source.boundaries.filter((entry) => stableSelectedIds.has(entry.turnId));
    const revisionTurns = sourceTurns.filter((turn) => stableSelectedIds.has(turn.id));
    const revision = branchRevision(sourceRecord, sourceBoundaries, revisionTurns);
    const serviceTier = normalizeClaudeServiceTier(this.config, modelPickerId,
      params.serviceTier === undefined ? sourceRecord.serviceTier : params.serviceTier);
    await this.validateModelSettings(modelPickerId, sourceRecord.reasoningEffort, serviceTier);
    const boundary = selectedBoundary?.messageUuid ?? sourceBoundaries.at(-1)?.messageUuid;
    const branch = boundary
      ? await this.transcripts.forkWithProvenance(sourceRecord.claudeSessionId, boundary, sourceRecord.thread.cwd,
        sourceBoundaries.map((entry) => entry.messageUuid))
      : { sessionId: uuidv7(), uuidMap: new Map<string, string>() };
    try {
      const current = await this.sessions.submit<SessionBranchSnapshot>(params.threadId, { type: "snapshotBranch" });
      const currentTurns = current.record.thread.turns.filter((turn) => stableSelectedIds.has(turn.id));
      const currentBoundaries = current.boundaries.filter((entry) => stableSelectedIds.has(entry.turnId));
      const currentRevision = branchRevision(current.record, currentBoundaries, currentTurns);
      if (currentRevision !== revision)
        throw invalidParams("Claude thread changed while branch was being prepared; retry the operation.");
    } catch (error) {
      await this.transcripts.delete(branch.sessionId, sourceRecord.thread.cwd).catch(() => undefined);
      throw error;
    }
    const createdAt = nowSeconds();
    const cwd = existingThreadCwd(params.cwd ?? sourceRecord.thread.cwd);
    const thread: Thread = {
      ...sourceRecord.thread, id: uuidv7(), ephemeral: params.ephemeral ?? false,
      sessionId: sourceRecord.thread.sessionId, forkedFromId: visibleForkedFromId,
      cwd, modelProvider: "claude", createdAt, updatedAt: createdAt, recencyAt: createdAt,
      status: params.ephemeral ? { type: "idle" } : { type: "notLoaded" },
      name: sourceRecord.thread.name ? `${sourceRecord.thread.name} (fork)` : null,
      threadSource: params.threadSource ?? sourceRecord.thread.threadSource, turns: [],
    };
    const copiedTurns = sourceTurns.map((turn) => forkProjection(turn, thread.id));
    const record: ClaudeThreadRecord = {
      ...sourceRecord, thread, claudeSessionId: branch.sessionId, modelPickerId, claudeModelValue, serviceTier,
      approvalPolicy: params.approvalPolicy ?? sourceRecord.approvalPolicy,
      approvalsReviewer: approvalsReviewer(params.approvalsReviewer, sourceRecord.approvalsReviewer),
      sandboxPolicy: params.permissions
        ? permissionProfileSandboxPolicy(params.permissions, cwd)
        : params.sandbox ? sandboxPolicy(params.sandbox, cwd) : sourceRecord.sandboxPolicy,
      baseInstructions: params.baseInstructions === undefined ? sourceRecord.baseInstructions : params.baseInstructions,
      developerInstructions: params.developerInstructions === undefined
        ? sourceRecord.developerInstructions : params.developerInstructions,
      lastClaudeMessageUuid: null, lastCompletedTurnId: null,
    };
    let responseRecord: ClaudeThreadRecord;
    try {
      responseRecord = await this.sessions.submit(thread.id, {
        type: "commitForkTarget", record, turns: copiedTurns,
        sourceBoundaries, uuidMap: [...branch.uuidMap],
      });
    } catch (error) {
      await this.transcripts.delete(branch.sessionId, sourceRecord.thread.cwd).catch(() => undefined);
      throw error;
    }
    responseRecord = { ...responseRecord, thread: { ...responseRecord.thread, turns: copiedTurns } };
    if (thread.ephemeral) {
      try {
        const targetSession = await this.sessions.getOrCreate(thread.id);
        await targetSession.ensureEphemeralRuntime();
        const activeTurn = activeIndex >= 0 ? sourceRecord.thread.turns[activeIndex] : undefined;
        if (activeSideFork && activeTurn) {
          await targetSession.injectRuntimeItems([sideReferenceSnapshot(sourceRecord.thread.id, activeTurn)]);
          responseRecord = this.requireRecord(thread.id, true);
        }
      } catch (error) {
        await this.sessions.submit(thread.id, { type: "deleteBranchTarget" }).catch(() => undefined);
        await this.sessions.retire(thread.id).catch(() => undefined);
        await this.transcripts.delete(branch.sessionId, sourceRecord.thread.cwd).catch(() => undefined);
        throw error;
      }
    }
    if (sidePromotion) this.scheduleEphemeralRelease(params.threadId);
    return threadResponse(responseRecord, !params.excludeTurns) as ThreadForkResponse;
  }

  public async rollbackThread(params: ThreadRollbackParams): Promise<ThreadRollbackResponse> {
    this.requireIndependentThread(params.threadId, "roll back");
    const source = await this.sessions.submit<SessionBranchSnapshot>(params.threadId, { type: "snapshotBranch" });
    const sourceRecord = source.record;
    if (sourceRecord.thread.ephemeral) throw invalidParams("Rolling back an ephemeral Claude thread is not supported.");
    if (!Number.isInteger(params.numTurns) || params.numTurns < 1) throw invalidParams("numTurns must be at least 1.");
    if (params.numTurns > sourceRecord.thread.turns.length)
      throw invalidParams("Cannot remove more turns than the Claude thread contains.");
    const sourceSession = await this.sessions.getOrCreate(params.threadId);
    if ((await sourceSession.runtimeInspection())?.quiescent === false)
      throw invalidParams("Cannot roll back a Claude thread with an active turn.");
    const keepCount = sourceRecord.thread.turns.length - params.numTurns;
    const retained = sourceRecord.thread.turns.slice(0, keepCount);
    const retainedIds = new Set(retained.map((turn) => turn.id));
    const sourceBoundaries = source.boundaries.filter((entry) => retainedIds.has(entry.turnId));
    const boundary = sourceBoundaries.at(-1)?.messageUuid;
    const branch = boundary
      ? await this.transcripts.forkWithProvenance(sourceRecord.claudeSessionId, boundary, sourceRecord.thread.cwd,
        sourceBoundaries.map((entry) => entry.messageUuid))
      : { sessionId: uuidv7(), uuidMap: new Map<string, string>() };
    let committed: ClaudeThreadRecord;
    try {
      committed = await this.sessions.submit(params.threadId, {
        type: "commitRollback", expectedRevision: source.revision, replacementSessionId: branch.sessionId,
        keepCount, sourceBoundaries, uuidMap: [...branch.uuidMap],
      });
    } catch (error) {
      await this.transcripts.delete(branch.sessionId, sourceRecord.thread.cwd).catch(() => undefined);
      throw error;
    }
    if (sourceSession.isLoaded) {
      await sourceSession.retireRuntimeSilently().catch((error) => {
        this.logger.warn("claude.rollback.old-runtime-retire-failed",
          { threadId: params.threadId, error: String(error) });
      });
    }
    await this.transcripts.delete(sourceRecord.claudeSessionId, sourceRecord.thread.cwd).catch((error) =>
      this.logger.warn("claude.rollback.old-session-delete-failed", { threadId: params.threadId, error: String(error) }));
    return { thread: committed.thread };
  }

  public prepareGoalSet(
    params: ThreadGoalSetParams,
  ): Promise<PreparedGoalHandle<{ goal: ThreadGoal }>> {
    this.requireIndependentThread(params.threadId, "set a goal on");
    return this.sessions.submit<Extract<PreparedGoalMutation, { kind: "set" }>>(
      params.threadId, { type: "goal", command: { kind: "prepareSet", params } },
    ).then((mutation) => this.goalHandle(params.threadId, mutation));
  }

  public async getGoal(threadId: string): Promise<{ goal: ThreadGoal | null }> {
    if (this.requireRecord(threadId, false).thread.parentThreadId) return { goal: null };
    const goal = await this.sessions.submit<import("../store/HybridStore.js").InternalGoal | undefined>(
      threadId, { type: "goal", command: { kind: "get" } },
    );
    return { goal: goal ? (({ goalId: _, ...value }) => value)(goal) : null };
  }

  public prepareGoalClear(threadId: string): Promise<PreparedGoalHandle<{ cleared: boolean }>> {
    this.requireIndependentThread(threadId, "clear a goal from");
    return this.sessions.submit<Extract<PreparedGoalMutation, { kind: "clear" }>>(
      threadId, { type: "goal", command: { kind: "prepareClear" } },
    ).then((mutation) => this.goalHandle(threadId, mutation));
  }

  private goalHandle<T extends PreparedGoalMutation>(
    threadId: string,
    mutation: T,
  ): PreparedGoalHandle<T["response"]> {
    let notified: Promise<void> | undefined;
    return {
      response: mutation.response,
      notify: () => notified ??= this.sessions.submit(
        threadId, { type: "goal", command: { kind: "finalize", mutation } },
      ),
    };
  }

  public async resolveServerRequest(requestId: string, response: unknown): Promise<boolean> {
    const request = this.store.getPendingRequest(requestId);
    if (!request) return false;
    let owner = this.requireRecord(request.threadId, false);
    while (owner.thread.parentThreadId) owner = this.requireRecord(owner.thread.parentThreadId, false);
    return this.sessions.submit(owner.thread.id, {
      type: "resolveInteraction",
      requestId,
      response,
    });
  }

  public replayPendingRequests(threadId: string, connectionId?: string): Promise<void> {
    this.assertThreadAvailable(threadId);
    return this.sessions.submit(threadId, {
      type: "replayInteractions",
      ...(connectionId ? { connectionId } : {}),
    });
  }

  public eventHighWatermark(threadId: string): number {
    this.assertThreadAvailable(threadId);
    return this.store.eventHighWatermark(threadId);
  }

  public eventsAfter(threadId: string, sequence: number) {
    this.assertThreadAvailable(threadId);
    return this.store.listEventsAfter(threadId, sequence);
  }

  public latestTokenUsage(threadId: string) {
    this.assertThreadAvailable(threadId);
    const record = this.requireRecord(threadId, false);
    if (!record.tokenUsageLast) return undefined;
    const current = {
      threadId,
      turnId: record.lastCompletedTurnId,
      tokenUsage: {
        total: record.tokenUsageTotal,
        last: record.tokenUsageLast,
        modelContextWindow: record.modelContextWindow,
      },
    };
    const latest = this.store.listEventsAfter(threadId, 0)
      .filter((event) => event.method === "thread/tokenUsage/updated")
      .at(-1);
    const latestTurnId = latest?.params && typeof latest.params === "object" && "turnId" in latest.params
      ? (latest.params as { turnId: unknown }).turnId
      : undefined;
    const replay = { ...current, turnId: typeof latestTurnId === "string" ? latestTurnId : current.turnId };
    return latest && JSON.stringify(latest.params) === JSON.stringify(replay)
      ? latest
      : { sequence: 0, threadId, turnId: replay.turnId, method: "thread/tokenUsage/updated", params: replay, createdAt: Date.now() };
  }

  public close(): Promise<void> {
    return this.closePromise ??= this.closeOnce();
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    for (const timer of this.ephemeralReleaseTimers.values()) clearTimeout(timer);
    this.ephemeralReleaseTimers.clear();
    const releaseResults = await Promise.allSettled(this.ephemeralReleases.values());
    await this.restartRecovery;
    clearInterval(this.idleTimer);
    await this.idleSweep;
    await Promise.all(this.sessions.activeOwnerIds().map((threadId) =>
      this.failStatusTurnForUnload(threadId, "Gateway restarted while the CCodex status request was active.")));
    await this.sessions.close();
    this.store.close();
    const failures = releaseResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to release ephemeral Claude threads during shutdown.");
    }
  }

  private async discardThreadSilently(threadId: string): Promise<void> {
    if (!this.store.getThreadRecord(threadId, false)) return;
    await this.removeThread(threadId, "discard", "Internal compact handoff completed.");
  }

  private async removeThread(
    threadId: string,
    kind: ThreadRemovalKind,
    reason: string,
  ): Promise<void> {
    const pending = this.pendingThreadRemoval(threadId);
    if (pending) {
      if (pending.rootThreadId !== threadId || pending.kind !== kind) this.throwPendingRemoval(threadId, pending);
      return this.resumeThreadRemoval(threadId);
    }
    const existing = this.removalRetries.get(threadId);
    if (existing) {
      if (existing.kind !== kind) this.throwPendingRemoval(threadId, existing);
      return existing.promise;
    }
    const removal = this.startThreadRemoval(threadId, kind, reason)
      .finally(() => this.removalRetries.delete(threadId));
    this.removalRetries.set(threadId, { kind, promise: removal });
    return removal;
  }

  private async startThreadRemoval(
    threadId: string,
    kind: ThreadRemovalKind,
    reason: string,
  ): Promise<void> {
    const session = this.sessions.resolvedSession(threadId) ?? await this.sessions.getOrCreate(threadId);
    await session.withRuntimeAdmin(async () => {
      let prepared: PreparedThreadRemoval | undefined;
      let providerAttempted = false;
      try {
        prepared = await this.sessions.submit<PreparedThreadRemoval>(threadId, {
          type: "threadAdmin",
          command: { kind: "beginRemoval", removalKind: kind },
        });
        await this.failStatusTurnForUnload(threadId, reason);
        await this.sessions.submit(threadId, {
          type: "goal",
          command: { kind: "detach", checkpoint: kind },
        });
        await session.retireRuntime(reason);
        providerAttempted = true;
        await this.deleteProviderSession(prepared.claudeSessionId, prepared.cwd);
        const committed = await this.sessions.submit<string[] | false>(threadId, {
          type: "threadAdmin",
          command: { kind: "providerSucceeded", operationId: prepared.operationId },
        });
        if (!committed) throw new Error(`Stale Claude ${kind} completion for thread '${threadId}'.`);
      } catch (error) {
        if (prepared) {
          await this.sessions.submit(threadId, {
            type: "threadAdmin",
            command: {
              kind: "providerFailed",
              operationId: prepared.operationId,
              providerAttempted,
            },
          });
        }
        throw error;
      }
    });
    if (await session.mayRelease()) await this.sessions.retire(threadId);
  }

  private async threadAdminEffect(
    threadId: string,
    operation: ThreadAdminOperation,
    effect: (prepared: PreparedThreadAdmin) => Promise<void>,
    name?: string,
  ): Promise<void> {
    const session = this.sessions.resolvedSession(threadId) ?? await this.sessions.getOrCreate(threadId);
    await session.withRuntimeAdmin(async () => {
      const prepared = await this.sessions.submit<PreparedThreadAdmin>(threadId, {
        type: "threadAdmin",
        command: { kind: "prepare", operation, ...(name === undefined ? {} : { name }) },
      });
      try {
        await effect(prepared);
      } catch (error) {
        await this.sessions.submit(threadId, {
          type: "threadAdmin",
          command: { kind: "abort", operationId: prepared.operationId },
        }).catch(() => undefined);
        throw error;
      }
      try {
        const current = await this.sessions.submit<boolean | string[]>(threadId, {
          type: "threadAdmin",
          command: { kind: "finish", operationId: prepared.operationId },
        });
        if (!current && operation !== "rename") {
          throw new Error(`Stale Claude ${operation} completion for thread '${threadId}'.`);
        }
      } catch (error) {
        await this.sessions.submit(threadId, {
          type: "threadAdmin",
          command: { kind: "abort", operationId: prepared.operationId },
        }).catch(() => undefined);
        throw error;
      }
    });
    if (await session.mayRelease()) await this.sessions.retire(threadId);
  }

  private async resumeThreadRemovals(rootThreadIds: readonly string[]): Promise<void> {
    for (const rootThreadId of rootThreadIds) {
      try {
        await this.resumeThreadRemoval(rootThreadId);
      } catch (error) {
        this.logger.warn("claude.thread-removal.recovery-failed", {
          threadId: rootThreadId,
          error: String(error),
        });
      }
    }
  }

  private async resumeThreadRemoval(rootThreadId: string): Promise<void> {
    const existing = this.removalRetries.get(rootThreadId);
    if (existing) return existing.promise;
    const kind = this.store.listPendingThreadRemovals()
      .find((removal) => removal.rootThreadId === rootThreadId)?.kind ?? "delete";
    const retry = this.resumeThreadRemovalOnce(rootThreadId)
      .finally(() => this.removalRetries.delete(rootThreadId));
    this.removalRetries.set(rootThreadId, { kind, promise: retry });
    return retry;
  }

  private async resumeThreadRemovalOnce(rootThreadId: string): Promise<void> {
    const session = await this.sessions.getOrCreate(rootThreadId);
    await session.withRuntimeAdmin(async () => {
      let prepared: PreparedThreadRemoval | undefined;
      try {
        prepared = await this.sessions.submit<PreparedThreadRemoval>(rootThreadId, {
          type: "threadAdmin",
          command: { kind: "recoverRemoval" },
        });
        await this.deleteProviderSession(prepared.claudeSessionId, prepared.cwd);
        const committed = await this.sessions.submit<string[] | false>(rootThreadId, {
          type: "threadAdmin",
          command: { kind: "providerSucceeded", operationId: prepared.operationId },
        });
        if (!committed) {
          throw new Error(`Stale Claude ${prepared.kind} recovery for thread '${rootThreadId}'.`);
        }
      } catch (error) {
        if (prepared) {
          await this.sessions.submit(rootThreadId, {
            type: "threadAdmin",
            command: {
              kind: "providerFailed",
              operationId: prepared.operationId,
              providerAttempted: true,
            },
          });
        }
        throw error;
      }
    });
    await this.sessions.retire(rootThreadId).catch((error) => {
      this.logger.warn("claude.thread-removal.session-retire-failed", {
        threadId: rootThreadId,
        error: String(error),
      });
    });
  }

  private async deleteProviderSession(sessionId: string, cwd: string): Promise<void> {
    try {
      await this.threadAdminEffects.delete(sessionId, cwd);
    } catch (error) {
      if (!String(error).toLowerCase().includes("not found")) throw error;
    }
  }

  private async reconcileAfterRestart(
    orphanProjectionIds: ReadonlySet<string>,
    recoveryRootIds: ReadonlySet<string>,
  ): Promise<void> {
    for (const threadId of orphanProjectionIds) {
      await this.sessions.submit(threadId, { type: "purgeStartupProjection" });
      await this.sessions.retire(threadId);
    }
    for (const threadId of recoveryRootIds) {
      try {
        const recovery = await this.sessions.submit<RestartRecovery>(threadId, {
          type: "recoverAfterRestart",
          statusCommandEnabled: this.config.features?.statusCommand ?? true,
        });
        for (const eventType of recovery.abandonedProviderEventTypes) {
          this.metrics.providerEvent(eventType, "abandoned");
        }
      } finally {
        await this.sessions.retire(threadId);
      }
    }
  }

  private async unloadIdleRuntimes(): Promise<void> {
    const idleMs = this.config.idleTimeoutSeconds * 1_000;
    for (const threadId of this.sessions.loadedOwnerIds()) {
      const session = await this.sessions.getOrCreate(threadId);
      const result = await session.retireRuntimeIfIdle(idleMs);
      if (result === "ephemeral") {
        await this.releaseEphemeralThread(threadId);
        continue;
      }
      if (result === "retired") {
        this.logger.info("claude.runtime.unloaded", { threadId });
        await this.sessions.retire(threadId);
      }
    }
  }

  private requireRecord(threadId: string, includeTurns: boolean): ClaudeThreadRecord {
    this.assertThreadAvailable(threadId);
    const record = this.store.getThreadRecord(threadId, includeTurns);
    if (!record) throw invalidParams(`Unknown Claude thread '${threadId}'.`);
    return record;
  }

  private requireIndependentThread(threadId: string, operation: string): void {
    const record = this.requireRecord(threadId, false);
    if (record.thread.parentThreadId) {
      throw invalidParams(`Cannot ${operation} Claude subagent thread '${threadId}'; it is a read-only projection.`);
    }
  }

  public isChildProjection(threadId: string): boolean {
    return Boolean(this.store.getThreadRecord(threadId, false)?.thread.parentThreadId);
  }

  private assertThreadAvailable(threadId: string): void {
    const pending = this.pendingThreadRemoval(threadId);
    if (pending) this.throwPendingRemoval(threadId, pending);
  }

  private throwPendingRemoval(threadId: string, removal: Pick<PendingThreadRemoval, "kind">): never {
    throw invalidParams(
      `Claude thread '${threadId}' is pending ${removal.kind}; retry the ${removal.kind} request after cleanup completes.`,
    );
  }

  private pendingThreadRemoval(threadId: string): PendingThreadRemoval | undefined {
    const removals = this.store.listPendingThreadRemovals();
    const pending = (rootThreadId: string): PendingThreadRemoval | undefined => {
      const durable = removals.find((removal) => removal.rootThreadId === rootThreadId);
      if (durable) return durable;
      const inFlight = this.removalRetries.get(rootThreadId);
      const record = inFlight && this.store.getThreadRecord(rootThreadId, false);
      return inFlight && record ? {
        rootThreadId,
        claudeSessionId: record.claudeSessionId,
        cwd: record.thread.cwd,
        kind: inFlight.kind,
      } : undefined;
    };
    const direct = pending(threadId);
    if (direct) return direct;
    let record = this.store.getThreadRecord(threadId, false);
    const seen = new Set<string>();
    while (record?.thread.parentThreadId && !seen.has(record.thread.id)) {
      seen.add(record.thread.id);
      const parentId = record.thread.parentThreadId;
      const removal = pending(parentId);
      if (removal) return removal;
      record = this.store.getThreadRecord(parentId, false);
    }
    return undefined;
  }

  private async newThreadRecord(
    params: ThreadStartParams,
    settings?: ThreadSettingsUpdateParams,
  ): Promise<ClaudeThreadRecord> {
    const modelPickerId = params.model;
    const claudeModelValue = modelPickerId && resolveClaudeModel(this.config, modelPickerId);
    if (!modelPickerId || !claudeModelValue)
      throw invalidParams("Claude thread requires a configured Claude model or alias.");
    if (params.permissions && params.sandbox) throw invalidParams("Claude thread start cannot combine permissions with sandbox.");
    const requestedServiceTier = normalizeClaudeServiceTier(this.config, modelPickerId, params.serviceTier);
    if (requestedServiceTier !== null && requestedServiceTier !== "default" && requestedServiceTier !== "fast")
      throw invalidParams(`Unsupported Claude service tier '${requestedServiceTier}'.`);
    const reasoningEffort = settings?.effort ?? null;
    const serviceTier = await this.validatedServiceTier(modelPickerId, reasoningEffort, requestedServiceTier);
    const createdAt = nowSeconds();
    const cwd = existingThreadCwd(params.cwd ?? process.cwd());
    return {
      thread: {
        id: uuidv7(),
        extra: null,
        sessionId: uuidv7(),
        forkedFromId: null,
        parentThreadId: null,
        preview: "",
        ephemeral: params.ephemeral ?? false,
        historyMode: params.historyMode ?? "legacy",
        modelProvider: "claude",
        createdAt,
        updatedAt: createdAt,
        recencyAt: createdAt,
        status: { type: "idle" },
        path: null,
        cwd,
        cliVersion: "claude-code",
        source: "appServer",
        threadSource: params.threadSource ?? null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
      },
      claudeSessionId: uuidv7(),
      modelPickerId,
      claudeModelValue,
      serviceTier,
      approvalPolicy: params.approvalPolicy ?? "on-request",
      approvalsReviewer: approvalsReviewer(params.approvalsReviewer),
      sandboxPolicy: params.permissions
        ? permissionProfileSandboxPolicy(params.permissions, cwd)
        : sandboxPolicy(params.sandbox, cwd),
      baseInstructions: params.baseInstructions ?? null,
      developerInstructions: params.developerInstructions ?? null,
      personality: settings?.personality ?? params.personality ?? null,
      resolvedModel: null,
      lastClaudeMessageUuid: null,
      lastCompletedTurnId: null,
      claudeCodeVersion: null,
      reasoningEffort,
      reasoningSummary: settings?.summary ?? null,
      collaborationMode: settings?.collaborationMode === undefined || settings.collaborationMode === null
        ? null
        : syncedCollaborationMode(
          settings.collaborationMode,
          modelPickerId,
          reasoningEffort as ThreadSettings["effort"],
        ),
      outputSchema: null,
      tokenUsageTotal: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      tokenUsageLast: null,
      modelContextWindow: null,
      providerCostUsdTotal: 0,
    };
  }

  private async applyTurnOverrides(params: TurnStartParams): Promise<void> {
    await this.applySettings({ ...params, effort: turnReasoningEffort(params) } as ThreadSettingsUpdateParams,
      params.outputSchema ?? null);
  }

  private async applySettings(
    params: ThreadSettingsUpdateParams,
    outputSchema?: unknown,
  ): Promise<void> {
    if (params.permissions && params.sandboxPolicy)
      throw invalidParams("Claude thread settings cannot combine permissions with sandboxPolicy.");
    if (params.effort && !["low", "medium", "high", "xhigh", "max"].includes(params.effort))
      throw invalidParams(`Unsupported Claude effort '${params.effort}'.`);
    let update: DesiredSettingsUpdate;
    let syncCanonicalSettings = false;
    const session = await this.sessions.getOrCreate(params.threadId);
    for (;;) {
      const before = await this.sessions.submit<ClaudeThreadRecord>(
        params.threadId,
        { type: "readThread", includeTurns: false },
      );
      const modelPickerId = params.model ?? before.modelPickerId;
      const claudeModelValue = resolveClaudeModel(this.config, modelPickerId);
      if (!claudeModelValue) throw invalidParams("Cannot switch a Claude thread to a Codex model.");
      const requestedServiceTier = normalizeClaudeServiceTier(
        this.config,
        modelPickerId,
        params.serviceTier === undefined ? before.serviceTier : params.serviceTier,
      );
      if (requestedServiceTier !== null && requestedServiceTier !== "default" && requestedServiceTier !== "fast")
        throw invalidParams(`Unsupported Claude service tier '${requestedServiceTier}'.`);
      const cwd = existingThreadCwd(params.cwd ?? before.thread.cwd);
      const reasoningEffort = params.effort === undefined ? before.reasoningEffort : params.effort;
      const serviceTier = await this.validatedServiceTier(
        modelPickerId,
        reasoningEffort,
        requestedServiceTier,
      );
      syncCanonicalSettings = requestedServiceTier === "fast" && serviceTier !== "fast";
      const collaborationMode = params.collaborationMode === undefined
        ? before.collaborationMode
        : params.collaborationMode;
      const candidate: ClaudeThreadRecord = {
        ...before,
        thread: { ...before.thread, cwd },
        modelPickerId,
        claudeModelValue,
        serviceTier,
        approvalPolicy: params.approvalPolicy ?? before.approvalPolicy,
        approvalsReviewer: approvalsReviewer(params.approvalsReviewer, before.approvalsReviewer),
        sandboxPolicy: params.permissions
          ? permissionProfileSandboxPolicy(params.permissions, cwd)
          : params.sandboxPolicy ?? before.sandboxPolicy,
        reasoningEffort,
        reasoningSummary: params.summary === undefined ? before.reasoningSummary : params.summary,
        collaborationMode: collaborationMode === null ? null : syncedCollaborationMode(
          collaborationMode, modelPickerId, reasoningEffort as ThreadSettings["effort"],
        ),
        personality: params.personality === undefined ? before.personality : params.personality,
        outputSchema: outputSchema === undefined ? before.outputSchema : outputSchema,
      };
      update = await this.sessions.submit<DesiredSettingsUpdate>(
        params.threadId,
        {
          type: "updateDesiredSettings",
          expectedGeneration: settingsGeneration(before),
          candidate,
          threadSettings: threadSettings(candidate),
        },
      );
      if (!update.conflict) break;
      await update.retryAfter;
    }
    if (!update.changed) {
      if (syncCanonicalSettings) {
        await this.sessions.submit(params.threadId, {
          type: "publishThreadSettings",
          threadSettings: threadSettings(update.record),
        });
      }
      return;
    }
    const updated = update.record;
    if (updated.thread.ephemeral && update.replacementId && update.replay) {
      try {
        await session.replaceEphemeralRuntime(
          update.replay,
          update.replacementId,
        );
      } catch (error) {
        await this.discardThreadSilently(params.threadId).catch(() => undefined);
        throw error;
      }
    }
  }

  private async validatedServiceTier(
    modelId: string,
    effort: string | null,
    serviceTier: string | null,
  ): Promise<string | null> {
    if (!this.modelCatalog) return serviceTier;
    const catalogId = claudeCatalogId(this.config, modelId);
    const model = (await this.modelCatalog.list()).find((candidate) => candidate.id === catalogId);
    if (!model) throw invalidParams(`Claude model '${modelId}' is not present in the current account catalog.`);
    if (effort && !model.supportedReasoningEfforts.some((level) => level.reasoningEffort === effort)) {
      throw invalidParams(`Claude model '${modelId}' does not support effort '${effort}'.`);
    }
    return serviceTier === "fast" && !model.serviceTiers.some((tier) => tier.id === "fast")
      ? null
      : serviceTier;
  }

  private async validateModelSettings(
    modelId: string,
    effort: string | null,
    serviceTier: string | null,
  ): Promise<void> {
    if (await this.validatedServiceTier(modelId, effort, serviceTier) !== serviceTier) {
      throw invalidParams(`Claude model '${modelId}' does not support the fast service tier.`);
    }
  }

  private async readStandaloneRateLimitStatus(): Promise<ClaudeRateLimitStatus> {
    const abort = new AbortController();
    const sdkQuery = this.queryFactory({
      prompt: idleUsagePrompt(abort.signal),
      options: {
        pathToClaudeCodeExecutable: this.config.claudeBinary,
        persistSession: false,
        abortController: abort,
        allowedTools: [],
        settingSources: ["user", "project", "local"],
        env: claudeEnvironment(),
        stderr: (line) => this.logger.debug("claude.usage-probe.stderr", { output: line }),
      },
    });
    let generation: number | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude usage probe timed out.")), 10_000);
        timer.unref();
      });
      await Promise.race([sdkQuery.initializationResult(), timeout]);
      generation = this.rateLimits.register(sdkQuery);
      return await this.rateLimits.readStatus();
    } finally {
      if (timer) clearTimeout(timer);
      if (generation !== undefined) this.rateLimits.unregister(generation);
      abort.abort();
      await Promise.resolve(sdkQuery.close()).catch(() => undefined);
    }
  }

  private async completeCommandTurn(
    threadId: string,
    turnId: string,
    synthetic: "status" | "state",
    render: () => Promise<string>,
  ): Promise<void> {
    let completion: Extract<ClaudeSessionCommand, { type: "completeSynthetic" }>;
    try {
      completion = {
        type: "completeSynthetic", turnId,
        text: await render(),
        status: "completed", codexErrorInfo: null,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      completion = {
        type: "completeSynthetic", turnId,
        text: systemNoticeText(
          `${synthetic === "status" ? "Unable to read Claude usage" : "Unable to read thread state"}: ${message}`,
          "error",
        ),
        status: "failed", errorMessage: message, codexErrorInfo: "internalServerError",
      };
    }
    await this.sessions.submit(threadId, completion).catch(() => undefined);
  }

  private async failStatusTurnForUnload(threadId: string, message: string): Promise<void> {
    await this.sessions.submit(threadId, {
      type: "completeSynthetic", text: systemNoticeText(message, "error"),
      status: "failed", errorMessage: message,
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
    });
  }

}
