import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeService } from "../../src/claude/service.js";
import type { HybridConfig } from "../../src/config/config.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";
import { formatCCodexStatus } from "../../src/claude/statusCommand.js";
import { formatCCodexState } from "../../src/state/stateCommand.js";

const directories: string[] = [];

function config(dataDir: string): HybridConfig {
  return {
    realCodex: "/bin/false", claudeBinary: "/bin/false", dataDir,
    publicSocket: join(dataDir, "gateway.sock"), modelPrefix: "claude:",
    idleTimeoutSeconds: 900, modelCacheSeconds: 300, logLevel: "error", logPrompts: false,
    debugCapture: false, debugLogMaxBytes: 1_048_576,
  };
}

function usage(): unknown {
  return {
    session: {
      total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0,
      total_lines_added: 0, total_lines_removed: 0, model_usage: {},
    },
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 9, resets_at: "2026-07-17T18:00:00Z" },
      seven_day: { utilization: 12, resets_at: "2026-07-21T18:00:00Z" },
      model_scoped: [{ display_name: "Fable", utilization: 21, resets_at: "2026-07-21T18:00:00Z" }],
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for CCodex status turn.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function statusRenderer(service: ClaudeService, threadId: string): () => Promise<string> {
  return async () => formatCCodexStatus({
    claude: {
      availability: { state: "ready" },
      usage: await service.readRateLimitStatus(threadId),
    },
    codex: {
      availability: { state: "notAuthenticated", action: "ccodex auth codex" },
    },
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("persisted CCodex status turn", () => {
  it("persists /ccstate through the same zero-token lifecycle without counting itself", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-state-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:claude-sonnet-4-6", cwd: directory,
      approvalPolicy: "on-request", approvalsReviewer: "auto_review",
    });
    const prepared = await service.prepareStateTurn({
      threadId: started.thread.id,
      clientUserMessageId: "client-state",
      input: [{ type: "text", text: "/ccstate", text_elements: [] }],
    }, async () => formatCCodexState(service.stateSnapshot(started.thread.id), started.thread.createdAt * 1_000));
    await prepared.announce();
    prepared.start();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed");

    const turn = service.readThread(started.thread.id, true).thread.turns[0]!;
    expect(turn.items).toMatchObject([
      { type: "userMessage", clientId: "client-state" },
      {
        type: "agentMessage",
        phase: "final_answer",
        text: expect.stringContaining("❋ **Claude Sonnet 4.6**"),
      },
    ]);
    expect((turn.items[1] as { text: string }).text).toContain(
      "messages  ▸ 0 user / 0 assistant / 0 total",
    );
    expect(fake.prompts).toEqual([]);
    await service.close();
  });

  it("reads Claude limits without an existing Claude thread or model input", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-status-probe-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    fake.experimentalUsage = usage();
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    await expect(service.readRateLimitStatus()).resolves.toMatchObject({
      rateLimits: { rateLimits: { primary: { usedPercent: 9 } } },
      unavailableReason: null,
    });
    expect(fake.experimentalUsageCalls).toBe(1);
    expect(fake.prompts).toEqual([]);
    await service.close();
  });

  it("uses the account control call without a model turn and replays after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-status-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery();
    fake.experimentalUsage = usage();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(database), fake.factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    const live: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "desktop", (method, params) => live.push({ method, params }));
    const prepared = await service.prepareStatusTurn({
      threadId: started.thread.id,
      clientUserMessageId: "client-status",
      input: [{ type: "text", text: " CCodex status ", text_elements: [] }],
    }, statusRenderer(service, started.thread.id));
    expect(prepared.response.turn).toMatchObject({
      status: "inProgress",
      items: [{ type: "userMessage", clientId: "client-status" }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed");

    expect(fake.prompts).toHaveLength(0);
    expect(fake.experimentalUsageCalls).toBe(1);
    const turn = service.readThread(started.thread.id, true).thread.turns[0]!;
    expect(turn.items).toHaveLength(2);
    expect(turn.items[1]).toMatchObject({
      type: "agentMessage",
      phase: "final_answer",
      text: expect.stringContaining("◆ **CCodex** │ status"),
    });
    expect((turn.items[1] as { text: string }).text).toContain("Fable 7d ▸ 21% used");
    expect(live.map((event) => event.method)).toEqual([
      "thread/status/changed",
      "turn/started",
      "item/started",
      "item/completed",
      "item/started",
      "item/agentMessage/delta",
      "item/completed",
      "thread/status/changed",
      "turn/completed",
    ]);
    const allEvents = service.eventsAfter(started.thread.id, 0);
    const firstStatusSequence = allEvents.find((event) => event.turnId === turn.id)!.sequence;
    const statusHighWatermark = service.eventHighWatermark(started.thread.id);
    const originalReplay = allEvents.filter((event) =>
      event.sequence >= firstStatusSequence && event.sequence <= statusHighWatermark,
    );
    expect(originalReplay.map((event) => event.method)).toEqual(live.map((event) => event.method));
    await service.close();

    const resumedFake = new FakeClaudeQuery();
    const resumed = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(database), resumedFake.factory,
    );
    const snapshot = await resumed.resumeThread({ threadId: started.thread.id, excludeTurns: false });
    expect(snapshot.thread.turns).toEqual([turn]);
    expect(resumed.eventsAfter(started.thread.id, 0).filter((event) =>
      event.sequence >= firstStatusSequence && event.sequence <= statusHighWatermark,
    )).toEqual(originalReplay);
    expect(resumedFake.prompts).toHaveLength(0);
    await resumed.close();
  });

  it("persists a visible CCodex error when the control surface cannot initialize", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-status-error-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const initial = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    const started = await initial.startThread({ model: "claude:sonnet", cwd: directory });
    await initial.close();

    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(database),
      (() => { throw new Error("OAuth control surface unavailable"); }) as never,
    );
    const prepared = await service.prepareStatusTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "/ccodex-status", text_elements: [] }],
    }, statusRenderer(service, started.thread.id));
    prepared.announce();
    prepared.start();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.status === "failed");
    const turn = service.readThread(started.thread.id, true).thread.turns[0]!;
    expect(turn.items.at(-1)).toMatchObject({
      type: "agentMessage",
      text: "◆ **CCodex** │ ⚠️ Unable to read Claude usage: OAuth control surface unavailable",
    });
    expect(service.eventsAfter(started.thread.id, 0).some((event) => event.method === "error")).toBe(false);
    await service.close();
  });

  it("interrupts a slow status read without a late duplicate completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-status-stop-"));
    directories.push(directory);
    let release!: () => void;
    const fake = new FakeClaudeQuery();
    fake.experimentalUsage = usage();
    fake.experimentalUsageWait = new Promise<void>((resolve) => { release = resolve; });
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    const prepared = await service.prepareStatusTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "CCodex status", text_elements: [] }],
    }, statusRenderer(service, started.thread.id));
    prepared.announce();
    prepared.start();
    await waitFor(() => fake.experimentalUsageCalls === 1);
    await service.interruptTurn({ threadId: started.thread.id, turnId: prepared.response.turn.id });
    expect(service.readThread(started.thread.id, true).thread.turns[0]).toMatchObject({
      status: "interrupted", items: [{ type: "userMessage" }],
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.eventsAfter(started.thread.id, 0).filter((event) => event.method === "turn/completed")).toHaveLength(1);
    expect(fake.prompts).toHaveLength(0);
    await service.close();
  });

  it("settles a slow status turn before archive and ignores the late usage result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-status-archive-"));
    directories.push(directory);
    let release!: () => void;
    const fake = new FakeClaudeQuery();
    fake.experimentalUsage = usage();
    fake.experimentalUsageWait = new Promise<void>((resolve) => { release = resolve; });
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    const methods: string[] = [];
    hub.subscribe(started.thread.id, "desktop", (method) => methods.push(method));
    const prepared = await service.prepareStatusTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "CCodex status", text_elements: [] }],
    }, statusRenderer(service, started.thread.id));
    prepared.announce();
    prepared.start();
    await waitFor(() => fake.experimentalUsageCalls === 1);
    await service.archiveThread(started.thread.id);
    expect(service.readThread(started.thread.id, true).thread.turns[0]).toMatchObject({
      status: "failed",
      items: [
        { type: "userMessage" },
        { type: "agentMessage", text: "◆ **CCodex** │ ⚠️ Claude thread archived during an active turn." },
      ],
    });
    expect(methods.indexOf("turn/completed")).toBeLessThan(methods.indexOf("thread/archived"));
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(methods.filter((method) => method === "turn/completed")).toHaveLength(1);
    await service.close();
  });

  it("clears a slow status turn before delete so the late result cannot touch removed state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-status-delete-"));
    directories.push(directory);
    let release!: () => void;
    const fake = new FakeClaudeQuery();
    fake.experimentalUsage = usage();
    fake.experimentalUsageWait = new Promise<void>((resolve) => { release = resolve; });
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    const methods: string[] = [];
    hub.subscribe(started.thread.id, "desktop", (method) => methods.push(method));
    const prepared = await service.prepareStatusTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "/ccodex-status", text_elements: [] }],
    }, statusRenderer(service, started.thread.id));
    prepared.announce();
    prepared.start();
    await waitFor(() => fake.experimentalUsageCalls === 1);
    await service.deleteThread(started.thread.id);
    expect(service.ownsThread(started.thread.id)).toBe(false);
    expect(methods.filter((method) => method === "turn/completed")).toHaveLength(0);
    expect(methods.filter((method) => method === "thread/deleted")).toHaveLength(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(methods.filter((method) => method === "turn/completed")).toHaveLength(0);
    expect(methods.filter((method) => method === "thread/deleted")).toHaveLength(1);
    await service.close();
  });

  it("recovers a hard-crashed status turn through the session with a precise visible failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-status-crash-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const seed = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    const started = await seed.startThread({ model: "claude:sonnet", cwd: directory });
    await seed.close();

    const store = new SqliteHybridStore(database);
    const record = store.getThreadRecord(started.thread.id, false)!;
    store.createTurn(started.thread.id, {
      id: "crashed-status",
      items: [{
        type: "userMessage", id: "status-user", clientId: null,
        content: [{ type: "text", text: "CCodex status", text_elements: [] }],
      }],
      itemsView: "full", status: "inProgress", error: null,
      startedAt: 1, completedAt: null, durationMs: null,
    });
    store.updateThread({
      ...record,
      thread: { ...record.thread, status: { type: "active", activeFlags: [] } },
    });
    store.close();

    const recovered = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    await recovered.ready();
    const turn = recovered.readThread(started.thread.id, true).thread.turns[0]!;
    expect(turn).toMatchObject({
      status: "failed",
      items: [
        { type: "userMessage" },
        {
          type: "agentMessage",
          text: "◆ **CCodex** │ ⚠️ Gateway restarted while the CCodex status request was active.",
        },
      ],
    });
    const lifecycle = recovered.eventsAfter(started.thread.id, 0)
      .filter((event) => event.turnId === turn.id)
      .map((event) => event.method);
    expect(lifecycle).toEqual([
      "item/started", "item/agentMessage/delta", "item/completed", "turn/completed",
    ]);
    await recovered.close();
    const replayed = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    await replayed.ready();
    expect(replayed.eventsAfter(started.thread.id, 0)
      .filter((event) => event.turnId === turn.id)
      .map((event) => event.method)).toEqual(lifecycle);
    expect(replayed.readThread(started.thread.id, true).thread.turns[0]?.items).toEqual(turn.items);
    await replayed.close();
  });
});
