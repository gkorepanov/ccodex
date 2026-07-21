import type { Turn } from "../../codex/generated/v2/Turn.js";
import type { Thread } from "../../codex/generated/v2/Thread.js";
import type { ThreadItem } from "../../codex/generated/v2/ThreadItem.js";
import type { TurnStartParams } from "../../codex/generated/v2/TurnStartParams.js";
import type { CodexErrorInfo } from "../../codex/generated/v2/CodexErrorInfo.js";
import type { TokenUsageBreakdown } from "../../codex/generated/v2/TokenUsageBreakdown.js";
import type { ThreadSettings } from "../../codex/generated/v2/ThreadSettings.js";
import type { ThreadGoal } from "../../codex/generated/v2/ThreadGoal.js";
import type { ThreadGoalSetParams } from "../../codex/generated/v2/ThreadGoalSetParams.js";
import type { ThreadMetadataUpdateParams } from "../../codex/generated/v2/ThreadMetadataUpdateParams.js";
import type { JsonValue } from "../../codex/generated/serde_json/JsonValue.js";
import type {
  ClaudeThreadRecord,
  InternalGoal,
  ProviderEventDisposition,
} from "../../store/HybridStore.js";
import type { TurnProviderBoundary } from "../../store/HybridStore.js";
import type { ActiveTool } from "../toolMapper.js";
import type { ClaudeResultInput } from "../resultClassifier.js";

export interface SessionBranchSnapshot {
  readonly record: ClaudeThreadRecord;
  readonly boundaries: readonly TurnProviderBoundary[];
  readonly revision: string;
}

export interface DesiredSettingsUpdate {
  readonly record: ClaudeThreadRecord;
  readonly changed: boolean;
  readonly conflict: boolean;
  readonly replacementId?: string;
  readonly replay?: { readonly resume: boolean; readonly batches: JsonValue[][] };
  readonly retryAfter?: Promise<void>;
}

export interface PreparedSessionTurn {
  readonly record: ClaudeThreadRecord;
  readonly turn: Turn;
}

export interface RuntimeFactSource {
  readonly providerEventId: string | null;
  readonly providerEventType: string | null;
}

export interface ProviderEventAdmission {
  readonly sequence: number;
  readonly source: RuntimeFactSource;
  readonly project: boolean;
  readonly finish: boolean;
  readonly activeTurnId: string | null;
  readonly readOnly: boolean;
}

export interface RuntimeInspection {
  readonly activeTurnId: string | null;
  readonly lastCompletedTurnId: string | null;
  readonly modelContextWindow: number | null;
  readonly interruptible: boolean;
  readonly ownerThreadId: string;
  readonly ownerTurnId: string | null;
  readonly taskIds: readonly string[];
  readonly childThreadId: string | null;
  readonly taskId: string | null;
  readonly quiescent: boolean;
  readonly canRestartEphemeral: boolean;
  readonly readOnly: boolean;
  readonly lastActivityMs: number;
}

export interface RuntimeInputAction {
  readonly messageUuid: string;
  readonly turnId: string | null;
}

export interface RuntimeTransportSettings {
  readonly cwd: string;
  readonly model: string;
  readonly settingsGeneration: number;
  readonly approvalPolicy: unknown;
  readonly approvalsReviewer: string;
  readonly sandboxPolicy: unknown;
  readonly serviceTier: string | null;
  readonly reasoningEffort: string | null;
  readonly reasoningSummary: string | null;
  readonly collaborationMode: unknown | null;
}

export type RuntimeTurnStage =
  | { readonly kind: "staged" }
  | { readonly kind: "busy" }
  | {
    readonly kind: "stale";
    readonly reason: "runtime" | "settings";
    readonly settings: RuntimeTransportSettings;
  };

export type MainStreamFact =
  | { readonly kind: "messageStart" }
  | { readonly kind: "blockStart"; readonly index: number; readonly block: "text" | "reasoning" }
  | {
    readonly kind: "blockDelta";
    readonly index: number;
    readonly block: "text" | "reasoning";
    readonly delta: string;
  }
  | { readonly kind: "blockStop"; readonly index: number }
  | {
    readonly kind: "assistant";
    readonly blocks: readonly ({ readonly block: "text" | "reasoning"; readonly text: string } | null)[];
    readonly completeAsCommentary: boolean;
  }
  | { readonly kind: "instantAgent"; readonly text: string }
  | { readonly kind: "settle"; readonly phase: "commentary" | "final_answer" }
  | { readonly kind: "finish" }
  | { readonly kind: "toolStart"; readonly index: number; readonly block: Record<string, unknown> }
  | { readonly kind: "toolInput"; readonly index: number; readonly delta: string }
  | { readonly kind: "toolPrepare"; readonly providerId: string; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly kind: "toolBegin"; readonly providerId: string }
  | { readonly kind: "toolFiles"; readonly providerId: string; readonly changes: Extract<ThreadItem, { type: "fileChange" }>["changes"] }
  | { readonly kind: "toolComplete"; readonly providerId: string; readonly output: string; readonly isError: boolean;
      readonly result?: Record<string, unknown> }
  | { readonly kind: "toolProgress"; readonly providerId: string; readonly elapsedMs: number;
      readonly message?: string }
  | { readonly kind: "taskStart"; readonly taskId: string; readonly providerId?: string; readonly description: string;
      readonly prompt?: string; readonly subagentType?: string; readonly taskType?: string; readonly outputFile?: string;
      readonly confirmed?: boolean }
  | { readonly kind: "taskProgress"; readonly taskId: string; readonly description: string; readonly durationMs?: number }
  | { readonly kind: "taskMembership"; readonly taskIds: readonly string[] }
  | { readonly kind: "taskOutput"; readonly taskId: string; readonly delta: string }
  | { readonly kind: "taskComplete"; readonly taskId: string; readonly providerId?: string;
      readonly status: "completed" | "failed" | "stopped"; readonly summary: string;
      readonly outputFile?: string; readonly durationMs?: number; readonly outputDrained?: boolean }
  | { readonly kind: "taskStop"; readonly taskIds?: readonly string[]; readonly reason: string }
  | { readonly kind: "evict"; readonly itemIds: readonly string[] }
  | { readonly kind: "scopeFinish"; readonly status: "completed" | "interrupted" | "failed"; readonly message?: string }
  | { readonly kind: "inspect" };

export interface MainStreamProjection {
  readonly turn: Turn;
  readonly itemIds: readonly (string | null)[];
  readonly handled: boolean;
  readonly tool: ActiveTool | null;
  readonly taskIds: readonly string[];
  readonly outputFile: string | null;
  readonly childThreadId: string | null;
  readonly childThread: Thread | null;
  readonly terminal: boolean;
  readonly terminals: readonly {
    itemId: string; processId: string; command: string; cwd: string;
    osPid: null; cpuPercent: null; rssKb: null;
  }[];
}

export interface CompletedSessionTurn {
  readonly record: ClaudeThreadRecord;
  readonly turn: Turn;
}

export interface RestartRecovery {
  readonly recoveredTurnIds: readonly string[];
  readonly abandonedProviderEventTypes: readonly string[];
}

export type LifecycleFact =
  | { readonly type: "expectedCommand"; readonly id: string }
  | { readonly type: "command"; readonly state: "queued" | "started" | "completed" | "cancelled" | "discarded";
      readonly id: string | null }
  | { readonly type: "request"; readonly messageStarted: boolean }
  | { readonly type: "session"; readonly state: "idle" | "running" | "requires_action" }
  | { readonly type: "result"; readonly status: "completed" | "interrupted" | "failed";
      readonly errorMessage?: string; readonly codexErrorInfo: CodexErrorInfo | null; readonly origin: string | null }
  | { readonly type: "taskNotification" }
  | { readonly type: "goalQueued" }
  | { readonly type: "noQuery" | "noQueryAck" }
  | { readonly type: "interrupt" | "interruptAck" }
  | { readonly type: "runtimeExit"; readonly message: string; readonly codexErrorInfo: CodexErrorInfo | null }
  | { readonly type: "timer"; readonly generation: number }
  | { readonly type: "sync" };

export interface SessionLifecycleUpdate {
  readonly completed?: CompletedSessionTurn;
  readonly quiescent: boolean;
  readonly acceptProviderFacts: boolean;
  readonly goalEffects?: readonly GoalEffect[];
  readonly compactionActions?: readonly CompactionTransportAction[];
}

export type GoalEffect =
  | { readonly kind: "ensureRuntime"; readonly goalId: string; readonly operationId: string }
  | { readonly kind: "steer"; readonly prompt: string; readonly goalId: string; readonly runtimeGeneration?: number }
  | {
    readonly kind: "continue";
    readonly prompt: string;
    readonly goalId: string;
    readonly operationId: string;
    readonly runtimeGeneration: number;
  };

export type PreparedGoalMutation =
  | {
    readonly kind: "set";
    readonly response: { goal: ThreadGoal };
    readonly goal: InternalGoal;
    readonly objectiveChanged: boolean;
    readonly newlyBudgetLimited: boolean;
    readonly mutationId: string;
  }
  | { readonly kind: "clear"; readonly response: { cleared: boolean }; readonly mutationId: string };

export type GoalSessionCommand =
  | { readonly kind: "get" }
  | { readonly kind: "prepareSet"; readonly params: ThreadGoalSetParams }
  | { readonly kind: "prepareClear" }
  | { readonly kind: "finalize"; readonly mutation: PreparedGoalMutation }
  | { readonly kind: "resume" }
  | { readonly kind: "resumeSnapshot"; readonly reservationId: string }
  | { readonly kind: "reserveTurn" }
  | { readonly kind: "cancelTurn" }
  | { readonly kind: "usage"; readonly turnId: string; readonly eventId: string; readonly tokenDelta: number }
  | { readonly kind: "toolGet" }
  | { readonly kind: "toolCreate"; readonly objective: string; readonly tokenBudget?: number }
  | { readonly kind: "toolUpdate"; readonly status: "complete" | "blocked" }
  | { readonly kind: "detach"; readonly checkpoint: string }
  | { readonly kind: "runtimeReady"; readonly runtimeGeneration: number }
  | { readonly kind: "recoverRestart"; readonly turnId: string }
  | { readonly kind: "admitEffect"; readonly operationId: string }
  | {
    readonly kind: "effectFailed";
    readonly goalId: string;
    readonly operationId: string;
    readonly runtimeGeneration?: number;
  };

export interface SessionInteractionRequest {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly claudeRequestId: string | null;
  readonly method: string;
  readonly params: unknown;
}

export interface OpenedSessionInteraction {
  readonly requestId: string;
  readonly pending: boolean;
  readonly response: unknown | null;
}

export type ThreadRemovalKind = "delete" | "release" | "discard";
export type ThreadAdminOperation = "rename" | "archive";
export interface PreparedThreadAdmin {
  readonly operationId: string;
  readonly record: ClaudeThreadRecord;
  readonly providerRename: boolean;
}
export interface PreparedThreadRemoval {
  readonly operationId: string;
  readonly kind: ThreadRemovalKind;
  readonly claudeSessionId: string;
  readonly cwd: string;
}
export type ThreadAdminCommand =
  | { readonly kind: "prepare"; readonly operation: ThreadAdminOperation; readonly name?: string }
  | { readonly kind: "finish" | "abort"; readonly operationId: string }
  | { readonly kind: "renameProjection"; readonly threadId: string; readonly name: string }
  | { readonly kind: "beginRemoval"; readonly removalKind: ThreadRemovalKind }
  | { readonly kind: "recoverRemoval" }
  | { readonly kind: "providerSucceeded"; readonly operationId: string }
  | {
    readonly kind: "providerFailed";
    readonly operationId: string;
    readonly providerAttempted: boolean;
  }
  | { readonly kind: "metadata"; readonly gitInfo: ThreadMetadataUpdateParams["gitInfo"] }
  | { readonly kind: "unarchive" };

export interface StartedShellCommand {
  readonly operationId: string;
  readonly turnId: string;
  readonly cwd: string;
}

export interface PreparedShellCancellation {
  readonly kind: "prepared";
  readonly operationId: string;
  readonly turnId: string;
}

export type ShellCancellation =
  | PreparedShellCancellation
  | { readonly kind: "terminal"; readonly turnId: string };

export type StartedCompaction = Readonly<{
  operationId: string;
  turnId: string;
  turn: Turn;
  completion?: Promise<string>;
}>;
export type CompactionTerminal = Readonly<{
  status: "interrupted" | "failed";
  message?: string;
  errorInfo: CodexErrorInfo | null;
}>;
export type CompactionTransportAction =
  | Readonly<{
    kind: "send";
    operationId: string;
    messageUuid: string;
    runtimeGeneration: number;
    input: string;
  }>
  | Readonly<{
    kind: "cancel";
    operationId: string;
    messageUuid: string;
    runtimeGeneration: number;
  }>;
export type CompactionProjection = Readonly<{
  turnId: string;
  terminal: boolean;
  hidden?: boolean;
  cancelOperationId?: string;
  transportAction?: Extract<CompactionTransportAction, { kind: "cancel" }>;
}>;

export type HookFact =
  | Readonly<{
    kind: "started";
    hookId: string;
    hookName: string;
    hookEvent: string;
  }>
  | Readonly<{
    kind: "progress";
    hookId: string;
    output: string;
    stdout: string;
    stderr: string;
  }>
  | Readonly<{
    kind: "response";
    hookId: string;
    output: string;
    stdout: string;
    stderr: string;
    outcome: "success" | "error" | "cancelled";
    exitCode?: number;
  }>;

export type ClaudeSessionCommand =
  | {
    readonly type: "createThread";
    readonly record: ClaudeThreadRecord;
  }
  | {
    readonly type: "readThread";
    readonly includeTurns: boolean;
  }
  | { readonly type: "recoverAfterRestart"; readonly statusCommandEnabled: boolean }
  | { readonly type: "purgeStartupProjection" }
  | {
    readonly type: "snapshotBranch";
  }
  | {
    readonly type: "commitForkTarget";
    readonly record: ClaudeThreadRecord;
    readonly turns: readonly Turn[];
    readonly sourceBoundaries: readonly TurnProviderBoundary[];
    readonly uuidMap: readonly (readonly [string, string])[];
  }
  | {
    readonly type: "commitRollback";
    readonly expectedRevision: string;
    readonly replacementSessionId: string;
    readonly keepCount: number;
    readonly sourceBoundaries: readonly TurnProviderBoundary[];
    readonly uuidMap: readonly (readonly [string, string])[];
  }
  | { readonly type: "deleteBranchTarget" }
  | { readonly type: "goal"; readonly command: GoalSessionCommand }
  | {
    readonly type: "runtimeDetached";
    readonly runtimeGeneration: number;
    readonly requireQuiescent?: boolean;
    readonly ephemeralPrelude?: boolean;
  }
  | {
    readonly type: "updateDesiredSettings";
    readonly expectedGeneration: number;
    readonly candidate: ClaudeThreadRecord;
    readonly threadSettings: ThreadSettings;
  }
  | {
    readonly type: "publishThreadSettings";
    readonly threadSettings: ThreadSettings;
  }
  | {
    readonly type: "announceThread";
  }
  | {
    readonly type: "prepareTurn";
    readonly params: TurnStartParams;
    readonly review?: string;
    readonly synthetic?: "status" | "state";
    readonly hiddenInput?: boolean;
    readonly stagedMessageUuid?: string;
    readonly readOnly?: boolean;
    readonly goalOperation?: {
      readonly operationId: string;
      readonly goalId: string;
      readonly runtimeGeneration: number;
    };
  }
  | {
    readonly type: "announceTurn";
    readonly turnId: string;
  }
  | {
    readonly type: "completeSynthetic";
    readonly turnId?: string;
    readonly text?: string;
    readonly status: "completed" | "interrupted" | "failed";
    readonly errorMessage?: string;
    readonly codexErrorInfo: CodexErrorInfo | null;
  }
  | {
    readonly type: "stageInjection";
    readonly runtimeGeneration: number;
    readonly messageUuid: string;
    readonly waitForAcknowledgement: boolean;
    readonly replayablePrelude: boolean;
    readonly items: readonly JsonValue[];
  }
  | {
    readonly type: "cancelInjection";
    readonly runtimeGeneration: number;
    readonly messageUuid: string;
    readonly previous: string | null;
    readonly reason: string;
    readonly rollbackBoundary: boolean;
  }
  | {
    readonly type: "acknowledgeInjection";
    readonly runtimeGeneration: number;
    readonly source: RuntimeFactSource;
  }
  | {
    readonly type: "cancelRuntimeInjections";
    readonly runtimeGeneration: number;
    readonly reason: string;
  }
  | {
    readonly type: "providerAssistantError";
    readonly runtimeGeneration: number;
    readonly error: string;
  }
  | {
    readonly type: "classifyProviderResult";
    readonly runtimeGeneration: number;
    readonly result: ClaudeResultInput;
  }
  | {
    readonly type: "goalAssistantUsage";
    readonly runtimeGeneration: number;
    readonly turnId: string;
    readonly eventId: string;
    readonly tokens: number;
  }
  | {
    readonly type: "goalResultUsage";
    readonly runtimeGeneration: number;
    readonly turnId: string;
    readonly eventId: string;
    readonly totalTokens: number;
  }
  | {
    readonly type: "runtimeUsageSnapshot";
    readonly runtimeGeneration: number;
    readonly action: "invalidate" | "claim" | "isCurrent";
    readonly snapshot?: number;
  }
  | {
    readonly type: "attachRuntime";
    readonly runtimeGeneration: number;
  }
  | {
    readonly type: "runtimeReady";
    readonly runtimeGeneration: number;
  }
  | {
    readonly type: "runtimeFailed" | "runtimeExited";
    readonly runtimeGeneration: number;
    readonly message: string;
    readonly codexErrorInfo: CodexErrorInfo | null;
  }
  | {
    readonly type: "runtimeInitialized";
    readonly runtimeGeneration: number;
    readonly providerSessionId: string;
    readonly model: string;
    readonly cliVersion: string;
  }
  | {
    readonly type: "providerEventStarted";
    readonly runtimeGeneration: number;
    readonly processEpoch: string;
    readonly providerSequence: number;
    readonly providerEventType: string;
    readonly providerEventId: string | null;
    readonly payload: unknown;
  }
  | {
    readonly type: "providerEventFinished";
    readonly runtimeGeneration: number;
    readonly sequence: number;
    readonly source: RuntimeFactSource;
    readonly disposition: Exclude<ProviderEventDisposition, "pending">;
    readonly error?: string;
  }
  | {
    readonly type: "providerBoundary";
    readonly runtimeGeneration: number;
    readonly providerMessageId: string;
    readonly ownerThreadId?: string;
    readonly itemIds?: readonly string[];
  }
  | {
    readonly type: "providerRetract";
    readonly runtimeGeneration: number;
    readonly providerMessageIds: readonly string[];
    readonly source: RuntimeFactSource;
  }
  | {
    readonly type: "conversationReset";
    readonly runtimeGeneration: number;
    readonly providerSessionId: string;
    readonly source: RuntimeFactSource;
  }
  | {
    readonly type: "modelFallback";
    readonly runtimeGeneration: number;
    readonly model: string;
    readonly fromModel: string;
    readonly source: RuntimeFactSource;
  }
  | {
    readonly type: "systemNotice";
    readonly runtimeGeneration: number;
    readonly text: string;
    readonly noticeKind: "info" | "error";
    readonly ownerThreadId?: string;
    readonly source: RuntimeFactSource;
  }
  | {
    readonly type: "runtimeNotification";
    readonly runtimeGeneration: number;
    readonly method: string;
    readonly params: unknown;
    readonly ownerThreadId?: string;
    readonly source: RuntimeFactSource;
  }
  | {
    readonly type: "steer";
    readonly runtimeGeneration: number;
    readonly messageUuid: string;
    readonly expectedTurnId: string;
    readonly clientUserMessageId?: string | null;
    readonly input: TurnStartParams["input"];
  }
  | {
    readonly type: "stageRuntimeTurn";
    readonly runtimeGeneration: number;
    readonly settingsGeneration: number;
    readonly messageUuid: string;
  }
  | {
    readonly type: "cancelRuntimeTurnStage";
    readonly runtimeGeneration: number;
    readonly messageUuid: string;
  }
  | {
    readonly type: "prepareRuntimeInput";
    readonly runtimeGeneration: number;
    readonly messageUuid: string;
    readonly kind: "turn" | "hiddenGoal" | "noQuery";
    readonly turnId?: string;
  }
  | {
    readonly type: "completeRuntimeInput";
    readonly runtimeGeneration: number;
    readonly messageUuid: string;
    readonly sent: boolean;
  }
  | {
    readonly type: "claimRuntimeInput";
    readonly runtimeGeneration: number;
    readonly messageUuid: string;
  }
  | {
    readonly type: "fenceCurrentRuntimeStop";
    readonly expectedTurnId?: string;
  }
  | {
    readonly type: "runtimeInputQueueChanged";
    readonly runtimeGeneration: number;
    readonly pendingInputs: number;
  }
  | {
    readonly type: "inspectRuntime";
    readonly runtimeGeneration: number;
    readonly ownerThreadId?: string;
    readonly providerId?: string;
    readonly childThreadId?: string;
    readonly expectedTurnId?: string;
    readonly control?: boolean;
  }
  | {
    readonly type: "mainStream";
    readonly runtimeGeneration: number;
    readonly ownerThreadId?: string;
    readonly source: RuntimeFactSource;
    readonly fact: MainStreamFact;
  }
  | {
    readonly type: "captureToolFileBefore";
    readonly runtimeGeneration: number;
    readonly providerId: string;
    readonly ownerProviderId?: string;
    readonly toolName: string;
    readonly input: Record<string, unknown>;
  }
  | {
    readonly type: "captureToolFileAfter";
    readonly runtimeGeneration: number;
    readonly providerId: string;
  }
  | {
    readonly type: "hook";
    readonly runtimeGeneration: number;
    readonly source: RuntimeFactSource;
    readonly fact: HookFact;
  }
  | { readonly type: "disposeRuntimeOperations" }
  | {
    readonly type: "accountUsage";
    readonly runtimeGeneration: number;
    readonly aggregate: TokenUsageBreakdown;
    readonly costUsd?: number;
  }
  | {
    readonly type: "accountCost";
    readonly runtimeGeneration: number;
    readonly costUsd: number;
  }
  | {
    readonly type: "publishUsage";
    readonly runtimeGeneration: number;
    readonly turnId: string;
    readonly last: TokenUsageBreakdown;
    readonly modelContextWindow: number | null;
  }
  | { readonly type: "lifecycle"; readonly runtimeGeneration: number;
      readonly fact: LifecycleFact; readonly source: RuntimeFactSource }
  | {
    readonly type: "openInteraction";
    readonly runtimeGeneration: number;
    readonly request: SessionInteractionRequest;
  }
  | {
    readonly type: "announceInteraction";
    readonly runtimeGeneration: number;
    readonly requestId: string;
  }
  | {
    readonly type: "waitInteraction";
    readonly runtimeGeneration: number;
    readonly requestId: string;
    readonly signal?: AbortSignal;
  }
  | {
    readonly type: "resolveInteraction";
    readonly requestId: string;
    readonly response: unknown;
  }
  | {
    readonly type: "cancelInteraction";
    readonly runtimeGeneration: number;
    readonly requestId: string;
  }
  | {
    readonly type: "cancelInteractions";
    readonly runtimeGeneration: number;
    readonly ownerThreadId?: string;
  }
  | {
    readonly type: "replayInteractions";
    readonly connectionId?: string;
  }
  | { readonly type: "threadAdmin"; readonly command: ThreadAdminCommand }
  | { readonly type: "runShell"; readonly command: string }
  | { readonly type: "startShell"; readonly command: string }
  | {
    readonly type: "shellOutput";
    readonly operationId: string;
    readonly delta: string;
  }
  | {
    readonly type: "admitShellEffect";
    readonly operationId: string;
  }
  | {
    readonly type: "finishShell";
    readonly operationId: string;
    readonly exitCode: number;
    readonly errorMessage?: string;
  }
  | { readonly type: "prepareShellCancellation"; readonly turnId?: string }
  | { readonly type: "finalizeShellCancellation"; readonly operationId: string }
  | {
    readonly type: "reportError";
    readonly threadId: string;
    readonly requestedTurnId?: string;
    readonly message: string;
    readonly codexErrorInfo: CodexErrorInfo;
  }
  | { readonly type: "startCompact"; readonly input?: string; readonly deferred?: boolean; readonly hidden?: boolean }
  | { readonly type: "announceCompaction"; readonly operationId: string }
  | { readonly type: "admitCompactTransport"; readonly action: Extract<CompactionTransportAction, { kind: "send" }> }
  | { readonly type: "completeCompactTransport"; readonly operationId: string; readonly messageUuid: string;
      readonly runtimeGeneration: number; readonly sent: boolean; readonly errorMessage?: string;
      readonly codexErrorInfo?: CodexErrorInfo | null }
  | { readonly type: "admitCompactBoundary"; readonly runtimeGeneration: number; readonly trigger: string }
  | { readonly type: "compactBoundary"; readonly runtimeGeneration: number; readonly trigger: string;
      readonly boundary: string; readonly source: RuntimeFactSource }
  | { readonly type: "compactFailed"; readonly runtimeGeneration: number; readonly message: string;
      readonly codexErrorInfo: CodexErrorInfo | null; readonly source: RuntimeFactSource }
  | { readonly type: "postCompact"; readonly runtimeGeneration: number; readonly trigger: "manual" | "auto";
      readonly summary: string }
  | { readonly type: "compactWatchdogFired"; readonly operationId: string }
  | { readonly type: "interruptCompaction"; readonly turnId?: string }
  | { readonly type: "compactTransportCancelled"; readonly operationId: string; readonly messageUuid: string;
      readonly runtimeGeneration: number }
  | { readonly type: "compactRuntimeExited"; readonly runtimeGeneration: number; readonly message: string };
