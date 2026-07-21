import type { Turn } from "../../codex/generated/v2/Turn.js";
import type {
  ClaudeThreadRecord,
  GoalPatch,
  GoalUsageInput,
  HybridStore,
  InternalGoal,
  PendingRequestRecord,
  ProviderEventDisposition,
  ProviderEventRecord,
  ProviderBoundaryCommit,
  ProviderItemCorrelation,
  ProviderRetractionMutation,
  PendingThreadRemoval,
  StateEvent,
  TurnProviderBoundary,
} from "../../store/HybridStore.js";
import type { RuntimeFactSource, SessionBranchSnapshot } from "./commands.js";

export function branchRevision(
  record: ClaudeThreadRecord,
  boundaries: readonly TurnProviderBoundary[],
  turns = record.thread.turns,
): string {
  return JSON.stringify({
    sessionId: record.claudeSessionId,
    turns: turns.map((turn) => [turn.id, turn.status]),
    boundaries,
  });
}

export function remapBoundaries(
  boundaries: readonly TurnProviderBoundary[],
  uuidEntries: readonly (readonly [string, string])[],
  retainedTurnIds: ReadonlySet<string>,
): TurnProviderBoundary[] {
  const uuidMap = new Map(uuidEntries);
  const seen = new Set<string>();
  return boundaries.map(({ turnId, messageUuid }) => {
    const mapped = uuidMap.get(messageUuid);
    if (!retainedTurnIds.has(turnId) || seen.has(turnId) || !mapped) {
      throw new Error(`Claude fork is missing or invalid provenance for retained boundary '${messageUuid}'.`);
    }
    seen.add(turnId);
    return { turnId, messageUuid: mapped };
  });
}

export class ClaudeSessionRepository {
  public constructor(private readonly store: HybridStore) {}

  public create(record: ClaudeThreadRecord): void {
    this.store.createThread(record);
  }

  public read(threadId: string, includeTurns: boolean): ClaudeThreadRecord | undefined {
    return this.store.getThreadRecord(threadId, includeTurns);
  }

  public branchSnapshot(threadId: string): SessionBranchSnapshot | undefined {
    const record = this.store.getThreadRecord(threadId, true);
    if (!record) return undefined;
    const boundaries = record.thread.turns.flatMap((turn) => {
      const messageUuid = this.store.getTurnClaudeMessageUuid(threadId, turn.id);
      return messageUuid ? [{ turnId: turn.id, messageUuid }] : [];
    });
    return { record, boundaries, revision: branchRevision(record, boundaries) };
  }

  public update(record: ClaudeThreadRecord): void {
    this.store.updateThread(record);
  }

  public commitState(
    record: ClaudeThreadRecord,
    events: readonly StateEvent[],
    turn?: Turn,
    insertTurn = false,
    providerBoundary?: ProviderBoundaryCommit,
  ): number[] {
    return this.store.commitThreadState({
      record,
      events,
      ...(turn ? { turn, insertTurn } : {}),
      ...(providerBoundary ? { providerBoundary } : {}),
    });
  }

  public delete(threadId: string): void {
    this.store.deleteThread(threadId);
  }

  public goal(threadId: string): InternalGoal | undefined { return this.store.getGoal(threadId); }
  public setGoal(threadId: string, patch: GoalPatch): InternalGoal { return this.store.setGoal(threadId, patch); }
  public clearGoal(threadId: string): boolean { return this.store.clearGoal(threadId); }
  public accountGoalUsage(input: GoalUsageInput): InternalGoal | undefined { return this.store.accountGoalUsage(input); }
  public archived(threadId: string): boolean { return this.store.isThreadArchived(threadId); }
  public commitArchived(threadIds: readonly string[], archived: boolean): void {
    this.store.commitThreadsArchived(threadIds, archived);
  }
  public beginRemoval(removal: PendingThreadRemoval): void {
    this.store.beginThreadRemoval(removal);
  }
  public cancelRemoval(rootThreadId: string): void {
    this.store.cancelThreadRemoval(rootThreadId);
  }
  public pendingRemoval(rootThreadId: string): PendingThreadRemoval | undefined {
    return this.store.listPendingThreadRemovals()
      .find((removal) => removal.rootThreadId === rootThreadId);
  }
  public commitRemoval(rootThreadId: string, threadIds: readonly string[]): void {
    this.store.commitThreadRemoval(rootThreadId, threadIds);
  }

  public ownedThreadIds(threadId: string): string[] {
    const children = new Map<string, string[]>();
    for (const record of this.store.allThreadRecords()) {
      const parent = record.thread.parentThreadId;
      if (!parent) continue;
      const values = children.get(parent) ?? [];
      values.push(record.thread.id);
      children.set(parent, values);
    }
    const result = [threadId];
    for (let index = 0; index < result.length; index += 1) {
      result.push(...(children.get(result[index]!) ?? []));
    }
    return result;
  }

  public commitFork(
    record: ClaudeThreadRecord,
    turns: readonly Turn[],
    boundaries: readonly TurnProviderBoundary[],
  ): void {
    this.store.commitForkedThread(record, turns, boundaries);
  }

  public commitRollback(
    record: ClaudeThreadRecord,
    keepCount: number,
    boundaries: readonly TurnProviderBoundary[],
    removedThreadIds: readonly string[],
  ): void {
    this.store.commitThreadRollback(record, keepCount, boundaries, removedThreadIds);
  }

  public createTurn(threadId: string, turn: Turn): void {
    this.store.createTurn(threadId, turn);
  }

  public readTurn(threadId: string, turnId: string): Turn | undefined {
    return this.store.getTurn(threadId, turnId);
  }

  public updateTurn(threadId: string, turn: Turn): void {
    this.store.updateTurn(threadId, turn);
  }

  public appendProviderEvent(event: {
    readonly threadId: string;
    readonly processEpoch: string;
    readonly providerSequence: number;
    readonly providerEventType: string;
    readonly providerEventId: string | null;
    readonly payload: unknown;
    readonly createdAt: number;
  }): { record: ProviderEventRecord; inserted: boolean } {
    return this.store.appendProviderEvent(event);
  }

  public finishProviderEvent(
    threadId: string,
    sequence: number,
    disposition: Exclude<ProviderEventDisposition, "pending">,
    error?: string,
  ): void {
    this.store.completeProviderEvent(threadId, sequence, disposition, error);
  }

  public abandonPendingProviderEvents(threadId: string, error: string): string[] {
    const pending = this.store.listProviderEvents(threadId, "pending");
    for (const event of pending) {
      this.store.completeProviderEvent(threadId, event.sequence, "abandoned", error);
    }
    return pending.map((event) => event.providerEventType);
  }

  public markProviderEventProcessed(
    threadId: string,
    providerEventType: string,
    providerEventId: string,
  ): void {
    this.store.markProviderEventProcessed(threadId, providerEventType, providerEventId);
  }

  public pruneProviderEvents(threadId: string, maxEvents: number, maxBytes: number): number {
    return this.store.pruneProviderEvents(threadId, maxEvents, maxBytes);
  }

  public providerItemCorrelations(
    threadId: string,
    providerMessageIds: readonly string[],
  ): ProviderItemCorrelation[] {
    return this.store.listProviderItemCorrelations(threadId, providerMessageIds);
  }

  public deleteProviderItemCorrelations(threadId: string, providerMessageIds: readonly string[]): void {
    this.store.deleteProviderItemCorrelations(threadId, providerMessageIds);
  }

  public commitProviderRetraction(
    record: ClaudeThreadRecord,
    providerMessageIds: readonly string[],
    mutations: readonly ProviderRetractionMutation[],
    removedThreadIds: readonly string[],
  ): void {
    this.store.commitProviderRetraction(record, providerMessageIds, mutations, removedThreadIds);
  }

  public appendEvent(
    threadId: string,
    turnId: string | null,
    method: string,
    params: unknown,
    dedupKey?: string,
  ): number {
    return this.store.appendEvent(
      threadId,
      turnId,
      method,
      params,
      dedupKey === undefined ? undefined : { dedupKey },
    );
  }

  public appendTurnEvent(
    threadId: string,
    turn: Turn,
    method: string,
    params: unknown,
    source: RuntimeFactSource,
  ): number {
    return this.store.appendEvent(threadId, turn.id, method, params, {
      turn,
      providerEventId: source.providerEventId,
      providerEventType: source.providerEventType,
    });
  }

  public pendingRequest(requestId: string): PendingRequestRecord | undefined {
    return this.store.getPendingRequest(requestId);
  }

  public pendingRequestByClaudeId(
    threadId: string,
    claudeRequestId: string,
  ): PendingRequestRecord | undefined {
    return this.store.findPendingRequestByClaudeId(threadId, claudeRequestId);
  }

  public createPendingRequest(request: PendingRequestRecord): void {
    this.store.createPendingRequest(request);
  }

  public pendingRequests(threadId: string): PendingRequestRecord[] {
    return this.store.listPendingRequests(threadId);
  }

  public resolvePendingRequest(
    requestId: string,
    status: "resolved" | "cancelled",
    response: unknown,
  ): void {
    this.store.resolvePendingRequest(requestId, status, response);
  }
}
