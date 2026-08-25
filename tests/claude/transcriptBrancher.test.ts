import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compactedTranscript as fixture } from "../fixtures/compactedTranscript.js";
import { SdkTranscriptBrancher, type TranscriptSdk } from "../../src/claude/transcriptBrancher.js";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

class FakeTranscriptSdk {
  public readonly sessions = new Map<string, SessionStoreEntry[]>();
  public readonly deleted: string[] = [];
  public failFork = false;
  public failImport = false;
  public omitProvenanceFor: string | undefined;
  public revealSummaryAfterImports = 0;
  public importCalls = 0;

  public readonly api = {
    forkSession: async (sessionId, options = {}) => {
      if (this.failFork) throw new Error("native fork failed");
      const source = this.sessions.get(sessionId);
      if (!source) throw new Error(`Session ${sessionId} not found`);
      const boundaryIndex = options.upToMessageId
        ? source.findIndex((entry) => entry.uuid === options.upToMessageId)
        : source.length - 1;
      if (boundaryIndex < 0) throw new Error(`Message ${options.upToMessageId} not found in session ${sessionId}`);
      const forkedSessionId = randomUUID();
      const uuidMap = new Map<string, string>();
      for (const entry of source.slice(0, boundaryIndex + 1)) {
        if (entry.isSidechain !== true && entry.type !== "progress" && typeof entry.uuid === "string") {
          uuidMap.set(entry.uuid, randomUUID());
        }
      }
      const copied = source.slice(0, boundaryIndex + 1).flatMap((entry) => {
        if (entry.isSidechain === true || entry.type === "progress" || typeof entry.uuid !== "string") return [];
        const oldUuid = entry.uuid;
        return [{
          ...structuredClone(entry),
          uuid: uuidMap.get(oldUuid),
          parentUuid: typeof entry.parentUuid === "string" ? uuidMap.get(entry.parentUuid) ?? null : null,
          logicalParentUuid: typeof entry.logicalParentUuid === "string" ? uuidMap.get(entry.logicalParentUuid) ?? null : null,
          sessionId: forkedSessionId,
          ...(oldUuid === this.omitProvenanceFor ? {} : { forkedFrom: { sessionId, messageUuid: oldUuid } }),
        } as SessionStoreEntry];
      });
      // 0.3.245 carries session-level markers into the fork regardless of the
      // boundary and writes a fork title from the custom-title sidecar.
      const markers = source.flatMap((entry) =>
        entry.type === "history-suppression" || entry.type === "atis-latch"
          ? [{ ...structuredClone(entry), sessionId: forkedSessionId } as SessionStoreEntry]
          : []);
      const title = source.find((entry) => entry.type === "custom-title");
      this.sessions.set(forkedSessionId, [
        ...copied,
        ...markers,
        ...(title
          ? [{ ...structuredClone(title), sessionId: forkedSessionId, uuid: randomUUID() } as SessionStoreEntry]
          : []),
      ]);
      return { sessionId: forkedSessionId };
    },
    importSessionToStore: async (sessionId, store, _options = {}) => {
      this.importCalls += 1;
      if (this.failImport) throw new Error("transcript import failed");
      let entries = this.sessions.get(sessionId);
      if (!entries) throw new Error(`Session ${sessionId} not found`);
      if (this.revealSummaryAfterImports >= this.importCalls) {
        entries = entries.slice(0, entries.findIndex((entry) => entry.uuid === fixture.appTurns[2]!.boundary));
      }
      await store.append({ projectKey: "fixture", sessionId }, structuredClone(entries));
    },
    deleteSession: async (sessionId) => {
      this.deleted.push(sessionId);
      this.sessions.delete(sessionId);
    },
  } satisfies TranscriptSdk;
}

function currentParentChain(entries: readonly SessionStoreEntry[]): string[] {
  const messages = entries.filter((entry) =>
    (entry.type === "user" || entry.type === "assistant") && typeof entry.uuid === "string",
  );
  const byId = new Map(messages.map((entry) => [entry.uuid!, entry]));
  const chain: string[] = [];
  let current = messages.at(-1);
  while (current?.uuid) {
    chain.push(current.uuid);
    current = typeof current.parentUuid === "string" ? byId.get(current.parentUuid) : undefined;
  }
  return chain.reverse();
}

describe("SdkTranscriptBrancher", () => {
  it("forks a raw pre-compaction boundary and validates every retained provenance mapping", async () => {
    const sdk = new FakeTranscriptSdk();
    sdk.sessions.set(fixture.sessionId, structuredClone(fixture.entries));
    const brancher = new SdkTranscriptBrancher(sdk.api, { attempts: 1, delayMs: 0 });
    const retained = fixture.appTurns.slice(0, 4).map((turn) => turn.boundary!);

    expect(currentParentChain(fixture.entries)).not.toContain(fixture.appTurns[0]!.boundary);
    const fork = await brancher.forkWithProvenance(
      fixture.sessionId, fixture.appTurns[3]!.boundary!, "/fixture/project", retained,
    );

    expect(fork.sessionId).not.toBe(fixture.sessionId);
    expect([...fork.uuidMap.keys()]).toEqual(expect.arrayContaining(retained));
    const copied = sdk.sessions.get(fork.sessionId)!;
    for (const oldUuid of retained) {
      expect(copied).toContainEqual(expect.objectContaining({
        uuid: fork.uuidMap.get(oldUuid), forkedFrom: { sessionId: fixture.sessionId, messageUuid: oldUuid },
      }));
    }
    // Provenance validation ignores the preserved UUID-less fork markers and
    // the sidecar-derived fork title.
    expect(copied).toContainEqual(expect.objectContaining({
      type: "history-suppression", sessionId: fork.sessionId,
    }));
    expect(copied).toContainEqual(expect.objectContaining({
      type: "atis-latch", atis: "latch-token", sessionId: fork.sessionId,
    }));
    expect(copied).toContainEqual(expect.objectContaining({
      type: "custom-title", customTitle: "Synthetic lighthouse", sessionId: fork.sessionId,
    }));
  });

  it("maps a normalized multi-block SDK uuid to the canonical Claude transcript boundary", async () => {
    const sdk = new FakeTranscriptSdk();
    const sourceSessionId = randomUUID();
    const normalizedUuid = "615c5536-95e6-424f-ab9c-000000000001";
    const canonicalUuid = "615c5536-95e6-424f-ab9c-b58dfadd4e58";
    const latestUuid = randomUUID();
    sdk.sessions.set(sourceSessionId, [
      {
        type: "assistant", uuid: canonicalUuid, parentUuid: null, sessionId: sourceSessionId,
        requestId: "req-multiblock", message: { id: "msg-multiblock" },
      } as SessionStoreEntry,
      {
        type: "assistant", uuid: latestUuid, parentUuid: canonicalUuid, sessionId: sourceSessionId,
        requestId: "req-latest", message: { id: "msg-latest" },
      } as SessionStoreEntry,
    ]);
    const brancher = new SdkTranscriptBrancher(sdk.api);

    const fork = await brancher.forkWithProvenance(
      sourceSessionId,
      latestUuid,
      "/fixture/project",
      [normalizedUuid, latestUuid],
      new Map([[normalizedUuid, { requestId: "req-multiblock", messageId: "msg-multiblock" }]]),
    );

    expect(fork.uuidMap.get(normalizedUuid)).toBeDefined();
    expect(sdk.sessions.get(fork.sessionId)).toContainEqual(expect.objectContaining({
      uuid: fork.uuidMap.get(normalizedUuid),
      forkedFrom: { sessionId: sourceSessionId, messageUuid: canonicalUuid },
    }));
  });

  it("resolves the generated post-compaction summary rather than an older or later assistant", async () => {
    const sdk = new FakeTranscriptSdk();
    sdk.sessions.set(fixture.sessionId, structuredClone(fixture.entries));
    const brancher = new SdkTranscriptBrancher(sdk.api);

    await expect(brancher.resolveCompactionBoundary(fixture.sessionId, "/fixture/project", {
      uuid: fixture.entries[4]!.uuid!, compact_metadata: {},
    })).resolves.toBe(fixture.appTurns[2]!.boundary);
  });

  it("waits for the summary append instead of treating the compact event as terminal", async () => {
    const sdk = new FakeTranscriptSdk();
    sdk.sessions.set(fixture.sessionId, structuredClone(fixture.entries));
    sdk.revealSummaryAfterImports = 2;
    const brancher = new SdkTranscriptBrancher(sdk.api, { attempts: 4, delayMs: 0 });

    await expect(brancher.resolveCompactionBoundary(fixture.sessionId, "/fixture/project", {
      uuid: fixture.entries[4]!.uuid!, compact_metadata: {},
    })).resolves.toBe(fixture.appTurns[2]!.boundary);
    expect(sdk.importCalls).toBe(3);
  });

  it.each(["import", "mapping"] as const)("deletes the temporary fork after %s validation failure", async (failure) => {
    const sdk = new FakeTranscriptSdk();
    sdk.sessions.set(fixture.sessionId, structuredClone(fixture.entries));
    if (failure === "import") sdk.failImport = true;
    else sdk.omitProvenanceFor = fixture.appTurns[0]!.boundary!;
    const brancher = new SdkTranscriptBrancher(sdk.api, { attempts: 1, delayMs: 0 });

    await expect(brancher.forkWithProvenance(
      fixture.sessionId,
      fixture.appTurns[3]!.boundary!,
      "/fixture/project",
      fixture.appTurns.slice(0, 4).map((turn) => turn.boundary!),
    )).rejects.toThrow(failure === "import" ? "transcript import failed" : "missing provenance");
    expect(sdk.deleted).toHaveLength(1);
    expect([...sdk.sessions.keys()]).toEqual([fixture.sessionId]);
  });
});
