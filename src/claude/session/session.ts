import { v7 as uuidv7 } from "uuid";
import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  HookInput,
  HookJSONOutput,
  PermissionResult,
  SDKMessage,
  SDKRateLimitInfo,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ThreadItem } from "../../codex/generated/v2/ThreadItem.js";
import type { Turn } from "../../codex/generated/v2/Turn.js";
import type {
  ClaudeThreadRecord,
  ProviderBoundaryCommit,
  ProviderEventDisposition,
  StateEvent,
} from "../../store/HybridStore.js";
import type { ClaudeSessionHandle } from "../sessionRegistry.js";
import { MetricsRegistry } from "../../observability/metrics.js";
import { invalidParams } from "../../protocol/errors.js";
import {
  classifyClaudeResult,
  classifyClaudeRuntimeError,
  type ClaudeResultClassification,
} from "../resultClassifier.js";
import type {
  ClaudeSessionCommand,
  CompactionProjection,
  CompactionTerminal,
  CompactionTransportAction,
  CompletedSessionTurn,
  DesiredSettingsUpdate,
  LifecycleFact,
  MainStreamFact,
  MainStreamProjection,
  OpenedSessionInteraction,
  ProviderEventAdmission,
  PreparedThreadAdmin,
  PreparedThreadRemoval,
  PreparedSessionTurn,
  RuntimeInspection,
  RuntimeInputAction,
  RuntimeTransportSettings,
  RuntimeTurnStage,
  RuntimeFactSource,
  RestartRecovery,
  SessionBranchSnapshot,
  SessionLifecycleUpdate,
  StartedShellCommand,
  ShellCancellation,
  GoalEffect,
  GoalSessionCommand,
  HookFact,
  StartedCompaction,
  ThreadAdminCommand,
  ThreadAdminOperation,
  ThreadRemovalKind,
  SessionInteractionRequest,
} from "./commands.js";
import { settingsGeneration, withSettingsFrom } from "../../store/HybridStore.js";
import { addUsage } from "./usage.js";
import {
  ClaudeMailbox,
  createDeferred,
  type ClaudeMailboxLane,
  type CommandEnvelope,
  type Deferred,
} from "./mailbox.js";
import type { ClaudeOutputAdapter } from "./outputAdapter.js";
import { remapBoundaries, type ClaudeSessionRepository } from "./repository.js";
import {
  completeTool, isImageRead, planSteps, projectToolCompletion, startTool, updateToolInput, type ActiveTool,
} from "../toolMapper.js";
import { isFileMutationTool, toolPolicy } from "../permissionPolicy.js";
import {
  newChildScope, newMainStreamState, scopeProjection, streamItem, taskUsesProvider, toolAt,
  type MainStreamState, type ScopeTask, type SessionTool,
} from "./scopeState.js";
import { systemNoticeText } from "../../gateway/transientNotice.js";
import { isClaudeStatusCommand } from "../statusCommand.js";
import { isCCodexStateCommand } from "../../state/stateCommand.js";
import {
  bindGoalTurn, consumeGoalContinuation, dispatchGoal, finishGoalTurn,
  goalEffects as nextGoalEffects, invalidateGoalEffect, newGoalState,
  runtimeAttached, runtimeDetached, runtimeSettingsChanged, type GoalContext,
} from "./goalState.js";
import { ShellRunner, type ShellProcess } from "./shellRunner.js";
import { diffFile, snapshotFile } from "../fileSnapshots.js";
import { appendHookProgress, completeHookRun, startHookRun, type ClaudeHookRun } from "../hookMapper.js";
import { readBackgroundOutput, type BackgroundOutputReader } from "./backgroundOutput.js";
import type { TurnStartParams } from "../../codex/generated/v2/TurnStartParams.js";
import type { TurnSteerParams } from "../../codex/generated/v2/TurnSteerParams.js";
import type { ThreadBackgroundTerminal } from "../../codex/generated/v2/ThreadBackgroundTerminal.js";
import type { CodexErrorInfo } from "../../codex/generated/v2/CodexErrorInfo.js";
import type { JsonValue } from "../../codex/generated/serde_json/JsonValue.js";
import type { TokenUsageBreakdown } from "../../codex/generated/v2/TokenUsageBreakdown.js";
import type { Logger } from "../../observability/logger.js";
import type { ClaudeQueryFactory } from "../queryFactory.js";
import type { TranscriptBrancher } from "../transcriptBrancher.js";
import type { ClaudeRateLimitCoordinator } from "../rateLimits.js";
import { createGoalMcpServer } from "../goalTools.js";
import { mapUserInput } from "../inputMapper.js";
import { bashCommandActions } from "../commandActions.js";
import { safeSessionPermissionUpdates } from "./permissionUpdates.js";
import {
  StaleClaudeRuntimeSettingsError,
  createProviderRuntime,
  providerPermissionMode,
  providerRuntimeSettings,
  runtimeTransportSettings,
  type RuntimeStartup,
} from "./providerRuntimeFactory.js";
import {
  isRetryableClaudeRuntimeStartupError,
  type ProviderRuntime,
} from "./providerRuntime.js";
import {
  assistantHasTools,
  backgroundOutputFile,
  backgroundTaskId,
  isNoQueryAcknowledgement,
  serverToolResult,
  toolResults,
  type ClaudeProviderFact,
  type RuntimeFactContext,
} from "./providerFacts.js";
import { normalizeClaudeModelIdentifier } from "../modelSelection.js";

const nullSource = { providerEventId: null, providerEventType: null } as const;
const providerJournalMaxEvents = 20_000;
const providerJournalMaxBytes = 256 * 1_024 * 1_024;
const providerJournalPruneInterval = 1_024;
const compactionWatchdogMs = 15 * 60_000;
const allowProviderTool = (): HookJSONOutput => ({
  continue: true,
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
  },
});

interface ClaudeIterationUsage {
  readonly input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly output_tokens: number;
}

function usageBreakdown(usage: ClaudeIterationUsage): TokenUsageBreakdown {
  const inputTokens = usage.input_tokens
    + usage.cache_creation_input_tokens
    + usage.cache_read_input_tokens;
  return {
    totalTokens: inputTokens + usage.output_tokens,
    inputTokens,
    cachedInputTokens: usage.cache_read_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: 0,
  };
}

function finalIterationUsage(
  message: Extract<SDKMessage, { type: "result"; subtype: "success" }>,
): ClaudeIterationUsage | undefined {
  const iterations = (message.usage as unknown as {
    iterations?: ClaudeIterationUsage[];
  }).iterations;
  return Array.isArray(iterations) && iterations.length > 0
    ? iterations.at(-1)
    : message.num_turns <= 1
      ? message.usage
      : undefined;
}

function residentBreakdown(
  totalTokens: number,
  iteration?: ClaudeIterationUsage,
): TokenUsageBreakdown {
  const outputTokens = Math.min(iteration?.output_tokens ?? 0, totalTokens);
  const inputTokens = totalTokens - outputTokens;
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens: Math.min(iteration?.cache_read_input_tokens ?? 0, inputTokens),
    outputTokens,
    reasoningOutputTokens: 0,
  };
}

function childProjectionIds(turns: readonly Turn[]): Set<string> {
  return new Set(turns.flatMap((turn) => turn.items.flatMap((item) => {
    if (item.type === "collabAgentToolCall") return item.receiverThreadIds;
    if (item.type === "subAgentActivity") return [item.agentThreadId];
    return [];
  })));
}

function commandLane(command: SessionMailboxCommand): ClaudeMailboxLane {
  if (command.type === "runtimeLineage"
    || command.type === "completeSynthetic" || command.type === "resolveInteraction"
    || command.type === "cancelInteraction" || command.type === "cancelInteractions"
    || command.type === "interruptCompaction" || command.type === "compactTransportCancelled"
    || command.type === "inspectRuntime" && command.control || command.type === "runtimeDetached"
    || command.type === "runtimeFailed" || command.type === "runtimeExited"
    || command.type === "compactRuntimeExited"
    || command.type === "disposeRuntimeOperations"
    || command.type === "threadAdmin"
    || command.type === "fenceCurrentRuntimeStop"
    || command.type === "prepareShellCancellation"
    || command.type === "finalizeShellCancellation"
    || command.type === "goal" && command.command.kind === "detach"
    || command.type === "lifecycle"
      && ["interrupt", "interruptAck", "runtimeExit"].includes(command.fact.type)) return "control";
  if (["providerEventStarted", "providerEventFinished", "providerBoundary", "providerRetract",
    "conversationReset", "modelFallback", "systemNotice", "runtimeNotification", "mainStream",
    "accountUsage", "accountCost", "publishUsage", "lifecycle", "compactBoundary", "compactFailed",
    "postCompact",
    ].includes(command.type)) return "provider";
  return "normal";
}

interface TurnLifecycle {
  result?: Omit<Extract<LifecycleFact, { type: "result" }>, "type" | "origin"> & { forced?: boolean };
  synthetic?: "status" | "state";
  commandId?: string;
  commandObserved: boolean;
  commandCompleted: boolean;
  notifications: number;
  acknowledged: number;
  request?: { covers: number; started: boolean };
  diagnosed: number;
  goals: number;
  goalInFlight: boolean;
}

export interface ClaudeSessionRuntimeDependencies {
  readonly claudeBinary: string;
  readonly logger: Logger;
  readonly queryFactory: ClaudeQueryFactory;
  readonly transcripts: TranscriptBrancher;
  readonly rateLimits: ClaudeRateLimitCoordinator;
  readonly invalidateModelCatalog: () => void;
  readonly isClosing: () => boolean;
  readonly persistUserSideSessions: boolean;
  readonly interactiveQuestions?: boolean;
  readonly resolveChildModel?: (model: string) => {
    readonly modelPickerId: string;
    readonly claudeModelValue: string;
  } | undefined;
}

interface RuntimeLease {
  readonly generation: number;
  readonly runtime: ProviderRuntime;
  readonly ready: Promise<void>;
  readonly activation: Deferred<RuntimeActivationResult>;
  readonly ephemeral: boolean;
  readonly resume: boolean;
  readonly rateLimitGeneration: number;
  readonly transportSettings: RuntimeTransportSettings;
  readonly appliedSettingsGeneration: number;
  readonly ephemeralPreludeBatches: readonly (readonly JsonValue[])[];
}

interface RuntimeGeneration extends RuntimeLease {
  readonly rateLimitGeneration: number;
  readonly settingsApplication?: RuntimeSettingsApplication;
}

type RuntimeActivationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

interface RuntimeCandidate extends RuntimeLease {}

type RuntimeSettingsResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

interface RuntimeSettingsApplication {
  readonly settings: RuntimeTransportSettings;
  readonly done: Promise<RuntimeSettingsResult>;
  readonly settle: (result: RuntimeSettingsResult) => void;
}

interface StagedClaudeTurn {
  readonly messageUuid: string;
  readonly message: SDKUserMessage;
  readonly readOnly: boolean;
}

interface ProviderProjectionState {
  readonly context: AsyncLocalStorage<RuntimeFactContext>;
  readonly processEpoch: string;
  providerSequence: number;
  runtime?: ProviderRuntime;
}

interface ProviderCallbackContext {
  readonly inspection: RuntimeInspection;
  readonly settings: RuntimeTransportSettings;
}

type RuntimeSettingsClaim =
  | { readonly kind: "applied" }
  | {
      readonly kind: "apply";
      readonly applied: RuntimeTransportSettings;
    }
  | { readonly kind: "wait"; readonly done: Promise<RuntimeSettingsResult> }
  | { readonly kind: "stale" };

type RuntimeCandidateResult =
  | { readonly ok: true; readonly candidate: RuntimeCandidate }
  | { readonly ok: false; readonly error: unknown };

type RuntimeLineage =
  | { readonly state: "absent" }
  | {
      readonly state: "starting";
      readonly generation: number;
      readonly candidateDone: Promise<RuntimeCandidateResult>;
      readonly settleCandidate: (result: RuntimeCandidateResult) => void;
      readonly startup: RuntimeStartup;
      readonly candidate?: RuntimeCandidate;
    }
  | {
      readonly state: "retiringStartup";
      readonly generation: number;
      readonly startup: RuntimeStartup;
      readonly candidate: RuntimeCandidate;
      readonly done: Promise<void>;
      readonly resolve: () => void;
    }
  | { readonly state: "ready"; readonly owner: RuntimeGeneration }
  | {
      readonly state: "retiring";
      readonly generation: number;
      readonly owner: RuntimeGeneration;
      readonly done: Promise<void>;
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
      readonly exited: boolean;
    };

type RuntimeStartClaim =
  | { readonly kind: "start"; readonly startup: RuntimeStartup }
  | { readonly kind: "lease"; readonly lease: RuntimeLease }
  | {
      readonly kind: "wait";
      readonly waitingFor: "candidate" | "retire";
      readonly done: Promise<RuntimeCandidateResult | void>;
    };

type RuntimeRetireClaim =
  | { readonly kind: "retire"; readonly owner: RuntimeGeneration }
  | { readonly kind: "retireStarting"; readonly startup: RuntimeStartup; readonly candidate: RuntimeCandidate }
  | { readonly kind: "wait"; readonly waitingFor: "start" | "retire"; readonly done: Promise<void> }
  | { readonly kind: "absent" };

type RuntimeOwnerInspection =
  | { readonly kind: "lease"; readonly lease: RuntimeLease }
  | { readonly kind: "wait"; readonly done: Promise<RuntimeCandidateResult | void> }
  | { readonly kind: "absent" };

type RuntimeLineageCommand =
  | {
      readonly type: "runtimeLineage";
      readonly action: "claimStart";
      readonly resumeOverride?: boolean;
      readonly replacement?: boolean;
    }
  | { readonly type: "runtimeLineage"; readonly action: "inspect"; readonly replacement?: boolean }
  | {
      readonly type: "runtimeLineage";
      readonly action: "started";
      readonly runtimeGeneration: number;
      readonly candidate: RuntimeCandidate;
    }
  | {
      readonly type: "runtimeLineage";
      readonly action: "candidateCreated";
      readonly runtimeGeneration: number;
      readonly candidate: RuntimeCandidate;
    }
  | {
      readonly type: "runtimeLineage";
      readonly action: "startFailed";
      readonly runtimeGeneration: number;
      readonly error: unknown;
    }
  | {
      readonly type: "runtimeLineage";
      readonly action: "startupRetired";
      readonly runtimeGeneration: number;
    }
  | {
      readonly type: "runtimeLineage";
      readonly action: "claimRetire";
      readonly runtimeGeneration?: number;
      readonly requireNoAdmin?: boolean;
      readonly requireQuiescent?: boolean;
      readonly staleOnly?: boolean;
      readonly replacement?: boolean;
    }
  | { readonly type: "runtimeLineage"; readonly action: "retired"; readonly runtimeGeneration: number }
  | {
      readonly type: "runtimeLineage";
      readonly action: "retireFailed";
      readonly runtimeGeneration: number;
      readonly error: unknown;
    }
  | {
      readonly type: "runtimeLineage";
      readonly action: "exited";
      readonly runtimeGeneration: number;
      readonly reason: string;
      readonly codexErrorInfo: CodexErrorInfo | null;
    }
  | {
      readonly type: "runtimeLineage";
      readonly action: "rateLimit";
      readonly runtimeGeneration: number;
      readonly info: SDKRateLimitInfo;
    }
  | {
      readonly type: "runtimeLineage";
      readonly action: "authFailure";
      readonly runtimeGeneration: number;
      readonly reason: string;
    }
  | { readonly type: "runtimeLineage"; readonly action: "catalogInvalidated"; readonly runtimeGeneration: number }
  | {
      readonly type: "runtimeLineage";
      readonly action: "providerCommand";
      readonly runtimeGeneration: number;
      readonly command: ClaudeSessionCommand;
    }
  | {
      readonly type: "runtimeLineage";
      readonly action: "inspectCallback";
      readonly runtimeGeneration: number;
      readonly providerId?: string;
      readonly ownerThreadId?: string;
    }
  | {
      readonly type: "runtimeLineage";
      readonly action: "providerGoal";
      readonly runtimeGeneration: number;
      readonly command: GoalSessionCommand;
    }
  | {
      readonly type: "runtimeLineage";
      readonly action: "claimSettings";
      readonly runtimeGeneration: number;
      readonly settings: RuntimeTransportSettings;
    }
  | {
      readonly type: "runtimeLineage";
      readonly action: "settingsApplied";
      readonly runtimeGeneration: number;
      readonly settings: RuntimeTransportSettings;
    }
  | {
      readonly type: "runtimeLineage";
      readonly action: "settingsFailed";
      readonly runtimeGeneration: number;
      readonly settingsGeneration: number;
      readonly error: unknown;
    }
  | {
      readonly type: "runtimeLineage";
      readonly action: "beginAdmin" | "endAdmin" | "beginInjection" | "endInjection";
    }
  | {
      readonly type: "runtimeLineage";
      readonly action: "beginReplacement" | "endReplacement";
      readonly replacementId: string;
    }
  | { readonly type: "runtimeLineage"; readonly action: "cancelReplacement" }
  | { readonly type: "runtimeLineage"; readonly action: "mayReleaseSession" }
  | {
      readonly type: "runtimeLineage";
      readonly action: "admitOperation";
      readonly runtimeGeneration: number;
      readonly replacement?: boolean;
    };

type SessionMailboxCommand = ClaudeSessionCommand | RuntimeLineageCommand;

export interface PreparedRuntimeTurn {
  readonly messageUuid: string;
  readonly readOnly: boolean;
  discard(): Promise<void>;
  attach(turn: PreparedSessionTurn["turn"]): () => Promise<void>;
}

export class ClaudeSession implements ClaudeSessionHandle<ClaudeSessionCommand> {
  private readonly mailbox: ClaudeMailbox<SessionMailboxCommand>;
  private readonly consumer: Promise<void>;
  private runtimeLineage: RuntimeLineage = { state: "absent" };
  private nextRuntimeGeneration = 0;
  private runtimeAdminOperations = 0;
  private runtimeAdminIdle: { readonly done: Promise<void>; readonly resolve: () => void } | undefined;
  private runtimeInjectionOperations = 0;
  private runtimeInjectionIdle: { readonly done: Promise<void>; readonly resolve: () => void } | undefined;
  private runtimeReplacement: {
    readonly id: string;
    readonly done: Promise<void>;
    readonly resolve: () => void;
  } | undefined;
  private readonly announcedTurns = new Set<string>();
  private readonly announcedInteractions = new Set<string>();
  private readonly interactionWaiters = new Map<string, {
    readonly promise: Promise<unknown>;
    readonly resolve: (response: unknown) => void;
    claimed: boolean;
    resolved: boolean;
  }>();
  private record: ClaudeThreadRecord | undefined;
  private runtimeGeneration: number | undefined;
  private readonly scopes = new Map<string, MainStreamState>();
  private readonly tasks = new Map<string, ScopeTask>();
  private compaction: (Omit<StartedCompaction, "turn"> & {
    readonly messageUuid: string;
    readonly runtimeGeneration: number;
    readonly watchdog: NodeJS.Timeout;
    transport: "pending" | "admitted" | "sent";
    cancellation?: CompactionTerminal;
    hidden?: {
      readonly completion: Deferred<string>;
      summary?: string;
      boundary?: { readonly source: RuntimeFactSource; readonly messageUuid: string };
    };
  }) | undefined;
  private readonly compactionActions: CompactionTransportAction[] = [];
  private lastPublishedUsage: string | undefined;
  private lifecycle: TurnLifecycle | undefined;
  private pendingNoQuery = 0;
  private pendingInputs = 0;
  private readonly stagedRuntimeTurns = new Set<string>();
  private readonly preparedRuntimeInputs = new Map<
    string, "turn" | "steer" | "hiddenGoal" | "noQuery"
  >();
  private readonly runtimeInjections: Array<{
    readonly runtimeGeneration: number;
    readonly messageUuid: string;
    admitted: boolean;
    readonly replayablePrelude: boolean;
    readonly items: readonly JsonValue[];
    readonly acknowledgement?: {
      readonly done: Promise<RuntimeSettingsResult>;
      readonly settle: (result: RuntimeSettingsResult) => void;
    };
  }> = [];
  private hasSubmittedRuntimeInput = false;
  private providerError: string | undefined;
  private readonly goalUsageEvents = new Set<string>();
  private goalCommandTokensObserved = 0;
  private usageSnapshotGeneration = 0;
  private rootReadOnly = false;
  private interruptFence = false;
  private transportStopFence = false;
  private dropLateFacts = false;
  private continuationTimer: NodeJS.Timeout | undefined;
  private lastQuiescent = false;
  private lastActivityMs = Date.now();
  private lastAcceptProviderFacts = true;
  private readonly goal = newGoalState();
  private readonly hookRuns = new Map<string, ClaudeHookRun>();
  private readonly suppressedHookRuns = new Set<string>();
  private suppressNextPostCompactHook = false;
  private hookDisplayOrder = 0;
  private adminOperation: {
    readonly operationId: string;
    readonly kind: ThreadAdminOperation | ThreadRemovalKind;
    readonly name?: string;
  } | undefined;
  private shell: {
    readonly operationId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly startedAtMs: number;
    readonly done: Promise<void>;
    readonly resolve: () => void;
    process?: ShellProcess;
    cancelling: boolean;
  } | undefined;

  public constructor(
    private readonly threadId: string,
    private readonly repository: ClaudeSessionRepository,
    private readonly output: ClaudeOutputAdapter,
    capacity?: number,
    private readonly metrics: MetricsRegistry = new MetricsRegistry(),
    private readonly onLifecycle: (update: SessionLifecycleUpdate) => void = () => undefined,
    private readonly onChildCreated: (threadId: string) => void = () => undefined,
    private readonly onChildRemoved: (threadId: string) => void = () => undefined,
    private readonly shellRunner: ShellRunner = new ShellRunner(),
    private readonly backgroundOutputReader: BackgroundOutputReader = readBackgroundOutput,
    private readonly runtimeDependencies?: ClaudeSessionRuntimeDependencies,
  ) {
    this.mailbox = new ClaudeMailbox(capacity);
    this.consumer = this.run();
  }

  public submit<Result>(command: ClaudeSessionCommand): Promise<Result> {
    return this.mailbox.submit<Result>(command, { lane: commandLane(command) });
  }

  private submitLineage<Result>(command: RuntimeLineageCommand): Promise<Result> {
    return this.mailbox.submit<Result>(command, { lane: "control" });
  }

  private submitRuntimeEffect<Result>(command: ClaudeSessionCommand): Promise<Result> {
    return this.mailbox.submit<Result>(command, { lane: "control" });
  }

  private beginRuntimeReplacement(replacementId: string): void {
    if (this.runtimeReplacement) {
      throw invalidParams(`Claude runtime '${this.threadId}' already has a settings replacement in progress.`);
    }
    let resolve!: () => void;
    const done = new Promise<void>((settled) => { resolve = settled; });
    this.runtimeReplacement = { id: replacementId, done, resolve };
  }

  public get isLoaded(): boolean {
    return this.runtimeLineage.state !== "absent";
  }

  public async ensureRuntime(reinitialize = false): Promise<void> {
    const owner = await this.requireRuntimeOwner();
    try {
      await owner.ready;
    } catch (error) {
      await owner.activation.promise;
      throw error;
    }
    if (reinitialize) await owner.runtime.reinitialize();
  }

  public async ensureEphemeralRuntime(): Promise<void> {
    try {
      await this.ensureRuntime();
    } catch (error) {
      if (!isRetryableClaudeRuntimeStartupError(error)) throw error;
      await this.ensureRuntime();
    }
  }

  public async materializeRuntime(): Promise<void> {
    for (;;) {
      const claim = await this.submitLineage<RuntimeStartClaim>({
        type: "runtimeLineage",
        action: "claimStart",
      });
      if (claim.kind === "lease") {
        await claim.lease.ready;
        await claim.lease.runtime.reinitialize();
        await this.refreshProviderContextUsage(claim.lease);
        return;
      }
      if (claim.kind === "wait") {
        if (claim.waitingFor === "retire") {
          await claim.done.catch(() => undefined);
          continue;
        }
        const result = await claim.done as RuntimeCandidateResult;
        if (!result.ok) throw result.error;
        return;
      }
      try {
        const candidate = await this.createRuntimeGeneration(claim.startup);
        void this.completeRuntimeGeneration(claim.startup, candidate).catch(() => undefined);
        if (candidate.resume) {
          await candidate.ready;
          await this.refreshProviderContextUsage(candidate);
        }
        return;
      } catch (error) {
        await this.submitLineage({
          type: "runtimeLineage",
          action: "startFailed",
          runtimeGeneration: claim.startup.runtimeGeneration,
          error,
        });
        throw error;
      }
    }
  }

  public async prepareRuntimeTurn(params: TurnStartParams, readOnly = false): Promise<PreparedRuntimeTurn> {
    for (;;) {
      const owner = await this.requireRuntimeOwner();
      if (!await this.admitRuntimeOperation(owner)) continue;
      try {
        const staged = await this.stageRuntimeTurn(
          owner,
          params,
          owner.transportSettings,
          owner.appliedSettingsGeneration,
          readOnly,
        );
        return {
          messageUuid: staged.messageUuid,
          readOnly: staged.readOnly,
          discard: () => this.discardRuntimeTurn(owner, staged),
          attach: (turn) => this.attachRuntimeTurn(owner, turn, staged),
        };
      } catch (error) {
        if (!(error instanceof StaleClaudeRuntimeSettingsError)) throw error;
        if (owner.ephemeral && error.reason === "settings") {
          await this.applyRuntimeSettings(owner, error.settings);
          continue;
        }
        await this.retireRuntimeOwner(owner, "stale");
      }
    }
  }

  public async interruptRuntime(expectedTurnId?: string): Promise<void> {
    const owner = await this.requireRuntimeOwner();
    if (await this.interruptRuntimeOwner(owner, expectedTurnId)) {
      await this.retireRuntimeOwner(owner, "silent");
    }
  }

  public fenceCurrentRuntimeStop(expectedTurnId?: string): Promise<boolean> {
    return this.submit({
      type: "fenceCurrentRuntimeStop",
      ...(expectedTurnId ? { expectedTurnId } : {}),
    });
  }

  public async interruptChildRuntime(childThreadId: string, expectedTurnId?: string): Promise<void> {
    await this.interruptChildRuntimeOwner(await this.requireRuntimeOwner(), childThreadId, expectedTurnId);
  }

  public async listBackgroundTerminals(ownerThreadId: string): Promise<ThreadBackgroundTerminal[]> {
    return this.listRuntimeBackgroundTerminals(await this.requireRuntimeOwner(), ownerThreadId);
  }

  public async cleanBackgroundTerminals(ownerThreadId: string): Promise<void> {
    const owner = await this.requireRuntimeOwner();
    const processIds = (await this.listRuntimeBackgroundTerminals(owner, ownerThreadId))
      .map((terminal) => terminal.processId);
    await Promise.all(processIds.map((processId) =>
      this.terminateRuntimeBackgroundTerminal(owner, ownerThreadId, processId)));
  }

  public async terminateBackgroundTerminal(ownerThreadId: string, processId: string): Promise<boolean> {
    return this.terminateRuntimeBackgroundTerminal(
      await this.requireRuntimeOwner(),
      ownerThreadId,
      processId,
    );
  }

  public async steerRuntime(params: TurnSteerParams): Promise<string> {
    const owner = await this.requireRuntimeOwner();
    return this.steerRuntimeOwner(owner, params, owner.transportSettings);
  }

  public async compactRuntime(): Promise<void> {
    const owner = await this.requireRuntimeOwner();
    await this.awaitRuntimeActivation(owner);
    await this.submitRuntimeEffect({ type: "startCompact" });
    await this.invalidateRuntimeUsageSnapshot(owner.generation);
  }

  public async compactRuntimeForHandoff(input = "/compact"): Promise<string> {
    const owner = await this.requireRuntimeOwner();
    await this.awaitRuntimeActivation(owner);
    const started = await this.submitRuntimeEffect<StartedCompaction>({
      type: "startCompact",
      input,
      hidden: true,
    });
    await this.invalidateRuntimeUsageSnapshot(owner.generation);
    if (!started.completion) throw new Error("Hidden Claude compaction was not admitted.");
    return started.completion;
  }

  public async preparePromptedCompaction(input: string): Promise<{
    turn: Turn;
    announce: () => Promise<void>;
  }> {
    const owner = await this.requireRuntimeOwner();
    await this.awaitRuntimeActivation(owner);
    const started = await this.submitRuntimeEffect<StartedCompaction>({
      type: "startCompact",
      input,
      deferred: true,
    });
    await this.invalidateRuntimeUsageSnapshot(owner.generation);
    let announcement: Promise<void> | undefined;
    return {
      turn: started.turn,
      announce: () => announcement ??= this.submitRuntimeEffect({
        type: "announceCompaction",
        operationId: started.operationId,
      }),
    };
  }

  public async injectRuntimeItems(items: JsonValue[], waitForAcknowledgement = false): Promise<void> {
    await this.withRuntimeInjection(async () => {
      for (;;) {
        const owner = await this.requireRuntimeOwner();
        if (!await this.admitRuntimeOperation(owner)) continue;
        await this.injectRuntimeItemsForOwner(owner, items, waitForAcknowledgement);
        return;
      }
    });
  }

  public async runtimeInspection(): Promise<(RuntimeInspection & { runtimeGeneration: number }) | undefined> {
    const owner = await this.currentRuntimeOwner();
    return owner
      ? this.submit<RuntimeInspection>({
        type: "inspectRuntime",
        runtimeGeneration: owner.generation,
      }).then((inspection) => ({ ...inspection, runtimeGeneration: owner.generation }))
      : undefined;
  }

  public async runtimeIsPlanMode(): Promise<boolean> {
    return this.planMode();
  }

  public async replaceEphemeralRuntime(
    replay: { readonly resume: boolean; readonly batches: JsonValue[][] },
    replacementId = uuidv7(),
  ): Promise<void> {
    for (;;) {
      const claim = await this.submitLineage<true | Promise<void>>({
        type: "runtimeLineage",
        action: "beginReplacement",
        replacementId,
      });
      if (claim === true) break;
      await claim;
    }
    try {
      const current = await this.currentRuntimeOwner(true);
      if (current) await this.retireRuntimeOwner(current, "ephemeral", undefined, false, false, true);
      const owner = await this.requireRuntimeOwner(replay.resume, true);
      for (const batch of replay.batches) {
        await this.injectRuntimeItemsForOwner(owner, batch, true, true);
      }
    } finally {
      await this.submitLineage({
        type: "runtimeLineage",
        action: "endReplacement",
        replacementId,
      });
    }
  }

  public async ephemeralRuntimeReplay(): Promise<{
    readonly canRestart: boolean;
    readonly replay?: { readonly resume: boolean; readonly batches: JsonValue[][] };
  }> {
    const owner = await this.currentRuntimeOwner();
    if (!owner || !owner.ephemeral) return { canRestart: false };
    const canRestart = await this.canRestartEphemeral(owner);
    return {
      canRestart,
      ...(canRestart
        ? {
            replay: {
              resume: owner.resume,
              batches: owner.ephemeralPreludeBatches.map((batch) => [...batch]),
            },
          }
        : {}),
    };
  }

  public async retireRuntime(reason = "Claude runtime unloaded."): Promise<void> {
    const owner = await this.currentRuntimeOwner();
    if (owner) await this.retireRuntimeOwner(owner, "stop", reason);
  }

  public async retireRuntimeSilently(): Promise<void> {
    const owner = await this.currentRuntimeOwner();
    if (owner) await this.retireRuntimeOwner(owner, "silent");
  }

  public async retireRuntimeIfIdle(milliseconds: number): Promise<"retired" | "ephemeral" | "busy" | "absent"> {
    const owner = await this.currentRuntimeOwner();
    if (!owner) return "absent";
    if (!await this.runtimeIdleFor(owner, milliseconds)) return "busy";
    if (owner.ephemeral) return "ephemeral";
    if (!await this.retireRuntimeOwner(owner, "stop", undefined, true, true)) return "busy";
    if (!await this.submitLineage<boolean>({
      type: "runtimeLineage",
      action: "mayReleaseSession",
    })) return "busy";
    return "retired";
  }

  public mayRelease(): Promise<boolean> {
    return this.submitLineage({
      type: "runtimeLineage",
      action: "mayReleaseSession",
    });
  }

  public async withRuntimeAdmin<Result>(effect: () => Promise<Result>): Promise<Result> {
    const pending = await this.submitLineage<Promise<void> | undefined>({
      type: "runtimeLineage",
      action: "beginAdmin",
    });
    try {
      await pending;
      return await effect();
    } finally {
      await this.submitLineage({ type: "runtimeLineage", action: "endAdmin" });
    }
  }

  private async withRuntimeInjection<Result>(effect: () => Promise<Result>): Promise<Result> {
    const pending = await this.submitLineage<Promise<void> | undefined>({
      type: "runtimeLineage",
      action: "beginInjection",
    });
    try {
      await pending;
      return await effect();
    } finally {
      await this.submitLineage({ type: "runtimeLineage", action: "endInjection" });
    }
  }

  public async close(): Promise<void> {
    if (this.continuationTimer) clearTimeout(this.continuationTimer);
    if (this.compaction) clearTimeout(this.compaction.watchdog);
    await this.submit({ type: "goal", command: { kind: "detach", checkpoint: "shutdown" } }).catch(() => undefined);
    await this.submit({ type: "prepareShellCancellation" }).catch(() => undefined);
    await this.submit({ type: "disposeRuntimeOperations" }).catch(() => undefined);
    await this.submitLineage({ type: "runtimeLineage", action: "cancelReplacement" }).catch(() => undefined);
    const owner = await this.currentRuntimeOwner(true).catch(() => undefined);
    if (owner) {
      await this.retireRuntimeOwner(
        owner,
        "stop",
        "Gateway shut down during an active Claude turn.",
        false,
        false,
        true,
      ).catch(() => undefined);
    }
    this.mailbox.close();
    await this.consumer;
  }

  private async requireRuntimeOwner(resumeOverride?: boolean, replacement = false): Promise<RuntimeLease> {
    if (!this.runtimeDependencies || this.runtimeDependencies.isClosing()) {
      throw invalidParams("Claude service is closing.");
    }
    for (;;) {
      const claim = await this.submitLineage<RuntimeStartClaim>({
        type: "runtimeLineage",
        action: "claimStart",
        ...(resumeOverride === undefined ? {} : { resumeOverride }),
        ...(replacement ? { replacement: true } : {}),
      });
      if (claim.kind === "lease") return claim.lease;
      if (claim.kind === "wait") {
        if (claim.waitingFor === "candidate") {
          const result = await claim.done as RuntimeCandidateResult;
          if (!result.ok) throw result.error;
        } else await claim.done.catch(() => undefined);
        continue;
      }
      try {
        const candidate = await this.createRuntimeGeneration(claim.startup);
        void this.completeRuntimeGeneration(claim.startup, candidate).catch(() => undefined);
        return candidate;
      } catch (error) {
        await this.submitLineage({
          type: "runtimeLineage",
          action: "startFailed",
          runtimeGeneration: claim.startup.runtimeGeneration,
          error,
        });
        throw error;
      }
    }
  }

  private async currentRuntimeOwner(replacement = false): Promise<RuntimeLease | undefined> {
    for (;;) {
      const inspection = await this.submitLineage<RuntimeOwnerInspection>({
        type: "runtimeLineage",
        action: "inspect",
        ...(replacement ? { replacement: true } : {}),
      });
      if (inspection.kind === "absent") return undefined;
      if (inspection.kind === "lease") return inspection.lease;
      const result = await inspection.done.catch(() => undefined);
      if (result && "ok" in result && !result.ok) return undefined;
    }
  }

  private runtimeStartup(generation: number, resumeOverride?: boolean): RuntimeStartup {
    const record = this.requireRecord(false);
    return {
      threadId: this.threadId,
      runtimeGeneration: generation,
      providerSessionId: record.claudeSessionId,
      resume: resumeOverride ?? record.lastClaudeMessageUuid !== null,
      cwd: record.thread.cwd,
      ephemeral: record.thread.ephemeral,
      persistSession: !record.thread.ephemeral || Boolean(
        this.runtimeDependencies!.persistUserSideSessions
        && !record.thread.parentThreadId
        && record.thread.threadSource === "user"
      ),
      claudeBinary: this.runtimeDependencies!.claudeBinary,
      model: record.claudeModelValue,
      settingsGeneration: settingsGeneration(record),
      lastCompletedTurnId: record.lastCompletedTurnId,
      modelContextWindow: record.modelContextWindow,
      approvalPolicy: record.approvalPolicy,
      approvalsReviewer: record.approvalsReviewer,
      sandboxPolicy: record.sandboxPolicy,
      baseInstructions: record.baseInstructions,
      developerInstructions: record.developerInstructions,
      personality: record.personality,
      serviceTier: record.serviceTier,
      reasoningEffort: record.reasoningEffort,
      reasoningSummary: record.reasoningSummary,
      collaborationMode: record.collaborationMode,
      outputSchema: record.outputSchema,
      interactiveQuestions: this.runtimeDependencies!.interactiveQuestions ?? true,
    };
  }

  private async createRuntimeGeneration(startup: RuntimeStartup): Promise<RuntimeCandidate> {
    const dependencies = this.runtimeDependencies!;
    let runtime: ProviderRuntime | undefined;
    const projection: ProviderProjectionState = {
      context: new AsyncLocalStorage<RuntimeFactContext>(),
      processEpoch: uuidv7(),
      providerSequence: 0,
    };
    try {
      runtime = createProviderRuntime(
        startup,
        dependencies.logger,
        dependencies.queryFactory,
        (fact) => this.handleProviderFact(projection, fact),
        {
          canUseTool: (name, input, options) =>
            this.canUseProviderTool(projection, startup.runtimeGeneration, name, input, options),
          onElicitation: (request, signal) =>
            this.handleProviderElicitation(startup.runtimeGeneration, request, signal),
          beforeToolUse: (input, toolUseId) =>
            this.beforeProviderToolUse(startup.runtimeGeneration, input, toolUseId),
          captureFileAfter: (input, toolUseId) =>
            this.captureProviderFileAfter(startup.runtimeGeneration, input, toolUseId),
          afterCompact: (input) =>
            this.afterProviderCompact(startup.runtimeGeneration, input),
        },
        {
          mcpServer: createGoalMcpServer(
            <Result>(command: GoalSessionCommand) => this.submitLineage<Result>({
              type: "runtimeLineage",
              action: "providerGoal",
              runtimeGeneration: startup.runtimeGeneration,
              command,
            }),
          ),
        },
      );
      projection.runtime = runtime;
      await this.submitProviderProjection(startup.runtimeGeneration, {
        type: "attachRuntime",
        runtimeGeneration: startup.runtimeGeneration,
      });
      runtime.start();
      const ready = this.waitForProviderRuntime(runtime);
      await Promise.resolve();
      if (runtime.hasExited) {
        await ready;
        throw runtime.initializationFailure(
          new Error(`Claude runtime '${this.threadId}' became unavailable during initialization.`),
        );
      }
      const transportSettings = runtimeTransportSettings(startup);
      const rateLimitGeneration = dependencies.rateLimits.register({
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => runtime!.usageSnapshot(),
      });
      const candidate: RuntimeCandidate = {
        generation: startup.runtimeGeneration,
        runtime,
        ready,
        activation: createDeferred(),
        ephemeral: startup.ephemeral,
        resume: startup.resume,
        rateLimitGeneration,
        transportSettings,
        appliedSettingsGeneration: transportSettings.settingsGeneration,
        ephemeralPreludeBatches: [],
      };
      if (!await this.submitLineage<boolean>({
        type: "runtimeLineage",
        action: "candidateCreated",
        runtimeGeneration: startup.runtimeGeneration,
        candidate,
      })) {
        dependencies.rateLimits.unregister(rateLimitGeneration);
        await this.retireProviderRuntimeSilently(candidate).catch(() =>
          this.stopProviderRuntime(
            candidate,
            "Claude runtime initialization failed.",
            true,
          ).catch(() => undefined));
        throw new Error(`Claude runtime '${this.threadId}' became stale during initialization.`);
      }
      void this.submit({
        type: "lifecycle",
        runtimeGeneration: startup.runtimeGeneration,
        fact: { type: "sync" },
        source: { providerEventId: null, providerEventType: null },
      });
      return candidate;
    } catch (error) {
      if (runtime) {
        await this.stopProviderRuntime(
          { generation: startup.runtimeGeneration, runtime },
          "Claude runtime initialization failed.",
          true,
        ).catch(() => undefined);
      }
      dependencies.logger.error("claude.runtime.initialization-failed", {
        threadId: this.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async waitForProviderRuntime(runtime: ProviderRuntime): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        runtime.initializationResult(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Claude session initialization timed out.")),
            15_000,
          );
          timer.unref();
        }),
      ]);
    } catch (error) {
      throw runtime.initializationFailure(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async awaitRuntimeActivation(owner: RuntimeLease): Promise<void> {
    const result = await owner.activation.promise;
    if (!result.ok) throw result.error;
  }

  private async applyRuntimeSettings(
    expectedOwner: RuntimeLease,
    settings: RuntimeTransportSettings,
  ): Promise<void> {
    await expectedOwner.ready;
    for (;;) {
      const claim = await this.submitLineage<RuntimeSettingsClaim>({
        type: "runtimeLineage",
        action: "claimSettings",
        runtimeGeneration: expectedOwner.generation,
        settings,
      });
      if (claim.kind === "applied") return;
      if (claim.kind === "stale") {
        throw new StaleClaudeRuntimeSettingsError(
          `Claude runtime '${this.threadId}' changed while applying settings.`,
          "runtime",
          settings,
        );
      }
      if (claim.kind === "wait") {
        const result = await claim.done;
        if (!result.ok) throw result.error;
        continue;
      }
      try {
        await expectedOwner.runtime.applySettings(providerRuntimeSettings(settings));
        if (!await this.submitLineage<boolean>({
          type: "runtimeLineage",
          action: "settingsApplied",
          runtimeGeneration: expectedOwner.generation,
          settings,
        })) {
          throw new StaleClaudeRuntimeSettingsError(
            `Claude runtime '${this.threadId}' changed while applying settings.`,
            "runtime",
            settings,
          );
        }
        return;
      } catch (error) {
        await this.submitLineage({
          type: "runtimeLineage",
          action: "settingsFailed",
          runtimeGeneration: expectedOwner.generation,
          settingsGeneration: settings.settingsGeneration,
          error,
        });
        throw error;
      }
    }
  }

  private runtimeInspectionFor(owner: Pick<RuntimeGeneration, "generation">): Promise<RuntimeInspection> {
    return this.submitRuntimeEffect({
      type: "inspectRuntime",
      runtimeGeneration: owner.generation,
    });
  }

  private async canRestartEphemeral(owner: RuntimeLease): Promise<boolean> {
    return (await this.runtimeInspectionFor(owner)).canRestartEphemeral;
  }

  private async runtimeIdleFor(owner: RuntimeLease, milliseconds: number): Promise<boolean> {
    const inspection = await this.runtimeInspectionFor(owner);
    return inspection.quiescent && Date.now() - inspection.lastActivityMs >= milliseconds;
  }

  private async invalidateRuntimeUsageSnapshot(runtimeGeneration: number): Promise<void> {
    await this.submitRuntimeEffect({
      type: "runtimeUsageSnapshot",
      runtimeGeneration,
      action: "invalidate",
    });
  }

  private async stageRuntimeTurn(
    owner: RuntimeLease,
    params: TurnStartParams,
    settings: RuntimeTransportSettings,
    appliedGeneration: number,
    readOnly = false,
  ): Promise<StagedClaudeTurn> {
    await this.invalidateRuntimeUsageSnapshot(owner.generation);
    const messageUuid = uuidv7();
    const staged = await this.submitRuntimeEffect<RuntimeTurnStage>({
      type: "stageRuntimeTurn",
      runtimeGeneration: owner.generation,
      settingsGeneration: appliedGeneration,
      messageUuid,
    });
    if (staged.kind === "busy") {
      throw invalidParams(`Thread '${this.threadId}' already has an active turn.`);
    }
    if (staged.kind === "stale") {
      throw new StaleClaudeRuntimeSettingsError(
        `Claude runtime '${this.threadId}' has stale settings.`,
        staged.reason,
        staged.settings,
      );
    }
    const sandboxPolicy = readOnly
      ? { type: "readOnly" as const, networkAccess: false }
      : settings.sandboxPolicy;
    try {
      const message = await mapUserInput(params.input, messageUuid, {
        cwd: settings.cwd,
        sandboxPolicy,
        origin: "human",
      });
      return { messageUuid, message, readOnly };
    } catch (error) {
      await this.submitRuntimeEffect({
        type: "cancelRuntimeTurnStage",
        runtimeGeneration: owner.generation,
        messageUuid,
      });
      throw error;
    }
  }

  private async discardRuntimeTurn(owner: RuntimeLease, staged: StagedClaudeTurn): Promise<void> {
    await this.submitRuntimeEffect({
      type: "cancelRuntimeTurnStage",
      runtimeGeneration: owner.generation,
      messageUuid: staged.messageUuid,
    });
  }

  private attachRuntimeTurn(
    owner: RuntimeLease,
    turn: PreparedSessionTurn["turn"],
    staged: StagedClaudeTurn,
  ): () => Promise<void> {
    return async () => {
      await this.sendPreparedRuntimeInput(owner, staged.messageUuid, staged.message, () =>
        this.submitRuntimeEffect<RuntimeInputAction | undefined>({
          type: "prepareRuntimeInput",
          runtimeGeneration: owner.generation,
          messageUuid: staged.messageUuid,
          kind: "turn",
          turnId: turn.id,
        }));
    };
  }

  private async steerRuntimeOwner(
    owner: RuntimeLease,
    params: TurnSteerParams,
    settings: RuntimeTransportSettings,
  ): Promise<string> {
    await this.invalidateRuntimeUsageSnapshot(owner.generation);
    const messageUuid = uuidv7();
    const message = await mapUserInput(params.input, messageUuid, {
      cwd: settings.cwd,
      sandboxPolicy: settings.sandboxPolicy,
      origin: "human",
    });
    const action = await this.sendPreparedRuntimeInput(owner, messageUuid, message, () =>
      this.submitRuntimeEffect<RuntimeInputAction | undefined>({
        type: "steer",
        runtimeGeneration: owner.generation,
        messageUuid,
        expectedTurnId: params.expectedTurnId,
        ...(params.clientUserMessageId === undefined
          ? {}
          : { clientUserMessageId: params.clientUserMessageId }),
        input: params.input,
      }));
    if (!action) {
      throw invalidParams(`Turn '${params.expectedTurnId}' stopped before the steer was admitted.`);
    }
    return action.turnId!;
  }

  private async injectHiddenGoalPrompt(owner: RuntimeLease, prompt: string): Promise<boolean> {
    const turnId = (await this.runtimeInspectionFor(owner)).activeTurnId;
    if (!turnId) return false;
    const messageUuid = uuidv7();
    const message = {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      uuid: messageUuid,
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    } as unknown as SDKUserMessage;
    return Boolean(await this.sendPreparedRuntimeInput(owner, messageUuid, message, () =>
      this.submitRuntimeEffect<RuntimeInputAction | undefined>({
        type: "prepareRuntimeInput",
        runtimeGeneration: owner.generation,
        messageUuid,
        kind: "hiddenGoal",
        turnId,
      })));
  }

  private async injectRuntimeItemsIntoOwner(
    owner: RuntimeLease,
    items: JsonValue[],
    waitForAcknowledgement: boolean,
    replayablePrelude: boolean,
  ): Promise<void> {
    await this.invalidateRuntimeUsageSnapshot(owner.generation);
    const input = [{
      type: "text" as const,
      text: `[Injected model-visible history]\n${items.map((item) => JSON.stringify(item)).join("\n")}`,
      text_elements: [],
    }];
    const messageUuid = uuidv7();
    const message = await mapUserInput(input, messageUuid);
    const staged = await this.submitRuntimeEffect<{
      previous: string | null;
      acknowledgement?: Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }>;
    }>({
      type: "stageInjection",
      runtimeGeneration: owner.generation,
      messageUuid,
      waitForAcknowledgement,
      replayablePrelude,
      items,
    });
    let sent = false;
    try {
      const counted = await this.sendPreparedRuntimeInput(
        owner,
        messageUuid,
        { ...message, shouldQuery: false },
        () => this.submitRuntimeEffect<RuntimeInputAction | undefined>({
          type: "prepareRuntimeInput",
          runtimeGeneration: owner.generation,
          messageUuid,
          kind: "noQuery",
        }),
        () => { sent = true; },
      );
      if (!counted) throw new Error("Claude history injection was cancelled before provider admission.");
    } catch (error) {
      await this.submitRuntimeEffect({
        type: "cancelInjection",
        runtimeGeneration: owner.generation,
        messageUuid,
        previous: staged.previous,
        reason: error instanceof Error ? error.message : String(error),
        rollbackBoundary: !sent,
      });
      throw error;
    }
    const acknowledgement = await staged.acknowledgement;
    if (acknowledgement && !acknowledgement.ok) throw acknowledgement.error;
  }

  private async sendPreparedRuntimeInput(
    owner: RuntimeLease,
    messageUuid: string,
    message: SDKUserMessage,
    admit: () => Promise<RuntimeInputAction | undefined>,
    afterSend?: () => void,
  ): Promise<RuntimeInputAction | undefined> {
    owner.runtime.ownMessage(messageUuid);
    try {
      const result = await admit();
      if (!result) {
        owner.runtime.releaseMessage(messageUuid);
        return undefined;
      }
      const claimed = await this.submitRuntimeEffect<boolean>({
        type: "claimRuntimeInput",
        runtimeGeneration: owner.generation,
        messageUuid,
      });
      if (!claimed) {
        owner.runtime.releaseMessage(messageUuid);
        return undefined;
      }
      owner.runtime.send(message);
      afterSend?.();
      await this.submitRuntimeEffect({
        type: "completeRuntimeInput",
        runtimeGeneration: owner.generation,
        messageUuid,
        sent: true,
      });
      return result;
    } catch (error) {
      owner.runtime.releaseMessage(messageUuid);
      throw error;
    }
  }

  private async interruptRuntimeOwner(
    owner: RuntimeLease,
    expectedTurnId?: string,
  ): Promise<boolean> {
    const compact = await this.submitRuntimeEffect<CompactionProjection | undefined>({
      type: "interruptCompaction",
      ...(expectedTurnId === undefined ? {} : { turnId: expectedTurnId }),
    });
    if (compact) {
      if (compact.transportAction) await this.executeCompactionTransport(compact.transportAction);
      return false;
    }
    const inspection = await this.submitRuntimeEffect<RuntimeInspection>({
      type: "inspectRuntime",
      runtimeGeneration: owner.generation,
      control: true,
      ...(expectedTurnId ? { expectedTurnId } : {}),
    });
    if (!inspection.interruptible) return false;
    await this.submitRuntimeEffect({
      type: "lifecycle",
      runtimeGeneration: owner.generation,
      fact: { type: "interrupt" },
      source: nullSource,
    });
    await this.submitRuntimeEffect({ type: "cancelInteractions", runtimeGeneration: owner.generation });
    await Promise.all(inspection.taskIds.map(async (taskId) => {
      try {
        await owner.runtime.stopTask(taskId);
      } catch (error) {
        this.runtimeDependencies?.logger.debug("claude.interrupt.stop-task-raced", {
          threadId: this.threadId,
          taskId,
          error: String(error),
        });
      }
    }));
    const cancellation = await owner.runtime.interruptOwned();
    for (const id of [...cancellation.cancelled, ...cancellation.raced]) {
      owner.runtime.releaseMessage(id);
    }
    if (cancellation.raced.length > 0) {
      this.runtimeDependencies?.logger.warn("claude.interrupt.queued-message-race", {
        threadId: this.threadId,
        count: cancellation.raced.length,
      });
    }
    await this.submitRuntimeEffect({
      type: "lifecycle",
      runtimeGeneration: owner.generation,
      fact: { type: "interruptAck" },
      source: nullSource,
    });
    return cancellation.raced.length > 0;
  }

  private async interruptChildRuntimeOwner(
    owner: RuntimeLease,
    childThreadId: string,
    expectedTurnId?: string,
  ): Promise<void> {
    const inspection = await this.submitRuntimeEffect<RuntimeInspection>({
      type: "inspectRuntime",
      runtimeGeneration: owner.generation,
      control: true,
      childThreadId,
      ...(expectedTurnId ? { expectedTurnId } : {}),
    });
    if (!inspection.interruptible) return;
    const taskId = inspection.taskId ?? undefined;
    if (!taskId) {
      throw invalidParams(`Claude subagent thread '${childThreadId}' is not owned by this runtime.`);
    }
    await this.submitRuntimeEffect({
      type: "cancelInteractions",
      runtimeGeneration: owner.generation,
      ownerThreadId: childThreadId,
    });
    await this.applyRuntimeMainStream(
      owner,
      { kind: "taskStop", taskIds: [taskId], reason: "Subagent stopped by user." },
      childThreadId,
    );
    await owner.runtime.stopTask(taskId);
  }

  private async listRuntimeBackgroundTerminals(
    owner: RuntimeLease,
    ownerThreadId: string,
  ): Promise<ThreadBackgroundTerminal[]> {
    return [...((await this.applyRuntimeMainStream(owner, { kind: "inspect" }, ownerThreadId))
      ?.terminals ?? [])];
  }

  private async terminateRuntimeBackgroundTerminal(
    owner: RuntimeLease,
    ownerThreadId: string,
    processId: string,
  ): Promise<boolean> {
    const stopped = await this.applyRuntimeMainStream(owner, {
      kind: "taskStop",
      taskIds: [processId],
      reason: "Background terminal stopped by user.",
    }, ownerThreadId);
    if (!stopped?.handled) return false;
    try {
      await owner.runtime.stopTask(processId);
    } catch (error) {
      this.runtimeDependencies?.logger.debug("claude.background-terminal.stop-raced", {
        threadId: this.threadId,
        ownerThreadId,
        taskId: processId,
        error: String(error),
      });
    }
    return true;
  }

  private applyRuntimeMainStream(
    owner: RuntimeLease,
    fact: MainStreamFact,
    ownerThreadId = this.threadId,
  ): Promise<MainStreamProjection | undefined> {
    return this.submitRuntimeEffect({
      type: "mainStream",
      runtimeGeneration: owner.generation,
      ownerThreadId,
      source: nullSource,
      fact,
    });
  }

  private async injectRuntimeItemsForOwner(
    owner: RuntimeLease,
    items: JsonValue[],
    waitForAcknowledgement: boolean,
    replacement = false,
  ): Promise<void> {
    if (!await this.admitRuntimeOperation(owner, replacement)) {
      throw new Error(`Claude runtime '${this.threadId}' changed before history injection.`);
    }
    const replayable = owner.ephemeral && await this.canRestartEphemeral(owner);
    await this.injectRuntimeItemsIntoOwner(owner, items, waitForAcknowledgement, replayable);
  }

  private async admitRuntimeOperation(
    owner: RuntimeLease,
    replacement = false,
  ): Promise<boolean> {
    const admitted = await this.submitLineage<true | false | Promise<void>>({
      type: "runtimeLineage",
      action: "admitOperation",
      runtimeGeneration: owner.generation,
      ...(replacement ? { replacement: true } : {}),
    });
    if (admitted === true) return true;
    if (admitted) await admitted;
    return false;
  }

  private async completeRuntimeGeneration(
    startup: RuntimeStartup,
    candidate: RuntimeCandidate,
  ): Promise<void> {
    try {
      await candidate.ready;
      if (candidate.runtime.hasExited || this.runtimeDependencies!.isClosing()) {
        throw new Error(`Claude runtime '${this.threadId}' became unavailable during initialization.`);
      }
      const owner = await this.submitLineage<RuntimeGeneration | false | "retiring">({
        type: "runtimeLineage",
        action: "started",
        runtimeGeneration: startup.runtimeGeneration,
        candidate,
      });
      if (owner === "retiring") {
        candidate.activation.resolve({
          ok: false,
          error: new Error(`Claude runtime '${this.threadId}' retired during initialization.`),
        });
        return;
      }
      if (!owner) throw new Error(`Claude runtime '${this.threadId}' became unavailable during initialization.`);
      candidate.activation.resolve({ ok: true });
      await this.submit({
        type: "goal",
        command: { kind: "runtimeReady", runtimeGeneration: startup.runtimeGeneration },
      }).catch(() => undefined);
    } catch (error) {
      candidate.activation.resolve({ ok: false, error });
      const message = error instanceof Error ? error.message : String(error);
      await this.stopProviderRuntime(
        candidate,
        message,
        true,
      ).catch(() => undefined);
      await this.submitLineage({
        type: "runtimeLineage",
        action: "startFailed",
        runtimeGeneration: startup.runtimeGeneration,
        error,
      });
      throw error;
    }
  }

  private runtimeExited(
    generation: number,
    reason: string,
  ): Promise<"starting" | undefined> {
    return this.submitLineage({
      type: "runtimeLineage",
      action: "exited",
      runtimeGeneration: generation,
      reason,
      codexErrorInfo: classifyClaudeRuntimeError(reason),
    });
  }

  private submitProviderProjection<Result>(
    runtimeGeneration: number,
    command: ClaudeSessionCommand,
  ): Promise<Result> {
    return this.submitLineage<Result>({
      type: "runtimeLineage",
      action: "providerCommand",
      runtimeGeneration,
      command,
    });
  }

  private async handleProviderFact(
    projection: ProviderProjectionState,
    fact: ClaudeProviderFact,
  ): Promise<void> {
    const runtime = projection.runtime;
    if (!runtime) return;
    if (fact.kind === "inputPending") {
      await this.submitProviderProjection(fact.runtimeGeneration, {
        type: "runtimeInputQueueChanged",
        runtimeGeneration: fact.runtimeGeneration,
        pendingInputs: fact.pendingInputs,
      });
      return;
    }
    if (fact.kind === "exit") {
      const reason = fact.error === undefined
        ? "Claude runtime exited before the turn completed."
        : fact.error instanceof Error ? fact.error.message : String(fact.error);
      try {
        await this.cancelProviderInjections(
          runtime,
          fact.runtimeGeneration,
          reason,
        );
        if (await this.runtimeExited(fact.runtimeGeneration, reason) === "starting") return;
        await this.submitProviderProjection<CompactionProjection | undefined>(
          fact.runtimeGeneration,
          {
            type: "compactRuntimeExited",
            runtimeGeneration: fact.runtimeGeneration,
            message: reason,
          },
        );
        await this.submitProviderProjection(fact.runtimeGeneration, {
          type: "runtimeExited",
          runtimeGeneration: fact.runtimeGeneration,
          message: reason,
          codexErrorInfo: classifyClaudeRuntimeError(reason),
        });
      } finally {
        await this.submitProviderProjection(fact.runtimeGeneration, {
          type: "runtimeDetached",
          runtimeGeneration: fact.runtimeGeneration,
        });
      }
      return;
    }

    const source = {
      providerEventId: fact.providerEventId,
      providerEventType: fact.providerEventType,
    };
    await projection.context.run(
      { ...source, activeTurnId: null, readOnly: false },
      async () => {
        const admission = await this.submitProviderProjection<ProviderEventAdmission>(
          fact.runtimeGeneration,
          {
            type: "providerEventStarted",
            runtimeGeneration: fact.runtimeGeneration,
            processEpoch: projection.processEpoch,
            providerSequence: ++projection.providerSequence,
            providerEventType: fact.providerEventType,
            providerEventId: fact.providerEventId,
            payload: fact.message,
          },
        );
        if (!admission?.finish) return;
        let disposition: Exclude<ProviderEventDisposition, "pending" | "failed"> = "retainedOnly";
        let failure: string | undefined;
        try {
          if (admission.project) {
            disposition = await projection.context.run({
              ...admission.source,
              activeTurnId: admission.activeTurnId,
              readOnly: admission.readOnly,
            }, () => this.projectProviderMessage(
              projection,
              runtime,
              fact.runtimeGeneration,
              fact.message,
            ));
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        } finally {
          await this.submitProviderProjection(fact.runtimeGeneration, {
            type: "providerEventFinished",
            runtimeGeneration: fact.runtimeGeneration,
            sequence: admission.sequence,
            source: admission.source,
            disposition: failure ? "failed" : disposition,
            ...(failure ? { error: failure } : {}),
          });
        }
        if (failure) {
          await this.submitProviderProjection(fact.runtimeGeneration, {
            type: "runtimeExited",
            runtimeGeneration: fact.runtimeGeneration,
            message: `Claude provider projection failed: ${failure}`,
            codexErrorInfo: null,
          });
          runtime.beginClose();
        }
      },
    );
  }

  private async projectProviderMessage(
    projection: ProviderProjectionState,
    runtime: ProviderRuntime,
    runtimeGeneration: number,
    message: SDKMessage,
  ): Promise<Exclude<ProviderEventDisposition, "pending" | "failed">> {
    const activeTurnId = projection.context.getStore()?.activeTurnId ?? null;
    const source = this.providerFactSource(projection);
    if ((message as unknown as { type: string }).type === "command_lifecycle") {
      const lifecycle = message as unknown as { state?: string; command_uuid?: string };
      const state = lifecycle.state;
      if (state === "queued" || state === "started" || state === "completed"
        || state === "cancelled" || state === "discarded") {
        await this.providerSubmitLifecycle(
          projection,
          runtimeGeneration,
          { type: "command", state, id: lifecycle.command_uuid ?? null },
        );
      }
      return "stateOnly";
    }
    if (message.type === "system" && message.subtype === "hook_started") {
      const handled = await this.submitProviderProjection<boolean>(runtimeGeneration, {
        type: "hook",
        runtimeGeneration,
        source,
        fact: {
          kind: "started",
          hookId: message.hook_id,
          hookName: message.hook_name,
          hookEvent: message.hook_event,
        },
      });
      return handled ? "projected" : "retainedOnly";
    }
    if (message.type === "system" && message.subtype === "hook_progress") {
      const handled = await this.submitProviderProjection<boolean>(runtimeGeneration, {
        type: "hook",
        runtimeGeneration,
        source,
        fact: {
          kind: "progress",
          hookId: message.hook_id,
          output: message.output,
          stdout: message.stdout,
          stderr: message.stderr,
        },
      });
      return handled ? "stateOnly" : "retainedOnly";
    }
    if (message.type === "system" && message.subtype === "hook_response") {
      const handled = await this.submitProviderProjection<boolean>(runtimeGeneration, {
        type: "hook",
        runtimeGeneration,
        source,
        fact: {
          kind: "response",
          hookId: message.hook_id,
          output: message.output,
          stdout: message.stdout,
          stderr: message.stderr,
          outcome: message.outcome,
          ...(message.exit_code === undefined ? {} : { exitCode: message.exit_code }),
        },
      });
      return handled ? "projected" : "retainedOnly";
    }
    if (message.type === "system" && message.subtype === "task_started") {
      if (message.skip_transcript) return "stateOnly";
      const owner = await this.providerInteractionOwner(
        runtimeGeneration,
        message.tool_use_id,
        undefined,
      );
      await this.applyProviderMainStream(projection, runtimeGeneration, {
        kind: "taskStart",
        taskId: message.task_id,
        ...(message.tool_use_id ? { providerId: message.tool_use_id } : {}),
        description: message.description,
        ...(message.prompt ? { prompt: message.prompt } : {}),
        ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
        ...(message.task_type ? { taskType: message.task_type } : {}),
        confirmed: true,
      }, owner);
      return "projected";
    }
    if (message.type === "system" && message.subtype === "task_progress") {
      await this.applyProviderMainStream(projection, runtimeGeneration, {
        kind: "taskProgress",
        taskId: message.task_id,
        description: message.summary ?? message.description,
      });
      return "projected";
    }
    if (message.type === "system" && message.subtype === "task_updated") {
      await this.applyProviderMainStream(projection, runtimeGeneration, {
        kind: "taskProgress",
        taskId: message.task_id,
        description: message.patch.description ?? "",
      });
      return "projected";
    }
    if (message.type === "system" && message.subtype === "task_notification") {
      const owner = await this.providerInteractionOwner(
        runtimeGeneration,
        message.tool_use_id ?? message.task_id,
        undefined,
      );
      await this.applyProviderMainStream(projection, runtimeGeneration, {
        kind: "taskStart",
        taskId: message.task_id,
        ...(message.tool_use_id ? { providerId: message.tool_use_id } : {}),
        description: message.summary,
        outputFile: message.output_file,
      }, owner);
      if (owner === this.threadId) {
        await this.providerSubmitLifecycle(
          projection,
          runtimeGeneration,
          { type: "taskNotification" },
        );
      }
      await this.applyProviderMainStream(projection, runtimeGeneration, {
        kind: "taskComplete",
        taskId: message.task_id,
        ...(message.tool_use_id ? { providerId: message.tool_use_id } : {}),
        status: message.status,
        summary: message.summary,
        outputFile: message.output_file,
        ...(message.usage?.duration_ms === undefined
          ? {}
          : { durationMs: message.usage.duration_ms }),
      }, owner);
      return "projected";
    }
    if (message.type === "system" && message.subtype === "background_tasks_changed") {
      await this.applyProviderMainStream(projection, runtimeGeneration, {
        kind: "taskMembership",
        taskIds: message.tasks.map((task) => task.task_id),
      });
      return "stateOnly";
    }
    if (message.type === "system"
      && message.subtype === "status"
      && message.compact_result === "failed") {
      const result = await this.providerSubmitCompactionFailure(
        projection,
        runtimeGeneration,
        message.compact_error ?? "Claude compaction failed.",
      );
      if (result) return result.terminal ? "projected" : "stateOnly";
    }
    if (message.type === "system" && message.subtype === "status") {
      const status = (message as SDKMessage & { status?: string | null }).status;
      if (status === "requesting") {
        await this.providerSubmitLifecycle(
          projection,
          runtimeGeneration,
          { type: "request", messageStarted: false },
        );
      }
      return "stateOnly";
    }
    if (message.type === "system" && message.subtype === "session_state_changed") {
      await this.providerSubmitLifecycle(
        projection,
        runtimeGeneration,
        { type: "session", state: message.state },
      );
      return "stateOnly";
    }
    if (message.type === "system" && message.subtype === "compact_boundary") {
      return this.providerCompactionBoundary(
        projection,
        runtimeGeneration,
        runtime,
        message,
      );
    }
    if (message.type === "system" && message.subtype === "init") {
      const initialized = await this.submitProviderProjection(runtimeGeneration, {
        type: "runtimeInitialized",
        runtimeGeneration,
        providerSessionId: message.session_id,
        model: message.model,
        cliVersion: message.claude_code_version,
      });
      if (!initialized) return "stateOnly";
      runtime.setCapabilities(message.capabilities ?? []);
      return "stateOnly";
    }
    if (message.type === "stream_event") {
      const child = await this.providerChildThreadFor(
        runtimeGeneration,
        message.parent_tool_use_id,
      );
      if (child?.active) {
        await this.providerChildStreamEvent(
          projection,
          runtimeGeneration,
          child.threadId,
          message,
        );
      } else if (child) {
        return "retainedOnly";
      } else {
        await this.providerMainStreamEvent(projection, runtimeGeneration, message);
      }
      return "projected";
    }
    if (message.type === "assistant") {
      const usage = (message.message as unknown as { usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number | null;
      } }).usage;
      if (activeTurnId && usage) {
        await this.submitProviderProjection(runtimeGeneration, {
          type: "goalAssistantUsage",
          runtimeGeneration,
          turnId: activeTurnId,
          eventId: `assistant:${message.uuid}`,
          tokens: usage.input_tokens
            + (usage.cache_creation_input_tokens ?? 0)
            + usage.output_tokens,
        });
      }
      if (message.supersedes?.length) {
        await this.providerEvictMessages(projection, runtimeGeneration, message.supersedes);
      }
      const child = await this.providerChildThreadFor(
        runtimeGeneration,
        message.parent_tool_use_id,
      );
      if (child?.active) {
        const itemIds = await this.providerProjectAssistant(
          projection,
          runtimeGeneration,
          message,
          child.threadId,
        );
        await this.providerLinkItems(runtimeGeneration, message.uuid, child.threadId, itemIds);
        return "projected";
      }
      if (child) return "retainedOnly";
      if (activeTurnId) {
        if (message.error) {
          await this.submitProviderProjection(runtimeGeneration, {
            type: "providerAssistantError",
            runtimeGeneration,
            error: message.error,
          });
          if (message.error === "authentication_failed"
            || message.error === "oauth_org_not_allowed"
            || message.error === "model_not_found") {
            void this.submitLineage({
              type: "runtimeLineage",
              action: "catalogInvalidated",
              runtimeGeneration,
            });
          }
        }
        await this.submitProviderProjection(runtimeGeneration, {
          type: "providerBoundary",
          runtimeGeneration,
          providerMessageId: message.uuid,
        });
      }
      const itemIds = activeTurnId
        ? await this.providerProjectAssistant(
            projection,
            runtimeGeneration,
            message,
            this.threadId,
          )
        : [];
      if (activeTurnId) {
        await this.providerLinkItems(runtimeGeneration, message.uuid, this.threadId, itemIds);
      }
      return "projected";
    }
    if (message.type === "user") {
      if ("uuid" in message && typeof message.uuid === "string") {
        runtime.releaseMessage(message.uuid);
      }
      const child = await this.providerChildThreadFor(
        runtimeGeneration,
        message.parent_tool_use_id,
      );
      if (child?.active) {
        const itemIds = await this.providerProjectToolResults(
          projection,
          runtimeGeneration,
          message,
          child.threadId,
        );
        if ("uuid" in message && typeof message.uuid === "string") {
          await this.providerLinkItems(
            runtimeGeneration,
            message.uuid,
            child.threadId,
            itemIds,
          );
        }
        return "projected";
      }
      if (child) return "retainedOnly";
      if (activeTurnId && "uuid" in message && typeof message.uuid === "string") {
        await this.submitProviderProjection(runtimeGeneration, {
          type: "providerBoundary",
          runtimeGeneration,
          providerMessageId: message.uuid,
        });
      }
      const itemIds = await this.providerProjectToolResults(
        projection,
        runtimeGeneration,
        message,
        this.threadId,
      );
      if (activeTurnId && "uuid" in message && typeof message.uuid === "string") {
        await this.providerLinkItems(
          runtimeGeneration,
          message.uuid,
          this.threadId,
          itemIds,
        );
      }
      return "projected";
    }
    if (message.type === "result") {
      if (isNoQueryAcknowledgement(message)) {
        const messageUuids = await this.submitProviderProjection<string[]>(
          runtimeGeneration,
          {
            type: "acknowledgeInjection",
            runtimeGeneration,
            source,
          },
        );
        for (const messageUuid of messageUuids) runtime.releaseMessage(messageUuid);
        return "stateOnly";
      }
      if (message.subtype !== "success") {
        const compactFailure = await this.providerSubmitCompactionFailure(
          projection,
          runtimeGeneration,
          message.errors[0] ?? "Claude compaction failed.",
        );
        if (compactFailure) return compactFailure.terminal ? "projected" : "stateOnly";
      }
      const result = await this.submitProviderProjection<ClaudeResultClassification>(
        runtimeGeneration,
        { type: "classifyProviderResult", runtimeGeneration, result: message },
      );
      const originKind = (message as SDKMessage & { origin?: { kind?: string } }).origin?.kind;
      await this.accountProviderGoalUsage(projection, runtimeGeneration, message);
      if (result.codexErrorInfo === "unauthorized" || result.codexErrorInfo === "badRequest") {
        void this.submitLineage({
          type: "runtimeLineage",
          action: "catalogInvalidated",
          runtimeGeneration,
        });
      }
      if (result.status === "completed" && message.subtype === "success") {
        if (message.structured_output !== undefined) {
          await this.applyProviderMainStream(projection, runtimeGeneration, {
            kind: "instantAgent",
            text: JSON.stringify(message.structured_output, null, 2),
          });
        }
        await this.accountProviderUsage(projection, runtimeGeneration, runtime, message);
      } else {
        await this.submitProviderProjection(runtimeGeneration, {
          type: "accountCost",
          runtimeGeneration,
          costUsd: message.total_cost_usd,
        });
      }
      await this.providerSubmitLifecycle(projection, runtimeGeneration, {
        type: "result",
        status: result.status === "completed" && message.subtype !== "success"
          ? "failed"
          : result.status,
        ...(result.error ? { errorMessage: result.error } : {}),
        codexErrorInfo: result.codexErrorInfo ?? null,
        origin: originKind ?? null,
      });
      return "projected";
    }
    if (message.type === "tool_progress") {
      await this.providerToolProgress(projection, runtimeGeneration, message);
      return "projected";
    }
    if (message.type === "tool_use_summary") {
      const owner = message.preceding_tool_use_ids.length > 0
        ? await this.providerInteractionOwner(
            runtimeGeneration,
            message.preceding_tool_use_ids[0],
            undefined,
          )
        : this.threadId;
      if (owner === this.threadId) {
        await this.providerSystemMessage(projection, runtimeGeneration, message.summary);
      } else {
        await this.applyProviderMainStream(
          projection,
          runtimeGeneration,
          { kind: "instantAgent", text: systemNoticeText(message.summary, "info") },
          owner,
        );
      }
      return "projected";
    }
    if (message.type === "auth_status") {
      if (message.error) {
        void this.submitLineage({
          type: "runtimeLineage",
          action: "authFailure",
          runtimeGeneration,
          reason: message.error,
        });
        await this.providerSystemMessage(
          projection,
          runtimeGeneration,
          `Claude authentication failed: ${message.error}`,
          "error",
        );
      } else if (message.output.length > 0) {
        await this.providerSystemMessage(
          projection,
          runtimeGeneration,
          message.output.join("\n"),
        );
      }
      return message.error || message.output.length > 0 ? "projected" : "stateOnly";
    }
    if (message.type === "rate_limit_event") {
      void this.submitLineage({
        type: "runtimeLineage",
        action: "rateLimit",
        runtimeGeneration,
        info: message.rate_limit_info,
      });
      if (message.rate_limit_info.status !== "allowed") {
        const reset = message.rate_limit_info.resetsAt
          ? ` Resets at ${new Date(message.rate_limit_info.resetsAt).toISOString()}.`
          : "";
        await this.providerSystemMessage(
          projection,
          runtimeGeneration,
          `Claude rate limit: ${message.rate_limit_info.status}.${reset}`,
          message.rate_limit_info.status === "rejected" ? "error" : "info",
        );
        return "projected";
      }
      return "stateOnly";
    }
    if (message.type === "conversation_reset") {
      await this.submitProviderProjection(runtimeGeneration, {
        type: "conversationReset",
        runtimeGeneration,
        providerSessionId: message.new_conversation_id,
        source,
      });
      return "projected";
    }
    if (message.type === "system" && message.subtype === "model_refusal_fallback") {
      if (message.retracted_message_uuids?.length) {
        await this.providerEvictMessages(
          projection,
          runtimeGeneration,
          message.retracted_message_uuids,
        );
      }
      await this.submitProviderProjection(runtimeGeneration, {
        type: "modelFallback",
        runtimeGeneration,
        model: message.fallback_model,
        fromModel: message.original_model,
        source,
      });
      await this.providerSystemMessage(
        projection,
        runtimeGeneration,
        message.content
          || `Claude switched from ${message.original_model} to ${message.fallback_model} after a refusal.`,
      );
      return "projected";
    }
    if (message.type === "system" && message.subtype === "permission_denied") {
      const owner = await this.providerInteractionOwner(
        runtimeGeneration,
        message.tool_use_id,
        message.agent_id,
      );
      await this.applyProviderMainStream(projection, runtimeGeneration, {
        kind: "toolComplete",
        providerId: message.tool_use_id,
        output: message.message,
        isError: true,
      }, owner);
      const text = `${message.tool_name} was denied: ${message.message}`;
      if (owner === this.threadId) {
        await this.providerSystemMessage(projection, runtimeGeneration, text, "error");
      } else {
        await this.applyProviderMainStream(
          projection,
          runtimeGeneration,
          { kind: "instantAgent", text: systemNoticeText(text, "error") },
          owner,
        );
      }
      return "projected";
    }
    if (message.type === "system" && message.subtype === "informational") {
      const owner = await this.providerInteractionOwner(
        runtimeGeneration,
        message.tool_use_id,
        undefined,
      );
      const kind = message.level === "warning" ? "error" : "info";
      if (owner === this.threadId) {
        await this.providerSystemMessage(
          projection,
          runtimeGeneration,
          message.content,
          kind,
        );
      } else {
        await this.applyProviderMainStream(
          projection,
          runtimeGeneration,
          { kind: "instantAgent", text: systemNoticeText(message.content, kind) },
          owner,
        );
      }
      return "projected";
    }

    const visibleSystemMessage = message.type === "system"
      ? message.subtype === "api_retry"
        ? `Claude API retry ${message.attempt}/${message.max_retries} after ${message.error}; waiting ${message.retry_delay_ms}ms.`
        : message.subtype === "control_request_progress" && message.status === "api_retry"
          ? `Claude control request retry ${message.attempt ?? "?"}/${message.max_retries ?? "?"}.`
          : message.subtype === "local_command_output"
            ? message.content
            : message.subtype === "model_refusal_no_fallback"
              ? message.content || `Claude model ${message.original_model} refused and no fallback is available.`
              : message.subtype === "notification"
                ? message.text
                : message.subtype === "mirror_error"
                  ? `Claude transcript mirror failed: ${message.error}`
                  : message.subtype === "worker_shutting_down"
                    ? `Claude worker is shutting down (${message.reason}).`
                    : message.subtype === "plugin_install" && message.status === "failed"
                      ? `Claude plugin ${message.name ?? "install"} failed: ${message.error ?? "unknown error"}.`
                      : message.subtype === "files_persisted" && message.failed.length > 0
                        ? `Claude failed to persist files: ${message.failed.map((file) =>
                            `${file.filename}: ${file.error}`).join("; ")}`
                        : message.subtype === "memory_recall"
                          ? `Claude recalled ${message.memories.length} ${message.memories.length === 1 ? "memory" : "memories"}.`
                          : message.subtype === "elicitation_complete"
                            ? `MCP elicitation completed for ${message.mcp_server_name}.`
                            : undefined
      : undefined;
    if (visibleSystemMessage !== undefined) {
      const error = message.type === "system"
        && (message.subtype === "model_refusal_no_fallback"
          || message.subtype === "mirror_error"
          || message.subtype === "worker_shutting_down"
          || message.subtype === "plugin_install"
          || message.subtype === "files_persisted"
          || message.subtype === "notification" && message.priority === "immediate");
      await this.providerSystemMessage(
        projection,
        runtimeGeneration,
        visibleSystemMessage,
        error ? "error" : "info",
      );
      return "projected";
    }
    if (message.type === "system"
      && message.subtype === "control_request_progress"
      && message.status !== "api_retry") {
      return "stateOnly";
    }
    if (message.type === "system" && message.subtype === "plugin_install") {
      return "stateOnly";
    }
    if (message.type === "system" && message.subtype === "files_persisted") {
      return "stateOnly";
    }
    switch (message.type) {
      case "prompt_suggestion":
        return "retainedOnly";
      case "system":
        switch (message.subtype) {
          case "thinking_tokens":
          case "commands_changed":
            return "retainedOnly";
          case "control_request_progress":
            return "stateOnly";
          case "api_retry":
          case "local_command_output":
          case "model_refusal_no_fallback":
          case "notification":
          case "mirror_error":
          case "worker_shutting_down":
          case "memory_recall":
          case "elicitation_complete":
            return "projected";
          default: {
            const exhaustive: never = message;
            const subtype = String(
              (exhaustive as { subtype?: unknown }).subtype ?? "unknown",
            );
            await this.providerSystemMessage(
              projection,
              runtimeGeneration,
              `Unsupported Claude provider event 'system/${subtype}' was retained for audit.`,
              "error",
            );
            this.runtimeDependencies?.logger.warn("claude.provider-event.unrecognized", {
              threadId: this.threadId,
              type: "system",
              subtype,
            });
            return "unsupportedVisible";
          }
        }
      default: {
        const exhaustive: never = message;
        const type = String((exhaustive as { type?: unknown }).type ?? "unknown");
        await this.providerSystemMessage(
          projection,
          runtimeGeneration,
          `Unsupported Claude provider event '${type}' was retained for audit.`,
          "error",
        );
        this.runtimeDependencies?.logger.warn("claude.provider-event.unrecognized", {
          threadId: this.threadId,
          type,
        });
        return "unsupportedVisible";
      }
    }
  }

  private async cancelProviderInjections(
    runtime: ProviderRuntime,
    runtimeGeneration: number,
    reason: string,
  ): Promise<void> {
    const messageUuids = await this.submitProviderProjection<string[]>(runtimeGeneration, {
      type: "cancelRuntimeInjections",
      runtimeGeneration,
      reason,
    });
    for (const messageUuid of messageUuids ?? []) {
      runtime.releaseMessage(messageUuid);
    }
  }

  private async openProviderInteraction(
    runtimeGeneration: number,
    request: SessionInteractionRequest,
    signal?: AbortSignal,
    afterOpen?: () => void,
  ): Promise<unknown> {
    const opened = await this.submitProviderProjection<OpenedSessionInteraction>(
      runtimeGeneration,
      { type: "openInteraction", runtimeGeneration, request },
    );
    if (!opened) return { cancelled: true };
    if (!opened.pending) return opened.response;
    afterOpen?.();
    await this.submitProviderProjection(runtimeGeneration, {
      type: "announceInteraction",
      runtimeGeneration,
      requestId: opened.requestId,
    });
    return this.submitProviderProjection(runtimeGeneration, {
      type: "waitInteraction",
      runtimeGeneration,
      requestId: opened.requestId,
      ...(signal ? { signal } : {}),
    });
  }

  private providerCallbackContext(
    runtimeGeneration: number,
    target: { readonly providerId?: string; readonly ownerThreadId?: string } = {},
  ): Promise<ProviderCallbackContext | undefined> {
    return this.submitLineage({
      type: "runtimeLineage",
      action: "inspectCallback",
      runtimeGeneration,
      ...target,
    });
  }

  private async providerInteractionOwner(
    runtimeGeneration: number,
    toolUseId: string | undefined,
    agentId: string | undefined,
  ): Promise<string> {
    const providerId = toolUseId ?? agentId;
    if (!providerId) return this.threadId;
    return (await this.providerCallbackContext(runtimeGeneration, { providerId }))
      ?.inspection.ownerThreadId ?? this.threadId;
  }

  private applyProviderMainStream(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    fact: MainStreamFact,
    ownerThreadId = this.threadId,
  ): Promise<MainStreamProjection | undefined> {
    return this.submitProviderProjection(runtimeGeneration, {
      type: "mainStream",
      runtimeGeneration,
      ownerThreadId,
      source: projection.context.getStore() ?? nullSource,
      fact,
    });
  }

  private async canUseProviderTool(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    name: Parameters<CanUseTool>[0],
    input: Parameters<CanUseTool>[1],
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult | null> {
    const context = await this.providerCallbackContext(runtimeGeneration);
    if (!context) return { behavior: "deny", message: "Claude runtime is no longer active." };
    const root = context.inspection;
    if (!root.activeTurnId) return { behavior: "deny", message: "No active Claude turn." };
    const settings = context.settings;
    if (name.startsWith("mcp__ccodex_goal__")) {
      return { behavior: "allow", updatedInput: input };
    }
    if (name === "AskUserQuestion") {
      return this.askProviderUser(projection, runtimeGeneration, input, options);
    }
    if (providerPermissionMode(settings) === "auto") {
      return {
        behavior: "deny",
        message: options.decisionReason ?? options.description ?? `Claude Auto did not allow tool '${name}'.`,
      };
    }
    if (name === "ExitPlanMode") {
      return {
        behavior: "deny",
        message: "The plan is visible in the client. Wait for the user's next instruction before executing it.",
      };
    }
    if (!root.readOnly && providerPermissionMode(settings) === "bypassPermissions") {
      return { behavior: "allow", updatedInput: input };
    }
    const sandbox = root.readOnly
      ? { type: "readOnly" as const, networkAccess: false }
      : settings.sandboxPolicy;
    const policy = toolPolicy(
      name,
      input,
      settings.cwd,
      settings.approvalPolicy,
      sandbox,
    );
    if (policy.decision === "deny") {
      return {
        behavior: "deny",
        message: policy.reason ?? `Tool '${name}' is denied by the Codex thread policy.`,
      };
    }
    if (policy.decision === "defer" && isFileMutationTool(name)) {
      return { behavior: "allow", updatedInput: input };
    }
    if (settings.approvalPolicy === "never") {
      return {
        behavior: "deny",
        message: `Tool '${name}' requires permission, but approvalPolicy is never.`,
      };
    }

    const itemId = options.toolUseID;
    const inspection = await this.submitProviderProjection<RuntimeInspection>(runtimeGeneration, {
      type: "inspectRuntime",
      runtimeGeneration,
      providerId: itemId,
    });
    const ownerThreadId = inspection.ownerThreadId;
    const ownerTurnId = inspection.ownerTurnId ?? root.activeTurnId;
    await this.applyProviderMainStream(
      projection,
      runtimeGeneration,
      { kind: "toolPrepare", providerId: itemId, name, input },
      ownerThreadId,
    );
    const common = {
      threadId: ownerThreadId,
      turnId: ownerTurnId,
      itemId,
      startedAtMs: Date.now(),
    };
    const sessionUpdates = safeSessionPermissionUpdates(options);
    let method: string;
    let params: unknown;
    if (name === "Bash") {
      method = "item/commandExecution/requestApproval";
      params = {
        ...common,
        environmentId: null,
        reason: options.decisionReason ?? options.description ?? null,
        command: typeof input.command === "string" ? input.command : null,
        cwd: settings.cwd,
        commandActions: typeof input.command === "string"
          ? bashCommandActions(input.command, settings.cwd)
          : null,
        additionalPermissions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        availableDecisions: sessionUpdates
          ? ["accept", "acceptForSession", "decline", "cancel"]
          : ["accept", "decline", "cancel"],
      };
    } else if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
      method = "item/fileChange/requestApproval";
      params = {
        ...common,
        reason: options.decisionReason ?? options.description ?? null,
        grantRoot: options.blockedPath ?? null,
      };
    } else {
      method = "item/permissions/requestApproval";
      const path = options.blockedPath ? [options.blockedPath] : null;
      params = {
        ...common,
        environmentId: null,
        cwd: settings.cwd,
        reason: options.title ?? options.decisionReason ?? `Claude requests permission for ${name}.`,
        permissions: { network: null, fileSystem: path ? { read: path, write: path } : null },
      };
    }
    const response = await this.openProviderInteraction(
      runtimeGeneration,
      {
        threadId: ownerThreadId,
        turnId: ownerTurnId,
        claudeRequestId: options.requestId,
        method,
        params,
      },
      options.signal,
      () => {
        void this.applyProviderMainStream(
          projection,
          runtimeGeneration,
          { kind: "toolBegin", providerId: itemId },
          ownerThreadId,
        );
      },
    );
    if (response && typeof response === "object" && "cancelled" in response) {
      return {
        behavior: "deny",
        message: "User cancelled tool execution.",
        decisionClassification: "user_reject",
      };
    }
    const decision = response && typeof response === "object" && "decision" in response
      ? (response as { decision?: unknown }).decision
      : response && typeof response === "object" && "scope" in response
        ? (response as { scope?: unknown }).scope === "session" ? "acceptForSession" : "accept"
        : "decline";
    if (decision === "accept" || decision === "acceptForSession") {
      const permanent = decision === "acceptForSession" && sessionUpdates !== undefined;
      return {
        behavior: "allow",
        updatedInput: input,
        decisionClassification: permanent ? "user_permanent" : "user_temporary",
        ...(permanent ? { updatedPermissions: sessionUpdates } : {}),
      };
    }
    return {
      behavior: "deny",
      message: decision === "cancel"
        ? "User cancelled tool execution."
        : "User declined tool execution.",
      decisionClassification: "user_reject",
    };
  }

  private async askProviderUser(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const context = await this.providerCallbackContext(runtimeGeneration);
    if (!context) return { behavior: "deny", message: "Claude runtime is no longer active." };
    const root = context.inspection;
    if (!root.activeTurnId) return { behavior: "deny", message: "No active Claude turn." };
    const threadId = await this.providerInteractionOwner(
      runtimeGeneration,
      options.toolUseID,
      options.agentID,
    );
    const owner = await this.providerCallbackContext(runtimeGeneration, { ownerThreadId: threadId });
    if (!owner) return { behavior: "deny", message: "Claude runtime is no longer active." };
    const inspection = owner.inspection;
    const turnId = inspection.ownerTurnId ?? root.activeTurnId;
    const questions = (Array.isArray(input.questions) ? input.questions : []).map((value, index) => {
      const question = value && typeof value === "object"
        ? value as Record<string, unknown>
        : {};
      const prompt = typeof question.question === "string"
        ? question.question
        : `Question ${index + 1}`;
      return {
        id: prompt,
        header: typeof question.header === "string" ? question.header : `Question ${index + 1}`,
        question: prompt,
        isOther: true,
        isSecret: false,
        options: (Array.isArray(question.options) ? question.options : []).map((choice) => {
          const option = choice && typeof choice === "object"
            ? choice as Record<string, unknown>
            : {};
          return {
            label: String(option.label ?? ""),
            description: String(option.description ?? ""),
          };
        }),
      };
    });
    const response = await this.openProviderInteraction(runtimeGeneration, {
      threadId,
      turnId,
      claudeRequestId: options.requestId,
      method: "item/tool/requestUserInput",
      params: {
        threadId,
        turnId,
        itemId: options.toolUseID,
        questions,
        autoResolutionMs: null,
      },
    }, options.signal);
    if (!response || typeof response !== "object" || "cancelled" in response) {
      return { behavior: "deny", message: "User cancelled the question." };
    }
    const rawAnswers = "answers" in response
      ? (response as { answers?: unknown }).answers
      : undefined;
    const answers: Record<string, string> = {};
    if (rawAnswers && typeof rawAnswers === "object") {
      for (const [id, value] of Object.entries(rawAnswers)) {
        const values = value && typeof value === "object" && "answers" in value
          ? (value as { answers?: unknown }).answers
          : undefined;
        if (Array.isArray(values)) answers[id] = values.map(String).join(", ");
      }
    }
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  private async handleProviderElicitation(
    runtimeGeneration: number,
    request: ElicitationRequest,
    signal: AbortSignal,
  ): Promise<ElicitationResult> {
    const context = await this.providerCallbackContext(runtimeGeneration);
    if (!context) return { action: "cancel" };
    const turnId = context.inspection.activeTurnId;
    const response = await this.openProviderInteraction(runtimeGeneration, {
      threadId: this.threadId,
      turnId,
      claudeRequestId: request.elicitationId ?? null,
      method: "mcpServer/elicitation/request",
      params: request.mode === "url"
        ? {
            threadId: this.threadId,
            turnId,
            serverName: request.serverName,
            mode: "url",
            _meta: null,
            message: request.message,
            url: request.url ?? "",
            elicitationId: request.elicitationId ?? "",
          }
        : {
            threadId: this.threadId,
            turnId,
            serverName: request.serverName,
            mode: "form",
            _meta: null,
            message: request.message,
            requestedSchema: request.requestedSchema ?? {},
          },
    }, signal);
    if (!response || typeof response !== "object" || "cancelled" in response) {
      return { action: "cancel" };
    }
    const result = response as {
      action?: "accept" | "decline" | "cancel";
      content?: Record<string, unknown> | null;
    };
    return {
      action: result.action ?? "cancel",
      ...(result.content
        ? {
            content: result.content as Record<
              string,
              string | number | boolean | string[]
            >,
          }
        : {}),
    };
  }

  private async beforeProviderToolUse(
    runtimeGeneration: number,
    input: HookInput,
    toolUseId: string | undefined,
  ): Promise<HookJSONOutput> {
    if (input.hook_event_name !== "PreToolUse" || !toolUseId) return { continue: true };
    const context = await this.providerCallbackContext(runtimeGeneration);
    if (!context) return { continue: false, stopReason: "Claude runtime is no longer active." };
    const inspection = context.inspection;
    if (!inspection.activeTurnId) {
      return { continue: true };
    }
    if (input.tool_name.startsWith("mcp__ccodex_goal__")) return allowProviderTool();
    const toolInput = input.tool_input && typeof input.tool_input === "object"
      ? input.tool_input as Record<string, unknown>
      : {};
    const settings = context.settings;
    const sandbox = inspection.readOnly
      ? { type: "readOnly" as const, networkAccess: false }
      : settings.sandboxPolicy;
    const selected = toolPolicy(
      input.tool_name,
      toolInput,
      settings.cwd,
      settings.approvalPolicy,
      sandbox,
    );
    const policy = providerPermissionMode(settings) === "auto" && selected.decision === "ask"
      ? { decision: "defer" as const }
      : selected;
    if (policy.decision !== "deny") {
      await this.submitProviderProjection(runtimeGeneration, {
        type: "captureToolFileBefore",
        runtimeGeneration,
        providerId: toolUseId,
        ...(input.agent_id ? { ownerProviderId: input.agent_id } : {}),
        toolName: input.tool_name,
        input: toolInput,
      });
    }
    if (policy.decision === "defer" || policy.decision === "ask") return { continue: true };
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: policy.decision,
        ...(policy.reason ? { permissionDecisionReason: policy.reason } : {}),
      },
    };
  }

  private async captureProviderFileAfter(
    runtimeGeneration: number,
    input: HookInput,
    toolUseId: string | undefined,
  ): Promise<HookJSONOutput> {
    if ((input.hook_event_name !== "PostToolUse"
      && input.hook_event_name !== "PostToolUseFailure") || !toolUseId) {
      return { continue: true };
    }
    await this.submitProviderProjection(runtimeGeneration, {
      type: "captureToolFileAfter",
      runtimeGeneration,
      providerId: toolUseId,
    });
    return { continue: true };
  }

  private async afterProviderCompact(
    runtimeGeneration: number,
    input: HookInput,
  ): Promise<HookJSONOutput> {
    if (input.hook_event_name !== "PostCompact") return { continue: true };
    await this.submitProviderProjection(runtimeGeneration, {
      type: "postCompact",
      runtimeGeneration,
      trigger: input.trigger,
      summary: input.compact_summary,
    });
    return { continue: true };
  }

  private providerFactSource(projection: ProviderProjectionState): RuntimeFactSource {
    return projection.context.getStore() ?? nullSource;
  }

  private async providerChildThreadFor(
    runtimeGeneration: number,
    providerId: string | null | undefined,
  ): Promise<{ readonly threadId: string; readonly active: boolean } | undefined> {
    if (!providerId) return undefined;
    const inspection = await this.submitProviderProjection<RuntimeInspection>(runtimeGeneration, {
      type: "inspectRuntime",
      runtimeGeneration,
      providerId,
    });
    return inspection.childThreadId
      ? { threadId: inspection.childThreadId, active: inspection.interruptible }
      : undefined;
  }

  private async providerLinkItems(
    runtimeGeneration: number,
    providerMessageId: string,
    ownerThreadId: string,
    itemIds: readonly string[],
  ): Promise<void> {
    await this.submitProviderProjection(runtimeGeneration, {
      type: "providerBoundary",
      runtimeGeneration,
      providerMessageId,
      ownerThreadId,
      itemIds,
    });
  }

  private async providerEvictMessages(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    providerMessageIds: readonly string[],
  ): Promise<void> {
    await this.submitProviderProjection(runtimeGeneration, {
      type: "providerRetract",
      runtimeGeneration,
      providerMessageIds,
      source: this.providerFactSource(projection),
    });
  }

  private providerSystemMessage(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    text: string,
    noticeKind: "info" | "error" = "info",
  ): Promise<unknown> {
    return this.submitProviderProjection(runtimeGeneration, {
      type: "systemNotice",
      runtimeGeneration,
      text,
      noticeKind,
      source: this.providerFactSource(projection),
    });
  }

  private async providerChildStreamEvent(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    childThreadId: string,
    message: Extract<SDKMessage, { type: "stream_event" }>,
  ): Promise<void> {
    const event = message.event;
    if (event.type === "message_start") {
      await this.invalidateRuntimeUsageSnapshot(runtimeGeneration);
      await this.applyProviderMainStream(
        projection,
        runtimeGeneration,
        { kind: "messageStart" },
        childThreadId,
      );
      return;
    }
    if (event.type === "content_block_start") {
      const block = event.content_block;
      const toolName = "name" in block && typeof block.name === "string" ? block.name : "";
      if (toolName.startsWith("mcp__ccodex_goal__")) return;
      if (block.type === "text" || block.type === "thinking") {
        await this.applyProviderMainStream(projection, runtimeGeneration, {
          kind: "blockStart",
          index: event.index,
          block: block.type === "text" ? "text" : "reasoning",
        }, childThreadId);
      } else if (block.type === "tool_use"
        || block.type === "server_tool_use"
        || block.type === "mcp_tool_use") {
        await this.applyProviderMainStream(projection, runtimeGeneration, {
          kind: "toolStart",
          index: event.index,
          block: block as unknown as Record<string, unknown>,
        }, childThreadId);
      } else {
        const result = serverToolResult(block);
        if (result) {
          await this.applyProviderMainStream(projection, runtimeGeneration, {
            kind: "toolComplete",
            providerId: result.toolUseId,
            output: result.output,
            isError: result.isError,
          }, childThreadId);
        }
      }
      return;
    }
    if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") {
        await this.applyProviderMainStream(projection, runtimeGeneration, {
          kind: "blockDelta",
          index: event.index,
          block: "text",
          delta: event.delta.text,
        }, childThreadId);
      } else if (event.delta.type === "thinking_delta") {
        await this.applyProviderMainStream(projection, runtimeGeneration, {
          kind: "blockDelta",
          index: event.index,
          block: "reasoning",
          delta: event.delta.thinking,
        }, childThreadId);
      } else if (event.delta.type === "input_json_delta") {
        await this.applyProviderMainStream(projection, runtimeGeneration, {
          kind: "toolInput",
          index: event.index,
          delta: event.delta.partial_json,
        }, childThreadId);
      }
      return;
    }
    if (event.type === "content_block_stop") {
      await this.applyProviderMainStream(
        projection,
        runtimeGeneration,
        { kind: "blockStop", index: event.index },
        childThreadId,
      );
    }
  }

  private async providerProjectAssistant(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    message: Extract<SDKMessage, { type: "assistant" }>,
    ownerThreadId: string,
  ): Promise<string[]> {
    if (!Array.isArray(message.message.content)) return [];
    const itemIds: (string | null)[] = message.message.content.map(() => null);
    for (const [index, block] of message.message.content.entries()) {
      const value = block as { type?: string; name?: string };
      if (["tool_use", "server_tool_use", "mcp_tool_use"].includes(value.type ?? "")
        && value.name?.startsWith("mcp__ccodex_goal__")) {
        continue;
      }
      if (block.type === "tool_use"
        || block.type === "server_tool_use"
        || block.type === "mcp_tool_use") {
        itemIds[index] = (await this.applyProviderMainStream(
          projection,
          runtimeGeneration,
          {
            kind: "toolStart",
            index,
            block: block as unknown as Record<string, unknown>,
          },
          ownerThreadId,
        ))?.tool?.foldedTaskId ? null : ("id" in block ? block.id : null);
      } else {
        const result = serverToolResult(block);
        if (result) {
          itemIds[index] = (await this.applyProviderMainStream(
            projection,
            runtimeGeneration,
            {
              kind: "toolComplete",
              providerId: result.toolUseId,
              output: result.output,
              isError: result.isError,
            },
            ownerThreadId,
          ))?.tool?.itemId ?? null;
        }
      }
    }
    const pending = (await this.applyProviderMainStream(
      projection,
      runtimeGeneration,
      { kind: "inspect" },
      ownerThreadId,
    ))?.taskIds.length;
    const stream = await this.applyProviderMainStream(
      projection,
      runtimeGeneration,
      {
        kind: "assistant",
        blocks: message.message.content.map((block) => block.type === "text"
          ? { block: "text" as const, text: block.text }
          : block.type === "thinking"
            ? { block: "reasoning" as const, text: block.thinking }
            : null),
        completeAsCommentary: assistantHasTools(message) || Boolean(pending),
      },
      ownerThreadId,
    );
    return itemIds.flatMap((id, index) => id ?? stream?.itemIds[index] ?? []);
  }

  private async providerProjectToolResults(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    message: SDKMessage,
    ownerThreadId: string,
  ): Promise<string[]> {
    const structured = (message as { tool_use_result?: unknown }).tool_use_result;
    const resultData = structured && typeof structured === "object"
      ? structured as Record<string, unknown>
      : undefined;
    const backgroundId = backgroundTaskId(message);
    const itemIds: string[] = [];
    for (const result of toolResults(message)) {
      const outputFile = backgroundOutputFile(result.output);
      const projected = backgroundId
        ? await this.applyProviderMainStream(projection, runtimeGeneration, {
            kind: "taskStart",
            taskId: backgroundId,
            providerId: result.toolUseId,
            description: result.output,
            ...(outputFile ? { outputFile } : {}),
            confirmed: false,
          }, ownerThreadId)
        : await this.applyProviderMainStream(projection, runtimeGeneration, {
            kind: "toolComplete",
            providerId: result.toolUseId,
            output: result.output,
            isError: result.isError,
            ...(resultData ? { result: resultData } : {}),
          }, ownerThreadId);
      if (projected?.tool && !projected.tool.foldedTaskId) {
        itemIds.push(projected.tool.itemId);
      }
    }
    return itemIds;
  }

  private async providerToolProgress(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    message: Extract<SDKMessage, { type: "tool_progress" }>,
  ): Promise<void> {
    const retry = message.subagent_retry;
    const status = retry
      ? `Retrying ${message.subagent_type ?? "subagent"} (${retry.attempt}/${retry.max_retries})`
        + `${retry.retry_delay_ms > 0 ? ` in ${(retry.retry_delay_ms / 1_000).toFixed(1)}s` : ""}`
      : message.heartbeat
        ? `${message.subagent_type ?? "Claude tool"} still working`
        : undefined;
    const owner = await this.providerInteractionOwner(
      runtimeGeneration,
      message.tool_use_id,
      undefined,
    );
    await this.applyProviderMainStream(projection, runtimeGeneration, {
      kind: "toolProgress",
      providerId: message.tool_use_id,
      elapsedMs: Math.round(message.elapsed_time_seconds * 1_000),
      ...(status ? { message: status } : {}),
    }, owner);
  }

  private async providerSubmitLifecycle(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    fact: LifecycleFact,
  ): Promise<void> {
    await this.submitProviderProjection(runtimeGeneration, {
      type: "lifecycle",
      runtimeGeneration,
      fact,
      source: this.providerFactSource(projection),
    });
  }

  private async providerSubmitCompactionFailure(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    message: string,
  ): Promise<CompactionProjection | undefined> {
    return this.submitProviderProjection(runtimeGeneration, {
      type: "compactFailed",
      runtimeGeneration,
      message,
      codexErrorInfo: classifyClaudeRuntimeError(message),
      source: this.providerFactSource(projection),
    });
  }

  private async providerCompactionBoundary(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    runtime: ProviderRuntime,
    message: Extract<SDKMessage, { type: "system"; subtype: "compact_boundary" }>,
  ): Promise<"projected" | "stateOnly"> {
    const metadata = message.compact_metadata;
    const admission = await this.submitProviderProjection<{
      admitted: boolean;
      hidden: boolean;
    }>(runtimeGeneration, {
      type: "admitCompactBoundary",
      runtimeGeneration,
      trigger: metadata.trigger,
    });
    if (!admission?.admitted) {
      return "stateOnly";
    }
    let boundary: string = message.uuid;
    if (!admission.hidden) {
      try {
        const current = await this.submit<ClaudeThreadRecord>({
          type: "readThread",
          includeTurns: false,
        });
        boundary = await this.runtimeDependencies!.transcripts.resolveCompactionBoundary(
          current.claudeSessionId,
          current.thread.cwd,
          message,
        );
      } catch (error) {
        const failure = await this.providerSubmitCompactionFailure(
          projection,
          runtimeGeneration,
          error instanceof Error ? error.message : String(error),
        );
        if (failure) return failure.terminal ? "projected" : "stateOnly";
        throw error;
      }
    }
    const result = await this.submitProviderProjection<CompactionProjection | undefined>(
      runtimeGeneration,
      {
        type: "compactBoundary",
        runtimeGeneration,
        trigger: metadata.trigger,
        boundary,
        source: this.providerFactSource(projection),
      },
    );
    if (result && !result.hidden) {
      this.resolveProviderCompactionUsage(
        projection,
        runtimeGeneration,
        runtime,
        result.turnId,
        metadata,
      );
    }
    return result?.terminal || result && metadata.trigger === "auto"
      ? "projected"
      : "stateOnly";
  }

  private async claimProviderUsageSnapshot(runtimeGeneration: number): Promise<number> {
    const snapshot = await this.submitProviderProjection<number | false>(runtimeGeneration, {
      type: "runtimeUsageSnapshot",
      runtimeGeneration,
      action: "claim",
    });
    return typeof snapshot === "number" ? snapshot : -1;
  }

  private async providerUsageSnapshotCurrent(
    runtimeGeneration: number,
    snapshot: number,
  ): Promise<boolean> {
    return Boolean(await this.submitProviderProjection<boolean>(runtimeGeneration, {
      type: "runtimeUsageSnapshot",
      runtimeGeneration,
      action: "isCurrent",
      snapshot,
    }));
  }

  private async publishProviderUsage(
    runtimeGeneration: number,
    turnId: string,
    last: TokenUsageBreakdown,
    modelContextWindow: number | null,
  ): Promise<void> {
    await this.submitProviderProjection(runtimeGeneration, {
      type: "publishUsage",
      runtimeGeneration,
      turnId,
      last,
      modelContextWindow,
    });
  }

  private async accountProviderUsage(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    runtime: ProviderRuntime,
    message: Extract<SDKMessage, { type: "result"; subtype: "success" }>,
  ): Promise<void> {
    const turnId = projection.context.getStore()?.activeTurnId;
    if (!turnId) return;
    if (!await this.submitProviderProjection(runtimeGeneration, {
      type: "accountUsage",
      runtimeGeneration,
      aggregate: usageBreakdown(message.usage),
      costUsd: message.total_cost_usd,
    })) {
      return;
    }
    const generation = await this.claimProviderUsageSnapshot(runtimeGeneration);
    const iteration = finalIterationUsage(message);
    const contextWindows = Object.values(message.modelUsage).map((usage) => usage.contextWindow);
    const fallbackWindow = contextWindows.length > 0
      ? Math.max(...contextWindows)
      : (await this.submitProviderProjection<RuntimeInspection>(runtimeGeneration, {
          type: "inspectRuntime",
          runtimeGeneration,
        })).modelContextWindow;
    void this.resolveProviderResultUsage(
      runtimeGeneration,
      runtime,
      generation,
      turnId,
      iteration,
      fallbackWindow,
    );
  }

  private async resolveProviderResultUsage(
    runtimeGeneration: number,
    runtime: ProviderRuntime,
    generation: number,
    turnId: string,
    iteration: ClaudeIterationUsage | undefined,
    fallbackWindow: number | null,
  ): Promise<void> {
    try {
      const context = await runtime.getContextUsage();
      if (!await this.providerUsageSnapshotCurrent(runtimeGeneration, generation)) return;
      await this.publishProviderUsage(
        runtimeGeneration,
        turnId,
        residentBreakdown(context.totalTokens, iteration),
        context.maxTokens,
      );
    } catch (error) {
      this.runtimeDependencies?.logger.debug("claude.context-usage.failed", {
        threadId: this.threadId,
        error: String(error),
      });
      if (!await this.providerUsageSnapshotCurrent(runtimeGeneration, generation) || !iteration) {
        return;
      }
      await this.publishProviderUsage(
        runtimeGeneration,
        turnId,
        usageBreakdown(iteration),
        fallbackWindow,
      );
    }
  }

  private resolveProviderCompactionUsage(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    runtime: ProviderRuntime,
    turnId: string,
    metadata: { pre_tokens: number; post_tokens?: number },
  ): void {
    void (async () => {
      const generation = await this.claimProviderUsageSnapshot(runtimeGeneration);
      try {
        const context = await runtime.getContextUsage();
        if (!await this.providerUsageSnapshotCurrent(runtimeGeneration, generation)) return;
        await this.publishProviderUsage(
          runtimeGeneration,
          turnId,
          residentBreakdown(context.totalTokens),
          context.maxTokens,
        );
      } catch (error) {
        this.runtimeDependencies?.logger.debug("claude.context-usage.failed", {
          threadId: this.threadId,
          error: String(error),
        });
        if (!await this.providerUsageSnapshotCurrent(runtimeGeneration, generation)
          || metadata.post_tokens === undefined) {
          return;
        }
        const inspection = await this.submitProviderProjection<RuntimeInspection>(
          runtimeGeneration,
          { type: "inspectRuntime", runtimeGeneration },
        );
        if (!await this.providerUsageSnapshotCurrent(runtimeGeneration, generation)) return;
        await this.publishProviderUsage(
          runtimeGeneration,
          turnId,
          residentBreakdown(metadata.post_tokens),
          inspection.modelContextWindow,
        );
      }
    })();
  }

  private async accountProviderGoalUsage(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    message: Extract<SDKMessage, { type: "result" }>,
  ): Promise<void> {
    const turnId = projection.context.getStore()?.activeTurnId;
    if (!turnId) return;
    const usage = (message as unknown as { usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number | null;
    } }).usage;
    if (!usage) return;
    await this.submitProviderProjection(runtimeGeneration, {
      type: "goalResultUsage",
      runtimeGeneration,
      turnId,
      eventId: message.uuid,
      totalTokens: usage.input_tokens
        + (usage.cache_creation_input_tokens ?? 0)
        + usage.output_tokens,
    });
  }

  private async providerMainStreamEvent(
    projection: ProviderProjectionState,
    runtimeGeneration: number,
    message: Extract<SDKMessage, { type: "stream_event" }>,
  ): Promise<void> {
    const event = message.event;
    if (!projection.context.getStore()?.activeTurnId) return;
    if (event.type === "message_start") {
      await this.invalidateRuntimeUsageSnapshot(runtimeGeneration);
      await this.providerSubmitLifecycle(
        projection,
        runtimeGeneration,
        { type: "request", messageStarted: true },
      );
      await this.applyProviderMainStream(
        projection,
        runtimeGeneration,
        { kind: "messageStart" },
      );
      return;
    }
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block.type === "text" || block.type === "thinking") {
        await this.applyProviderMainStream(projection, runtimeGeneration, {
          kind: "blockStart",
          index: event.index,
          block: block.type === "text" ? "text" : "reasoning",
        });
      } else if (block.type === "tool_use"
        || block.type === "server_tool_use"
        || block.type === "mcp_tool_use") {
        await this.applyProviderMainStream(projection, runtimeGeneration, {
          kind: "toolStart",
          index: event.index,
          block: block as unknown as Record<string, unknown>,
        });
      } else {
        const result = serverToolResult(block);
        if (result) {
          await this.applyProviderMainStream(projection, runtimeGeneration, {
            kind: "toolComplete",
            providerId: result.toolUseId,
            output: result.output,
            isError: result.isError,
          });
        }
      }
      return;
    }
    if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") {
        await this.applyProviderMainStream(projection, runtimeGeneration, {
          kind: "blockDelta",
          index: event.index,
          block: "text",
          delta: event.delta.text,
        });
      } else if (event.delta.type === "thinking_delta") {
        await this.applyProviderMainStream(projection, runtimeGeneration, {
          kind: "blockDelta",
          index: event.index,
          block: "reasoning",
          delta: event.delta.thinking,
        });
      } else if (event.delta.type === "input_json_delta") {
        await this.applyProviderMainStream(projection, runtimeGeneration, {
          kind: "toolInput",
          index: event.index,
          delta: event.delta.partial_json,
        });
      }
      return;
    }
    if (event.type === "content_block_stop") {
      await this.applyProviderMainStream(
        projection,
        runtimeGeneration,
        { kind: "blockStop", index: event.index },
      );
    }
  }

  private async stopProviderRuntime(
    target: Pick<RuntimeGeneration, "generation" | "runtime">,
    reason: string,
    failed = false,
  ): Promise<void> {
    if (!target.runtime.beginClose()) {
      await target.runtime.close();
      return;
    }
    try {
      await this.cancelProviderInjections(target.runtime, target.generation, reason);
      await this.invalidateRuntimeUsageSnapshot(target.generation);
      await this.submitProviderProjection<CompactionProjection | undefined>(target.generation, {
        type: "compactRuntimeExited",
        runtimeGeneration: target.generation,
        message: reason,
      });
      await this.submitProviderProjection(target.generation, {
        type: failed ? "runtimeFailed" : "runtimeExited",
        runtimeGeneration: target.generation,
        message: reason,
        codexErrorInfo: classifyClaudeRuntimeError(reason),
      });
      await this.submitProviderProjection(target.generation, {
        type: "runtimeDetached",
        runtimeGeneration: target.generation,
      });
    } finally {
      await target.runtime.close();
    }
  }

  private async retireProviderRuntimeSilently(
    target: Pick<RuntimeGeneration, "generation" | "runtime">,
  ): Promise<void> {
    if (!target.runtime.beginClose()) {
      await target.runtime.close();
      return;
    }
    try {
      await this.submitProviderProjection(target.generation, {
        type: "runtimeDetached",
        runtimeGeneration: target.generation,
        requireQuiescent: true,
      });
      await this.invalidateRuntimeUsageSnapshot(target.generation);
      await this.cancelProviderInjections(
        target.runtime,
        target.generation,
        "Claude runtime retired before injected history was acknowledged.",
      );
    } finally {
      await target.runtime.close();
    }
  }

  private async retireProviderEphemeralPrelude(
    target: Pick<RuntimeGeneration, "generation" | "runtime">,
  ): Promise<void> {
    if (!target.runtime.beginClose()) {
      await target.runtime.close();
      return;
    }
    try {
      await this.submitProviderProjection(target.generation, {
        type: "runtimeDetached",
        runtimeGeneration: target.generation,
        ephemeralPrelude: true,
      });
      await this.invalidateRuntimeUsageSnapshot(target.generation);
      await this.cancelProviderInjections(
        target.runtime,
        target.generation,
        "Claude runtime restarted before injected history was acknowledged.",
      );
    } finally {
      await target.runtime.close();
    }
  }

  private async refreshProviderContextUsage(owner: RuntimeLease): Promise<void> {
    const generation = await this.claimProviderUsageSnapshot(owner.generation);
    const inspection = await this.submitProviderProjection<RuntimeInspection>(owner.generation, {
      type: "inspectRuntime",
      runtimeGeneration: owner.generation,
    });
    const turnId = inspection.lastCompletedTurnId;
    if (!turnId || !await this.providerUsageSnapshotCurrent(owner.generation, generation)) return;
    void (async () => {
      try {
        const context = await owner.runtime.getContextUsage();
        if (!await this.providerUsageSnapshotCurrent(owner.generation, generation)) return;
        await this.publishProviderUsage(
          owner.generation,
          turnId,
          residentBreakdown(context.totalTokens),
          context.maxTokens,
        );
      } catch (error) {
        this.runtimeDependencies?.logger.debug("claude.context-usage.failed", {
          threadId: this.threadId,
          error: String(error),
        });
      }
    })();
  }

  private async retireRuntimeOwner(
    owner: RuntimeLease,
    mode: "stop" | "silent" | "ephemeral" | "stale",
    reason?: string,
    requireNoAdmin = false,
    requireQuiescent = false,
    replacement = false,
  ): Promise<boolean> {
    let claim: RuntimeRetireClaim;
    for (;;) {
      claim = await this.submitLineage<RuntimeRetireClaim>({
        type: "runtimeLineage",
        action: "claimRetire",
        runtimeGeneration: owner.generation,
        requireNoAdmin,
        requireQuiescent,
        ...(replacement ? { replacement: true } : {}),
      });
      if (claim.kind !== "wait") break;
      await claim.done;
      if (claim.waitingFor === "retire") return true;
    }
    if (claim.kind === "absent") return false;
    if (claim.kind === "retireStarting") {
      try {
        if (mode === "stop") {
          await this.stopProviderRuntime(
            claim.candidate,
            reason ?? "Claude runtime unloaded.",
          );
        } else if (mode === "ephemeral") {
          await this.retireProviderEphemeralPrelude(claim.candidate);
        } else {
          await this.retireProviderRuntimeSilently(claim.candidate);
        }
      } finally {
        await this.submitLineage({
          type: "runtimeLineage",
          action: "startupRetired",
          runtimeGeneration: claim.startup.runtimeGeneration,
        });
      }
      return true;
    }
    await this.executeRetirement(claim.owner, mode, reason);
    return true;
  }

  private async executeRetirement(
    owner: RuntimeGeneration,
    mode: "stop" | "silent" | "ephemeral" | "stale",
    reason?: string,
  ): Promise<void> {
    try {
      if (mode === "stop") {
        await this.stopProviderRuntime(owner, reason ?? "Claude runtime unloaded.");
      } else if (mode === "ephemeral") {
        await this.retireProviderEphemeralPrelude(owner);
      } else {
        await this.retireProviderRuntimeSilently(owner);
      }
      await this.submitLineage({
        type: "runtimeLineage",
        action: "retired",
        runtimeGeneration: owner.generation,
      });
      if (mode === "stale") this.runtimeDependencies!.logger.info("claude.runtime.retired", {
        threadId: this.threadId,
        appliedGeneration: owner.appliedSettingsGeneration,
      });
    } catch (error) {
      await this.submitLineage<boolean>({
        type: "runtimeLineage",
        action: "retireFailed",
        runtimeGeneration: owner.generation,
        error,
      });
      throw error;
    }
  }

  private async retireStaleRuntime(): Promise<void> {
    const claim = await this.submitLineage<RuntimeRetireClaim>({
      type: "runtimeLineage",
      action: "claimRetire",
      staleOnly: true,
    });
    if (claim.kind === "retire") {
      await this.executeRetirement(claim.owner, "stale");
    } else if (claim.kind === "retireStarting") {
      try {
        await this.retireProviderRuntimeSilently(claim.candidate);
      } finally {
        await this.submitLineage({
          type: "runtimeLineage",
          action: "startupRetired",
          runtimeGeneration: claim.startup.runtimeGeneration,
        });
      }
    }
  }

  private async run(): Promise<void> {
    for await (const envelope of this.mailbox) this.dispatchEnvelope(envelope);
  }

  private dispatchEnvelope(envelope: CommandEnvelope<SessionMailboxCommand>): void {
    try {
      envelope.completion?.resolve(this.dispatch(envelope.command));
    } catch (error) {
      envelope.completion?.reject(error);
    }
  }

  private dispatch(command: SessionMailboxCommand): unknown {
    switch (command.type) {
      case "runtimeLineage": {
        switch (command.action) {
          case "claimStart": {
            if (this.runtimeReplacement && !command.replacement) {
              return {
                kind: "wait",
                waitingFor: "retire",
                done: this.runtimeReplacement.done,
              } satisfies RuntimeStartClaim;
            }
            const lineage = this.runtimeLineage;
            if (lineage.state === "ready") {
              return { kind: "lease", lease: lineage.owner } satisfies RuntimeStartClaim;
            }
            if (lineage.state === "starting") {
              if (lineage.candidate) {
                return { kind: "lease", lease: lineage.candidate } satisfies RuntimeStartClaim;
              }
              return {
                kind: "wait",
                waitingFor: "candidate",
                done: lineage.candidateDone,
              } satisfies RuntimeStartClaim;
            }
            if (lineage.state === "retiring" || lineage.state === "retiringStartup") {
              return {
                kind: "wait",
                waitingFor: "retire",
                done: lineage.done,
              } satisfies RuntimeStartClaim;
            }
            const generation = ++this.nextRuntimeGeneration;
            let settleCandidate!: (result: RuntimeCandidateResult) => void;
            const candidateDone = new Promise<RuntimeCandidateResult>((resolved) => {
              settleCandidate = resolved;
            });
            this.runtimeLineage = {
              state: "starting",
              generation,
              candidateDone,
              settleCandidate,
              startup: this.runtimeStartup(generation, command.resumeOverride),
            };
            return {
              kind: "start",
              startup: this.runtimeLineage.startup,
            } satisfies RuntimeStartClaim;
          }
          case "inspect": {
            if (this.runtimeReplacement && !command.replacement) {
              return { kind: "wait", done: this.runtimeReplacement.done } satisfies RuntimeOwnerInspection;
            }
            const lineage = this.runtimeLineage;
            if (lineage.state === "ready") {
              return { kind: "lease", lease: lineage.owner } satisfies RuntimeOwnerInspection;
            }
            if (lineage.state === "starting") {
              if (lineage.candidate) {
                return { kind: "lease", lease: lineage.candidate } satisfies RuntimeOwnerInspection;
              }
              return { kind: "wait", done: lineage.candidateDone } satisfies RuntimeOwnerInspection;
            }
            if (lineage.state === "retiring" || lineage.state === "retiringStartup") {
              return { kind: "wait", done: lineage.done } satisfies RuntimeOwnerInspection;
            }
            return { kind: "absent" } satisfies RuntimeOwnerInspection;
          }
          case "started": {
            const lineage = this.runtimeLineage;
            const candidate = lineage.state === "starting" ? lineage.candidate : undefined;
            if (lineage.state === "retiringStartup"
              && lineage.generation === command.runtimeGeneration) return "retiring";
            if (lineage.state !== "starting"
              || lineage.generation !== command.runtimeGeneration
              || !candidate
              || candidate.generation !== command.runtimeGeneration
              || candidate.runtime !== command.candidate.runtime) return false;
            if (candidate.runtime.hasExited) return false;
            if (!this.dispatch({
              type: "runtimeReady",
              runtimeGeneration: command.runtimeGeneration,
            })) return false;
            const owner: RuntimeGeneration = { ...candidate };
            this.metrics.runtimeLoaded(candidate.resume);
            this.runtimeLineage = { state: "ready", owner };
            return owner;
          }
          case "candidateCreated": {
            const lineage = this.runtimeLineage;
            if (lineage.state !== "starting"
              || lineage.generation !== command.runtimeGeneration) return false;
            const desired = this.requireRecord(false);
            if (settingsGeneration(desired) !== lineage.startup.settingsGeneration) return false;
            this.runtimeLineage = { ...lineage, candidate: command.candidate };
            lineage.settleCandidate({ ok: true, candidate: command.candidate });
            return true;
          }
          case "startFailed": {
            const lineage = this.runtimeLineage;
            if (lineage.state === "retiringStartup"
              && lineage.generation === command.runtimeGeneration) return false;
            if (lineage.state !== "starting"
              || lineage.generation !== command.runtimeGeneration) return false;
            this.runtimeLineage = { state: "absent" };
            if (lineage.candidate) {
              this.runtimeDependencies!.rateLimits.unregister(lineage.candidate.rateLimitGeneration);
            }
            lineage.settleCandidate({ ok: false, error: command.error });
            return true;
          }
          case "startupRetired": {
            const lineage = this.runtimeLineage;
            if (lineage.state !== "retiringStartup"
              || lineage.generation !== command.runtimeGeneration) return false;
            this.runtimeLineage = { state: "absent" };
            this.runtimeDependencies!.rateLimits.unregister(lineage.candidate.rateLimitGeneration);
            lineage.resolve();
            return true;
          }
          case "claimRetire": {
            if (this.runtimeReplacement && !command.replacement) {
              return {
                kind: "wait",
                waitingFor: "start",
                done: this.runtimeReplacement.done,
              } satisfies RuntimeRetireClaim;
            }
            const lineage = this.runtimeLineage;
            if (command.requireNoAdmin
              && (this.runtimeAdminOperations > 0 || this.runtimeInjectionOperations > 0)) {
              return { kind: "absent" } satisfies RuntimeRetireClaim;
            }
            if (lineage.state === "absent") {
              return { kind: "absent" } satisfies RuntimeRetireClaim;
            }
            if (lineage.state === "starting") {
              if (!lineage.candidate) {
                return {
                  kind: "wait",
                  waitingFor: "start",
                  done: lineage.candidateDone.then(() => undefined),
                } satisfies RuntimeRetireClaim;
              }
              if (command.runtimeGeneration !== undefined
                && command.runtimeGeneration !== lineage.generation) {
                return { kind: "absent" } satisfies RuntimeRetireClaim;
              }
              if (command.requireQuiescent && !this.isQuiescent()) {
                return { kind: "absent" } satisfies RuntimeRetireClaim;
              }
              if (command.staleOnly) {
                const desired = this.requireRecord(false);
                if (desired.thread.ephemeral
                  || settingsGeneration(desired) <= lineage.startup.settingsGeneration
                  || !this.isQuiescent()) {
                  return { kind: "absent" } satisfies RuntimeRetireClaim;
                }
              }
              let resolve!: () => void;
              const done = new Promise<void>((settled) => { resolve = settled; });
              this.runtimeLineage = {
                state: "retiringStartup",
                generation: lineage.generation,
                startup: lineage.startup,
                candidate: lineage.candidate,
                done,
                resolve,
              };
              return {
                kind: "retireStarting",
                startup: lineage.startup,
                candidate: lineage.candidate,
              } satisfies RuntimeRetireClaim;
            }
            if (lineage.state === "retiring" || lineage.state === "retiringStartup") {
              return {
                kind: "wait",
                waitingFor: "retire",
                done: lineage.done,
              } satisfies RuntimeRetireClaim;
            }
            if (command.runtimeGeneration !== undefined
              && lineage.owner.generation !== command.runtimeGeneration) {
              return { kind: "absent" } satisfies RuntimeRetireClaim;
            }
            if (command.requireQuiescent && !this.isQuiescent()) {
              return { kind: "absent" } satisfies RuntimeRetireClaim;
            }
            if (command.staleOnly) {
              const desired = this.requireRecord(false);
              if (desired.thread.ephemeral
                || settingsGeneration(desired) <= lineage.owner.appliedSettingsGeneration
                || !this.isQuiescent()) {
                return { kind: "absent" } satisfies RuntimeRetireClaim;
              }
            }
            if (lineage.owner.settingsApplication) {
              lineage.owner.settingsApplication.settle({
                ok: false,
                error: new Error(`Claude runtime '${this.threadId}' retired while applying settings.`),
              });
            }
            const { settingsApplication: _settingsApplication, ...owner } = lineage.owner;
            let resolve!: () => void;
            let reject!: (error: unknown) => void;
            const done = new Promise<void>((settled, failed) => {
              resolve = settled;
              reject = failed;
            });
            void done.catch(() => undefined);
            this.runtimeLineage = {
              state: "retiring",
              generation: owner.generation,
              owner,
              done,
              resolve,
              reject,
              exited: false,
            };
            return { kind: "retire", owner } satisfies RuntimeRetireClaim;
          }
          case "retired": {
            const lineage = this.runtimeLineage;
            if (lineage.state !== "retiring"
              || lineage.generation !== command.runtimeGeneration) return false;
            this.runtimeLineage = { state: "absent" };
            this.runtimeDependencies!.rateLimits.unregister(lineage.owner.rateLimitGeneration);
            this.metrics.runtimeUnloaded();
            lineage.resolve();
            return true;
          }
          case "retireFailed": {
            const lineage = this.runtimeLineage;
            if (lineage.state !== "retiring"
              || lineage.generation !== command.runtimeGeneration) return false;
            this.runtimeLineage = { state: "absent" };
            this.runtimeDependencies!.rateLimits.unregister(lineage.owner.rateLimitGeneration);
            this.metrics.runtimeUnloaded();
            lineage.reject(command.error);
            return false;
          }
          case "exited": {
            const lineage = this.runtimeLineage;
            if (lineage.state === "ready"
              && lineage.owner.generation === command.runtimeGeneration) {
              if (lineage.owner.settingsApplication) {
                lineage.owner.settingsApplication.settle({
                  ok: false,
                  error: new Error(`Claude runtime '${this.threadId}' exited while applying settings.`),
                });
              }
              const { settingsApplication: _settingsApplication, ...owner } = lineage.owner;
              let resolve!: () => void;
              let reject!: (error: unknown) => void;
              const done = new Promise<void>((settled, failed) => {
                resolve = settled;
                reject = failed;
              });
              void done.catch(() => undefined);
              this.runtimeLineage = {
                state: "retiring",
                generation: owner.generation,
                owner,
                done,
                resolve,
                reject,
                exited: true,
              };
              return undefined;
            }
            if (lineage.state === "starting"
              && lineage.generation === command.runtimeGeneration) {
              this.dispatch({
                type: "runtimeExited",
                runtimeGeneration: command.runtimeGeneration,
                message: command.reason,
                codexErrorInfo: command.codexErrorInfo,
              });
              this.dispatch({
                type: "runtimeDetached",
                runtimeGeneration: command.runtimeGeneration,
              });
              this.runtimeLineage = { state: "absent" };
              if (lineage.candidate) {
                this.runtimeDependencies!.rateLimits.unregister(lineage.candidate.rateLimitGeneration);
              }
              const error = new Error(
                `Claude runtime '${this.threadId}' became unavailable during initialization.`,
              );
              lineage.settleCandidate({ ok: false, error });
              return "starting";
            } else if (lineage.state === "retiring"
              && lineage.generation === command.runtimeGeneration) {
              this.runtimeLineage = { ...lineage, exited: true };
            }
            return undefined;
          }
          case "rateLimit": {
            const lineage = this.runtimeLineage;
            if (lineage.state !== "ready"
              || lineage.owner.generation !== command.runtimeGeneration) return false;
            this.runtimeDependencies!.rateLimits.mergeEvent(lineage.owner.rateLimitGeneration, command.info);
            return true;
          }
          case "authFailure": {
            const lineage = this.runtimeLineage;
            if (lineage.state !== "ready"
              || lineage.owner.generation !== command.runtimeGeneration) return false;
            this.runtimeDependencies!.rateLimits.invalidate(`authentication-failure: ${command.reason}`);
            return true;
          }
          case "catalogInvalidated": {
            const lineage = this.runtimeLineage;
            if (lineage.state !== "ready"
              || lineage.owner.generation !== command.runtimeGeneration) return false;
            this.runtimeDependencies!.invalidateModelCatalog();
            return true;
          }
          case "providerCommand": {
            const lineage = this.runtimeLineage;
            const current = lineage.state === "starting"
              ? lineage.generation
              : lineage.state === "ready"
                ? lineage.owner.generation
                : lineage.state === "retiring"
                  ? lineage.generation
                  : lineage.state === "retiringStartup"
                    ? lineage.generation
                  : undefined;
            if (current !== command.runtimeGeneration) return undefined;
            if ((lineage.state === "retiring" || lineage.state === "retiringStartup")
              && ![
                "runtimeExited",
                "runtimeFailed",
                "runtimeDetached",
                "compactRuntimeExited",
                "cancelRuntimeInjections",
              ]
                .includes(command.command.type)) return undefined;
            const result = this.dispatch(command.command);
            if (command.command.type === "runtimeDetached"
              && lineage.state === "retiring" && lineage.exited) {
              this.runtimeLineage = { state: "absent" };
              this.runtimeDependencies!.rateLimits.unregister(lineage.owner.rateLimitGeneration);
              this.metrics.runtimeUnloaded();
              lineage.resolve();
            }
            return result;
          }
          case "inspectCallback": {
            if (this.interruptFence || this.transportStopFence || this.dropLateFacts) return undefined;
            const lineage = this.runtimeLineage;
            const lease = lineage.state === "ready"
              ? lineage.owner
              : lineage.state === "starting"
                ? lineage.candidate
                : undefined;
            if (!lease || lease.generation !== command.runtimeGeneration) return undefined;
            return {
              inspection: this.inspectRuntime({
                type: "inspectRuntime",
                runtimeGeneration: command.runtimeGeneration,
                ...(command.providerId ? { providerId: command.providerId } : {}),
                ...(command.ownerThreadId ? { ownerThreadId: command.ownerThreadId } : {}),
              }),
              settings: lease.transportSettings,
            } satisfies ProviderCallbackContext;
          }
          case "providerGoal": {
            const lineage = this.runtimeLineage;
            const lease = lineage.state === "ready"
              ? lineage.owner
              : lineage.state === "starting"
                ? lineage.candidate
                : undefined;
            if (!lease || lease.generation !== command.runtimeGeneration
              || this.interruptFence || this.transportStopFence || this.dropLateFacts
              || !this.lifecycle || !this.scopes.has(this.threadId)) {
              throw invalidParams("Claude runtime is no longer accepting goal commands.");
            }
            return this.dispatch({ type: "goal", command: command.command });
          }
          case "claimSettings": {
            const lineage = this.runtimeLineage;
            if (lineage.state !== "ready"
              || lineage.owner.generation !== command.runtimeGeneration) {
              return { kind: "stale" } satisfies RuntimeSettingsClaim;
            }
            if (lineage.owner.appliedSettingsGeneration >= command.settings.settingsGeneration) {
              return { kind: "applied" } satisfies RuntimeSettingsClaim;
            }
            if (lineage.owner.settingsApplication) {
              return {
                kind: "wait",
                done: lineage.owner.settingsApplication.done,
              } satisfies RuntimeSettingsClaim;
            }
            let settle!: (result: RuntimeSettingsResult) => void;
            const done = new Promise<RuntimeSettingsResult>((resolved) => { settle = resolved; });
            const settingsApplication = { settings: command.settings, done, settle };
            this.runtimeLineage = {
              state: "ready",
              owner: { ...lineage.owner, settingsApplication },
            };
            return {
              kind: "apply",
              applied: lineage.owner.transportSettings,
            } satisfies RuntimeSettingsClaim;
          }
          case "settingsApplied": {
            const lineage = this.runtimeLineage;
            if (lineage.state !== "ready"
              || lineage.owner.generation !== command.runtimeGeneration
              || lineage.owner.settingsApplication?.settings.settingsGeneration
                !== command.settings.settingsGeneration) return false;
            const { settingsApplication, ...owner } = lineage.owner;
            this.runtimeLineage = {
              state: "ready",
              owner: {
                ...owner,
                transportSettings: command.settings,
                appliedSettingsGeneration: command.settings.settingsGeneration,
              },
            };
            settingsApplication.settle({ ok: true });
            return true;
          }
          case "settingsFailed": {
            const lineage = this.runtimeLineage;
            if (lineage.state !== "ready"
              || lineage.owner.generation !== command.runtimeGeneration
              || lineage.owner.settingsApplication?.settings.settingsGeneration
                !== command.settingsGeneration) return false;
            const { settingsApplication, ...owner } = lineage.owner;
            this.runtimeLineage = { state: "ready", owner };
            settingsApplication.settle({ ok: false, error: command.error });
            return true;
          }
          case "beginAdmin": {
            if (this.runtimeAdminOperations === 0) {
              let resolve!: () => void;
              const done = new Promise<void>((settled) => { resolve = settled; });
              this.runtimeAdminIdle = { done, resolve };
            }
            this.runtimeAdminOperations += 1;
            if (this.runtimeReplacement) return this.runtimeReplacement.done;
            return this.runtimeLineage.state === "retiring"
              || this.runtimeLineage.state === "retiringStartup"
              ? this.runtimeLineage.done
              : undefined;
          }
          case "endAdmin":
            this.runtimeAdminOperations -= 1;
            if (this.runtimeAdminOperations === 0 && this.runtimeAdminIdle) {
              this.runtimeAdminIdle.resolve();
              this.runtimeAdminIdle = undefined;
            }
            return undefined;
          case "beginInjection": {
            if (this.runtimeInjectionOperations === 0) {
              let resolve!: () => void;
              const done = new Promise<void>((settled) => { resolve = settled; });
              this.runtimeInjectionIdle = { done, resolve };
            }
            this.runtimeInjectionOperations += 1;
            if (this.runtimeReplacement) return this.runtimeReplacement.done;
            return this.runtimeLineage.state === "retiring"
              || this.runtimeLineage.state === "retiringStartup"
              ? this.runtimeLineage.done
              : undefined;
          }
          case "endInjection":
            this.runtimeInjectionOperations -= 1;
            if (this.runtimeInjectionOperations === 0 && this.runtimeInjectionIdle) {
              this.runtimeInjectionIdle.resolve();
              this.runtimeInjectionIdle = undefined;
            }
            return undefined;
          case "beginReplacement": {
            if (this.runtimeReplacement?.id === command.replacementId) return true;
            if (this.runtimeReplacement) return this.runtimeReplacement.done;
            this.beginRuntimeReplacement(command.replacementId);
            return true;
          }
          case "endReplacement":
            if (this.runtimeReplacement?.id === command.replacementId) {
              this.runtimeReplacement.resolve();
              this.runtimeReplacement = undefined;
            }
            return undefined;
          case "cancelReplacement":
            if (this.runtimeReplacement) {
              this.runtimeReplacement.resolve();
              this.runtimeReplacement = undefined;
            }
            return undefined;
          case "mayReleaseSession":
            return this.runtimeLineage.state === "absent"
              && this.runtimeAdminOperations === 0
              && this.runtimeInjectionOperations === 0
              && !this.runtimeReplacement;
          case "admitOperation":
            if (this.runtimeReplacement && !command.replacement) {
              return this.runtimeReplacement.done;
            }
            return this.runtimeLineage.state === "ready"
              ? this.runtimeLineage.owner.generation === command.runtimeGeneration
              : this.runtimeLineage.state === "starting"
                && this.runtimeLineage.candidate?.generation === command.runtimeGeneration;
        }
      }
      case "createThread": {
        if (command.record.thread.id !== this.threadId) {
          throw new Error(`Cannot create thread '${command.record.thread.id}' in session '${this.threadId}'.`);
        }
        if (this.record ?? this.repository.read(this.threadId, false)) {
          throw new Error(`Claude thread '${this.threadId}' already exists.`);
        }
        this.repository.create(command.record);
        this.record = command.record;
        this.lastPublishedUsage = this.usageKey(command.record);
        return command.record;
      }
      case "readThread":
        return this.requireRecord(command.includeTurns);
      case "recoverAfterRestart":
        return this.recoverAfterRestart(command.statusCommandEnabled);
      case "snapshotBranch": {
        const snapshot = this.repository.branchSnapshot(this.threadId);
        if (!snapshot) throw new Error(`Unknown Claude thread '${this.threadId}'.`);
        return snapshot satisfies SessionBranchSnapshot;
      }
      case "commitForkTarget": {
        if (command.record.thread.id !== this.threadId || (this.record ?? this.repository.read(this.threadId, false)))
          throw new Error(`Cannot commit fork target '${this.threadId}'.`);
        const boundaries = remapBoundaries(
          command.sourceBoundaries,
          command.uuidMap,
          new Set(command.turns.map((turn) => turn.id)),
        );
        const record = {
          ...command.record,
          lastClaudeMessageUuid: boundaries.at(-1)?.messageUuid ?? null,
          lastCompletedTurnId: command.turns.findLast((turn) => turn.status === "completed")?.id ?? null,
        };
        this.repository.commitFork(record, command.turns, boundaries);
        this.record = record;
        this.lastPublishedUsage = this.usageKey(record);
        return record;
      }
      case "commitRollback": {
        const current = this.requireRecord(true);
        if (this.repository.branchSnapshot(this.threadId)?.revision !== command.expectedRevision)
          throw invalidParams("Claude thread changed while rollback was being prepared; retry the rollback.");
        const retained = current.thread.turns.slice(0, command.keepCount);
        const boundaries = remapBoundaries(
          command.sourceBoundaries,
          command.uuidMap,
          new Set(retained.map((turn) => turn.id)),
        );
        const now = Math.floor(Date.now() / 1_000);
        const record = {
          ...current,
          claudeSessionId: command.replacementSessionId,
          lastClaudeMessageUuid: boundaries.at(-1)?.messageUuid ?? null,
          lastCompletedTurnId: retained.at(-1)?.id ?? null,
          thread: {
            ...current.thread,
            status: { type: "notLoaded" as const },
            updatedAt: now,
            recencyAt: now,
            turns: [],
          },
        };
        const retainedChildIds = childProjectionIds(retained);
        const removedChildIds = childProjectionIds(current.thread.turns.slice(command.keepCount));
        const owned = new Set(this.repository.ownedThreadIds(this.threadId).slice(1));
        const removed = new Set<string>();
        for (const childThreadId of removedChildIds) {
          if (!owned.has(childThreadId) || retainedChildIds.has(childThreadId)) continue;
          for (const descendant of this.repository.ownedThreadIds(childThreadId)) {
            if (owned.has(descendant)) removed.add(descendant);
          }
        }
        const removedThreadIds = [...removed].reverse();
        this.repository.commitRollback(record, command.keepCount, boundaries, removedThreadIds);
        this.record = record;
        this.runtimeGeneration = undefined;
        this.disposeRuntimeOperations();
        this.scopes.clear();
        this.tasks.clear();
        for (const childThreadId of removedThreadIds) {
          this.onChildRemoved(childThreadId);
          this.output.emit(childThreadId, "thread/deleted", { threadId: childThreadId });
        }
        return { ...record, thread: { ...record.thread, turns: retained } };
      }
      case "deleteBranchTarget":
      case "purgeStartupProjection": {
        this.repository.delete(this.threadId);
        this.record = undefined;
        this.runtimeGeneration = undefined;
        this.disposeRuntimeOperations();
        this.scopes.clear();
        this.tasks.clear();
        return undefined;
      }
      case "goal":
        if (this.adminOperation
          && this.adminOperation.kind !== "rename"
          && this.adminOperation.kind !== "archive"
          && command.command.kind !== "detach") {
          throw invalidParams(
            `Claude thread '${this.threadId}' is pending ${this.adminOperation.kind}; `
            + `retry the ${this.adminOperation.kind} request after cleanup completes.`,
          );
        }
        return dispatchGoal(this.goal, this.goalContext(), command.command);
      case "runtimeDetached": {
        const detached = this.runtimeGeneration === command.runtimeGeneration;
        if (detached && command.requireQuiescent && !this.isQuiescent()) {
          throw new Error(`Claude runtime '${this.threadId}' is not quiescent.`);
        }
        if (detached && command.ephemeralPrelude) {
          const inspection = this.inspectRuntime({
            type: "inspectRuntime",
            runtimeGeneration: command.runtimeGeneration,
          });
          if (!inspection.canRestartEphemeral) {
            throw new Error(`Claude runtime '${this.threadId}' no longer has a replayable ephemeral prelude.`);
          }
          this.pendingNoQuery = this.pendingInputs = 0;
          this.preparedRuntimeInputs.clear();
        }
        if (detached) {
          this.disposeRuntimeOperations();
          this.runtimeGeneration = undefined;
        }
        const goalDetached = runtimeDetached(this.goal, command.runtimeGeneration);
        if (detached) invalidateGoalEffect(this.goal);
        if (goalDetached || detached) {
          this.emitLifecycle(undefined, true);
          return true;
        }
        return false;
      }
      case "updateDesiredSettings": {
        const record = this.requireRecord(false);
        if (settingsGeneration(record) !== command.expectedGeneration) {
          return { record, changed: false, conflict: true } satisfies DesiredSettingsUpdate;
        }
        if (this.runtimeAdminOperations > 0) {
          return {
            record,
            changed: false,
            conflict: true,
            retryAfter: this.runtimeAdminIdle!.done,
          } satisfies DesiredSettingsUpdate;
        }
        const candidate = withSettingsFrom(record, command.candidate);
        if (JSON.stringify(candidate) === JSON.stringify(record))
          return { record, changed: false, conflict: false } satisfies DesiredSettingsUpdate;
        const lineage = this.runtimeLineage;
        const owner = lineage.state === "ready"
          ? lineage.owner
          : lineage.state === "starting"
            ? lineage.candidate
            : undefined;
        const runtimeLoaded = lineage.state !== "absent";
        const canRestartEphemeral = Boolean(record.thread.ephemeral && owner
          && this.inspectRuntime({
            type: "inspectRuntime",
            runtimeGeneration: owner.generation,
          }).canRestartEphemeral);
        if (canRestartEphemeral && this.runtimeInjectionOperations > 0) {
          return {
            record,
            changed: false,
            conflict: true,
            retryAfter: this.runtimeInjectionIdle!.done,
          } satisfies DesiredSettingsUpdate;
        }
        if (record.thread.ephemeral && runtimeLoaded && !canRestartEphemeral) {
          this.validateLiveEphemeralSettings(record, candidate);
        }
        const replacementId = canRestartEphemeral ? uuidv7() : undefined;
        if (replacementId && this.runtimeReplacement) {
          throw invalidParams(`Claude runtime '${this.threadId}' already has a settings replacement in progress.`);
        }
        const replay = owner && replacementId ? {
          resume: owner.resume,
          batches: owner.ephemeralPreludeBatches.map((batch) => [...batch]),
        } : undefined;
        const updated = {
          ...candidate,
          settingsGeneration: settingsGeneration(record) + 1,
          thread: { ...candidate.thread, updatedAt: Math.floor(Date.now() / 1_000) },
        };
        const params = { threadId: this.threadId, threadSettings: command.threadSettings };
        this.commitState(updated, [{ turnId: null, method: "thread/settings/updated", params }]);
        if (replacementId) this.beginRuntimeReplacement(replacementId);
        runtimeSettingsChanged(this.goal);
        this.emitLifecycle(undefined, true);
        return {
          record: updated,
          changed: true,
          conflict: false,
          ...(replacementId && replay ? { replacementId, replay } : {}),
        } satisfies DesiredSettingsUpdate;
      }
      case "publishThreadSettings": {
        const record = this.requireRecord(false);
        const params = {
          threadId: this.threadId,
          threadSettings: command.threadSettings,
        };
        this.commitState(record, [{ turnId: null, method: "thread/settings/updated", params }]);
        return undefined;
      }
      case "announceThread": {
        const record = this.requireRecord(false);
        const params = { thread: record.thread };
        this.publish(null, "thread/started", params);
        return undefined;
      }
      case "prepareTurn": {
        if (command.params.threadId !== this.threadId) {
          throw new Error(`Cannot prepare thread '${command.params.threadId}' in session '${this.threadId}'.`);
        }
        if (command.stagedMessageUuid && !this.stagedRuntimeTurns.delete(command.stagedMessageUuid)) {
          throw invalidParams(`Claude turn input '${command.stagedMessageUuid}' is no longer staged.`);
        }
        if (command.goalOperation && !consumeGoalContinuation(
          this.goal,
          this.goalContext(),
          command.goalOperation.operationId,
          command.goalOperation.goalId,
          command.goalOperation.runtimeGeneration,
        )) {
          this.emitLifecycle(undefined, true);
          return undefined;
        }
        const record = this.requireRecord(false);
        if (this.repository.archived(this.threadId)
          || this.adminOperation && this.adminOperation.kind !== "rename") {
          throw invalidParams(`Claude thread '${this.threadId}' is unavailable for a new turn.`);
        }
        if (this.lifecycle || this.compaction || record.thread.status.type === "active") {
          throw invalidParams(`Thread '${this.threadId}' already has an active turn.`);
        }
        if (!command.goalOperation) invalidateGoalEffect(this.goal);
        const turnId = uuidv7();
        const userItem: ThreadItem = {
          type: "userMessage",
          id: command.review ? turnId : uuidv7(),
          clientId: command.params.clientUserMessageId ?? null,
          content: command.params.input,
        };
        const reviewItem: ThreadItem | undefined = command.review
          ? { type: "enteredReviewMode", id: uuidv7(), review: command.review }
          : undefined;
        const preview = command.hiddenInput ? record.thread.preview : record.thread.preview || command.params.input
          .flatMap((item) => item.type === "text" ? [item.text] : [])
          .join(" ")
          .slice(0, 200);
        const started = this.startTurn(
          [...(reviewItem ? [reviewItem] : []), ...(command.hiddenInput ? [] : [userItem])],
          { preview },
          turnId,
        );
        const { turn } = started;
        this.scopes.set(this.threadId, newMainStreamState(this.threadId, turn.id, record, command.review));
        this.rootReadOnly = command.readOnly ?? false;
        this.lifecycle = {
          ...(command.synthetic ? { synthetic: command.synthetic } : {}),
          commandObserved: false, commandCompleted: false, notifications: 0,
          acknowledged: 0, diagnosed: 0, goals: 0, goalInFlight: false,
        };
        if (!command.synthetic) bindGoalTurn(this.goal, this.goalContext(), turn.id);
        if (!command.synthetic) this.emitLifecycle();
        return started;
      }
      case "announceTurn": {
        const turn = this.repository.readTurn(this.threadId, command.turnId);
        if (!turn) throw new Error(`Unknown Claude turn '${command.turnId}'.`);
        this.announceTurn(turn, true);
        return undefined;
      }
      case "completeSynthetic": {
        const active = this.lifecycle;
        const state = this.scopes.get(this.threadId);
        if (!active?.synthetic || !state) return false;
        if (command.turnId && command.turnId !== state.turnId) {
          const prior = this.repository.readTurn(this.threadId, command.turnId);
          if (prior?.status !== "inProgress") return true;
          throw invalidParams(`Turn '${command.turnId}' is not active in Claude thread '${this.threadId}'.`);
        }
        if (command.text) {
          this.projectMainStream(this.threadId, {
            kind: "assistant", blocks: [{ block: "text", text: command.text }], completeAsCommentary: false,
          }, nullSource);
          this.settleRootMessages("final_answer", nullSource);
        }
        active.result = {
          status: command.status, codexErrorInfo: command.codexErrorInfo, forced: true,
          ...(command.errorMessage ? { errorMessage: command.errorMessage } : {}),
        };
        active.commandCompleted = true;
        this.maybeFinish(nullSource);
        return true;
      }
      case "stageInjection": {
        if (command.runtimeGeneration !== this.runtimeGeneration) {
          throw new Error(`Claude runtime '${this.threadId}' changed before history injection.`);
        }
        const record = this.requireRecord(false);
        const updated = { ...record, lastClaudeMessageUuid: command.messageUuid };
        this.repository.update(updated);
        this.record = updated;
        let acknowledgement:
          | { done: Promise<RuntimeSettingsResult>; settle: (result: RuntimeSettingsResult) => void }
          | undefined;
        if (command.waitForAcknowledgement) {
          let settle!: (result: RuntimeSettingsResult) => void;
          const done = new Promise<RuntimeSettingsResult>((resolved) => { settle = resolved; });
          acknowledgement = { done, settle };
        }
        this.runtimeInjections.push({
          runtimeGeneration: command.runtimeGeneration,
          messageUuid: command.messageUuid,
          admitted: false,
          replayablePrelude: command.replayablePrelude,
          items: [...command.items],
          ...(acknowledgement ? { acknowledgement } : {}),
        });
        return {
          previous: record.lastClaudeMessageUuid,
          record: updated,
          ...(acknowledgement ? { acknowledgement: acknowledgement.done } : {}),
        };
      }
      case "cancelInjection": {
        const record = this.requireRecord(false);
        if (command.rollbackBoundary && record.lastClaudeMessageUuid === command.messageUuid) {
          const updated = { ...record, lastClaudeMessageUuid: command.previous };
          this.repository.update(updated);
          this.record = updated;
        }
        const index = this.runtimeInjections.findIndex((operation) =>
          operation.runtimeGeneration === command.runtimeGeneration
          && operation.messageUuid === command.messageUuid);
        if (index < 0) return false;
        const operation = this.runtimeInjections.splice(index, 1)[0]!;
        if (operation.admitted && this.runtimeGeneration === command.runtimeGeneration) {
          this.acceptLifecycle({ type: "noQueryAck" }, nullSource);
        }
        operation.acknowledgement?.settle({ ok: false, error: new Error(command.reason) });
        return true;
      }
      case "acknowledgeInjection": {
        const index = this.runtimeInjections.findIndex((operation) =>
          operation.runtimeGeneration === command.runtimeGeneration && operation.admitted);
        if (index < 0) return [];
        let count = 0;
        while (this.runtimeInjections[index + count]?.runtimeGeneration === command.runtimeGeneration
          && this.runtimeInjections[index + count]?.admitted) count += 1;
        const operations = this.runtimeInjections.splice(index, count);
        for (const operation of operations) {
          this.acceptLifecycle({ type: "noQueryAck" }, command.source);
          operation.acknowledgement?.settle({ ok: true });
        }
        return operations.map((operation) => operation.messageUuid);
      }
      case "cancelRuntimeInjections":
        return this.cancelRuntimeInjections(command.runtimeGeneration, command.reason);
      case "providerAssistantError":
        if (command.runtimeGeneration === this.runtimeGeneration) this.providerError = command.error;
        return undefined;
      case "classifyProviderResult":
        return command.runtimeGeneration === this.runtimeGeneration
          ? classifyClaudeResult(command.result, this.providerError)
          : { status: "failed" } satisfies ClaudeResultClassification;
      case "goalAssistantUsage":
        if (command.runtimeGeneration !== this.runtimeGeneration
          || this.goalUsageEvents.has(command.eventId)) return undefined;
        this.goalUsageEvents.add(command.eventId);
        this.goalCommandTokensObserved += command.tokens;
        return dispatchGoal(this.goal, this.goalContext(), {
          kind: "usage",
          turnId: command.turnId,
          eventId: command.eventId,
          tokenDelta: command.tokens,
        });
      case "goalResultUsage": {
        if (command.runtimeGeneration !== this.runtimeGeneration) return undefined;
        const tokenDelta = Math.max(0, command.totalTokens - this.goalCommandTokensObserved);
        this.goalUsageEvents.clear();
        this.goalCommandTokensObserved = 0;
        return dispatchGoal(this.goal, this.goalContext(), {
          kind: "usage",
          turnId: command.turnId,
          eventId: command.eventId,
          tokenDelta,
        });
      }
      case "runtimeUsageSnapshot":
        if (command.runtimeGeneration !== this.runtimeGeneration) return false;
        if (command.action === "isCurrent") {
          return command.snapshot === this.usageSnapshotGeneration;
        }
        this.usageSnapshotGeneration += 1;
        return command.action === "claim" ? this.usageSnapshotGeneration : undefined;
      case "attachRuntime":
        if (this.runtimeGeneration !== undefined && command.runtimeGeneration < this.runtimeGeneration) {
          throw new Error(
            `Cannot attach stale Claude runtime generation ${command.runtimeGeneration}; current is ${this.runtimeGeneration}.`,
          );
        }
        if (this.runtimeGeneration !== command.runtimeGeneration) {
          if (this.runtimeGeneration !== undefined) {
            this.cancelRuntimeInjections(
              this.runtimeGeneration,
              "Claude runtime replaced before injected history was acknowledged.",
            );
          }
          this.disposeRuntimeOperations();
        }
        this.runtimeGeneration = command.runtimeGeneration;
        runtimeAttached(this.goal, command.runtimeGeneration);
        this.interruptFence = this.dropLateFacts = false;
        this.pendingNoQuery = this.pendingInputs = 0;
        this.stagedRuntimeTurns.clear();
        this.preparedRuntimeInputs.clear();
        this.emitLifecycle(undefined, true);
        return undefined;
      case "runtimeReady": {
        if (command.runtimeGeneration !== this.runtimeGeneration
          || !this.record || this.repository.archived(this.threadId)
          || this.adminOperation && this.adminOperation.kind !== "rename") return false;
        const record = this.requireRecord(false);
        if (record.thread.status.type === "notLoaded" || record.thread.status.type === "systemError") {
          const updated = {
            ...record,
            thread: { ...record.thread, status: { type: "idle" as const }, updatedAt: Math.floor(Date.now() / 1_000) },
          };
          const params = { threadId: this.threadId, status: updated.thread.status };
          this.commitState(updated, [{ turnId: null, method: "thread/status/changed", params }]);
        }
        return true;
      }
      case "runtimeFailed":
      case "runtimeExited": {
        if (command.runtimeGeneration !== this.runtimeGeneration) return false;
        this.acceptLifecycle({
          type: "runtimeExit",
          message: command.message,
          codexErrorInfo: command.codexErrorInfo,
        }, { providerEventId: null, providerEventType: command.type });
        if (!this.lifecycle && this.record && !this.repository.archived(this.threadId)) {
          const record = this.requireRecord(false);
          const updated = {
            ...record,
            thread: {
              ...record.thread,
              status: { type: command.type === "runtimeFailed" ? "systemError" as const : "notLoaded" as const },
              updatedAt: Math.floor(Date.now() / 1_000),
            },
          };
          const params = { threadId: this.threadId, status: updated.thread.status };
          this.commitState(updated, [{ turnId: null, method: "thread/status/changed", params }]);
        }
        return true;
      }
      case "runtimeInitialized": {
        if (command.runtimeGeneration !== this.runtimeGeneration) return undefined;
        const record = this.requireRecord(false);
        if (command.providerSessionId !== record.claudeSessionId) {
          throw new Error(
            `Claude initialized session '${command.providerSessionId}', expected '${record.claudeSessionId}'.`,
          );
        }
        const updated: ClaudeThreadRecord = {
          ...record,
          resolvedModel: command.model,
          claudeCodeVersion: command.cliVersion,
          thread: { ...record.thread, cliVersion: command.cliVersion },
        };
        this.repository.update(updated);
        this.record = updated;
        return updated;
      }
      case "providerEventStarted": {
        const source = {
          providerEventId: command.providerEventId,
          providerEventType: command.providerEventType,
        };
        if (command.runtimeGeneration !== this.runtimeGeneration || !this.record) {
          return {
            sequence: 0, source, project: false, finish: false, activeTurnId: null, readOnly: false,
          } satisfies ProviderEventAdmission;
        }
        const journal = this.repository.appendProviderEvent({
          threadId: this.threadId,
          processEpoch: command.processEpoch,
          providerSequence: command.providerSequence,
          providerEventType: command.providerEventType,
          providerEventId: command.providerEventId,
          payload: command.payload,
          createdAt: Date.now(),
        });
        if (!journal.inserted && journal.record.disposition !== "pending"
          && journal.record.disposition !== "failed") {
          this.metrics.eventDeduplicated();
          return {
            sequence: journal.record.sequence,
            source,
            project: false,
            finish: false,
            activeTurnId: this.scopes.get(this.threadId)?.turnId ?? null,
            readOnly: this.rootReadOnly,
          } satisfies ProviderEventAdmission;
        }
        return {
          sequence: journal.record.sequence,
          source,
          project: !this.interruptFence && !this.transportStopFence && !this.dropLateFacts
            || command.providerEventType === "command_lifecycle",
          finish: true,
          activeTurnId: this.scopes.get(this.threadId)?.turnId ?? null,
          readOnly: this.rootReadOnly,
        } satisfies ProviderEventAdmission;
      }
      case "providerEventFinished": {
        if (command.sequence === 0 || command.runtimeGeneration !== this.runtimeGeneration) return false;
        this.repository.finishProviderEvent(
          this.threadId,
          command.sequence,
          command.disposition,
          command.error,
        );
        this.metrics.providerEvent(command.source.providerEventType ?? "unknown", command.disposition);
        if (command.disposition !== "failed"
          && command.source.providerEventId && command.source.providerEventType) {
          this.repository.markProviderEventProcessed(
            this.threadId,
            command.source.providerEventType,
            command.source.providerEventId,
          );
        }
        if (command.sequence % providerJournalPruneInterval === 0) {
          this.repository.pruneProviderEvents(
            this.threadId,
            providerJournalMaxEvents,
            providerJournalMaxBytes,
          );
        }
        return true;
      }
      case "providerBoundary": {
        if (command.runtimeGeneration !== this.runtimeGeneration || this.dropLateFacts) return false;
        const ownerThreadId = command.ownerThreadId ?? this.threadId;
        const state = this.scopes.get(ownerThreadId);
        if (!state) return false;
        const record = this.requireRecord(false);
        let updated = record;
        if (ownerThreadId === this.threadId) {
          updated = { ...record, lastClaudeMessageUuid: command.providerMessageId };
        }
        const itemIds = [...new Set(command.itemIds ?? [])];
        this.commitState(updated, [], undefined, false, {
          ownerThreadId,
          turnId: state.turnId,
          messageUuid: command.providerMessageId,
          itemIds,
        });
        return true;
      }
      case "providerRetract": {
        if (command.runtimeGeneration !== this.runtimeGeneration || this.dropLateFacts) return false;
        const providerMessageIds = [...new Set(command.providerMessageIds)];
        const retracted = new Set(providerMessageIds);
        const groups = new Map<string, {
          ownerThreadId: string;
          turnId: string;
          itemIds: Set<string>;
          clearBoundary: boolean;
        }>();
        for (const correlation of this.repository.providerItemCorrelations(this.threadId, providerMessageIds)) {
          const key = `${correlation.ownerThreadId}\0${correlation.turnId}`;
          const group = groups.get(key) ?? {
            ownerThreadId: correlation.ownerThreadId,
            turnId: correlation.turnId,
            itemIds: new Set<string>(),
            clearBoundary: false,
          };
          group.itemIds.add(correlation.itemId);
          groups.set(key, group);
        }
        const ownedThreadIds = this.repository.ownedThreadIds(this.threadId);
        const snapshots = new Map<string, SessionBranchSnapshot>();
        const record = this.requireRecord(false);
        let previousRootBoundary: string | null = null;
        for (const ownerThreadId of ownedThreadIds) {
          const snapshot = this.repository.branchSnapshot(ownerThreadId);
          if (!snapshot) continue;
          snapshots.set(ownerThreadId, snapshot);
          for (const boundary of snapshot.boundaries) {
            if (ownerThreadId === this.threadId && !retracted.has(boundary.messageUuid)) {
              previousRootBoundary = boundary.messageUuid;
            }
            if (!retracted.has(boundary.messageUuid)) continue;
            const key = `${ownerThreadId}\0${boundary.turnId}`;
            const group = groups.get(key) ?? {
              ownerThreadId,
              turnId: boundary.turnId,
              itemIds: new Set<string>(),
              clearBoundary: false,
            };
            group.clearBoundary = true;
            groups.set(key, group);
          }
        }
        const projectedChildIds = new Set<string>();
        const mutations = [...groups.values()].flatMap((group) => {
          const turn = this.repository.readTurn(group.ownerThreadId, group.turnId);
          if (!turn) return [];
          const removedItems = turn.items.filter((item) => group.itemIds.has(item.id));
          for (const childThreadId of childProjectionIds([{ ...turn, items: removedItems }])) {
            projectedChildIds.add(childThreadId);
          }
          turn.items = turn.items.filter((item) => !group.itemIds.has(item.id));
          return [{
            ownerThreadId: group.ownerThreadId,
            turn,
            clearBoundary: group.clearBoundary,
          }];
        });
        const retainedChildIds = new Set<string>();
        for (const [ownerThreadId, snapshot] of snapshots) {
          for (const turn of snapshot.record.thread.turns) {
            const group = groups.get(`${ownerThreadId}\0${turn.id}`);
            const retainedTurn = group
              ? { ...turn, items: turn.items.filter((item) => !group.itemIds.has(item.id)) }
              : turn;
            for (const childThreadId of childProjectionIds([retainedTurn])) retainedChildIds.add(childThreadId);
          }
        }
        const owned = new Set(ownedThreadIds.slice(1));
        const removed = new Set<string>();
        for (const childThreadId of projectedChildIds) {
          if (!owned.has(childThreadId) || retainedChildIds.has(childThreadId)) continue;
          for (const descendant of this.repository.ownedThreadIds(childThreadId)) {
            if (owned.has(descendant)) removed.add(descendant);
          }
        }
        const removedThreadIds = [...removed].reverse();
        const updated = {
          ...record,
          lastClaudeMessageUuid: record.lastClaudeMessageUuid !== null
            && retracted.has(record.lastClaudeMessageUuid)
            ? previousRootBoundary
            : record.lastClaudeMessageUuid,
        };
        this.repository.commitProviderRetraction(
          updated,
          providerMessageIds,
          mutations.filter((mutation) => !removed.has(mutation.ownerThreadId)),
          removedThreadIds,
        );
        this.record = updated;
        for (const group of groups.values()) {
          const state = this.scopes.get(group.ownerThreadId);
          if (state?.turnId === group.turnId) this.evictProjectedItems(state, group.itemIds);
        }
        for (const childThreadId of removedThreadIds) {
          this.scopes.delete(childThreadId);
          this.onChildRemoved(childThreadId);
          this.output.emit(childThreadId, "thread/deleted", { threadId: childThreadId });
        }
        for (const [taskId, task] of this.tasks) {
          if (removed.has(task.ownerThreadId)
            || task.childThreadId && removed.has(task.childThreadId)) this.tasks.delete(taskId);
        }
        return true;
      }
      case "conversationReset": {
        if (command.runtimeGeneration !== this.runtimeGeneration || this.dropLateFacts) return false;
        const record = this.requireRecord(false);
        const updated = {
          ...record,
          claudeSessionId: command.providerSessionId,
          lastClaudeMessageUuid: null,
          thread: { ...record.thread, name: null },
        };
        const params = { threadId: this.threadId, threadName: null };
        this.commitState(updated, [{
          turnId: null,
          method: "thread/name/updated",
          params,
          providerEventId: command.source.providerEventId,
          providerEventType: command.source.providerEventType,
        }]);
        this.appendSystemNotice(
          `Claude reset the provider conversation to ${command.providerSessionId}.`,
          "info",
          this.threadId,
          command.source,
        );
        return true;
      }
      case "modelFallback": {
        if (command.runtimeGeneration !== this.runtimeGeneration || this.dropLateFacts) return false;
        const record = this.requireRecord(false);
        const updated = { ...record, resolvedModel: command.model };
        const state = this.scopes.get(this.threadId);
        if (state) {
          const params = {
            threadId: this.threadId,
            turnId: state.turnId,
            fromModel: command.fromModel,
            toModel: command.model,
            reason: "highRiskCyberActivity",
          };
          this.commitState(updated, [{
            turnId: state.turnId,
            method: "model/rerouted",
            params,
            providerEventId: command.source.providerEventId,
            providerEventType: command.source.providerEventType,
          }]);
        } else {
          this.repository.update(updated);
          this.record = updated;
        }
        return true;
      }
      case "systemNotice":
        if (command.runtimeGeneration === this.runtimeGeneration && !this.dropLateFacts) {
          this.appendSystemNotice(
            command.text,
            command.noticeKind,
            command.ownerThreadId ?? this.threadId,
            command.source,
          );
          return true;
        }
        return false;
      case "runtimeNotification": {
        if (command.runtimeGeneration !== this.runtimeGeneration || this.dropLateFacts) return false;
        const ownerThreadId = command.ownerThreadId ?? this.threadId;
        const state = this.scopes.get(ownerThreadId);
        if (state) this.publishAt(ownerThreadId, state.turnId, command.method, command.params, command.source);
        else this.publish(null, command.method, command.params);
        return true;
      }
      case "steer": {
        if (command.runtimeGeneration !== this.runtimeGeneration || this.interruptFence
          || this.transportStopFence || this.dropLateFacts) {
          return undefined;
        }
        const state = this.scopes.get(this.threadId);
        if (!state || state.turnId !== command.expectedTurnId) {
          throw invalidParams(`Expected active turn '${command.expectedTurnId}' does not match the Claude thread.`);
        }
        const turn = this.repository.readTurn(this.threadId, state.turnId);
        if (!turn || turn.status !== "inProgress") {
          throw invalidParams(`Turn '${command.expectedTurnId}' is not active in Claude thread '${this.threadId}'.`);
        }
        const item: ThreadItem = {
          type: "userMessage",
          id: uuidv7(),
          clientId: command.clientUserMessageId ?? null,
          content: command.input,
        };
        turn.items.push(item);
        this.publishTurn(turn, "item/started", {
          item,
          threadId: this.threadId,
          turnId: turn.id,
          startedAtMs: Date.now(),
        }, nullSource);
        this.publishTurn(turn, "item/completed", {
          item,
          threadId: this.threadId,
          turnId: turn.id,
          completedAtMs: Date.now(),
        }, nullSource);
        this.acceptLifecycle({ type: "expectedCommand", id: command.messageUuid }, nullSource);
        this.preparedRuntimeInputs.set(command.messageUuid, "steer");
        this.emitLifecycle();
        return { messageUuid: command.messageUuid, turnId: turn.id } satisfies RuntimeInputAction;
      }
      case "stageRuntimeTurn": {
        const record = this.requireRecord(false);
        if (command.runtimeGeneration === this.runtimeGeneration) {
          if (this.stagedRuntimeTurns.has(command.messageUuid)) {
            return { kind: "staged" } satisfies RuntimeTurnStage;
          }
          if (this.stagedRuntimeTurns.size) return { kind: "busy" } satisfies RuntimeTurnStage;
        }
        if (command.runtimeGeneration !== this.runtimeGeneration
          || command.settingsGeneration !== settingsGeneration(record)) {
          return {
            kind: "stale",
            reason: command.runtimeGeneration === this.runtimeGeneration ? "settings" : "runtime",
            settings: {
              cwd: record.thread.cwd,
              model: record.claudeModelValue,
              settingsGeneration: settingsGeneration(record),
              approvalPolicy: record.approvalPolicy,
              approvalsReviewer: record.approvalsReviewer,
              sandboxPolicy: record.sandboxPolicy,
              serviceTier: record.serviceTier,
              reasoningEffort: record.reasoningEffort,
              reasoningSummary: record.reasoningSummary,
              collaborationMode: record.collaborationMode,
            },
          } satisfies RuntimeTurnStage;
        }
        if (this.interruptFence || this.transportStopFence
          || this.lifecycle || this.compaction || record.thread.status.type === "active") {
          return { kind: "busy" } satisfies RuntimeTurnStage;
        }
        this.stagedRuntimeTurns.add(command.messageUuid);
        this.emitLifecycle();
        return { kind: "staged" } satisfies RuntimeTurnStage;
      }
      case "cancelRuntimeTurnStage": {
        if (command.runtimeGeneration !== this.runtimeGeneration) return false;
        const cancelled = this.stagedRuntimeTurns.delete(command.messageUuid);
        if (cancelled) this.emitLifecycle();
        return cancelled;
      }
      case "prepareRuntimeInput": {
        if (command.runtimeGeneration !== this.runtimeGeneration
          || this.interruptFence || this.transportStopFence) {
          return undefined;
        }
        const state = this.scopes.get(this.threadId);
        if (command.kind === "turn") {
          if (!state || state.turnId !== command.turnId || !this.lifecycle) return undefined;
          this.dropLateFacts = false;
          this.acceptLifecycle({ type: "expectedCommand", id: command.messageUuid }, nullSource);
          this.preparedRuntimeInputs.set(command.messageUuid, command.kind);
          this.emitLifecycle();
          return { messageUuid: command.messageUuid, turnId: state.turnId } satisfies RuntimeInputAction;
        }
        if (this.dropLateFacts) return undefined;
        if (command.kind === "noQuery") {
          const injection = this.runtimeInjections.find((operation) =>
            operation.runtimeGeneration === command.runtimeGeneration
            && operation.messageUuid === command.messageUuid);
          if (!injection) return undefined;
          injection.admitted = true;
          this.acceptLifecycle({ type: "noQuery" }, nullSource);
          this.preparedRuntimeInputs.set(command.messageUuid, command.kind);
          this.emitLifecycle();
          return { messageUuid: command.messageUuid, turnId: state?.turnId ?? null } satisfies RuntimeInputAction;
        }
        if (!state || state.turnId !== command.turnId || !this.lifecycle) return undefined;
        if (command.kind === "hiddenGoal") this.acceptLifecycle({ type: "goalQueued" }, nullSource);
        this.acceptLifecycle({ type: "expectedCommand", id: command.messageUuid }, nullSource);
        this.preparedRuntimeInputs.set(command.messageUuid, command.kind);
        this.emitLifecycle();
        return { messageUuid: command.messageUuid, turnId: state.turnId } satisfies RuntimeInputAction;
      }
      case "completeRuntimeInput": {
        if (command.runtimeGeneration !== this.runtimeGeneration) return false;
        const kind = this.preparedRuntimeInputs.get(command.messageUuid);
        if (!kind) return false;
        this.preparedRuntimeInputs.delete(command.messageUuid);
        if (command.sent && kind === "noQuery") {
          const injection = this.runtimeInjections.find((operation) =>
            operation.runtimeGeneration === command.runtimeGeneration
            && operation.messageUuid === command.messageUuid);
          const lineage = this.runtimeLineage;
          const lease = lineage.state === "ready"
            ? lineage.owner
            : lineage.state === "starting"
              ? lineage.candidate
              : undefined;
          if (injection?.replayablePrelude && lease?.generation === command.runtimeGeneration
            && lease.ephemeral) {
            const updated = {
              ...lease,
              ephemeralPreludeBatches: [
                ...lease.ephemeralPreludeBatches,
                [...injection.items],
              ],
            };
            if (lineage.state === "ready") {
              this.runtimeLineage = { state: "ready", owner: updated };
            } else if (lineage.state === "starting") {
              this.runtimeLineage = { ...lineage, candidate: updated };
            }
          }
        }
        if (command.sent && kind !== "noQuery") this.hasSubmittedRuntimeInput = true;
        if (command.sent && kind === "turn") {
          this.providerError = undefined;
          this.goalUsageEvents.clear();
          this.goalCommandTokensObserved = 0;
        }
        this.emitLifecycle();
        return true;
      }
      case "claimRuntimeInput": {
        if (command.runtimeGeneration !== this.runtimeGeneration) return false;
        if (!this.preparedRuntimeInputs.has(command.messageUuid)) return false;
        if (this.interruptFence || this.transportStopFence || this.dropLateFacts) {
          this.preparedRuntimeInputs.delete(command.messageUuid);
          this.emitLifecycle();
          return false;
        }
        return true;
      }
      case "fenceCurrentRuntimeStop": {
        if (this.runtimeGeneration === undefined) return false;
        const state = this.scopes.get(this.threadId);
        if (!state) return false;
        if (command.expectedTurnId && state.turnId !== command.expectedTurnId) {
          const prior = this.repository.readTurn(this.threadId, command.expectedTurnId);
          if (prior?.status !== "inProgress") return false;
          throw invalidParams(
            `Turn '${command.expectedTurnId}' is not active in Claude thread '${this.threadId}'.`,
          );
        }
        this.transportStopFence = true;
        this.emitLifecycle(undefined, true);
        return true;
      }
      case "runtimeInputQueueChanged":
        if (command.runtimeGeneration !== this.runtimeGeneration) return false;
        this.pendingInputs = command.pendingInputs;
        this.maybeFinish(nullSource);
        return true;
      case "inspectRuntime":
        return this.inspectRuntime(command);
      case "mainStream":
        if (command.runtimeGeneration !== this.runtimeGeneration
          || this.interruptFence || this.dropLateFacts) return undefined;
        {
          const ownerThreadId = command.ownerThreadId ?? this.threadId;
          if (!this.scopes.has(ownerThreadId)) {
            if (command.fact.kind === "inspect") return undefined;
            switch (command.fact.kind) {
              case "taskStart": case "taskProgress": case "taskMembership":
              case "taskOutput": case "taskComplete": case "taskStop":
                return this.projectDetachedTaskFact(command.fact, command.source);
            }
          }
        }
        {
          if (command.fact.kind === "taskComplete" && !command.fact.outputDrained) {
            const task = this.tasks.get(command.fact.taskId);
            if (task?.outputTailer) {
              return this.completeTaskAfterOutputDrain(
                command.runtimeGeneration,
                command.ownerThreadId ?? task?.ownerThreadId ?? this.threadId,
                command.fact,
                command.source,
              );
            }
          }
          const projected = this.projectMainStream(command.ownerThreadId ?? this.threadId, command.fact, command.source);
          this.maybeFinish(command.source);
          return projected;
        }
      case "captureToolFileBefore":
        return this.captureToolFileBefore(command);
      case "captureToolFileAfter":
        return this.captureToolFileAfter(command.runtimeGeneration, command.providerId);
      case "hook":
        if (command.runtimeGeneration !== this.runtimeGeneration || this.interruptFence || this.dropLateFacts) return false;
        return this.acceptHook(command.fact, command.source);
      case "disposeRuntimeOperations":
        this.disposeRuntimeOperations();
        return undefined;
      case "accountUsage": {
        if (command.runtimeGeneration !== this.runtimeGeneration) return undefined;
        const record = this.requireRecord(false);
        const updated = {
          ...record,
          tokenUsageTotal: addUsage(record.tokenUsageTotal, command.aggregate),
          providerCostUsdTotal: (record.providerCostUsdTotal ?? 0) + (command.costUsd ?? 0),
        };
        this.repository.update(updated);
        this.record = updated;
        return updated;
      }
      case "accountCost": {
        if (command.runtimeGeneration !== this.runtimeGeneration) return undefined;
        const record = this.requireRecord(false);
        const updated = {
          ...record,
          providerCostUsdTotal: (record.providerCostUsdTotal ?? 0) + command.costUsd,
        };
        this.repository.update(updated);
        this.record = updated;
        return updated;
      }
      case "publishUsage": {
        if (command.runtimeGeneration !== this.runtimeGeneration) return undefined;
        const record = this.requireRecord(false);
        const updated: ClaudeThreadRecord = {
          ...record,
          tokenUsageLast: command.last,
          modelContextWindow: command.modelContextWindow,
        };
        const key = this.usageKey(updated);
        if (key === this.lastPublishedUsage) return updated;
        const params = {
          threadId: this.threadId,
          turnId: command.turnId,
          tokenUsage: {
            total: updated.tokenUsageTotal,
            last: command.last,
            modelContextWindow: command.modelContextWindow,
          },
        };
        this.commitState(updated, [{
          turnId: command.turnId,
          method: "thread/tokenUsage/updated",
          params,
        }]);
        this.lastPublishedUsage = key;
        return updated;
      }
      case "lifecycle":
        if (command.runtimeGeneration === this.runtimeGeneration)
          this.acceptLifecycle(command.fact, command.source);
        return undefined;
      case "openInteraction": {
        if (command.runtimeGeneration !== this.runtimeGeneration
          || this.interruptFence || this.transportStopFence || this.dropLateFacts) {
          return {
            requestId: "",
            pending: false,
            response: { cancelled: true },
          } satisfies OpenedSessionInteraction;
        }
        const request = command.request;
        if (request.threadId !== this.threadId && !this.scopes.has(request.threadId)) {
          throw new Error(`Cannot open interaction for '${request.threadId}' in session '${this.threadId}'.`);
        }
        const existing = request.claudeRequestId
          ? this.repository.pendingRequestByClaudeId(request.threadId, request.claudeRequestId)
          : undefined;
        if (existing && existing.status !== "pending") {
          return {
            requestId: existing.requestId,
            pending: false,
            response: existing.response,
          } satisfies OpenedSessionInteraction;
        }
        const scope = this.scopes.get(request.threadId);
        const turn = request.turnId ? this.repository.readTurn(request.threadId, request.turnId) : undefined;
        const idleRootRequest = request.threadId === this.threadId
          && request.turnId === null
          && !this.lifecycle;
        if (!idleRootRequest && (!scope || request.turnId !== scope.turnId || turn?.status !== "inProgress")) {
          return {
            requestId: existing?.requestId ?? "",
            pending: false,
            response: { cancelled: true },
          } satisfies OpenedSessionInteraction;
        }
        const pending = existing ?? {
          requestId: `hyb-claude-request:${uuidv7()}`,
          threadId: request.threadId,
          turnId: request.turnId,
          claudeRequestId: request.claudeRequestId,
          method: request.method,
          params: request.params,
          status: "pending" as const,
          response: null,
          createdAt: Date.now(),
          resolvedAt: null,
        };
        if (!existing) this.repository.createPendingRequest(pending);
        this.metrics.pendingOpened(pending.requestId, pending.createdAt);
        this.syncInteractionStatus(pending.threadId, pending.turnId);
        this.interactionWaiter(pending.requestId);
        return {
          requestId: pending.requestId,
          pending: true,
          response: null,
        } satisfies OpenedSessionInteraction;
      }
      case "announceInteraction": {
        if (command.runtimeGeneration !== this.runtimeGeneration) return false;
        const request = this.repository.pendingRequest(command.requestId);
        if (!request || request.threadId !== this.threadId && !this.scopes.has(request.threadId)
          || request.status !== "pending") return false;
        if (this.announcedInteractions.has(request.requestId)) return false;
        this.announcedInteractions.add(request.requestId);
        this.output.request(request.threadId, request.requestId, request.method, request.params);
        return true;
      }
      case "waitInteraction": {
        if (command.runtimeGeneration !== this.runtimeGeneration) return { cancelled: true };
        const waiter = this.interactionWaiter(command.requestId);
        waiter.claimed = true;
        if (waiter.resolved) this.interactionWaiters.delete(command.requestId);
        const cancel = () => {
          void this.submit({
            type: "cancelInteraction",
            runtimeGeneration: command.runtimeGeneration,
            requestId: command.requestId,
          });
        };
        if (command.signal?.aborted) queueMicrotask(cancel);
        else command.signal?.addEventListener("abort", cancel, { once: true });
        return waiter.promise;
      }
      case "resolveInteraction":
        return this.settleInteraction(command.requestId, "resolved", command.response);
      case "cancelInteraction":
        if (command.runtimeGeneration !== this.runtimeGeneration) return false;
        return this.settleInteraction(command.requestId, "cancelled", { cancelled: true });
      case "cancelInteractions":
        if (command.runtimeGeneration !== this.runtimeGeneration) return false;
        for (const scope of command.ownerThreadId
          ? [command.ownerThreadId]
          : this.repository.ownedThreadIds(this.threadId)) {
          for (const request of this.repository.pendingRequests(scope)) {
            this.settleInteraction(request.requestId, "cancelled", { cancelled: true });
          }
        }
        return undefined;
      case "replayInteractions":
        for (const scope of this.repository.ownedThreadIds(this.threadId)) {
          for (const request of this.repository.pendingRequests(scope)) {
            if (command.connectionId) {
              this.output.request(
                request.threadId, request.requestId, request.method, request.params, command.connectionId,
              );
            } else {
              this.output.request(request.threadId, request.requestId, request.method, request.params);
            }
          }
        }
        return undefined;
      case "threadAdmin":
        return this.dispatchThreadAdmin(command.command);
      case "runShell":
        return this.runShell(command.command);
      case "startShell":
        return this.startShell(command.command);
      case "admitShellEffect":
        return this.admitShellEffect(command.operationId);
      case "shellOutput":
        return this.appendShellOutput(command.operationId, command.delta);
      case "finishShell":
        return this.finishShell(command.operationId, command.exitCode, command.errorMessage);
      case "prepareShellCancellation":
        return this.cancelShell(command.turnId);
      case "finalizeShellCancellation":
        return this.finalizeShellCancellation(command.operationId);
      case "reportError": {
        if (!this.repository.ownedThreadIds(this.threadId).includes(command.threadId)) {
          return false;
        }
        if (this.dropLateFacts || this.adminOperation && this.adminOperation.kind !== "rename"
          || this.repository.archived(command.threadId)) return false;
        const state = this.scopes.get(command.threadId);
        if (!state || command.requestedTurnId && command.requestedTurnId !== state.turnId
          || this.repository.readTurn(command.threadId, state.turnId)?.status !== "inProgress") return false;
        this.projectMainStream(command.threadId, {
          kind: "instantAgent",
          text: systemNoticeText(command.message, "error"),
        }, nullSource);
        return true;
      }
      case "startCompact": {
        const started = this.startCompaction(command.input ?? "/compact", command.hidden ?? false);
        if (!command.deferred && !command.hidden) this.announceCompaction(started.operationId);
        else if (command.hidden) this.emitLifecycle(undefined, true);
        return started;
      }
      case "announceCompaction":
        return this.announceCompaction(command.operationId);
      case "admitCompactTransport": {
        const operation = this.compaction;
        if (!operation || operation.operationId !== command.action.operationId
          || operation.messageUuid !== command.action.messageUuid
          || operation.runtimeGeneration !== command.action.runtimeGeneration
          || operation.cancellation || operation.transport !== "pending") return false;
        operation.transport = "admitted";
        return true;
      }
      case "completeCompactTransport": {
        const operation = this.compaction;
        if (!operation || operation.operationId !== command.operationId
          || operation.messageUuid !== command.messageUuid
          || operation.runtimeGeneration !== command.runtimeGeneration) return undefined;
        if (command.sent) {
          if (operation.transport === "admitted") operation.transport = "sent";
          return this.compactionProjection();
        }
        if (operation.cancellation) return this.compactionProjection();
        return this.completeCompaction(
          "failed",
          command.errorMessage ?? "Claude compaction transport failed.",
          command.codexErrorInfo ?? "other",
          { providerEventId: null, providerEventType: "compact_input" },
        );
      }
      case "admitCompactBoundary":
        if (command.runtimeGeneration !== this.runtimeGeneration) return { admitted: false, hidden: false };
        return {
          admitted: command.trigger === "auto" ? !this.compaction && Boolean(this.activeNormalTurn())
            : Boolean(this.compaction && !this.compaction.cancellation),
          hidden: Boolean(this.compaction?.hidden),
        };
      case "compactBoundary":
        if (command.runtimeGeneration !== this.runtimeGeneration) return undefined;
        if (command.trigger === "auto") return this.projectAutomaticCompaction(command.boundary, command.source);
        if (!this.compaction) return undefined;
        if (this.compaction.cancellation) return this.compactionProjection();
        if (this.compaction.hidden && !this.compaction.hidden.summary) {
          this.compaction.hidden.boundary = { source: command.source, messageUuid: command.boundary };
          return this.compactionProjection();
        }
        return this.completeCompaction("completed", undefined, null, command.source, command.boundary);
      case "postCompact": {
        if (command.runtimeGeneration !== this.runtimeGeneration || command.trigger !== "manual"
          || !this.compaction?.hidden) return undefined;
        this.compaction.hidden.summary = command.summary;
        const boundary = this.compaction.hidden.boundary;
        return boundary
          ? this.completeCompaction("completed", undefined, null, boundary.source, boundary.messageUuid)
          : this.compactionProjection();
      }
      case "compactFailed":
        if (command.runtimeGeneration !== this.runtimeGeneration || !this.compaction) return undefined;
        if (this.compaction.cancellation) return this.compactionProjection();
        return this.completeCompaction("failed", command.message, command.codexErrorInfo, command.source);
      case "compactWatchdogFired": {
        if (command.operationId !== this.compaction?.operationId || this.compaction.cancellation) return undefined;
        return this.requestCompactionCancellation({
          status: "failed", errorInfo: "other",
          message: "Claude compaction did not reach a terminal provider boundary within 15 minutes.",
        }, true);
      }
      case "interruptCompaction": return this.interruptCompaction(command.turnId);
      case "compactTransportCancelled": {
        if (command.runtimeGeneration !== this.runtimeGeneration
          || command.operationId !== this.compaction?.operationId
          || command.messageUuid !== this.compaction.messageUuid
          || !this.compaction.cancellation) {
          return this.compaction ? this.compactionProjection() : undefined;
        }
        const { status, message, errorInfo } = this.compaction.cancellation;
        return this.completeCompaction(status, message, errorInfo,
          { providerEventId: null, providerEventType: "runtime_cancelled" });
      }
      case "compactRuntimeExited": {
        if (command.runtimeGeneration !== this.runtimeGeneration || !this.compaction) return undefined;
        const terminal = this.compaction.cancellation
          ?? { status: "failed" as const, message: command.message, errorInfo: "other" as const };
        return this.completeCompaction(terminal.status, terminal.message, terminal.errorInfo,
          { providerEventId: null, providerEventType: "runtime_exited" });
      }
    }
  }

  private startShell(command: string): StartedShellCommand {
    const record = this.requireRecord(true);
    if (this.repository.archived(this.threadId)
      || this.adminOperation && this.adminOperation.kind !== "rename") {
      throw invalidParams(`Claude thread '${this.threadId}' is unavailable for a shell command.`);
    }
    if (this.shell || this.lifecycle || this.compaction || record.thread.status.type === "active"
      || record.thread.turns.some((turn) => turn.status === "inProgress")) {
      throw invalidParams("Cannot run a thread shell command during an active Claude turn.");
    }
    invalidateGoalEffect(this.goal);
    const item: Extract<ThreadItem, { type: "commandExecution" }> = {
      type: "commandExecution",
      id: uuidv7(),
      command,
      cwd: record.thread.cwd,
      processId: null,
      source: "userShell",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: "",
      exitCode: null,
      durationMs: null,
    };
    const { turn } = this.startTurn([item]);
    const operationId = uuidv7();
    let resolve!: () => void;
    const done = new Promise<void>((settled) => { resolve = settled; });
    this.shell = {
      operationId,
      turnId: turn.id,
      itemId: item.id,
      startedAtMs: Date.now(),
      done,
      resolve,
      cancelling: false,
    };
    this.announceTurn(turn, false);
    this.emitLifecycle();
    return { operationId, turnId: turn.id, cwd: record.thread.cwd };
  }

  private runShell(command: string): Promise<void> {
    const started = this.startShell(command);
    const shell = this.shell!;
    let processHandle!: ShellProcess;
    try {
      processHandle = this.shellRunner.launch(started.cwd, command, {
        ready: () => {
          void this.submit<boolean>({
            type: "admitShellEffect",
            operationId: started.operationId,
          }).then((admitted) => {
            if (!admitted) processHandle.kill();
          }, () => processHandle.kill());
        },
        output: (bytes) => {
          void this.submit({
            type: "shellOutput",
            operationId: started.operationId,
            delta: bytes.toString(),
          }).catch(() => undefined);
        },
        terminal: (exitCode, errorMessage) => {
          void this.submit({
            type: "finishShell",
            operationId: started.operationId,
            exitCode,
            ...(errorMessage ? { errorMessage } : {}),
          }).catch(() => shell.resolve());
        },
      });
      shell.process = processHandle;
    } catch (error) {
      this.finishShell(started.operationId, 1, String(error));
    }
    return shell.done;
  }

  private admitShellEffect(operationId: string): boolean {
    const shell = this.shell;
    if (!shell || shell.operationId !== operationId || shell.cancelling || !shell.process) return false;
    shell.process.start();
    return true;
  }

  private appendShellOutput(operationId: string, delta: string): boolean {
    const shell = this.shell;
    if (!shell || shell.operationId !== operationId || shell.cancelling || !delta) return false;
    const turn = this.repository.readTurn(this.threadId, shell.turnId);
    const item = turn?.items.find((candidate) => candidate.id === shell.itemId);
    if (!turn || item?.type !== "commandExecution" || turn.status !== "inProgress") return false;
    const updatedItem = {
      ...item,
      aggregatedOutput: `${item.aggregatedOutput ?? ""}${delta}`,
    };
    const updatedTurn = {
      ...turn,
      items: turn.items.map((candidate) => candidate.id === item.id ? updatedItem : candidate),
    };
    this.publishTurn(updatedTurn, "item/commandExecution/outputDelta", {
      threadId: this.threadId,
      turnId: turn.id,
      itemId: item.id,
      delta,
    }, nullSource);
    return true;
  }

  private finishShell(operationId: string, exitCode: number, errorMessage?: string): boolean {
    const shell = this.shell;
    if (!shell || shell.operationId !== operationId || shell.cancelling) return false;
    const active = this.repository.readTurn(this.threadId, shell.turnId);
    const item = active?.items.find((candidate) => candidate.id === shell.itemId);
    if (!active || item?.type !== "commandExecution" || active.status !== "inProgress") {
      this.shell = undefined;
      shell.resolve();
      return false;
    }
    const status = exitCode === 0 && errorMessage === undefined ? "completed" : "failed";
    const updatedItem = {
      ...item,
      status,
      exitCode,
      durationMs: Math.max(0, Date.now() - shell.startedAtMs),
    } satisfies Extract<ThreadItem, { type: "commandExecution" }>;
    const turn = this.terminalTurn(
      {
        ...active,
        items: active.items.map((candidate) => candidate.id === item.id ? updatedItem : candidate),
      },
      status,
      errorMessage ?? (status === "failed" ? `Shell command exited with code ${exitCode}.` : undefined),
      null,
    );
    this.shell = undefined;
    this.finishTurn(turn, nullSource, false, [{
      turnId: turn.id,
      method: "item/completed",
      params: {
        item: updatedItem,
        threadId: this.threadId,
        turnId: turn.id,
        completedAtMs: Date.now(),
      },
    }]);
    this.emitLifecycle();
    shell.resolve();
    return true;
  }

  private prepareShellCancellation(turnId: string | undefined): ShellCancellation | undefined {
    const shell = this.shell;
    if (!shell) {
      const turn = turnId ? this.repository.readTurn(this.threadId, turnId) : undefined;
      return turn && turn.status !== "inProgress" ? { kind: "terminal", turnId: turn.id } : undefined;
    }
    if (turnId && shell.turnId !== turnId) return undefined;
    const active = this.repository.readTurn(this.threadId, shell.turnId);
    const item = active?.items.find((candidate) => candidate.id === shell.itemId);
    if (!active || item?.type !== "commandExecution" || active.status !== "inProgress") {
      this.shell = undefined;
      shell.resolve();
      return undefined;
    }
    if (!shell.cancelling) {
      shell.cancelling = true;
      const finalize = () => {
        void this.submit({
          type: "finalizeShellCancellation",
          operationId: shell.operationId,
        }).catch(() => shell.resolve());
      };
      if (shell.process) {
        shell.process.kill();
        void shell.process.done.then(finalize);
      } else {
        queueMicrotask(finalize);
      }
    }
    return {
      kind: "prepared",
      operationId: shell.operationId,
      turnId: shell.turnId,
    };
  }

  private cancelShell(turnId: string | undefined): Promise<ShellCancellation | undefined> | ShellCancellation | undefined {
    const cancellation = this.prepareShellCancellation(turnId);
    if (cancellation?.kind !== "prepared") return cancellation;
    return this.shell!.done.then(() => cancellation);
  }

  private finalizeShellCancellation(operationId: string): boolean {
    const shell = this.shell;
    if (!shell || shell.operationId !== operationId || !shell.cancelling) return false;
    const active = this.repository.readTurn(this.threadId, shell.turnId);
    const item = active?.items.find((candidate) => candidate.id === shell.itemId);
    if (!active || item?.type !== "commandExecution" || active.status !== "inProgress") {
      this.shell = undefined;
      shell.resolve();
      return false;
    }
    const updatedItem = {
      ...item,
      status: "failed",
      durationMs: Math.max(0, Date.now() - shell.startedAtMs),
    } satisfies Extract<ThreadItem, { type: "commandExecution" }>;
    const turn = this.terminalTurn({
      ...active,
      items: active.items.map((candidate) => candidate.id === item.id ? updatedItem : candidate),
    }, "interrupted", undefined, null);
    this.shell = undefined;
    this.finishTurn(turn, nullSource, false, [{
      turnId: turn.id,
      method: "item/completed",
      params: {
        item: updatedItem,
        threadId: this.threadId,
        turnId: turn.id,
        completedAtMs: Date.now(),
      },
    }]);
    this.emitLifecycle();
    shell.resolve();
    return true;
  }

  private startCompaction(input: string, hidden = false): StartedCompaction {
    const record = this.requireRecord(true);
    const active = record.thread.turns.findLast((turn) => turn.status === "inProgress");
    if (this.compaction || active?.items.some((item) => item.type === "contextCompaction")) {
      throw invalidParams("Claude compaction is already in progress.");
    }
    if (record.thread.status.type !== "idle" || active
      || this.repository.pendingRequests(this.threadId).length > 0) {
      throw invalidParams("Cannot compact a Claude thread while another lifecycle is active.");
    }
    if (this.runtimeGeneration === undefined) {
      throw invalidParams(`Claude thread '${this.threadId}' has no attached runtime.`);
    }
    invalidateGoalEffect(this.goal);
    this.suppressNextPostCompactHook = hidden;
    const item: Extract<ThreadItem, { type: "contextCompaction" }> = {
      type: "contextCompaction", id: uuidv7(),
    };
    const { turn } = this.startTurn([item], {}, uuidv7(), !hidden);
    const operationId = uuidv7();
    const messageUuid = uuidv7();
    const runtimeGeneration = this.runtimeGeneration;
    const watchdog = setTimeout(() => {
      void this.submit({ type: "compactWatchdogFired", operationId }).catch(() => undefined);
    }, compactionWatchdogMs);
    watchdog.unref();
    const completion = hidden ? createDeferred<string>() : undefined;
    this.compaction = {
      operationId, turnId: turn.id, messageUuid, runtimeGeneration, watchdog, transport: "pending",
      ...(completion ? { hidden: { completion } } : {}),
    };
    this.compactionActions.push({ kind: "send", operationId, messageUuid, runtimeGeneration, input });
    return { operationId, turnId: turn.id, turn, ...(completion ? { completion: completion.promise } : {}) };
  }

  private announceCompaction(operationId: string): void {
    if (this.compaction?.operationId !== operationId) return;
    const turn = this.repository.readTurn(this.threadId, this.compaction.turnId);
    if (!turn) return;
    this.announceTurn(turn, false);
    this.emitLifecycle(undefined, true);
  }

  private interruptCompaction(turnId: string | undefined): CompactionProjection | undefined {
    if (turnId && turnId !== this.compaction?.turnId) {
      const prior = this.repository.readTurn(this.threadId, turnId);
      if (prior?.status !== "inProgress") {
        return this.compaction || prior?.items.some((item) => item.type === "contextCompaction")
          ? { turnId, terminal: true } : undefined;
      }
      if (this.compaction) throw invalidParams(`Turn '${turnId}' is not active in Claude thread '${this.threadId}'.`);
    }
    if (!this.compaction) return undefined;
    if (this.compaction.cancellation) return this.compactionProjection();
    return this.requestCompactionCancellation({ status: "interrupted", errorInfo: null }, false);
  }

  private requestCompactionCancellation(
    terminal: CompactionTerminal,
    publishAction: boolean,
  ): CompactionProjection {
    const operation = this.compaction;
    if (!operation) throw new Error(`Claude thread '${this.threadId}' has no active compaction.`);
    operation.cancellation = terminal;
    clearTimeout(operation.watchdog);
    const transportAction = {
      kind: "cancel" as const,
      operationId: operation.operationId,
      messageUuid: operation.messageUuid,
      runtimeGeneration: operation.runtimeGeneration,
    };
    if (publishAction) {
      this.compactionActions.push(transportAction);
      this.emitLifecycle(undefined, true);
    }
    return this.compactionProjection(false, operation.operationId, transportAction);
  }

  private projectAutomaticCompaction(
    boundary: string, source: RuntimeFactSource,
  ): CompactionProjection | undefined {
    if (this.compaction) return this.compactionProjection();
    const record = this.requireRecord(true);
    const turn = this.activeNormalTurn(record);
    if (!turn) return undefined;
    const updated = { ...record, lastClaudeMessageUuid: boundary };
    this.commitState(updated, [{
      turnId: turn.id,
      method: "thread/compacted",
      params: { threadId: this.threadId, turnId: turn.id },
      providerEventId: source.providerEventId,
      providerEventType: source.providerEventType,
    }], turn, false, {
      ownerThreadId: this.threadId,
      turnId: turn.id,
      messageUuid: boundary,
    });
    return { turnId: turn.id, terminal: false };
  }

  private completeCompaction(
    status: "completed" | "interrupted" | "failed",
    errorMessage: string | undefined,
    codexErrorInfo: import("../../codex/generated/v2/CodexErrorInfo.js").CodexErrorInfo | null,
    source: RuntimeFactSource,
    boundary?: string,
  ): CompactionProjection | undefined {
    const operation = this.compaction;
    if (!operation) return undefined;
    const active = this.repository.readTurn(this.threadId, operation.turnId)!;
    const item = active.items[0]!;
    const turn = this.terminalTurn(active, status, errorMessage, codexErrorInfo);
    this.finishTurn(turn, source, true, [
      {
        turnId: turn.id,
        method: "item/completed",
        params: { item, threadId: this.threadId, turnId: turn.id, completedAtMs: Date.now() },
      },
      ...(status === "completed" ? [{
        turnId: turn.id,
        method: "thread/compacted",
        params: { threadId: this.threadId, turnId: turn.id },
      }] : []),
    ], status === "completed" && boundary ? {
      ownerThreadId: this.threadId,
      turnId: turn.id,
      messageUuid: boundary,
    } : undefined, !operation.hidden);
    clearTimeout(operation.watchdog);
    this.compaction = undefined;
    if (operation.hidden) {
      if (status === "completed" && operation.hidden.summary !== undefined) {
        operation.hidden.completion.resolve(operation.hidden.summary);
      } else {
        operation.hidden.completion.reject(new Error(errorMessage ?? `Claude compaction ${status}.`));
      }
    }
    this.emitLifecycle();
    return { turnId: turn.id, terminal: true, ...(operation.hidden ? { hidden: true } : {}) };
  }

  private compactionProjection(
    terminal = false,
    cancelOperationId?: string,
    transportAction?: Extract<CompactionTransportAction, { kind: "cancel" }>,
  ): CompactionProjection {
    return {
      turnId: this.compaction!.turnId,
      terminal,
      ...(this.compaction!.hidden ? { hidden: true } : {}),
      ...(cancelOperationId ? { cancelOperationId } : {}),
      ...(transportAction ? { transportAction } : {}),
    };
  }

  private activeNormalTurn(record = this.requireRecord(true)): Turn | undefined {
    return record.thread.turns.findLast((turn) =>
      turn.status === "inProgress"
      && !turn.items.some((item) => item.type === "contextCompaction"));
  }

  private startTurn(
    items: ThreadItem[],
    threadPatch: Partial<ClaudeThreadRecord["thread"]> = {},
    id = uuidv7(),
    emitEvents = true,
  ): PreparedSessionTurn {
    const record = this.requireRecord(false);
    const now = Math.floor(Date.now() / 1_000);
    const turn: Turn = {
      id, items, itemsView: "full", status: "inProgress", error: null,
      startedAt: now, completedAt: null, durationMs: null,
    };
    const updated: ClaudeThreadRecord = {
      ...record,
      thread: {
        ...record.thread, ...threadPatch, status: { type: "active", activeFlags: [] },
        updatedAt: now, recencyAt: now,
      },
    };
    const params = { threadId: this.threadId, status: updated.thread.status };
    this.commitState(updated, [{
      turnId: turn.id,
      method: "thread/status/changed",
      params,
    }], turn, true, undefined, emitEvents);
    return { record: updated, turn };
  }

  private recoverAfterRestart(statusCommandEnabled: boolean): RestartRecovery {
    const recoveredTurnIds: string[] = [];
    const abandonedProviderEventTypes: string[] = [];
    let recoveredTurnId: string | undefined;
    for (const ownerThreadId of this.repository.ownedThreadIds(this.threadId)) {
      abandonedProviderEventTypes.push(...this.repository.abandonPendingProviderEvents(
        ownerThreadId,
        "Gateway process exited after journaling this provider event but before projection completed.",
      ));
      const record = this.repository.read(ownerThreadId, true);
      if (!record) continue;
      const active = record.thread.turns.filter((turn) => turn.status === "inProgress");
      const recovered = active.map((turn) => this.recoverTurn(turn, statusCommandEnabled));
      const pendingRequests = this.repository.pendingRequests(ownerThreadId);
      for (const request of pendingRequests) {
        this.settleInteraction(request.requestId, "cancelled", { cancelled: true }, false);
      }
      if (recovered.length === 0 && record.thread.status.type !== "active") continue;
      let updated = {
        ...record,
        thread: { ...record.thread, status: { type: "systemError" as const } },
      };
      if (recovered.length === 0) {
        this.repository.update(updated);
        if (ownerThreadId === this.threadId) this.record = updated;
      }
      for (const [index, turn] of recovered.entries()) {
        updated = { ...updated, lastCompletedTurnId: turn.id };
        this.commitState(updated, [
          ...this.recoveredItemEvents(ownerThreadId, active[index]!, turn),
          {
            turnId: turn.id,
            method: "turn/completed",
            params: { threadId: ownerThreadId, turn },
          },
        ], turn);
        this.metrics.turnCompleted("failed");
        recoveredTurnIds.push(turn.id);
      }
      if (ownerThreadId === this.threadId) recoveredTurnId = recovered.at(-1)?.id;
    }
    if (recoveredTurnId) {
      dispatchGoal(this.goal, this.goalContext(), { kind: "recoverRestart", turnId: recoveredTurnId });
    }
    return { recoveredTurnIds, abandonedProviderEventTypes };
  }

  private recoverTurn(turn: Turn, statusCommandEnabled: boolean): Turn {
    const completedAt = Math.floor(Date.now() / 1_000);
    const items = turn.items.map((item) =>
      "status" in item && item.status === "inProgress"
        ? { ...item, status: "failed" } as ThreadItem
        : item);
    const user = items.find((item) => item.type === "userMessage");
    const status = statusCommandEnabled && user?.type === "userMessage" && isClaudeStatusCommand(user.content);
    const state = statusCommandEnabled && user?.type === "userMessage" && isCCodexStateCommand(user.content);
    if (status || state) {
      items.push({
        type: "agentMessage",
        id: uuidv7(),
        text: systemNoticeText(
          `Gateway restarted while the CCodex ${state ? "state" : "status"} request was active.`,
          "error",
        ),
        phase: "final_answer",
        memoryCitation: null,
      });
    }
    if (items.some((item) => item.type === "enteredReviewMode")
      && !items.some((item) => item.type === "exitedReviewMode")) {
      const output = [...items].reverse().find((item) =>
        item.type === "agentMessage" && item.text.trim()) as Extract<ThreadItem, { type: "agentMessage" }> | undefined;
      items.push({
        type: "exitedReviewMode",
        id: uuidv7(),
        review: output?.text.trim() || "Reviewer failed to output a response.",
      });
    }
    return {
      ...turn,
      items,
      status: "failed",
      completedAt,
      durationMs: turn.startedAt === null ? null : Math.max(0, (completedAt - turn.startedAt) * 1_000),
      error: {
        message: "Gateway restarted while the Claude turn was active.",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        additionalDetails: null,
      },
    };
  }

  private recoveredItemEvents(ownerThreadId: string, before: Turn, recovered: Turn): StateEvent[] {
    return recovered.items.slice(before.items.length).flatMap((item) => {
      const started = item.type === "agentMessage" ? { ...item, text: "" } : item;
      const startedEvent: StateEvent = {
        turnId: recovered.id,
        method: "item/started",
        params: { item: started, threadId: ownerThreadId, turnId: recovered.id, startedAtMs: Date.now() },
      };
      const deltaEvent: StateEvent[] = item.type === "agentMessage" ? [{
        turnId: recovered.id,
        method: "item/agentMessage/delta",
        params: { threadId: ownerThreadId, turnId: recovered.id, itemId: item.id, delta: item.text },
      }] : [];
      return [
        startedEvent,
        ...deltaEvent,
        {
          turnId: recovered.id,
          method: "item/completed",
          params: { item, threadId: ownerThreadId, turnId: recovered.id, completedAtMs: Date.now() },
        },
      ];
    });
  }

  private announceTurn(turn: Turn, completeItems: boolean): void {
    if (this.announcedTurns.has(turn.id)) return;
    this.announcedTurns.add(turn.id);
    this.publish(turn.id, "turn/started", { threadId: this.threadId, turn }, `turn/started:${turn.id}`);
    for (const item of turn.items) {
      this.publish(turn.id, "item/started", {
        item, threadId: this.threadId, turnId: turn.id, startedAtMs: Date.now(),
      }, `item/started:${item.id}`);
      if (completeItems) this.publish(turn.id, "item/completed", {
        item, threadId: this.threadId, turnId: turn.id, completedAtMs: Date.now(),
      }, `item/completed:${item.id}`);
    }
  }

  private terminalTurn(
    active: Turn, status: Turn["status"], errorMessage: string | undefined,
    codexErrorInfo: import("../../codex/generated/v2/CodexErrorInfo.js").CodexErrorInfo | null,
  ): Turn {
    const completedAt = Math.floor(Date.now() / 1_000);
    return {
      ...active, status, completedAt,
      durationMs: Math.max(0, (completedAt - (active.startedAt ?? completedAt)) * 1_000),
      error: status === "failed"
        ? { message: errorMessage ?? "Claude turn failed.", codexErrorInfo, additionalDetails: null }
        : null,
    };
  }

  private finishTurn(
    turn: Turn,
    source: RuntimeFactSource,
    emitError = true,
    terminalEvents: readonly StateEvent[] = [],
    providerBoundary?: ProviderBoundaryCommit,
    emitEvents = true,
  ): CompletedSessionTurn {
    const record = this.requireRecord(false);
    const updated: ClaudeThreadRecord = {
      ...record,
      ...(providerBoundary ? { lastClaudeMessageUuid: providerBoundary.messageUuid } : {}),
      lastCompletedTurnId: turn.id,
      thread: {
        ...record.thread, status: { type: "idle" },
        updatedAt: turn.completedAt!, recencyAt: turn.completedAt,
      },
    };
    const events: StateEvent[] = [...terminalEvents.map((event) => ({
      ...event,
      providerEventId: event.providerEventId ?? source.providerEventId,
      providerEventType: event.providerEventType ?? source.providerEventType,
    })), {
      turnId: turn.id,
      method: "thread/status/changed",
      params: { threadId: this.threadId, status: updated.thread.status },
      providerEventId: source.providerEventId,
      providerEventType: source.providerEventType,
    }];
    if (turn.error && emitError) events.push({
      turnId: turn.id,
      method: "error",
      params: {
        error: turn.error, willRetry: false, threadId: this.threadId, turnId: turn.id,
      },
      providerEventId: source.providerEventId,
      providerEventType: source.providerEventType,
    });
    events.push({
      turnId: turn.id,
      method: "turn/completed",
      params: { threadId: this.threadId, turn },
      providerEventId: source.providerEventId,
      providerEventType: source.providerEventType,
    });
    this.commitState(updated, events, turn, false, providerBoundary, emitEvents);
    return { record: updated, turn };
  }

  private goalContext(): GoalContext {
    return {
      threadId: this.threadId, repository: this.repository,
      turnId: this.scopes.get(this.threadId)?.turnId, active: Boolean(this.lifecycle),
      quiescent: this.isQuiescent(), planMode: this.planMode(),
      eligible: (!this.adminOperation || this.adminOperation.kind === "rename")
        && !this.repository.archived(this.threadId),
      runtimeGeneration: this.runtimeGeneration,
      updatePreview: (preview) => {
        const record = this.requireRecord(false);
        const updated = { ...record, thread: { ...record.thread, preview } };
        this.repository.update(updated);
        this.record = updated;
      },
      publish: (turnId, method, params, key) => this.publish(turnId, method, params, key),
      emit: (goalEffects) => goalEffects
        ? this.publishGoalEffects({
          quiescent: this.isQuiescent(),
          acceptProviderFacts: !this.interruptFence && !this.dropLateFacts,
        }, goalEffects)
        : this.emitLifecycle(undefined, true),
    };
  }

  private planMode(): boolean {
    const mode = this.requireRecord(false).collaborationMode;
    return Boolean(mode && typeof mode === "object" && "mode" in mode && mode.mode === "plan");
  }

  private validateLiveEphemeralSettings(
    before: ClaudeThreadRecord,
    candidate: ClaudeThreadRecord,
  ): void {
    if (candidate.personality !== before.personality) {
      throw invalidParams("Cannot change personality after ephemeral Claude turn preparation or model-visible input.");
    }
    if (candidate.thread.cwd !== before.thread.cwd) {
      throw invalidParams("Cannot change cwd after ephemeral Claude turn preparation or model-visible input.");
    }
    const collaborationShape = (value: unknown): unknown => {
      if (!value || typeof value !== "object") return value;
      const mode = value as { mode?: unknown; settings?: { developer_instructions?: unknown } };
      return {
        mode: mode.mode,
        developerInstructions: mode.settings?.developer_instructions,
      };
    };
    if (JSON.stringify(collaborationShape(candidate.collaborationMode))
      !== JSON.stringify(collaborationShape(before.collaborationMode))) {
      throw invalidParams(
        "Cannot change collaboration instructions after ephemeral Claude turn preparation or model-visible input.",
      );
    }
    if (JSON.stringify(candidate.outputSchema) !== JSON.stringify(before.outputSchema)) {
      throw invalidParams("Cannot change output schema after ephemeral Claude turn preparation or model-visible input.");
    }
  }

  private acceptLifecycle(fact: LifecycleFact, source: RuntimeFactSource): void {
    const active = this.lifecycle;
    if ((this.interruptFence || this.dropLateFacts)
      && fact.type !== "interruptAck" && fact.type !== "runtimeExit" && fact.type !== "sync") return;
    if (fact.type === "expectedCommand" && active) {
      active.commandId = fact.id;
      active.commandObserved = false;
      active.commandCompleted = false;
    } else if (fact.type === "command" && active) {
      if (fact.state === "queued" && active.request && fact.id) active.commandId = fact.id;
      else if (!active.commandId && fact.id) active.commandId = fact.id;
      if (active.commandId && active.commandId !== fact.id) return;
      active.commandObserved = true;
      active.commandCompleted = fact.state === "completed" || fact.state === "cancelled" || fact.state === "discarded";
      if (active.commandCompleted && active.result && this.hasNotifications()) this.scheduleContinuation();
    } else if (fact.type === "goalQueued" && active) active.goals += 1;
    else if (fact.type === "noQuery") this.pendingNoQuery += 1;
    else if (fact.type === "noQueryAck") {
      if (this.pendingNoQuery > 0) this.pendingNoQuery -= 1;
      else if (active) active.result = { status: "completed", codexErrorInfo: null };
    }
    else if (fact.type === "taskNotification" && active) {
      active.notifications += 1;
      if (active.request && !active.request.started) active.request.covers = active.notifications;
      if (active.result && (!active.commandObserved || active.commandCompleted)) this.scheduleContinuation(true);
    } else if (fact.type === "request" && active) {
      if (!fact.messageStarted && active.request?.started
        && active.notifications > active.request.covers) {
        active.request = { covers: active.notifications, started: false };
        this.cancelContinuation();
      } else if (!active.request && (this.hasNotifications() || active.result)) {
        active.request = { covers: active.notifications, started: false };
        this.cancelContinuation();
      }
      if (fact.messageStarted) {
        if (active.result && (this.hasNotifications() || active.goals > 0)) delete active.result;
        if (active.request) active.request.started = true;
        active.goalInFlight = active.goals > 0;
        this.cancelContinuation();
      }
    } else if (fact.type === "session" && active) {
      if (fact.state === "running" && active.result && active.goals > 0) active.goalInFlight = true;
      if (fact.state === "idle") {
        if (active.commandObserved) active.commandCompleted = true;
        if (this.hasNotifications() && !active.request) {
          active.acknowledged = active.notifications;
          this.cancelContinuation();
          this.settleRootMessages(active.goals === 0 && !this.hasBlockers() ? "final_answer" : "commentary", source);
        }
      }
    } else if (fact.type === "result" && active) {
      if (active.goalInFlight) { active.goals = Math.max(0, active.goals - 1); active.goalInFlight = false; }
      if (active.request) { active.acknowledged = Math.max(active.acknowledged, active.request.covers); delete active.request; }
      else if (fact.origin === "task-notification") active.acknowledged = active.notifications;
      active.result = { status: fact.status, codexErrorInfo: fact.codexErrorInfo,
        ...(fact.errorMessage ? { errorMessage: fact.errorMessage } : {}) };
      this.settleRootMessages(!this.hasNotifications() && active.goals === 0
        && !this.hasBlockers() ? "final_answer" : "commentary", source);
      if (this.hasNotifications() && (!active.commandObserved || active.commandCompleted)) this.scheduleContinuation();
    } else if (fact.type === "interrupt" && active) {
      this.interruptFence = true;
      this.disposeRuntimeOperations();
      active.result = { status: "interrupted", codexErrorInfo: null, forced: true };
      active.acknowledged = active.notifications;
      active.goals = 0;
      active.goalInFlight = false;
      delete active.request;
      this.pendingNoQuery = 0;
    } else if (fact.type === "interruptAck" || fact.type === "runtimeExit") {
      const generation = this.runtimeGeneration;
      if (fact.type === "runtimeExit" && active && !this.interruptFence) active.result = {
        status: "failed", errorMessage: fact.message, codexErrorInfo: fact.codexErrorInfo, forced: true,
      };
      this.interruptFence = false;
      this.transportStopFence = false;
      this.dropLateFacts = true;
      this.pendingNoQuery = this.pendingInputs = 0;
      this.preparedRuntimeInputs.clear();
      this.disposeRuntimeOperations();
      if (active) {
        active.commandCompleted = true;
        active.acknowledged = active.notifications;
        active.goals = 0;
        active.goalInFlight = false;
        delete active.request;
      }
      this.settleForcedScopes(source);
      if (fact.type === "runtimeExit" && generation !== undefined) {
        this.runtimeGeneration = undefined;
        runtimeDetached(this.goal, generation);
      }
    } else if (fact.type === "timer" && active?.result && this.hasNotifications()
      && fact.generation === active.notifications && fact.generation > active.diagnosed) {
      active.diagnosed = fact.generation;
      this.runtimeDependencies?.logger.warn("claude.lifecycle.notification-unacknowledged", {
        threadId: this.threadId,
        generation: fact.generation,
      });
    }
    this.maybeFinish(source, fact.type === "sync");
  }

  private maybeFinish(source: RuntimeFactSource, forceEmit = false): void {
    const active = this.lifecycle;
    if (!active?.result || !active.synthetic && (this.interruptFence || active.request || this.hasNotifications()
      || active.goals > 0 || active.goalInFlight || active.commandObserved && !active.commandCompleted
      || this.pendingNoQuery > 0 || this.pendingInputs > 0 || this.hasOutputDrains()
      || this.preparedRuntimeInputs.size > 0 || this.hasBlockers())) {
      this.emitLifecycle(undefined, forceEmit);
      return;
    }
    const state = this.scopes.get(this.threadId);
    if (!state) return;
    if (active.result.status === "completed") this.settleRootMessages("final_answer", source);
    this.projectMainStream(this.threadId, { kind: "scopeFinish", status: active.result.status,
      ...(active.result.errorMessage ? { message: active.result.errorMessage } : {}) }, source);
    this.projectMainStream(this.threadId, { kind: "finish" }, source);
    const turn = this.repository.readTurn(this.threadId, state.turnId);
    if (!turn) return;
    if (active.result.status === "completed"
      && !turn.items.some((item) => item.type === "agentMessage" && item.phase === "final_answer")) {
      const last = turn.items.findLast((item) => item.type === "agentMessage" && item.phase === "commentary");
      if (last?.type === "agentMessage") last.phase = "final_answer";
    }
    if (state.review) this.appendReviewExit(turn, source);
    const completed = this.finishTurn(this.terminalTurn(
      turn, active.result.status, active.result.errorMessage, active.result.codexErrorInfo,
    ), source, !active.synthetic);
    if (!active.synthetic) finishGoalTurn(this.goal, this.goalContext(), completed.turn);
    this.scopes.delete(this.threadId);
    this.transportStopFence = false;
    this.rootReadOnly = false;
    this.lifecycle = undefined;
    this.cancelContinuation();
    this.metrics.turnCompleted(active.result.status);
    if (active.synthetic) this.emitLifecycle(undefined, true);
    else this.emitLifecycle(completed);
  }

  private hasNotifications(): boolean {
    return Boolean(this.lifecycle && this.lifecycle.notifications > this.lifecycle.acknowledged);
  }

  private hasBlockers(): boolean {
    return [...this.tasks.values()].some((task) => !task.terminal)
      || [...this.scopes.values()].some((scope) => scope.openBlocks.size > 0
        || this.repository.pendingRequests(scope.ownerThreadId).length > 0);
  }

  private settleForcedScopes(source: RuntimeFactSource): void {
    if (!this.lifecycle) return;
    this.projectMainStream(this.threadId, {
      kind: "taskStop", reason: this.lifecycle.result?.errorMessage ?? "Claude runtime stopped.",
    }, source);
    this.projectMainStream(this.threadId, {
      kind: "scopeFinish", status: this.lifecycle.result?.status ?? "failed",
    }, source);
    for (const scope of this.scopes.values()) scope.openBlocks.clear();
    for (const scope of this.scopes.keys()) for (const request of this.repository.pendingRequests(scope))
      this.settleInteraction(request.requestId, "cancelled", { cancelled: true });
  }

  private emitLifecycle(completed?: CompletedSessionTurn, force = false): void {
    const quiescent = this.isQuiescent();
    const goalEffects = nextGoalEffects(this.goal, this.goalContext());
    if (goalEffects.length) force = true;
    if (this.compactionActions.length) force = true;
    const acceptProviderFacts = !this.interruptFence && !this.transportStopFence && !this.dropLateFacts;
    if (force || completed || quiescent !== this.lastQuiescent
      || acceptProviderFacts !== this.lastAcceptProviderFacts) {
      if (completed || quiescent && !this.lastQuiescent) this.lastActivityMs = Date.now();
      this.lastQuiescent = quiescent;
      this.lastAcceptProviderFacts = acceptProviderFacts;
      const compactionActions = this.compactionActions.splice(0);
      this.publishGoalEffects({
        ...(completed ? { completed } : {}),
        quiescent,
        acceptProviderFacts,
        ...(compactionActions.length ? { compactionActions } : {}),
      }, goalEffects);
      if (this.runtimeDependencies && quiescent) queueMicrotask(() => {
        void this.retireStaleRuntime().catch((error) => {
          this.runtimeDependencies?.logger.error("claude.runtime.retirement-failed", {
            threadId: this.threadId,
            error: String(error),
          });
        });
      });
      for (const action of this.runtimeDependencies ? compactionActions : []) queueMicrotask(() => {
        void this.executeCompactionTransport(action);
      });
    }
  }

  private publishGoalEffects(
    update: Omit<SessionLifecycleUpdate, "goalEffects">,
    effects: readonly GoalEffect[],
  ): void {
    this.onLifecycle({
      ...update,
      ...(effects.length ? { goalEffects: effects } : {}),
    });
    for (const effect of this.runtimeDependencies ? effects : []) queueMicrotask(() => {
      void this.executeGoalEffect(effect);
    });
  }

  private async executeCompactionTransport(action: CompactionTransportAction): Promise<void> {
    const owner = await this.currentRuntimeOwner();
    if (owner?.generation === action.runtimeGeneration) {
      if (action.kind === "cancel") {
        try {
          await owner.runtime.interruptOwned(new Set([action.messageUuid]));
        } catch (error) {
          this.runtimeDependencies?.logger.debug("claude.compaction.interrupt-failed", {
            threadId: this.threadId,
            error: String(error),
          });
        }
        await this.submit({
          type: "compactTransportCancelled",
          operationId: action.operationId,
          messageUuid: action.messageUuid,
          runtimeGeneration: action.runtimeGeneration,
        });
        return;
      }
      try {
        const message = await mapUserInput(
          [{ type: "text", text: action.input, text_elements: [] }],
          action.messageUuid,
        );
        if (!await this.submit<boolean>({ type: "admitCompactTransport", action })) return;
        owner.runtime.send(message);
        await this.submit({
          type: "completeCompactTransport",
          operationId: action.operationId,
          messageUuid: action.messageUuid,
          runtimeGeneration: action.runtimeGeneration,
          sent: true,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await this.submit({
          type: "completeCompactTransport",
          operationId: action.operationId,
          messageUuid: action.messageUuid,
          runtimeGeneration: action.runtimeGeneration,
          sent: false,
          errorMessage,
          codexErrorInfo: classifyClaudeRuntimeError(errorMessage),
        });
      }
      return;
    }
    if (action.kind === "cancel") {
      await this.submit({
        type: "compactTransportCancelled",
        operationId: action.operationId,
        messageUuid: action.messageUuid,
        runtimeGeneration: action.runtimeGeneration,
      }).catch(() => undefined);
      return;
    }
    await this.submit({
      type: "completeCompactTransport",
      operationId: action.operationId,
      messageUuid: action.messageUuid,
      runtimeGeneration: action.runtimeGeneration,
      sent: false,
      errorMessage: "Claude runtime became unavailable before compaction transport started.",
      codexErrorInfo: "other",
    }).catch(() => undefined);
  }

  private async executeGoalEffect(effect: GoalEffect): Promise<void> {
    try {
      if (effect.kind === "steer") {
        const owner = await this.currentRuntimeOwner();
        if (owner && (effect.runtimeGeneration === undefined
          || owner.generation === effect.runtimeGeneration)) {
          await this.injectHiddenGoalPrompt(owner, effect.prompt);
        }
        return;
      }
      if (effect.kind === "ensureRuntime") {
        if (!await this.submit<boolean>({
          type: "goal",
          command: { kind: "admitEffect", operationId: effect.operationId },
        })) return;
        const record = this.record ?? this.repository.read(this.threadId, false);
        if (!record || record.thread.ephemeral || this.repository.archived(this.threadId)) return;
        await this.ensureRuntime();
        return;
      }
      const owner = await this.currentRuntimeOwner();
      if (!owner || owner.generation !== effect.runtimeGeneration) {
        throw new Error(`Claude runtime '${this.threadId}' is unavailable for active goal work.`);
      }
      const params: TurnStartParams = {
        threadId: this.threadId,
        input: [{ type: "text", text: effect.prompt, text_elements: [] }],
      };
      const staged = await this.stageRuntimeTurn(
        owner,
        params,
        owner.transportSettings,
        owner.appliedSettingsGeneration,
      );
      try {
        const prepared = await this.submit<PreparedSessionTurn | undefined>({
          type: "prepareTurn",
          params,
          hiddenInput: true,
          stagedMessageUuid: staged.messageUuid,
          readOnly: staged.readOnly,
          goalOperation: effect,
        });
        if (!prepared) return;
        await this.submit({ type: "announceTurn", turnId: prepared.turn.id });
        await this.attachRuntimeTurn(owner, prepared.turn, staged)();
      } finally {
        await this.discardRuntimeTurn(owner, staged);
      }
    } catch (error) {
      const record = this.repository.read(this.threadId, false);
      if (this.runtimeDependencies?.isClosing() || !record || this.repository.archived(this.threadId)) return;
      this.runtimeDependencies?.logger.error("claude.goal.effect-failed", {
        threadId: this.threadId,
        effect: effect.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      if (effect.kind !== "steer") await this.submit({
        type: "goal",
        command: {
          kind: "effectFailed",
          goalId: effect.goalId,
          operationId: effect.operationId,
          ...(effect.kind === "continue" ? { runtimeGeneration: effect.runtimeGeneration } : {}),
        },
      }).catch(() => undefined);
    }
  }

  private isQuiescent(): boolean {
    return !this.lifecycle && !this.compaction && !this.interruptFence && !this.transportStopFence
      && this.pendingNoQuery === 0 && this.pendingInputs === 0 && !this.hasOutputDrains()
      && this.stagedRuntimeTurns.size === 0 && this.preparedRuntimeInputs.size === 0
      && !this.continuationTimer && !this.hasBlockers()
      && !this.requireRecord(true).thread.turns.some((turn) => turn.status === "inProgress");
  }

  private scheduleContinuation(reset = false): void {
    if (reset) this.cancelContinuation();
    if (this.continuationTimer || !this.lifecycle) return;
    const generation = this.lifecycle.notifications;
    this.continuationTimer = setTimeout(() => {
      void this.submit({ type: "lifecycle", runtimeGeneration: this.runtimeGeneration!,
        fact: { type: "timer", generation }, source: nullSource });
    }, 5_000);
    this.continuationTimer.unref();
  }

  private cancelContinuation(): void {
    if (this.continuationTimer) clearTimeout(this.continuationTimer);
    this.continuationTimer = undefined;
  }

  private settleRootMessages(phase: "commentary" | "final_answer", source: RuntimeFactSource): void {
    const state = this.scopes.get(this.threadId);
    const turn = state && this.repository.readTurn(this.threadId, state.turnId);
    if (state && turn) this.settleAgentMessages(turn, state, phase, source);
  }

  private appendReviewExit(turn: Turn, source: RuntimeFactSource): void {
    const review = [...turn.items].reverse().find((item) =>
      item.type === "agentMessage" && item.text.trim()) as Extract<ThreadItem, { type: "agentMessage" }> | undefined;
    const item: ThreadItem = {
      type: "exitedReviewMode", id: uuidv7(),
      review: review?.text.trim() || "Reviewer failed to output a response.",
    };
    turn.items.push(item);
    this.publishTurn(turn, "item/started",
      { item, threadId: this.threadId, turnId: turn.id, startedAtMs: Date.now() }, source);
    this.publishTurn(turn, "item/completed",
      { item, threadId: this.threadId, turnId: turn.id, completedAtMs: Date.now() }, source);
  }

  private settleInteraction(
    requestId: string,
    status: "resolved" | "cancelled",
    response: unknown,
    evaluateLifecycle = true,
  ): boolean {
    const request = this.repository.pendingRequest(requestId);
    if (!request || !this.repository.ownedThreadIds(this.threadId).includes(request.threadId)
      || request.status !== "pending") return false;
    this.repository.resolvePendingRequest(requestId, status, response);
    this.announcedInteractions.delete(requestId);
    this.metrics.pendingClosed(requestId);
    const waiter = this.interactionWaiters.get(requestId);
    if (waiter) {
      waiter.resolved = true;
      waiter.resolve(response);
      if (waiter.claimed) this.interactionWaiters.delete(requestId);
    }
    this.output.emit(request.threadId, "serverRequest/resolved", { threadId: request.threadId, requestId });
    this.syncInteractionStatus(request.threadId, request.turnId);
    if (evaluateLifecycle) this.maybeFinish(nullSource);
    return true;
  }

  private interactionWaiter(requestId: string) {
    const existing = this.interactionWaiters.get(requestId);
    if (existing) return existing;
    let resolve!: (response: unknown) => void;
    const waiter = {
      promise: new Promise<unknown>((done) => { resolve = done; }),
      resolve,
      claimed: false,
      resolved: false,
    };
    this.interactionWaiters.set(requestId, waiter);
    return waiter;
  }

  private dispatchThreadAdmin(command: ThreadAdminCommand): unknown {
    if (command.kind === "renameProjection") {
      const record = this.repository.read(command.threadId, false);
      if (!record?.thread.parentThreadId
        || !this.repository.ownedThreadIds(this.threadId).includes(command.threadId)) {
        throw invalidParams(`Unknown Claude subagent thread '${command.threadId}'.`);
      }
      const updated = {
        ...record,
        thread: { ...record.thread, name: command.name, updatedAt: Math.floor(Date.now() / 1_000) },
      };
      const params = { threadId: command.threadId, threadName: command.name };
      this.commitState(updated, [{ turnId: null, method: "thread/name/updated", params }]);
      return {};
    }
    if (command.kind === "beginRemoval") {
      if (this.adminOperation) {
        throw invalidParams(`Claude thread '${this.threadId}' has an active ${this.adminOperation.kind} operation.`);
      }
      const record = this.requireRecord(false);
      const operationId = uuidv7();
      this.repository.beginRemoval({
        rootThreadId: this.threadId,
        claudeSessionId: record.claudeSessionId,
        cwd: record.thread.cwd,
        kind: command.removalKind,
      });
      this.adminOperation = { operationId, kind: command.removalKind };
      return this.prepareRemoval(operationId, command.removalKind, record.claudeSessionId, record.thread.cwd);
    }
    if (command.kind === "recoverRemoval") {
      const removal = this.repository.pendingRemoval(this.threadId);
      if (!removal) throw invalidParams(`Claude thread '${this.threadId}' has no pending removal.`);
      if (this.adminOperation) {
        if (this.adminOperation.kind !== removal.kind) {
          throw invalidParams(`Claude thread '${this.threadId}' has an active ${this.adminOperation.kind} operation.`);
        }
        const prepared = {
          operationId: this.adminOperation.operationId,
          kind: removal.kind,
          claudeSessionId: removal.claudeSessionId,
          cwd: removal.cwd,
        } satisfies PreparedThreadRemoval;
        return this.afterShellCancellation(prepared);
      }
      const operationId = uuidv7();
      this.adminOperation = { operationId, kind: removal.kind };
      return this.prepareRemoval(operationId, removal.kind, removal.claudeSessionId, removal.cwd);
    }
    if (command.kind === "providerFailed") {
      const operation = this.adminOperation;
      if (!operation || operation.operationId !== command.operationId
        || operation.kind === "rename" || operation.kind === "archive") return false;
      if (command.providerAttempted) return true;
      const ownedThreadIds = this.repository.ownedThreadIds(this.threadId);
      this.repository.cancelRemoval(this.threadId);
      for (const ownedThreadId of ownedThreadIds) this.output.unsuppress(ownedThreadId);
      this.adminOperation = undefined;
      this.dropLateFacts = false;
      this.emitLifecycle(undefined, true);
      return true;
    }
    if (command.kind === "providerSucceeded") {
      const operation = this.adminOperation;
      if (!operation || operation.operationId !== command.operationId
        || operation.kind === "rename" || operation.kind === "archive") return false;
      const ownedThreadIds = this.repository.ownedThreadIds(this.threadId);
      this.repository.commitRemoval(this.threadId, ownedThreadIds);
      this.runtimeGeneration = undefined;
      this.cancelContinuation();
      this.disposeRuntimeOperations();
      this.scopes.clear();
      this.tasks.clear();
      for (const ownedThreadId of ownedThreadIds.slice(1).reverse()) {
        this.onChildRemoved(ownedThreadId);
      }
      this.record = undefined;
      this.adminOperation = undefined;
      for (const ownedThreadId of [...ownedThreadIds].reverse()) {
        this.output.unsuppress(ownedThreadId);
        if (operation.kind === "delete") this.output.threadDeleted(ownedThreadId);
      }
      return ownedThreadIds;
    }
    if (command.kind === "prepare") {
      if (this.adminOperation && this.adminOperation.kind !== "rename") {
        throw invalidParams(`Claude thread '${this.threadId}' has an active ${this.adminOperation.kind} operation.`);
      }
      const record = this.requireRecord(false);
      this.adminOperation = {
        operationId: uuidv7(),
        kind: command.operation,
        ...(command.name === undefined ? {} : { name: command.name }),
      };
      if (command.operation !== "rename") {
        this.dropLateFacts = true;
        this.disposeRuntimeOperations();
        invalidateGoalEffect(this.goal);
        for (const scope of this.repository.ownedThreadIds(this.threadId)) {
          for (const request of this.repository.pendingRequests(scope)) {
            this.settleInteraction(request.requestId, "cancelled", { cancelled: true });
          }
        }
      }
      const prepared = {
        operationId: this.adminOperation.operationId,
        record,
        providerRename: command.operation === "rename"
          && !record.thread.ephemeral
          && record.lastClaudeMessageUuid !== null,
      } satisfies PreparedThreadAdmin;
      return command.operation === "rename" ? prepared : this.afterShellCancellation(prepared);
    }
    if (command.kind === "abort") {
      const operation = this.adminOperation;
      if (!operation || operation.operationId !== command.operationId) return false;
      this.adminOperation = undefined;
      if (operation.kind !== "rename") {
        this.dropLateFacts = false;
        this.emitLifecycle(undefined, true);
      }
      return true;
    }
    if (command.kind === "finish") {
      const operation = this.adminOperation;
      if (!operation || operation.operationId !== command.operationId) return false;
      if (operation.kind === "rename") {
        const record = this.requireRecord(false);
        const updated = {
          ...record,
          thread: { ...record.thread, name: operation.name ?? "", updatedAt: Math.floor(Date.now() / 1_000) },
        };
        const params = {
          threadId: this.threadId,
          threadName: operation.name ?? "",
        };
        this.commitState(updated, [{ turnId: null, method: "thread/name/updated", params }]);
      } else if (operation.kind === "archive") {
        const ownedThreadIds = this.repository.ownedThreadIds(this.threadId);
        this.repository.commitArchived(ownedThreadIds, true);
        for (const ownedThreadId of ownedThreadIds) {
          this.output.emit(ownedThreadId, "thread/archived", { threadId: ownedThreadId });
        }
      }
      this.adminOperation = undefined;
      return true;
    }
    if (command.kind === "metadata") {
      if (this.adminOperation && this.adminOperation.kind !== "rename") {
        throw invalidParams(`Claude thread '${this.threadId}' has an active ${this.adminOperation.kind} operation.`);
      }
      const record = this.requireRecord(false);
      const previous = record.thread.gitInfo ?? { sha: null, branch: null, originUrl: null };
      const patch = command.gitInfo;
      const gitInfo = patch === null ? null : patch === undefined ? record.thread.gitInfo : {
        sha: patch.sha === undefined ? previous.sha : patch.sha,
        branch: patch.branch === undefined ? previous.branch : patch.branch,
        originUrl: patch.originUrl === undefined ? previous.originUrl : patch.originUrl,
      };
      const updated = {
        ...record,
        thread: { ...record.thread, gitInfo, updatedAt: Math.floor(Date.now() / 1_000) },
      };
      this.repository.update(updated);
      this.record = updated;
      return { thread: updated.thread };
    }
    if (this.adminOperation) {
      throw invalidParams(`Claude thread '${this.threadId}' has an active ${this.adminOperation.kind} operation.`);
    }
    const record = this.requireRecord(false);
    const ownedThreadIds = this.repository.ownedThreadIds(this.threadId);
    this.repository.commitArchived(ownedThreadIds, false);
    for (const ownedThreadId of ownedThreadIds) {
      this.output.emit(ownedThreadId, "thread/unarchived", { threadId: ownedThreadId });
    }
    this.dropLateFacts = false;
    this.emitLifecycle(undefined, true);
    return { thread: record.thread };
  }

  private prepareRemoval(
    operationId: string,
    kind: ThreadRemovalKind,
    claudeSessionId: string,
    cwd: string,
  ): PreparedThreadRemoval | Promise<PreparedThreadRemoval> {
    this.dropLateFacts = true;
    this.disposeRuntimeOperations();
    invalidateGoalEffect(this.goal);
    const ownedThreadIds = this.repository.ownedThreadIds(this.threadId);
    for (const scope of ownedThreadIds) {
      for (const request of this.repository.pendingRequests(scope)) {
        this.settleInteraction(request.requestId, "cancelled", { cancelled: true });
      }
    }
    for (const ownedThreadId of ownedThreadIds) this.output.suppress(ownedThreadId);
    const prepared = {
      operationId,
      kind,
      claudeSessionId,
      cwd,
    };
    return this.afterShellCancellation(prepared);
  }

  private afterShellCancellation<Result>(result: Result): Result | Promise<Result> {
    const cancellation = this.prepareShellCancellation(undefined);
    if (cancellation?.kind !== "prepared") return result;
    return this.shell!.done.then(() => result);
  }

  private findTool(providerId: string): SessionTool | undefined {
    for (const state of this.scopes.values()) {
      const tool = state.tools.get(providerId);
      if (tool) return tool;
    }
    return undefined;
  }

  private toolOwner(providerId: string): MainStreamState | undefined {
    return [...this.scopes.values()].find((state) => state.tools.has(providerId));
  }

  private async captureToolFileBefore(
    command: Extract<ClaudeSessionCommand, { type: "captureToolFileBefore" }>,
  ): Promise<boolean> {
    if (command.runtimeGeneration !== this.runtimeGeneration || this.interruptFence || this.dropLateFacts) return false;
    let owner = this.toolOwner(command.providerId);
    if (!owner && command.ownerProviderId) {
      owner = this.toolOwner(command.ownerProviderId);
      const task = [...this.tasks.values()].find((candidate) =>
        taskUsesProvider(candidate, command.ownerProviderId!) || candidate.taskId === command.ownerProviderId);
      if (task?.childThreadId) owner = this.scopes.get(task.childThreadId);
    }
    owner ??= this.scopes.get(this.threadId);
    if (!owner) return false;
    if (!owner.tools.has(command.providerId)) {
      this.projectMainStream(owner.ownerThreadId, {
        kind: "toolPrepare",
        providerId: command.providerId,
        name: command.toolName,
        input: command.input,
      }, nullSource);
    }
    const tool = owner.tools.get(command.providerId);
    if (!tool) return false;
    const snapshot = await snapshotFile(command.toolName, command.input, owner.record.thread.cwd);
    if (!snapshot || command.runtimeGeneration !== this.runtimeGeneration
      || this.interruptFence || this.dropLateFacts || this.findTool(command.providerId) !== tool) return false;
    tool.fileSnapshot = snapshot;
    return true;
  }

  private async captureToolFileAfter(runtimeGeneration: number, providerId: string): Promise<boolean> {
    if (runtimeGeneration !== this.runtimeGeneration || this.interruptFence || this.dropLateFacts) return false;
    const owner = this.toolOwner(providerId);
    const tool = owner?.tools.get(providerId);
    const snapshot = tool?.fileSnapshot;
    if (!owner || !tool || !snapshot) return false;
    delete tool.fileSnapshot;
    const change = await diffFile(snapshot);
    if (!change) return true;
    return Boolean(await this.submit<MainStreamProjection | undefined>({
      type: "mainStream",
      runtimeGeneration,
      ownerThreadId: owner.ownerThreadId,
      source: nullSource,
      fact: { kind: "toolFiles", providerId, changes: [change] },
    }));
  }

  private acceptHook(fact: HookFact, source: RuntimeFactSource): boolean {
    if (fact.kind === "started" && fact.hookEvent === "PostCompact" && this.suppressNextPostCompactHook) {
      this.suppressNextPostCompactHook = false;
      this.suppressedHookRuns.add(fact.hookId);
      return true;
    }
    if (this.suppressedHookRuns.has(fact.hookId)) {
      if (fact.kind === "response") this.suppressedHookRuns.delete(fact.hookId);
      return true;
    }
    if (fact.kind === "started") {
      const state = this.scopes.get(this.threadId);
      const run = startHookRun(
        fact, this.requireRecord(false).thread.cwd, Boolean(state), this.hookDisplayOrder++,
      );
      if (!run) return false;
      this.hookRuns.set(fact.hookId, run);
      const params = { threadId: this.threadId, turnId: state?.turnId ?? null, run };
      if (state) this.publishAt(this.threadId, state.turnId, "hook/started", params, source);
      else this.publish(null, "hook/started", params);
      return true;
    }
    const run = this.hookRuns.get(fact.hookId);
    if (!run) return false;
    if (fact.kind === "progress") {
      appendHookProgress(run, fact);
      return true;
    }
    completeHookRun(run, fact);
    this.hookRuns.delete(fact.hookId);
    const state = this.scopes.get(this.threadId);
    const params = { threadId: this.threadId, turnId: state?.turnId ?? null, run };
    if (state) this.publishAt(this.threadId, state.turnId, "hook/completed", params, source);
    else this.publish(null, "hook/completed", params);
    return true;
  }

  private syncInteractionStatus(ownerThreadId: string, turnId: string | null): void {
    const record = this.repository.read(ownerThreadId, false)!;
    if (record.thread.status.type !== "active") return;
    const pending = this.repository.pendingRequests(ownerThreadId);
    const activeFlags = [
      ...(pending.some((request) => request.method.includes("/requestApproval"))
        ? ["waitingOnApproval" as const]
        : []),
      ...(pending.some((request) => request.method === "item/tool/requestUserInput")
        ? ["waitingOnUserInput" as const]
        : []),
    ];
    if (activeFlags.length === record.thread.status.activeFlags.length
      && activeFlags.every((flag, index) => record.thread.status.type === "active"
        && record.thread.status.activeFlags[index] === flag)) return;
    const updated: ClaudeThreadRecord = {
      ...record,
      thread: { ...record.thread, status: { type: "active", activeFlags } },
    };
    const params = {
      threadId: ownerThreadId,
      status: updated.thread.status,
    };
    this.commitState(updated, [{ turnId, method: "thread/status/changed", params }]);
  }

  private inspectRuntime(command: Extract<ClaudeSessionCommand, { type: "inspectRuntime" }>): RuntimeInspection {
    if (command.runtimeGeneration !== this.runtimeGeneration) {
      return {
        activeTurnId: null,
        lastCompletedTurnId: null,
        modelContextWindow: null,
        interruptible: false,
        ownerThreadId: this.threadId,
        ownerTurnId: null,
        taskIds: [],
        childThreadId: null,
        taskId: null,
        quiescent: false,
        canRestartEphemeral: false,
        readOnly: false,
        lastActivityMs: this.lastActivityMs,
      };
    }
    let ownerThreadId = command.ownerThreadId ?? this.threadId;
    let targetThreadId = ownerThreadId;
    let providerTask: ScopeTask | undefined;
    if (command.providerId) {
      const scope = [...this.scopes.values()].find((candidate) => candidate.tools.has(command.providerId!));
      providerTask = [...this.tasks.values()].find((candidate) =>
        taskUsesProvider(candidate, command.providerId!) || candidate.taskId === command.providerId);
      ownerThreadId = providerTask?.ownerThreadId ?? scope?.ownerThreadId ?? ownerThreadId;
      targetThreadId = providerTask?.childThreadId ?? ownerThreadId;
    }
    const childTask = command.childThreadId
      ? [...this.tasks.values()].find((candidate) => candidate.childThreadId === command.childThreadId)
      : undefined;
    if (childTask) {
      ownerThreadId = childTask.ownerThreadId;
      targetThreadId = childTask.childThreadId!;
    }
    const ownerState = this.scopes.get(ownerThreadId);
    const targetState = this.scopes.get(targetThreadId);
    if (command.expectedTurnId && targetState?.turnId !== command.expectedTurnId) {
      const prior = this.repository.readTurn(targetThreadId, command.expectedTurnId);
      if (!prior || prior.status === "inProgress") {
        throw invalidParams(
          `Turn '${command.expectedTurnId}' is not active in Claude thread '${targetThreadId}'.`,
        );
      }
    }
    const allTasks = !command.ownerThreadId && !command.providerId && !command.childThreadId;
    const taskIds = [...this.tasks.values()]
      .filter((task) => !task.terminal && (allTasks || task.ownerThreadId === ownerThreadId))
      .map((task) => task.taskId);
    return {
      activeTurnId: this.scopes.get(this.threadId)?.turnId ?? null,
      lastCompletedTurnId: this.requireRecord(false).lastCompletedTurnId,
      modelContextWindow: this.requireRecord(false).modelContextWindow,
      interruptible: command.expectedTurnId
        ? targetState?.turnId === command.expectedTurnId
        : childTask ? !childTask.terminal && Boolean(targetState)
          : providerTask?.childThreadId ? !providerTask.terminal && Boolean(targetState)
            : Boolean(targetState),
      ownerThreadId,
      ownerTurnId: ownerState?.turnId ?? null,
      taskIds,
      childThreadId: command.providerId
        ? [...this.tasks.values()].find((task) =>
          taskUsesProvider(task, command.providerId!) || task.taskId === command.providerId)?.childThreadId ?? null
        : null,
      taskId: childTask?.taskId ?? null,
      quiescent: this.isQuiescent(),
      canRestartEphemeral: this.requireRecord(false).thread.ephemeral
        && !this.hasSubmittedRuntimeInput
        && !this.lifecycle
        && !this.compaction
        && this.stagedRuntimeTurns.size === 0
        && this.preparedRuntimeInputs.size === 0,
      readOnly: this.rootReadOnly,
      lastActivityMs: this.lastActivityMs,
    };
  }

  private appendSystemNotice(
    text: string,
    kind: "info" | "error",
    ownerThreadId: string,
    source: RuntimeFactSource,
  ): void {
    const value = systemNoticeText(text, kind);
    const active = this.scopes.get(ownerThreadId);
    if (active) {
      this.projectMainStream(ownerThreadId, { kind: "instantAgent", text: value }, source);
      return;
    }
    if (ownerThreadId !== this.threadId || !this.record) return;
    const now = Math.floor(Date.now() / 1_000);
    const timestamp = Date.now();
    const item: ThreadItem = {
      type: "agentMessage",
      id: uuidv7(),
      text: value,
      phase: null,
      memoryCitation: null,
    };
    const turn: Turn = {
      id: uuidv7(),
      items: [item],
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: now,
      completedAt: now,
      durationMs: 0,
    };
    const record = this.requireRecord(false);
    const updated = {
      ...record,
      lastCompletedTurnId: turn.id,
      thread: { ...record.thread, updatedAt: now, recencyAt: now },
    };
    const started = {
      ...turn,
      items: [],
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    this.commitState(updated, [
      { turnId: turn.id, method: "turn/started", params: { threadId: this.threadId, turn: started } },
      {
        turnId: turn.id,
        method: "item/started",
        params: {
          item: { ...item, text: "" },
          threadId: this.threadId,
          turnId: turn.id,
          startedAtMs: timestamp,
        },
      },
      {
        turnId: turn.id,
        method: "item/agentMessage/delta",
        params: { threadId: this.threadId, turnId: turn.id, itemId: item.id, delta: value },
      },
      {
        turnId: turn.id,
        method: "item/completed",
        params: { item, threadId: this.threadId, turnId: turn.id, completedAtMs: timestamp },
      },
      { turnId: turn.id, method: "turn/completed", params: { threadId: this.threadId, turn } },
    ], turn, true);
  }

  private projectMainStream(
    ownerThreadId: string, fact: MainStreamFact, source: RuntimeFactSource,
  ): MainStreamProjection {
    const state = this.requireMainStreamState(ownerThreadId);
    const turn = this.repository.readTurn(ownerThreadId, state.turnId);
    if (!turn) throw new Error(`Unknown active Claude turn '${state.turnId}'.`);
    let itemIds: readonly (string | null)[] = [];
    switch (fact.kind) {
      case "messageStart":
        this.settleAgentMessages(turn, state, "commentary", source);
        state.blockItems.clear();
        state.reasoningSummaryIndices.clear();
        state.openBlocks.clear();
        state.suppressedBlocks.clear();
        break;
      case "blockStart":
        state.openBlocks.add(fact.index);
        itemIds = [this.ensureStreamItem(turn, state, fact.index, fact.block, source).id];
        break;
      case "blockDelta": {
        if (state.suppressedBlocks.has(fact.index)) break;
        const item = this.ensureStreamItem(turn, state, fact.index, fact.block, source);
        if (fact.block === "text" && item.type === "agentMessage") {
          item.text += fact.delta;
          this.publishTurn(turn, "item/agentMessage/delta", {
            threadId: state.ownerThreadId, turnId: turn.id, itemId: item.id, delta: fact.delta,
          }, source);
        } else if (fact.block === "reasoning" && item.type === "reasoning") {
          const summaryIndex = state.reasoningSummaryIndices.get(fact.index) ?? 0;
          item.summary[summaryIndex] = `${item.summary[summaryIndex] ?? ""}${fact.delta}`;
          this.publishTurn(turn, "item/reasoning/summaryTextDelta", {
            threadId: state.ownerThreadId, turnId: turn.id, itemId: item.id, delta: fact.delta, summaryIndex,
          }, source);
        }
        itemIds = [item.id];
        break;
      }
      case "blockStop":
        if (state.suppressedBlocks.delete(fact.index)) break;
        state.openBlocks.delete(fact.index);
        break;
      case "assistant":
        itemIds = this.reconcileAssistant(turn, state, fact.blocks, fact.completeAsCommentary, source);
        state.openBlocks.clear();
        break;
      case "instantAgent": {
        const item: ThreadItem = {
          type: "agentMessage",
          id: uuidv7(),
          text: fact.text,
          phase: null,
          memoryCitation: null,
        };
        turn.items.push(item);
        this.publishTurn(turn, "item/started", {
          item, threadId: state.ownerThreadId, turnId: turn.id, startedAtMs: Date.now(),
        }, source);
        this.publishTurn(turn, "item/agentMessage/delta", {
          threadId: state.ownerThreadId, turnId: turn.id, itemId: item.id, delta: fact.text,
        }, source);
        this.completeStreamItem(turn, state, item.id, source);
        itemIds = [item.id];
        break;
      }
      case "settle":
        this.settleAgentMessages(turn, state, fact.phase, source);
        break;
      case "finish":
        for (const itemId of new Set(state.blockItems.values())) {
          const item = turn.items.find((candidate) => candidate.id === itemId);
          if (item?.type === "agentMessage" || item?.type === "reasoning") {
            this.completeStreamItem(turn, state, itemId, source);
          }
        }
        break;
      case "toolStart": case "toolInput": case "toolPrepare": case "toolBegin":
      case "toolFiles": case "toolComplete": case "toolProgress": case "evict":
      case "scopeFinish":
        return this.projectToolFact(turn, state, fact, source);
      case "taskStart": case "taskProgress": case "taskMembership": case "taskOutput":
      case "taskComplete": case "taskStop": case "inspect":
        return this.projectTaskFact(turn, state, fact, source);
    }
    return scopeProjection(turn, { itemIds });
  }

  private projectToolFact(
    turn: Turn, state: MainStreamState,
    fact: Extract<MainStreamFact, { kind: `tool${string}` | "evict" | "scopeFinish" | "inspect" }>,
    source: RuntimeFactSource,
  ): MainStreamProjection {
    let tool = "providerId" in fact ? state.tools.get(fact.providerId) : undefined;
    if (fact.kind === "toolStart") {
      const name = typeof fact.block.name === "string" ? fact.block.name : "";
      if (name.startsWith("mcp__ccodex_goal__")) {
        state.suppressedBlocks.add(fact.index);
        return scopeProjection(turn);
      }
      const id = typeof fact.block.id === "string" ? fact.block.id : `claude-tool-${fact.index}`;
      tool = state.tools.get(id);
      if (!tool) {
        const created = startTool(fact.index, fact.block, state.record.thread.cwd, state.ownerThreadId);
        tool = created.state; state.tools.set(tool.providerId, tool); turn.items.push(created.item);
      }
      state.blockItems.set(fact.index, tool.itemId);
      if (fact.block.input && typeof fact.block.input === "object") {
        this.updateTool(turn, state, tool, fact.block.input as Record<string, unknown>, source);
      }
      this.beginTool(turn, state, tool, false, source);
    } else if (fact.kind === "toolInput" && state.suppressedBlocks.has(fact.index)) {
      return scopeProjection(turn);
    } else if (fact.kind === "toolPrepare") {
      if (!tool) {
        const created = startTool(turn.items.length, {
          type: "tool_use", id: fact.providerId, name: fact.name, input: fact.input,
        }, state.record.thread.cwd, state.ownerThreadId);
        tool = created.state; state.tools.set(tool.providerId, tool); turn.items.push(created.item);
      }
      this.updateTool(turn, state, tool, fact.input, source);
    } else if (fact.kind === "toolInput") {
      tool = toolAt(state, fact.index);
      if (tool) {
        tool.partialInput += fact.delta;
        try { this.updateTool(turn, state, tool, JSON.parse(tool.partialInput) as Record<string, unknown>, source); }
        catch { /* Partial provider JSON. */ }
      }
    } else if (fact.kind === "toolBegin" && tool) {
      this.beginTool(turn, state, tool, true, source);
    } else if (fact.kind === "toolFiles" && tool) {
      const item = turn.items.find((candidate) => candidate.id === tool!.itemId);
      if (item?.type === "fileChange") {
        item.changes = fact.changes;
        this.publishTurn(turn, "item/fileChange/patchUpdated", {
          threadId: state.ownerThreadId, turnId: turn.id, itemId: item.id, changes: item.changes,
        }, source);
        this.publishTurn(turn, "turn/diff/updated", {
          threadId: state.ownerThreadId, turnId: turn.id,
          diff: turn.items.flatMap((candidate) => candidate.type === "fileChange"
            ? candidate.changes.map((change) => change.diff) : []).join("\n"),
        }, source);
      }
    } else if (fact.kind === "toolComplete" && tool) {
      this.completeTool(turn, state, tool, fact.output, fact.isError, fact.result, source);
    } else if (fact.kind === "toolProgress" && tool) {
      const item = turn.items.find((candidate) => candidate.id === tool!.itemId);
      if (item?.type === "commandExecution") item.durationMs = fact.elapsedMs;
      else if (item?.type === "mcpToolCall") this.publishTurn(turn, "item/mcpToolCall/progress", {
        threadId: state.ownerThreadId, turnId: turn.id, itemId: item.id,
        message: fact.message ?? `${tool.name} running (${(fact.elapsedMs / 1_000).toFixed(1)}s)`,
      }, source);
      else if (item?.type === "collabAgentToolCall" && fact.message) {
        const child = item.receiverThreadIds[0];
        if (child) item.agentsStates[child] = { status: "running", message: fact.message };
      }
    } else if (fact.kind === "evict") {
      const ids = new Set(fact.itemIds);
      turn.items = turn.items.filter((item) => !ids.has(item.id));
      this.evictProjectedItems(state, ids);
    } else if (fact.kind === "scopeFinish") {
      for (const candidate of state.tools.values()) if (!state.completedItems.has(candidate.itemId)) {
        this.completeTool(turn, state, candidate, fact.message ?? "Claude scope ended before the tool returned.",
          fact.status !== "completed", undefined, source);
      }
    }
    this.repository.updateTurn(state.ownerThreadId, turn);
    return scopeProjection(turn, { tool });
  }

  private evictProjectedItems(state: MainStreamState, itemIds: ReadonlySet<string>): void {
    for (const [index, id] of state.blockItems) if (itemIds.has(id)) state.blockItems.delete(index);
    for (const [id, candidate] of state.tools) if (itemIds.has(candidate.itemId)) state.tools.delete(id);
    for (const [id, task] of this.tasks) if (itemIds.has(task.itemId)) {
      this.stopBackgroundTailer(task);
      this.tasks.delete(id);
    }
  }

  private ensureBackgroundTailer(task: ScopeTask, outputFile: string): void {
    task.outputFile = outputFile;
    if (task.outputTailer) return;
    const runtimeGeneration = this.runtimeGeneration;
    if (runtimeGeneration === undefined || task.terminal) return;
    const tailer: NonNullable<ScopeTask["outputTailer"]> = {
      runtimeGeneration,
      decoder: new TextDecoder(),
      offset: 0,
      timer: setInterval(() => {
        void this.drainBackgroundOutput(task.taskId).catch(() => undefined);
      }, 250),
      stopped: false,
    };
    tailer.timer.unref();
    task.outputTailer = tailer;
    void this.drainBackgroundOutput(task.taskId).catch(() => undefined);
  }

  private async drainBackgroundOutput(taskId: string, final = false): Promise<void> {
    const task = this.tasks.get(taskId);
    const tailer = task?.outputTailer;
    if (!task || !tailer || tailer.stopped || !task.outputFile) return;
    if (tailer.reading) {
      const reading = tailer.reading;
      await reading;
      if (tailer.reading === reading) tailer.reading = undefined;
      if (final) await this.drainBackgroundOutput(taskId, true);
      return;
    }
    const reading = (async () => {
      tailer.offset = await this.backgroundOutputReader(task.outputFile!, tailer.offset, async (bytes) => {
        const delta = tailer.decoder.decode(bytes, { stream: true });
        if (!delta || tailer.stopped) return;
        await this.submit({
          type: "mainStream",
          runtimeGeneration: tailer.runtimeGeneration,
          ownerThreadId: task.ownerThreadId,
          source: { providerEventId: null, providerEventType: "background_output" },
          fact: { kind: "taskOutput", taskId, delta },
        });
      });
      if (final && !tailer.stopped) {
        const delta = tailer.decoder.decode();
        if (delta) await this.submit({
          type: "mainStream",
          runtimeGeneration: tailer.runtimeGeneration,
          ownerThreadId: task.ownerThreadId,
          source: { providerEventId: null, providerEventType: "background_output" },
          fact: { kind: "taskOutput", taskId, delta },
        });
      }
    })();
    tailer.reading = reading;
    try {
      await reading;
    } finally {
      if (tailer.reading === reading) tailer.reading = undefined;
    }
    if (final) this.stopBackgroundTailer(task);
  }

  private async completeTaskAfterOutputDrain(
    runtimeGeneration: number,
    ownerThreadId: string,
    fact: Extract<MainStreamFact, { kind: "taskComplete" }>,
    source: RuntimeFactSource,
  ): Promise<MainStreamProjection | undefined> {
    const task = this.tasks.get(fact.taskId);
    if (!task || task.terminal) return undefined;
    if (fact.outputFile) this.ensureBackgroundTailer(task, fact.outputFile);
    await this.drainBackgroundOutput(fact.taskId, true);
    return this.submit<MainStreamProjection | undefined>({
      type: "mainStream",
      runtimeGeneration,
      ownerThreadId,
      source,
      fact: { ...fact, outputDrained: true },
    });
  }

  private stopBackgroundTailer(task: ScopeTask): void {
    const tailer = task.outputTailer;
    if (!tailer) return;
    tailer.stopped = true;
    clearInterval(tailer.timer);
    delete task.outputTailer;
  }

  private disposeRuntimeOperations(): void {
    for (const task of this.tasks.values()) this.stopBackgroundTailer(task);
    for (const state of this.scopes.values()) {
      for (const tool of state.tools.values()) delete tool.fileSnapshot;
    }
    this.hookRuns.clear();
    this.suppressedHookRuns.clear();
    this.suppressNextPostCompactHook = false;
  }

  private cancelRuntimeInjections(runtimeGeneration: number, reason: string): string[] {
    const cancelled: string[] = [];
    for (let index = this.runtimeInjections.length - 1; index >= 0; index -= 1) {
      const operation = this.runtimeInjections[index]!;
      if (operation.runtimeGeneration !== runtimeGeneration) continue;
      this.runtimeInjections.splice(index, 1);
      cancelled.push(operation.messageUuid);
      if (operation.admitted && this.runtimeGeneration === runtimeGeneration) {
        this.acceptLifecycle({ type: "noQueryAck" }, nullSource);
      }
      operation.acknowledgement?.settle({ ok: false, error: new Error(reason) });
    }
    return cancelled.reverse();
  }

  private hasOutputDrains(): boolean {
    return [...this.tasks.values()].some((task) => task.outputTailer !== undefined);
  }

  private projectTaskFact(
    turn: Turn, state: MainStreamState,
    fact: Extract<MainStreamFact, { kind: `task${string}` | "inspect" }>,
    source: RuntimeFactSource,
  ): MainStreamProjection {
    let task = "taskId" in fact ? this.tasks.get(fact.taskId) : undefined;
    let childThread: ClaudeThreadRecord["thread"] | null = null;
    let handled = true;
    let taskIds: string[] = [];
    if (fact.kind === "taskStart") {
      const tool = fact.providerId ? state.tools.get(fact.providerId) : undefined;
      const existing = tool && turn.items.find((item) => item.id === tool.itemId);
      const subagent = Boolean(fact.subagentType) || fact.taskType === "agent" || fact.taskType === "subagent";
      if (!task && !existing && !subagent) {
        const providerId = fact.providerId ?? fact.taskId;
        task = { taskId: fact.taskId, ownerThreadId: state.ownerThreadId,
          itemId: `claude-task:${fact.taskId}`, providerId, providerIds: new Set([providerId]),
          turnId: turn.id, childThreadId: undefined, outputFile: fact.outputFile, terminal: false };
        this.tasks.set(task.taskId, task);
      }
      if (!task && (existing || subagent)) {
        const item: ThreadItem = existing ?? {
          type: "collabAgentToolCall", id: fact.providerId ?? `claude-task:${uuidv7()}`, tool: "spawnAgent",
          status: "inProgress", senderThreadId: state.ownerThreadId, receiverThreadIds: [],
          prompt: fact.prompt ?? fact.description, model: null, reasoningEffort: null, agentsStates: {},
        };
        const providerId = fact.providerId ?? item.id;
        const createdTask: ScopeTask = { taskId: fact.taskId, ownerThreadId: state.ownerThreadId, itemId: item.id,
          providerId, providerIds: new Set([providerId]), turnId: turn.id, childThreadId: undefined,
          outputFile: fact.outputFile, terminal: false };
        task = createdTask; this.tasks.set(createdTask.taskId, createdTask);
        if (!existing) {
          turn.items.push(item);
          this.publishTurn(turn, "item/started", {
            item, threadId: state.ownerThreadId, turnId: turn.id, startedAtMs: Date.now(),
          }, source);
        }
        if (subagent && item.type === "collabAgentToolCall") {
          const requestedModel = typeof tool?.input.model === "string" ? tool.input.model : undefined;
          childThread = this.createChildScope(state.ownerThreadId, fact, source, requestedModel);
          task.childThreadId = childThread.id; item.receiverThreadIds = [childThread.id];
          item.agentsStates = { [childThread.id]: { status: "running", message: fact.description } };
        }
      }
      const resumed = task?.terminal && subagent && task.childThreadId && fact.providerId
        && !taskUsesProvider(task, fact.providerId);
      if (resumed && task?.childThreadId) {
        childThread = this.resumeChildScope(task.childThreadId, fact, source);
        task.terminal = false;
        task.providerId = fact.providerId!;
        task.providerIds.add(fact.providerId!);
        task.itemId = existing?.id ?? task.itemId;
        task.turnId = turn.id;
        task.outputFile = fact.outputFile;
        if (existing?.type === "collabAgentToolCall") {
          existing.receiverThreadIds = [task.childThreadId];
          existing.agentsStates = {
            [task.childThreadId]: { status: "running", message: fact.description },
          };
          if (tool) this.beginTool(turn, state, tool, true, source);
        }
      }
      if (task && tool) {
        tool.backgroundTaskId = task.taskId;
        if (task.outputFile) tool.outputFile = task.outputFile;
        const item = turn.items.find((candidate) => candidate.id === tool.itemId);
        if (fact.confirmed !== false && item?.type === "commandExecution") {
          item.processId = task.taskId;
          this.beginTool(turn, state, tool, true, source);
        }
      }
      if (task && fact.outputFile) {
        task.outputFile = fact.outputFile;
        const taskTool = state.tools.get(task.providerId);
        if (taskTool) taskTool.outputFile = fact.outputFile;
        const item = turn.items.find((candidate) => candidate.id === task!.itemId);
        if (item?.type === "commandExecution") this.ensureBackgroundTailer(task, fact.outputFile);
      }
      this.repository.updateTurn(state.ownerThreadId, turn);
      handled = Boolean(task);
    } else if (fact.kind === "taskMembership") {
      taskIds = fact.taskIds.filter((id) => this.tasks.has(id));
      handled = taskIds.length > 0;
    } else if (task) {
      const ownerState = this.scopes.get(task.ownerThreadId);
      const ownerTurn = this.repository.readTurn(task.ownerThreadId, task.turnId);
      if (!ownerState || !ownerTurn || ownerTurn.status !== "inProgress") {
        if (fact.kind === "taskComplete" && !task.terminal) {
          this.stopBackgroundTailer(task);
          task.outputFile = fact.outputFile ?? task.outputFile;
          task.terminal = true;
          if (task.childThreadId) this.finishChildScope(task.childThreadId, fact.status, fact.summary, source);
        }
        return scopeProjection(turn, {
          handled: fact.kind === "taskComplete",
          taskIds: [task.taskId],
          outputFile: task.outputFile,
          childThreadId: task.childThreadId,
          terminal: task.terminal,
        });
      }
      const item = ownerTurn.items.find((candidate) => candidate.id === task!.itemId);
      if (fact.kind === "taskProgress") {
        if (item?.type === "collabAgentToolCall") item.agentsStates[task.childThreadId ?? task.taskId] =
          { status: "running", message: fact.description };
        else if (item?.type === "commandExecution" && fact.durationMs !== undefined) item.durationMs = fact.durationMs;
        else if (item?.type === "mcpToolCall") this.publishTurn(ownerTurn, "item/mcpToolCall/progress", {
          threadId: task.ownerThreadId, turnId: ownerTurn.id, itemId: item.id,
          message: fact.description,
        }, source);
      } else if (fact.kind === "taskOutput" && item?.type === "commandExecution" && !task.terminal) {
        const aggregate = `${item.aggregatedOutput ?? ""}${fact.delta}`;
        item.aggregatedOutput = Buffer.byteLength(aggregate) <= 8 * 1_024 * 1_024 ? aggregate
          : `[CCodex retained the last 8388608 bytes of command output.]\n${Buffer.from(aggregate).subarray(-8 * 1_024 * 1_024).toString()}`;
        this.publishTurn(ownerTurn, "item/commandExecution/outputDelta", {
          threadId: task.ownerThreadId, turnId: ownerTurn.id, itemId: item.id, delta: fact.delta,
        }, source);
      } else if (fact.kind === "taskComplete" && !task.terminal) {
        this.stopBackgroundTailer(task);
        task.outputFile = fact.outputFile ?? task.outputFile; task.terminal = true;
        const tool = ownerState.tools.get(task.providerId);
        if (item?.type === "commandExecution" && tool) {
          const exit = /exit code (\d+)/i.exec(fact.summary)?.[1];
          this.completeTool(ownerTurn, ownerState, tool, item.aggregatedOutput ?? "",
            fact.status !== "completed", { ...(fact.durationMs === undefined ? {} : { duration_ms: fact.durationMs }),
              ...(exit ? { exit_code: Number(exit) } : {}) }, source, false);
        } else if (item?.type === "mcpToolCall" && tool) {
          this.completeTool(ownerTurn, ownerState, tool, fact.summary, fact.status !== "completed",
            fact.durationMs === undefined ? undefined : { duration_ms: fact.durationMs }, source, false);
        } else if (item?.type === "collabAgentToolCall") {
          item.status = fact.status === "completed" ? "completed" : "failed";
          item.agentsStates[task.childThreadId ?? task.taskId] = {
            status: fact.status === "completed" ? "completed" : fact.status === "stopped" ? "interrupted" : "errored",
            message: fact.summary,
          };
          if (item.tool !== "sendInput" || !ownerState.completedItems.has(item.id)) {
            ownerState.completedItems.add(item.id);
            this.publishTurn(ownerTurn, "item/completed", {
              item, threadId: task.ownerThreadId, turnId: ownerTurn.id, completedAtMs: Date.now(),
            }, source);
          }
        }
        if (task.childThreadId) this.finishChildScope(task.childThreadId, fact.status, fact.summary, source);
      }
      this.repository.updateTurn(task.ownerThreadId, ownerTurn); taskIds = [task.taskId];
    } else if (fact.kind === "taskStop") {
      taskIds = (fact.taskIds ?? [...this.tasks.keys()]).filter((id) => {
        const candidate = this.tasks.get(id);
        if (!candidate || candidate.terminal) return false;
        this.projectTaskFact(turn, state, { kind: "taskComplete", taskId: id, status: "stopped", summary: fact.reason }, source);
        return true;
      });
      handled = taskIds.length > 0;
    } else if (fact.kind === "inspect") {
      taskIds = [...this.tasks.values()]
        .filter((candidate) => candidate.ownerThreadId === state.ownerThreadId && !candidate.terminal)
        .map((candidate) => candidate.taskId);
    } else handled = false;
    const terminals = [...this.tasks.values()].flatMap((candidate) => {
      if (candidate.terminal || candidate.ownerThreadId !== state.ownerThreadId) return [];
      const item = this.repository.readTurn(candidate.ownerThreadId, candidate.turnId)?.items
        .find((value) => value.id === candidate.itemId);
      return item?.type === "commandExecution" ? [{
        itemId: item.id, processId: candidate.taskId, command: item.command, cwd: item.cwd,
        osPid: null, cpuPercent: null, rssKb: null,
      }] : [];
    });
    return scopeProjection(turn, {
      handled, taskIds, outputFile: task?.outputFile, childThreadId: task?.childThreadId,
      childThread, terminal: task?.terminal, terminals,
      tool: task ? this.scopes.get(task.ownerThreadId)?.tools.get(task.providerId) : undefined,
    });
  }

  private projectDetachedTaskFact(
    fact: Extract<MainStreamFact, { kind: `task${string}` }>,
    source: RuntimeFactSource,
  ): MainStreamProjection | undefined {
    if (!("taskId" in fact)) return undefined;
    const task = this.tasks.get(fact.taskId);
    if (!task) return undefined;
    const turn = this.repository.readTurn(task.ownerThreadId, task.turnId);
    if (!turn) return undefined;
    if (fact.kind === "taskStart") {
      task.outputFile = fact.outputFile ?? task.outputFile;
    } else if (fact.kind === "taskComplete" && !task.terminal) {
      this.stopBackgroundTailer(task);
      task.outputFile = fact.outputFile ?? task.outputFile;
      task.terminal = true;
      if (task.childThreadId) this.finishChildScope(task.childThreadId, fact.status, fact.summary, source);
    }
    return scopeProjection(turn, {
      handled: true,
      taskIds: [task.taskId],
      outputFile: task.outputFile,
      childThreadId: task.childThreadId,
      terminal: task.terminal,
    });
  }

  private updateTool(
    turn: Turn, state: MainStreamState, tool: ActiveTool, input: Record<string, unknown>, source: RuntimeFactSource,
  ): void {
    const item = turn.items.find((candidate) => candidate.id === tool.itemId);
    if (!item) return;
    updateToolInput(item, tool, input, state.record.thread.cwd);
    if (item.type === "collabAgentToolCall" && item.tool === "sendInput") {
      const target = typeof input.to === "string" ? input.to
        : typeof input.recipient === "string" ? input.recipient : undefined;
      const task = target ? this.tasks.get(target) : undefined;
      if (task?.childThreadId) {
        item.receiverThreadIds = [task.childThreadId];
        item.agentsStates = {
          [task.childThreadId]: { status: task.terminal ? "completed" : "running", message: null },
        };
      }
    }
    if (tool.name === "TaskOutput") {
      const id = typeof input.task_id === "string" ? input.task_id
        : typeof input.taskId === "string" ? input.taskId : undefined;
      if (id && this.tasks.has(id)) {
        turn.items.splice(turn.items.indexOf(item), 1); tool.foldedTaskId = id; tool.started = true; return;
      }
    }
    this.beginTool(turn, state, tool, false, source);
  }

  private beginTool(
    turn: Turn, state: MainStreamState, tool: ActiveTool, force: boolean, source: RuntimeFactSource,
  ): void {
    const item = turn.items.find((candidate) => candidate.id === tool.itemId);
    const record = state.record;
    if (!item || tool.started || tool.foldedTaskId || isImageRead(tool, record.thread.cwd)
      || item.type === "commandExecution" && !item.command) return;
    if (item.type === "collabAgentToolCall" && item.tool === "sendInput"
      && (!item.prompt || item.receiverThreadIds.length === 0)) return;
    if (tool.name === "Bash" && tool.input.run_in_background === true && !tool.backgroundTaskId) return;
    if (!force
      && toolPolicy(tool.name, tool.input, record.thread.cwd, record.approvalPolicy, record.sandboxPolicy).decision === "ask") return;
    tool.started = true;
    this.publishTurn(turn, "item/started", {
      item, threadId: state.ownerThreadId, turnId: turn.id, startedAtMs: tool.startedAtMs,
    }, source);
    if (item.type === "plan") {
      const plan = planSteps(tool.input);
      if (plan.length) this.publishTurn(turn, "turn/plan/updated", {
        threadId: state.ownerThreadId, turnId: turn.id, explanation: null, plan,
      }, source);
    }
  }

  private completeTool(
    turn: Turn, state: MainStreamState, tool: ActiveTool, output: string, isError: boolean,
    result: Record<string, unknown> | undefined, source: RuntimeFactSource, emitOutput = true,
  ): void {
    const index = turn.items.findIndex((item) => item.id === tool.itemId);
    const item = turn.items[index];
    if (!item || state.completedItems.has(item.id)) return;
    const projection = projectToolCompletion(item, tool, output, isError, result, state.record.thread.cwd);
    turn.items[index] = projection.completed; state.completedItems.add(item.id);
    if (projection.completed.type === "collabAgentToolCall"
      && projection.completed.tool === "spawnAgent" && projection.completed.model) {
      const childThreadId = projection.completed.receiverThreadIds[0];
      const child = childThreadId ? this.repository.read(childThreadId, false) : undefined;
      if (child) this.repository.update({
        ...child,
        resolvedModel: normalizeClaudeModelIdentifier(projection.completed.model),
      });
    }
    if (!tool.started) {
      tool.started = true;
      this.publishTurn(turn, "item/started", {
        item: projection.started, threadId: state.ownerThreadId, turnId: turn.id, startedAtMs: tool.startedAtMs,
      }, source);
    }
    if (emitOutput && projection.completed.type === "commandExecution" && output) this.publishTurn(
      turn, "item/commandExecution/outputDelta",
      { threadId: state.ownerThreadId, turnId: turn.id, itemId: item.id, delta: output }, source,
    );
    this.publishTurn(turn, "item/completed", {
      item: projection.completed, threadId: state.ownerThreadId, turnId: turn.id, completedAtMs: Date.now(),
    }, source);
  }

  private createChildScope(
    parentThreadId: string, fact: Extract<MainStreamFact, { kind: "taskStart" }>, source: RuntimeFactSource,
    requestedModel?: string,
  ): ClaudeThreadRecord["thread"] {
    const parent = this.repository.read(parentThreadId, false)!;
    const normalized = requestedModel && requestedModel !== "inherit"
      ? normalizeClaudeModelIdentifier(requestedModel) : undefined;
    const model = normalized
      ? this.runtimeDependencies?.resolveChildModel?.(normalized) ?? {
          modelPickerId: `claude:${normalized}`,
          claudeModelValue: normalized,
        }
      : undefined;
    const { record, turn, item } = newChildScope(parent, parentThreadId, fact, model);
    const { thread } = record;
    const childThreadId = thread.id;
    this.repository.create(record); this.repository.createTurn(childThreadId, turn);
    this.onChildCreated(childThreadId);
    const state = newMainStreamState(childThreadId, turn.id, record);
    state.completedItems.add(item.id); this.scopes.set(childThreadId, state);
    this.publishAt(childThreadId, turn.id, "thread/started", { thread }, source);
    this.publishAt(childThreadId, turn.id, "turn/started", { threadId: childThreadId, turn }, source);
    this.publishAt(childThreadId, turn.id, "item/started",
      { item, threadId: childThreadId, turnId: turn.id, startedAtMs: Date.now() }, source);
    this.publishAt(childThreadId, turn.id, "item/completed",
      { item, threadId: childThreadId, turnId: turn.id, completedAtMs: Date.now() }, source);
    return thread;
  }

  private resumeChildScope(
    childThreadId: string,
    fact: Extract<MainStreamFact, { kind: "taskStart" }>,
    source: RuntimeFactSource,
  ): ClaudeThreadRecord["thread"] {
    const record = this.repository.read(childThreadId, false);
    if (!record) throw new Error(`Unknown Claude child thread '${childThreadId}'.`);
    const startedAt = Math.floor(Date.now() / 1_000);
    const text = fact.prompt ?? fact.description;
    const item: ThreadItem = {
      type: "userMessage", id: uuidv7(), clientId: null,
      content: [{ type: "text", text, text_elements: [] }],
    };
    const turn: Turn = {
      id: uuidv7(), items: [item], itemsView: "full", status: "inProgress", error: null,
      startedAt, completedAt: null, durationMs: null,
    };
    const updated: ClaudeThreadRecord = {
      ...record,
      thread: {
        ...record.thread,
        preview: text,
        status: { type: "active", activeFlags: [] },
        updatedAt: startedAt,
        recencyAt: startedAt,
      },
    };
    const status = { threadId: childThreadId, status: updated.thread.status };
    this.commitState(updated, [{
      turnId: turn.id,
      method: "thread/status/changed",
      params: status,
      providerEventId: source.providerEventId,
      providerEventType: source.providerEventType,
    }], turn, true);
    const state = newMainStreamState(childThreadId, turn.id, updated);
    state.completedItems.add(item.id);
    this.scopes.set(childThreadId, state);
    this.publishAt(childThreadId, turn.id, "turn/started", { threadId: childThreadId, turn }, source);
    this.publishAt(childThreadId, turn.id, "item/started", {
      item, threadId: childThreadId, turnId: turn.id, startedAtMs: Date.now(),
    }, source);
    this.publishAt(childThreadId, turn.id, "item/completed", {
      item, threadId: childThreadId, turnId: turn.id, completedAtMs: Date.now(),
    }, source);
    return updated.thread;
  }

  private finishChildScope(
    childThreadId: string, status: "completed" | "failed" | "stopped", summary: string, source: RuntimeFactSource,
  ): void {
    const state = this.scopes.get(childThreadId);
    const record = this.repository.read(childThreadId, false);
    const turn = state && this.repository.readTurn(childThreadId, state.turnId);
    if (!state || !record || !turn) return;
    if (status === "completed" && !turn.items.some((item) => item.type === "agentMessage")) {
      this.reconcileAssistant(turn, state, [{ block: "text", text: summary }], false, source);
    }
    this.settleAgentMessages(turn, state, status === "completed" ? "final_answer" : "commentary", source);
    for (const tool of state.tools.values()) if (!state.completedItems.has(tool.itemId)) {
      this.completeTool(turn, state, tool, summary || "Claude subagent stopped.", true, undefined, source);
    }
    const completedAt = Math.floor(Date.now() / 1_000);
    turn.status = status === "completed" ? "completed" : status === "stopped" ? "interrupted" : "failed";
    turn.completedAt = completedAt; turn.durationMs = Math.max(0, (completedAt - (turn.startedAt ?? completedAt)) * 1_000);
    turn.error = status === "failed" ? { message: summary, codexErrorInfo: null, additionalDetails: null } : null;
    const updated = { ...record, lastCompletedTurnId: turn.id,
      thread: { ...record.thread, status: { type: "idle" as const }, updatedAt: completedAt } };
    this.commitState(updated, [
      {
        turnId: turn.id,
        method: "thread/status/changed",
        params: { threadId: childThreadId, status: { type: "idle" } },
        providerEventId: source.providerEventId,
        providerEventType: source.providerEventType,
      },
      {
        turnId: turn.id,
        method: "turn/completed",
        params: { threadId: childThreadId, turn },
        providerEventId: source.providerEventId,
        providerEventType: source.providerEventType,
      },
    ], turn);
    this.scopes.delete(childThreadId);
  }

  private reconcileAssistant(
    turn: Turn,
    state: MainStreamState,
    blocks: readonly ({ readonly block: "text" | "reasoning"; readonly text: string } | null)[],
    completeAsCommentary: boolean,
    source: RuntimeFactSource,
  ): readonly (string | null)[] {
    return blocks.map((block, index) => {
      if (!block) return null;
      let item = streamItem(turn, state, index);
      if (block.block === "text") {
        if (!item || item.type !== "agentMessage") {
          const duplicate = turn.items.find((candidate) =>
            candidate.type === "agentMessage" && candidate.text === block.text);
          if (duplicate?.type === "agentMessage") {
            item = duplicate;
            state.blockItems.set(index, item.id);
          } else {
            item = this.ensureStreamItem(turn, state, index, "text", source);
            if (item.type === "agentMessage" && block.text) {
              item.text = block.text;
              this.publishTurn(turn, "item/agentMessage/delta", {
                threadId: state.ownerThreadId, turnId: turn.id, itemId: item.id, delta: block.text,
              }, source);
            }
          }
        }
        if (item.type === "agentMessage") {
          item.phase = completeAsCommentary ? "commentary" : null;
          if (completeAsCommentary) {
            state.pendingAgentItemIds.delete(item.id);
            this.completeStreamItem(turn, state, item.id, source);
          } else {
            state.pendingAgentItemIds.add(item.id);
            this.repository.updateTurn(state.ownerThreadId, turn);
          }
        }
        return item.id;
      }
      if (!item || item.type !== "reasoning") item = this.ensureStreamItem(turn, state, index, "reasoning", source);
      if (item.type === "reasoning") {
        const summaryIndex = state.reasoningSummaryIndices.get(index) ?? 0;
        const current = item.summary[summaryIndex] ?? "";
        const delta = block.text.startsWith(current) ? block.text.slice(current.length) : "";
        if (delta) {
          item.summary[summaryIndex] = `${current}${delta}`;
          this.publishTurn(turn, "item/reasoning/summaryTextDelta", {
            threadId: state.ownerThreadId, turnId: turn.id, itemId: item.id, delta, summaryIndex,
          }, source);
        }
      }
      this.completeStreamItem(turn, state, item.id, source);
      return item.id;
    });
  }

  private ensureStreamItem(
    turn: Turn,
    state: MainStreamState,
    index: number,
    block: "text" | "reasoning",
    source: RuntimeFactSource,
  ): ThreadItem {
    const existing = streamItem(turn, state, index);
    if (existing && (block === "text" ? existing.type === "agentMessage" : existing.type === "reasoning")) return existing;
    state.blockItems.delete(index);
    if (block === "text") {
      const item: ThreadItem = {
        type: "agentMessage", id: uuidv7(), text: "", phase: null, memoryCitation: null,
      };
      state.blockItems.set(index, item.id);
      turn.items.push(item);
      this.publishTurn(turn, "item/started", {
        item, threadId: state.ownerThreadId, turnId: turn.id, startedAtMs: Date.now(),
      }, source);
      return item;
    }
    const reusable = [...turn.items].reverse().find((item) => item.type === "reasoning"
      && !state.completedItems.has(item.id)
      && ![...state.openBlocks].some((blockIndex) => blockIndex !== index
        && state.blockItems.get(blockIndex) === item.id));
    const item: Extract<ThreadItem, { type: "reasoning" }> = reusable?.type === "reasoning"
      ? reusable
      : { type: "reasoning", id: uuidv7(), summary: [], content: [] };
    const summaryIndex = reusable ? item.summary.length : 0;
    if (reusable) item.summary.push("");
    state.blockItems.set(index, item.id);
    state.reasoningSummaryIndices.set(index, summaryIndex);
    if (!reusable) turn.items.push(item);
    this.publishTurn(turn, reusable ? "item/reasoning/summaryPartAdded" : "item/started", reusable
      ? { threadId: state.ownerThreadId, turnId: turn.id, itemId: item.id, summaryIndex }
      : { item, threadId: state.ownerThreadId, turnId: turn.id, startedAtMs: Date.now() }, source);
    return item;
  }

  private settleAgentMessages(
    turn: Turn,
    state: MainStreamState,
    phase: "commentary" | "final_answer",
    source: RuntimeFactSource,
  ): void {
    for (const itemId of state.pendingAgentItemIds) {
      const item = turn.items.find((candidate) => candidate.id === itemId);
      if (!item || item.type !== "agentMessage") continue;
      item.phase = phase;
      this.completeStreamItem(turn, state, item.id, source);
    }
    state.pendingAgentItemIds.clear();
  }

  private completeStreamItem(
    turn: Turn,
    state: MainStreamState,
    itemId: string,
    source: RuntimeFactSource,
  ): void {
    if (state.completedItems.has(itemId)) return;
    const item = turn.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    state.completedItems.add(itemId);
    this.publishTurn(turn, "item/completed", {
      item, threadId: state.ownerThreadId, turnId: turn.id, completedAtMs: Date.now(),
    }, source);
  }

  private requireMainStreamState(ownerThreadId: string): MainStreamState {
    const existing = this.scopes.get(ownerThreadId);
    if (existing) return existing;
    const record = this.repository.read(ownerThreadId, true);
    if (!record) throw new Error(`Unknown Claude scope '${ownerThreadId}'.`);
    const turn = record.thread.turns.findLast((candidate) => candidate.status === "inProgress");
    if (!turn) throw new Error(`Claude thread '${ownerThreadId}' has no active turn.`);
    const state = newMainStreamState(ownerThreadId, turn.id, record);
    this.scopes.set(ownerThreadId, state);
    return state;
  }

  private requireRecord(includeTurns: boolean): ClaudeThreadRecord {
    const record = this.repository.read(this.threadId, includeTurns);
    if (!record) throw new Error(`Unknown Claude thread '${this.threadId}'.`);
    this.record = record;
    if (this.lastPublishedUsage === undefined) this.lastPublishedUsage = this.usageKey(record);
    return record;
  }

  private usageKey(record: ClaudeThreadRecord): string | undefined {
    return record.tokenUsageLast
      ? JSON.stringify({
        total: record.tokenUsageTotal,
        last: record.tokenUsageLast,
        modelContextWindow: record.modelContextWindow,
      })
      : undefined;
  }

  private commitState(
    record: ClaudeThreadRecord,
    events: readonly StateEvent[],
    turn?: Turn,
    insertTurn = false,
    providerBoundary?: ProviderBoundaryCommit,
    emitEvents = true,
  ): void {
    const sequences = this.repository.commitState(record, events, turn, insertTurn, providerBoundary);
    if (record.thread.id === this.threadId) this.record = record;
    if (!emitEvents) return;
    events.forEach((event, index) => {
      if (sequences[index] !== 0) this.output.emit(record.thread.id, event.method, event.params);
    });
  }

  private publish(turnId: string | null, method: string, params: unknown, dedupKey?: string): void {
    const sequence = this.repository.appendEvent(this.threadId, turnId, method, params, dedupKey);
    if (sequence === 0) return;
    this.output.emit(this.threadId, method, params);
  }

  private publishTurn(turn: Turn, method: string, params: unknown, source: RuntimeFactSource): void {
    const ownerThreadId = [...this.scopes.values()].find((scope) => scope.turnId === turn.id)?.ownerThreadId
      ?? this.threadId;
    this.publishOwnedTurn(ownerThreadId, turn, method, params, source);
  }

  private publishOwnedTurn(
    ownerThreadId: string, turn: Turn, method: string, params: unknown, source: RuntimeFactSource,
  ): void {
    const sequence = this.repository.appendTurnEvent(ownerThreadId, turn, method, params, source);
    if (sequence !== 0) this.output.emit(ownerThreadId, method, params);
  }

  private publishAt(ownerThreadId: string, turnId: string, method: string, params: unknown, source: RuntimeFactSource): void {
    const turn = this.repository.readTurn(ownerThreadId, turnId)!;
    if (this.repository.appendTurnEvent(ownerThreadId, turn, method, params, source)) {
      this.output.emit(ownerThreadId, method, params);
    }
  }
}
