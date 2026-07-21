import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Thread } from "../codex/generated/v2/Thread.js";
import type { ThreadSettingsUpdateParams } from "../codex/generated/v2/ThreadSettingsUpdateParams.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import type { TurnStartParams } from "../codex/generated/v2/TurnStartParams.js";

export type ProviderKind = "claude" | "stock";

export interface PendingProviderSwitch {
  readonly threadId: string;
  readonly sourceProvider: ProviderKind;
  readonly targetProvider: ProviderKind;
  readonly targetModel: string;
  readonly settings: ThreadSettingsUpdateParams;
  readonly revision?: number;
  readonly expectedEpochId?: string;
}

export type ProviderEpochState = "current" | "sealed" | "provisional";
export type LogicalTurnKind = "provider" | "migrationCompact";
export type ProviderSwitchJobStatus = "queued" | "running" | "targetCreated" | "committed" | "failed";
export type ForkSelectionStatus = "pending" | "finalized";

export interface LogicalThread {
  readonly publicThreadId: string;
  readonly currentEpochId: string;
  readonly thread: Thread;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProviderEpoch {
  readonly id: string;
  readonly publicThreadId: string;
  readonly ordinal: number;
  readonly provider: ProviderKind;
  readonly backendThreadId: string;
  readonly model: string;
  readonly settings: Record<string, unknown>;
  readonly state: ProviderEpochState;
  readonly createdAt: number;
  readonly sealedAt?: number;
}

export interface LogicalTurn {
  readonly publicThreadId: string;
  readonly position: number;
  readonly publicTurnId: string;
  readonly epochId?: string;
  readonly providerTurnId?: string;
  readonly turn: Turn;
  readonly kind: LogicalTurnKind;
}

export interface ProviderSwitchJob {
  readonly id: string;
  readonly publicThreadId: string;
  readonly expectedEpochId: string;
  readonly expectedThreadRevision: number;
  readonly pendingRevision: number;
  readonly targetProvider: ProviderKind;
  readonly targetModel: string;
  readonly settings: ThreadSettingsUpdateParams;
  readonly turnParams: TurnStartParams;
  readonly compactionTurn: Turn;
  readonly status: ProviderSwitchJobStatus;
  readonly summary?: string;
  readonly targetBackendThreadId?: string;
  readonly targetProviderTurnId?: string;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ForkSelection {
  readonly targetPublicThreadId: string;
  readonly sourcePublicThreadId: string;
  readonly provisionalEpochId: string;
  readonly expectedTargetRevision: number;
  readonly selectedEpochId?: string;
  readonly status: ForkSelectionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BackendThreadMapping {
  readonly publicThreadId: string;
  readonly epochId: string;
  readonly provider: ProviderKind;
  readonly backendThreadId: string;
  readonly state: ProviderEpochState;
}

export interface NewProviderEpoch {
  readonly id: string;
  readonly provider: ProviderKind;
  readonly backendThreadId: string;
  readonly model: string;
  readonly settings: Record<string, unknown>;
  readonly createdAt?: number;
}

export interface NewLogicalTurn {
  readonly publicTurnId: string;
  readonly epochId?: string;
  readonly providerTurnId?: string;
  readonly turn: Turn;
  readonly kind: LogicalTurnKind;
}

export interface NewProviderSwitchJob {
  readonly id: string;
  readonly publicThreadId: string;
  readonly expectedEpochId: string;
  readonly pendingRevision: number;
  readonly targetProvider: ProviderKind;
  readonly targetModel: string;
  readonly settings: ThreadSettingsUpdateParams;
  readonly turnParams: TurnStartParams;
  readonly compactionTurn: Turn;
  readonly createdAt?: number;
}

export interface ProviderSwitchTargetCheckpoint {
  readonly backendThreadId: string;
  readonly summary?: string;
  readonly providerTurnId?: string;
}

export interface ProviderSwitchCommit {
  readonly jobId: string;
  readonly targetEpoch: NewProviderEpoch;
  readonly sourceTurns: readonly NewLogicalTurn[];
  readonly thread: Thread;
  readonly committedAt?: number;
}

export interface ForkSelectionCommit {
  readonly targetPublicThreadId: string;
  readonly expectedProvisionalEpochId: string;
  readonly selectedSourceEpochId: string;
  readonly targetEpoch: NewProviderEpoch;
  readonly turns: readonly NewLogicalTurn[];
  readonly thread: Thread;
  readonly committedAt?: number;
}

export interface StockHistoryOverlay {
  readonly threadId: string;
  readonly sourceThreadId: string;
  readonly sourceThread: Thread;
  readonly inheritedTurns: Turn[];
}

interface PendingRow {
  thread_id: string;
  source_provider: ProviderKind;
  target_provider: ProviderKind;
  target_model: string;
  settings_json: string;
  revision: number;
  expected_epoch_id: string | null;
}

interface OverlayRow {
  thread_id: string;
  source_thread_id: string;
  source_thread_json: string;
  turns_json: string;
}

export type HandoffJobStatus = "queued" | "running" | "completed" | "failed";

export interface HandoffJob {
  readonly id: string;
  readonly sourceThreadId: string;
  readonly params: Record<string, unknown>;
  readonly pending?: PendingProviderSwitch;
  readonly status: HandoffJobStatus;
  readonly result?: Record<string, unknown>;
  readonly target?: Record<string, unknown>;
  readonly error?: string;
}

interface JobRow {
  job_id: string;
  source_thread_id: string;
  params_json: string;
  pending_json: string | null;
  status: HandoffJobStatus;
  result_json: string | null;
  target_json: string | null;
  error: string | null;
}

interface LogicalThreadRow {
  public_thread_id: string;
  current_epoch_id: string;
  thread_json: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface ProviderEpochRow {
  epoch_id: string;
  public_thread_id: string;
  ordinal: number;
  provider: ProviderKind;
  backend_thread_id: string;
  model: string;
  settings_json: string;
  state: ProviderEpochState;
  created_at: number;
  sealed_at: number | null;
}

interface LogicalTurnRow {
  public_thread_id: string;
  position: number;
  public_turn_id: string;
  epoch_id: string | null;
  provider_turn_id: string | null;
  turn_json: string;
  kind: LogicalTurnKind;
}

interface ProviderSwitchJobRow {
  job_id: string;
  public_thread_id: string;
  expected_epoch_id: string;
  expected_thread_revision: number;
  pending_revision: number;
  target_provider: ProviderKind;
  target_model: string;
  settings_json: string;
  turn_params_json: string;
  compaction_turn_json: string;
  status: ProviderSwitchJobStatus;
  summary: string | null;
  target_backend_thread_id: string | null;
  target_provider_turn_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface ForkSelectionRow {
  target_public_thread_id: string;
  source_public_thread_id: string;
  provisional_epoch_id: string;
  expected_target_revision: number;
  selected_epoch_id: string | null;
  status: ForkSelectionStatus;
  created_at: number;
  updated_at: number;
}

export class HandoffStore {
  private readonly database: DatabaseSync;

  public constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS pending_provider_switches (
        thread_id TEXT PRIMARY KEY,
        source_provider TEXT NOT NULL,
        target_provider TEXT NOT NULL,
        target_model TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        expected_epoch_id TEXT
      );
      CREATE TABLE IF NOT EXISTS stock_history_overlays (
        thread_id TEXT PRIMARY KEY,
        source_thread_id TEXT NOT NULL,
        source_thread_json TEXT NOT NULL,
        turns_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS handoff_jobs (
        job_id TEXT PRIMARY KEY,
        source_thread_id TEXT NOT NULL,
        params_json TEXT NOT NULL,
        pending_json TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        target_json TEXT,
        error TEXT,
        error_notified INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS handoff_jobs_recovery
        ON handoff_jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS handoff_jobs_failure
        ON handoff_jobs(source_thread_id, status, error_notified, updated_at);
      CREATE TABLE IF NOT EXISTS logical_threads (
        public_thread_id TEXT PRIMARY KEY,
        current_epoch_id TEXT NOT NULL,
        thread_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_epochs (
        epoch_id TEXT PRIMARY KEY,
        public_thread_id TEXT NOT NULL REFERENCES logical_threads(public_thread_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('claude', 'stock')),
        backend_thread_id TEXT NOT NULL,
        model TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('current', 'sealed', 'provisional')),
        created_at INTEGER NOT NULL,
        sealed_at INTEGER,
        UNIQUE(public_thread_id, ordinal),
        UNIQUE(provider, backend_thread_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS provider_epochs_one_current
        ON provider_epochs(public_thread_id) WHERE state = 'current';
      CREATE INDEX IF NOT EXISTS provider_epochs_public
        ON provider_epochs(public_thread_id, ordinal);
      CREATE TABLE IF NOT EXISTS logical_turns (
        public_thread_id TEXT NOT NULL REFERENCES logical_threads(public_thread_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        public_turn_id TEXT NOT NULL,
        epoch_id TEXT REFERENCES provider_epochs(epoch_id),
        provider_turn_id TEXT,
        turn_json TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('provider', 'migrationCompact')),
        PRIMARY KEY(public_thread_id, position),
        UNIQUE(public_thread_id, public_turn_id),
        CHECK((kind = 'provider' AND epoch_id IS NOT NULL AND provider_turn_id IS NOT NULL)
          OR (kind = 'migrationCompact' AND epoch_id IS NULL AND provider_turn_id IS NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS logical_turns_provider
        ON logical_turns(public_thread_id, epoch_id, provider_turn_id)
        WHERE epoch_id IS NOT NULL AND provider_turn_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS provider_switch_jobs (
        job_id TEXT PRIMARY KEY,
        public_thread_id TEXT NOT NULL REFERENCES logical_threads(public_thread_id) ON DELETE CASCADE,
        expected_epoch_id TEXT NOT NULL REFERENCES provider_epochs(epoch_id),
        expected_thread_revision INTEGER NOT NULL,
        pending_revision INTEGER NOT NULL,
        target_provider TEXT NOT NULL CHECK(target_provider IN ('claude', 'stock')),
        target_model TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        turn_params_json TEXT NOT NULL,
        compaction_turn_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'targetCreated', 'committed', 'failed')),
        summary TEXT,
        target_backend_thread_id TEXT,
        target_provider_turn_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS provider_switch_jobs_active
        ON provider_switch_jobs(public_thread_id)
        WHERE status IN ('queued', 'running', 'targetCreated');
      CREATE INDEX IF NOT EXISTS provider_switch_jobs_recovery
        ON provider_switch_jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS fork_selections (
        target_public_thread_id TEXT PRIMARY KEY REFERENCES logical_threads(public_thread_id) ON DELETE CASCADE,
        source_public_thread_id TEXT NOT NULL REFERENCES logical_threads(public_thread_id) ON DELETE CASCADE,
        provisional_epoch_id TEXT NOT NULL REFERENCES provider_epochs(epoch_id),
        expected_target_revision INTEGER NOT NULL,
        selected_epoch_id TEXT REFERENCES provider_epochs(epoch_id),
        status TEXT NOT NULL CHECK(status IN ('pending', 'finalized')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const pendingColumns = this.database.prepare("PRAGMA table_info(pending_provider_switches)")
      .all() as unknown as Array<{ name: string }>;
    if (!pendingColumns.some((column) => column.name === "revision")) {
      this.database.exec("ALTER TABLE pending_provider_switches ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    }
    if (!pendingColumns.some((column) => column.name === "expected_epoch_id")) {
      this.database.exec("ALTER TABLE pending_provider_switches ADD COLUMN expected_epoch_id TEXT");
    }
    const jobColumns = this.database.prepare("PRAGMA table_info(handoff_jobs)")
      .all() as unknown as Array<{ name: string }>;
    if (!jobColumns.some((column) => column.name === "target_json")) {
      this.database.exec("ALTER TABLE handoff_jobs ADD COLUMN target_json TEXT");
    }
    const switchColumns = this.database.prepare("PRAGMA table_info(provider_switch_jobs)")
      .all() as unknown as Array<{ name: string }>;
    if (!switchColumns.some((column) => column.name === "compaction_turn_json")) {
      this.database.exec("ALTER TABLE provider_switch_jobs ADD COLUMN compaction_turn_json TEXT");
    }
    chmodSync(path, 0o600);
  }

  public setPending(pending: PendingProviderSwitch): PendingProviderSwitch {
    this.database.prepare(`
      INSERT INTO pending_provider_switches (
        thread_id, source_provider, target_provider, target_model, settings_json, updated_at, revision,
        expected_epoch_id
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        source_provider = excluded.source_provider,
        target_provider = excluded.target_provider,
        target_model = excluded.target_model,
        settings_json = excluded.settings_json,
        updated_at = excluded.updated_at,
        expected_epoch_id = excluded.expected_epoch_id,
        revision = pending_provider_switches.revision + 1
    `).run(
      pending.threadId, pending.sourceProvider, pending.targetProvider, pending.targetModel,
      JSON.stringify(pending.settings), Date.now(), pending.expectedEpochId ?? null,
    );
    return this.getPending(pending.threadId)!;
  }

  public getPending(threadId: string): PendingProviderSwitch | undefined {
    const row = this.database.prepare("SELECT * FROM pending_provider_switches WHERE thread_id = ?")
      .get(threadId) as unknown as PendingRow | undefined;
    return row ? {
      threadId: row.thread_id,
      sourceProvider: row.source_provider,
      targetProvider: row.target_provider,
      targetModel: row.target_model,
      settings: JSON.parse(row.settings_json) as ThreadSettingsUpdateParams,
      revision: row.revision,
      ...(row.expected_epoch_id ? { expectedEpochId: row.expected_epoch_id } : {}),
    } : undefined;
  }

  public clearPending(threadId: string, revision?: number): boolean {
    const result = revision === undefined
      ? this.database.prepare("DELETE FROM pending_provider_switches WHERE thread_id = ?").run(threadId)
      : this.database.prepare("DELETE FROM pending_provider_switches WHERE thread_id = ? AND revision = ?")
        .run(threadId, revision);
    return Number(result.changes) > 0;
  }

  public createLogicalThread(input: { readonly thread: Thread; readonly epoch: NewProviderEpoch }): LogicalThread {
    const now = input.epoch.createdAt ?? Date.now();
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO logical_threads (
          public_thread_id, current_epoch_id, thread_json, revision, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?)
      `).run(input.thread.id, input.epoch.id, JSON.stringify({ ...input.thread, turns: [] }), now, now);
      this.insertEpoch(input.thread.id, 0, input.epoch, "current", now);
      return this.getLogicalThread(input.thread.id)!;
    });
  }

  public getLogicalThread(publicThreadId: string): LogicalThread | undefined {
    const row = this.database.prepare("SELECT * FROM logical_threads WHERE public_thread_id = ?")
      .get(publicThreadId) as unknown as LogicalThreadRow | undefined;
    return row ? this.logicalThreadFromRow(row) : undefined;
  }

  public updateLogicalThread(
    publicThreadId: string,
    expectedRevision: number,
    thread: Thread,
  ): LogicalThread | undefined {
    const result = this.database.prepare(`
      UPDATE logical_threads SET thread_json = ?, updated_at = ?
      WHERE public_thread_id = ? AND revision = ?
    `).run(JSON.stringify({ ...thread, id: publicThreadId, turns: [] }), Date.now(), publicThreadId, expectedRevision);
    return Number(result.changes) === 1 ? this.getLogicalThread(publicThreadId) : undefined;
  }

  public deleteLogicalThread(publicThreadId: string): boolean {
    return Number(this.database.prepare("DELETE FROM logical_threads WHERE public_thread_id = ?")
      .run(publicThreadId).changes) === 1;
  }

  public getEpoch(epochId: string): ProviderEpoch | undefined {
    const row = this.database.prepare("SELECT * FROM provider_epochs WHERE epoch_id = ?")
      .get(epochId) as unknown as ProviderEpochRow | undefined;
    return row ? this.epochFromRow(row) : undefined;
  }

  public listEpochs(publicThreadId: string): ProviderEpoch[] {
    return (this.database.prepare(`
      SELECT * FROM provider_epochs WHERE public_thread_id = ? ORDER BY ordinal ASC
    `).all(publicThreadId) as unknown as ProviderEpochRow[]).map((row) => this.epochFromRow(row));
  }

  public updateCurrentEpoch(
    publicThreadId: string,
    expectedEpochId: string,
    patch: { readonly model?: string; readonly settings?: Record<string, unknown> },
  ): ProviderEpoch | undefined {
    return this.transaction(() => {
      const logical = this.getLogicalThread(publicThreadId);
      const epoch = logical && this.getEpoch(expectedEpochId);
      if (!logical || logical.currentEpochId !== expectedEpochId || epoch?.state !== "current") return undefined;
      const result = this.database.prepare(`
        UPDATE provider_epochs SET model = ?, settings_json = ?
        WHERE epoch_id = ? AND public_thread_id = ? AND state = 'current'
      `).run(
        patch.model ?? epoch.model,
        JSON.stringify({ ...epoch.settings, ...(patch.settings ?? {}) }),
        expectedEpochId,
        publicThreadId,
      );
      return Number(result.changes) === 1 ? this.getEpoch(expectedEpochId) : undefined;
    });
  }

  public findEpochByBackend(provider: ProviderKind, backendThreadId: string): ProviderEpoch | undefined {
    const row = this.database.prepare(`
      SELECT * FROM provider_epochs WHERE provider = ? AND backend_thread_id = ?
    `).get(provider, backendThreadId) as unknown as ProviderEpochRow | undefined;
    return row ? this.epochFromRow(row) : undefined;
  }

  public listBackendMappings(): BackendThreadMapping[] {
    return (this.database.prepare(`
      SELECT public_thread_id, epoch_id, provider, backend_thread_id, state
      FROM provider_epochs ORDER BY public_thread_id ASC, ordinal ASC
    `).all() as unknown as Array<{
      public_thread_id: string;
      epoch_id: string;
      provider: ProviderKind;
      backend_thread_id: string;
      state: ProviderEpochState;
    }>).map((row) => ({
      publicThreadId: row.public_thread_id,
      epochId: row.epoch_id,
      provider: row.provider,
      backendThreadId: row.backend_thread_id,
      state: row.state,
    }));
  }

  public listLogicalTurns(publicThreadId: string): LogicalTurn[] {
    return (this.database.prepare(`
      SELECT * FROM logical_turns WHERE public_thread_id = ? ORDER BY position ASC
    `).all(publicThreadId) as unknown as LogicalTurnRow[]).map((row) => this.logicalTurnFromRow(row));
  }

  public findLogicalTurn(publicThreadId: string, publicTurnId: string): LogicalTurn | undefined {
    const row = this.database.prepare(`
      SELECT * FROM logical_turns WHERE public_thread_id = ? AND public_turn_id = ?
    `).get(publicThreadId, publicTurnId) as unknown as LogicalTurnRow | undefined;
    return row ? this.logicalTurnFromRow(row) : undefined;
  }

  public replaceLogicalTurns(
    publicThreadId: string,
    expectedThreadRevision: number,
    turns: readonly NewLogicalTurn[],
  ): boolean {
    return this.transaction(() => {
      const current = this.getLogicalThread(publicThreadId);
      if (!current || current.revision !== expectedThreadRevision) return false;
      this.replaceTurns(publicThreadId, turns);
      const result = this.database.prepare(`
        UPDATE logical_threads SET revision = revision + 1, updated_at = ?
        WHERE public_thread_id = ? AND revision = ?
      `).run(Date.now(), publicThreadId, expectedThreadRevision);
      return Number(result.changes) === 1;
    });
  }

  public stageProviderSwitch(input: {
    readonly pending: PendingProviderSwitch;
    readonly expectedEpochId: string;
  }): PendingProviderSwitch | undefined {
    return this.transaction(() => {
      const logical = this.getLogicalThread(input.pending.threadId);
      const epoch = logical && this.getEpoch(logical.currentEpochId);
      if (!logical || logical.currentEpochId !== input.expectedEpochId
        || epoch?.provider !== input.pending.sourceProvider) return undefined;
      return this.setPending({ ...input.pending, expectedEpochId: input.expectedEpochId });
    });
  }

  public createProviderSwitchJob(input: NewProviderSwitchJob): ProviderSwitchJob | undefined {
    return this.transaction(() => {
      const logical = this.getLogicalThread(input.publicThreadId);
      const pending = this.getPending(input.publicThreadId);
      const epoch = logical && this.getEpoch(logical.currentEpochId);
      const active = this.database.prepare(`
        SELECT 1 AS found FROM provider_switch_jobs
        WHERE public_thread_id = ? AND status IN ('queued', 'running', 'targetCreated')
      `).get(input.publicThreadId);
      if (!logical || logical.currentEpochId !== input.expectedEpochId || active
        || epoch?.provider !== pending?.sourceProvider
        || pending?.revision !== input.pendingRevision || pending.expectedEpochId !== input.expectedEpochId
        || pending.targetProvider !== input.targetProvider || pending.targetModel !== input.targetModel) return undefined;
      const now = input.createdAt ?? Date.now();
      this.database.prepare(`
        INSERT INTO provider_switch_jobs (
          job_id, public_thread_id, expected_epoch_id, expected_thread_revision, pending_revision,
          target_provider, target_model, settings_json, turn_params_json, status, created_at, updated_at
          , compaction_turn_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(
        input.id, input.publicThreadId, input.expectedEpochId, logical.revision, input.pendingRevision,
        input.targetProvider, input.targetModel, JSON.stringify(input.settings), JSON.stringify(input.turnParams),
        now, now, JSON.stringify(input.compactionTurn),
      );
      return this.getProviderSwitchJob(input.id)!;
    });
  }

  public getProviderSwitchJob(jobId: string): ProviderSwitchJob | undefined {
    const row = this.database.prepare("SELECT * FROM provider_switch_jobs WHERE job_id = ?")
      .get(jobId) as unknown as ProviderSwitchJobRow | undefined;
    return row ? this.providerSwitchJobFromRow(row) : undefined;
  }

  public recoverableProviderSwitchJobs(): ProviderSwitchJob[] {
    return (this.database.prepare(`
      SELECT * FROM provider_switch_jobs
      WHERE status IN ('queued', 'running', 'targetCreated') ORDER BY created_at ASC
    `).all() as unknown as ProviderSwitchJobRow[]).map((row) => this.providerSwitchJobFromRow(row));
  }

  public claimProviderSwitchJob(jobId: string): ProviderSwitchJob | undefined {
    const result = this.database.prepare(`
      UPDATE provider_switch_jobs SET status = 'running', updated_at = ?
      WHERE job_id = ? AND status = 'queued'
    `).run(Date.now(), jobId);
    return Number(result.changes) === 1 ? this.getProviderSwitchJob(jobId) : undefined;
  }

  public requeueProviderSwitchJob(jobId: string): ProviderSwitchJob | undefined {
    const result = this.database.prepare(`
      UPDATE provider_switch_jobs SET
        status = 'queued', summary = NULL, target_backend_thread_id = NULL,
        target_provider_turn_id = NULL, error = NULL, updated_at = ?
      WHERE job_id = ? AND status IN ('running', 'targetCreated')
    `).run(Date.now(), jobId);
    return Number(result.changes) === 1 ? this.getProviderSwitchJob(jobId) : this.getProviderSwitchJob(jobId);
  }

  public checkpointProviderSwitchTarget(jobId: string, checkpoint: ProviderSwitchTargetCheckpoint): boolean {
    return this.transaction(() => {
      const job = this.getProviderSwitchJob(jobId);
      if (!job || !["running", "targetCreated"].includes(job.status)
        || (job.targetBackendThreadId && job.targetBackendThreadId !== checkpoint.backendThreadId)) return false;
      const result = this.database.prepare(`
        UPDATE provider_switch_jobs SET
          status = 'targetCreated', target_backend_thread_id = ?,
          summary = COALESCE(?, summary), target_provider_turn_id = COALESCE(?, target_provider_turn_id),
          updated_at = ?
        WHERE job_id = ? AND status IN ('running', 'targetCreated')
      `).run(
        checkpoint.backendThreadId, checkpoint.summary ?? null, checkpoint.providerTurnId ?? null,
        Date.now(), jobId,
      );
      return Number(result.changes) === 1;
    });
  }

  public commitProviderSwitch(input: ProviderSwitchCommit): LogicalThread | undefined {
    return this.transaction(() => {
      const job = this.getProviderSwitchJob(input.jobId);
      const logical = job && this.getLogicalThread(job.publicThreadId);
      const pending = job && this.getPending(job.publicThreadId);
      if (!job || job.status !== "targetCreated" || !job.targetProviderTurnId || !logical
        || logical.currentEpochId !== job.expectedEpochId || logical.revision !== job.expectedThreadRevision
        || pending?.revision !== job.pendingRevision || pending.expectedEpochId !== job.expectedEpochId
        || input.targetEpoch.provider !== job.targetProvider || input.targetEpoch.model !== job.targetModel
        || input.targetEpoch.backendThreadId !== job.targetBackendThreadId) return undefined;
      const committedAt = input.committedAt ?? Date.now();
      const ordinal = (this.database.prepare(`
        SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM provider_epochs WHERE public_thread_id = ?
      `).get(job.publicThreadId) as unknown as { ordinal: number }).ordinal;
      this.database.prepare(`
        UPDATE provider_epochs SET state = 'sealed', sealed_at = ?
        WHERE epoch_id = ? AND public_thread_id = ? AND state = 'current'
      `).run(committedAt, job.expectedEpochId, job.publicThreadId);
      this.insertEpoch(job.publicThreadId, ordinal, input.targetEpoch, "current", committedAt);
      this.replaceTurns(job.publicThreadId, input.sourceTurns);
      const update = this.database.prepare(`
        UPDATE logical_threads SET current_epoch_id = ?, thread_json = ?, revision = revision + 1, updated_at = ?
        WHERE public_thread_id = ? AND current_epoch_id = ? AND revision = ?
      `).run(
        input.targetEpoch.id, JSON.stringify({ ...input.thread, turns: [] }), committedAt,
        job.publicThreadId, job.expectedEpochId, job.expectedThreadRevision,
      );
      if (Number(update.changes) !== 1) throw new Error("Provider switch lost its logical-thread CAS during commit.");
      this.database.prepare(`
        DELETE FROM pending_provider_switches WHERE thread_id = ? AND revision = ? AND expected_epoch_id = ?
      `).run(job.publicThreadId, job.pendingRevision, job.expectedEpochId);
      this.database.prepare(`
        UPDATE provider_switch_jobs SET status = 'committed', error = NULL, updated_at = ?
        WHERE job_id = ? AND status = 'targetCreated'
      `).run(committedAt, job.id);
      return this.getLogicalThread(job.publicThreadId)!;
    });
  }

  public failProviderSwitch(jobId: string, error: string): boolean {
    return this.transaction(() => {
      const job = this.getProviderSwitchJob(jobId);
      if (!job || !["queued", "running", "targetCreated"].includes(job.status)) return false;
      const result = this.database.prepare(`
        UPDATE provider_switch_jobs SET status = 'failed', error = ?, updated_at = ?
        WHERE job_id = ? AND status IN ('queued', 'running', 'targetCreated')
      `).run(error, Date.now(), jobId);
      if (Number(result.changes) !== 1) return false;
      const logical = this.getLogicalThread(job.publicThreadId);
      if (logical?.currentEpochId === job.expectedEpochId) {
        this.database.prepare(`
          DELETE FROM pending_provider_switches WHERE thread_id = ? AND revision = ? AND expected_epoch_id = ?
        `).run(job.publicThreadId, job.pendingRevision, job.expectedEpochId);
      }
      return true;
    });
  }

  public createForkSelection(selection: {
    readonly targetPublicThreadId: string;
    readonly sourcePublicThreadId: string;
    readonly provisionalEpochId: string;
    readonly createdAt?: number;
  }): boolean {
    return this.transaction(() => {
      const epoch = this.getEpoch(selection.provisionalEpochId);
      const target = this.getLogicalThread(selection.targetPublicThreadId);
      if (!epoch || epoch.publicThreadId !== selection.targetPublicThreadId
        || target?.currentEpochId !== selection.provisionalEpochId
        || !this.getLogicalThread(selection.sourcePublicThreadId)) return false;
      const now = selection.createdAt ?? Date.now();
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO fork_selections (
          target_public_thread_id, source_public_thread_id, provisional_epoch_id, expected_target_revision,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        selection.targetPublicThreadId, selection.sourcePublicThreadId,
        selection.provisionalEpochId, target.revision, now, now,
      );
      return Number(result.changes) === 1;
    });
  }

  public getForkSelection(targetPublicThreadId: string): ForkSelection | undefined {
    const row = this.database.prepare("SELECT * FROM fork_selections WHERE target_public_thread_id = ?")
      .get(targetPublicThreadId) as unknown as ForkSelectionRow | undefined;
    return row ? this.forkSelectionFromRow(row) : undefined;
  }

  public finalizeForkSelection(
    targetPublicThreadId: string,
    expectedProvisionalEpochId: string,
    selectedEpochId: string,
  ): boolean {
    return this.transaction(() => {
      const selection = this.getForkSelection(targetPublicThreadId);
      const selected = this.getEpoch(selectedEpochId);
      if (!selection || selection.status !== "pending"
        || selection.provisionalEpochId !== expectedProvisionalEpochId
        || this.getLogicalThread(targetPublicThreadId)?.revision !== selection.expectedTargetRevision
        || selected?.publicThreadId !== selection.sourcePublicThreadId) return false;
      const result = this.database.prepare(`
        UPDATE fork_selections SET selected_epoch_id = ?, status = 'finalized', updated_at = ?
        WHERE target_public_thread_id = ? AND provisional_epoch_id = ? AND status = 'pending'
      `).run(selectedEpochId, Date.now(), targetPublicThreadId, expectedProvisionalEpochId);
      return Number(result.changes) === 1;
    });
  }

  public commitForkSelection(input: ForkSelectionCommit): LogicalThread | undefined {
    return this.transaction(() => {
      const selection = this.getForkSelection(input.targetPublicThreadId);
      const target = selection && this.getLogicalThread(selection.targetPublicThreadId);
      const selected = this.getEpoch(input.selectedSourceEpochId);
      const provisional = this.getEpoch(input.expectedProvisionalEpochId);
      if (!selection || selection.status !== "pending" || !target
        || selection.provisionalEpochId !== input.expectedProvisionalEpochId
        || selection.expectedTargetRevision !== target.revision
        || target.currentEpochId !== input.expectedProvisionalEpochId
        || selected?.publicThreadId !== selection.sourcePublicThreadId
        || provisional?.publicThreadId !== target.publicThreadId || provisional.state !== "current"
        || input.targetEpoch.provider !== selected.provider) return undefined;
      const committedAt = input.committedAt ?? Date.now();
      const ordinal = (this.database.prepare(`
        SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM provider_epochs WHERE public_thread_id = ?
      `).get(target.publicThreadId) as unknown as { ordinal: number }).ordinal;
      this.database.prepare(`
        UPDATE provider_epochs SET state = 'sealed', sealed_at = ?
        WHERE epoch_id = ? AND public_thread_id = ? AND state = 'current'
      `).run(committedAt, provisional.id, target.publicThreadId);
      this.insertEpoch(target.publicThreadId, ordinal, input.targetEpoch, "current", committedAt);
      this.replaceTurns(target.publicThreadId, input.turns);
      const updated = this.database.prepare(`
        UPDATE logical_threads SET current_epoch_id = ?, thread_json = ?, revision = revision + 1, updated_at = ?
        WHERE public_thread_id = ? AND current_epoch_id = ? AND revision = ?
      `).run(
        input.targetEpoch.id, JSON.stringify({ ...input.thread, turns: [] }), committedAt,
        target.publicThreadId, provisional.id, selection.expectedTargetRevision,
      );
      if (Number(updated.changes) !== 1) throw new Error("Fork selection lost its logical-thread CAS during commit.");
      const finalized = this.database.prepare(`
        UPDATE fork_selections SET selected_epoch_id = ?, status = 'finalized', updated_at = ?
        WHERE target_public_thread_id = ? AND provisional_epoch_id = ? AND status = 'pending'
      `).run(selected.id, committedAt, target.publicThreadId, provisional.id);
      if (Number(finalized.changes) !== 1) throw new Error("Fork selection lost its finalize CAS during commit.");
      return this.getLogicalThread(target.publicThreadId)!;
    });
  }

  public createJob(job: Omit<HandoffJob, "status">): HandoffJob {
    const now = Date.now();
    this.database.prepare(`
      INSERT INTO handoff_jobs (
        job_id, source_thread_id, params_json, pending_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      job.id,
      job.sourceThreadId,
      JSON.stringify(job.params),
      job.pending ? JSON.stringify(job.pending) : null,
      now,
      now,
    );
    return { ...job, status: "queued" };
  }

  public recoverableJobs(): HandoffJob[] {
    const rows = this.database.prepare(`
      SELECT * FROM handoff_jobs WHERE status IN ('queued', 'running') ORDER BY created_at ASC
    `).all() as unknown as JobRow[];
    this.database.prepare(`
      UPDATE handoff_jobs SET status = 'queued', updated_at = ? WHERE status = 'running'
    `).run(Date.now());
    return rows.map((row) => this.jobFromRow({ ...row, status: "queued" }));
  }

  public markJobRunning(jobId: string): void {
    this.database.prepare(`
      UPDATE handoff_jobs SET status = 'running', updated_at = ? WHERE job_id = ?
    `).run(Date.now(), jobId);
  }

  public completeJob(jobId: string, result: Record<string, unknown>): void {
    this.database.prepare(`
      UPDATE handoff_jobs
      SET status = 'completed', result_json = ?, error = NULL, updated_at = ?
      WHERE job_id = ?
    `).run(JSON.stringify(result), Date.now(), jobId);
  }

  public checkpointJobTarget(jobId: string, target: Record<string, unknown>): void {
    this.database.prepare(`
      UPDATE handoff_jobs SET target_json = ?, updated_at = ? WHERE job_id = ?
    `).run(JSON.stringify(target), Date.now(), jobId);
  }

  public clearJobTarget(jobId: string): void {
    this.database.prepare(`
      UPDATE handoff_jobs SET target_json = NULL, updated_at = ? WHERE job_id = ?
    `).run(Date.now(), jobId);
  }

  public failJob(jobId: string, error: string): void {
    this.database.prepare(`
      UPDATE handoff_jobs
      SET status = 'failed', error = ?, updated_at = ?
      WHERE job_id = ?
    `).run(error, Date.now(), jobId);
  }

  public claimFailedJob(sourceThreadId: string): string | undefined {
    const row = this.database.prepare(`
      SELECT * FROM handoff_jobs
      WHERE source_thread_id = ? AND status = 'failed' AND error_notified = 0
      ORDER BY updated_at ASC LIMIT 1
    `).get(sourceThreadId) as unknown as JobRow | undefined;
    if (!row?.error) return undefined;
    this.database.prepare(`
      UPDATE handoff_jobs SET error_notified = 1, updated_at = ? WHERE job_id = ?
    `).run(Date.now(), row.job_id);
    return row.error;
  }

  public setOverlay(overlay: StockHistoryOverlay): void {
    this.database.prepare(`
      INSERT INTO stock_history_overlays (
        thread_id, source_thread_id, source_thread_json, turns_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        source_thread_id = excluded.source_thread_id,
        source_thread_json = excluded.source_thread_json,
        turns_json = excluded.turns_json
    `).run(
      overlay.threadId, overlay.sourceThreadId, JSON.stringify(overlay.sourceThread),
      JSON.stringify(overlay.inheritedTurns), Date.now(),
    );
  }

  public getOverlay(threadId: string): StockHistoryOverlay | undefined {
    const row = this.database.prepare("SELECT * FROM stock_history_overlays WHERE thread_id = ?")
      .get(threadId) as unknown as OverlayRow | undefined;
    return row ? {
      threadId: row.thread_id,
      sourceThreadId: row.source_thread_id,
      sourceThread: JSON.parse(row.source_thread_json) as Thread,
      inheritedTurns: JSON.parse(row.turns_json) as Turn[],
    } : undefined;
  }

  public clearOverlay(threadId: string): void {
    this.database.prepare("DELETE FROM stock_history_overlays WHERE thread_id = ?").run(threadId);
  }

  public close(): void {
    this.database.close();
  }

  private jobFromRow(row: JobRow): HandoffJob {
    return {
      id: row.job_id,
      sourceThreadId: row.source_thread_id,
      params: JSON.parse(row.params_json) as Record<string, unknown>,
      ...(row.pending_json
        ? { pending: JSON.parse(row.pending_json) as PendingProviderSwitch }
        : {}),
      status: row.status,
      ...(row.result_json ? { result: JSON.parse(row.result_json) as Record<string, unknown> } : {}),
      ...(row.target_json ? { target: JSON.parse(row.target_json) as Record<string, unknown> } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  private insertEpoch(
    publicThreadId: string,
    ordinal: number,
    epoch: NewProviderEpoch,
    state: ProviderEpochState,
    defaultCreatedAt: number,
  ): void {
    this.database.prepare(`
      INSERT INTO provider_epochs (
        epoch_id, public_thread_id, ordinal, provider, backend_thread_id,
        model, settings_json, state, created_at, sealed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      epoch.id, publicThreadId, ordinal, epoch.provider, epoch.backendThreadId,
      epoch.model, JSON.stringify(epoch.settings), state, epoch.createdAt ?? defaultCreatedAt,
    );
  }

  private replaceTurns(publicThreadId: string, turns: readonly NewLogicalTurn[]): void {
    this.database.prepare("DELETE FROM logical_turns WHERE public_thread_id = ?").run(publicThreadId);
    const insert = this.database.prepare(`
      INSERT INTO logical_turns (
        public_thread_id, position, public_turn_id, epoch_id, provider_turn_id, turn_json, kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    turns.forEach((turn, position) => {
      if (turn.publicTurnId !== turn.turn.id) {
        throw new Error(`Logical turn id '${turn.publicTurnId}' does not match payload '${turn.turn.id}'.`);
      }
      insert.run(
        publicThreadId, position, turn.publicTurnId, turn.epochId ?? null,
        turn.providerTurnId ?? null, JSON.stringify(turn.turn), turn.kind,
      );
    });
  }

  private logicalThreadFromRow(row: LogicalThreadRow): LogicalThread {
    return {
      publicThreadId: row.public_thread_id,
      currentEpochId: row.current_epoch_id,
      thread: JSON.parse(row.thread_json) as Thread,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private epochFromRow(row: ProviderEpochRow): ProviderEpoch {
    return {
      id: row.epoch_id,
      publicThreadId: row.public_thread_id,
      ordinal: row.ordinal,
      provider: row.provider,
      backendThreadId: row.backend_thread_id,
      model: row.model,
      settings: JSON.parse(row.settings_json) as Record<string, unknown>,
      state: row.state,
      createdAt: row.created_at,
      ...(row.sealed_at === null ? {} : { sealedAt: row.sealed_at }),
    };
  }

  private logicalTurnFromRow(row: LogicalTurnRow): LogicalTurn {
    return {
      publicThreadId: row.public_thread_id,
      position: row.position,
      publicTurnId: row.public_turn_id,
      ...(row.epoch_id ? { epochId: row.epoch_id } : {}),
      ...(row.provider_turn_id ? { providerTurnId: row.provider_turn_id } : {}),
      turn: JSON.parse(row.turn_json) as Turn,
      kind: row.kind,
    };
  }

  private providerSwitchJobFromRow(row: ProviderSwitchJobRow): ProviderSwitchJob {
    return {
      id: row.job_id,
      publicThreadId: row.public_thread_id,
      expectedEpochId: row.expected_epoch_id,
      expectedThreadRevision: row.expected_thread_revision,
      pendingRevision: row.pending_revision,
      targetProvider: row.target_provider,
      targetModel: row.target_model,
      settings: JSON.parse(row.settings_json) as ThreadSettingsUpdateParams,
      turnParams: JSON.parse(row.turn_params_json) as TurnStartParams,
      compactionTurn: row.compaction_turn_json
        ? JSON.parse(row.compaction_turn_json) as Turn
        : {
            id: row.job_id, items: [], itemsView: "full", status: "inProgress", error: null,
            startedAt: null, completedAt: null, durationMs: null,
          },
      status: row.status,
      ...(row.summary === null ? {} : { summary: row.summary }),
      ...(row.target_backend_thread_id === null ? {} : { targetBackendThreadId: row.target_backend_thread_id }),
      ...(row.target_provider_turn_id === null ? {} : { targetProviderTurnId: row.target_provider_turn_id }),
      ...(row.error === null ? {} : { error: row.error }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private forkSelectionFromRow(row: ForkSelectionRow): ForkSelection {
    return {
      targetPublicThreadId: row.target_public_thread_id,
      sourcePublicThreadId: row.source_public_thread_id,
      provisionalEpochId: row.provisional_epoch_id,
      expectedTargetRevision: row.expected_target_revision,
      ...(row.selected_epoch_id === null ? {} : { selectedEpochId: row.selected_epoch_id }),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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
