import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeService } from "../../src/claude/service.js";
import type { ClaudeQueryFactory } from "../../src/claude/queryFactory.js";
import type { ClaudeSession } from "../../src/claude/session/session.js";
import type { HybridConfig } from "../../src/config/config.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import { MetricsRegistry } from "../../src/observability/metrics.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";

const directories: string[] = [];
const originalCommandParser = process.env.CCODEX_COMMAND_PARSER;

function config(dataDir: string): HybridConfig {
  return {
    realCodex: "/bin/false",
    claudeBinary: "/bin/false",
    dataDir,
    publicSocket: join(dataDir, "gateway.sock"),
    modelPrefix: "claude:",
    idleTimeoutSeconds: 900,
    modelCacheSeconds: 300,
    logLevel: "error",
    logPrompts: false,
    debugCapture: false,
    debugLogMaxBytes: 1_048_576,
  };
}

function usage(utilization: number): unknown {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: {
        utilization,
        resets_at: "2026-07-18T01:00:00Z",
        limit_dollars: null,
        used_dollars: null,
        remaining_dollars: null,
      },
      seven_day: { utilization: 11, resets_at: "2026-07-20T01:00:00Z" },
    },
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function controlledFactory(
  fake: FakeClaudeQuery,
  initialization: Promise<void> = Promise.resolve(),
): { factory: ClaudeQueryFactory; providerExit: () => Promise<void> } {
  let query: Query | undefined;
  return {
    factory: (input) => {
      const target = fake.factory(input);
      query = target;
      return new Proxy(target, {
        get(value, property) {
          if (property === "initializationResult") {
            return async () => {
              await initialization;
              return value.initializationResult();
            };
          }
          const member = Reflect.get(value, property, value) as unknown;
          return typeof member === "function" ? member.bind(value) : member;
        },
      });
    },
    providerExit: async () => {
      if (!query) throw new Error("Provider Query has not been created.");
      await query.return(undefined);
    },
  };
}

function serviceWith(
  directory: string,
  factory: ClaudeQueryFactory,
  metrics = new MetricsRegistry(),
): { service: ClaudeService; metrics: MetricsRegistry } {
  return {
    service: new ClaudeService(
      config(directory),
      new SubscriptionHub(),
      new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      factory,
      undefined,
      metrics,
    ),
    metrics,
  };
}

function goalTool(
  fake: FakeClaudeQuery,
  name: "create_goal" | "get_goal" | "update_goal",
): (input: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown> {
  const server = fake.inputs[0]!.options.mcpServers!.ccodex_goal as unknown as {
    instance: {
      _registeredTools: Record<
        string,
        { handler: (input: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown> }
      >;
    };
  };
  return server.instance._registeredTools[name]!.handler;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (originalCommandParser === undefined) delete process.env.CCODEX_COMMAND_PARSER;
  else process.env.CCODEX_COMMAND_PARSER = originalCommandParser;
});

describe("Claude runtime lineage through public service and Query contracts", () => {
  it("keeps a staged public Session turn non-quiescent until it is discarded", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-staged-quiescence-"));
    directories.push(directory);
    const { service } = serviceWith(directory, new FakeClaudeQuery().factory);
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    await service.resumeThread(started.thread.id);
    const session = await (service as unknown as {
      sessions: { getOrCreate(threadId: string): Promise<ClaudeSession> };
    }).sessions.getOrCreate(started.thread.id);

    expect((await session.runtimeInspection())?.quiescent).toBe(true);
    const staged = await session.prepareRuntimeTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "reserved", text_elements: [] }],
    });
    expect((await session.runtimeInspection())?.quiescent).toBe(false);
    await staged.discard();
    expect((await session.runtimeInspection())?.quiescent).toBe(true);
    await service.close();
  });

  it("never publishes a Query that exits before readiness and rematerializes one live owner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-exit-before-ready-"));
    directories.push(directory);
    const initialization = new Promise<void>(() => undefined);
    const first = new FakeClaudeQuery();
    const second = new FakeClaudeQuery();
    const controlled = controlledFactory(first, initialization);
    let factoryCalls = 0;
    const { service, metrics } = serviceWith(directory, (input) =>
      factoryCalls++ === 0 ? controlled.factory(input) : second.factory(input));
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });

    await service.resumeThread(started.thread.id);
    await waitFor(() => first.inputs.length === 1, "first Query creation");
    await controlled.providerExit();
    await waitFor(
      () => service.readThread(started.thread.id, false).thread.status.type === "notLoaded",
      "dead pre-ready Query eviction",
    );
    expect(metrics.snapshot()).toMatchObject({
      gauges: { loadedClaudeRuntimes: 0 },
      counters: { claudeRuntimeStarts: 0 },
    });

    const turn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "replace the dead startup", text_elements: [] }],
    });
    await turn.announce();
    turn.start();
    await waitFor(
      () => (metrics.snapshot().gauges as { loadedClaudeRuntimes: number }).loadedClaudeRuntimes === 1,
      "replacement readiness",
    );
    expect(factoryCalls).toBe(2);
    expect(second.inputs).toHaveLength(1);
    expect(service.loadedThreadIds()).toEqual([started.thread.id]);
    await service.close();
  });

  it("rejects a held starting lease promptly when its Query exits before initialization", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-held-start-exit-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const controlled = controlledFactory(fake, new Promise<void>(() => undefined));
    let factoryCalls = 0;
    const { service } = serviceWith(directory, (input) => {
      factoryCalls += 1;
      return controlled.factory(input);
    });
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });

    const reading = service.readRateLimits(started.thread.id);
    await waitFor(() => fake.inputs.length === 1, "held starting lease");
    await controlled.providerExit();
    await expect(Promise.race([
      reading,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("starting lease waited for initialization timeout")), 500)),
    ])).rejects.toThrow("exited during initialization");
    expect(factoryCalls).toBe(1);
    await service.close();
  });

  it("reports one shared factory failure to two concurrent runtime resumptions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-shared-start-failure-"));
    directories.push(directory);
    let factoryCalls = 0;
    const { service } = serviceWith(directory, () => {
      factoryCalls += 1;
      throw new Error("shared factory failure");
    });
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });

    const results = await Promise.allSettled([
      service.resumeThread(started.thread.id),
      service.resumeThread(started.thread.id),
    ]);

    expect(results).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ message: "shared factory failure" }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ message: "shared factory failure" }),
      }),
    ]);
    expect(factoryCalls).toBe(1);
    await service.close();
  });

  it("fails one active turn on provider exit and sends the next turn only to a fresh Query", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-exit-active-"));
    directories.push(directory);
    const producerGate = new Promise<void>(() => undefined);
    const first = new FakeClaudeQuery(
      undefined,
      undefined,
      [],
      false,
      undefined,
      undefined,
      undefined,
      [{
        type: "system",
        subtype: "status",
        status: "working",
        permissionMode: "default",
        uuid: "lineage-active-status",
        session_id: "session",
      }] as never[],
      { afterIndex: 0, wait: producerGate },
    );
    const second = new FakeClaudeQuery();
    const controlled = controlledFactory(first);
    let factoryCalls = 0;
    const hub = new SubscriptionHub();
    const metrics = new MetricsRegistry();
    const service = new ClaudeService(
      config(directory),
      hub,
      new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      (input) => factoryCalls++ === 0 ? controlled.factory(input) : second.factory(input),
      undefined,
      metrics,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    const terminalEvents: unknown[] = [];
    hub.subscribe(started.thread.id, "lineage-active", (method, params) => {
      if (method === "turn/completed") terminalEvents.push(params);
    });
    const firstTurn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "hold the first Query", text_elements: [] }],
    });
    await firstTurn.announce();
    firstTurn.start();
    await waitFor(() => first.prompts.length === 1, "first provider prompt");

    await controlled.providerExit();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "failed",
      "active turn failure",
    );
    expect(terminalEvents).toHaveLength(1);

    const nextTurn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "use a fresh Query", text_elements: [] }],
    });
    await nextTurn.announce();
    nextTurn.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed",
      "replacement turn completion",
    );
    expect(first.prompts).toHaveLength(1);
    expect(second.prompts).toHaveLength(1);
    expect(factoryCalls).toBe(2);
    await service.close();
  });

  it("retires a settings-stale Query during startup without admitting its late readiness", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-retire-startup-"));
    directories.push(directory);
    let rejectInitialization!: (error: Error) => void;
    const initialization = new Promise<void>((_resolve, reject) => { rejectInitialization = reject; });
    let releaseReturn!: () => void;
    const returnGate = new Promise<void>((resolve) => { releaseReturn = resolve; });
    const first = new FakeClaudeQuery();
    first.returnWait = returnGate;
    const second = new FakeClaudeQuery();
    const controlled = controlledFactory(first, initialization);
    let factoryCalls = 0;
    const { service, metrics } = serviceWith(directory, (input) =>
      factoryCalls++ === 0 ? controlled.factory(input) : second.factory(input));
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    await service.resumeThread(started.thread.id);
    await waitFor(() => first.inputs.length === 1, "initializing Query");

    const updating = service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });
    await waitFor(() => first.returnCalls === 1, "startup retirement");
    rejectInitialization(new Error("delayed startup rejection"));
    const preparedPromise = service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "latest settings only", text_elements: [] }],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(factoryCalls).toBe(1);
    expect(second.inputs).toHaveLength(0);
    releaseReturn();
    await updating;
    expect(metrics.snapshot()).toMatchObject({
      gauges: { loadedClaudeRuntimes: 0 },
      counters: { claudeRuntimeStarts: 0 },
    });

    const prepared = await preparedPromise;
    expect(second.inputs[0]?.options.effort).toBe("high");
    await prepared.announce();
    prepared.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "post-retirement turn",
    );
    expect(factoryCalls).toBe(2);
    await service.close();
  });

  it("fences concurrent rename and injection behind retiring-startup physical close", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-retiring-startup-ops-"));
    directories.push(directory);
    let rejectInitialization!: (error: Error) => void;
    const initialization = new Promise<void>((_resolve, reject) => { rejectInitialization = reject; });
    let releaseReturn!: () => void;
    const returnGate = new Promise<void>((resolve) => { releaseReturn = resolve; });
    const first = new FakeClaudeQuery();
    first.returnWait = returnGate;
    const replacement = new FakeClaudeQuery();
    const controlled = controlledFactory(first, initialization);
    let factoryCalls = 0;
    const { service } = serviceWith(
      directory,
      (input) => factoryCalls++ === 0 ? controlled.factory(input) : replacement.factory(input),
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    await service.resumeThread(started.thread.id);
    await waitFor(() => first.inputs.length === 1, "initializing operation-fence Query");

    const updating = service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });
    await waitFor(() => first.returnCalls === 1, "retiring-startup close barrier");
    rejectInitialization(new Error("delayed operation-fence initialization rejection"));
    let renameSettled = false;
    const renaming = service.setThreadName({
      threadId: started.thread.id,
      name: "after-startup-close",
    }).then(() => { renameSettled = true; });
    let injectionSettled = false;
    const injecting = service.injectItems({
      threadId: started.thread.id,
      items: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "after startup close" }],
      }],
    }).then(() => { injectionSettled = true; });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(renameSettled).toBe(false);
    expect(injectionSettled).toBe(false);
    expect(service.readThread(started.thread.id, false).thread.name).not.toBe("after-startup-close");
    expect(factoryCalls).toBe(1);
    expect(replacement.inputs).toHaveLength(0);

    releaseReturn();
    await Promise.all([updating, renaming, injecting]);
    expect(service.readThread(started.thread.id, false).thread.name).toBe("after-startup-close");
    expect(factoryCalls).toBe(2);
    expect(replacement.prompts).toHaveLength(1);
    await service.close();
  });

  it("never widens or replays provider session permissions across Query replacement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-session-approval-"));
    directories.push(directory);
    process.env.CCODEX_COMMAND_PARSER = join(process.cwd(), "tests/fixtures/fakeCommandParser.sh");
    const tool = { name: "Bash", input: { command: "printf lineage-ok" } };
    const fake = new FakeClaudeQuery(tool);
    let factoryCalls = 0;
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory),
      hub,
      new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      (input) => {
        factoryCalls += 1;
        return fake.factory(input);
      },
    );
    const started = await service.startThread({
      model: "claude:sonnet",
      cwd: directory,
      approvalPolicy: "on-request",
    });
    const requests: string[] = [];
    hub.subscribe(started.thread.id, "lineage-approval", () => undefined, (id, method) => {
      requests.push(method);
      void service.resolveServerRequest(id, { decision: "acceptForSession" });
    });
    const runTurn = async (text: string) => {
      const prepared = await service.prepareTurn({
        threadId: started.thread.id,
        input: [{ type: "text", text, text_elements: [] }],
      });
      await prepared.announce();
      prepared.start();
      await waitFor(
        () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed",
        `${text} completion`,
      );
    };

    await runTurn("approve once");
    await service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });
    await waitFor(() => fake.returnCalls === 1, "approved Query retirement");
    await runTurn("reuse after replacement");

    expect(factoryCalls).toBe(2);
    expect(requests).toEqual([
      "item/commandExecution/requestApproval",
      "item/commandExecution/requestApproval",
    ]);
    expect(fake.permissionResults).toHaveLength(2);
    expect(fake.inputs[1]?.options.allowedTools).toBeUndefined();
    expect(fake.providerAllowedTools).toEqual([]);
    expect(fake.providerHookAllowedTools).toEqual([]);
    await service.close();
  });

  it("fails closed when an old Query invokes callbacks after replacement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-stale-callback-"));
    directories.push(directory);
    const first = new FakeClaudeQuery();
    const replacement = new FakeClaudeQuery();
    let factoryCalls = 0;
    const { service } = serviceWith(
      directory,
      (input) => factoryCalls++ === 0 ? first.factory(input) : replacement.factory(input),
    );
    const started = await service.startThread({
      model: "claude:sonnet",
      cwd: directory,
      ephemeral: true,
      threadSource: "user",
    });
    await service.injectItems({
      threadId: started.thread.id,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "prelude" }] }],
    });
    const oldOptions = first.inputs[0]!.options;
    const oldCreateGoal = goalTool(first, "create_goal");
    await service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });

    await expect(oldOptions.canUseTool!("Bash", { command: "pwd" }, {
      signal: new AbortController().signal,
      suggestions: [],
      toolUseID: "stale-tool",
      requestId: "stale-request",
    })).resolves.toMatchObject({ behavior: "deny" });
    await expect(oldOptions.onElicitation!(
      {
        mode: "form",
        serverName: "stale-server",
        message: "stale request",
        requestedSchema: {},
      } as never,
      { signal: new AbortController().signal },
    )).resolves.toEqual({ action: "cancel" });
    await expect(oldOptions.hooks!.PreToolUse![0]!.hooks[0]!(
      {
        hook_event_name: "PreToolUse",
        session_id: "stale",
        transcript_path: "/tmp/stale",
        cwd: directory,
        permission_mode: "default",
        tool_name: "Bash",
        tool_input: { command: "pwd" },
        tool_use_id: "stale-tool",
      } as never,
      "stale-tool",
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({ continue: false });
    await expect(oldCreateGoal({ objective: "stale goal mutation" }, {}))
      .rejects.toThrow("no longer accepting goal commands");
    await service.close();
  });

  it("rejects an old Goal MCP callback while a replacement generation owns an active durable turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-stale-goal-"));
    directories.push(directory);
    const first = new FakeClaudeQuery();
    const replacement = new FakeClaudeQuery(
      undefined,
      undefined,
      [],
      false,
      undefined,
      undefined,
      undefined,
      [{
        type: "system",
        subtype: "status",
        status: "working",
        permissionMode: "default",
        uuid: "replacement-goal-status",
        session_id: "session",
      }] as never[],
      { afterIndex: 0, wait: new Promise<void>(() => undefined) },
    );
    let factoryCalls = 0;
    const { service } = serviceWith(
      directory,
      (input) => factoryCalls++ === 0 ? first.factory(input) : replacement.factory(input),
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    await service.resumeThread(started.thread.id);
    const oldCreateGoal = goalTool(first, "create_goal");
    await service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });

    const turn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "replacement owns this turn", text_elements: [] }],
    });
    await turn.announce();
    turn.start();
    await waitFor(() => replacement.prompts.length === 1, "replacement active turn");
    await expect(oldCreateGoal({ objective: "stale durable mutation" }, {}))
      .rejects.toThrow("no longer accepting goal commands");
    expect(await service.getGoal(started.thread.id)).toEqual({ goal: null });
    await service.close();
  });

  it("rejects same-generation Goal MCP handlers before and after the root turn lifecycle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-goal-turn-fence-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const { service } = serviceWith(directory, fake.factory);
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    await service.resumeThread(started.thread.id);
    const createGoal = goalTool(fake, "create_goal");

    await expect(createGoal({ objective: "before root turn" }, {}))
      .rejects.toThrow("no longer accepting goal commands");
    expect(await service.getGoal(started.thread.id)).toEqual({ goal: null });

    const turn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "complete the root turn", text_elements: [] }],
    });
    await turn.announce();
    turn.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "completed root turn",
    );
    await expect(createGoal({ objective: "after root turn" }, {}))
      .rejects.toThrow("no longer accepting goal commands");
    expect(await service.getGoal(started.thread.id)).toEqual({ goal: null });
    await service.close();
  });

  it("fails closed for current Query callbacks after the Stop fence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-stop-callback-"));
    directories.push(directory);
    let releaseInterrupt!: () => void;
    const interruptGate = new Promise<void>((resolve) => { releaseInterrupt = resolve; });
    const providerGate = new Promise<void>(() => undefined);
    const fake = new FakeClaudeQuery(
      undefined,
      undefined,
      [],
      false,
      undefined,
      undefined,
      undefined,
      [{
        type: "system",
        subtype: "status",
        status: "working",
        permissionMode: "default",
        uuid: "stop-callback-status",
        session_id: "session",
      }] as never[],
      { afterIndex: 0, wait: providerGate },
    );
    fake.interruptWait = interruptGate;
    const hub = new SubscriptionHub();
    const requests: string[] = [];
    const service = new ClaudeService(
      config(directory),
      hub,
      new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      fake.factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    hub.subscribe(started.thread.id, "stop-callback", () => undefined, (_id, method) => {
      requests.push(method);
    });
    const turn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "hold for Stop", text_elements: [] }],
    });
    await turn.announce();
    turn.start();
    await waitFor(() => fake.prompts.length === 1, "current Query prompt");
    const options = fake.inputs[0]!.options;
    const createGoal = goalTool(fake, "create_goal");

    const stopping = service.interruptTurn({
      threadId: started.thread.id,
      turnId: turn.response.turn.id,
    });
    await waitFor(() => fake.interruptCalls === 1, "Stop transport fence");
    await expect(options.canUseTool!("Bash", { command: "pwd" }, {
      signal: new AbortController().signal,
      suggestions: [],
      toolUseID: "stopped-tool",
      requestId: "stopped-request",
    })).resolves.toMatchObject({ behavior: "deny" });
    await expect(options.onElicitation!(
      {
        mode: "form",
        serverName: "stopped-server",
        message: "stopped request",
        requestedSchema: {},
      } as never,
      { signal: new AbortController().signal },
    )).resolves.toEqual({ action: "cancel" });
    await expect(options.hooks!.PreToolUse![0]!.hooks[0]!(
      {
        hook_event_name: "PreToolUse",
        session_id: "stopped",
        transcript_path: "/tmp/stopped",
        cwd: directory,
        permission_mode: "default",
        tool_name: "Bash",
        tool_input: { command: "pwd" },
        tool_use_id: "stopped-tool",
      } as never,
      "stopped-tool",
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({ continue: false });
    await expect(createGoal({ objective: "stopped goal mutation" }, {}))
      .rejects.toThrow("no longer accepting goal commands");
    expect(requests).toEqual([]);
    expect(await service.getGoal(started.thread.id)).toEqual({ goal: null });

    releaseInterrupt();
    await stopping;
    await service.close();
  });

  it("does not idle-retire a runtime while an injection awaits acknowledgement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-idle-injection-"));
    directories.push(directory);
    let releaseInjection!: () => void;
    const injectionGate = new Promise<void>((resolve) => { releaseInjection = resolve; });
    const fake = new FakeClaudeQuery(
      undefined,
      undefined,
      [],
      false,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      injectionGate,
    );
    const service = new ClaudeService(
      { ...config(directory), idleTimeoutSeconds: -1 },
      new SubscriptionHub(),
      new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      fake.factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    const injecting = service.injectItems({
      threadId: started.thread.id,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "pending" }] }],
    });
    await waitFor(() => fake.prompts.length === 1, "pending injection send");

    await (service as unknown as { unloadIdleRuntimes(): Promise<void> }).unloadIdleRuntimes();
    expect(fake.returnCalls).toBe(0);
    expect(service.loadedThreadIds()).toContain(started.thread.id);

    releaseInjection();
    await injecting;
    await service.close();
  });

  it("retains an exited Session through a concurrent admin effect while an injection token is pending", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-release-injection-"));
    directories.push(directory);
    let releaseInjection!: () => void;
    const injectionGate = new Promise<void>((resolve) => { releaseInjection = resolve; });
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
    let renameStarted = false;
    const fake = new FakeClaudeQuery();
    const controlled = controlledFactory(fake);
    const service = new ClaudeService(
      config(directory),
      new SubscriptionHub(),
      new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      controlled.factory,
      undefined,
      new MetricsRegistry(),
      undefined,
      {
        rename: async () => {
          renameStarted = true;
          await renameGate;
        },
        delete: async () => undefined,
      },
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    await service.resumeThread(started.thread.id);
    const sessions = (service as unknown as {
      sessions: {
        getOrCreate(threadId: string): Promise<ClaudeSession>;
        resolvedSession(threadId: string): ClaudeSession | undefined;
      };
    }).sessions;
    const session = await sessions.getOrCreate(started.thread.id);
    await session.ensureRuntime();
    const setup = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "establish provider session", text_elements: [] }],
    });
    await setup.announce();
    setup.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "provider session setup",
    );
    const injecting = (session as unknown as {
      withRuntimeInjection<Result>(effect: () => Promise<Result>): Promise<Result>;
    }).withRuntimeInjection(() => injectionGate);
    await waitFor(async () => !await session.mayRelease(), "pending injection admission");

    const renaming = service.setThreadName({ threadId: started.thread.id, name: "release-fenced" });
    await waitFor(() => renameStarted, "concurrent rename effect");
    const exiting = controlled.providerExit();
    releaseRename();
    await Promise.all([renaming, exiting]);
    await waitFor(async () => await session.runtimeInspection() === undefined, "exited runtime retirement");
    expect(await session.mayRelease()).toBe(false);
    expect(sessions.resolvedSession(started.thread.id)).toBe(session);

    releaseInjection();
    await injecting;
    expect(await session.mayRelease()).toBe(true);
    await service.close();
  });

  it("replays an acknowledged ephemeral prelude recorded before startup readiness", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-pre-ready-prelude-"));
    directories.push(directory);
    const first = new FakeClaudeQuery();
    const controlled = controlledFactory(first, new Promise<void>(() => undefined));
    const replacement = new FakeClaudeQuery();
    let factoryCalls = 0;
    const { service } = serviceWith(directory, (input) =>
      factoryCalls++ === 0 ? controlled.factory(input) : replacement.factory(input));
    const started = await service.startThread({
      model: "claude:sonnet",
      cwd: directory,
      ephemeral: true,
      threadSource: "user",
    });

    await service.injectItems({
      threadId: started.thread.id,
      items: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "pre-ready ephemeral prelude" }],
      }],
    });
    expect(first.prompts).toHaveLength(1);

    await service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });
    await waitFor(() => replacement.prompts.length === 1, "pre-ready prelude replay");
    expect(JSON.stringify(replacement.prompts[0])).toContain("pre-ready ephemeral prelude");
    expect(factoryCalls).toBe(2);
    await service.close();
  });

  it("fences an old usage refresh after replacement and keeps runtime metrics exactly balanced", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-rate-metrics-"));
    directories.push(directory);
    let releaseOldUsage!: () => void;
    const oldUsageGate = new Promise<void>((resolve) => { releaseOldUsage = resolve; });
    const first = new FakeClaudeQuery();
    first.experimentalUsage = usage(91);
    first.experimentalUsageWait = oldUsageGate;
    const second = new FakeClaudeQuery();
    second.experimentalUsage = usage(22);
    let factoryCalls = 0;
    const metrics = new MetricsRegistry();
    const { service } = serviceWith(
      directory,
      (input) => factoryCalls++ === 0 ? first.factory(input) : second.factory(input),
      metrics,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    await service.resumeThread(started.thread.id);
    await waitFor(
      () => (metrics.snapshot().gauges as { loadedClaudeRuntimes: number }).loadedClaudeRuntimes === 1,
      "first runtime load",
    );
    const staleRead = service.readRateLimits(started.thread.id);
    await waitFor(() => first.experimentalUsageCalls === 1, "old usage probe");

    await service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });
    await waitFor(() => first.returnCalls === 1, "old runtime retirement");
    const turn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "materialize replacement", text_elements: [] }],
    });
    const freshRead = service.readRateLimits(started.thread.id);
    await waitFor(() => second.experimentalUsageCalls === 1, "replacement usage probe");
    releaseOldUsage();
    expect((await staleRead).rateLimits.primary?.usedPercent).not.toBe(91);
    expect((await freshRead).rateLimits.primary?.usedPercent).toBe(22);
    expect(service.cachedRateLimits().rateLimits.primary?.usedPercent).toBe(22);

    await turn.announce();
    turn.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "replacement turn completion",
    );
    expect(metrics.snapshot()).toMatchObject({
      gauges: { loadedClaudeRuntimes: 1 },
      counters: { claudeRuntimeStarts: 2 },
    });
    await service.close();
    expect(metrics.snapshot()).toMatchObject({
      gauges: { loadedClaudeRuntimes: 0 },
      counters: { claudeRuntimeStarts: 2 },
    });
  });

  it("serializes ephemeral prelude replay before a concurrent turn and creates no third Query", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-ephemeral-order-"));
    directories.push(directory);
    const first = new FakeClaudeQuery();
    let releaseReplay!: () => void;
    const replayGate = new Promise<void>((resolve) => { releaseReplay = resolve; });
    const replacement = new FakeClaudeQuery(
      undefined,
      undefined,
      [],
      false,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      replayGate,
    );
    const unexpected = new FakeClaudeQuery();
    const queries = [first, replacement, unexpected];
    let factoryCalls = 0;
    const { service } = serviceWith(directory, (input) => queries[factoryCalls++]!.factory(input));
    const started = await service.startThread({
      model: "claude:sonnet",
      cwd: directory,
      ephemeral: true,
      threadSource: "user",
    });
    await service.injectItems({
      threadId: started.thread.id,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "prelude" }] }],
    });

    const updating = service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });
    await waitFor(() => replacement.prompts.length === 1, "replacement prelude replay");
    let prepared = false;
    const preparing = service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "after prelude", text_elements: [] }],
    }).then((value) => {
      prepared = true;
      return value;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(prepared).toBe(false);
    expect(factoryCalls).toBe(2);

    releaseReplay();
    await updating;
    const turn = await preparing;
    expect(factoryCalls).toBe(2);
    expect(replacement.prompts.map((message) => message.shouldQuery)).toEqual([false]);
    expect(unexpected.inputs).toHaveLength(0);
    await turn.announce();
    turn.start();
    await waitFor(() => replacement.prompts.length === 2, "post-prelude turn send");
    expect(replacement.prompts.map((message) => message.shouldQuery)).toEqual([false, undefined]);
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "ordered ephemeral turn",
    );
    await service.close();
  });

  it("allows durable settings persistence while a no-query injection awaits acknowledgement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-durable-injection-settings-"));
    directories.push(directory);
    let releaseInjection!: () => void;
    const injectionGate = new Promise<void>((resolve) => { releaseInjection = resolve; });
    const fake = new FakeClaudeQuery(
      undefined,
      undefined,
      [],
      false,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      injectionGate,
    );
    const { service } = serviceWith(directory, fake.factory);
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    let injectionSettled = false;
    const session = await (service as unknown as {
      sessions: { getOrCreate(threadId: string): Promise<ClaudeSession> };
    }).sessions.getOrCreate(started.thread.id);
    const injecting = session.injectRuntimeItems(
      [{ type: "message", role: "user", content: [{ type: "input_text", text: "durable" }] }],
      true,
    ).then(() => { injectionSettled = true; });
    await waitFor(() => fake.prompts.length === 1, "durable injection send");

    await service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });
    expect(injectionSettled).toBe(false);
    expect(service.currentThreadSettings(started.thread.id).effort).toBe("high");

    releaseInjection();
    await injecting;
    await service.close();
  });

  it("keeps durable settings fenced behind an in-flight thread admin effect", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-durable-admin-settings-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
    let renameStarted = false;
    const service = new ClaudeService(
      config(directory),
      new SubscriptionHub(),
      new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      fake.factory,
      undefined,
      new MetricsRegistry(),
      undefined,
      {
        rename: async () => {
          renameStarted = true;
          await renameGate;
        },
        delete: async () => undefined,
      },
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    const turn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "persist provider session", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "durable setup turn",
    );

    const renaming = service.setThreadName({ threadId: started.thread.id, name: "admin-fenced" });
    await waitFor(() => renameStarted, "provider rename effect");
    let settingsSettled = false;
    const updating = service.updateThreadSettings({
      threadId: started.thread.id,
      effort: "high",
    }).then(() => { settingsSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settingsSettled).toBe(false);

    releaseRename();
    await Promise.all([renaming, updating]);
    expect(service.readThread(started.thread.id, false).thread.name).toBe("admin-fenced");
    expect(service.currentThreadSettings(started.thread.id).effort).toBe("high");
    await service.close();
  });

  it("closes through a replacement whose replay acknowledgement never arrives", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-close-replay-"));
    directories.push(directory);
    const first = new FakeClaudeQuery();
    const replacement = new FakeClaudeQuery(
      undefined,
      undefined,
      [],
      false,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      new Promise<void>(() => undefined),
    );
    let factoryCalls = 0;
    const queries = [first, replacement];
    const { service } = serviceWith(directory, (input) => queries[factoryCalls++]!.factory(input));
    const started = await service.startThread({
      model: "claude:sonnet",
      cwd: directory,
      ephemeral: true,
      threadSource: "user",
    });
    await service.injectItems({
      threadId: started.thread.id,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "prelude" }] }],
    });
    const updating = service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });
    await waitFor(() => replacement.prompts.length === 1, "hung replacement replay");
    const session = await (service as unknown as {
      sessions: { getOrCreate(threadId: string): Promise<ClaudeSession> };
    }).sessions.getOrCreate(started.thread.id);
    expect(await session.mayRelease()).toBe(false);
    await Promise.race([
      service.close(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("close waited for replay acknowledgement")), 1_000)),
    ]);
    await expect(updating).rejects.toThrow();
  });

  it("atomically reserves an exact ephemeral replay snapshot before a concurrent injection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-atomic-replay-"));
    directories.push(directory);
    const first = new FakeClaudeQuery();
    let releaseReplay!: () => void;
    const replayGate = new Promise<void>((resolve) => { releaseReplay = resolve; });
    const replacement = new FakeClaudeQuery(
      undefined,
      undefined,
      [],
      false,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      replayGate,
    );
    const unexpected = new FakeClaudeQuery();
    const queries = [first, replacement, unexpected];
    let factoryCalls = 0;
    const { service } = serviceWith(directory, (input) => queries[factoryCalls++]!.factory(input));
    const started = await service.startThread({
      model: "claude:sonnet",
      cwd: directory,
      ephemeral: true,
      threadSource: "user",
    });
    const initial = [{ type: "message", role: "user", content: [{ type: "input_text", text: "initial" }] }];
    const concurrent = [{ type: "message", role: "user", content: [{ type: "input_text", text: "concurrent" }] }];
    await service.injectItems({ threadId: started.thread.id, items: initial });

    const updating = service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });
    await waitFor(() => replacement.prompts.length === 1, "reserved replay snapshot");
    let injected = false;
    const injecting = service.injectItems({
      threadId: started.thread.id,
      items: concurrent,
    }).then(() => { injected = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(first.prompts).toHaveLength(1);
    expect(injected).toBe(false);
    releaseReplay();
    await Promise.all([updating, injecting]);
    await waitFor(() => replacement.prompts.length === 2, "post-replay concurrent injection");
    expect(replacement.prompts.every((message) => message.shouldQuery === false)).toBe(true);
    expect(factoryCalls).toBe(2);
    expect(unexpected.inputs).toHaveLength(0);
    await service.close();
  });

  it("fences a late provider frame while its Query is retiring for replacement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-late-frame-"));
    directories.push(directory);
    let releaseReturn!: () => void;
    const returnGate = new Promise<void>((resolve) => { releaseReturn = resolve; });
    const first = new FakeClaudeQuery();
    first.returnWait = returnGate;
    const replacement = new FakeClaudeQuery();
    const unexpected = new FakeClaudeQuery();
    const queries = [first, replacement, unexpected];
    let factoryCalls = 0;
    const { service, metrics } = serviceWith(
      directory,
      (input) => queries[factoryCalls++]!.factory(input),
    );
    const started = await service.startThread({
      model: "claude:sonnet",
      cwd: directory,
      ephemeral: true,
      threadSource: "user",
    });
    await service.injectItems({
      threadId: started.thread.id,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "prelude" }] }],
    });
    const updating = service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });
    await waitFor(() => first.returnCalls === 1, "retirement return barrier");
    first.emit({
      type: "assistant",
      error: "authentication_failed",
      message: { role: "assistant", content: [] },
      parent_tool_use_id: null,
      uuid: "late-auth-frame",
      session_id: "session",
    } as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(factoryCalls).toBe(1);
    releaseReturn();
    await updating;
    await waitFor(() => replacement.inputs.length === 1, "replacement after late frame");
    expect(factoryCalls).toBe(2);
    expect(unexpected.inputs).toHaveLength(0);
    expect(metrics.snapshot()).toMatchObject({ gauges: { loadedClaudeRuntimes: 1 } });
    await service.close();
  });

  it("physically closes and rematerializes after runtime detach projection fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-detach-failure-"));
    directories.push(directory);
    const first = new FakeClaudeQuery();
    const replacement = new FakeClaudeQuery();
    let factoryCalls = 0;
    const { service } = serviceWith(
      directory,
      (input) => factoryCalls++ === 0 ? first.factory(input) : replacement.factory(input),
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    await service.resumeThread(started.thread.id);
    const session = await (service as unknown as {
      sessions: { getOrCreate(threadId: string): Promise<ClaudeSession> };
    }).sessions.getOrCreate(started.thread.id);
    await session.ensureRuntime();
    const target = session as unknown as {
      submitProviderProjection<Result>(generation: number, command: { type: string }): Promise<Result>;
    };
    const submitProviderProjection = target.submitProviderProjection.bind(session);
    let failDetach = true;
    target.submitProviderProjection = <Result>(generation: number, command: { type: string }) => {
      if (failDetach && command.type === "runtimeDetached") {
        failDetach = false;
        return Promise.reject(new Error("injected detach projection failure"));
      }
      return submitProviderProjection<Result>(generation, command);
    };

    await expect(session.retireRuntimeSilently()).rejects.toThrow("injected detach projection failure");
    expect(first.returnCalls).toBe(1);
    expect(await session.runtimeInspection()).toBeUndefined();
    await service.resumeThread(started.thread.id);
    await waitFor(() => replacement.inputs.length === 1, "runtime after detach projection failure");
    expect(factoryCalls).toBe(2);
    await service.close();
  });

  it("physically closes and rematerializes when cleanup fails after runtime detach", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-lineage-post-detach-failure-"));
    directories.push(directory);
    const first = new FakeClaudeQuery();
    const replacement = new FakeClaudeQuery();
    let factoryCalls = 0;
    const { service } = serviceWith(
      directory,
      (input) => factoryCalls++ === 0 ? first.factory(input) : replacement.factory(input),
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    await service.resumeThread(started.thread.id);
    const session = await (service as unknown as {
      sessions: { getOrCreate(threadId: string): Promise<ClaudeSession> };
    }).sessions.getOrCreate(started.thread.id);
    await session.ensureRuntime();
    const target = session as unknown as {
      submitRuntimeEffect<Result>(command: { type: string; action?: string }): Promise<Result>;
    };
    const submitRuntimeEffect = target.submitRuntimeEffect.bind(session);
    let failCleanup = true;
    target.submitRuntimeEffect = <Result>(command: { type: string; action?: string }) => {
      if (failCleanup && command.type === "runtimeUsageSnapshot" && command.action === "invalidate") {
        failCleanup = false;
        return Promise.reject(new Error("injected post-detach cleanup failure"));
      }
      return submitRuntimeEffect<Result>(command);
    };

    await expect(session.retireRuntimeSilently()).rejects.toThrow("injected post-detach cleanup failure");
    expect(first.returnCalls).toBe(1);
    expect(await session.runtimeInspection()).toBeUndefined();
    await service.resumeThread(started.thread.id);
    await waitFor(() => replacement.inputs.length === 1, "runtime after post-detach cleanup failure");
    expect(factoryCalls).toBe(2);
    await service.close();
  });
});
