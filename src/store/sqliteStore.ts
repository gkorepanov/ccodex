import {
  chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { v7 as uuidv7 } from "uuid";
import type { Thread } from "../codex/generated/v2/Thread.js";
import type { ThreadListParams } from "../codex/generated/v2/ThreadListParams.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import type { ApprovalsReviewer } from "../codex/generated/v2/ApprovalsReviewer.js";
import type {
  AppendProviderEvent, ClaudeThreadRecord, EventPersistence, GoalPatch, GoalUsageInput, HybridStore, InternalGoal,
  PendingRequestRecord, PendingThreadRemoval, ProviderEventDisposition, ProviderEventRecord, ProviderItemCorrelation,
  ProviderRetractionMutation, StoredEvent, ThreadStateCommit, TurnProviderBoundary,
} from "./HybridStore.js";
import { settingsGeneration, withSettingsFrom } from "./HybridStore.js";
import { filterSortThreads } from "./threadFilter.js";

interface ThreadRow {
  thread_json: string;
  claude_session_id: string;
  model_picker_id: string;
  claude_model_value: string;
  service_tier: string | null;
  approval_policy_json: string;
  sandbox_policy_json: string;
  base_instructions: string | null;
  developer_instructions: string | null;
  personality: string | null;
  resolved_model: string | null;
  last_claude_message_uuid: string | null;
  last_completed_turn_id: string | null;
  claude_code_version: string | null;
  runtime_settings_json: string | null;
}

interface TurnRow {
  turn_json: string;
  last_claude_message_uuid?: string | null;
}

interface PendingRequestRow {
  request_id: string;
  thread_id: string;
  turn_id: string | null;
  claude_request_id: string | null;
  method: string;
  params_json: string;
  status: PendingRequestRecord["status"];
  response_json: string | null;
  created_at: number;
  resolved_at: number | null;
}

interface ProviderEventRow {
  sequence: number;
  thread_id: string;
  process_epoch: string;
  provider_sequence: number;
  provider_event_type: string;
  provider_event_id: string | null;
  payload_json: string;
  disposition: ProviderEventDisposition;
  error: string | null;
  created_at: number;
  projected_at: number | null;
}

interface EventRow {
  sequence: number;
  thread_id: string;
  turn_id: string | null;
  method: string;
  params_json: string;
  created_at: number;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function openChecked(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  try {
    const rows = database.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    if (rows.length !== 1 || rows[0]?.quick_check !== "ok") throw new Error(rows.map((row) => row.quick_check).join("; "));
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function recoverableDatabase(path: string): DatabaseSync {
  if (!existsSync(path)) return openChecked(path);
  try {
    return openChecked(path);
  } catch (error) {
    const backup = `${path}.bak`;
    if (!existsSync(backup)) throw new Error(`SQLite integrity check failed and no backup exists: ${String(error)}`);
    const suffix = `.corrupt-${Date.now()}`;
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(candidate)) renameSync(candidate, `${candidate}${suffix}`);
    }
    copyFileSync(backup, path);
    return openChecked(path);
  }
}

function parseRecord(row: ThreadRow, turns: Turn[]): ClaudeThreadRecord {
  const thread = JSON.parse(row.thread_json) as Thread;
  const runtime = row.runtime_settings_json ? JSON.parse(row.runtime_settings_json) as Record<string, unknown> : {};
  return {
    thread: { ...thread, turns },
    claudeSessionId: row.claude_session_id,
    modelPickerId: row.model_picker_id,
    claudeModelValue: row.claude_model_value,
    serviceTier: row.service_tier,
    approvalPolicy: JSON.parse(row.approval_policy_json) as unknown,
    approvalsReviewer: (["user", "auto_review", "guardian_subagent"] as const).includes(
      runtime.approvalsReviewer as ApprovalsReviewer,
    ) ? runtime.approvalsReviewer as ApprovalsReviewer : "user",
    sandboxPolicy: JSON.parse(row.sandbox_policy_json) as unknown,
    baseInstructions: row.base_instructions,
    developerInstructions: row.developer_instructions,
    personality: row.personality,
    resolvedModel: row.resolved_model,
    lastClaudeMessageUuid: row.last_claude_message_uuid,
    lastCompletedTurnId: row.last_completed_turn_id,
    claudeCodeVersion: row.claude_code_version,
    reasoningEffort: typeof runtime.reasoningEffort === "string" ? runtime.reasoningEffort : null,
    reasoningSummary: typeof runtime.reasoningSummary === "string" ? runtime.reasoningSummary : null,
    collaborationMode: runtime.collaborationMode ?? null,
    outputSchema: runtime.outputSchema ?? null,
    tokenUsageTotal: runtime.tokenUsageTotal && typeof runtime.tokenUsageTotal === "object"
      ? runtime.tokenUsageTotal as ClaudeThreadRecord["tokenUsageTotal"]
      : { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    tokenUsageLast: runtime.tokenUsageLast && typeof runtime.tokenUsageLast === "object"
      ? runtime.tokenUsageLast as ClaudeThreadRecord["tokenUsageLast"]
      : null,
    modelContextWindow: typeof runtime.modelContextWindow === "number" ? runtime.modelContextWindow : null,
    providerCostUsdTotal: typeof runtime.providerCostUsdTotal === "number" ? runtime.providerCostUsdTotal : 0,
    settingsGeneration: typeof runtime.settingsGeneration === "number" ? runtime.settingsGeneration : 0,
  };
}

function parsePending(row: PendingRequestRow): PendingRequestRecord {
  return {
    requestId: row.request_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    claudeRequestId: row.claude_request_id,
    method: row.method,
    params: JSON.parse(row.params_json) as unknown,
    status: row.status,
    response: row.response_json === null ? null : JSON.parse(row.response_json) as unknown,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function parseProviderEvent(row: ProviderEventRow): ProviderEventRecord {
  return {
    sequence: row.sequence,
    threadId: row.thread_id,
    processEpoch: row.process_epoch,
    providerSequence: row.provider_sequence,
    providerEventType: row.provider_event_type,
    providerEventId: row.provider_event_id,
    payload: JSON.parse(row.payload_json) as unknown,
    disposition: row.disposition,
    error: row.error,
    createdAt: row.created_at,
    projectedAt: row.projected_at,
  };
}

export class SqliteHybridStore implements HybridStore {
  private readonly database: DatabaseSync;
  private readonly path: string;

  public constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.path = path;
    const existed = existsSync(path);
    this.database = recoverableDatabase(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    if (existed) this.backup();
    this.migrate();
    chmodSync(path, 0o600);
  }

  public createThread(record: ClaudeThreadRecord): void {
    this.database.prepare(`
      INSERT INTO threads (
        id, session_id, claude_session_id, model_picker_id, claude_model_value,
        service_tier, cwd, archived, ephemeral, created_at, updated_at,
        thread_json, approval_policy_json, sandbox_policy_json,
        base_instructions, developer_instructions, personality, resolved_model,
        last_claude_message_uuid, last_completed_turn_id, claude_code_version, runtime_settings_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.thread.id,
      record.thread.sessionId,
      record.claudeSessionId,
      record.modelPickerId,
      record.claudeModelValue,
      record.serviceTier,
      record.thread.cwd,
      0,
      record.thread.ephemeral ? 1 : 0,
      record.thread.createdAt,
      record.thread.updatedAt,
      json({ ...record.thread, turns: [] }),
      json(record.approvalPolicy),
      json(record.sandboxPolicy),
      record.baseInstructions,
      record.developerInstructions,
      record.personality,
      record.resolvedModel,
      record.lastClaudeMessageUuid,
      record.lastCompletedTurnId,
      record.claudeCodeVersion,
      json({
        approvalsReviewer: record.approvalsReviewer,
        reasoningEffort: record.reasoningEffort,
        reasoningSummary: record.reasoningSummary,
        collaborationMode: record.collaborationMode,
        outputSchema: record.outputSchema,
        tokenUsageTotal: record.tokenUsageTotal,
        tokenUsageLast: record.tokenUsageLast,
        modelContextWindow: record.modelContextWindow,
        providerCostUsdTotal: record.providerCostUsdTotal ?? 0,
        settingsGeneration: settingsGeneration(record),
      }),
    );
  }

  public hasThread(threadId: string): boolean {
    return this.database.prepare("SELECT 1 AS found FROM threads WHERE id = ?").get(threadId) !== undefined;
  }

  public getThreadRecord(threadId: string, includeTurns = false): ClaudeThreadRecord | undefined {
    const row = this.database.prepare(`
      SELECT thread_json, claude_session_id, model_picker_id, claude_model_value,
             service_tier, approval_policy_json, sandbox_policy_json,
             base_instructions, developer_instructions, personality, resolved_model,
             last_claude_message_uuid, last_completed_turn_id, claude_code_version, runtime_settings_json
      FROM threads WHERE id = ?
    `).get(threadId) as unknown as ThreadRow | undefined;
    if (!row) return undefined;
    return parseRecord(row, includeTurns ? this.listTurns(threadId) : []);
  }

  public allThreadRecords(): ClaudeThreadRecord[] {
    const rows = this.database.prepare(`
      SELECT thread_json, claude_session_id, model_picker_id, claude_model_value,
             service_tier, approval_policy_json, sandbox_policy_json,
             base_instructions, developer_instructions, personality, resolved_model,
             last_claude_message_uuid, last_completed_turn_id, claude_code_version, runtime_settings_json
      FROM threads ORDER BY created_at ASC
    `).all() as unknown as ThreadRow[];
    return rows.map((row) => {
      const thread = JSON.parse(row.thread_json) as Thread;
      return parseRecord(row, this.listTurns(thread.id));
    });
  }

  public listThreads(params: ThreadListParams): Thread[] {
    const archived = params.archived === true ? 1 : 0;
    const rows = this.database.prepare("SELECT thread_json FROM threads WHERE archived = ?").all(archived) as unknown as Array<{ thread_json: string }>;
    return filterSortThreads(rows.map((row) => JSON.parse(row.thread_json) as Thread), params);
  }

  public updateThread(record: ClaudeThreadRecord): void {
    const current = this.getThreadRecord(record.thread.id, false);
    const merged = current && settingsGeneration(current) > settingsGeneration(record)
      ? withSettingsFrom(record, current)
      : record;
    this.database.prepare(`
      UPDATE threads SET
        claude_session_id = ?, model_picker_id = ?, claude_model_value = ?,
        service_tier = ?, cwd = ?, updated_at = ?, thread_json = ?,
        approval_policy_json = ?, sandbox_policy_json = ?, base_instructions = ?,
        developer_instructions = ?, personality = ?, resolved_model = ?,
        last_claude_message_uuid = ?, last_completed_turn_id = ?, claude_code_version = ?,
        runtime_settings_json = ?
      WHERE id = ?
    `).run(
      merged.claudeSessionId,
      merged.modelPickerId,
      merged.claudeModelValue,
      merged.serviceTier,
      merged.thread.cwd,
      merged.thread.updatedAt,
      json({ ...merged.thread, turns: [] }),
      json(merged.approvalPolicy),
      json(merged.sandboxPolicy),
      merged.baseInstructions,
      merged.developerInstructions,
      merged.personality,
      merged.resolvedModel,
      merged.lastClaudeMessageUuid,
      merged.lastCompletedTurnId,
      merged.claudeCodeVersion,
      json({
        approvalsReviewer: merged.approvalsReviewer,
        reasoningEffort: merged.reasoningEffort,
        reasoningSummary: merged.reasoningSummary,
        collaborationMode: merged.collaborationMode,
        outputSchema: merged.outputSchema,
        tokenUsageTotal: merged.tokenUsageTotal,
        tokenUsageLast: merged.tokenUsageLast,
        modelContextWindow: merged.modelContextWindow,
        providerCostUsdTotal: merged.providerCostUsdTotal ?? 0,
        settingsGeneration: settingsGeneration(merged),
      }),
      merged.thread.id,
    );
  }

  public isThreadArchived(threadId: string): boolean {
    const row = this.database.prepare("SELECT archived FROM threads WHERE id = ?").get(threadId) as unknown as {
      archived: number;
    } | undefined;
    return row?.archived === 1;
  }

  public setThreadArchived(threadId: string, archived: boolean): void {
    this.database.prepare("UPDATE threads SET archived = ? WHERE id = ?").run(archived ? 1 : 0, threadId);
  }

  public commitThreadsArchived(threadIds: readonly string[], archived: boolean): void {
    const method = archived ? "thread/archived" : "thread/unarchived";
    this.transaction(() => {
      for (const threadId of threadIds) {
        this.setThreadArchived(threadId, archived);
        this.insertEvent(threadId, null, method, { threadId });
      }
    });
  }

  public beginThreadRemoval(removal: PendingThreadRemoval): void {
    this.database.prepare(`
      INSERT INTO pending_thread_removals (root_thread_id, claude_session_id, cwd, kind)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(root_thread_id) DO UPDATE SET
        claude_session_id = excluded.claude_session_id,
        cwd = excluded.cwd,
        kind = excluded.kind
    `).run(removal.rootThreadId, removal.claudeSessionId, removal.cwd, removal.kind);
  }

  public cancelThreadRemoval(rootThreadId: string): void {
    this.database.prepare("DELETE FROM pending_thread_removals WHERE root_thread_id = ?").run(rootThreadId);
  }

  public listPendingThreadRemovals(): PendingThreadRemoval[] {
    return (this.database.prepare(`
      SELECT root_thread_id, claude_session_id, cwd, kind
      FROM pending_thread_removals ORDER BY root_thread_id
    `).all() as unknown as Array<{
      root_thread_id: string;
      claude_session_id: string;
      cwd: string;
      kind: PendingThreadRemoval["kind"];
    }>).map((row) => ({
      rootThreadId: row.root_thread_id,
      claudeSessionId: row.claude_session_id,
      cwd: row.cwd,
      kind: row.kind,
    }));
  }

  public commitThreadRemoval(rootThreadId: string, threadIds: readonly string[]): void {
    this.transaction(() => {
      for (const threadId of [...threadIds].reverse()) this.deleteThreadRows(threadId);
      this.database.prepare("DELETE FROM pending_thread_removals WHERE root_thread_id = ?").run(rootThreadId);
    });
  }

  public deleteThread(threadId: string): void {
    this.transaction(() => this.deleteThreadRows(threadId));
  }

  public createTurn(threadId: string, turn: Turn): void {
    this.transaction(() => this.insertTurn(threadId, turn));
  }

  public updateTurn(threadId: string, turn: Turn): void {
    this.transaction(() => this.writeTurn(threadId, turn));
  }

  public getTurn(threadId: string, turnId: string): Turn | undefined {
    const row = this.database.prepare("SELECT turn_json FROM turns WHERE id = ? AND thread_id = ?")
      .get(turnId, threadId) as unknown as TurnRow | undefined;
    return row ? JSON.parse(row.turn_json) as Turn : undefined;
  }

  public listTurns(threadId: string): Turn[] {
    const rows = this.database.prepare("SELECT turn_json FROM turns WHERE thread_id = ? ORDER BY ordinal ASC")
      .all(threadId) as unknown as TurnRow[];
    return rows.map((row) => JSON.parse(row.turn_json) as Turn);
  }

  public setTurnClaudeMessageUuid(threadId: string, turnId: string, messageUuid: string): void {
    this.database.prepare("UPDATE turns SET last_claude_message_uuid = ? WHERE id = ? AND thread_id = ?")
      .run(messageUuid, turnId, threadId);
  }

  public getTurnClaudeMessageUuid(threadId: string, turnId: string): string | undefined {
    const row = this.database.prepare("SELECT last_claude_message_uuid FROM turns WHERE id = ? AND thread_id = ?")
      .get(turnId, threadId) as unknown as { last_claude_message_uuid: string | null } | undefined;
    return row?.last_claude_message_uuid ?? undefined;
  }

  public truncateTurns(threadId: string, keepCount: number): void {
    this.database.prepare("DELETE FROM turns WHERE thread_id = ? AND ordinal >= ?").run(threadId, keepCount);
  }

  public commitForkedThread(
    record: ClaudeThreadRecord,
    turns: readonly Turn[],
    boundaries: readonly TurnProviderBoundary[],
  ): void {
    this.transaction(() => {
      this.createThread(record);
      for (const turn of turns) this.insertTurn(record.thread.id, turn);
      for (const boundary of boundaries) {
        this.setTurnClaudeMessageUuid(record.thread.id, boundary.turnId, boundary.messageUuid);
      }
    });
  }

  public commitThreadRollback(
    record: ClaudeThreadRecord,
    keepCount: number,
    boundaries: readonly TurnProviderBoundary[],
    removedThreadIds: readonly string[] = [],
  ): void {
    this.transaction(() => {
      for (const threadId of removedThreadIds) this.deleteThreadRows(threadId);
      this.truncateTurns(record.thread.id, keepCount);
      for (const boundary of boundaries) {
        this.setTurnClaudeMessageUuid(record.thread.id, boundary.turnId, boundary.messageUuid);
      }
      this.updateThread(record);
    });
  }

  public commitThreadState(commit: ThreadStateCommit): number[] {
    return this.transaction(() => {
      this.updateThread(commit.record);
      if (commit.turn) {
        if (commit.insertTurn) this.insertTurn(commit.record.thread.id, commit.turn);
        else this.writeTurn(commit.record.thread.id, commit.turn);
      }
      if (commit.providerBoundary) {
        const boundary = commit.providerBoundary;
        this.setTurnClaudeMessageUuid(boundary.ownerThreadId, boundary.turnId, boundary.messageUuid);
        this.insertProviderItems(
          commit.record.thread.id,
          boundary.messageUuid,
          boundary.ownerThreadId,
          boundary.turnId,
          boundary.itemIds ?? [],
        );
      }
      return commit.events.map((event) => this.insertEvent(
        commit.record.thread.id,
        event.turnId,
        event.method,
        event.params,
        event,
      ));
    });
  }

  public appendEvent(
    threadId: string,
    turnId: string | null,
    method: string,
    params: unknown,
    persistence?: EventPersistence,
  ): number {
    return this.transaction(() => this.insertEvent(threadId, turnId, method, params, persistence));
  }

  public eventHighWatermark(threadId: string): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE thread_id = ?")
      .get(threadId) as unknown as { sequence: number };
    return row.sequence;
  }

  public listEventsAfter(threadId: string, sequence: number): StoredEvent[] {
    const rows = this.database.prepare(`
      SELECT sequence, thread_id, turn_id, method, params_json, created_at
      FROM events
      WHERE thread_id = ? AND sequence > ? AND method NOT LIKE 'hybrid/%'
      ORDER BY sequence ASC
    `).all(threadId, sequence) as unknown as EventRow[];
    return rows.map((row) => ({
      sequence: row.sequence,
      threadId: row.thread_id,
      turnId: row.turn_id,
      method: row.method,
      params: JSON.parse(row.params_json) as unknown,
      createdAt: row.created_at,
    }));
  }

  public hasProcessedProviderEvent(threadId: string, providerEventId: string): boolean {
    return this.database.prepare(`
      SELECT 1 FROM events
      WHERE thread_id = ? AND provider_event_id = ? AND method = 'hybrid/providerMessage/processed'
    `).get(threadId, providerEventId) !== undefined;
  }

  public markProviderEventProcessed(threadId: string, providerEventType: string, providerEventId: string): void {
    this.appendEvent(threadId, null, "hybrid/providerMessage/processed", {}, {
      providerEventType, providerEventId, dedupKey: `provider:${providerEventId}`,
    });
  }

  public appendProviderEvent(event: AppendProviderEvent): { record: ProviderEventRecord; inserted: boolean } {
    return this.transaction(() => {
      const existing = event.providerEventId === null ? undefined : this.database.prepare(`
        SELECT * FROM provider_events WHERE thread_id = ? AND provider_event_id = ?
      `).get(event.threadId, event.providerEventId) as unknown as ProviderEventRow | undefined;
      if (existing) return { record: parseProviderEvent(existing), inserted: false };
      const result = this.database.prepare(`
        INSERT INTO provider_events (
          thread_id, process_epoch, provider_sequence, provider_event_type,
          provider_event_id, payload_json, disposition, error, created_at, projected_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
      `).run(
        event.threadId, event.processEpoch, event.providerSequence, event.providerEventType,
        event.providerEventId, json(event.payload), event.createdAt,
      );
      const row = this.database.prepare("SELECT * FROM provider_events WHERE sequence = ?")
        .get(Number(result.lastInsertRowid)) as unknown as ProviderEventRow;
      return { record: parseProviderEvent(row), inserted: true };
    });
  }

  public completeProviderEvent(
    threadId: string,
    sequence: number,
    disposition: Exclude<ProviderEventDisposition, "pending">,
    error: string | null = null,
  ): void {
    this.database.prepare(`
      UPDATE provider_events SET disposition = ?, error = ?, projected_at = ? WHERE thread_id = ? AND sequence = ?
    `).run(disposition, error, Date.now(), threadId, sequence);
  }

  public listProviderEvents(threadId: string, disposition?: ProviderEventDisposition): ProviderEventRecord[] {
    const rows = (disposition
      ? this.database.prepare("SELECT * FROM provider_events WHERE thread_id = ? AND disposition = ? ORDER BY sequence")
        .all(threadId, disposition)
      : this.database.prepare("SELECT * FROM provider_events WHERE thread_id = ? ORDER BY sequence").all(threadId)
    ) as unknown as ProviderEventRow[];
    return rows.map(parseProviderEvent);
  }

  public pruneProviderEvents(threadId: string, maxEvents: number, maxBytes: number): number {
    if (maxEvents < 1) throw new Error("Provider event retention must keep at least one event.");
    const result = this.database.prepare(`
      DELETE FROM provider_events
      WHERE thread_id = ?
        AND disposition IN ('projected', 'stateOnly', 'retainedOnly', 'unsupportedVisible')
        AND sequence IN (
          SELECT sequence FROM (
            SELECT sequence,
                   ROW_NUMBER() OVER (ORDER BY sequence DESC) AS ordinal,
                   SUM(LENGTH(CAST(payload_json AS BLOB))) OVER (ORDER BY sequence DESC) AS retained_bytes
            FROM provider_events
            WHERE thread_id = ?
              AND disposition IN ('projected', 'stateOnly', 'retainedOnly', 'unsupportedVisible')
          )
          WHERE ordinal > ? OR (ordinal > 1 AND retained_bytes > ?)
        )
    `).run(threadId, threadId, maxEvents, maxBytes);
    return Number(result.changes);
  }

  public linkProviderItems(threadId: string, providerMessageId: string, ownerThreadId: string, turnId: string, itemIds: readonly string[]): void {
    this.transaction(() => this.insertProviderItems(threadId, providerMessageId, ownerThreadId, turnId, itemIds));
  }

  private insertProviderItems(
    threadId: string,
    providerMessageId: string,
    ownerThreadId: string,
    turnId: string,
    itemIds: readonly string[],
  ): void {
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO provider_item_correlations (
        thread_id, provider_message_id, owner_thread_id, turn_id, item_id
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const itemId of itemIds) insert.run(threadId, providerMessageId, ownerThreadId, turnId, itemId);
  }

  public listProviderItemCorrelations(threadId: string, providerMessageIds: readonly string[]): ProviderItemCorrelation[] {
    if (providerMessageIds.length === 0) return [];
    const placeholders = providerMessageIds.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT provider_message_id, owner_thread_id, turn_id, item_id
      FROM provider_item_correlations
      WHERE thread_id = ? AND provider_message_id IN (${placeholders})
    `).all(threadId, ...providerMessageIds) as unknown as Array<{
      provider_message_id: string; owner_thread_id: string; turn_id: string; item_id: string;
    }>;
    return rows.map((row) => ({
      providerMessageId: row.provider_message_id,
      ownerThreadId: row.owner_thread_id,
      turnId: row.turn_id,
      itemId: row.item_id,
    }));
  }

  public deleteProviderItemCorrelations(threadId: string, providerMessageIds: readonly string[]): void {
    if (providerMessageIds.length === 0) return;
    const placeholders = providerMessageIds.map(() => "?").join(", ");
    this.database.prepare(`
      DELETE FROM provider_item_correlations
      WHERE thread_id = ? AND provider_message_id IN (${placeholders})
    `).run(threadId, ...providerMessageIds);
  }

  public commitProviderRetraction(
    record: ClaudeThreadRecord,
    providerMessageIds: readonly string[],
    mutations: readonly ProviderRetractionMutation[],
    removedThreadIds: readonly string[] = [],
  ): void {
    this.transaction(() => {
      for (const threadId of removedThreadIds) this.deleteThreadRows(threadId);
      for (const mutation of mutations) {
        this.writeTurn(mutation.ownerThreadId, mutation.turn);
        if (mutation.clearBoundary) {
          this.database.prepare(`
            UPDATE turns SET last_claude_message_uuid = NULL
            WHERE id = ? AND thread_id = ?
          `).run(mutation.turn.id, mutation.ownerThreadId);
        }
      }
      this.deleteProviderItemCorrelations(record.thread.id, providerMessageIds);
      this.updateThread(record);
    });
  }

  public createPendingRequest(request: PendingRequestRecord): void {
    this.database.prepare(`
      INSERT INTO pending_requests (
        request_id, thread_id, turn_id, claude_request_id, method, params_json,
        status, response_json, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.requestId, request.threadId, request.turnId, request.claudeRequestId,
      request.method, json(request.params), request.status,
      request.response === null ? null : json(request.response), request.createdAt, request.resolvedAt,
    );
  }

  public getPendingRequest(requestId: string): PendingRequestRecord | undefined {
    const row = this.database.prepare("SELECT * FROM pending_requests WHERE request_id = ?").get(requestId) as unknown as PendingRequestRow | undefined;
    return row ? parsePending(row) : undefined;
  }

  public findPendingRequestByClaudeId(threadId: string, claudeRequestId: string): PendingRequestRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM pending_requests
      WHERE thread_id = ? AND claude_request_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(threadId, claudeRequestId) as unknown as PendingRequestRow | undefined;
    return row ? parsePending(row) : undefined;
  }

  public listPendingRequests(threadId: string): PendingRequestRecord[] {
    const rows = this.database.prepare("SELECT * FROM pending_requests WHERE thread_id = ? AND status = 'pending' ORDER BY created_at ASC")
      .all(threadId) as unknown as PendingRequestRow[];
    return rows.map(parsePending);
  }

  public resolvePendingRequest(requestId: string, status: "resolved" | "cancelled", response: unknown): void {
    this.database.prepare("UPDATE pending_requests SET status = ?, response_json = ?, resolved_at = ? WHERE request_id = ? AND status = 'pending'")
      .run(status, json(response), Date.now(), requestId);
  }

  public getGoal(threadId: string): InternalGoal | undefined {
    const row = this.database.prepare("SELECT goal_json FROM goals WHERE thread_id = ?").get(threadId) as unknown as { goal_json: string } | undefined;
    if (!row) return undefined;
    const stored = JSON.parse(row.goal_json) as InternalGoal;
    if (stored.goalId) return stored;
    const migrated = { ...stored, goalId: uuidv7() };
    this.database.prepare("UPDATE goals SET goal_json = ? WHERE thread_id = ?").run(json(migrated), threadId);
    return migrated;
  }

  public setGoal(threadId: string, patch: GoalPatch): InternalGoal {
    return this.transaction(() => {
      const previous = this.getGoal(threadId);
      const now = patch.now ?? Math.floor(Date.now() / 1_000);
      const replace = patch.replace === true || !previous;
      if (replace && patch.objective === undefined) throw new Error(`cannot create goal for thread ${threadId} without an objective`);
      const goal: InternalGoal = {
        threadId,
        goalId: replace ? uuidv7() : previous.goalId,
        objective: patch.objective ?? previous?.objective ?? "",
        status: patch.status ?? (replace ? "active" : previous.status),
        tokenBudget: patch.tokenBudget === undefined ? (replace ? null : previous.tokenBudget) : patch.tokenBudget,
        tokensUsed: replace ? 0 : previous.tokensUsed,
        timeUsedSeconds: replace ? 0 : previous.timeUsedSeconds,
        createdAt: replace ? now : previous.createdAt,
        updatedAt: now,
      };
      if (goal.status === "active" && goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) goal.status = "budgetLimited";
      this.database.prepare(`
        INSERT INTO goals (thread_id, goal_json) VALUES (?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET goal_json = excluded.goal_json
      `).run(threadId, json(goal));
      return goal;
    });
  }

  public clearGoal(threadId: string): boolean {
    return Number(this.database.prepare("DELETE FROM goals WHERE thread_id = ?").run(threadId).changes) > 0;
  }

  public accountGoalUsage(input: GoalUsageInput): InternalGoal | undefined {
    return this.transaction(() => {
      if (input.checkpointKey) {
        const inserted = this.database.prepare(`
          INSERT OR IGNORE INTO goal_checkpoints (thread_id, goal_id, checkpoint_key)
          VALUES (?, ?, ?)
        `).run(input.threadId, input.expectedGoalId, input.checkpointKey);
        if (Number(inserted.changes) === 0) return this.getGoal(input.threadId);
      }
      const previous = this.getGoal(input.threadId);
      if (!previous || previous.goalId !== input.expectedGoalId) return previous;
      if (previous.status !== "active" && previous.status !== "budgetLimited") return previous;
      const goal: InternalGoal = {
        ...previous,
        tokensUsed: previous.tokensUsed + Math.max(0, input.tokenDelta),
        timeUsedSeconds: previous.timeUsedSeconds + Math.max(0, input.timeDeltaSeconds),
        updatedAt: Math.floor(Date.now() / 1_000),
      };
      if (goal.status === "active" && goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) goal.status = "budgetLimited";
      this.database.prepare("UPDATE goals SET goal_json = ? WHERE thread_id = ?").run(json(goal), input.threadId);
      return goal;
    });
  }

  public close(): void {
    try {
      this.backup();
    } finally {
      this.database.close();
    }
  }

  private transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private insertEvent(
    threadId: string,
    turnId: string | null,
    method: string,
    params: unknown,
    persistence?: EventPersistence,
  ): number {
    if (persistence?.dedupKey) {
      const found = this.database.prepare("SELECT 1 FROM events WHERE thread_id = ? AND dedup_key = ?")
        .get(threadId, persistence.dedupKey);
      if (found) return 0;
    }
    if (persistence?.turn) this.writeTurn(threadId, persistence.turn);
    const result = this.database.prepare(`
      INSERT INTO events (
        event_id, thread_id, turn_id, method, params_json, provider_event_type,
        provider_event_id, dedup_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv7(), threadId, turnId, method, json(params), persistence?.providerEventType ?? null,
      persistence?.providerEventId ?? null, persistence?.dedupKey ?? null, Date.now(),
    );
    return Number(result.lastInsertRowid);
  }

  private deleteThreadRows(threadId: string): void {
    this.database.prepare("DELETE FROM provider_item_correlations WHERE owner_thread_id = ?").run(threadId);
    this.database.prepare("DELETE FROM goals WHERE thread_id = ?").run(threadId);
    this.database.prepare("DELETE FROM pending_requests WHERE thread_id = ?").run(threadId);
    this.database.prepare("DELETE FROM events WHERE thread_id = ?").run(threadId);
    this.database.prepare("DELETE FROM turns WHERE thread_id = ?").run(threadId);
    this.database.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
  }

  private writeTurn(threadId: string, turn: Turn): void {
    this.database.prepare("UPDATE turns SET status = ?, turn_json = ? WHERE id = ? AND thread_id = ?")
      .run(turn.status, json(turn), turn.id, threadId);
    this.syncItems(threadId, turn);
  }

  private insertTurn(threadId: string, turn: Turn): void {
    const ordinalRow = this.database.prepare("SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM turns WHERE thread_id = ?")
      .get(threadId) as unknown as { ordinal: number };
    this.database.prepare("INSERT INTO turns (id, thread_id, ordinal, status, turn_json) VALUES (?, ?, ?, ?, ?)")
      .run(turn.id, threadId, ordinalRow.ordinal, turn.status, json(turn));
    this.syncItems(threadId, turn);
  }

  private syncItems(threadId: string, turn: Turn): void {
    this.database.prepare("DELETE FROM items WHERE turn_id = ? AND thread_id = ?").run(turn.id, threadId);
    const insert = this.database.prepare(`
      INSERT INTO items (
        id, thread_id, turn_id, ordinal, type, status, payload_json,
        provider_item_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const timestamp = Date.now();
    turn.items.forEach((item, ordinal) => insert.run(
      item.id, threadId, turn.id, ordinal, item.type,
      "status" in item && typeof item.status === "string" ? item.status : null,
      json(item), null, timestamp, timestamp,
    ));
  }

  private backup(): void {
    const backup = `${this.path}.bak`;
    if (existsSync(backup)) unlinkSync(backup);
    this.database.exec(`VACUUM INTO ${sqlString(backup)}`);
    chmodSync(backup, 0o600);
  }

  private migrate(): void {
    this.transaction(() => {
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        claude_session_id TEXT NOT NULL,
        model_picker_id TEXT NOT NULL,
        claude_model_value TEXT NOT NULL,
        service_tier TEXT,
        cwd TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        ephemeral INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        thread_json TEXT NOT NULL,
        approval_policy_json TEXT NOT NULL,
        sandbox_policy_json TEXT NOT NULL,
        base_instructions TEXT,
        developer_instructions TEXT,
        personality TEXT
        ,resolved_model TEXT
        ,last_claude_message_uuid TEXT
        ,last_completed_turn_id TEXT
        ,claude_code_version TEXT
        ,runtime_settings_json TEXT
        ,deletion_pending INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        turn_json TEXT NOT NULL,
        last_claude_message_uuid TEXT,
        UNIQUE(thread_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        method TEXT NOT NULL,
        params_json TEXT NOT NULL,
        provider_event_type TEXT,
        provider_event_id TEXT,
        dedup_key TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT,
        payload_json TEXT NOT NULL,
        provider_item_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(turn_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS pending_requests (
        request_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        claude_request_id TEXT,
        method TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL,
        response_json TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS pending_requests_claude_id
        ON pending_requests(thread_id, claude_request_id, status);
      CREATE TABLE IF NOT EXISTS goals (
        thread_id TEXT PRIMARY KEY,
        goal_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goal_checkpoints (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        goal_id TEXT NOT NULL,
        checkpoint_key TEXT NOT NULL,
        PRIMARY KEY(thread_id, goal_id, checkpoint_key)
      );
      CREATE TABLE IF NOT EXISTS provider_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        process_epoch TEXT NOT NULL,
        provider_sequence INTEGER NOT NULL,
        provider_event_type TEXT NOT NULL,
        provider_event_id TEXT,
        payload_json TEXT NOT NULL,
        disposition TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        projected_at INTEGER,
        UNIQUE(thread_id, process_epoch, provider_sequence)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS provider_events_thread_event_id
        ON provider_events(thread_id, provider_event_id) WHERE provider_event_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS provider_item_correlations (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        provider_message_id TEXT NOT NULL,
        owner_thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        PRIMARY KEY(thread_id, provider_message_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS provider_item_correlations_owner
        ON provider_item_correlations(owner_thread_id, turn_id);
      CREATE TABLE IF NOT EXISTS pending_thread_removals (
        root_thread_id TEXT PRIMARY KEY,
        claude_session_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        kind TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
    `);
      this.ensureColumn("threads", "resolved_model", "TEXT");
      this.ensureColumn("threads", "last_claude_message_uuid", "TEXT");
      this.ensureColumn("threads", "last_completed_turn_id", "TEXT");
      this.ensureColumn("threads", "claude_code_version", "TEXT");
      this.ensureColumn("threads", "runtime_settings_json", "TEXT");
      this.ensureColumn("threads", "deletion_pending", "INTEGER NOT NULL DEFAULT 0");
      const threadColumns = new Set((this.database.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>)
        .map((column) => column.name));
      if (threadColumns.has("claude_session_id") && threadColumns.has("cwd")) {
        this.database.exec(`
          INSERT OR IGNORE INTO pending_thread_removals (root_thread_id, claude_session_id, cwd, kind)
          SELECT id, claude_session_id, cwd, 'delete' FROM threads WHERE deletion_pending = 1
        `);
      }
      this.ensureColumn("turns", "last_claude_message_uuid", "TEXT");
      this.ensureColumn("events", "event_id", "TEXT");
      this.ensureColumn("events", "provider_event_type", "TEXT");
      this.ensureColumn("events", "provider_event_id", "TEXT");
      this.ensureColumn("events", "dedup_key", "TEXT");
      this.database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS events_thread_dedup
          ON events(thread_id, dedup_key) WHERE dedup_key IS NOT NULL;
        INSERT OR IGNORE INTO schema_migrations(version) VALUES (2);
      `);
      const threadScopedIds = this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get();
      if (!threadScopedIds) this.migrateThreadScopedIds();
      this.database.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (4)");
      this.database.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (5)");
      this.database.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (6)");
    });
  }

  private migrateThreadScopedIds(): void {
    this.database.exec(`
      CREATE TABLE turns_v3 (
        id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        turn_json TEXT NOT NULL,
        last_claude_message_uuid TEXT,
        PRIMARY KEY(thread_id, id),
        UNIQUE(thread_id, ordinal)
      );
      INSERT INTO turns_v3 (
        id, thread_id, ordinal, status, turn_json, last_claude_message_uuid
      ) SELECT id, thread_id, ordinal, status, turn_json, last_claude_message_uuid FROM turns;

      CREATE TABLE items_v3 (
        id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT,
        payload_json TEXT NOT NULL,
        provider_item_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, id),
        FOREIGN KEY(thread_id, turn_id) REFERENCES turns_v3(thread_id, id) ON DELETE CASCADE,
        UNIQUE(thread_id, turn_id, ordinal)
      );
      INSERT INTO items_v3 (
        id, thread_id, turn_id, ordinal, type, status, payload_json,
        provider_item_id, created_at, updated_at
      ) SELECT
        id, thread_id, turn_id, ordinal, type, status, payload_json,
        provider_item_id, created_at, updated_at
      FROM items;

      DROP TABLE items;
      DROP TABLE turns;
      ALTER TABLE turns_v3 RENAME TO turns;
      ALTER TABLE items_v3 RENAME TO items;
      INSERT INTO schema_migrations(version) VALUES (3);
    `);
    const violations = this.database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) throw new Error("SQLite migration 3 violated foreign-key integrity");
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((candidate) => candidate.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}
