import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Thread } from "../codex/generated/v2/Thread.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import type { ProviderKind, ProviderEpochState } from "./store.js";

const SCHEMA_VERSION = 2;

export interface PublicTaskIdentity {
  readonly publicThreadId: string;
  readonly currentEpochId: string;
  readonly revision: number;
  readonly sessionId: string;
  readonly forkedFromId?: string;
  readonly parentThreadId?: string;
}

export interface EpochBoundary {
  readonly epochId: string;
  readonly publicThreadId: string;
  readonly ordinal: number;
  readonly provider: ProviderKind;
  readonly backendThreadId: string;
  readonly state: ProviderEpochState;
  readonly startTurnId?: string;
  readonly endTurnId?: string;
  readonly archivePending: boolean;
  readonly deleteDone: boolean;
}

export interface LegacyBackendRef {
  readonly provider: ProviderKind;
  readonly backendThreadId: string;
}

export interface ProviderSegment {
  readonly kind: "provider";
  readonly position: number;
  readonly epochId: string;
  readonly startTurnId: string;
  readonly endTurnId: string;
}

export interface SyntheticSegment {
  readonly kind: "synthetic";
  readonly position: number;
  readonly publicTurnId: string;
  readonly turn: Turn;
}

export type TranscriptSegment = ProviderSegment | SyntheticSegment;
export type NewTranscriptSegment =
  | Omit<ProviderSegment, "position">
  | Omit<SyntheticSegment, "position">;

export interface NewEpochBoundary {
  readonly epochId: string;
  readonly provider: ProviderKind;
  readonly backendThreadId: string;
  readonly state?: ProviderEpochState;
}

export interface SwitchJournal {
  readonly jobId: string;
  readonly publicThreadId: string;
  readonly expectedEpochId: string;
  readonly expectedThreadRevision: number;
  readonly pendingRevision: number;
  readonly targetProvider: ProviderKind;
  readonly targetModel: string;
  readonly status: "queued" | "running" | "targetCreated" | "committed" | "failed";
  readonly payload?: Record<string, unknown>;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface LegacyThreadRow {
  public_thread_id: string;
  current_epoch_id: string;
  thread_json: string;
  revision: number;
}

interface LegacyEpochRow {
  epoch_id: string;
  public_thread_id: string;
  ordinal: number;
  provider: ProviderKind;
  backend_thread_id: string;
  state: ProviderEpochState;
  archive_pending: number;
  delete_done: number;
}

interface LegacyTurnRow {
  public_thread_id: string;
  position: number;
  public_turn_id: string;
  epoch_id: string | null;
  provider_turn_id: string | null;
  turn_json: string;
  kind: "provider" | "migrationCompact";
}

interface TaskRow {
  public_thread_id: string;
  current_epoch_id: string;
  revision: number;
  session_id: string;
  forked_from_id: string | null;
  parent_thread_id: string | null;
}

interface EpochRow {
  epoch_id: string;
  public_thread_id: string;
  ordinal: number;
  provider: ProviderKind;
  backend_thread_id: string;
  state: ProviderEpochState;
  start_turn_id: string | null;
  end_turn_id: string | null;
  archive_pending: number;
  delete_done: number;
}

interface SegmentRow {
  position: number;
  kind: "provider" | "synthetic";
  epoch_id: string | null;
  start_turn_id: string | null;
  end_turn_id: string | null;
  public_turn_id: string | null;
  synthetic_turn_json: string | null;
}

interface JournalRow {
  job_id: string;
  public_thread_id: string;
  expected_epoch_id: string;
  expected_thread_revision: number;
  pending_revision: number;
  target_provider: ProviderKind;
  target_model: string;
  status: SwitchJournal["status"];
  payload_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Minimal cross-provider source of truth.
 *
 * Provider-owned Thread, Turn and settings payloads deliberately have no column
 * in this schema. Provider segments retain only the boundary IDs needed to read
 * and slice the native provider transcript. Full JSON is accepted only for
 * CCodex-owned synthetic turns and an unfinished switch transaction journal.
 */
export class LineageStore {
  private readonly database: DatabaseSync;

  public constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
    `);
    chmodSync(path, 0o600);
    if (this.needsLegacyMigration()) return;
    this.createSchema();
    if (this.userVersion() < SCHEMA_VERSION) this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  public close(): void { this.database.close(); }

  public createTask(identity: Omit<PublicTaskIdentity, "revision">, epoch: NewEpochBoundary): PublicTaskIdentity {
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO lineage_tasks (
          public_thread_id, current_epoch_id, revision, session_id, forked_from_id, parent_thread_id
        ) VALUES (?, ?, 1, ?, ?, ?)
      `).run(
        identity.publicThreadId, identity.currentEpochId, identity.sessionId,
        identity.forkedFromId ?? null, identity.parentThreadId ?? null,
      );
      this.database.prepare(`
        INSERT INTO lineage_epochs (
          epoch_id, public_thread_id, ordinal, provider, backend_thread_id, state,
          archive_pending, delete_done
        ) VALUES (?, ?, 0, ?, ?, ?, 0, 0)
      `).run(
        epoch.epochId, identity.publicThreadId, epoch.provider, epoch.backendThreadId,
        epoch.state ?? "current",
      );
      return this.getTask(identity.publicThreadId)!;
    });
  }

  public getTask(publicThreadId: string): PublicTaskIdentity | undefined {
    const row = this.database.prepare(`
      SELECT * FROM lineage_tasks WHERE public_thread_id = ?
    `).get(publicThreadId) as unknown as TaskRow | undefined;
    return row ? this.taskFromRow(row) : undefined;
  }

  public listTasks(): PublicTaskIdentity[] {
    return (this.database.prepare(`
      SELECT * FROM lineage_tasks ORDER BY public_thread_id ASC
    `).all() as unknown as TaskRow[]).map((row) => this.taskFromRow(row));
  }

  public getEpoch(epochId: string): EpochBoundary | undefined {
    const row = this.database.prepare(`
      SELECT * FROM lineage_epochs WHERE epoch_id = ?
    `).get(epochId) as unknown as EpochRow | undefined;
    return row ? this.epochFromRow(row) : undefined;
  }

  public listMappings(): EpochBoundary[] {
    return (this.database.prepare(`
      SELECT * FROM lineage_epochs ORDER BY public_thread_id ASC, ordinal ASC
    `).all() as unknown as EpochRow[]).map((row) => this.epochFromRow(row));
  }

  public listEpochs(publicThreadId: string): EpochBoundary[] {
    return (this.database.prepare(`
      SELECT * FROM lineage_epochs WHERE public_thread_id = ? ORDER BY ordinal ASC
    `).all(publicThreadId) as unknown as EpochRow[]).map((row) => this.epochFromRow(row));
  }

  public findEpoch(provider: ProviderKind, backendThreadId: string): EpochBoundary | undefined {
    const row = this.database.prepare(`
      SELECT * FROM lineage_epochs WHERE provider = ? AND backend_thread_id = ?
    `).get(provider, backendThreadId) as unknown as EpochRow | undefined;
    return row ? this.epochFromRow(row) : undefined;
  }

  public pendingStockArchives(): EpochBoundary[] {
    return this.listMappings().filter((epoch) => epoch.provider === "stock" && epoch.archivePending);
  }

  public markStockArchived(epochId: string): boolean {
    return Number(this.database.prepare(`
      UPDATE lineage_epochs SET archive_pending = 0 WHERE epoch_id = ? AND provider = 'stock'
    `).run(epochId).changes) === 1;
  }

  public markEpochDeleted(epochId: string): boolean {
    return Number(this.database.prepare(`
      UPDATE lineage_epochs SET delete_done = 1 WHERE epoch_id = ?
    `).run(epochId).changes) === 1;
  }

  public epochBelongsToLineage(publicThreadId: string, epochId: string): boolean {
    return this.database.prepare(`
      SELECT 1 FROM lineage_epochs WHERE epoch_id = ? AND public_thread_id = ?
      UNION ALL
      SELECT 1 FROM lineage_segments WHERE public_thread_id = ? AND epoch_id = ?
      LIMIT 1
    `).get(epochId, publicThreadId, publicThreadId, epochId) !== undefined;
  }

  public epochReferenceCount(epochId: string): number {
    const current = (this.database.prepare(`
      SELECT COUNT(*) AS count FROM lineage_tasks WHERE current_epoch_id = ?
    `).get(epochId) as unknown as { count: number }).count;
    const segments = (this.database.prepare(`
      SELECT COUNT(DISTINCT public_thread_id) AS count FROM lineage_segments WHERE epoch_id = ?
    `).get(epochId) as unknown as { count: number }).count;
    return current + segments;
  }

  public taskEpochs(publicThreadId: string): EpochBoundary[] {
    return (this.database.prepare(`
      SELECT DISTINCT epoch.* FROM lineage_epochs epoch
      LEFT JOIN lineage_segments segment ON segment.epoch_id = epoch.epoch_id
      WHERE epoch.public_thread_id = ? OR segment.public_thread_id = ?
      ORDER BY epoch.public_thread_id ASC, epoch.ordinal ASC
    `).all(publicThreadId, publicThreadId) as unknown as EpochRow[])
      .map((row) => this.epochFromRow(row));
  }

  public deleteTask(publicThreadId: string): boolean {
    return this.transaction(() => {
      const deleted = Number(this.database.prepare(`
        DELETE FROM lineage_tasks WHERE public_thread_id = ?
      `).run(publicThreadId).changes) === 1;
      if (!deleted) return false;
      this.database.prepare(`
        DELETE FROM lineage_epochs
        WHERE delete_done = 1
          AND epoch_id NOT IN (SELECT current_epoch_id FROM lineage_tasks)
          AND epoch_id NOT IN (SELECT epoch_id FROM lineage_segments WHERE epoch_id IS NOT NULL)
      `).run();
      return true;
    });
  }

  public createForkTask(
    identity: Omit<PublicTaskIdentity, "revision">,
    epoch: NewEpochBoundary,
    inheritedSegments: readonly NewTranscriptSegment[],
  ): PublicTaskIdentity {
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO lineage_tasks (
          public_thread_id, current_epoch_id, revision, session_id, forked_from_id, parent_thread_id
        ) VALUES (?, ?, 1, ?, ?, ?)
      `).run(
        identity.publicThreadId, identity.currentEpochId, identity.sessionId,
        identity.forkedFromId ?? null, identity.parentThreadId ?? null,
      );
      this.database.prepare(`
        INSERT INTO lineage_epochs (
          epoch_id, public_thread_id, ordinal, provider, backend_thread_id, state,
          archive_pending, delete_done
        ) VALUES (?, ?, 0, ?, ?, ?, 0, 0)
      `).run(
        epoch.epochId, identity.publicThreadId, epoch.provider, epoch.backendThreadId,
        epoch.state ?? "current",
      );
      inheritedSegments.forEach((segment, position) => this.insertSegment(
        identity.publicThreadId, position, segment,
      ));
      return this.getTask(identity.publicThreadId)!;
    });
  }

  public listSegments(publicThreadId: string): TranscriptSegment[] {
    return (this.database.prepare(`
      SELECT * FROM lineage_segments WHERE public_thread_id = ? ORDER BY position ASC
    `).all(publicThreadId) as unknown as SegmentRow[]).map((row) => row.kind === "provider" ? {
      kind: "provider",
      position: row.position,
      epochId: row.epoch_id!,
      startTurnId: row.start_turn_id!,
      endTurnId: row.end_turn_id!,
    } : {
      kind: "synthetic",
      position: row.position,
      publicTurnId: row.public_turn_id!,
      turn: JSON.parse(row.synthetic_turn_json!) as Turn,
    });
  }

  public replaceSegments(
    publicThreadId: string,
    expectedRevision: number,
    segments: readonly NewTranscriptSegment[],
  ): boolean {
    return this.transaction(() => {
      const task = this.getTask(publicThreadId);
      if (!task || task.revision !== expectedRevision) return false;
      this.database.prepare("DELETE FROM lineage_segments WHERE public_thread_id = ?").run(publicThreadId);
      segments.forEach((segment, position) => this.insertSegment(publicThreadId, position, segment));
      return Number(this.database.prepare(`
        UPDATE lineage_tasks SET revision = revision + 1
        WHERE public_thread_id = ? AND revision = ?
      `).run(publicThreadId, expectedRevision).changes) === 1;
    });
  }

  public commitEpoch(
    publicThreadId: string,
    expectedEpochId: string,
    expectedRevision: number,
    sourceBoundary: { readonly startTurnId: string; readonly endTurnId: string },
    target: NewEpochBoundary,
    syntheticTurns: readonly { readonly publicTurnId: string; readonly turn: Turn }[] = [],
  ): PublicTaskIdentity | undefined {
    return this.transaction(() => {
      const task = this.getTask(publicThreadId);
      if (!task || task.currentEpochId !== expectedEpochId || task.revision !== expectedRevision) return undefined;
      const ordinal = (this.database.prepare(`
        SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
        FROM lineage_epochs WHERE public_thread_id = ?
      `).get(publicThreadId) as unknown as { ordinal: number }).ordinal;
      const sealed = this.database.prepare(`
        UPDATE lineage_epochs SET state = 'sealed', start_turn_id = ?, end_turn_id = ?,
          archive_pending = CASE WHEN provider = 'stock' THEN 1 ELSE 0 END
        WHERE epoch_id = ? AND public_thread_id = ? AND state = 'current'
      `).run(sourceBoundary.startTurnId, sourceBoundary.endTurnId, expectedEpochId, publicThreadId);
      if (Number(sealed.changes) !== 1) return undefined;
      this.database.prepare(`
        INSERT INTO lineage_epochs (
          epoch_id, public_thread_id, ordinal, provider, backend_thread_id, state,
          archive_pending, delete_done
        ) VALUES (?, ?, ?, ?, ?, 'current', 0, 0)
      `).run(target.epochId, publicThreadId, ordinal, target.provider, target.backendThreadId);
      const nextPosition = (this.database.prepare(`
        SELECT COALESCE(MAX(position), -1) + 1 AS position
        FROM lineage_segments WHERE public_thread_id = ?
      `).get(publicThreadId) as unknown as { position: number }).position;
      this.insertSegment(publicThreadId, nextPosition, {
        kind: "provider",
        epochId: expectedEpochId,
        startTurnId: sourceBoundary.startTurnId,
        endTurnId: sourceBoundary.endTurnId,
      });
      syntheticTurns.forEach((synthetic, index) => this.insertSegment(publicThreadId, nextPosition + index + 1, {
        kind: "synthetic",
        publicTurnId: synthetic.publicTurnId,
        turn: synthetic.turn,
      }));
      const updated = this.database.prepare(`
        UPDATE lineage_tasks SET current_epoch_id = ?, revision = revision + 1
        WHERE public_thread_id = ? AND current_epoch_id = ? AND revision = ?
      `).run(target.epochId, publicThreadId, expectedEpochId, expectedRevision);
      if (Number(updated.changes) !== 1) throw new Error("Epoch commit lost its task CAS.");
      return this.getTask(publicThreadId)!;
    });
  }

  public putSwitchJournal(journal: SwitchJournal): void {
    const active = ["queued", "running", "targetCreated"].includes(journal.status);
    this.database.prepare(`
      INSERT INTO lineage_switch_jobs (
        job_id, public_thread_id, expected_epoch_id, expected_thread_revision, pending_revision,
        target_provider, target_model, status, payload_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        status = excluded.status,
        payload_json = excluded.payload_json,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run(
      journal.jobId, journal.publicThreadId, journal.expectedEpochId,
      journal.expectedThreadRevision, journal.pendingRevision, journal.targetProvider,
      journal.targetModel, journal.status, active ? JSON.stringify(journal.payload ?? {}) : null,
      journal.error ?? null, journal.createdAt, journal.updatedAt,
    );
  }

  public getSwitchJournal(jobId: string): SwitchJournal | undefined {
    const row = this.database.prepare(`
      SELECT * FROM lineage_switch_jobs WHERE job_id = ?
    `).get(jobId) as unknown as JournalRow | undefined;
    return row ? {
      jobId: row.job_id,
      publicThreadId: row.public_thread_id,
      expectedEpochId: row.expected_epoch_id,
      expectedThreadRevision: row.expected_thread_revision,
      pendingRevision: row.pending_revision,
      targetProvider: row.target_provider,
      targetModel: row.target_model,
      status: row.status,
      ...(row.payload_json ? { payload: JSON.parse(row.payload_json) as Record<string, unknown> } : {}),
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : undefined;
  }

  public needsLegacyMigration(): boolean {
    return this.userVersion() < SCHEMA_VERSION && this.hasTable("logical_threads");
  }

  public legacyBackendRefs(): LegacyBackendRef[] {
    if (!this.needsLegacyMigration() || !this.hasTable("provider_epochs")) return [];
    return (this.database.prepare(`
      SELECT DISTINCT provider, backend_thread_id FROM provider_epochs ORDER BY provider, backend_thread_id
    `).all() as unknown as Array<{ provider: ProviderKind; backend_thread_id: string }>).map((row) => ({
      provider: row.provider,
      backendThreadId: row.backend_thread_id,
    }));
  }

  public finalizeLegacyMigration(
    validated: ReadonlySet<string>,
    backupPath = `${this.path}.pre-lineage-v2.bak`,
  ): void {
    if (!this.needsLegacyMigration()) return;
    const missing = this.legacyBackendRefs().filter(
      (ref) => !validated.has(`${ref.provider}:${ref.backendThreadId}`),
    );
    if (missing.length > 0) {
      throw new Error(`Lineage migration requires validated provider backends: ${missing.map(
        (ref) => `${ref.provider}:${ref.backendThreadId}`,
      ).join(", ")}`);
    }
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (!existsSync(backupPath)) copyFileSync(this.path, backupPath, 0);
    this.transaction(() => {
      this.createSchema();
      if (this.hasTable("logical_threads")) this.importLegacyLineage();
      if (this.hasTable("provider_switch_jobs")) this.importLegacySwitchJobs();
      this.scrubLegacySnapshots();
      this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
    chmodSync(this.path, 0o600);
    chmodSync(backupPath, 0o600);
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS lineage_tasks (
        public_thread_id TEXT PRIMARY KEY,
        current_epoch_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        forked_from_id TEXT,
        parent_thread_id TEXT
      );
      CREATE TABLE IF NOT EXISTS lineage_epochs (
        epoch_id TEXT PRIMARY KEY,
        public_thread_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('claude', 'stock')),
        backend_thread_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('current', 'sealed', 'provisional')),
        start_turn_id TEXT,
        end_turn_id TEXT,
        archive_pending INTEGER NOT NULL DEFAULT 0,
        delete_done INTEGER NOT NULL DEFAULT 0,
        UNIQUE(public_thread_id, ordinal),
        UNIQUE(provider, backend_thread_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS lineage_epochs_one_current
        ON lineage_epochs(public_thread_id) WHERE state = 'current';
      CREATE TABLE IF NOT EXISTS lineage_segments (
        public_thread_id TEXT NOT NULL REFERENCES lineage_tasks(public_thread_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('provider', 'synthetic')),
        epoch_id TEXT REFERENCES lineage_epochs(epoch_id),
        start_turn_id TEXT,
        end_turn_id TEXT,
        public_turn_id TEXT,
        synthetic_turn_json TEXT,
        PRIMARY KEY(public_thread_id, position),
        CHECK((kind = 'provider' AND epoch_id IS NOT NULL AND start_turn_id IS NOT NULL
          AND end_turn_id IS NOT NULL AND public_turn_id IS NULL AND synthetic_turn_json IS NULL)
          OR (kind = 'synthetic' AND epoch_id IS NULL AND start_turn_id IS NULL
          AND end_turn_id IS NULL AND public_turn_id IS NOT NULL AND synthetic_turn_json IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS lineage_switch_jobs (
        job_id TEXT PRIMARY KEY,
        public_thread_id TEXT NOT NULL,
        expected_epoch_id TEXT NOT NULL,
        expected_thread_revision INTEGER NOT NULL,
        pending_revision INTEGER NOT NULL,
        target_provider TEXT NOT NULL CHECK(target_provider IN ('claude', 'stock')),
        target_model TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'targetCreated', 'committed', 'failed')),
        payload_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK((status IN ('queued', 'running', 'targetCreated') AND payload_json IS NOT NULL)
          OR (status IN ('committed', 'failed') AND payload_json IS NULL))
      );
    `);
  }

  private importLegacyLineage(): void {
    const threads = this.database.prepare("SELECT * FROM logical_threads")
      .all() as unknown as LegacyThreadRow[];
    for (const row of threads) {
      const thread = JSON.parse(row.thread_json) as Thread;
      this.database.prepare(`
        INSERT OR IGNORE INTO lineage_tasks (
          public_thread_id, current_epoch_id, revision, session_id, forked_from_id, parent_thread_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        row.public_thread_id, row.current_epoch_id, row.revision,
        thread.sessionId || row.public_thread_id, thread.forkedFromId, thread.parentThreadId,
      );
    }
    if (!this.hasTable("provider_epochs")) return;
    const epochs = this.database.prepare("SELECT * FROM provider_epochs ORDER BY public_thread_id, ordinal")
      .all() as unknown as LegacyEpochRow[];
    for (const row of epochs) {
      this.database.prepare(`
        INSERT OR IGNORE INTO lineage_epochs (
          epoch_id, public_thread_id, ordinal, provider, backend_thread_id, state,
          archive_pending, delete_done
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.epoch_id, row.public_thread_id, row.ordinal, row.provider, row.backend_thread_id,
        row.state, row.archive_pending ?? 0, row.delete_done ?? 0,
      );
    }
    if (!this.hasTable("logical_turns")) return;
    const turns = this.database.prepare("SELECT * FROM logical_turns ORDER BY public_thread_id, position")
      .all() as unknown as LegacyTurnRow[];
    for (const publicThreadId of new Set(turns.map((row) => row.public_thread_id))) {
      this.importLegacyTurns(publicThreadId, turns.filter((row) => row.public_thread_id === publicThreadId));
    }
  }

  private importLegacyTurns(publicThreadId: string, turns: LegacyTurnRow[]): void {
    let position = 0;
    let providerRun: { epochId: string; startTurnId: string; endTurnId: string } | undefined;
    const flush = (): void => {
      if (!providerRun) return;
      this.insertSegment(publicThreadId, position++, {
        kind: "provider",
        epochId: providerRun.epochId,
        startTurnId: providerRun.startTurnId,
        endTurnId: providerRun.endTurnId,
      });
      this.database.prepare(`
        UPDATE lineage_epochs SET
          start_turn_id = COALESCE(start_turn_id, ?), end_turn_id = ?
        WHERE epoch_id = ?
      `).run(providerRun.startTurnId, providerRun.endTurnId, providerRun.epochId);
      providerRun = undefined;
    };
    for (const row of turns) {
      if (row.kind === "provider" && row.epoch_id && row.provider_turn_id) {
        if (providerRun?.epochId === row.epoch_id) providerRun.endTurnId = row.provider_turn_id;
        else {
          flush();
          providerRun = {
            epochId: row.epoch_id,
            startTurnId: row.provider_turn_id,
            endTurnId: row.provider_turn_id,
          };
        }
        continue;
      }
      flush();
      this.insertSegment(publicThreadId, position++, {
        kind: "synthetic",
        publicTurnId: row.public_turn_id,
        turn: JSON.parse(row.turn_json) as Turn,
      });
    }
    flush();
  }

  private importLegacySwitchJobs(): void {
    const rows = this.database.prepare("SELECT * FROM provider_switch_jobs")
      .all() as unknown as Array<Record<string, unknown>>;
    for (const row of rows) {
      const status = row.status as SwitchJournal["status"];
      const active = ["queued", "running", "targetCreated"].includes(status);
      const payload = active ? {
        settings: parseJson(row.settings_json),
        turnParams: parseJson(row.turn_params_json),
        compactionTurn: parseJson(row.compaction_turn_json),
        summary: row.summary,
        targetBackendThreadId: row.target_backend_thread_id,
        targetProviderTurnId: row.target_provider_turn_id,
      } : undefined;
      this.putSwitchJournal({
        jobId: row.job_id as string,
        publicThreadId: row.public_thread_id as string,
        expectedEpochId: row.expected_epoch_id as string,
        expectedThreadRevision: row.expected_thread_revision as number,
        pendingRevision: row.pending_revision as number,
        targetProvider: row.target_provider as ProviderKind,
        targetModel: row.target_model as string,
        status,
        ...(payload ? { payload } : {}),
        ...(typeof row.error === "string" ? { error: row.error } : {}),
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      });
    }
  }

  private scrubLegacySnapshots(): void {
    if (this.hasTable("logical_threads")) {
      for (const task of this.database.prepare("SELECT * FROM lineage_tasks").all() as unknown as TaskRow[]) {
        this.database.prepare(`
          UPDATE logical_threads SET thread_json = ? WHERE public_thread_id = ?
        `).run(JSON.stringify({
          id: task.public_thread_id,
          sessionId: task.session_id,
          forkedFromId: task.forked_from_id,
          parentThreadId: task.parent_thread_id,
        }), task.public_thread_id);
      }
    }
    if (this.hasTable("provider_epochs")) {
      this.database.prepare("UPDATE provider_epochs SET model = '', settings_json = '{}'").run();
    }
    if (this.hasTable("logical_turns")) {
      this.database.prepare("UPDATE logical_turns SET turn_json = '{}' WHERE kind = 'provider'").run();
    }
    if (this.hasTable("provider_switch_jobs")) {
      this.database.prepare(`
        UPDATE provider_switch_jobs
        SET settings_json = '{}', turn_params_json = '{}', compaction_turn_json = '{}'
        WHERE status IN ('committed', 'failed')
      `).run();
    }
  }

  private insertSegment(
    publicThreadId: string,
    position: number,
    segment: NewTranscriptSegment,
  ): void {
    this.database.prepare(`
      INSERT INTO lineage_segments (
        public_thread_id, position, kind, epoch_id, start_turn_id, end_turn_id,
        public_turn_id, synthetic_turn_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      publicThreadId, position, segment.kind,
      segment.kind === "provider" ? segment.epochId : null,
      segment.kind === "provider" ? segment.startTurnId : null,
      segment.kind === "provider" ? segment.endTurnId : null,
      segment.kind === "synthetic" ? segment.publicTurnId : null,
      segment.kind === "synthetic" ? JSON.stringify(segment.turn) : null,
    );
  }

  private taskFromRow(row: TaskRow): PublicTaskIdentity {
    return {
      publicThreadId: row.public_thread_id,
      currentEpochId: row.current_epoch_id,
      revision: row.revision,
      sessionId: row.session_id,
      ...(row.forked_from_id ? { forkedFromId: row.forked_from_id } : {}),
      ...(row.parent_thread_id ? { parentThreadId: row.parent_thread_id } : {}),
    };
  }

  private epochFromRow(row: EpochRow): EpochBoundary {
    return {
      epochId: row.epoch_id,
      publicThreadId: row.public_thread_id,
      ordinal: row.ordinal,
      provider: row.provider,
      backendThreadId: row.backend_thread_id,
      state: row.state,
      ...(row.start_turn_id ? { startTurnId: row.start_turn_id } : {}),
      ...(row.end_turn_id ? { endTurnId: row.end_turn_id } : {}),
      archivePending: row.archive_pending === 1,
      deleteDone: row.delete_done === 1,
    };
  }

  private hasTable(name: string): boolean {
    return this.database.prepare(`
      SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(name) !== undefined;
  }

  private userVersion(): number {
    return (this.database.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version;
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
}

function parseJson(value: unknown): unknown {
  return typeof value === "string" && value.length > 0 ? JSON.parse(value) : undefined;
}
