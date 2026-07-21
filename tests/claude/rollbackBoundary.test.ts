import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SDKMessage, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { compactedTranscript as fixture } from "../fixtures/compactedTranscript.js";
import { ClaudeService } from "../../src/claude/service.js";
import type { TranscriptBrancher, CompactionBoundary, ForkedTranscript } from "../../src/claude/transcriptBrancher.js";
import type { HybridConfig } from "../../src/config/config.js";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import type { ClaudeThreadRecord, TurnProviderBoundary } from "../../src/store/HybridStore.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";

const directories: string[] = [];

function config(dataDir: string): HybridConfig {
  return {
    realCodex: "/bin/false", claudeBinary: "/bin/false", dataDir,
    publicSocket: join(dataDir, "gateway.sock"), modelPrefix: "claude:",
    idleTimeoutSeconds: 900, modelCacheSeconds: 300, logLevel: "error",
    logPrompts: false, debugCapture: false, debugLogMaxBytes: 1_048_576,
  };
}

function turn(id: string, status: Turn["status"], compaction = false): Turn {
  const item = compaction
    ? { type: "contextCompaction" as const, id: `${id}-item` }
    : { type: "agentMessage" as const, id: `${id}-item`, text: id, phase: null, memoryCitation: null };
  return {
    id, items: [item], itemsView: "full", status, error: null,
    startedAt: 1, completedAt: status === "inProgress" ? null : 2, durationMs: status === "inProgress" ? null : 1_000,
  };
}

function record(directory: string): ClaudeThreadRecord {
  return {
    thread: {
      id: "rollback-thread", extra: null, sessionId: randomUUID(), forkedFromId: null, parentThreadId: null,
      preview: "compacted branch", ephemeral: false, historyMode: "legacy", modelProvider: "claude",
      createdAt: 1, updatedAt: 2, recencyAt: 2, status: { type: "idle" }, path: null, cwd: directory,
      cliVersion: "2.1.209", source: "appServer", threadSource: null, agentNickname: null, agentRole: null,
      gitInfo: null, name: "rollback fixture ✳️", turns: [],
    },
    claudeSessionId: fixture.sessionId,
    modelPickerId: "claude:claude-fable-5", claudeModelValue: "claude-fable-5", serviceTier: null,
    approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite" },
    baseInstructions: null, developerInstructions: null, personality: null, resolvedModel: "claude-fable-5",
    lastClaudeMessageUuid: fixture.appTurns[3]!.boundary, lastCompletedTurnId: fixture.appTurns[3]!.id,
    claudeCodeVersion: "2.1.209", reasoningEffort: "high", reasoningSummary: "detailed",
    collaborationMode: null, outputSchema: null,
    tokenUsageTotal: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 50, outputTokens: 10, reasoningOutputTokens: 0 },
    tokenUsageLast: { totalTokens: 20, inputTokens: 18, cachedInputTokens: 10, outputTokens: 2, reasoningOutputTokens: 0 },
    modelContextWindow: 200_000, settingsGeneration: 3,
  };
}

function seed(store: SqliteHybridStore, directory: string): void {
  store.createThread(record(directory));
  fixture.appTurns.forEach((entry, index) => {
    store.createTurn("rollback-thread", turn(entry.id, entry.status as Turn["status"], index === 2));
    if (entry.boundary) store.setTurnClaudeMessageUuid("rollback-thread", entry.id, entry.boundary);
  });
}

class FixtureBrancher implements TranscriptBrancher {
  public readonly sessions = new Map<string, SessionStoreEntry[]>([[fixture.sessionId, structuredClone(fixture.entries)]]);
  public readonly events: string[] = [];
  public fail: "fork" | "import" | "mapping" | undefined;
  public failDeleteSession: string | undefined;
  public afterForkValidated: (() => void | Promise<void>) | undefined;

  public async forkWithProvenance(
    sourceSessionId: string,
    boundaryUuid: string,
    _cwd: string,
    expectedBoundaries: readonly string[],
  ): Promise<ForkedTranscript> {
    if (this.fail === "fork") throw new Error("native fork failed");
    const source = this.sessions.get(sourceSessionId)!;
    const boundaryIndex = source.findIndex((entry) => entry.uuid === boundaryUuid);
    if (boundaryIndex < 0) throw new Error(`Message ${boundaryUuid} not found in session ${sourceSessionId}`);
    const sessionId = randomUUID();
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
        ...structuredClone(entry), uuid: uuidMap.get(oldUuid), sessionId,
        parentUuid: typeof entry.parentUuid === "string" ? uuidMap.get(entry.parentUuid) ?? null : null,
        logicalParentUuid: typeof entry.logicalParentUuid === "string" ? uuidMap.get(entry.logicalParentUuid) ?? null : null,
        ...(this.fail === "mapping" && oldUuid === expectedBoundaries[0]
          ? {} : { forkedFrom: { sessionId: sourceSessionId, messageUuid: oldUuid } }),
      } as SessionStoreEntry];
    });
    this.sessions.set(sessionId, copied);
    this.events.push(`fork:${sessionId}`);
    try {
      if (this.fail === "import") throw new Error("transcript import failed");
      const missing = expectedBoundaries.find((uuid) =>
        !copied.some((entry) => (entry.forkedFrom as { messageUuid?: string } | undefined)?.messageUuid === uuid));
      if (missing) throw new Error(`Claude fork is missing provenance for retained boundary '${missing}'.`);
      await this.afterForkValidated?.();
      return { sessionId, uuidMap };
    } catch (error) {
      await this.delete(sessionId, _cwd);
      throw error;
    }
  }

  public async resolveCompactionBoundary(_sessionId: string, _cwd: string, boundary: CompactionBoundary): Promise<string> {
    return boundary.compact_metadata.preserved_messages?.anchor_uuid
      ?? boundary.compact_metadata.preserved_segment?.anchor_uuid
      ?? fixture.appTurns[2]!.boundary!;
  }

  public async delete(sessionId: string, _cwd: string): Promise<void> {
    this.events.push(`delete:${sessionId}`);
    if (this.failDeleteSession === sessionId) throw new Error("delete failed");
    this.sessions.delete(sessionId);
  }
}

class ObservingStore extends SqliteHybridStore {
  public readonly events: string[] = [];
  public failCommit = false;

  public override commitThreadRollback(
    next: ClaudeThreadRecord,
    keepCount: number,
    boundaries: readonly TurnProviderBoundary[],
  ): void {
    this.events.push("commit:rollback");
    if (this.failCommit) throw new Error("injected SQLite commit failure");
    super.commitThreadRollback(next, keepCount, boundaries);
  }

  public override commitForkedThread(
    next: ClaudeThreadRecord,
    turns: readonly Turn[],
    boundaries: readonly TurnProviderBoundary[],
  ): void {
    this.events.push("commit:fork");
    super.commitForkedThread(next, turns, boundaries);
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function rateLimitSourceCount(service: ClaudeService): number {
  return (service as unknown as { rateLimits: { sources: Map<number, unknown> } }).rateLimits.sources.size;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("compacted transcript rollback boundary", () => {
  it("replaces the retired runtime's rate-limit source exactly once on rollback and lazy resume", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-rollback-rate-source-"));
    directories.push(directory);
    const store = new ObservingStore(join(directory, "state.sqlite"));
    seed(store, directory);
    const brancher = new FixtureBrancher();
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), store,
      new FakeClaudeQuery().factory, undefined, undefined, brancher,
    );
    await service.resumeThread({ threadId: "rollback-thread", excludeTurns: false });
    expect(rateLimitSourceCount(service)).toBe(1);

    await service.rollbackThread({ threadId: "rollback-thread", numTurns: 1 });
    expect(rateLimitSourceCount(service)).toBe(0);
    await service.readRateLimits("rollback-thread");
    expect(rateLimitSourceCount(service)).toBe(1);
    await service.close();
  });

  it("atomically remaps all retained boundaries and supports deeper rollback plus visible fork", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-rollback-boundary-"));
    directories.push(directory);
    const store = new ObservingStore(join(directory, "state.sqlite"));
    seed(store, directory);
    const brancher = new FixtureBrancher();
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), store, fake.factory, undefined, undefined, brancher,
    );

    const first = await service.rollbackThread({ threadId: "rollback-thread", numTurns: 1 });
    expect(first.thread.turns.map((candidate) => candidate.id)).toEqual(fixture.appTurns.slice(0, 4).map((entry) => entry.id));
    const firstSession = store.getThreadRecord("rollback-thread")!.claudeSessionId;
    expect(firstSession).not.toBe(fixture.sessionId);
    const copied = brancher.sessions.get(firstSession)!;
    expect(JSON.stringify(copied)).toContain("synthetic lighthouse");
    for (const retained of fixture.appTurns.slice(0, 4)) {
      const remapped = store.getTurnClaudeMessageUuid("rollback-thread", retained.id)!;
      expect(copied).toContainEqual(expect.objectContaining({
        uuid: remapped,
        forkedFrom: { sessionId: fixture.sessionId, messageUuid: retained.boundary },
      }));
    }
    expect(brancher.events.indexOf(`delete:${fixture.sessionId}`)).toBeGreaterThan(brancher.events.indexOf(`fork:${firstSession}`));
    expect(store.events).toEqual(["commit:rollback"]);

    const visible = await service.forkThread({ threadId: "rollback-thread", lastTurnId: fixture.appTurns[0]!.id });
    expect(visible.thread.turns.map((candidate) => candidate.id)).toEqual([fixture.appTurns[0]!.id]);
    expect(service.readThread("rollback-thread", true).thread.turns).toHaveLength(4);

    const second = await service.rollbackThread({ threadId: "rollback-thread", numTurns: 3 });
    expect(second.thread.turns.map((candidate) => candidate.id)).toEqual([fixture.appTurns[0]!.id]);
    const secondSession = store.getThreadRecord("rollback-thread")!.claudeSessionId;
    expect(brancher.sessions.get(secondSession)).toContainEqual(expect.objectContaining({
      uuid: store.getTurnClaudeMessageUuid("rollback-thread", fixture.appTurns[0]!.id),
      forkedFrom: expect.objectContaining({ sessionId: firstSession }),
    }));

    const prepared = await service.prepareTurn({
      threadId: "rollback-thread",
      collaborationMode: {
        mode: "default",
        settings: { model: "claude:claude-fable-5", reasoning_effort: "high", developer_instructions: null },
      },
      input: [{ type: "text", text: "replacement", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(() => service.readThread("rollback-thread", true).thread.turns.at(-1)?.status === "completed", "resent turn");
    expect(fake.inputs.at(-1)?.options).toMatchObject({ model: "claude-fable-5", effort: "high", resume: secondSession });
    expect(service.readThread("rollback-thread", true).thread.turns.filter((candidate) =>
      candidate.items.some((item) => item.type === "userMessage"))).toHaveLength(1);
    expect(brancher.sessions.size).toBe(2);
    await service.close();
  });

  it("replays interrupt -> rollback -> resend High as one edited branch without an error projection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-rollback-rpc-replay-"));
    directories.push(directory);
    const store = new ObservingStore(join(directory, "state.sqlite"));
    seed(store, directory);
    store.truncateTurns("rollback-thread", 4);
    const seeded = store.getThreadRecord("rollback-thread")!;
    store.updateThread({ ...seeded, lastCompletedTurnId: fixture.appTurns[3]!.id });
    let releaseActive!: () => void;
    const activePause = new Promise<void>((resolve) => { releaseActive = resolve; });
    const streamStart = {
      type: "stream_event", event: { type: "message_start", message: {} },
      parent_tool_use_id: null, uuid: randomUUID(), session_id: fixture.sessionId,
    } as unknown as SDKMessage;
    const activeFake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined,
      [streamStart], { afterIndex: 0, wait: activePause },
    );
    const resentFake = new FakeClaudeQuery();
    let queryIndex = 0;
    const brancher = new FixtureBrancher();
    const hub = new SubscriptionHub();
    const wire: Array<{ method: string; params: unknown }> = [];
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), store,
      (input) => (queryIndex++ === 0 ? activeFake : resentFake).factory(input),
      undefined, undefined, brancher,
    );
    hub.subscribe("rollback-thread", "rpc-replay", (method, params) => wire.push({ method, params }));

    await service.resumeThread({ threadId: "rollback-thread", excludeTurns: false });
    const interrupted = await service.prepareTurn({
      threadId: "rollback-thread", effort: null,
      input: [{ type: "text", text: "message before edit", text_elements: [] }],
    });
    interrupted.announce();
    interrupted.start();
    await waitFor(() => activeFake.prompts.length === 1, "active edit target");
    await service.interruptTurn({ threadId: "rollback-thread", turnId: interrupted.response.turn.id });
    releaseActive();
    await waitFor(() => service.readThread("rollback-thread", true).thread.status.type === "idle", "interrupted runtime idle");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const rollback = await service.rollbackThread({ threadId: "rollback-thread", numTurns: 1 });
    expect(rollback.thread.turns).toHaveLength(4);
    const resent = await service.prepareTurn({
      threadId: "rollback-thread", effort: null,
      collaborationMode: {
        mode: "default",
        settings: { model: "claude:claude-fable-5", reasoning_effort: "high", developer_instructions: null },
      },
      input: [{ type: "text", text: "edited replacement", text_elements: [] }],
    });
    resent.announce();
    resent.start();
    await waitFor(() => service.readThread("rollback-thread", true).thread.turns.at(-1)?.status === "completed", "edited resend");

    expect(wire.filter((event) => event.method === "error")).toEqual([]);
    expect(wire.filter((event) => event.method === "turn/started")).toHaveLength(2);
    expect(wire.filter((event) => event.method === "turn/completed")).toHaveLength(2);
    expect(wire.filter((event) => event.method === "turn/completed").map((event) =>
      (event.params as { turn: Turn }).turn.status)).toEqual(["interrupted", "completed"]);
    expect(resentFake.inputs[0]?.options).toMatchObject({ model: "claude-fable-5", effort: "high" });
    const edited = service.readThread("rollback-thread", true).thread;
    expect(JSON.stringify(edited.turns)).not.toContain("message before edit");
    expect(JSON.stringify(edited.turns).match(/edited replacement/g)).toHaveLength(1);
    const beforeReconnect = structuredClone(edited.turns);
    await service.resumeThread({ threadId: "rollback-thread", excludeTurns: false });
    expect(service.readThread("rollback-thread", true).thread.turns).toEqual(beforeReconnect);
    await service.close();
  });

  it("reopens the remapped branch after gateway restart and still permits a deeper rollback", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-rollback-restart-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const brancher = new FixtureBrancher();
    const firstStore = new ObservingStore(database);
    seed(firstStore, directory);
    const first = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), firstStore,
      new FakeClaudeQuery().factory, undefined, undefined, brancher,
    );
    await first.rollbackThread({ threadId: "rollback-thread", numTurns: 1 });
    const replacementSession = firstStore.getThreadRecord("rollback-thread")!.claudeSessionId;
    const remappedBeforeRestart = fixture.appTurns.slice(0, 4).map((candidate) =>
      firstStore.getTurnClaudeMessageUuid("rollback-thread", candidate.id));
    await first.close();

    const reopenedStore = new ObservingStore(database);
    const reopened = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), reopenedStore,
      new FakeClaudeQuery().factory, undefined, undefined, brancher,
    );
    expect(reopenedStore.getThreadRecord("rollback-thread")!.claudeSessionId).toBe(replacementSession);
    expect(fixture.appTurns.slice(0, 4).map((candidate) =>
      reopenedStore.getTurnClaudeMessageUuid("rollback-thread", candidate.id))).toEqual(remappedBeforeRestart);
    await expect(reopened.rollbackThread({ threadId: "rollback-thread", numTurns: 3 })).resolves.toMatchObject({
      thread: { turns: [{ id: fixture.appTurns[0]!.id }] },
    });
    await reopened.close();
  });

  it.each(["fork", "import", "mapping", "commit"] as const)(
    "leaves thread, turns, settings, session, and runtime ownership unchanged after %s failure",
    async (failure) => {
      const directory = mkdtempSync(join(tmpdir(), `ccodex-rollback-${failure}-`));
      directories.push(directory);
      const store = new ObservingStore(join(directory, "state.sqlite"));
      seed(store, directory);
      const brancher = new FixtureBrancher();
      if (failure === "commit") store.failCommit = true;
      else brancher.fail = failure;
      const service = new ClaudeService(
        config(directory), new SubscriptionHub(), new Logger("error"), store,
        new FakeClaudeQuery().factory, undefined, undefined, brancher,
      );
      await service.resumeThread({ threadId: "rollback-thread", excludeTurns: false });
      await waitFor(() => {
        const current = store.getThreadRecord("rollback-thread")!;
        return current.claudeCodeVersion === "test" && current.tokenUsageLast?.totalTokens === 24;
      }, "resumed runtime stabilization");
      const before = store.getThreadRecord("rollback-thread", true)!;
      const beforeBoundaries = before.thread.turns.map((candidate) =>
        store.getTurnClaudeMessageUuid("rollback-thread", candidate.id));

      await expect(service.rollbackThread({ threadId: "rollback-thread", numTurns: 1 })).rejects.toThrow();
      expect(store.getThreadRecord("rollback-thread", true)).toEqual(before);
      expect(before.thread.turns.map((candidate) => store.getTurnClaudeMessageUuid("rollback-thread", candidate.id)))
        .toEqual(beforeBoundaries);
      expect(service.loadedThreadIds()).toEqual(["rollback-thread"]);
      expect(rateLimitSourceCount(service)).toBe(1);
      expect([...brancher.sessions.keys()]).toEqual([fixture.sessionId]);
      await service.close();
    },
  );

  it("keeps the committed replacement when old-session deletion fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-rollback-delete-"));
    directories.push(directory);
    const store = new ObservingStore(join(directory, "state.sqlite"));
    seed(store, directory);
    const brancher = new FixtureBrancher();
    brancher.failDeleteSession = fixture.sessionId;
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), store,
      new FakeClaudeQuery().factory, undefined, undefined, brancher,
    );

    await expect(service.rollbackThread({ threadId: "rollback-thread", numTurns: 1 })).resolves.toBeDefined();
    expect(store.getThreadRecord("rollback-thread")!.claudeSessionId).not.toBe(fixture.sessionId);
    expect(store.listTurns("rollback-thread")).toHaveLength(4);
    await service.close();
  });

  it("deletes the temporary fork and preserves a concurrent source mutation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-rollback-concurrent-"));
    directories.push(directory);
    const store = new ObservingStore(join(directory, "state.sqlite"));
    seed(store, directory);
    const brancher = new FixtureBrancher();
    brancher.afterForkValidated = () => {
      store.createTurn("rollback-thread", turn("concurrent-turn", "completed"));
    };
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), store,
      new FakeClaudeQuery().factory, undefined, undefined, brancher,
    );

    await expect(service.rollbackThread({ threadId: "rollback-thread", numTurns: 1 }))
      .rejects.toThrow("changed while rollback was being prepared");
    expect(store.listTurns("rollback-thread").map((candidate) => candidate.id).at(-1)).toBe("concurrent-turn");
    expect(store.getThreadRecord("rollback-thread")!.claudeSessionId).toBe(fixture.sessionId);
    expect([...brancher.sessions.keys()]).toEqual([fixture.sessionId]);
    await service.close();
  });

  it("keeps an explicit fork pinned to its selected prefix while the later source tail changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-fork-selected-prefix-"));
    directories.push(directory);
    const store = new ObservingStore(join(directory, "state.sqlite"));
    seed(store, directory);
    const brancher = new FixtureBrancher();
    brancher.afterForkValidated = () => {
      store.createTurn("rollback-thread", turn("later-concurrent-turn", "completed"));
    };
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), store,
      new FakeClaudeQuery().factory, undefined, undefined, brancher,
    );

    const fork = await service.forkThread({
      threadId: "rollback-thread",
      lastTurnId: fixture.appTurns[0]!.id,
    });
    expect(fork.thread.turns.map((candidate) => candidate.id)).toEqual([fixture.appTurns[0]!.id]);
    expect(store.listTurns("rollback-thread").at(-1)?.id).toBe("later-concurrent-turn");
    await service.close();
  });

  it("snapshots a streaming source turn as interrupted and lets App rollback select the completed boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-fork-active-snapshot-"));
    directories.push(directory);
    const store = new ObservingStore(join(directory, "state.sqlite"));
    seed(store, directory);
    const active = turn("active-source-turn", "inProgress");
    const brancher = new FixtureBrancher();
    brancher.afterForkValidated = () => {
      store.updateTurn("rollback-thread", {
        ...active,
        items: [{
          type: "agentMessage", id: "late-source-delta", text: "source kept streaming",
          phase: null, memoryCitation: null,
        }],
      });
    };
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), store,
      new FakeClaudeQuery().factory, undefined, undefined, brancher,
    );
    await service.ready();
    store.createTurn("rollback-thread", active);

    const fork = await service.forkThread({ threadId: "rollback-thread" });
    expect(fork.thread.turns.at(-1)).toMatchObject({
      id: active.id,
      status: "interrupted",
      items: active.items,
    });
    expect(store.getThreadRecord(fork.thread.id)?.lastCompletedTurnId)
      .toBe(fixture.appTurns.filter((candidate) => candidate.boundary).at(-1)?.id);
    expect(store.getTurn("rollback-thread", active.id)).toMatchObject({
      status: "inProgress",
      items: [expect.objectContaining({ text: "source kept streaming" })],
    });

    const rolled = await service.rollbackThread({ threadId: fork.thread.id, numTurns: 1 });
    expect(rolled.thread.turns.map((candidate) => candidate.id))
      .toEqual(fixture.appTurns.map((candidate) => candidate.id));
    expect(store.getTurn("rollback-thread", active.id)?.status).toBe("inProgress");
    await service.close();
  });

  it("deletes an explicit fork when its selected prefix changes before commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-fork-prefix-conflict-"));
    directories.push(directory);
    const store = new ObservingStore(join(directory, "state.sqlite"));
    seed(store, directory);
    const brancher = new FixtureBrancher();
    brancher.afterForkValidated = () => {
      store.updateTurn("rollback-thread", turn(fixture.appTurns[0]!.id, "interrupted"));
    };
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), store,
      new FakeClaudeQuery().factory, undefined, undefined, brancher,
    );

    await expect(service.forkThread({
      threadId: "rollback-thread",
      lastTurnId: fixture.appTurns[0]!.id,
    })).rejects.toThrow("changed while branch was being prepared");
    expect([...brancher.sessions.keys()]).toEqual([fixture.sessionId]);
    await service.close();
  });

  it("keeps an active /side fork pinned while the parent turn streams new items", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-side-stable-prefix-"));
    directories.push(directory);
    const store = new ObservingStore(join(directory, "state.sqlite"));
    seed(store, directory);
    const active = turn("active-parent", "inProgress");
    const brancher = new FixtureBrancher();
    brancher.afterForkValidated = () => {
      store.updateTurn("rollback-thread", {
        ...active,
        items: [{ type: "agentMessage", id: "late-item", text: "late parent delta", phase: null, memoryCitation: null }],
      });
    };
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), store,
      new FakeClaudeQuery().factory, undefined, undefined, brancher,
    );
    await service.ready();
    store.createTurn("rollback-thread", active);

    const fork = await service.forkThread({
      threadId: "rollback-thread",
      threadSource: "user",
      ephemeral: true,
      excludeTurns: true,
    });
    expect(fork.thread).toMatchObject({ ephemeral: true, turns: [] });
    expect(JSON.stringify(store.getTurn("rollback-thread", "active-parent"))).toContain("late parent delta");
    await service.releaseEphemeralThread(fork.thread.id);
    await service.close();
  });

  it("persists manual and auto compaction boundaries before terminal projection and lets later assistants win", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-compaction-boundary-"));
    directories.push(directory);
    let releaseBoundary!: (uuid: string) => void;
    const delayedBoundary = new Promise<string>((resolve) => { releaseBoundary = resolve; });
    const brancher: TranscriptBrancher = {
      forkWithProvenance: async () => { throw new Error("unused"); },
      resolveCompactionBoundary: async () => delayedBoundary,
      delete: async () => undefined,
    };
    const manualFake = new FakeClaudeQuery(undefined, undefined, [], true);
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const events: string[] = [];
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), store, manualFake.factory, undefined, undefined, brancher,
    );
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory });
    hub.subscribe(started.thread.id, "compact", (method) => events.push(method));
    await service.compactThread(started.thread.id);
    await waitFor(() => manualFake.prompts.length === 1, "manual compact prompt");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const compactTurn = service.readThread(started.thread.id, true).thread.turns[0]!;
    expect(compactTurn.status).toBe("inProgress");
    expect(store.getTurnClaudeMessageUuid(started.thread.id, compactTurn.id)).toBeUndefined();
    expect(events).not.toContain("thread/compacted");
    releaseBoundary("manual-summary-boundary");
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed", "manual compact completion");
    expect(store.getTurnClaudeMessageUuid(started.thread.id, compactTurn.id)).toBe("manual-summary-boundary");
    expect(events.filter((method) => method === "thread/compacted")).toHaveLength(1);
    await service.close();

    const autoDirectory = mkdtempSync(join(tmpdir(), "ccodex-auto-boundary-"));
    directories.push(autoDirectory);
    const compactUuid = randomUUID();
    const laterAssistantUuid = randomUUID();
    const autoMessages = [
      {
        type: "system", subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 100, post_tokens: 25 },
        uuid: compactUuid, session_id: "auto-session",
      },
      {
        type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "after compact" }] },
        parent_tool_use_id: null, uuid: laterAssistantUuid, session_id: "auto-session",
      },
    ] as unknown as SDKMessage[];
    const autoStore = new SqliteHybridStore(join(autoDirectory, "state.sqlite"));
    const autoBrancher: TranscriptBrancher = {
      forkWithProvenance: async () => { throw new Error("unused"); },
      resolveCompactionBoundary: async () => "auto-summary-boundary",
      delete: async () => undefined,
    };
    const autoService = new ClaudeService(
      config(autoDirectory), new SubscriptionHub(), new Logger("error"), autoStore,
      new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, autoMessages).factory,
      undefined, undefined, autoBrancher,
    );
    const auto = await autoService.startThread({ model: "claude:claude-fable-5", cwd: autoDirectory });
    const prepared = await autoService.prepareTurn({
      threadId: auto.thread.id, input: [{ type: "text", text: "auto compact", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(() => autoService.readThread(auto.thread.id, true).thread.turns[0]?.status === "completed", "auto compact turn");
    const autoTurn = autoService.readThread(auto.thread.id, true).thread.turns[0]!;
    expect(autoStore.getTurnClaudeMessageUuid(auto.thread.id, autoTurn.id)).not.toBe("auto-summary-boundary");
    expect(autoStore.getTurnClaudeMessageUuid(auto.thread.id, autoTurn.id)).toBe(autoStore.getThreadRecord(auto.thread.id)!.lastClaudeMessageUuid);
    await autoService.close();
  });
});
