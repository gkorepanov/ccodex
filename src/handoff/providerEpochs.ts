import { v7 as uuidv7 } from "uuid";
import type { Thread } from "../codex/generated/v2/Thread.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import {
  LineageStore,
  type EpochBoundary,
  type NewTranscriptSegment,
  type PublicTaskIdentity,
  type TranscriptSegment,
} from "./lineageStore.js";
import {
  HandoffStore,
  type LogicalThread,
  type ProviderEpoch,
  type ProviderKind,
} from "./store.js";

export interface ResolvedProviderEpoch {
  readonly logical: LogicalThread;
  readonly epoch: ProviderEpoch;
}

export interface LegacyProviderSnapshots {
  readonly threads: ReadonlyMap<string, Thread>;
  readonly epochs: ReadonlyMap<string, ProviderEpoch>;
}

const STOCK_SWITCH_SOURCE_PREFIX = "ccodexProviderSwitch:";

export function stockSwitchThreadSource(jobId: string, source: string | null): string {
  return `${STOCK_SWITCH_SOURCE_PREFIX}${jobId}|${encodeURIComponent(source ?? "")}`;
}

function publicThreadSource(source: string | null): string | null {
  if (!source?.startsWith(STOCK_SWITCH_SOURCE_PREFIX)) return source;
  const separator = source.indexOf("|", STOCK_SWITCH_SOURCE_PREFIX.length);
  if (separator < 0) return source;
  return decodeURIComponent(source.slice(separator + 1)) || null;
}

export class ProviderEpochs {
  public constructor(
    private readonly lineage: LineageStore,
    private readonly legacyMirror?: HandoffStore,
    private readonly legacySnapshots?: LegacyProviderSnapshots,
  ) {}

  public resolve(publicThreadId: string): ResolvedProviderEpoch | undefined {
    const task = this.lineage.getTask(publicThreadId);
    const boundary = task && this.lineage.getEpoch(task.currentEpochId);
    if (!task || !boundary) return undefined;
    return {
      logical: logicalTask(task, this.legacySnapshots?.threads.get(publicThreadId)),
      epoch: providerEpoch(
        boundary,
        this.legacySnapshots?.epochs.get(boundary.epochId) ?? this.legacyMirror?.getEpoch(boundary.epochId),
      ),
    };
  }

  public publicId(provider: ProviderKind, backendThreadId: string): string | undefined {
    const epoch = this.lineage.findEpoch(provider, backendThreadId);
    const task = epoch && this.lineage.getTask(epoch.publicThreadId);
    return epoch && task?.currentEpochId === epoch.epochId ? epoch.publicThreadId : undefined;
  }

  public hiddenBackendIds(provider?: ProviderKind): Set<string> {
    return new Set(this.lineage.listMappings()
      .filter((mapping) => provider === undefined || mapping.provider === provider)
      .map((mapping) => mapping.backendThreadId));
  }

  public mappings(): EpochBoundary[] { return this.lineage.listMappings(); }
  public segments(publicThreadId: string): TranscriptSegment[] { return this.lineage.listSegments(publicThreadId); }
  public epoch(epochId: string): EpochBoundary | undefined { return this.lineage.getEpoch(epochId); }
  public configuredEpoch(epochId: string): ProviderEpoch | undefined { return this.legacySnapshots?.epochs.get(epochId); }
  public belongs(publicThreadId: string, epochId: string): boolean {
    return this.lineage.epochBelongsToLineage(publicThreadId, epochId);
  }

  public seed(
    thread: Thread,
    provider: ProviderKind,
    model: string,
    settings: Record<string, unknown>,
  ): ResolvedProviderEpoch {
    const existing = this.resolve(thread.id);
    if (existing) return existing;
    const epochId = uuidv7();
    this.lineage.createTask({
      publicThreadId: thread.id,
      currentEpochId: epochId,
      sessionId: thread.sessionId,
      ...(thread.forkedFromId ? { forkedFromId: thread.forkedFromId } : {}),
      ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
      createdAt: thread.createdAt,
    }, { epochId, provider, backendThreadId: thread.id });
    // Operational compatibility mirror: provider payloads are scrubbed by HandoffStore.
    this.legacyMirror?.createLogicalThread({
      thread,
      epoch: { id: epochId, provider, backendThreadId: thread.id, model, settings },
    });
    (this.legacySnapshots?.threads as Map<string, Thread> | undefined)?.set(thread.id, thread);
    (this.legacySnapshots?.epochs as Map<string, ProviderEpoch> | undefined)?.set(epochId, {
      id: epochId,
      publicThreadId: thread.id,
      ordinal: 0,
      provider,
      backendThreadId: thread.id,
      model,
      settings,
      state: "current",
      createdAt: Date.now(),
    });
    return this.resolve(thread.id)!;
  }

  public createFork(
    thread: Thread,
    backendThreadId: string,
    provider: ProviderKind,
    model: string,
    settings: Record<string, unknown>,
    inheritedSegments: readonly NewTranscriptSegment[],
  ): ResolvedProviderEpoch {
    const epochId = uuidv7();
    this.lineage.createForkTask({
      publicThreadId: thread.id,
      currentEpochId: epochId,
      sessionId: thread.sessionId,
      ...(thread.forkedFromId ? { forkedFromId: thread.forkedFromId } : {}),
      ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
      createdAt: thread.createdAt,
    }, { epochId, provider, backendThreadId }, inheritedSegments);
    this.legacyMirror?.createLogicalThread({
      thread,
      epoch: { id: epochId, provider, backendThreadId, model, settings },
    });
    (this.legacySnapshots?.threads as Map<string, Thread> | undefined)?.set(thread.id, thread);
    return this.resolve(thread.id)!;
  }

  public projectThread(
    publicThreadId: string,
    backend: Thread,
    includeTurns: boolean,
    historicalTurns: readonly Turn[] = [],
  ): Thread {
    const resolved = this.resolve(publicThreadId);
    if (!resolved) throw new Error(`Unknown logical thread '${publicThreadId}'.`);
    const base = resolved.logical.thread;
    return {
      ...backend,
      id: publicThreadId,
      sessionId: base.sessionId,
      forkedFromId: base.forkedFromId,
      parentThreadId: base.parentThreadId,
      createdAt: base.createdAt,
      threadSource: publicThreadSource(backend.threadSource),
      turns: includeTurns ? [...historicalTurns, ...backend.turns] : [],
    };
  }

  /** Legacy-test helper; production history is assembled from provider segments. */
  public visibleTurns(publicThreadId: string, currentBackendTurns: readonly Turn[]): Turn[] {
    return [
      ...(this.legacyMirror?.listLogicalTurns(publicThreadId).map((turn) => turn.turn) ?? []),
      ...currentBackendTurns,
    ];
  }
}

function logicalTask(task: PublicTaskIdentity, snapshot?: Thread): LogicalThread {
  return {
    publicThreadId: task.publicThreadId,
    currentEpochId: task.currentEpochId,
    revision: task.revision,
    createdAt: task.createdAt * 1_000,
    updatedAt: task.createdAt * 1_000,
    thread: snapshot ? { ...snapshot, id: task.publicThreadId, turns: [] } : {
      id: task.publicThreadId,
      sessionId: task.sessionId,
      forkedFromId: task.forkedFromId ?? null,
      parentThreadId: task.parentThreadId ?? null,
      createdAt: task.createdAt,
      turns: [],
    } as unknown as Thread,
  };
}

function providerEpoch(boundary: EpochBoundary, mirror?: ProviderEpoch): ProviderEpoch {
  return {
    id: boundary.epochId,
    publicThreadId: boundary.publicThreadId,
    ordinal: boundary.ordinal,
    provider: boundary.provider,
    backendThreadId: boundary.backendThreadId,
    model: mirror?.model ?? "",
    settings: mirror?.settings ?? {},
    state: boundary.state,
    createdAt: mirror?.createdAt ?? 0,
    archivePending: boundary.archivePending,
    deleteDone: boundary.deleteDone,
  };
}
