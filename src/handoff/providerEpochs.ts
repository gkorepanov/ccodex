import { v7 as uuidv7 } from "uuid";
import type { Thread } from "../codex/generated/v2/Thread.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import {
  HandoffStore,
  type LogicalThread,
  type NewLogicalTurn,
  type ProviderEpoch,
  type ProviderKind,
} from "./store.js";

export interface ResolvedProviderEpoch {
  readonly logical: LogicalThread;
  readonly epoch: ProviderEpoch;
}

function providerTurns(epochId: string, turns: readonly Turn[]): NewLogicalTurn[] {
  return turns.map((turn) => ({
    publicTurnId: turn.id,
    epochId,
    providerTurnId: turn.id,
    turn,
    kind: "provider",
  }));
}

export class ProviderEpochs {
  public constructor(private readonly store: HandoffStore) {}

  public resolve(publicThreadId: string): ResolvedProviderEpoch | undefined {
    const logical = this.store.getLogicalThread(publicThreadId);
    const epoch = logical && this.store.getEpoch(logical.currentEpochId);
    return logical && epoch ? { logical, epoch } : undefined;
  }

  public publicId(provider: ProviderKind, backendThreadId: string): string | undefined {
    const epoch = this.store.findEpochByBackend(provider, backendThreadId);
    return epoch?.state === "current" ? epoch.publicThreadId : undefined;
  }

  public hiddenBackendIds(provider?: ProviderKind): Set<string> {
    return new Set(this.store.listBackendMappings()
      .filter((mapping) => provider === undefined || mapping.provider === provider)
      .map((mapping) => mapping.backendThreadId));
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
    const logical = this.store.createLogicalThread({
      thread,
      epoch: { id: epochId, provider, backendThreadId: thread.id, model, settings },
    });
    return this.resolve(thread.id)!;
  }

  public visibleTurns(publicThreadId: string, currentBackendTurns: readonly Turn[]): Turn[] {
    return [
      ...this.store.listLogicalTurns(publicThreadId).map((turn) => turn.turn),
      ...currentBackendTurns,
    ];
  }

  public snapshotTurns(publicThreadId: string, currentBackendTurns: readonly Turn[]): NewLogicalTurn[] {
    const resolved = this.resolve(publicThreadId);
    if (!resolved) throw new Error(`Unknown logical thread '${publicThreadId}'.`);
    return [
      ...this.store.listLogicalTurns(publicThreadId).map((turn) => ({
        publicTurnId: turn.publicTurnId,
        ...(turn.epochId ? { epochId: turn.epochId } : {}),
        ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
        turn: turn.turn,
        kind: turn.kind,
      })),
      ...providerTurns(resolved.epoch.id, currentBackendTurns),
    ];
  }

  public projectThread(
    publicThreadId: string,
    backend: Thread,
    includeTurns: boolean,
  ): Thread {
    const resolved = this.resolve(publicThreadId);
    if (!resolved) throw new Error(`Unknown logical thread '${publicThreadId}'.`);
    const base = resolved.logical.thread;
    return {
      ...backend,
      id: publicThreadId,
      forkedFromId: base.forkedFromId,
      name: base.name ?? backend.name,
      createdAt: base.createdAt,
      turns: includeTurns ? this.visibleTurns(publicThreadId, backend.turns) : [],
    };
  }
}
