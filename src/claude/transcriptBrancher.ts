import {
  deleteSession,
  forkSession,
  importSessionToStore,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

export interface ForkedTranscript {
  readonly sessionId: string;
  readonly uuidMap: ReadonlyMap<string, string>;
}

export interface CompactionBoundary {
  readonly uuid: string;
  readonly compact_metadata: {
    readonly preserved_segment?: { readonly anchor_uuid: string };
    readonly preserved_messages?: { readonly anchor_uuid: string };
  };
}

export interface TranscriptBrancher {
  forkWithProvenance(
    sourceSessionId: string,
    boundaryUuid: string,
    cwd: string,
    expectedBoundaries: readonly string[],
  ): Promise<ForkedTranscript>;
  resolveCompactionBoundary(sessionId: string, cwd: string, boundary: CompactionBoundary): Promise<string>;
  delete(sessionId: string, cwd: string): Promise<void>;
}

export interface TranscriptSdk {
  forkSession: typeof forkSession;
  importSessionToStore: typeof importSessionToStore;
  deleteSession: typeof deleteSession;
}

class RecordingSessionStore implements SessionStore {
  private readonly mainEntries: SessionStoreEntry[] = [];

  public constructor(private readonly sessionId: string) {}

  public async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (key.sessionId === this.sessionId && key.subpath === undefined) this.mainEntries.push(...structuredClone(entries));
  }

  public async load(_key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return null;
  }

  public entries(): readonly SessionStoreEntry[] {
    return this.mainEntries;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function provenance(entry: SessionStoreEntry): {
  sessionId: string | undefined;
  messageUuid: string | undefined;
} | undefined {
  const value = entry.forkedFrom;
  if (!value || typeof value !== "object") return undefined;
  const fields = value as Record<string, unknown>;
  return { sessionId: stringField(fields.sessionId), messageUuid: stringField(fields.messageUuid) };
}

export class SdkTranscriptBrancher implements TranscriptBrancher {
  public constructor(
    private readonly sdk: TranscriptSdk = { forkSession, importSessionToStore, deleteSession },
    private readonly compactionPoll: { readonly attempts: number; readonly delayMs: number } = { attempts: 8, delayMs: 10 },
  ) {}

  public async forkWithProvenance(
    sourceSessionId: string,
    boundaryUuid: string,
    cwd: string,
    expectedBoundaries: readonly string[],
  ): Promise<ForkedTranscript> {
    let forkedSessionId: string | undefined;
    try {
      const fork = await this.sdk.forkSession(sourceSessionId, { dir: cwd, upToMessageId: boundaryUuid });
      forkedSessionId = fork.sessionId;
      const recording = new RecordingSessionStore(fork.sessionId);
      await this.sdk.importSessionToStore(fork.sessionId, recording, { dir: cwd, includeSubagents: false });
      const uuidMap = new Map<string, string>();
      for (const entry of recording.entries()) {
        const copiedFrom = provenance(entry);
        const newUuid = stringField(entry.uuid);
        if (copiedFrom?.sessionId !== sourceSessionId || !copiedFrom.messageUuid || !newUuid) continue;
        const previous = uuidMap.get(copiedFrom.messageUuid);
        if (previous && previous !== newUuid) {
          throw new Error(`Claude fork contains conflicting provenance for boundary '${copiedFrom.messageUuid}'.`);
        }
        uuidMap.set(copiedFrom.messageUuid, newUuid);
      }
      const required = new Set([boundaryUuid, ...expectedBoundaries]);
      const missing = [...required].filter((uuid) => !uuidMap.has(uuid));
      if (missing.length > 0) {
        throw new Error(`Claude fork is missing provenance for retained boundary '${missing[0]}'.`);
      }
      return { sessionId: fork.sessionId, uuidMap };
    } catch (error) {
      if (forkedSessionId) await this.delete(forkedSessionId, cwd).catch(() => undefined);
      throw error;
    }
  }

  public async resolveCompactionBoundary(
    sessionId: string,
    cwd: string,
    boundary: CompactionBoundary,
  ): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.compactionPoll.attempts; attempt += 1) {
      try {
        const recording = new RecordingSessionStore(sessionId);
        await this.sdk.importSessionToStore(sessionId, recording, { dir: cwd, includeSubagents: false });
        const entries = recording.entries().filter((entry) => entry.isSidechain !== true);
        const boundaryIndex = entries.findIndex((entry) => entry.uuid === boundary.uuid);
        if (boundaryIndex < 0) throw new Error(`Claude transcript does not contain compact boundary '${boundary.uuid}'.`);
        const declaredAnchor = boundary.compact_metadata.preserved_messages?.anchor_uuid
          ?? boundary.compact_metadata.preserved_segment?.anchor_uuid;
        if (declaredAnchor && entries.findIndex((entry) => entry.uuid === declaredAnchor) > boundaryIndex) return declaredAnchor;
        const summary = entries.slice(boundaryIndex + 1).find((entry) =>
          entry.type === "user"
          && typeof entry.uuid === "string"
          && entry.parentUuid === boundary.uuid,
        );
        if (summary?.uuid) return summary.uuid;
        lastError = new Error(`Claude transcript does not contain a resumable summary after compact boundary '${boundary.uuid}'.`);
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < this.compactionPoll.attempts) {
        const delayMs = Math.min(250, this.compactionPoll.delayMs * 2 ** attempt);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError ?? new Error(`Claude transcript did not expose compact boundary '${boundary.uuid}'.`);
  }

  public async delete(sessionId: string, cwd: string): Promise<void> {
    await this.sdk.deleteSession(sessionId, { dir: cwd });
  }
}
