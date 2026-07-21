import type { Thread } from "../codex/generated/v2/Thread.js";
import type { ThreadListParams } from "../codex/generated/v2/ThreadListParams.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import type { ThreadGoal } from "../codex/generated/v2/ThreadGoal.js";
import type { TokenUsageBreakdown } from "../codex/generated/v2/TokenUsageBreakdown.js";
import type { ApprovalsReviewer } from "../codex/generated/v2/ApprovalsReviewer.js";

export interface InternalGoal extends ThreadGoal {
  readonly goalId: string;
}

export interface GoalPatch {
  readonly objective?: string;
  readonly status?: ThreadGoal["status"];
  readonly tokenBudget?: number | null;
  readonly replace?: boolean;
  readonly now?: number;
}

export interface GoalUsageInput {
  readonly threadId: string;
  readonly expectedGoalId: string;
  readonly tokenDelta: number;
  readonly timeDeltaSeconds: number;
  readonly checkpointKey?: string;
}

export interface ClaudeThreadRecord {
  readonly thread: Thread;
  readonly claudeSessionId: string;
  readonly modelPickerId: string;
  readonly claudeModelValue: string;
  readonly serviceTier: string | null;
  readonly approvalPolicy: unknown;
  readonly approvalsReviewer: ApprovalsReviewer;
  readonly sandboxPolicy: unknown;
  readonly baseInstructions: string | null;
  readonly developerInstructions: string | null;
  readonly personality: string | null;
  readonly resolvedModel: string | null;
  readonly lastClaudeMessageUuid: string | null;
  readonly lastCompletedTurnId: string | null;
  readonly claudeCodeVersion: string | null;
  readonly reasoningEffort: string | null;
  readonly reasoningSummary: string | null;
  readonly collaborationMode: unknown | null;
  readonly outputSchema: unknown | null;
  readonly tokenUsageTotal: TokenUsageBreakdown;
  readonly tokenUsageLast: TokenUsageBreakdown | null;
  readonly modelContextWindow: number | null;
  readonly providerCostUsdTotal?: number;
  readonly settingsGeneration?: number;
}

export function settingsGeneration(record: ClaudeThreadRecord): number {
  return record.settingsGeneration ?? 0;
}

export function withSettingsFrom(
  base: ClaudeThreadRecord,
  settings: ClaudeThreadRecord,
): ClaudeThreadRecord {
  return {
    ...base,
    thread: { ...base.thread, cwd: settings.thread.cwd },
    modelPickerId: settings.modelPickerId,
    claudeModelValue: settings.claudeModelValue,
    serviceTier: settings.serviceTier,
    approvalPolicy: settings.approvalPolicy,
    approvalsReviewer: settings.approvalsReviewer,
    sandboxPolicy: settings.sandboxPolicy,
    baseInstructions: settings.baseInstructions,
    developerInstructions: settings.developerInstructions,
    personality: settings.personality,
    reasoningEffort: settings.reasoningEffort,
    reasoningSummary: settings.reasoningSummary,
    collaborationMode: settings.collaborationMode,
    outputSchema: settings.outputSchema,
    settingsGeneration: settingsGeneration(settings),
  };
}

export interface PendingRequestRecord {
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly claudeRequestId: string | null;
  readonly method: string;
  readonly params: unknown;
  readonly status: "pending" | "resolved" | "cancelled";
  readonly response: unknown | null;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
}

export interface EventPersistence {
  readonly turn?: Turn;
  readonly providerEventType?: string | null;
  readonly providerEventId?: string | null;
  readonly dedupKey?: string | null;
}

export interface StateEvent {
  readonly turnId: string | null;
  readonly method: string;
  readonly params: unknown;
  readonly providerEventType?: string | null;
  readonly providerEventId?: string | null;
}

export interface ThreadStateCommit {
  readonly record: ClaudeThreadRecord;
  readonly turn?: Turn;
  readonly insertTurn?: boolean;
  readonly providerBoundary?: ProviderBoundaryCommit;
  readonly events: readonly StateEvent[];
}

export interface TurnProviderBoundary {
  readonly turnId: string;
  readonly messageUuid: string;
}

export interface ProviderBoundaryCommit extends TurnProviderBoundary {
  readonly ownerThreadId: string;
  readonly itemIds?: readonly string[];
}

export interface PendingThreadRemoval {
  readonly rootThreadId: string;
  readonly claudeSessionId: string;
  readonly cwd: string;
  readonly kind: "delete" | "release" | "discard";
}

export interface StoredEvent {
  readonly sequence: number;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly method: string;
  readonly params: unknown;
  readonly createdAt: number;
}

export type ProviderEventDisposition =
  | "pending"
  | "projected"
  | "stateOnly"
  | "retainedOnly"
  | "abandoned"
  | "unsupportedVisible"
  | "failed";

export interface ProviderEventRecord {
  readonly sequence: number;
  readonly threadId: string;
  readonly processEpoch: string;
  readonly providerSequence: number;
  readonly providerEventType: string;
  readonly providerEventId: string | null;
  readonly payload: unknown;
  readonly disposition: ProviderEventDisposition;
  readonly error: string | null;
  readonly createdAt: number;
  readonly projectedAt: number | null;
}

export interface ProviderItemCorrelation {
  readonly providerMessageId: string;
  readonly ownerThreadId: string;
  readonly turnId: string;
  readonly itemId: string;
}

export interface ProviderRetractionMutation {
  readonly ownerThreadId: string;
  readonly turn: Turn;
  readonly clearBoundary: boolean;
}

export interface AppendProviderEvent {
  readonly threadId: string;
  readonly processEpoch: string;
  readonly providerSequence: number;
  readonly providerEventType: string;
  readonly providerEventId: string | null;
  readonly payload: unknown;
  readonly createdAt: number;
}

export interface HybridStore {
  createThread(record: ClaudeThreadRecord): void;
  hasThread(threadId: string): boolean;
  getThreadRecord(threadId: string, includeTurns?: boolean): ClaudeThreadRecord | undefined;
  allThreadRecords(): ClaudeThreadRecord[];
  listThreads(params: ThreadListParams): Thread[];
  updateThread(record: ClaudeThreadRecord): void;
  isThreadArchived(threadId: string): boolean;
  setThreadArchived(threadId: string, archived: boolean): void;
  commitThreadsArchived(threadIds: readonly string[], archived: boolean): void;
  beginThreadRemoval(removal: PendingThreadRemoval): void;
  cancelThreadRemoval(rootThreadId: string): void;
  listPendingThreadRemovals(): PendingThreadRemoval[];
  commitThreadRemoval(rootThreadId: string, threadIds: readonly string[]): void;
  deleteThread(threadId: string): void;
  createTurn(threadId: string, turn: Turn): void;
  updateTurn(threadId: string, turn: Turn): void;
  getTurn(threadId: string, turnId: string): Turn | undefined;
  listTurns(threadId: string): Turn[];
  setTurnClaudeMessageUuid(threadId: string, turnId: string, messageUuid: string): void;
  getTurnClaudeMessageUuid(threadId: string, turnId: string): string | undefined;
  truncateTurns(threadId: string, keepCount: number): void;
  commitForkedThread(record: ClaudeThreadRecord, turns: readonly Turn[], boundaries: readonly TurnProviderBoundary[]): void;
  commitThreadRollback(
    record: ClaudeThreadRecord,
    keepCount: number,
    boundaries: readonly TurnProviderBoundary[],
    removedThreadIds?: readonly string[],
  ): void;
  commitThreadState(commit: ThreadStateCommit): number[];
  appendEvent(threadId: string, turnId: string | null, method: string, params: unknown, persistence?: EventPersistence): number;
  eventHighWatermark(threadId: string): number;
  listEventsAfter(threadId: string, sequence: number): StoredEvent[];
  hasProcessedProviderEvent(threadId: string, providerEventId: string): boolean;
  markProviderEventProcessed(threadId: string, providerEventType: string, providerEventId: string): void;
  appendProviderEvent(event: AppendProviderEvent): { record: ProviderEventRecord; inserted: boolean };
  completeProviderEvent(threadId: string, sequence: number, disposition: Exclude<ProviderEventDisposition, "pending">, error?: string | null): void;
  listProviderEvents(threadId: string, disposition?: ProviderEventDisposition): ProviderEventRecord[];
  pruneProviderEvents(threadId: string, maxEvents: number, maxBytes: number): number;
  linkProviderItems(threadId: string, providerMessageId: string, ownerThreadId: string, turnId: string, itemIds: readonly string[]): void;
  listProviderItemCorrelations(threadId: string, providerMessageIds: readonly string[]): ProviderItemCorrelation[];
  deleteProviderItemCorrelations(threadId: string, providerMessageIds: readonly string[]): void;
  commitProviderRetraction(
    record: ClaudeThreadRecord,
    providerMessageIds: readonly string[],
    mutations: readonly ProviderRetractionMutation[],
    removedThreadIds?: readonly string[],
  ): void;
  createPendingRequest(request: PendingRequestRecord): void;
  getPendingRequest(requestId: string): PendingRequestRecord | undefined;
  findPendingRequestByClaudeId(threadId: string, claudeRequestId: string): PendingRequestRecord | undefined;
  listPendingRequests(threadId: string): PendingRequestRecord[];
  resolvePendingRequest(requestId: string, status: "resolved" | "cancelled", response: unknown): void;
  getGoal(threadId: string): InternalGoal | undefined;
  setGoal(threadId: string, patch: GoalPatch): InternalGoal;
  clearGoal(threadId: string): boolean;
  accountGoalUsage(input: GoalUsageInput): InternalGoal | undefined;
  close(): void;
}
