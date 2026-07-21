import type { Thread } from "../codex/generated/v2/Thread.js";
import type { ThreadListParams } from "../codex/generated/v2/ThreadListParams.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import type {
  AppendProviderEvent, ClaudeThreadRecord, EventPersistence, GoalPatch, GoalUsageInput, HybridStore, InternalGoal, PendingRequestRecord,
  PendingThreadRemoval, ProviderEventDisposition, ProviderEventRecord, ProviderItemCorrelation, ProviderRetractionMutation,
  StoredEvent, ThreadStateCommit, TurnProviderBoundary,
} from "./HybridStore.js";
import { settingsGeneration, withSettingsFrom } from "./HybridStore.js";
import { filterSortThreads } from "./threadFilter.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function restoreMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function restoreSet<T>(target: Set<T>, source: Set<T>): void {
  target.clear();
  for (const value of source) target.add(value);
}

function filteredThreads(records: Iterable<ClaudeThreadRecord>, params: ThreadListParams): Thread[] {
  return filterSortThreads([...records].map((record) => record.thread), params).map(copy);
}

export class MemoryHybridStore implements HybridStore {
  private readonly records = new Map<string, ClaudeThreadRecord>();
  private readonly turns = new Map<string, Turn[]>();
  private readonly pending = new Map<string, PendingRequestRecord>();
  private readonly archived = new Set<string>();
  private readonly pendingRemovals = new Map<string, PendingThreadRemoval>();
  private readonly goals = new Map<string, InternalGoal>();
  private readonly goalCheckpoints = new Set<string>();
  private readonly turnMessages = new Map<string, string>();
  private readonly eventDedup = new Set<string>();
  private readonly providerEvents = new Set<string>();
  private readonly providerJournal: ProviderEventRecord[] = [];
  private readonly providerItemCorrelations: Array<ProviderItemCorrelation & { threadId: string }> = [];
  private readonly events: StoredEvent[] = [];
  private eventSequence = 0;

  public createThread(record: ClaudeThreadRecord): void {
    this.records.set(record.thread.id, copy({ ...record, thread: { ...record.thread, turns: [] } }));
    this.turns.set(record.thread.id, []);
  }

  public hasThread(threadId: string): boolean { return this.records.has(threadId); }

  public getThreadRecord(threadId: string, includeTurns = false): ClaudeThreadRecord | undefined {
    const record = this.records.get(threadId);
    return record ? copy({ ...record, thread: { ...record.thread, turns: includeTurns ? this.turns.get(threadId) ?? [] : [] } }) : undefined;
  }

  public allThreadRecords(): ClaudeThreadRecord[] {
    return [...this.records.keys()].flatMap((id) => {
      const record = this.getThreadRecord(id, true);
      return record ? [record] : [];
    });
  }

  public listThreads(params: ThreadListParams): Thread[] {
    const archived = params.archived === true;
    return filteredThreads([...this.records.values()].filter((record) => this.archived.has(record.thread.id) === archived), params);
  }

  public updateThread(record: ClaudeThreadRecord): void {
    const current = this.records.get(record.thread.id);
    const merged = current && settingsGeneration(current) > settingsGeneration(record)
      ? withSettingsFrom(record, current)
      : record;
    this.records.set(record.thread.id, copy({ ...merged, thread: { ...merged.thread, turns: [] } }));
  }

  public isThreadArchived(threadId: string): boolean { return this.archived.has(threadId); }

  public setThreadArchived(threadId: string, archived: boolean): void {
    if (archived) this.archived.add(threadId);
    else this.archived.delete(threadId);
  }

  public commitThreadsArchived(threadIds: readonly string[], archived: boolean): void {
    const method = archived ? "thread/archived" : "thread/unarchived";
    const createdAt = Date.now();
    const events = threadIds.map((threadId, index) => ({
      sequence: this.eventSequence + index + 1,
      threadId,
      turnId: null,
      method,
      params: { threadId },
      createdAt,
    }));
    for (const threadId of threadIds) this.setThreadArchived(threadId, archived);
    this.eventSequence += events.length;
    this.events.push(...events);
  }

  public beginThreadRemoval(removal: PendingThreadRemoval): void {
    this.pendingRemovals.set(removal.rootThreadId, copy(removal));
  }
  public cancelThreadRemoval(rootThreadId: string): void {
    this.pendingRemovals.delete(rootThreadId);
  }
  public listPendingThreadRemovals(): PendingThreadRemoval[] {
    return [...this.pendingRemovals.values()].map(copy);
  }
  public commitThreadRemoval(rootThreadId: string, threadIds: readonly string[]): void {
    const snapshot = copy({
      records: this.records,
      turns: this.turns,
      pending: this.pending,
      archived: this.archived,
      pendingRemovals: this.pendingRemovals,
      goals: this.goals,
      goalCheckpoints: this.goalCheckpoints,
      turnMessages: this.turnMessages,
      events: this.events,
      providerJournal: this.providerJournal,
      providerItemCorrelations: this.providerItemCorrelations,
    });
    try {
      for (const threadId of [...threadIds].reverse()) this.deleteThread(threadId);
    } catch (error) {
      restoreMap(this.records, snapshot.records);
      restoreMap(this.turns, snapshot.turns);
      restoreMap(this.pending, snapshot.pending);
      restoreSet(this.archived, snapshot.archived);
      restoreMap(this.pendingRemovals, snapshot.pendingRemovals);
      restoreMap(this.goals, snapshot.goals);
      restoreSet(this.goalCheckpoints, snapshot.goalCheckpoints);
      restoreMap(this.turnMessages, snapshot.turnMessages);
      this.events.splice(0, this.events.length, ...snapshot.events);
      this.providerJournal.splice(0, this.providerJournal.length, ...snapshot.providerJournal);
      this.providerItemCorrelations.splice(
        0,
        this.providerItemCorrelations.length,
        ...snapshot.providerItemCorrelations,
      );
      throw error;
    }
    this.pendingRemovals.delete(rootThreadId);
  }

  public deleteThread(threadId: string): void {
    this.records.delete(threadId);
    for (const turn of this.turns.get(threadId) ?? []) this.turnMessages.delete(`${threadId}:${turn.id}`);
    this.turns.delete(threadId);
    this.archived.delete(threadId);
    this.goals.delete(threadId);
    for (const checkpoint of this.goalCheckpoints) if (checkpoint.startsWith(`${threadId}:`)) this.goalCheckpoints.delete(checkpoint);
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if (this.events[index]!.threadId === threadId) this.events.splice(index, 1);
    }
    for (let index = this.providerJournal.length - 1; index >= 0; index -= 1) {
      if (this.providerJournal[index]!.threadId === threadId) this.providerJournal.splice(index, 1);
    }
    for (let index = this.providerItemCorrelations.length - 1; index >= 0; index -= 1) {
      const link = this.providerItemCorrelations[index]!;
      if (link.threadId === threadId || link.ownerThreadId === threadId) this.providerItemCorrelations.splice(index, 1);
    }
    for (const [requestId, request] of this.pending) if (request.threadId === threadId) this.pending.delete(requestId);
  }

  public createTurn(threadId: string, turn: Turn): void { this.turns.get(threadId)?.push(copy(turn)); }

  public updateTurn(threadId: string, turn: Turn): void {
    const turns = this.turns.get(threadId);
    const index = turns?.findIndex((candidate) => candidate.id === turn.id) ?? -1;
    if (turns && index >= 0) turns[index] = copy(turn);
  }

  public getTurn(threadId: string, turnId: string): Turn | undefined {
    const turn = this.turns.get(threadId)?.find((candidate) => candidate.id === turnId);
    return turn ? copy(turn) : undefined;
  }

  public listTurns(threadId: string): Turn[] { return copy(this.turns.get(threadId) ?? []); }
  public setTurnClaudeMessageUuid(threadId: string, turnId: string, messageUuid: string): void {
    this.turnMessages.set(`${threadId}:${turnId}`, messageUuid);
  }
  public getTurnClaudeMessageUuid(threadId: string, turnId: string): string | undefined {
    return this.turnMessages.get(`${threadId}:${turnId}`);
  }
  public truncateTurns(threadId: string, keepCount: number): void {
    const turns = this.turns.get(threadId) ?? [];
    for (const turn of turns.slice(keepCount)) this.turnMessages.delete(`${threadId}:${turn.id}`);
    this.turns.set(threadId, turns.slice(0, keepCount));
  }
  public commitForkedThread(record: ClaudeThreadRecord, turns: readonly Turn[], boundaries: readonly TurnProviderBoundary[]): void {
    this.createThread(record);
    for (const turn of turns) this.createTurn(record.thread.id, turn);
    for (const boundary of boundaries) this.setTurnClaudeMessageUuid(record.thread.id, boundary.turnId, boundary.messageUuid);
  }
  public commitThreadRollback(
    record: ClaudeThreadRecord,
    keepCount: number,
    boundaries: readonly TurnProviderBoundary[],
    removedThreadIds: readonly string[] = [],
  ): void {
    for (const threadId of removedThreadIds) this.deleteThread(threadId);
    this.truncateTurns(record.thread.id, keepCount);
    for (const boundary of boundaries) this.setTurnClaudeMessageUuid(record.thread.id, boundary.turnId, boundary.messageUuid);
    this.updateThread(record);
  }

  public commitThreadState(commit: ThreadStateCommit): number[] {
    const threadId = commit.record.thread.id;
    const createdAt = Date.now();
    const events = commit.events.map((event, index) => ({
      sequence: this.eventSequence + index + 1,
      threadId,
      turnId: event.turnId,
      method: event.method,
      params: copy(event.params),
      createdAt,
    }));
    this.updateThread(commit.record);
    if (commit.turn) {
      if (commit.insertTurn) this.createTurn(threadId, commit.turn);
      else this.updateTurn(threadId, commit.turn);
    }
    if (commit.providerBoundary) {
      const boundary = commit.providerBoundary;
      this.setTurnClaudeMessageUuid(boundary.ownerThreadId, boundary.turnId, boundary.messageUuid);
      this.linkProviderItems(
        threadId,
        boundary.messageUuid,
        boundary.ownerThreadId,
        boundary.turnId,
        boundary.itemIds ?? [],
      );
    }
    this.eventSequence += events.length;
    this.events.push(...events);
    return events.map((event) => event.sequence);
  }

  public appendEvent(threadId: string, turnId: string | null, method: string, params: unknown, persistence?: EventPersistence): number {
    if (persistence?.dedupKey && this.eventDedup.has(`${threadId}:${persistence.dedupKey}`)) return 0;
    if (persistence?.turn) this.updateTurn(threadId, persistence.turn);
    if (persistence?.dedupKey) this.eventDedup.add(`${threadId}:${persistence.dedupKey}`);
    const sequence = ++this.eventSequence;
    this.events.push({ sequence, threadId, turnId, method, params: copy(params), createdAt: Date.now() });
    return sequence;
  }
  public eventHighWatermark(threadId: string): number {
    return this.events.findLast((event) => event.threadId === threadId)?.sequence ?? 0;
  }
  public listEventsAfter(threadId: string, sequence: number): StoredEvent[] {
    return this.events.filter((event) => event.threadId === threadId && event.sequence > sequence && !event.method.startsWith("hybrid/"))
      .map(copy);
  }
  public hasProcessedProviderEvent(threadId: string, providerEventId: string): boolean {
    return this.providerEvents.has(`${threadId}:${providerEventId}`);
  }
  public markProviderEventProcessed(threadId: string, _providerEventType: string, providerEventId: string): void {
    this.providerEvents.add(`${threadId}:${providerEventId}`);
  }
  public appendProviderEvent(event: AppendProviderEvent): { record: ProviderEventRecord; inserted: boolean } {
    const existing = event.providerEventId === null ? undefined : this.providerJournal.find(
      (candidate) => candidate.threadId === event.threadId && candidate.providerEventId === event.providerEventId,
    );
    if (existing) return { record: copy(existing), inserted: false };
    const record: ProviderEventRecord = {
      ...copy(event), sequence: ++this.eventSequence, disposition: "pending", error: null, projectedAt: null,
    };
    this.providerJournal.push(record);
    return { record: copy(record), inserted: true };
  }
  public completeProviderEvent(
    threadId: string,
    sequence: number,
    disposition: Exclude<ProviderEventDisposition, "pending">,
    error: string | null = null,
  ): void {
    const index = this.providerJournal.findIndex((event) => event.threadId === threadId && event.sequence === sequence);
    if (index >= 0) this.providerJournal[index] = { ...this.providerJournal[index]!, disposition, error, projectedAt: Date.now() };
  }
  public listProviderEvents(threadId: string, disposition?: ProviderEventDisposition): ProviderEventRecord[] {
    return this.providerJournal.filter((event) =>
      event.threadId === threadId && (disposition === undefined || event.disposition === disposition),
    ).map(copy);
  }
  public pruneProviderEvents(threadId: string, maxEvents: number, maxBytes: number): number {
    if (maxEvents < 1) throw new Error("Provider event retention must keep at least one event.");
    const ordinary = new Set<ProviderEventDisposition>(["projected", "stateOnly", "retainedOnly", "unsupportedVisible"]);
    const candidates = this.providerJournal.filter((event) => event.threadId === threadId && ordinary.has(event.disposition));
    const retained = new Set<number>();
    let bytes = 0;
    for (const event of [...candidates].reverse()) {
      const size = Buffer.byteLength(JSON.stringify(event.payload));
      if (retained.size >= maxEvents || (retained.size > 0 && bytes + size > maxBytes)) continue;
      retained.add(event.sequence);
      bytes += size;
    }
    const before = this.providerJournal.length;
    for (let index = this.providerJournal.length - 1; index >= 0; index -= 1) {
      const event = this.providerJournal[index]!;
      if (event.threadId === threadId && ordinary.has(event.disposition) && !retained.has(event.sequence)) {
        this.providerJournal.splice(index, 1);
      }
    }
    return before - this.providerJournal.length;
  }
  public linkProviderItems(threadId: string, providerMessageId: string, ownerThreadId: string, turnId: string, itemIds: readonly string[]): void {
    for (const itemId of itemIds) {
      if (this.providerItemCorrelations.some((link) => link.threadId === threadId && link.providerMessageId === providerMessageId && link.itemId === itemId)) continue;
      this.providerItemCorrelations.push({ threadId, providerMessageId, ownerThreadId, turnId, itemId });
    }
  }
  public listProviderItemCorrelations(threadId: string, providerMessageIds: readonly string[]): ProviderItemCorrelation[] {
    const ids = new Set(providerMessageIds);
    return this.providerItemCorrelations.filter((link) => link.threadId === threadId && ids.has(link.providerMessageId)).map(copy);
  }
  public deleteProviderItemCorrelations(threadId: string, providerMessageIds: readonly string[]): void {
    const ids = new Set(providerMessageIds);
    for (let index = this.providerItemCorrelations.length - 1; index >= 0; index -= 1) {
      const link = this.providerItemCorrelations[index]!;
      if (link.threadId === threadId && ids.has(link.providerMessageId)) this.providerItemCorrelations.splice(index, 1);
    }
  }
  public commitProviderRetraction(
    record: ClaudeThreadRecord,
    providerMessageIds: readonly string[],
    mutations: readonly ProviderRetractionMutation[],
    removedThreadIds: readonly string[] = [],
  ): void {
    for (const threadId of removedThreadIds) this.deleteThread(threadId);
    for (const mutation of mutations) {
      this.updateTurn(mutation.ownerThreadId, mutation.turn);
      if (mutation.clearBoundary) this.turnMessages.delete(`${mutation.ownerThreadId}:${mutation.turn.id}`);
    }
    this.deleteProviderItemCorrelations(record.thread.id, providerMessageIds);
    this.updateThread(record);
  }

  public createPendingRequest(request: PendingRequestRecord): void { this.pending.set(request.requestId, copy(request)); }
  public getPendingRequest(requestId: string): PendingRequestRecord | undefined {
    const request = this.pending.get(requestId);
    return request ? copy(request) : undefined;
  }
  public findPendingRequestByClaudeId(threadId: string, claudeRequestId: string): PendingRequestRecord | undefined {
    return [...this.pending.values()].reverse().find((request) => request.threadId === threadId && request.claudeRequestId === claudeRequestId);
  }
  public listPendingRequests(threadId: string): PendingRequestRecord[] {
    return [...this.pending.values()].filter((request) => request.threadId === threadId && request.status === "pending").map(copy);
  }
  public resolvePendingRequest(requestId: string, status: "resolved" | "cancelled", response: unknown): void {
    const request = this.pending.get(requestId);
    if (request?.status === "pending") this.pending.set(requestId, { ...request, status, response: copy(response), resolvedAt: Date.now() });
  }
  public getGoal(threadId: string): InternalGoal | undefined {
    const goal = this.goals.get(threadId);
    return goal ? copy(goal) : undefined;
  }
  public setGoal(threadId: string, patch: GoalPatch): InternalGoal {
    const previous = this.goals.get(threadId);
    const now = patch.now ?? Math.floor(Date.now() / 1_000);
    const replace = patch.replace === true || !previous;
    if (replace && patch.objective === undefined) throw new Error(`cannot create goal for thread ${threadId} without an objective`);
    const goal: InternalGoal = {
      threadId,
      goalId: replace ? crypto.randomUUID() : previous.goalId,
      objective: patch.objective ?? previous?.objective ?? "",
      status: patch.status ?? (replace ? "active" : previous.status),
      tokenBudget: patch.tokenBudget === undefined ? (replace ? null : previous.tokenBudget) : patch.tokenBudget,
      tokensUsed: replace ? 0 : previous.tokensUsed,
      timeUsedSeconds: replace ? 0 : previous.timeUsedSeconds,
      createdAt: replace ? now : previous.createdAt,
      updatedAt: now,
    };
    if (goal.status === "active" && goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) goal.status = "budgetLimited";
    this.goals.set(threadId, copy(goal));
    return copy(goal);
  }
  public clearGoal(threadId: string): boolean { return this.goals.delete(threadId); }
  public accountGoalUsage(input: GoalUsageInput): InternalGoal | undefined {
    const checkpoint = input.checkpointKey ? `${input.threadId}:${input.expectedGoalId}:${input.checkpointKey}` : undefined;
    if (checkpoint && this.goalCheckpoints.has(checkpoint)) return this.getGoal(input.threadId);
    const previous = this.goals.get(input.threadId);
    if (!previous || previous.goalId !== input.expectedGoalId) return previous ? copy(previous) : undefined;
    if (checkpoint) this.goalCheckpoints.add(checkpoint);
    if (previous.status !== "active" && previous.status !== "budgetLimited") return copy(previous);
    const goal = {
      ...previous,
      tokensUsed: previous.tokensUsed + Math.max(0, input.tokenDelta),
      timeUsedSeconds: previous.timeUsedSeconds + Math.max(0, input.timeDeltaSeconds),
      updatedAt: Math.floor(Date.now() / 1_000),
    };
    if (goal.status === "active" && goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) goal.status = "budgetLimited" as const;
    this.goals.set(input.threadId, copy(goal));
    return copy(goal);
  }

  public close(): void {
    this.records.clear();
    this.turns.clear();
    this.pending.clear();
    this.archived.clear();
    this.pendingRemovals.clear();
    this.goals.clear();
    this.goalCheckpoints.clear();
    this.turnMessages.clear();
    this.eventDedup.clear();
    this.providerEvents.clear();
    this.providerJournal.length = 0;
    this.providerItemCorrelations.length = 0;
    this.events.length = 0;
  }
}

export class LayeredHybridStore implements HybridStore {
  private readonly ephemeral = new MemoryHybridStore();

  public constructor(private readonly durable: HybridStore) {}

  private owner(threadId: string): HybridStore { return this.ephemeral.hasThread(threadId) ? this.ephemeral : this.durable; }

  public createThread(record: ClaudeThreadRecord): void { (record.thread.ephemeral ? this.ephemeral : this.durable).createThread(record); }
  public hasThread(threadId: string): boolean { return this.ephemeral.hasThread(threadId) || this.durable.hasThread(threadId); }
  public getThreadRecord(threadId: string, includeTurns = false) { return this.owner(threadId).getThreadRecord(threadId, includeTurns); }
  public allThreadRecords(): ClaudeThreadRecord[] { return [...this.durable.allThreadRecords(), ...this.ephemeral.allThreadRecords()]; }
  public listThreads(params: ThreadListParams): Thread[] {
    return filterSortThreads([...this.durable.listThreads(params), ...this.ephemeral.listThreads(params)], params);
  }
  public updateThread(record: ClaudeThreadRecord): void { this.owner(record.thread.id).updateThread(record); }
  public isThreadArchived(threadId: string): boolean { return this.owner(threadId).isThreadArchived(threadId); }
  public setThreadArchived(threadId: string, archived: boolean): void { this.owner(threadId).setThreadArchived(threadId, archived); }
  public commitThreadsArchived(threadIds: readonly string[], archived: boolean): void {
    const owner = this.owner(threadIds[0]!);
    if (threadIds.some((threadId) => this.owner(threadId) !== owner)) {
      throw new Error("Cannot atomically archive threads stored in different layers.");
    }
    owner.commitThreadsArchived(threadIds, archived);
  }
  public beginThreadRemoval(removal: PendingThreadRemoval): void {
    this.durable.beginThreadRemoval(removal);
  }
  public cancelThreadRemoval(rootThreadId: string): void {
    this.durable.cancelThreadRemoval(rootThreadId);
  }
  public listPendingThreadRemovals(): PendingThreadRemoval[] {
    return this.durable.listPendingThreadRemovals();
  }
  public commitThreadRemoval(rootThreadId: string, threadIds: readonly string[]): void {
    const owner = this.owner(rootThreadId);
    if (threadIds.some((threadId) => this.owner(threadId) !== owner)) {
      throw new Error("Cannot atomically delete threads stored in different layers.");
    }
    owner.commitThreadRemoval(rootThreadId, threadIds);
    if (owner !== this.durable) this.durable.commitThreadRemoval(rootThreadId, []);
  }
  public deleteThread(threadId: string): void { this.owner(threadId).deleteThread(threadId); }
  public createTurn(threadId: string, turn: Turn): void { this.owner(threadId).createTurn(threadId, turn); }
  public updateTurn(threadId: string, turn: Turn): void { this.owner(threadId).updateTurn(threadId, turn); }
  public getTurn(threadId: string, turnId: string): Turn | undefined { return this.owner(threadId).getTurn(threadId, turnId); }
  public listTurns(threadId: string): Turn[] { return this.owner(threadId).listTurns(threadId); }
  public setTurnClaudeMessageUuid(threadId: string, turnId: string, messageUuid: string): void {
    this.owner(threadId).setTurnClaudeMessageUuid(threadId, turnId, messageUuid);
  }
  public getTurnClaudeMessageUuid(threadId: string, turnId: string): string | undefined {
    return this.owner(threadId).getTurnClaudeMessageUuid(threadId, turnId);
  }
  public truncateTurns(threadId: string, keepCount: number): void { this.owner(threadId).truncateTurns(threadId, keepCount); }
  public commitForkedThread(record: ClaudeThreadRecord, turns: readonly Turn[], boundaries: readonly TurnProviderBoundary[]): void {
    (record.thread.ephemeral ? this.ephemeral : this.durable).commitForkedThread(record, turns, boundaries);
  }
  public commitThreadRollback(
    record: ClaudeThreadRecord,
    keepCount: number,
    boundaries: readonly TurnProviderBoundary[],
    removedThreadIds: readonly string[] = [],
  ): void {
    this.owner(record.thread.id).commitThreadRollback(record, keepCount, boundaries, removedThreadIds);
  }
  public commitThreadState(commit: ThreadStateCommit): number[] {
    return this.owner(commit.record.thread.id).commitThreadState(commit);
  }
  public appendEvent(threadId: string, turnId: string | null, method: string, params: unknown, persistence?: EventPersistence): number {
    return this.owner(threadId).appendEvent(threadId, turnId, method, params, persistence);
  }
  public eventHighWatermark(threadId: string): number { return this.owner(threadId).eventHighWatermark(threadId); }
  public listEventsAfter(threadId: string, sequence: number): StoredEvent[] {
    return this.owner(threadId).listEventsAfter(threadId, sequence);
  }
  public hasProcessedProviderEvent(threadId: string, providerEventId: string): boolean {
    return this.owner(threadId).hasProcessedProviderEvent(threadId, providerEventId);
  }
  public markProviderEventProcessed(threadId: string, providerEventType: string, providerEventId: string): void {
    this.owner(threadId).markProviderEventProcessed(threadId, providerEventType, providerEventId);
  }
  public appendProviderEvent(event: AppendProviderEvent): { record: ProviderEventRecord; inserted: boolean } {
    return this.owner(event.threadId).appendProviderEvent(event);
  }
  public completeProviderEvent(
    threadId: string,
    sequence: number,
    disposition: Exclude<ProviderEventDisposition, "pending">,
    error: string | null = null,
  ): void {
    this.owner(threadId).completeProviderEvent(threadId, sequence, disposition, error);
  }
  public listProviderEvents(threadId: string, disposition?: ProviderEventDisposition): ProviderEventRecord[] {
    return this.owner(threadId).listProviderEvents(threadId, disposition);
  }
  public pruneProviderEvents(threadId: string, maxEvents: number, maxBytes: number): number {
    return this.owner(threadId).pruneProviderEvents(threadId, maxEvents, maxBytes);
  }
  public linkProviderItems(threadId: string, providerMessageId: string, ownerThreadId: string, turnId: string, itemIds: readonly string[]): void {
    this.owner(threadId).linkProviderItems(threadId, providerMessageId, ownerThreadId, turnId, itemIds);
  }
  public listProviderItemCorrelations(threadId: string, providerMessageIds: readonly string[]): ProviderItemCorrelation[] {
    return this.owner(threadId).listProviderItemCorrelations(threadId, providerMessageIds);
  }
  public deleteProviderItemCorrelations(threadId: string, providerMessageIds: readonly string[]): void {
    this.owner(threadId).deleteProviderItemCorrelations(threadId, providerMessageIds);
  }
  public commitProviderRetraction(
    record: ClaudeThreadRecord,
    providerMessageIds: readonly string[],
    mutations: readonly ProviderRetractionMutation[],
    removedThreadIds: readonly string[] = [],
  ): void {
    this.owner(record.thread.id).commitProviderRetraction(
      record,
      providerMessageIds,
      mutations,
      removedThreadIds,
    );
  }
  public createPendingRequest(request: PendingRequestRecord): void { this.owner(request.threadId).createPendingRequest(request); }
  public getPendingRequest(requestId: string): PendingRequestRecord | undefined {
    return this.ephemeral.getPendingRequest(requestId) ?? this.durable.getPendingRequest(requestId);
  }
  public findPendingRequestByClaudeId(threadId: string, claudeRequestId: string): PendingRequestRecord | undefined {
    return this.owner(threadId).findPendingRequestByClaudeId(threadId, claudeRequestId);
  }
  public listPendingRequests(threadId: string): PendingRequestRecord[] { return this.owner(threadId).listPendingRequests(threadId); }
  public resolvePendingRequest(requestId: string, status: "resolved" | "cancelled", response: unknown): void {
    const request = this.getPendingRequest(requestId);
    if (request) this.owner(request.threadId).resolvePendingRequest(requestId, status, response);
  }
  public getGoal(threadId: string): InternalGoal | undefined { return this.owner(threadId).getGoal(threadId); }
  public setGoal(threadId: string, patch: GoalPatch): InternalGoal { return this.owner(threadId).setGoal(threadId, patch); }
  public clearGoal(threadId: string): boolean { return this.owner(threadId).clearGoal(threadId); }
  public accountGoalUsage(input: GoalUsageInput): InternalGoal | undefined { return this.owner(input.threadId).accountGoalUsage(input); }
  public close(): void { this.ephemeral.close(); this.durable.close(); }
}
