import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HybridConfig } from "../../src/config/config.js";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import type { ThreadStartParams } from "../../src/codex/generated/v2/ThreadStartParams.js";
import type { ThreadSettingsUpdateParams } from "../../src/codex/generated/v2/ThreadSettingsUpdateParams.js";
import { ClaudeService } from "../../src/claude/service.js";
import type { ClaudeSession } from "../../src/claude/session/session.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import { MetricsRegistry } from "../../src/observability/metrics.js";
import type {
  AppendProviderEvent,
  EventPersistence,
  HybridStore,
  ProviderEventDisposition,
} from "../../src/store/HybridStore.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";
import type { TranscriptBrancher } from "../../src/claude/transcriptBrancher.js";
import {
  deferredSettingsUpdate,
  fullAccessProjection,
  stopLifecycleSample,
} from "../fixtures/protocolSamples.js";

const directories: string[] = [];
const originalCommandParser = process.env.CCODEX_COMMAND_PARSER;
const immediateCompactionBoundary: TranscriptBrancher = {
  forkWithProvenance: async () => { throw new Error("unused transcript fork"); },
  resolveCompactionBoundary: async (_sessionId, _cwd, boundary) => boundary.uuid,
  delete: async () => undefined,
};

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

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

class ProviderOrderStore extends SqliteHybridStore {
  public readonly order: string[] = [];
  private watchedSequence: number | undefined;

  public override appendProviderEvent(event: AppendProviderEvent) {
    const appended = super.appendProviderEvent(event);
    if (event.providerEventId === "ordered-provider-event") {
      this.watchedSequence = appended.record.sequence;
      this.order.push("journal:pending");
    }
    return appended;
  }

  public override appendEvent(
    threadId: string,
    turnId: string | null,
    method: string,
    params: unknown,
    persistence?: EventPersistence,
  ): number {
    if (persistence?.providerEventId === "ordered-provider-event" && !method.startsWith("hybrid/")) {
      this.order.push(`projection:${method}`);
    }
    return super.appendEvent(threadId, turnId, method, params, persistence);
  }

  public override completeProviderEvent(
    threadId: string,
    sequence: number,
    disposition: Exclude<ProviderEventDisposition, "pending">,
    error?: string | null,
  ): void {
    if (sequence === this.watchedSequence) this.order.push(`journal:${disposition}`);
    super.completeProviderEvent(threadId, sequence, disposition, error);
  }
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (originalCommandParser === undefined) delete process.env.CCODEX_COMMAND_PARSER;
  else process.env.CCODEX_COMMAND_PARSER = originalCommandParser;
});

describe("ClaudeService", () => {
  it("projects streamed image Reads atomically and durably without duplicate lifecycle items", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-image-view-"));
    directories.push(directory);
    const base = { parent_tool_use_id: null, session_id: "image-session" };
    const imageId = "streamed-image";
    const readId = "streamed-json";
    const failedId = "failed-image";
    const imageInput = JSON.stringify({ file_path: "plots/chart.png" });
    const imageFragments = [imageInput.slice(0, 8), imageInput.slice(8, 19), imageInput.slice(19)];
    const messages = [
      { type: "stream_event", event: { type: "message_start", message: {} }, uuid: randomUUID(), ...base },
      {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: imageId, name: "Read", input: {} } },
      },
      ...imageFragments.map((partial_json) => ({
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } },
      })),
      { type: "stream_event", event: { type: "content_block_stop", index: 0 }, uuid: randomUUID(), ...base },
      {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: readId, name: "Read", input: {} } },
      },
      {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: "package.json" }) } },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 1 }, uuid: randomUUID(), ...base },
      {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: failedId, name: "Read", input: {} } },
      },
      {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: "plots/missing.jpg" }) } },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 2 }, uuid: randomUUID(), ...base },
      {
        type: "assistant", uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [
          { type: "tool_use", id: imageId, name: "Read", input: { file_path: "plots/chart.png" } },
          { type: "tool_use", id: readId, name: "Read", input: { file_path: "package.json" } },
          { type: "tool_use", id: failedId, name: "Read", input: { file_path: "plots/missing.jpg" } },
        ] },
      },
      {
        type: "user", uuid: randomUUID(), ...base,
        message: { role: "user", content: [
          { type: "tool_result", tool_use_id: imageId, content: "image bytes" },
          { type: "tool_result", tool_use_id: readId, content: "package" },
          { type: "tool_result", tool_use_id: failedId, content: "not found", is_error: true },
        ] },
      },
      { type: "stream_event", event: { type: "message_start", message: {} }, uuid: randomUUID(), ...base },
    ] as unknown as SDKMessage[];
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")),
      new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, messages).factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "image-view", (method, params) => events.push({ method, params }));
    const prepared = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "inspect images", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "streamed image turn completion",
    );

    const turn = service.readThread(started.thread.id, true).thread.turns[0]!;
    expect(turn.items.filter((item) => item.id === imageId)).toEqual([{
      type: "imageView", id: imageId, path: join(directory, "plots/chart.png"),
    }]);
    expect(turn.items).toContainEqual(expect.objectContaining({
      type: "commandExecution", id: readId, command: "Read package.json", status: "completed",
      commandActions: [expect.objectContaining({ type: "read", path: join(directory, "package.json") })],
    }));
    expect(turn.items.filter((item) => item.id === failedId)).toEqual([{
      type: "commandExecution", id: failedId, command: "Read plots/missing.jpg", cwd: directory,
      processId: null, source: "agent", status: "failed",
      commandActions: [{
        type: "read", command: "Read plots/missing.jpg", name: "missing.jpg",
        path: join(directory, "plots/missing.jpg"),
      }],
      aggregatedOutput: "not found", exitCode: 1, durationMs: expect.any(Number),
    }]);

    const successfulLifecycle = events.filter((event) =>
      ["item/started", "item/completed"].includes(event.method)
      && (event.params as { item?: { id?: string } }).item?.id === imageId,
    );
    expect(successfulLifecycle.map((event) => event.method)).toEqual(["item/started", "item/completed"]);
    expect(successfulLifecycle.map((event) => (event.params as { item: { type: string } }).item.type))
      .toEqual(["imageView", "imageView"]);
    const failedLifecycle = events.filter((event) =>
      ["item/started", "item/commandExecution/outputDelta", "item/completed"].includes(event.method)
      && ((event.params as { item?: { id?: string } }).item?.id === failedId
        || (event.params as { itemId?: string }).itemId === failedId),
    );
    expect(failedLifecycle.map((event) => event.method)).toEqual([
      "item/started", "item/commandExecution/outputDelta", "item/completed",
    ]);
    expect((failedLifecycle[0]?.params as { item: { type: string } }).item.type).toBe("commandExecution");
    expect((failedLifecycle[1]?.params as { delta: string }).delta).toBe("not found");
    expect((failedLifecycle[2]?.params as { item: { type: string; status: string } }).item)
      .toMatchObject({ type: "commandExecution", status: "failed" });
    expect(events.some((event) => ["item/started", "item/completed"].includes(event.method)
      && (event.params as { item?: { id?: string; type?: string } }).item?.id === failedId
      && (event.params as { item: { type?: string } }).item.type === "imageView")).toBe(false);
    expect(JSON.stringify(turn.items.filter((item) => item.id === imageId))).not.toContain("commandExecution");

    const replay = service.eventsAfter(started.thread.id, 0).filter((event) =>
      ["item/started", "item/completed"].includes(event.method)
      && (event.params as { item?: { id?: string } }).item?.id === imageId,
    );
    expect(replay.map((event) => (event.params as { item: { type: string } }).item.type)).toEqual(["imageView", "imageView"]);
    const failedReplay = service.eventsAfter(started.thread.id, 0).filter((event) =>
      ["item/started", "item/commandExecution/outputDelta", "item/completed"].includes(event.method)
      && ((event.params as { item?: { id?: string } }).item?.id === failedId
        || (event.params as { itemId?: string }).itemId === failedId),
    );
    expect(failedReplay.map((event) => event.method)).toEqual([
      "item/started", "item/commandExecution/outputDelta", "item/completed",
    ]);
    await service.close();

    const reconnected = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), new FakeClaudeQuery().factory,
    );
    const resumed = await reconnected.resumeThread({
      threadId: started.thread.id,
      initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "full" },
    });
    expect(resumed.initialTurnsPage?.data[0]?.items).toContainEqual({
      type: "imageView", id: imageId, path: join(directory, "plots/chart.png"),
    });
    expect(resumed.initialTurnsPage?.data[0]?.items).toContainEqual(expect.objectContaining({
      type: "commandExecution", id: failedId, status: "failed", aggregatedOutput: "not found",
    }));
    expect(reconnected.eventsAfter(started.thread.id, 0).filter((event) =>
      ["item/started", "item/completed"].includes(event.method)
      && (event.params as { item?: { id?: string } }).item?.id === imageId,
    )).toHaveLength(2);
    const reconnectedFailure = reconnected.eventsAfter(started.thread.id, 0).filter((event) =>
      ["item/started", "item/commandExecution/outputDelta", "item/completed"].includes(event.method)
      && ((event.params as { item?: { id?: string } }).item?.id === failedId
        || (event.params as { itemId?: string }).itemId === failedId),
    );
    expect(reconnectedFailure).toHaveLength(3);
    expect(reconnectedFailure.some((event) =>
      (event.params as { item?: { type?: string } }).item?.type === "imageView")).toBe(false);
    await reconnected.close();
  });

  it("persists and streams a basic Claude turn through the Codex lifecycle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-service-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(config(directory), hub, new Logger("error"), store, fake.factory);
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: string[] = [];
    hub.subscribe(started.thread.id, "test", (method) => events.push(method));

    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "test", text_elements: [] }],
    });
    expect(events).toEqual(["thread/status/changed"]);
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => events.includes("turn/completed") ? resolve() : setTimeout(poll, 5);
      poll();
    });

    expect(service.readThread(started.thread.id, true).thread.turns[0]).toMatchObject({
      status: "completed",
      items: [{ type: "userMessage" }, { type: "agentMessage", text: "OK" }],
    });
    const userStarted = events.indexOf("item/started");
    expect(userStarted).toBeGreaterThan(events.indexOf("turn/started"));
    expect(events[userStarted + 1]).toBe("item/completed");
    expect(events).toContain("thread/tokenUsage/updated");
    await service.shellCommand({ threadId: started.thread.id, command: "printf shell-ok" });
    expect(service.readThread(started.thread.id, true).thread.turns.at(-1)).toMatchObject({
      status: "completed",
      items: [{ type: "commandExecution", source: "userShell", aggregatedOutput: "shell-ok", exitCode: 0 }],
    });
    expect(fake.inputs).toHaveLength(1);
    expect(fake.prompts[0]?.origin).toEqual({ kind: "human" });
    await service.close();
  });

  it("returns an interruptible turn while Claude initialization is still pending", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-runtime-init-interrupt-"));
    directories.push(directory);
    let releaseInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => { releaseInitialization = resolve; });
    const fake = new FakeClaudeQuery();
    const delayedFactory: typeof fake.factory = (input) => {
      const query = fake.factory(input);
      return new Proxy(query, {
        get(target, property) {
          if (property === "initializationResult") {
            return async () => {
              await initialization;
              return target.initializationResult();
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), delayedFactory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: string[] = [];
    hub.subscribe(started.thread.id, "test", (method) => events.push(method));

    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "wait for init", text_elements: [] }],
    });
    expect(fake.inputs).toHaveLength(1);
    await prepared.announce();
    await service.interruptTurn({ threadId: started.thread.id, turnId: prepared.response.turn.id });
    expect(service.readThread(started.thread.id, true).thread.turns[0]).toMatchObject({
      id: prepared.response.turn.id,
      status: "interrupted",
    });
    expect(events.filter((method) => method === "turn/completed")).toHaveLength(1);

    releaseInitialization();
    await service.close();
  });

  it("projects a delayed initialization failure into the already-created turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-runtime-init-failure-"));
    directories.push(directory);
    let rejectInitialization!: (error: Error) => void;
    const initialization = new Promise<never>((_resolve, reject) => { rejectInitialization = reject; });
    const fake = new FakeClaudeQuery();
    const delayedFactory: typeof fake.factory = (input) => {
      const query = fake.factory(input);
      return new Proxy(query, {
        get(target, property) {
          if (property === "initializationResult") return () => initialization;
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), delayedFactory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: string[] = [];
    hub.subscribe(started.thread.id, "test", (method) => events.push(method));
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "fail during init", text_elements: [] }],
    });
    await prepared.announce();

    rejectInitialization(new Error("Claude login expired during initialization."));
    await vi.waitFor(() => expect(service.readThread(started.thread.id, true).thread.turns[0]).toMatchObject({
      status: "failed",
      error: { message: "Claude login expired during initialization." },
    }));
    expect(events.filter((method) => method === "error")).toHaveLength(1);
    expect(events.filter((method) => method === "turn/completed")).toHaveLength(1);
    await service.close();
  });

  it("projects summarized Claude thinking through the native Codex reasoning-summary contract", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-reasoning-summary-"));
    directories.push(directory);
    const base = { parent_tool_use_id: null, session_id: "session" };
    const messages = [
      { type: "stream_event", event: { type: "message_start", message: {} }, uuid: randomUUID(), ...base },
      {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "test" } },
      },
      {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Planning first-principles architecture synthesizer" } },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 }, uuid: randomUUID(), ...base },
      {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "test-2" } },
      },
      {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Drafting standalone architecture synthesis script" } },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 1 }, uuid: randomUUID(), ...base },
      {
        type: "assistant", message: { role: "assistant", content: [
          { type: "thinking", thinking: "Planning first-principles architecture synthesizer", signature: "test" },
          { type: "thinking", thinking: "Drafting standalone architecture synthesis script", signature: "test-2" },
        ] }, uuid: randomUUID(), ...base,
      },
    ] as unknown as SDKMessage[];
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, messages);
    const hub = new SubscriptionHub();
    const database = join(directory, "state.sqlite");
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(database), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      summary: "detailed",
      input: [{ type: "text", text: "think", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => events.some((event) => event.method === "turn/completed") ? resolve() : setTimeout(poll, 5);
      poll();
    });

    expect(fake.inputs.at(-1)?.options.thinking).toEqual({ type: "adaptive", display: "summarized" });
    const reasoning = service.readThread(started.thread.id, true).thread.turns[0]?.items
      .find((item) => item.type === "reasoning");
    expect(reasoning).toEqual(expect.objectContaining({
      type: "reasoning",
      summary: ["Planning first-principles architecture synthesizer", "Drafting standalone architecture synthesis script"],
      content: [],
    }));
    expect(events.filter((event) => event.method === "item/reasoning/summaryTextDelta")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ delta: "Planning first-principles architecture synthesizer", summaryIndex: 0 }) }),
      expect.objectContaining({ params: expect.objectContaining({ delta: "Drafting standalone architecture synthesis script", summaryIndex: 1 }) }),
    ]);
    expect(events.filter((event) => event.method === "item/reasoning/summaryPartAdded")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ summaryIndex: 1 }) }),
    ]);
    expect(events.some((event) => event.method === "item/reasoning/textDelta")).toBe(false);
    await service.close();
  });

  it("renames a fresh thread locally before Claude has persisted its session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-fresh-name-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), new FakeClaudeQuery().factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));

    await service.setThreadName({ threadId: started.thread.id, name: "Fresh name" });

    expect(service.readThread(started.thread.id, false).thread.name).toBe("Fresh name");
    expect(events).toContainEqual({
      method: "thread/name/updated",
      params: { threadId: started.thread.id, threadName: "Fresh name" },
    });
    await service.close();
  });

  it("keeps idle durable history unloaded until resume materializes its runtime", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-lazy-session-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const firstFake = new FakeClaudeQuery();
    const first = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), firstFake.factory,
    );
    const started = await first.startThread({ model: "claude:haiku", cwd: directory });
    const firstRegistry = (first as unknown as {
      sessions: { activeOwnerIds(): string[] };
    }).sessions;
    expect(started.thread.status).toEqual({ type: "idle" });
    expect(firstRegistry.activeOwnerIds()).toEqual([started.thread.id]);
    expect(first.loadedThreadIds()).toEqual([]);
    expect(firstFake.inputs).toHaveLength(0);
    await first.close();

    const resumedFake = new FakeClaudeQuery();
    const resumed = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), resumedFake.factory,
    );
    await resumed.ready();
    const registry = (resumed as unknown as {
      sessions: { activeOwnerIds(): string[] };
    }).sessions;
    expect(registry.activeOwnerIds()).toEqual([]);
    expect(resumed.loadedThreadIds()).toEqual([]);
    expect(resumed.readThread(started.thread.id, false).thread.id).toBe(started.thread.id);
    expect(registry.activeOwnerIds()).toEqual([]);
    const response = await resumed.resumeThread(started.thread.id);
    expect(response.thread.id).toBe(started.thread.id);
    expect(resumed.loadedThreadIds()).toEqual([started.thread.id]);
    expect(resumedFake.inputs).toHaveLength(1);
    await resumed.close();
  });

  it("reconciles idle pending residue without retaining a startup session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-lazy-recovery-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const first = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    const started = await first.startThread({ model: "claude:haiku", cwd: directory });
    await first.close();

    const seed = new SqliteHybridStore(database);
    const rootRecord = seed.getThreadRecord(started.thread.id, false)!;
    const childThreadId = "idle-pending-child";
    seed.createThread({
      ...rootRecord,
      claudeSessionId: randomUUID(),
      thread: {
        ...rootRecord.thread,
        id: childThreadId,
        parentThreadId: started.thread.id,
        forkedFromId: started.thread.id,
        threadSource: "subagent",
        turns: [],
      },
    });
    seed.createPendingRequest({
      requestId: "idle-pending-request",
      threadId: started.thread.id,
      turnId: null,
      claudeRequestId: "idle-provider-request",
      method: "item/commandExecution/requestApproval",
      params: {},
      status: "pending",
      response: null,
      createdAt: 1,
      resolvedAt: null,
    });
    seed.createPendingRequest({
      requestId: "idle-child-pending-request",
      threadId: childThreadId,
      turnId: null,
      claudeRequestId: "idle-child-provider-request",
      method: "item/commandExecution/requestApproval",
      params: {},
      status: "pending",
      response: null,
      createdAt: 1,
      resolvedAt: null,
    });
    seed.appendProviderEvent({
      threadId: started.thread.id,
      processEpoch: "dead-process",
      providerSequence: 1,
      providerEventType: "stream_event",
      providerEventId: "idle-pending-provider-event",
      payload: { type: "stream_event" },
      createdAt: 2,
    });
    seed.appendProviderEvent({
      threadId: childThreadId,
      processEpoch: "dead-process",
      providerSequence: 2,
      providerEventType: "stream_event",
      providerEventId: "idle-child-pending-provider-event",
      payload: { type: "stream_event" },
      createdAt: 3,
    });
    seed.close();

    const metrics = new MetricsRegistry();
    const recoveredStore = new SqliteHybridStore(database);
    const recovered = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      recoveredStore, new FakeClaudeQuery().factory, undefined, metrics,
    );
    await recovered.ready();
    const registry = (recovered as unknown as {
      sessions: { activeOwnerIds(): string[]; ownerOf(threadId: string): string };
    }).sessions;
    expect(recovered.loadedThreadIds()).toEqual([]);
    expect(registry.activeOwnerIds()).toEqual([]);
    expect(registry.ownerOf(childThreadId)).toBe(started.thread.id);
    expect(recoveredStore.getPendingRequest("idle-pending-request")).toMatchObject({
      status: "cancelled",
      response: { cancelled: true },
    });
    expect(recoveredStore.getPendingRequest("idle-child-pending-request")).toMatchObject({
      status: "cancelled",
      response: { cancelled: true },
    });
    expect([
      ...recoveredStore.listProviderEvents(started.thread.id),
      ...recoveredStore.listProviderEvents(childThreadId),
    ]).toMatchObject([{
      providerEventId: "idle-pending-provider-event",
      disposition: "abandoned",
    }, {
      providerEventId: "idle-child-pending-provider-event",
      disposition: "abandoned",
    }]);
    expect(metrics.snapshot()).toMatchObject({
      gauges: { pendingApprovals: 0, loadedClaudeRuntimes: 0 },
      counters: {
        providerEventsByTypeAndDisposition: { "stream_event:abandoned": 2 },
      },
    });
    await recovered.close();
  });

  it("retires the mailbox when an idle durable runtime unloads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-idle-session-retire-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const seed = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    const started = await seed.startThread({ model: "claude:haiku", cwd: directory });
    await seed.close();

    const metrics = new MetricsRegistry();
    const service = new ClaudeService(
      { ...config(directory), idleTimeoutSeconds: -1 },
      new SubscriptionHub(),
      new Logger("error"),
      new SqliteHybridStore(database),
      new FakeClaudeQuery().factory,
      undefined,
      metrics,
    );
    await service.ready();
    await service.resumeThread(started.thread.id);
    await waitFor(() => service.loadedThreadIds().includes(started.thread.id), "loaded resumed runtime");
    await (service as unknown as { unloadIdleRuntimes(): Promise<void> }).unloadIdleRuntimes();
    const registry = (service as unknown as {
      sessions: { activeOwnerIds(): string[] };
    }).sessions;
    expect(service.loadedThreadIds()).toEqual([]);
    expect(registry.activeOwnerIds()).toEqual([]);
    expect(service.readThread(started.thread.id, false).thread.status).not.toEqual({ type: "active", activeFlags: [] });
    expect(metrics.snapshot()).toMatchObject({ gauges: { loadedClaudeRuntimes: 0 } });
    await service.close();
  });

  it("makes concurrent resume wait for idle unload before materializing a fresh runtime", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-idle-unload-resume-race-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const seed = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    const started = await seed.startThread({ model: "claude:haiku", cwd: directory });
    await seed.close();

    const fake = new FakeClaudeQuery();
    let releaseStop!: () => void;
    fake.returnWait = new Promise<void>((resolve) => { releaseStop = resolve; });
    const idleConfig = { ...config(directory), idleTimeoutSeconds: -1 };
    const service = new ClaudeService(
      idleConfig,
      new SubscriptionHub(),
      new Logger("error"),
      new SqliteHybridStore(database),
      fake.factory,
    );
    await service.ready();
    await service.resumeThread(started.thread.id);

    const unload = (service as unknown as {
      unloadIdleRuntimes(): Promise<void>;
    }).unloadIdleRuntimes();
    await waitFor(() => fake.returnCalls === 1, "idle runtime provider close");
    let resumed = false;
    const resume = service.resumeThread(started.thread.id).then((response) => {
      resumed = true;
      return response;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resumed).toBe(false);
    expect(service.loadedThreadIds()).toEqual([started.thread.id]);

    idleConfig.idleTimeoutSeconds = 900;
    releaseStop();
    await unload;
    await expect(resume).resolves.toMatchObject({ thread: { id: started.thread.id } });
    expect(fake.inputs).toHaveLength(2);
    await service.close();
  });

  it("cannot publish a runtime that becomes ready after archive", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-archive-loading-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const seed = new ClaudeService(
      config(directory),
      new SubscriptionHub(),
      new Logger("error"),
      new SqliteHybridStore(database),
      new FakeClaudeQuery().factory,
    );
    const started = await seed.startThread({ model: "claude:haiku", cwd: directory });
    await seed.close();

    let releaseInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => { releaseInitialization = resolve; });
    const fake = new FakeClaudeQuery();
    const delayedFactory: typeof fake.factory = (input) => {
      const query = fake.factory(input);
      return new Proxy(query, {
        get(target, property) {
          if (property === "initializationResult") {
            return async () => {
              await initialization;
              return target.initializationResult();
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const metrics = new MetricsRegistry();
    const hub = new SubscriptionHub();
    const methods: string[] = [];
    hub.subscribe(started.thread.id, "archive-loading", (method) => methods.push(method));
    const service = new ClaudeService(
      config(directory),
      hub,
      new Logger("error"),
      new SqliteHybridStore(database),
      delayedFactory,
      undefined,
      metrics,
    );
    await service.resumeThread(started.thread.id);
    await waitFor(() => fake.inputs.length === 1, "delayed archive runtime");
    await service.archiveThread(started.thread.id);
    const beforeReady = methods.length;
    releaseInitialization();
    expect(fake.inputs[0]!.options.abortController?.signal.aborted).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(service.listThreads({ archived: true, limit: 10 })).toContainEqual(
      expect.objectContaining({ id: started.thread.id }),
    );
    expect(methods.slice(beforeReady)).toEqual([]);
    expect(metrics.snapshot()).toMatchObject({
      gauges: { loadedClaudeRuntimes: 0 },
      counters: { claudeRuntimeStarts: 0 },
    });
    await service.close();
  });

  it("persists initialization failure as systemError with the exact visible cause", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-init-failure-"));
    directories.push(directory);
    let rejectInitialization!: () => void;
    const initialization = new Promise<void>((_resolve, reject) => {
      rejectInitialization = () => reject(new Error("runtime authentication failed"));
    });
    const fake = new FakeClaudeQuery();
    const failingFactory: typeof fake.factory = (input) => {
      const query = fake.factory(input);
      return new Proxy(query, {
        get(target, property) {
          if (property === "initializationResult") return async () => {
            await initialization;
            return target.initializationResult();
          };
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const hub = new SubscriptionHub();
    const errors: unknown[] = [];
    const service = new ClaudeService(
      config(directory),
      hub,
      new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      failingFactory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    hub.subscribe(started.thread.id, "init-failure", (method, params) => {
      if (method === "error") errors.push(params);
    });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "fail initialization", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    rejectInitialization();
    await waitFor(
      () => {
        const thread = service.readThread(started.thread.id, true).thread;
        return thread.status.type === "systemError" && thread.turns[0]?.status === "failed";
      },
      "durable initialization failure",
    );

    expect(service.readThread(started.thread.id, true).thread).toMatchObject({
      status: { type: "systemError" },
      turns: [{
        status: "failed",
        error: { message: "runtime authentication failed" },
      }],
    });
    expect(errors).toContainEqual(expect.objectContaining({
      error: expect.objectContaining({ message: "runtime authentication failed" }),
      willRetry: false,
      threadId: started.thread.id,
      turnId: prepared.response.turn.id,
    }));
    await service.close();
  });

  it("projects base, developer, and personality instructions into the Claude preset prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-instructions-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:haiku",
      cwd: directory,
      baseInstructions: "Base contract.",
      developerInstructions: "Developer contract.",
      personality: "pragmatic",
    });
    expect(fake.inputs).toHaveLength(0);
    await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "materialize", text_elements: [] }],
    });
    expect(fake.inputs[0]?.options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Base contract.\n\nDeveloper contract.\n\nBe direct, pragmatic, and focused on concrete outcomes.",
    });
    expect(fake.inputs[0]?.options.disallowedTools).toEqual(["SendFeedback", "ProposeSkills"]);
    await service.close();
  });

  it("maps Codex permission controls to native Claude modes and persists the auto reviewer", async () => {
    const make = (name: string, fake = new FakeClaudeQuery()) => {
      const directory = mkdtempSync(join(tmpdir(), `codex-hybrid-permissions-${name}-`));
      directories.push(directory);
      const database = join(directory, "state.sqlite");
      const service = new ClaudeService(
        config(directory), new SubscriptionHub(), new Logger("error"),
        new SqliteHybridStore(database), fake.factory,
      );
      return { directory, database, fake, service };
    };

    const ask = make("ask");
    const askThread = await ask.service.startThread({
      model: "claude:haiku", cwd: ask.directory, approvalPolicy: "on-request",
    });
    expect(askThread.activePermissionProfile).toEqual({ id: ":workspace", extends: null });
    expect(ask.fake.inputs).toHaveLength(0);
    await ask.service.prepareTurn({
      threadId: askThread.thread.id,
      input: [{ type: "text", text: "materialize", text_elements: [] }],
    });
    expect(ask.fake.inputs[0]?.options.permissionMode).toBe("default");
    expect(ask.fake.inputs[0]?.options.canUseTool).toBeTypeOf("function");
    await ask.service.close();

    const fullFake = new FakeClaudeQuery({ name: "Bash", input: { command: "printf ok" } });
    const full = make("full", fullFake);
    const fullThread = await full.service.startThread({
      model: "claude:haiku", cwd: full.directory, approvalPolicy: "never", sandbox: "danger-full-access",
    });
    expect(fullThread.activePermissionProfile).toEqual({ id: ":danger-full-access", extends: null });
    const prepared = await full.service.prepareTurn({
      threadId: fullThread.thread.id,
      input: [{ type: "text", text: "run", text_elements: [] }],
    });
    expect(full.fake.inputs[0]?.options).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    expect(full.fake.inputs[0]?.options.canUseTool).toBeTypeOf("function");
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => fullFake.permissionResults.length ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(fullFake.permissionResults[0]).toMatchObject({ behavior: "allow" });
    await full.service.close();

    const restricted = make("restricted");
    const restrictedThread = await restricted.service.startThread({
      model: "claude:haiku", cwd: restricted.directory, approvalPolicy: "never", sandbox: "read-only",
    });
    expect(restrictedThread.activePermissionProfile).toEqual({ id: ":read-only", extends: null });
    expect(restricted.fake.inputs).toHaveLength(0);
    await restricted.service.prepareTurn({
      threadId: restrictedThread.thread.id,
      input: [{ type: "text", text: "materialize", text_elements: [] }],
    });
    expect(restricted.fake.inputs[0]?.options.permissionMode).toBe("dontAsk");
    expect(restricted.fake.inputs[0]?.options.canUseTool).toBeTypeOf("function");
    await restricted.service.close();

    const ephemeral = make("ephemeral");
    const ephemeralThread = await ephemeral.service.startThread({
      model: "claude:haiku",
      cwd: ephemeral.directory,
      ephemeral: true,
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
    await ephemeral.service.prepareTurn({
      threadId: ephemeralThread.thread.id,
      input: [{ type: "text", text: "materialize", text_elements: [] }],
    });
    expect(ephemeral.fake.inputs[0]?.options.permissionMode).toBe("auto");
    expect(ephemeral.fake.inputs[0]?.options.canUseTool).toBeTypeOf("function");
    await ephemeral.service.close();

    const autoFake = new FakeClaudeQuery({ name: "Bash", input: { command: "printf ok" } });
    const automatic = make("auto", autoFake);
    const autoThread = await automatic.service.startThread({
      model: "claude:haiku", cwd: automatic.directory, approvalPolicy: "on-request", approvalsReviewer: "auto_review",
    });
    expect(autoThread.approvalsReviewer).toBe("auto_review");
    expect(autoThread.activePermissionProfile).toEqual({ id: ":workspace", extends: null });
    const autoTurn = await automatic.service.prepareTurn({
      threadId: autoThread.thread.id,
      input: [{ type: "text", text: "run", text_elements: [] }],
    });
    expect(automatic.fake.inputs[0]?.options.permissionMode).toBe("auto");
    expect(automatic.fake.inputs[0]?.options.canUseTool).toBeTypeOf("function");
    autoTurn.start();
    await new Promise<void>((resolve) => {
      const poll = () => automatic.service.readThread(autoThread.thread.id, true).thread.turns.at(-1)?.status === "completed"
        ? resolve()
        : setTimeout(poll, 5);
      poll();
    });
    expect(autoFake.preToolHookResults[0]).toEqual({ continue: true });
    expect(autoFake.permissionResults[0]).toMatchObject({
      behavior: "deny",
      message: "Claude Auto did not allow tool 'Bash'.",
    });
    await automatic.service.close();

    const resumedFake = new FakeClaudeQuery();
    const resumed = new ClaudeService(
      config(automatic.directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(automatic.database), resumedFake.factory,
    );
    const response = await resumed.resumeThread(autoThread.thread.id);
    expect(response.approvalsReviewer).toBe("auto_review");
    expect(response.activePermissionProfile).toEqual({ id: ":workspace", extends: null });
    expect(resumedFake.inputs[0]?.options.permissionMode).toBe("auto");
    expect(resumedFake.inputs[0]?.options.canUseTool).toBeTypeOf("function");
    await resumed.close();
  });

  it("replays the exact App Full Access projection through start, settings, fork, read, and resume", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-full-access-projection-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(database), fake.factory,
    );
    const capturedStart = fullAccessProjection.start as ThreadStartParams;
    const expected = fullAccessProjection.expectedProfile;
    const started = await service.startThread({ ...capturedStart, cwd: directory });

    expect(started).toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" },
      activePermissionProfile: expected,
    });
    expect(service.currentThreadSettings(started.thread.id)).toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
      activePermissionProfile: expected,
    });
    expect(fake.inputs).toHaveLength(0);

    const settings: unknown[] = [];
    hub.subscribe(started.thread.id, "full-access-projection", (method, params) => {
      if (method === "thread/settings/updated") settings.push(params);
    });
    await service.updateThreadSettings({
      threadId: started.thread.id,
      ...fullAccessProjection.settingsUpdate as Omit<ThreadSettingsUpdateParams, "threadId">,
    });
    expect(settings).toContainEqual(expect.objectContaining({
      threadSettings: expect.objectContaining({
        sandboxPolicy: { type: "dangerFullAccess" },
        activePermissionProfile: expected,
      }),
    }));
    expect(fake.returnCalls).toBe(0);

    const forked = await service.forkThread({ threadId: started.thread.id, excludeTurns: true });
    expect(forked).toMatchObject({
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
      activePermissionProfile: expected,
    });
    expect(service.readThread(started.thread.id, false)).toEqual({
      thread: expect.objectContaining({ id: started.thread.id, modelProvider: "claude" }),
    });
    await service.close();

    const resumedFake = new FakeClaudeQuery();
    const resumed = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), resumedFake.factory,
    );
    const response = await resumed.resumeThread({
      threadId: started.thread.id,
      ...fullAccessProjection.resume,
    });
    expect(response).toMatchObject({
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
      activePermissionProfile: expected,
      reasoningEffort: "high",
    });
    expect(resumedFake.inputs[0]?.options).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    await resumed.close();
  });

  it("persists provider error metadata before one terminal notification", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-provider-error-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const result = {
      type: "result", subtype: "error_during_execution", duration_ms: 10, duration_api_ms: 8,
      is_error: true, num_turns: 1, stop_reason: null, total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {}, permission_denials: [], errors: ["model_not_found"], terminal_reason: "api_error",
      uuid: "result-error", session_id: "session",
    } as unknown as SDKMessage;
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, result);
    let invalidations = 0;
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
      { list: async () => [{
        id: "claude:haiku", model: "claude:haiku", upgrade: null, upgradeInfo: null, availabilityNux: null,
        displayName: "Haiku", description: "test", hidden: false, supportedReasoningEfforts: [],
        defaultReasoningEffort: "medium", inputModalities: ["text" as const], supportsPersonality: true,
        additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, isDefault: false,
      }], invalidate: () => { invalidations += 1; } },
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => {
      if (method === "error" || method === "turn/completed") events.push({ method, params });
    });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "fail", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => events.some((event) => event.method === "turn/completed") ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(events.map((event) => event.method)).toEqual(["error", "turn/completed"]);
    expect(events[0]?.params).toMatchObject({
      error: { message: "model_not_found", codexErrorInfo: "badRequest", additionalDetails: null },
      willRetry: false,
      threadId: started.thread.id,
    });
    expect(service.readThread(started.thread.id, true).thread.turns.at(-1)).toMatchObject({
      status: "failed", error: { message: "model_not_found", codexErrorInfo: "badRequest" },
    });
    expect(invalidations).toBe(1);
    await service.close();
  });

  it("matches the mobile resume bootstrap contract with excluded turns and a descending full page", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-mobile-resume-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), new FakeClaudeQuery().factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    hub.subscribe(started.thread.id, "test", () => undefined);
    const prepared = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "resume me", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed"
        ? resolve() : setTimeout(poll, 5);
      poll();
    });

    const resumed = await service.resumeThread({
      threadId: started.thread.id,
      excludeTurns: true,
      initialTurnsPage: { itemsView: "full", limit: 5, sortDirection: "desc" },
    });
    expect(resumed.thread.turns).toEqual([]);
    expect(resumed.initialTurnsPage).toMatchObject({
      data: [{ itemsView: "full", items: [{ type: "userMessage" }, { type: "agentMessage" }] }],
      nextCursor: null,
      backwardsCursor: "hyb-turn:0",
    });
    await service.close();
  });

  it("reconciles an active crash into one durable failed terminal turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-crash-reconcile-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const seed = new SqliteHybridStore(database);
    const thread = {
      id: "crashed-thread", extra: null, sessionId: "codex-session", forkedFromId: null, parentThreadId: null,
      preview: "crash", ephemeral: false, historyMode: "legacy" as const, modelProvider: "claude",
      createdAt: 1, updatedAt: 1, recencyAt: 1, status: { type: "active" as const, activeFlags: [] },
      path: null, cwd: directory, cliVersion: "test", source: "appServer" as const, threadSource: null,
      agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [],
    };
    seed.createThread({
      thread, claudeSessionId: "claude-session", modelPickerId: "claude:haiku", claudeModelValue: "haiku",
      serviceTier: null, approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" },
      approvalsReviewer: "user",
      baseInstructions: null, developerInstructions: null, personality: null, resolvedModel: null,
      lastClaudeMessageUuid: null, lastCompletedTurnId: null, claudeCodeVersion: null,
      reasoningEffort: null, reasoningSummary: null, collaborationMode: null, outputSchema: null,
      tokenUsageTotal: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      tokenUsageLast: null, modelContextWindow: null,
    });
    seed.createTurn(thread.id, {
      id: "crashed-turn", items: [
        { type: "enteredReviewMode", id: "review-entered", review: "current changes" },
        { type: "userMessage", id: "crashed-turn", clientId: null, content: [] },
        { type: "agentMessage", id: "partial-review", text: "P1 persisted finding", phase: "commentary", memoryCitation: null },
        {
          type: "commandExecution", id: "crashed-command", command: "sleep 10", cwd: directory,
          processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: "TICK 1\n",
          exitCode: null, durationMs: null,
        },
      ],
      itemsView: "full", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null,
    });
    seed.createPendingRequest({
      requestId: "crashed-request", threadId: thread.id, turnId: "crashed-turn", claudeRequestId: "provider-request",
      method: "item/commandExecution/requestApproval", params: {}, status: "pending", response: null,
      createdAt: 1, resolvedAt: null,
    });
    seed.appendProviderEvent({
      threadId: thread.id,
      processEpoch: "dead-process",
      providerSequence: 7,
      providerEventType: "stream_event",
      providerEventId: "crashed-provider-event",
      payload: { type: "stream_event", event: { type: "content_block_delta" } },
      createdAt: 2,
    });
    seed.setGoal(thread.id, { objective: "survive the gateway restart" });
    seed.close();

    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    await service.ready();
    const recoveredRegistry = (service as unknown as {
      sessions: { activeOwnerIds(): string[] };
    }).sessions;
    expect(service.loadedThreadIds()).toEqual([]);
    expect(recoveredRegistry.activeOwnerIds()).toEqual([]);
    expect(service.readThread(thread.id, true).thread).toMatchObject({
      status: { type: "systemError" },
      turns: [{
        id: "crashed-turn", status: "failed", items: [
          { type: "enteredReviewMode", review: "current changes" },
          { type: "userMessage", id: "crashed-turn" },
          { type: "agentMessage", text: "P1 persisted finding" },
          { id: "crashed-command", status: "failed", aggregatedOutput: "TICK 1\n" },
          { type: "exitedReviewMode", review: "P1 persisted finding" },
        ],
        error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } },
      }],
    });
    await waitFor(async () => (await service.getGoal(thread.id)).goal?.status === "blocked", "restart goal recovery");
    const inspector = new SqliteHybridStore(database);
    expect(inspector.listPendingRequests(thread.id)).toEqual([]);
    expect(inspector.getPendingRequest("crashed-request")).toMatchObject({ status: "cancelled", response: { cancelled: true } });
    expect(inspector.listProviderEvents(thread.id)).toMatchObject([{
      providerEventId: "crashed-provider-event",
      disposition: "abandoned",
      error: "Gateway process exited after journaling this provider event but before projection completed.",
    }]);
    expect(inspector.listEventsAfter(thread.id, 0).filter((event) =>
      event.method === "thread/goal/updated")).toMatchObject([{
      turnId: "crashed-turn", params: { goal: { status: "blocked" } },
    }]);
    inspector.close();
    await service.close();
  });

  it("bridges a Claude Bash permission through a Codex server request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-permission-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const command = "rg --files ~/.ccodex/current/node_modules/@gkorepanov/ccodex/dist";
    process.env.CCODEX_COMMAND_PARSER = join(process.cwd(), "tests/fixtures/fakeCommandParser.sh");
    const fake = new FakeClaudeQuery({ name: "Bash", input: { command } });
    const sessionUpdates = [{
      type: "addRules" as const,
      rules: [{ toolName: "Bash", ruleContent: command }],
      behavior: "allow" as const,
      destination: "session" as const,
    }];
    fake.permissionSuggestions = sessionUpdates;
    fake.streamPermissionTool = true;
    const service = new ClaudeService(config(directory), hub, new Logger("error"), store, fake.factory);
    const started = await service.startThread({ model: "claude:haiku", cwd: directory, approvalPolicy: "on-request" });
    const requests: string[] = [];
    const events: Array<{ method: string; params: unknown }> = [];
    const approvalParams: unknown[] = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }), (id, method, params) => {
      requests.push(method);
      approvalParams.push(params);
      void service.resolveServerRequest(id, { decision: "acceptForSession" });
    });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "list files", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => events.filter((event) => event.method === "turn/completed").length === 1 ? resolve() : setTimeout(poll, 5);
      poll();
    });
    const second = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "list files again", text_elements: [] }],
    });
    const secondCommand = "rm -rf ./unrelated";
    fake.toolRequest = { name: "Bash", input: { command: secondCommand } };
    fake.permissionSuggestions = [{
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: secondCommand }],
      behavior: "allow",
      destination: "session",
    }];
    second.announce();
    second.start();
    await new Promise<void>((resolve) => {
      const poll = () => events.filter((event) => event.method === "turn/completed").length === 2 ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(requests).toEqual([
      "item/commandExecution/requestApproval",
      "item/commandExecution/requestApproval",
    ]);
    expect(approvalParams[0]).toMatchObject({
      command,
      commandActions: [{ type: "listFiles", path: "ccodex" }],
    });
    const commandStart = events.findIndex((event) => event.method === "item/started"
      && (event.params as { item?: { type?: string } }).item?.type === "commandExecution");
    const waiting = events.findIndex((event) => event.method === "thread/status/changed"
      && (event.params as { status?: { activeFlags?: string[] } }).status?.activeFlags?.includes("waitingOnApproval"));
    expect(waiting).toBeGreaterThanOrEqual(0);
    expect(commandStart).toBeGreaterThan(waiting);
    expect(events[commandStart]?.params).toMatchObject({
      item: { command, commandActions: [{ type: "listFiles", path: "ccodex" }] },
    });
    const statuses = events
      .filter((event) => event.method === "thread/status/changed")
      .map((event) => event.params);
    expect(statuses).toContainEqual(expect.objectContaining({ status: { type: "active", activeFlags: ["waitingOnApproval"] } }));
    expect(statuses).toContainEqual(expect.objectContaining({ status: { type: "active", activeFlags: [] } }));
    expect(approvalParams[1]).toMatchObject({ command: secondCommand });
    expect(fake.permissionResults[0]).toMatchObject({
      behavior: "allow",
      decisionClassification: "user_permanent",
    });
    expect((fake.permissionResults[0] as { updatedPermissions: unknown }).updatedPermissions)
      .toBe(sessionUpdates);
    expect(fake.permissionResults).toHaveLength(2);
    expect(fake.providerHookAllowedTools).toEqual([]);
    await service.close();
  });

  it("treats a delayed interrupt for a completed turn as a no-op", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-delayed-interrupt-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery({ name: "Bash", input: { command: "printf ok" } });
    const hub = new SubscriptionHub();
    const requestIds: string[] = [];
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:haiku", cwd: directory, approvalPolicy: "on-request",
    });
    hub.subscribe(started.thread.id, "delayed-interrupt", () => undefined, (requestId) => {
      requestIds.push(requestId);
    });
    const first = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "first", text_elements: [] }],
    });
    first.announce();
    first.start();
    await waitFor(() => requestIds.length === 1, "first approval");
    await service.resolveServerRequest(requestIds[0]!, { decision: "accept" });
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "first approved turn",
    );

    const second = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "second", text_elements: [] }],
    });
    second.announce();
    second.start();
    await waitFor(() => requestIds.length === 2, "second approval");
    await service.interruptTurn({ threadId: started.thread.id, turnId: first.response.turn.id });

    expect(fake.interruptCalls).toBe(0);
    expect(service.readThread(started.thread.id, true).thread).toMatchObject({
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
      turns: [
        { id: first.response.turn.id, status: "completed" },
        { id: second.response.turn.id, status: "inProgress" },
      ],
    });
    await service.resolveServerRequest(requestIds[1]!, { decision: "decline" });
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[1]?.status !== "inProgress",
      "second denied turn",
    );
    await service.close();
  });

  it("fences Stop between steer persistence and SDK send", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-steer-stop-fence-"));
    directories.push(directory);
    let releaseProvider!: () => void;
    const providerBarrier = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const fake = new FakeClaudeQuery(
      undefined,
      undefined,
      [],
      false,
      undefined,
      undefined,
      undefined,
      [{
        type: "prompt_suggestion",
        suggestion: "hold",
        uuid: randomUUID(),
        session_id: "session",
      } as unknown as SDKMessage],
      { afterIndex: 0, wait: providerBarrier },
    );
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const initial = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "work", text_elements: [] }],
    });
    initial.announce();
    initial.start();
    await waitFor(() => fake.prompts.length === 1, "initial provider prompt");
    let stop: Promise<void> | undefined;
    hub.subscribe(started.thread.id, "steer-stop", (method, params) => {
      if (method !== "item/completed") return;
      const item = (params as { item?: { type?: string; content?: Array<{ type?: string; text?: string }> } }).item;
      if (item?.type === "userMessage" && item.content?.some((part) =>
        part.type === "text" && part.text === "steer now")) {
        stop ??= service.interruptTurn({
          threadId: started.thread.id,
          turnId: initial.response.turn.id,
        });
      }
    });
    const steer = service.steerTurn({
      threadId: started.thread.id,
      expectedTurnId: initial.response.turn.id,
      input: [{ type: "text", text: "steer now", text_elements: [] }],
    });
    const rejected = expect(steer).rejects.toThrow("stopped before the steer was admitted");
    await waitFor(() => stop !== undefined, "Stop after steer persistence");
    await stop;
    await rejected;
    releaseProvider();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fake.prompts).toHaveLength(1);
    expect(service.readThread(started.thread.id, true).thread.turns[0]).toMatchObject({
      status: "interrupted",
      items: expect.arrayContaining([expect.objectContaining({
        type: "userMessage",
        content: [{ type: "text", text: "steer now", text_elements: [] }],
      })]),
    });
    await service.close();
  });

  it("auto-allows file mutations inside workspace writable roots", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-file-permission-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery({ name: "Edit", input: { file_path: "approved.txt" } });
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:haiku", cwd: directory, approvalPolicy: "on-request", sandbox: "workspace-write",
    });
    const requests: string[] = [];
    hub.subscribe(started.thread.id, "test", () => undefined, (_id, method) => requests.push(method));
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "edit the file", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => fake.permissionResults.length ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(requests).toEqual([]);
    expect(fake.permissionResults[0]).toEqual({ behavior: "allow", updatedInput: { file_path: "approved.txt" } });
    await service.close();
  });

  it("routes generic Claude permissions through the Codex approval contract and preserves decline", async () => {
    const name = "WebFetch";
    const input = { url: "https://example.com" };
    const expectedMethod = "item/permissions/requestApproval";
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-permission-kind-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery({ name, input });
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:haiku", cwd: directory, approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const requests: string[] = [];
    hub.subscribe(started.thread.id, "test", () => undefined, (id, method) => {
      requests.push(method);
      void service.resolveServerRequest(id, { decision: "decline" });
    });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "request permission", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => fake.permissionResults.length ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(requests).toEqual([expectedMethod]);
    expect(fake.permissionResults[0]).toEqual({
      behavior: "deny",
      message: "User declined tool execution.",
      decisionClassification: "user_reject",
    });
    await service.close();
  });

  it("does not advertise or apply unsafe provider session updates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-unsafe-session-permission-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery({ name: "Bash", input: { command: "printf ok" } });
    fake.permissionSuggestions = [{
      type: "addRules",
      rules: [{ toolName: "Bash" }],
      behavior: "allow",
      destination: "projectSettings",
    }];
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:haiku", cwd: directory, approvalPolicy: "on-request",
    });
    let approval: { id: string; params: unknown } | undefined;
    hub.subscribe(started.thread.id, "unsafe-session", () => undefined, (id, _method, params) => {
      approval = { id, params };
    });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "run it", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(() => approval !== undefined, "unsafe session approval");
    expect(approval!.params).toMatchObject({
      availableDecisions: ["accept", "decline", "cancel"],
    });
    await service.resolveServerRequest(approval!.id, { decision: "acceptForSession" });
    await waitFor(() => fake.permissionResults.length === 1, "stale session decision");
    expect(fake.permissionResults[0]).toEqual({
      behavior: "allow",
      updatedInput: { command: "printf ok" },
      decisionClassification: "user_temporary",
    });
    await service.close();
  });

  it("keeps an ephemeral fork loaded for inject and turn lifecycle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-ephemeral-fork-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const source = await service.startThread({ model: "claude:haiku", cwd: directory });
    const fork = await service.forkThread({ threadId: source.thread.id, ephemeral: true, excludeTurns: true });
    expect(fork.thread).toMatchObject({
      ephemeral: true, forkedFromId: source.thread.id, status: { type: "idle" }, turns: [],
    });
    expect(service.loadedThreadIds()).toContain(fork.thread.id);
    await service.injectItems({
      threadId: fork.thread.id,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "injected context" }] }],
    });
    const events: string[] = [];
    hub.subscribe(fork.thread.id, "test", (method) => events.push(method));
    const prepared = await service.prepareTurn({
      threadId: fork.thread.id,
      input: [{ type: "text", text: "continue", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => events.includes("turn/completed") ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(service.readThread(fork.thread.id, true).thread.turns.at(-1)?.status).toBe("completed");
    await service.close();
  });

  it("retries an output-free /side runtime exit once and keeps only the successful target", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-side-runtime-retry-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    let attempts = 0;
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      (input) => {
        const query = fake.factory(input);
        if (attempts++ > 0) return query;
        input.options.stderr?.("temporary Claude bootstrap failure\n");
        return new Proxy(query, {
          get(target, property) {
            if (property === "initializationResult") {
              return async () => { throw new Error("Query closed before response received"); };
            }
            if (property === Symbol.asyncIterator) return async function* () { /* no provider output */ };
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    );
    const source = await service.startThread({ model: "claude:haiku", cwd: directory });

    const fork = await service.forkThread({
      threadId: source.thread.id,
      ephemeral: true,
      excludeTurns: true,
      threadSource: "user",
    });

    expect(attempts).toBe(2);
    expect(fork.thread).toMatchObject({ ephemeral: true, forkedFromId: source.thread.id });
    expect(service.listThreads({ limit: 100 }).map((thread) => thread.id).sort())
      .toEqual([source.thread.id, fork.thread.id].sort());
    expect(service.loadedThreadIds()).toContain(fork.thread.id);
    await service.close();
  });

  it("reports the final /side startup cause and cleans a twice-failed target exactly once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-side-runtime-failure-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const removeTranscript = vi.fn(async () => undefined);
    const transcripts: TranscriptBrancher = {
      forkWithProvenance: async () => ({ sessionId: "failed-side-session", uuidMap: new Map() }),
      resolveCompactionBoundary: async (_sessionId, _cwd, boundary) => boundary.uuid,
      delete: removeTranscript,
    };
    let attempts = 0;
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      (input) => {
        attempts += 1;
        input.options.stderr?.(`side bootstrap attempt ${attempts} failed\n`);
        const query = fake.factory(input);
        return new Proxy(query, {
          get(target, property) {
            if (property === "initializationResult") {
              return async () => { throw new Error("Query closed before response received"); };
            }
            if (property === Symbol.asyncIterator) return async function* () { /* no provider output */ };
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      undefined,
      undefined,
      transcripts,
    );
    const source = await service.startThread({ model: "claude:haiku", cwd: directory });

    await expect(service.forkThread({
      threadId: source.thread.id,
      ephemeral: true,
      excludeTurns: true,
      threadSource: "user",
    })).rejects.toThrow(/Query closed before response received[\s\S]*side bootstrap attempt 2 failed/u);

    expect(attempts).toBe(2);
    expect(service.listThreads({ limit: 100 }).map((thread) => thread.id)).toEqual([source.thread.id]);
    expect(removeTranscript).toHaveBeenCalledTimes(1);
    expect(removeTranscript).toHaveBeenCalledWith(expect.any(String), directory);
    await service.close();
  });

  it("promotes a completed user side chat into a durable same-provider fork", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-side-promotion-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const fake = new FakeClaudeQuery();
    const forkCalls: Array<{ source: string; boundary: string; expected: readonly string[] }> = [];
    const transcripts: TranscriptBrancher = {
      forkWithProvenance: async (source, boundary, _cwd, expected) => {
        forkCalls.push({ source, boundary, expected });
        return {
          sessionId: randomUUID(),
          uuidMap: new Map(expected.map((uuid) => [uuid, randomUUID()])),
        };
      },
      resolveCompactionBoundary: async (_sessionId, _cwd, boundary) => boundary.uuid,
      delete: async () => undefined,
    };
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), fake.factory, undefined, undefined, transcripts,
    );
    const source = await service.startThread({
      model: "claude:haiku", cwd: directory, serviceTier: null,
      approvalPolicy: "on-request", threadSource: "user",
    });
    const side = await service.forkThread({
      threadId: source.thread.id, ephemeral: true, excludeTurns: true, threadSource: "user",
    });
    for (const text of ["first side message", "second side message"]) {
      const prepared = await service.prepareTurn({
        threadId: side.thread.id,
        input: [{ type: "text", text, text_elements: [] }],
      });
      prepared.announce();
      prepared.start();
      await waitFor(
        () => service.readThread(side.thread.id, true).thread.turns.at(-1)?.status === "completed",
        `${text} completion`,
      );
    }
    expect(fake.inputs.at(-1)?.options.persistSession).toBe(true);

    const promoted = await service.forkThread({ threadId: side.thread.id, threadSource: "user" });
    expect(promoted.thread).toMatchObject({
      ephemeral: false,
      forkedFromId: side.thread.id,
      modelProvider: "claude",
      threadSource: "user",
      status: { type: "notLoaded" },
    });
    expect(promoted.thread.turns).toHaveLength(2);
    expect(promoted.thread.turns.map((turn) => turn.status)).toEqual(["completed", "completed"]);
    expect(service.readThread(side.thread.id, true).thread.turns).toHaveLength(2);
    expect(forkCalls).toHaveLength(1);
    expect((service as unknown as { ephemeralReleaseTimers: Map<string, NodeJS.Timeout> })
      .ephemeralReleaseTimers.has(side.thread.id)).toBe(true);
    await service.close();

    const resumed = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory, undefined, undefined, transcripts,
    );
    await resumed.ready();
    expect(resumed.readThread(promoted.thread.id, true).thread.turns).toHaveLength(2);
    expect(resumed.ownsThread(side.thread.id)).toBe(false);
    await resumed.close();
  });

  it("honors the side promotion feature flag", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-side-promotion-disabled-"));
    directories.push(directory);
    const disabled = {
      ...config(directory),
      features: { statusCommand: true, sideChatPromotion: false, interactiveQuestions: true },
    };
    const service = new ClaudeService(
      disabled, new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), new FakeClaudeQuery().factory,
    );
    const source = await service.startThread({ model: "claude:haiku", cwd: directory });
    const side = await service.forkThread({
      threadId: source.thread.id, ephemeral: true, excludeTurns: true, threadSource: "user",
    });
    await expect(service.forkThread({ threadId: side.thread.id }))
      .rejects.toThrow("Forking this ephemeral Claude source thread is not supported");
    await service.close();
  });

  it("acknowledges captured inject_items after enqueue while provider no-query results remain delayed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-raw-inject-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    let release!: () => void;
    const acknowledgement = new Promise<void>((resolve) => { release = resolve; });
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined, [], undefined, acknowledgement,
    );
    fake.noQueryAcknowledgementBatchSize = 2;
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const before = service.readThread(started.thread.id, true).thread;
    const events: string[] = [];
    hub.subscribe(started.thread.id, "inject", (method) => events.push(method));
    await expect(service.injectItems({ threadId: started.thread.id, items: [] }))
      .rejects.toThrow("items must not be empty");
    await expect(service.injectItems({ threadId: started.thread.id, items: [{ broken: true }] }))
      .rejects.toThrow("items[0] is not a valid response item");
    const firstInjection = service.injectItems({
      threadId: started.thread.id,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "snapshot" }] }],
    });
    await waitFor(() => fake.prompts.length === 1, "raw injection provider send");
    await firstInjection;
    const secondInjection = service.injectItems({
      threadId: started.thread.id,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "boundary" }] }],
    });
    await secondInjection;
    expect(fake.prompts).toHaveLength(2);
    expect(events).toEqual([]);
    expect(service.readThread(started.thread.id, true).thread).toMatchObject({
      turns: [], preview: before.preview, recencyAt: before.recencyAt, updatedAt: before.updatedAt,
    });

    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "answer after both preludes", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    release();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed",
      "turn after delayed injection acknowledgements",
    );
    expect(fake.prompts.filter((message) => message.shouldQuery === false)).toHaveLength(2);
    expect(fake.prompts.filter((message) => message.shouldQuery !== false)).toHaveLength(1);
    await service.close();
  });

  it("does not replay a durable raw injection after restart between provider send and no-query ack", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-inject-restart-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    let release!: () => void;
    const ack = new Promise<void>((resolve) => { release = resolve; });
    const firstFake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined, [], undefined, ack,
    );
    const first = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), firstFake.factory,
    );
    const started = await first.startThread({ model: "claude:haiku", cwd: directory });
    const firstSession = await (first as unknown as {
      sessions: { getOrCreate(threadId: string): Promise<ClaudeSession> };
    }).sessions.getOrCreate(started.thread.id);
    const injecting = firstSession.injectRuntimeItems(
      [{ type: "message", role: "user", content: [{ type: "input_text", text: "once" }] }],
      true,
    );
    await waitFor(() => firstFake.prompts.length === 1, "raw injection provider send");
    const closing = first.close();
    await expect(injecting).rejects.toThrow("Gateway shut down");
    release();
    await closing;

    const resumedFake = new FakeClaudeQuery();
    const resumed = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), resumedFake.factory,
    );
    await resumed.resumeThread(started.thread.id);
    expect(firstFake.prompts).toHaveLength(1);
    expect(resumedFake.prompts).toHaveLength(0);
    expect(resumed.readThread(started.thread.id, true).thread.turns).toEqual([]);
    await resumed.close();
  });

  it("balances pending no-query operations before replaying an ephemeral prelude after settings replacement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-prelude-restart-"));
    directories.push(directory);
    let release!: () => void;
    const acknowledgement = new Promise<void>((resolve) => { release = resolve; });
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined, [], undefined, acknowledgement,
    );
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:haiku", cwd: directory, ephemeral: true, threadSource: "user",
    });
    const session = await (service as unknown as {
      sessions: { getOrCreate(threadId: string): Promise<ClaudeSession> };
    }).sessions.getOrCreate(started.thread.id);
    const injecting = session.injectRuntimeItems(
      [{ type: "message", role: "user", content: [{ type: "input_text", text: "prelude" }] }],
      true,
    );
    await waitFor(() => fake.prompts.length === 1, "initial prelude send");
    const updating = service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });
    const preparing = service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "continue", text_elements: [] }],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fake.prompts).toHaveLength(1);
    release();
    await injecting;
    await waitFor(() => fake.prompts.length === 2, "replayed prelude send");
    await updating;
    const prepared = await preparing;
    prepared.announce();
    prepared.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed",
      "turn completion after replacement acknowledgement",
    );
    await service.close();
  });

  it("runs the complete captured Full Access side, child, settings, and reconnect lifecycle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-active-side-"));
    directories.push(directory);
    const backgroundOutput = join(directory, "flow-a-background.output");
    writeFileSync(backgroundOutput, "FLOW_A_BACKGROUND_OK\n");
    const backgroundToolId = "flow-a-background-tool";
    const backgroundTaskId = "flow-a-background-task";
    const agentToolId = "flow-a-agent-tool";
    const agentTaskId = "flow-a-agent-task";
    let releaseParent!: () => void;
    const parentWait = new Promise<void>((resolve) => { releaseParent = resolve; });
    const base = { parent_tool_use_id: null, session_id: "parent-session" };
    const parent = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined,
      [
        { type: "stream_event", event: { type: "message_start", message: {} }, uuid: randomUUID(), ...base },
        {
          type: "stream_event", uuid: randomUUID(), ...base,
          event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "test" } },
        },
        {
          type: "stream_event", uuid: randomUUID(), ...base,
          event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Working on parent" } },
        },
        {
          type: "stream_event", uuid: randomUUID(), ...base,
          event: { type: "content_block_stop", index: 0 },
        },
        {
          type: "stream_event", uuid: randomUUID(), ...base,
          event: {
            type: "content_block_start", index: 1,
            content_block: {
              type: "tool_use", id: backgroundToolId, name: "Bash",
              input: { command: "printf FLOW_A_BACKGROUND_OK", run_in_background: true },
            },
          },
        },
        {
          type: "stream_event", uuid: randomUUID(), ...base,
          event: { type: "content_block_stop", index: 1 },
        },
        {
          type: "user", uuid: randomUUID(), ...base,
          message: {
            role: "user",
            content: [{
              type: "tool_result", tool_use_id: backgroundToolId,
              content: `Command running in background with ID: ${backgroundTaskId}. Output is being written to: ${backgroundOutput}.`,
            }],
          },
          tool_use_result: { stdout: "", stderr: "", backgroundTaskId },
        },
        {
          type: "system", subtype: "background_tasks_changed",
          tasks: [{ task_id: backgroundTaskId, task_type: "bash", description: "Flow A background" }],
          uuid: randomUUID(), session_id: base.session_id,
        },
        {
          type: "system", subtype: "task_started", task_id: backgroundTaskId, tool_use_id: backgroundToolId,
          task_type: "bash", description: "Flow A background", uuid: randomUUID(), session_id: base.session_id,
        },
        {
          type: "stream_event", uuid: randomUUID(), ...base,
          event: {
            type: "content_block_start", index: 2,
            content_block: {
              type: "tool_use", id: agentToolId, name: "Agent",
              input: { prompt: "Inspect Flow A", description: "Flow A child" },
            },
          },
        },
        {
          type: "stream_event", uuid: randomUUID(), ...base,
          event: { type: "content_block_stop", index: 2 },
        },
        {
          type: "system", subtype: "task_started", task_id: agentTaskId, tool_use_id: agentToolId,
          task_type: "agent", subagent_type: "general-purpose", description: "Flow A child",
          prompt: "Inspect Flow A", uuid: randomUUID(), session_id: base.session_id,
        },
        {
          type: "stream_event", parent_tool_use_id: agentToolId, uuid: randomUUID(), session_id: base.session_id,
          event: { type: "message_start", message: {} },
        },
        {
          type: "stream_event", parent_tool_use_id: agentToolId, uuid: randomUUID(), session_id: base.session_id,
          event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        },
        {
          type: "stream_event", parent_tool_use_id: agentToolId, uuid: randomUUID(), session_id: base.session_id,
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "FLOW_A_CHILD_OK" } },
        },
        {
          type: "stream_event", parent_tool_use_id: agentToolId, uuid: randomUUID(), session_id: base.session_id,
          event: { type: "content_block_stop", index: 0 },
        },
        {
          type: "assistant", parent_tool_use_id: agentToolId, uuid: randomUUID(), session_id: base.session_id,
          message: { role: "assistant", content: [{ type: "text", text: "FLOW_A_CHILD_OK" }] },
        },
        {
          type: "system", subtype: "task_notification", task_id: agentTaskId, tool_use_id: agentToolId,
          status: "completed", output_file: join(directory, "unused-child-output"), summary: "Flow A child completed",
          uuid: randomUUID(), session_id: base.session_id,
        },
        {
          type: "system", subtype: "background_tasks_changed", tasks: [],
          uuid: randomUUID(), session_id: base.session_id,
        },
        {
          type: "system", subtype: "task_notification", task_id: backgroundTaskId, tool_use_id: backgroundToolId,
          status: "completed", output_file: backgroundOutput, summary: "Flow A background completed (exit code 0)",
          usage: { total_tokens: 0, tool_uses: 1, duration_ms: 1_000 },
          uuid: randomUUID(), session_id: base.session_id,
        },
      ] as unknown as SDKMessage[],
      { afterIndex: 11, wait: parentWait },
    );
    let releaseNoQueryAcknowledgements!: () => void;
    const noQueryAcknowledgements = new Promise<void>((resolve) => { releaseNoQueryAcknowledgements = resolve; });
    const initialSide = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined, [], undefined, noQueryAcknowledgements,
    );
    const side = new FakeClaudeQuery();
    const hub = new SubscriptionHub();
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    let runtimeCount = 0;
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      store,
      (input) => (runtimeCount++ === 0 ? parent : runtimeCount === 2 ? initialSide : side).factory(input),
    );
    const layeredStore = (service as unknown as { store: HybridStore }).store;
    const source = await service.startThread({
      model: "claude:haiku", cwd: directory, approvalPolicy: "never", sandbox: "danger-full-access",
    });
    expect(source).toMatchObject({
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
      activePermissionProfile: { id: ":danger-full-access", extends: null },
    });
    const sourceEvents: string[] = [];
    hub.subscribe(source.thread.id, "parent-test", (method) => sourceEvents.push(method));
    const preparedParent = await service.prepareTurn({
      threadId: source.thread.id,
      input: [{ type: "text", text: "long parent task", text_elements: [] }],
    });
    preparedParent.announce();
    preparedParent.start();
    await new Promise<void>((resolve) => {
      const poll = () => sourceEvents.includes("item/reasoning/summaryTextDelta") ? resolve() : setTimeout(poll, 5);
      poll();
    });
    const sourceEventCount = sourceEvents.length;
    const activeInjection = service.injectItems({
      threadId: source.thread.id,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "active reference" }] }],
    });
    expect(service.readThread(source.thread.id, true).thread.turns).toHaveLength(1);
    expect(service.readThread(source.thread.id, true).thread.turns[0]?.status).toBe("inProgress");
    expect(sourceEvents).toHaveLength(sourceEventCount);

    const startedAt = performance.now();
    const fork = await service.forkThread({
      threadId: source.thread.id,
      threadSource: "user",
      developerInstructions: "Captured App /side instructions.",
      ephemeral: true,
      excludeTurns: true,
    });
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(fork.thread).toMatchObject({ ephemeral: true, forkedFromId: source.thread.id, status: { type: "idle" }, turns: [] });
    expect(service.readThread(fork.thread.id, true).thread.turns).toEqual([]);
    expect(service.readThread(source.thread.id, true).thread.status.type).toBe("active");
    await new Promise<void>((resolve) => {
      const poll = () => initialSide.prompts.length > 0 ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(JSON.stringify(initialSide.prompts[0])).toContain("ccodex_side_parent_snapshot");
    expect(JSON.stringify(initialSide.prompts[0])).toContain("Working on parent");

    const sideInjection = service.injectItems({
      threadId: fork.thread.id,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "canonical side boundary" }] }],
    });
    releaseNoQueryAcknowledgements();
    await sideInjection;
    const originalPreludeBoundary = layeredStore.getThreadRecord(fork.thread.id, false)!.lastClaudeMessageUuid;
    const sideEvents: string[] = [];
    hub.subscribe(fork.thread.id, "side-test", (method) => sideEvents.push(method));
    const preparedSide = await service.prepareTurn({
      threadId: fork.thread.id,
      cwd: directory,
      approvalPolicy: null,
      approvalsReviewer: null,
      permissions: null,
      serviceTier: "default",
      summary: "detailed",
      personality: "friendly",
      collaborationMode: {
        mode: "default",
        settings: { model: "claude:haiku", reasoning_effort: "high", developer_instructions: null },
      },
      input: [{ type: "text", text: "answer independently", text_elements: [] }],
    });
    const replayedPreludeBoundary = layeredStore.getThreadRecord(fork.thread.id, false)!.lastClaudeMessageUuid;
    expect(replayedPreludeBoundary).not.toBe(originalPreludeBoundary);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(layeredStore.getThreadRecord(fork.thread.id, false)!.lastClaudeMessageUuid).toBe(replayedPreludeBoundary);
    preparedSide.announce();
    preparedSide.start();
    await new Promise<void>((resolve) => {
      const poll = () => sideEvents.includes("turn/completed") ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(service.readThread(fork.thread.id, true).thread.turns.at(-1)).toMatchObject({
      status: "completed",
      items: expect.arrayContaining([expect.objectContaining({ type: "agentMessage", text: "OK" })]),
    });
    const turnCountAfterFirstAnswer = service.readThread(fork.thread.id, true).thread.turns.length;
    const secondSide = await service.prepareTurn({
      threadId: fork.thread.id,
      cwd: directory,
      serviceTier: "default",
      summary: "detailed",
      personality: "friendly",
      collaborationMode: {
        mode: "default",
        settings: { model: "claude:haiku", reasoning_effort: "high", developer_instructions: null },
      },
      input: [{ type: "text", text: "continue the same side conversation", text_elements: [] }],
    });
    secondSide.announce();
    secondSide.start();
    await waitFor(
      () => service.readThread(fork.thread.id, true).thread.turns.length === turnCountAfterFirstAnswer + 1
        && service.readThread(fork.thread.id, true).thread.turns.at(-1)?.status === "completed",
      "second side turn completion",
    );
    const sideThread = service.readThread(fork.thread.id, true).thread;
    expect(sideThread.status).toEqual({ type: "idle" });
    expect(sideThread.turns.filter((turn) => turn.items.some((item) => item.type === "agentMessage"))).toMatchObject([
      { status: "completed", items: expect.arrayContaining([expect.objectContaining({ type: "agentMessage", text: "OK" })]) },
      { status: "completed", items: expect.arrayContaining([expect.objectContaining({ type: "agentMessage", text: "OK" })]) },
    ]);
    expect(layeredStore.getThreadRecord(fork.thread.id, false)!.lastClaudeMessageUuid).not.toBe(originalPreludeBoundary);
    expect(initialSide.prompts.filter((message) => message.shouldQuery !== false)).toEqual([]);
    expect(side.inputs).toHaveLength(1);
    expect(side.inputs[0]?.options).toMatchObject({
      effort: "high",
      thinking: { type: "adaptive", display: "summarized" },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: expect.stringContaining("Captured App /side instructions."),
      },
    });
    expect(side.inputs[0]?.options.systemPrompt).toMatchObject({
      append: expect.stringContaining("Use a friendly, collaborative communication style."),
    });
    expect(side.prompts.filter((message) => message.shouldQuery === false).map((message) =>
      JSON.stringify(message.message.content))).toEqual([
      expect.stringContaining("ccodex_side_parent_snapshot"),
      expect.stringContaining("canonical side boundary"),
    ]);
    expect(side.prompts.filter((message) => message.shouldQuery !== false).map((message) =>
      JSON.stringify(message.message.content))).toEqual([
      expect.stringContaining("answer independently"),
      expect.stringContaining("continue the same side conversation"),
    ]);
    expect(service.readThread(source.thread.id, true).thread.status.type).toBe("active");
    const childrenWhileActive = service.listThreads({ limit: 10, parentThreadId: source.thread.id });
    expect(childrenWhileActive).toHaveLength(1);
    expect(childrenWhileActive[0]).toMatchObject({
      parentThreadId: source.thread.id, threadSource: "subagent", status: { type: "active", activeFlags: [] },
    });

    await service.updateThreadSettings({
      threadId: source.thread.id,
      model: "claude:claude-opus-4-8",
      serviceTier: "fast",
      effort: "low",
      approvalPolicy: "never",
      permissions: ":danger-full-access",
    });
    expect(service.currentThreadSettings(source.thread.id)).toMatchObject({
      model: "claude:claude-opus-4-8",
      serviceTier: "fast",
      effort: "low",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    const resumedParent = await service.resumeThread({
      threadId: source.thread.id,
      initialTurnsPage: { limit: 10, sortDirection: "desc", itemsView: "full" },
    });
    expect(resumedParent.thread.status).toEqual({ type: "active", activeFlags: [] });
    expect(resumedParent.initialTurnsPage?.data).toEqual([
      expect.objectContaining({ id: preparedParent.response.turn.id, status: "inProgress" }),
    ]);

    await service.releaseEphemeralThread(fork.thread.id);
    expect(() => service.readThread(fork.thread.id, true)).toThrow(`Unknown Claude thread '${fork.thread.id}'.`);

    releaseParent();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(source.thread.id, true).thread.status.type === "idle" ? resolve() : setTimeout(poll, 5);
      poll();
    });
    await activeInjection;

    const parentTurn = service.readThread(source.thread.id, true).thread.turns[0]!;
    expect(parentTurn).toMatchObject({
      id: preparedParent.response.turn.id,
      status: "completed",
      items: expect.arrayContaining([
        expect.objectContaining({
          type: "commandExecution", id: backgroundToolId, status: "completed",
          aggregatedOutput: "FLOW_A_BACKGROUND_OK\n",
        }),
        expect.objectContaining({
          type: "collabAgentToolCall", status: "completed",
          receiverThreadIds: [childrenWhileActive[0]!.id],
        }),
      ]),
    });
    expect(service.eventsAfter(source.thread.id, 0).filter((event) =>
      event.method === "turn/completed"
      && (event.params as { turn: { id: string } }).turn.id === preparedParent.response.turn.id)).toHaveLength(1);
    const child = await service.resumeThread({
      threadId: childrenWhileActive[0]!.id,
      initialTurnsPage: { limit: 10, sortDirection: "desc", itemsView: "full" },
    });
    expect(child.initialTurnsPage?.data[0]).toMatchObject({
      status: "completed",
      items: expect.arrayContaining([
        expect.objectContaining({ type: "agentMessage", text: "FLOW_A_CHILD_OK" }),
      ]),
    });

    const next = await service.prepareTurn({
      threadId: source.thread.id,
      input: [{ type: "text", text: "use deferred Flow A settings", text_elements: [] }],
    });
    const applied = [...parent.inputs, ...initialSide.inputs, ...side.inputs]
      .find((input) => input.options.model === "claude-opus-4-8");
    expect(applied?.options).toMatchObject({
      model: "claude-opus-4-8",
      effort: "low",
      settings: { fastMode: true },
      permissionMode: "bypassPermissions",
    });
    next.announce();
    next.start();
    await waitFor(
      () => service.readThread(source.thread.id, true).thread.turns.at(-1)?.status === "completed",
      "post-Flow-A settings turn completion",
    );
    const finalEvents = service.eventsAfter(source.thread.id, 0);
    expect(finalEvents.filter((event) => event.method === "turn/completed")).toHaveLength(2);
    expect(finalEvents.some((event) => event.method === "error")).toBe(false);
    expect(service.readThread(source.thread.id, true).thread.status).toEqual({ type: "idle" });
    await service.close();
  });

  it("publishes captured background Bash as running when task_started confirms execution", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-background-start-"));
    directories.push(directory);
    const outputFile = join(directory, "background.output");
    writeFileSync(outputFile, "");
    const toolId = "background-tool";
    const taskId = "b1amvs9ok";
    let release!: () => void;
    const delay = new Promise<void>((resolve) => { release = resolve; });
    const base = { parent_tool_use_id: null, session_id: "background-session" };
    const messages = [
      { type: "stream_event", event: { type: "message_start", message: {} }, uuid: randomUUID(), ...base },
      {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: {
          type: "content_block_start", index: 0,
          content_block: {
            type: "tool_use", id: toolId, name: "Bash",
            input: { command: "sleep 30; echo BACKGROUND_DONE", run_in_background: true },
          },
        },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 }, uuid: randomUUID(), ...base },
      {
        type: "user", uuid: randomUUID(), ...base,
        message: {
          role: "user",
          content: [{
            type: "tool_result", tool_use_id: toolId,
            content: `Command running in background with ID: ${taskId}. Output is being written to: ${outputFile}.`,
          }],
        },
        tool_use_result: { stdout: "", stderr: "", backgroundTaskId: taskId },
      },
      {
        type: "system", subtype: "background_tasks_changed",
        tasks: [{ task_id: taskId, task_type: "bash", description: "sleep 30" }],
        uuid: randomUUID(), session_id: base.session_id,
      },
      {
        type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolId,
        task_type: "bash", description: "sleep 30", uuid: randomUUID(), session_id: base.session_id,
      },
      { type: "stream_event", event: { type: "message_start", message: {} }, uuid: randomUUID(), ...base },
      {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      },
      {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Background command started." } },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 1 }, uuid: randomUUID(), ...base },
      {
        type: "assistant", uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "text", text: "Background command started." }] },
      },
      {
        type: "system", subtype: "task_progress", task_id: taskId, description: "sleeping",
        usage: { duration_ms: 30_000 }, uuid: randomUUID(), session_id: base.session_id,
      },
      {
        type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: toolId,
        status: "completed", output_file: outputFile, summary: "completed (exit code 0)",
        usage: { total_tokens: 0, tool_uses: 1, duration_ms: 30_000 },
        uuid: randomUUID(), session_id: base.session_id,
      },
    ] as unknown as SDKMessage[];
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined, messages,
      { afterIndex: 10, wait: delay },
    );
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "run background", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(
      () => service.eventsAfter(started.thread.id, 0).some((event) =>
        event.method === "item/agentMessage/delta"
        && (event.params as { delta?: string }).delta === "Background command started."),
      "background commentary after task start",
    );
    const beforeCompletion = service.eventsAfter(started.thread.id, 0);
    const commandStarted = beforeCompletion.filter((event) =>
      event.method === "item/started"
      && (event.params as { item?: { id?: string } }).item?.id === toolId);
    expect(commandStarted).toHaveLength(1);
    expect(commandStarted[0]?.params).toMatchObject({
      item: {
        type: "commandExecution", id: toolId, command: "sleep 30; echo BACKGROUND_DONE",
        status: "inProgress", processId: taskId,
      },
    });
    expect(beforeCompletion.indexOf(commandStarted[0]!)).toBeLessThan(beforeCompletion.findIndex((event) =>
      event.method === "item/agentMessage/delta"
      && (event.params as { delta?: string }).delta === "Background command started."));
    expect(beforeCompletion.some((event) =>
      event.method === "item/completed"
      && (event.params as { item?: { id?: string } }).item?.id === toolId)).toBe(false);

    writeFileSync(outputFile, "BACKGROUND_DONE\n");
    release();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "background turn completion",
    );
    const events = service.eventsAfter(started.thread.id, 0);
    expect(events.filter((event) =>
      event.method === "item/started"
      && (event.params as { item?: { id?: string } }).item?.id === toolId)).toHaveLength(1);
    expect(events.filter((event) =>
      event.method === "item/completed"
      && (event.params as { item?: { id?: string } }).item?.id === toolId)).toHaveLength(1);
    expect(events.filter((event) =>
      event.method === "item/commandExecution/outputDelta"
      && (event.params as { itemId?: string }).itemId === toolId)).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ itemId: toolId, delta: "BACKGROUND_DONE\n" }) }),
    ]);
    await service.close();
  });

  it("classifies /side from the durable in-progress lifecycle even when the Query has no active response", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-background-side-"));
    directories.push(directory);
    const sideQuery = new FakeClaudeQuery();
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), store,
      sideQuery.factory,
    );
    const source = await service.startThread({ model: "claude:haiku", cwd: directory });
    const activeTurn: Turn = {
      id: "background-visible-turn",
      items: [{
        type: "commandExecution",
        id: "live-provider-task-secret",
        command: "sleep 60; echo done",
        cwd: directory,
        processId: null,
        source: "agent",
        status: "inProgress",
        commandActions: [{ type: "unknown", command: "sleep 60; echo done" }],
        aggregatedOutput: "provider-owned-live-output-secret",
        exitCode: null,
        durationMs: null,
      }],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    };
    store.createTurn(source.thread.id, activeTurn);
    const sourceRecord = store.getThreadRecord(source.thread.id, false)!;
    store.updateThread({ ...sourceRecord, thread: { ...sourceRecord.thread, status: { type: "active", activeFlags: [] } } });

    const fork = await service.forkThread({
      threadId: source.thread.id,
      threadSource: "user",
      ephemeral: true,
      excludeTurns: true,
    });
    expect(fork.thread).toMatchObject({ ephemeral: true, status: { type: "idle" }, turns: [] });
    await waitFor(() => sideQuery.prompts.length > 0, "background-side reference injection");
    const reference = JSON.stringify(sideQuery.prompts[0]);
    expect(reference).toContain("sleep 60; echo done");
    expect(reference).not.toContain("live-provider-task-secret");
    expect(reference).not.toContain("provider-owned-live-output-secret");
    expect(service.readThread(source.thread.id, true).thread.turns[0]).toEqual(activeTurn);

    await service.releaseEphemeralThread(fork.thread.id);
    store.updateTurn(source.thread.id, { ...activeTurn, status: "completed", completedAt: 2, durationMs: 1_000 });
    await service.close();
  });

  it("preserves source turn and item ids in a visible fork", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-visible-fork-"));
    directories.push(directory);
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      store, new FakeClaudeQuery().factory,
    );
    const source = await service.startThread({ model: "claude:haiku", cwd: directory });
    store.createTurn(source.thread.id, {
      id: "source-turn",
      items: [{ type: "agentMessage", id: "source-item", text: "hello", phase: null, memoryCitation: null }],
      itemsView: "full", status: "completed", error: null,
      startedAt: 11, completedAt: 12, durationMs: 1000,
    });
    const sourceTurn = service.readThread(source.thread.id, true).thread.turns[0]!;
    const fork = await service.forkThread({ threadId: source.thread.id, lastTurnId: sourceTurn.id });

    expect(fork.thread.turns[0]?.id).toBe(sourceTurn.id);
    expect(fork.thread.turns[0]?.items.map((item) => item.id)).toEqual(sourceTurn.items.map((item) => item.id));
    await service.close();
  });

  it("keeps source children navigable while a visible fork retains only their inert projection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-fork-child-ownership-"));
    directories.push(directory);
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      store, new FakeClaudeQuery().factory,
    );
    const source = await service.startThread({ model: "claude:haiku", cwd: directory });
    const childId = "source-owned-child";
    const child = store.getThreadRecord(source.thread.id, false)!;
    store.createThread({
      ...child,
      thread: {
        ...child.thread, id: childId, parentThreadId: source.thread.id,
        threadSource: "subagent", turns: [],
      },
    });
    (service as unknown as { sessions: { registerChild(childId: string, ownerId: string): void } })
      .sessions.registerChild(childId, source.thread.id);
    store.createTurn(childId, {
      id: "child-turn", items: [{
        type: "agentMessage", id: "child-answer", text: "source child result",
        phase: "final_answer", memoryCitation: null,
      }],
      itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    });
    store.createTurn(source.thread.id, {
      id: "source-turn",
      items: [{
        type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", status: "completed",
        senderThreadId: source.thread.id, receiverThreadIds: [childId], prompt: "inspect",
        model: null, reasoningEffort: null,
        agentsStates: { [childId]: { status: "completed", message: "done" } },
      }, {
        type: "subAgentActivity", id: "activity", kind: "started",
        agentThreadId: childId, agentPath: "child",
      }],
      itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    });

    const fork = await service.forkThread({ threadId: source.thread.id });
    const projection = fork.thread.turns[0]!.items.find((item) => item.type === "collabAgentToolCall");
    expect(projection).toMatchObject({
      id: "spawn", status: "completed", senderThreadId: fork.thread.id,
      receiverThreadIds: [], agentsStates: {},
    });
    expect(fork.thread.turns[0]!.items.some((item) => item.type === "subAgentActivity")).toBe(false);
    expect(service.readThread(source.thread.id, true).thread.turns[0]!.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ receiverThreadIds: [childId] })]),
    );
    expect((await service.resumeThread(childId)).thread.id).toBe(childId);
    expect(service.listThreads({ limit: 100, parentThreadId: fork.thread.id })).toEqual([]);
    await service.close();
  });

  it("rollback deletes only child projections owned by removed turns", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-rollback-child-ownership-"));
    directories.push(directory);
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const hub = new SubscriptionHub();
    const deleted: string[] = [];
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), store, new FakeClaudeQuery().factory,
    );
    const source = await service.startThread({ model: "claude:haiku", cwd: directory });
    const sourceRecord = store.getThreadRecord(source.thread.id, false)!;
    const collab = (turnId: string, childId: string): Turn => ({
      id: turnId,
      items: [{
        type: "collabAgentToolCall", id: `spawn-${childId}`, tool: "spawnAgent", status: "completed",
        senderThreadId: source.thread.id, receiverThreadIds: [childId], prompt: childId,
        model: null, reasoningEffort: null,
        agentsStates: { [childId]: { status: "completed", message: "done" } },
      }],
      itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    });
    for (const [turnId, childId] of [["retained-turn", "retained-child"], ["removed-turn", "removed-child"]]) {
      store.createTurn(source.thread.id, collab(turnId!, childId!));
      store.createThread({
        ...sourceRecord,
        thread: {
          ...sourceRecord.thread, id: childId!, parentThreadId: source.thread.id,
          threadSource: "subagent", turns: [],
        },
      });
      (service as unknown as { sessions: { registerChild(childId: string, ownerId: string): void } })
        .sessions.registerChild(childId!, source.thread.id);
      store.createTurn(childId!, {
        id: `${childId}-turn`, items: [], itemsView: "full", status: "completed", error: null,
        startedAt: 1, completedAt: 2, durationMs: 1_000,
      });
    }
    store.createThread({
      ...sourceRecord,
      thread: {
        ...sourceRecord.thread, id: "removed-grandchild", parentThreadId: "removed-child",
        threadSource: "subagent", turns: [],
      },
    });
    store.createTurn("removed-grandchild", {
      id: "removed-grandchild-turn", items: [], itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    });
    (service as unknown as { sessions: { registerChild(childId: string, ownerId: string): void } })
      .sessions.registerChild("removed-grandchild", source.thread.id);
    hub.subscribe("removed-child", "rollback-test", (method) => {
      if (method === "thread/deleted") deleted.push("removed-child");
    });

    const rolledBack = await service.rollbackThread({ threadId: source.thread.id, numTurns: 1 });
    expect(rolledBack.thread.turns.map((turn) => turn.id)).toEqual(["retained-turn"]);
    expect(service.readThread("retained-child", true).thread.turns).toHaveLength(1);
    expect(() => service.readThread("removed-child", true)).toThrow("Unknown Claude thread");
    expect(() => service.readThread("removed-grandchild", true)).toThrow("Unknown Claude thread");
    expect(service.listThreads({ limit: 100, parentThreadId: source.thread.id }).map((thread) => thread.id))
      .toEqual(["retained-child"]);
    expect(deleted).toEqual(["removed-child"]);
    await service.close();
  });

  it("creates a silent ephemeral compact handoff and removes it after completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-compact-handoff-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const events: string[] = [];
    hub.attach("observer", (method) => events.push(method));
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), new FakeClaudeQuery().factory,
    );
    const source = await service.startThread({ model: "claude:haiku", cwd: directory });

    expect(await service.summarizeHandoff(source.thread.id, "summarize this transcript")).toBe("OK");
    expect(service.listThreads({ limit: 100 }).map((thread) => thread.id)).toEqual([source.thread.id]);
    expect(service.loadedThreadIds()).toEqual([]);
    expect(events).toEqual([]);
    await service.close();
  });

  it("does not persist ephemeral threads across a service restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-ephemeral-restart-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const first = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    const started = await first.startThread({ model: "claude:haiku", cwd: directory, ephemeral: true });
    expect(first.ownsThread(started.thread.id)).toBe(true);
    const durable = new SqliteHybridStore(database);
    expect(durable.hasThread(started.thread.id)).toBe(false);
    durable.close();
    await first.close();

    const second = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    expect(second.ownsThread(started.thread.id)).toBe(false);
    await second.close();
  });

  it("projects an inline review as entered/result/exited lifecycle items under read-only policy", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-review-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery({
      name: "Write", input: { file_path: join(directory, "review-mutation.txt"), content: "blocked" },
    });
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:haiku", cwd: directory, approvalPolicy: "never", sandbox: "danger-full-access",
    });
    const events: string[] = [];
    hub.subscribe(started.thread.id, "test", (method) => events.push(method));
    await expect(service.prepareReview({
      threadId: started.thread.id, target: { type: "baseBranch", branch: "   " }, delivery: "detached",
    })).rejects.toThrow("branch must not be empty");
    await expect(service.prepareReview({
      threadId: started.thread.id, target: { type: "custom", instructions: "\n" }, delivery: "inline",
    })).rejects.toThrow("instructions must not be empty");
    expect(service.readThread(started.thread.id, true).thread.turns).toEqual([]);
    expect(service.listThreads({ archived: false, limit: 100, sortKey: "created_at" })).toHaveLength(1);
    const prepared = await service.prepareReview({
      threadId: started.thread.id,
      target: { type: "custom", instructions: "  Review this fixture.  " },
      delivery: "inline",
    });
    expect(prepared.response.turn).toMatchObject({
      itemsView: "notLoaded",
      items: [
        { type: "userMessage", id: prepared.response.turn.id, content: [
          { type: "text", text: "Review this fixture." },
        ] },
      ],
      startedAt: null,
      completedAt: null,
      durationMs: null,
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => events.includes("turn/completed") ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(service.readThread(started.thread.id, true).thread.turns.at(-1)?.items).toMatchObject([
      { type: "enteredReviewMode", review: "Review this fixture." },
      { type: "userMessage" },
      { type: "agentMessage", text: "OK" },
      { type: "exitedReviewMode", review: "OK" },
    ]);
    expect(fake.permissionResults).toEqual([{
      behavior: "deny",
      message: expect.stringContaining("read-only"),
    }]);
    expect(service.readThread(started.thread.id, false).thread.status).toEqual({ type: "idle" });
    expect((service as unknown as { store: HybridStore }).store.getThreadRecord(started.thread.id, false))
      .toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
    await service.close();
  });

  it("discards a detached review fork when runtime preparation fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-detached-review-failure-"));
    directories.push(directory);
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      (() => { throw new Error("review runtime failed"); }) as never,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    await expect(service.prepareReview({
      threadId: started.thread.id,
      target: { type: "uncommittedChanges" },
      delivery: "detached",
    })).rejects.toThrow("review runtime failed");
    expect(service.listThreads({ archived: false, limit: 100, sortKey: "created_at" }))
      .toMatchObject([{ id: started.thread.id }]);
    await service.close();
  });

  it("recovers a hard-crashed review through the session and exits review mode before terminal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-review-crash-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const seed = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    const started = await seed.startThread({ model: "claude:haiku", cwd: directory });
    await seed.close();
    const store = new SqliteHybridStore(database);
    const record = store.getThreadRecord(started.thread.id, false)!;
    store.createTurn(started.thread.id, {
      id: "crashed-review",
      items: [
        { type: "enteredReviewMode", id: "entered", review: "current changes" },
        {
          type: "userMessage", id: "crashed-review", clientId: null,
          content: [{ type: "text", text: "current changes", text_elements: [] }],
        },
        {
          type: "agentMessage", id: "partial", text: "P1 partial finding",
          phase: "commentary", memoryCitation: null,
        },
      ],
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
    expect(turn.items.at(-1)).toMatchObject({
      type: "exitedReviewMode", review: "P1 partial finding",
    });
    const lifecycle = recovered.eventsAfter(started.thread.id, 0)
      .filter((event) => event.turnId === turn.id)
      .map((event) => event.method);
    expect(lifecycle).toEqual([
      "item/started", "item/completed", "turn/completed",
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

  it("projects verified hook snapshots into fileChange and turn diff events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-file-change-"));
    directories.push(directory);
    const path = join(directory, "edited.txt");
    writeFileSync(path, "before\n");
    const hub = new SubscriptionHub();
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const fake = new FakeClaudeQuery(undefined, {
      name: "Edit", input: { file_path: path }, execute: () => writeFileSync(path, "after\n"),
    });
    const service = new ClaudeService(config(directory), hub, new Logger("error"), store, fake.factory);
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "edit", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => events.some((event) => event.method === "turn/completed") ? resolve() : setTimeout(poll, 5);
      poll();
    });
    const fileChange = service.readThread(started.thread.id, true).thread.turns[0]?.items.find((item) => item.type === "fileChange");
    expect(fileChange).toMatchObject({ type: "fileChange", status: "completed", changes: [{ path, kind: { type: "update" } }] });
    expect(events.filter((event) => event.method === "item/fileChange/patchUpdated")).toHaveLength(1);
    expect(events.find((event) => event.method === "turn/diff/updated")?.params).toMatchObject({ diff: expect.stringContaining("+after") });
    await service.close();
  });

  it("keeps background continuation and its final answer in the originating logical turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-background-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const base = { session_id: "session" };
    const messages = [
      { type: "command_lifecycle", command_uuid: randomUUID(), state: "queued", uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_started", task_id: "task-1", description: "Inspect code", subagent_type: "Explore", uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_progress", task_id: "task-1", description: "Reading files", subagent_type: "Explore", usage: { total_tokens: 10, tool_uses: 1, duration_ms: 20 }, uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_updated", task_id: "task-1", patch: { status: "running" }, uuid: randomUUID(), ...base },
      { type: "system", subtype: "background_tasks_changed", tasks: [], uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_notification", task_id: "task-1", status: "completed", output_file: "/tmp/task", summary: "Found it", uuid: randomUUID(), ...base },
      { type: "command_lifecycle", command_uuid: randomUUID(), state: "completed", uuid: randomUUID(), ...base },
    ] as unknown as SDKMessage[];
    const result = {
      type: "result", subtype: "success", duration_ms: 15, duration_api_ms: 12, is_error: false,
      num_turns: 1, result: "OK", stop_reason: "end_turn", total_cost_usd: 0,
      usage: { input_tokens: 4, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {}, permission_denials: [], uuid: randomUUID(), ...base,
      origin: { kind: "task-notification" },
    } as unknown as SDKMessage;
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, result, undefined, messages);
    const service = new ClaudeService(config(directory), hub, new Logger("error"), store, fake.factory);
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: string[] = [];
    hub.subscribe(started.thread.id, "test", (method) => events.push(method));
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "start background work", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => {
        const turns = service.readThread(started.thread.id, true).thread.turns;
        turns.length === 1 && turns[0]?.status === "completed" ? resolve() : setTimeout(poll, 5);
      };
      poll();
    });
    const turns = service.readThread(started.thread.id, true).thread.turns;
    expect(turns[0]?.status).toBe("completed");
    const task = turns[0]?.items.find((item) => item.type === "collabAgentToolCall");
    expect(task).toMatchObject({ type: "collabAgentToolCall", status: "completed" });
    const childThreadId = task?.type === "collabAgentToolCall" ? task.receiverThreadIds[0] : undefined;
    expect(childThreadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(childThreadId).not.toBe("task-1");
    expect(task?.type === "collabAgentToolCall" ? task.agentsStates[childThreadId!] : undefined).toEqual({
      status: "completed", message: "Found it",
    });
    expect(service.readThread(childThreadId!, true).thread.turns[0]).toMatchObject({ status: "completed" });
    expect(turns[0]?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agentMessage", text: "OK", phase: "final_answer" }),
    ]));
    expect(turns.flatMap((turn) => turn.items).filter((item) => "status" in item).every((item) => item.status !== "inProgress")).toBe(true);
    expect(events.filter((method) => method === "turn/started")).toHaveLength(1);
    expect(events.filter((method) => method === "turn/completed")).toHaveLength(1);
    await service.close();
  });

  it("reports an explicitly selected Sonnet child instead of the Fable parent model", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-child-model-"));
    directories.push(directory);
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const base = { session_id: "fable-parent-session" };
    const agentTool = "sonnet-agent-tool";
    const agentTask = "sonnet-agent-task";
    const messages = [
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: {
          type: "content_block_start", index: 0,
          content_block: {
            type: "tool_use", id: agentTool, name: "Agent",
            input: { description: "Use Sonnet", prompt: "Inspect the project", model: "sonnet" },
          },
        },
      },
      {
        type: "system", subtype: "task_started", task_id: agentTask, tool_use_id: agentTool,
        task_type: "agent", subagent_type: "general-purpose", description: "Use Sonnet",
        uuid: randomUUID(), ...base,
      },
      {
        type: "user", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: agentTool, content: "Async agent launched successfully." }],
        },
        tool_use_result: {
          isAsync: true, status: "async_launched", agentId: agentTask,
          resolvedModel: "claude-sonnet-5", outputFile: "/tmp/sonnet-agent.output",
        },
      },
      {
        type: "assistant", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        message: {
          role: "assistant", model: "claude-sonnet-5",
          content: [{ type: "text", text: "Sonnet child answer." }],
        },
      },
      {
        type: "system", subtype: "task_notification", task_id: agentTask, tool_use_id: agentTool,
        status: "completed", output_file: "/tmp/sonnet-agent.output", summary: "Sonnet child answer.",
        uuid: randomUUID(), ...base,
      },
    ] as unknown as SDKMessage[];
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), store,
      new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, messages).factory,
    );
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "Spawn Sonnet", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "Fable parent with Sonnet child",
    );

    const parentCall = service.readThread(started.thread.id, true).thread.turns[0]?.items
      .find((item) => item.type === "collabAgentToolCall");
    expect(parentCall).toMatchObject({
      type: "collabAgentToolCall", model: "claude-sonnet-5", status: "completed",
    });
    const childThreadId = parentCall?.type === "collabAgentToolCall"
      ? parentCall.receiverThreadIds[0]! : "";
    expect(store.getThreadRecord(childThreadId)).toMatchObject({
      modelPickerId: "claude:sonnet",
      claudeModelValue: "sonnet",
      resolvedModel: "claude-sonnet-5",
    });
    await expect(service.resumeThread({ threadId: childThreadId })).resolves.toMatchObject({
      model: "claude:sonnet",
      thread: { id: childThreadId, parentThreadId: started.thread.id },
    });
    await service.close();
  });

  it("projects Claude subagent retry progress without creating another item", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-subagent-retry-"));
    directories.push(directory);
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const base = { session_id: "session", parent_tool_use_id: null };
    const messages = [
      {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: {
          type: "content_block_start", index: 0,
          content_block: { type: "tool_use", id: "agent-tool", name: "Agent", input: { prompt: "inspect" } },
        },
      },
      {
        type: "system", subtype: "task_started", task_id: "agent-task", tool_use_id: "agent-tool",
        task_type: "agent", subagent_type: "Explore", description: "Inspect", uuid: randomUUID(), ...base,
      },
      {
        type: "tool_progress", tool_use_id: "agent-tool", tool_name: "Agent",
        elapsed_time_seconds: 5, heartbeat: true, subagent_type: "Explore",
        subagent_retry: {
          agent_id: "agent-task", attempt: 2, max_retries: 3, retry_delay_ms: 1_500,
          error_status: 503, error_category: "overloaded",
        },
        uuid: randomUUID(), ...base,
      },
      {
        type: "system", subtype: "task_notification", task_id: "agent-task", tool_use_id: "agent-tool",
        status: "completed", output_file: "/tmp/agent-task", summary: "Done", uuid: randomUUID(), ...base,
      },
    ] as unknown as SDKMessage[];
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined, messages,
      { afterIndex: 2, wait: pause },
    );
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "retry a child", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(() => {
      const item = service.readThread(started.thread.id, true).thread.turns[0]?.items
        .find((candidate) => candidate.type === "collabAgentToolCall");
      if (item?.type !== "collabAgentToolCall") return false;
      const child = item.receiverThreadIds[0];
      return child ? item.agentsStates[child]?.message === "Retrying Explore (2/3) in 1.5s" : false;
    }, "subagent retry projection");
    expect(service.readThread(started.thread.id, true).thread.turns[0]?.items
      .filter((item) => item.type === "collabAgentToolCall")).toHaveLength(1);
    release();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "subagent retry completion",
    );
    await service.close();
  });

  it("settles multiple task notifications represented by one terminal continuation result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-multi-task-continuation-"));
    directories.push(directory);
    const base = { session_id: "session" };
    const result = (origin: { kind: string } | undefined) => ({
      type: "result", subtype: "success", duration_ms: 15, duration_api_ms: 12, is_error: false,
      num_turns: 1, result: "OK", stop_reason: "end_turn", total_cost_usd: 0,
      usage: { input_tokens: 4, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {}, permission_denials: [], uuid: randomUUID(), ...base, ...(origin ? { origin } : {}),
    }) as unknown as SDKMessage;
    const before = [
      { type: "command_lifecycle", command_uuid: randomUUID(), state: "queued", uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_started", task_id: "task-a", description: "A", subagent_type: "Explore", uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_started", task_id: "task-b", description: "B", subagent_type: "Explore", uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_notification", task_id: "task-a", status: "completed", summary: "A done", uuid: randomUUID(), ...base },
      { type: "command_lifecycle", command_uuid: randomUUID(), state: "completed", uuid: randomUUID(), ...base },
    ] as unknown as SDKMessage[];
    const after = [
      { type: "system", subtype: "task_notification", task_id: "task-b", status: "completed", summary: "B done", uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "assistant", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "text", text: "Both tasks completed." }] },
      },
      result({ kind: "task-notification" }),
    ] as unknown as SDKMessage[];
    const fake = new FakeClaudeQuery(undefined, undefined, after, false, undefined, result(undefined), undefined, before);
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "parallel", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed" ? resolve() : setTimeout(poll, 5);
      poll();
    });
    const turn = service.readThread(started.thread.id, true).thread.turns[0]!;
    expect(turn.items.filter((item) => item.type === "collabAgentToolCall")).toHaveLength(2);
    expect(turn.items.filter((item) => item.type === "agentMessage").at(-1)).toMatchObject({
      text: "Both tasks completed.", phase: "final_answer",
    });
    await service.close();
  });

  it("keeps a background Bash as one command item and streams its output file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-background-bash-"));
    directories.push(directory);
    const outputFile = join(directory, "task.output");
    writeFileSync(outputFile, "TICK 1\nTICK 2\nTICK 3\n");
    const base = { session_id: "session" };
    const toolUseId = "background-bash-tool";
    const taskId = "background-bash-task";
    const taskOutputTool = "background-task-output-tool";
    const messages = [
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolUseId, name: "Bash", input: { command: "tick", run_in_background: true } } },
      },
      {
        type: "user", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: `Command running in background with ID: ${taskId}. Output is being written to: ${outputFile}. You will be notified when it completes.` }] },
        tool_use_result: { stdout: "", stderr: "", backgroundTaskId: taskId },
      },
      { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: taskId, task_type: "bash", description: "tick" }], uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId, task_type: "bash", description: "tick", uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_progress", task_id: taskId, tool_use_id: toolUseId, description: "tick", usage: { total_tokens: 0, tool_uses: 1, duration_ms: 20 }, uuid: randomUUID(), ...base },
      { type: "system", subtype: "background_tasks_changed", tasks: [], uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_updated", task_id: taskId, patch: { status: "completed", end_time: Date.now() }, uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: toolUseId, status: "completed", output_file: outputFile, summary: "Background command completed (exit code 0)", usage: { total_tokens: 0, tool_uses: 1, duration_ms: 30 }, uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: taskOutputTool, name: "TaskOutput", input: {} } },
      },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ task_id: taskId, block: true, timeout: 120_000 }) } },
      },
      {
        type: "assistant", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "tool_use", id: taskOutputTool, name: "TaskOutput", input: { task_id: taskId, block: true, timeout: 120_000 } }] },
      },
      {
        type: "user", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: taskOutputTool, content: `<retrieval_status>success</retrieval_status>\n<task_id>${taskId}</task_id>\n<output>TICK 1\nTICK 2\nTICK 3</output>` }] },
        tool_use_result: { type: "text" },
      },
    ] as unknown as SDKMessage[];
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, messages);
    const hub = new SubscriptionHub();
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(config(directory), hub, new Logger("error"), store, fake.factory);
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "background bash", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed" ? resolve() : setTimeout(poll, 5);
      poll();
    });
    const commands = service.readThread(started.thread.id, true).thread.turns[0]?.items.filter((item) => item.type === "commandExecution") ?? [];
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      id: toolUseId, command: "tick", status: "completed", aggregatedOutput: "TICK 1\nTICK 2\nTICK 3\n", exitCode: 0,
    });
    expect(events.filter((event) => event.method === "item/commandExecution/outputDelta")).toHaveLength(1);
    expect(events.filter((event) => event.method === "item/completed" && (event.params as { item?: { id?: string } }).item?.id === toolUseId)).toHaveLength(1);
    expect(events.some((event) => ["item/started", "item/completed"].includes(event.method)
      && (event.params as { item?: { id?: string } }).item?.id === taskOutputTool)).toBe(false);
    expect(commands.some((item) => item.id === taskOutputTool)).toBe(false);
    expect(service.readThread(started.thread.id, true).thread.turns[0]?.items.some((item) => item.type === "dynamicToolCall")).toBe(false);
    await service.close();
  });

  it("keeps child background output, progress, and auto-denial inside the child thread", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-child-background-"));
    directories.push(directory);
    const outputFile = join(directory, "child-task.output");
    writeFileSync(outputFile, "CHILD TICK 1\nCHILD TICK 2\n");
    const base = { session_id: "session" };
    const agentTool = "agent-tool-background";
    const agentTask = "agent-task-background";
    const bashTool = "child-background-bash";
    const bashTask = "child-background-task";
    const taskOutputTool = "child-task-output";
    const deniedTool = "child-denied-bash";
    const messages = [
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: agentTool, name: "Agent", input: { prompt: "Run child work" } } },
      },
      { type: "system", subtype: "task_started", task_id: agentTask, tool_use_id: agentTool, task_type: "agent", subagent_type: "Explore", description: "Run child work", uuid: randomUUID(), ...base },
      {
        type: "assistant", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "tool_use", id: bashTool, name: "Bash", input: { command: "child ticks", run_in_background: true } }] },
      },
      {
        type: "user", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: bashTool, content: `Command running in background with ID: ${bashTask}. Output is being written to: ${outputFile}. You will be notified when it completes.` }] },
        tool_use_result: { stdout: "", stderr: "", backgroundTaskId: bashTask },
      },
      { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: bashTask, task_type: "bash", description: "child ticks" }], uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_started", task_id: bashTask, tool_use_id: bashTool, task_type: "bash", description: "child ticks", uuid: randomUUID(), ...base },
      { type: "tool_progress", tool_use_id: bashTool, tool_name: "Bash", parent_tool_use_id: agentTool, task_id: bashTask, elapsed_time_seconds: 1.5, uuid: randomUUID(), ...base },
      { type: "system", subtype: "background_tasks_changed", tasks: [], uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_notification", task_id: bashTask, tool_use_id: bashTool, status: "completed", output_file: outputFile, summary: "Background command completed (exit code 0)", usage: { total_tokens: 0, tool_uses: 1, duration_ms: 1_600 }, uuid: randomUUID(), ...base },
      {
        type: "assistant", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "tool_use", id: taskOutputTool, name: "TaskOutput", input: { task_id: bashTask, block: true, timeout: 120_000 } }] },
      },
      {
        type: "user", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: taskOutputTool, content: "<retrieval_status>success</retrieval_status>" }] },
        tool_use_result: { type: "text" },
      },
      {
        type: "assistant", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "tool_use", id: deniedTool, name: "Bash", input: { command: "curl example.com" } }] },
      },
      { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: deniedTool, agent_id: agentTask, message: "Policy denied it", uuid: randomUUID(), ...base },
      { type: "tool_use_summary", summary: "Child denial was handled.", preceding_tool_use_ids: [deniedTool], uuid: randomUUID(), ...base },
      { type: "system", subtype: "informational", content: "Child tool notice.", level: "notice", tool_use_id: deniedTool, uuid: randomUUID(), ...base },
      {
        type: "assistant", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "text", text: "Child work finished." }] },
      },
      { type: "system", subtype: "task_notification", task_id: agentTask, tool_use_id: agentTool, status: "completed", output_file: join(directory, "unused"), summary: "Child completed", uuid: randomUUID(), ...base },
    ] as unknown as SDKMessage[];
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, messages).factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "child background", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed" ? resolve() : setTimeout(poll, 5);
      poll();
    });
    const parentCall = service.readThread(started.thread.id, true).thread.turns[0]!.items
      .find((item) => item.type === "collabAgentToolCall");
    const childThreadId = parentCall?.type === "collabAgentToolCall" ? parentCall.receiverThreadIds[0]! : "";
    const childTurn = service.readThread(childThreadId, true).thread.turns[0]!;
    expect(childTurn.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "commandExecution", id: bashTool, status: "completed", exitCode: 0,
        aggregatedOutput: "CHILD TICK 1\nCHILD TICK 2\n",
      }),
      expect.objectContaining({ type: "commandExecution", id: deniedTool, status: "failed" }),
      expect.objectContaining({ type: "agentMessage", text: "◆ **CCodex** │ ⚠️ Bash was denied: Policy denied it" }),
      expect.objectContaining({ type: "agentMessage", text: "◆ **CCodex** │ Child denial was handled." }),
      expect.objectContaining({ type: "agentMessage", text: "◆ **CCodex** │ Child tool notice." }),
      expect.objectContaining({ type: "agentMessage", text: "Child work finished.", phase: "final_answer" }),
    ]));
    const childEvents = service.eventsAfter(childThreadId, 0);
    expect(childEvents.filter((event) => event.method === "item/commandExecution/outputDelta" && (event.params as { itemId?: string }).itemId === bashTool)).toHaveLength(1);
    expect(childEvents.filter((event) => event.method === "item/completed" && (event.params as { item?: { id?: string } }).item?.id === deniedTool)).toHaveLength(1);
    expect(childTurn.items.some((item) => item.id === taskOutputTool)).toBe(false);
    expect(childEvents.some((event) => ["item/started", "item/completed"].includes(event.method)
      && (event.params as { item?: { id?: string } }).item?.id === taskOutputTool)).toBe(false);
    const root = JSON.stringify(service.readThread(started.thread.id, true).thread.turns[0]!.items);
    expect(root).not.toContain("Child tool notice");
    expect(root).not.toContain(bashTool);
    expect(root).not.toContain(bashTask);
    await expect(service.listBackgroundTerminals({ threadId: started.thread.id }))
      .resolves.toMatchObject({ data: [] });
    expect(service.readThread(started.thread.id, true).thread.status).toEqual({ type: "idle" });
    expect(service.readThread(childThreadId, true).thread.status).toEqual({ type: "idle" });
    await service.close();
  });

  it("suppresses streamed and canonical goal MCP plumbing inside a child thread", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-child-goal-mcp-"));
    directories.push(directory);
    const base = { session_id: "child-goal-session" };
    const agentTool = "goal-agent";
    const taskId = "goal-agent-task";
    const goalTool = "child-goal-tool";
    const goalName = "mcp__ccodex_goal__get_goal";
    const messages = [
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: agentTool, name: "Agent", input: { prompt: "Inspect goal" } } },
      },
      {
        type: "system", subtype: "task_started", task_id: taskId, tool_use_id: agentTool,
        task_type: "agent", subagent_type: "Explore", description: "Inspect goal", prompt: "Inspect goal", uuid: randomUUID(), ...base,
      },
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: agentTool, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "mcp_tool_use", id: goalTool, name: goalName, input: {} } },
      },
      {
        type: "stream_event", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: agentTool, uuid: randomUUID(), ...base },
      {
        type: "assistant", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "mcp_tool_use", id: goalTool, name: goalName, input: {} }] },
      },
      {
        type: "user", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: goalTool, content: "{\"goal\":null}" }] },
      },
      {
        type: "assistant", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "text", text: "Child goal inspection finished." }] },
      },
      {
        type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: agentTool,
        status: "completed", output_file: join(directory, "unused"), summary: "Child completed", uuid: randomUUID(), ...base,
      },
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
    ] as unknown as SDKMessage[];
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, messages).factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "delegate goal inspection", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "child goal MCP lifecycle",
    );

    const parentCall = service.readThread(started.thread.id, true).thread.turns[0]!.items
      .find((item) => item.type === "collabAgentToolCall");
    const childThreadId = parentCall?.type === "collabAgentToolCall" ? parentCall.receiverThreadIds[0]! : "";
    const childTurn = service.readThread(childThreadId, true).thread.turns[0]!;
    expect(childTurn.status).toBe("completed");
    expect(childTurn.items).toContainEqual(expect.objectContaining({
      type: "agentMessage", text: "Child goal inspection finished.", phase: "final_answer",
    }));
    expect(childTurn.items.some((item) => item.id === goalTool || item.type === "dynamicToolCall")).toBe(false);
    expect(JSON.stringify(childTurn.items)).not.toContain(goalName);
    const goalLifecycle = service.eventsAfter(childThreadId, 0).filter((event) => {
      const item = (event.params as { item?: { id?: string } }).item;
      return item?.id === goalTool;
    });
    expect(goalLifecycle).toEqual([]);
    await service.close();
  });

  it("projects a child streamed image Read with the same durable lifecycle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-child-image-view-"));
    directories.push(directory);
    const base = { session_id: "child-image-session" };
    const agentTool = "image-agent";
    const taskId = "image-agent-task";
    const imageId = "child-streamed-image";
    const failedId = "child-failed-image";
    const input = JSON.stringify({ file_path: "plots/child.webp" });
    const failedInput = JSON.stringify({ file_path: "plots/missing.png" });
    const messages = [
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: agentTool, name: "Agent", input: { prompt: "Inspect image" } } },
      },
      {
        type: "system", subtype: "task_started", task_id: taskId, tool_use_id: agentTool,
        task_type: "agent", subagent_type: "Explore", description: "Inspect image", prompt: "Inspect image", uuid: randomUUID(), ...base,
      },
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: agentTool, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: imageId, name: "Read", input: {} } },
      },
      {
        type: "stream_event", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: input.slice(0, 11) } },
      },
      {
        type: "stream_event", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: input.slice(11) } },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: agentTool, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: failedId, name: "Read", input: {} } },
      },
      {
        type: "stream_event", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: failedInput.slice(0, 7) } },
      },
      {
        type: "stream_event", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: failedInput.slice(7) } },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 1 }, parent_tool_use_id: agentTool, uuid: randomUUID(), ...base },
      {
        type: "assistant", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [
          { type: "tool_use", id: imageId, name: "Read", input: { file_path: "plots/child.webp" } },
          { type: "tool_use", id: failedId, name: "Read", input: { file_path: "plots/missing.png" } },
        ] },
      },
      {
        type: "user", parent_tool_use_id: agentTool, uuid: randomUUID(), ...base,
        message: { role: "user", content: [
          { type: "tool_result", tool_use_id: imageId, content: "image bytes" },
          { type: "tool_result", tool_use_id: failedId, content: "ENOENT child image", is_error: true },
        ] },
      },
      {
        type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: agentTool,
        status: "completed", output_file: join(directory, "unused"), summary: "Child completed", uuid: randomUUID(), ...base,
      },
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
    ] as unknown as SDKMessage[];
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, messages).factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "delegate image inspection", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "child image turn completion",
    );

    const parentCall = service.readThread(started.thread.id, true).thread.turns[0]!.items
      .find((item) => item.type === "collabAgentToolCall");
    const childThreadId = parentCall?.type === "collabAgentToolCall" ? parentCall.receiverThreadIds[0]! : "";
    const child = await service.resumeThread({
      threadId: childThreadId,
      initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "full" },
    });
    expect(child.initialTurnsPage?.data[0]?.items.filter((item) => item.id === imageId)).toEqual([{
      type: "imageView", id: imageId, path: join(directory, "plots/child.webp"),
    }]);
    expect(child.initialTurnsPage?.data[0]?.items.filter((item) => item.id === failedId)).toEqual([
      expect.objectContaining({
        type: "commandExecution", id: failedId, command: "Read plots/missing.png", status: "failed",
        aggregatedOutput: "ENOENT child image", exitCode: 1,
        commandActions: [expect.objectContaining({ type: "read", path: join(directory, "plots/missing.png") })],
      }),
    ]);
    const lifecycle = service.eventsAfter(childThreadId, 0).filter((event) =>
      ["item/started", "item/completed"].includes(event.method)
      && (event.params as { item?: { id?: string } }).item?.id === imageId,
    );
    expect(lifecycle.map((event) => event.method)).toEqual(["item/started", "item/completed"]);
    expect(lifecycle.map((event) => (event.params as { item: { type: string } }).item.type)).toEqual(["imageView", "imageView"]);
    const failedLifecycle = service.eventsAfter(childThreadId, 0).filter((event) =>
      ["item/started", "item/commandExecution/outputDelta", "item/completed"].includes(event.method)
      && ((event.params as { item?: { id?: string } }).item?.id === failedId
        || (event.params as { itemId?: string }).itemId === failedId),
    );
    expect(failedLifecycle.map((event) => event.method)).toEqual([
      "item/started", "item/commandExecution/outputDelta", "item/completed",
    ]);
    expect((failedLifecycle[1]?.params as { delta: string }).delta).toBe("ENOENT child image");
    expect(failedLifecycle.some((event) =>
      (event.params as { item?: { type?: string } }).item?.type === "imageView")).toBe(false);
    await service.close();

    const reconnected = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), new FakeClaudeQuery().factory,
    );
    const resumedChild = await reconnected.resumeThread({
      threadId: childThreadId,
      initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "full" },
    });
    expect(resumedChild.initialTurnsPage?.data[0]?.items).toContainEqual(expect.objectContaining({
      type: "commandExecution", id: failedId, status: "failed", aggregatedOutput: "ENOENT child image",
    }));
    expect(resumedChild.initialTurnsPage?.data[0]?.items).toContainEqual({
      type: "imageView", id: imageId, path: join(directory, "plots/child.webp"),
    });
    expect(reconnected.eventsAfter(childThreadId, 0).filter((event) =>
      ["item/started", "item/commandExecution/outputDelta", "item/completed"].includes(event.method)
      && ((event.params as { item?: { id?: string } }).item?.id === failedId
        || (event.params as { itemId?: string }).itemId === failedId),
    )).toHaveLength(3);
    await reconnected.close();
  });

  it("repairs orphaned and cyclic legacy child ownership without bricking startup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-legacy-child-repair-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const first = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    const root = await first.startThread({ model: "claude:haiku", cwd: directory });
    await first.close();

    const legacy = new SqliteHybridStore(database);
    const seed = legacy.getThreadRecord(root.thread.id, false)!;
    const child = (id: string, parentThreadId: string, threadSource = "subagent") => ({
      ...seed,
      claudeSessionId: randomUUID(),
      thread: {
        ...seed.thread,
        id,
        parentThreadId,
        forkedFromId: parentThreadId,
        threadSource,
        turns: [],
      },
    });
    legacy.createThread(child("legacy-valid-child", root.thread.id, "user"));
    legacy.createThread(child("legacy-orphan", "missing-parent"));
    legacy.createThread(child("legacy-cycle-a", "legacy-cycle-b"));
    legacy.createThread(child("legacy-cycle-b", "legacy-cycle-a"));
    legacy.close();

    const repaired = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    await repaired.ready();
    expect(repaired.ownsThread(root.thread.id)).toBe(true);
    expect(repaired.ownsThread("legacy-valid-child")).toBe(true);
    expect(repaired.ownsThread("legacy-orphan")).toBe(false);
    expect(repaired.ownsThread("legacy-cycle-a")).toBe(false);
    expect(repaired.ownsThread("legacy-cycle-b")).toBe(false);
    const registry = (repaired as unknown as {
      sessions: { ownerOf(threadId: string): string; activeOwnerIds(): string[] };
    }).sessions;
    expect(registry.ownerOf("legacy-valid-child")).toBe(root.thread.id);
    expect(registry.activeOwnerIds()).not.toContain("legacy-valid-child");
    await expect(repaired.setThreadName({
      threadId: "legacy-valid-child",
      name: "child title",
    })).resolves.toEqual({});
    expect(repaired.readThread("legacy-valid-child", false).thread.name).toBe("child title");
    expect(repaired.readThread(root.thread.id, false).thread.name).not.toBe("child title");
    await repaired.close();
  });

  it("materializes a Claude subagent as a readable child thread", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-child-thread-"));
    directories.push(directory);
    const base = { session_id: "session" };
    const toolUseId = "agent-tool";
    const taskId = "claude-agent-task";
    const messages = [
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolUseId, name: "Agent", input: { prompt: "Inspect the repo" } } },
      },
      { type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId, task_type: "agent", subagent_type: "Explore", description: "Inspect the repo", prompt: "Inspect the repo", uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "test" } }, parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Inspecting" } }, parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "test-2" } }, parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Checking details" } }, parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base },
      { type: "stream_event", event: { type: "content_block_stop", index: 1 }, parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base },
      {
        type: "assistant", parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [
          { type: "thinking", thinking: "Inspecting", signature: "test" },
          { type: "thinking", thinking: "Checking details", signature: "test-2" },
        ] },
      },
      {
        type: "assistant", parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "tool_use", id: "child-read", name: "Read", input: { file_path: "package.json" } }] },
      },
      {
        type: "user", parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "child-read", content: "ccodex" }] },
        tool_use_result: { type: "text" },
      },
      {
        type: "assistant", parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "tool_use", id: "child-bash", name: "Bash", input: { command: "printf CHILD_OK" } }] },
      },
      {
        type: "user", parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "child-bash", content: "CHILD_OK" }] },
        tool_use_result: { stdout: "CHILD_OK", stderr: "", exit_code: 0 },
      },
      {
        type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base,
      },
      {
        type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base,
      },
      {
        type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The child inspected the repository." } }, parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base,
      },
      {
        type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base,
      },
      {
        type: "assistant", parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "text", text: "The child inspected the repository." }] },
      },
      { type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: toolUseId, status: "completed", output_file: join(directory, "unused"), summary: "Child completed", uuid: randomUUID(), ...base },
    ] as unknown as SDKMessage[];
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, messages);
    const hub = new SubscriptionHub();
    const database = join(directory, "state.sqlite");
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(database), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "spawn child", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed" ? resolve() : setTimeout(poll, 5);
      poll();
    });
    const call = service.readThread(started.thread.id, true).thread.turns[0]?.items.find((item) => item.type === "collabAgentToolCall");
    expect(call).toMatchObject({ type: "collabAgentToolCall", status: "completed" });
    const childThreadId = call?.type === "collabAgentToolCall" ? call.receiverThreadIds[0] : undefined;
    expect(childThreadId).toMatch(/^[0-9a-f-]{36}$/);
    const children = service.listThreads({ limit: 100, parentThreadId: started.thread.id });
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ id: childThreadId, parentThreadId: started.thread.id, threadSource: "subagent", status: { type: "idle" } });
    const child = await service.resumeThread({
      threadId: childThreadId!,
      initialTurnsPage: { limit: 20, sortDirection: "desc", itemsView: "full" },
    });
    expect(child.initialTurnsPage?.data[0]).toMatchObject({
      status: "completed",
      items: expect.arrayContaining([
        expect.objectContaining({ type: "reasoning", summary: ["Inspecting", "Checking details"], content: [] }),
        expect.objectContaining({
          type: "commandExecution", id: "child-read", command: "Read package.json", status: "completed",
          commandActions: [expect.objectContaining({ type: "read", path: join(directory, "package.json") })],
        }),
        expect.objectContaining({ type: "commandExecution", id: "child-bash", command: "printf CHILD_OK", aggregatedOutput: "CHILD_OK", status: "completed" }),
        expect.objectContaining({ type: "agentMessage", text: "The child inspected the repository.", phase: "final_answer" }),
      ]),
    });
    const childEvents = service.eventsAfter(childThreadId!, 0);
    expect(childEvents.filter((event) => event.method === "item/reasoning/summaryTextDelta")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ delta: "Inspecting", summaryIndex: 0 }) }),
      expect.objectContaining({ params: expect.objectContaining({ delta: "Checking details", summaryIndex: 1 }) }),
    ]);
    expect(childEvents.filter((event) => event.method === "item/reasoning/summaryPartAdded")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ summaryIndex: 1 }) }),
    ]);
    expect(childEvents.filter((event) => event.method === "item/agentMessage/delta" && (event.params as { delta?: string }).delta === "The child inspected the repository.")).toHaveLength(1);
    await (await service.prepareGoalSet({
      threadId: started.thread.id,
      objective: "root goal must survive child rejection",
      status: "paused",
    })).notify();
    const rootGoalBefore = await service.getGoal(started.thread.id);
    const rootBeforeChildTurn = service.readThread(started.thread.id, true).thread;
    const rootWatermarkBefore = service.eventHighWatermark(started.thread.id);
    const sessionRegistry = (service as unknown as {
      sessions: { submit(threadId: string, command: unknown): Promise<unknown> };
    }).sessions;
    const childSubmit = vi.spyOn(sessionRegistry, "submit");
    await expect(service.prepareTurn({
      threadId: childThreadId!, input: [{ type: "text", text: "continue", text_elements: [] }],
    })).rejects.toThrow("read-only projection");
    expect(childSubmit).not.toHaveBeenCalled();
    childSubmit.mockRestore();
    expect(await service.getGoal(started.thread.id)).toEqual(rootGoalBefore);
    expect(service.readThread(started.thread.id, true).thread).toEqual(rootBeforeChildTurn);
    expect(service.eventHighWatermark(started.thread.id)).toBe(rootWatermarkBefore);
    const rootBefore = service.readThread(started.thread.id, true).thread;
    await expect(service.setThreadName({ threadId: childThreadId!, name: "child title" }))
      .resolves.toEqual({});
    expect(service.readThread(childThreadId!, false).thread.name).toBe("child title");
    expect(() => service.updateThreadMetadata({ threadId: childThreadId!, gitInfo: null }))
      .toThrow("read-only projection");
    await expect(service.updateThreadSettings({ threadId: childThreadId!, effort: "high" }))
      .rejects.toThrow("read-only projection");
    await expect(service.compactThread(childThreadId!)).rejects.toThrow("read-only projection");
    await expect(service.injectItems({
      threadId: childThreadId!,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "forbidden" }] }],
    })).rejects.toThrow("read-only projection");
    await expect(service.forkThread({ threadId: childThreadId! })).rejects.toThrow("read-only projection");
    await expect(service.handoffSource(childThreadId!)).rejects.toThrow("read-only projection");
    await expect(service.summarizeHandoff(childThreadId!, "forbidden"))
      .rejects.toThrow("read-only projection");
    await expect(service.shellCommand({ threadId: childThreadId!, command: "echo forbidden" }))
      .rejects.toThrow("read-only projection");
    await expect(service.archiveThread(childThreadId!)).rejects.toThrow("read-only projection");
    expect(() => service.unarchiveThread(childThreadId!)).toThrow("read-only projection");
    await expect(service.deleteThread(childThreadId!)).rejects.toThrow("read-only projection");
    await expect(service.releaseEphemeralThread(childThreadId!)).rejects.toThrow("read-only projection");
    await expect(service.rollbackThread({ threadId: childThreadId!, numTurns: 1 }))
      .rejects.toThrow("read-only projection");
    expect(() => service.prepareGoalSet({ threadId: childThreadId!, objective: "forbidden" }))
      .toThrow("read-only projection");
    await expect(service.getGoal(childThreadId!)).resolves.toEqual({ goal: null });
    expect(() => service.prepareGoalClear(childThreadId!)).toThrow("read-only projection");
    await expect(service.prepareStatusTurn({
      threadId: childThreadId!,
      input: [{ type: "text", text: "/status", text_elements: [] }],
    }, async () => "status")).rejects.toThrow("read-only projection");
    await expect(service.announceThread(service.readThread(childThreadId!, false).thread))
      .rejects.toThrow("read-only projection");
    const resumedChild = await service.prepareResume({ threadId: childThreadId!, excludeTurns: false });
    expect(resumedChild.response.thread.id).toBe(childThreadId);
    await resumedChild.notifyGoalSnapshot(() => {
      throw new Error("Projected child resume must not replay the root goal.");
    });
    expect(service.readThread(started.thread.id, true).thread).toEqual(rootBefore);
    const liveRegistry = (service as unknown as {
      sessions: { ownerOf(threadId: string): string; activeOwnerIds(): string[] };
    }).sessions;
    expect(liveRegistry.ownerOf(childThreadId!)).toBe(started.thread.id);
    expect(liveRegistry.activeOwnerIds()).not.toContain(childThreadId);
    await service.close();

    const restarted = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    const restartedRegistry = (restarted as unknown as {
      sessions: { ownerOf(threadId: string): string; activeOwnerIds(): string[] };
    }).sessions;
    expect(restartedRegistry.ownerOf(childThreadId!)).toBe(started.thread.id);
    await restarted.resumeThread(childThreadId!);
    await restarted.interruptTurn({
      threadId: childThreadId!,
      turnId: restarted.readThread(childThreadId!, true).thread.turns[0]!.id,
    });
    expect(restartedRegistry.activeOwnerIds()).not.toContain(childThreadId);
    await restarted.archiveThread(started.thread.id);
    expect(restarted.listThreads({ archived: false, limit: 100 }).map((thread) => thread.id))
      .not.toContain(started.thread.id);
    expect(restarted.listThreads({ archived: false, limit: 100 }).map((thread) => thread.id))
      .not.toContain(childThreadId);
    expect(restarted.listThreads({ archived: true, limit: 100 }).map((thread) => thread.id))
      .toEqual(expect.arrayContaining([started.thread.id, childThreadId!]));
    expect(restarted.readThread(childThreadId!, true).thread.id).toBe(childThreadId);
    await restarted.close();

    const unarchived = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    await unarchived.unarchiveThread(started.thread.id);
    expect(unarchived.listThreads({ archived: false, limit: 100 }).map((thread) => thread.id))
      .toEqual(expect.arrayContaining([started.thread.id, childThreadId!]));
    expect(unarchived.listThreads({ archived: true, limit: 100 }).map((thread) => thread.id))
      .not.toEqual(expect.arrayContaining([started.thread.id, childThreadId!]));
    await unarchived.close();
  });

  it("interrupts only the selected child through Claude stopTask", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-child-only-interrupt-"));
    directories.push(directory);
    const base = { session_id: "session" };
    const toolUseId = "agent-tool-stop";
    const taskId = "agent-task-stop";
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const messages = [
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolUseId, name: "Agent", input: { prompt: "Wait" } } },
      },
      { type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId, task_type: "agent", subagent_type: "Explore", description: "Wait", uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: toolUseId, status: "stopped", output_file: join(directory, "unused"), summary: "Stopped by user", uuid: randomUUID(), ...base },
    ] as unknown as SDKMessage[];
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, messages, {
      afterIndex: 2,
      wait,
    });
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "stop child only", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    const childThreadId = await new Promise<string>((resolve) => {
      const poll = () => {
        const child = service.listThreads({ limit: 10, parentThreadId: started.thread.id })[0];
        child ? resolve(child.id) : setTimeout(poll, 5);
      };
      poll();
    });
    const childTurnId = service.readThread(childThreadId, true).thread.turns[0]!.id;

    await service.interruptTurn({ threadId: childThreadId, turnId: childTurnId });
    expect(fake.stoppedTaskIds).toEqual([taskId]);
    expect(service.readThread(started.thread.id, true).thread.turns[0]?.status).toBe("inProgress");
    release();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed" ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(service.readThread(childThreadId, true).thread.turns[0]?.status).toBe("interrupted");
    expect(service.readThread(started.thread.id, true).thread.turns[0]?.status).toBe("completed");
    await expect(service.interruptTurn({
      threadId: childThreadId,
      turnId: childTurnId,
    })).resolves.toBeUndefined();
    expect(fake.stoppedTaskIds).toEqual([taskId]);
    expect(service.readThread(started.thread.id, true).thread.turns[0]?.status).toBe("completed");
    await service.close();
  });

  it("retains late output from an already completed subagent without failing the active parent turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-late-child-output-"));
    directories.push(directory);
    const base = { session_id: "late-child-session" };
    const toolUseId = "late-child-tool";
    const taskId = "late-child-task";
    const backgroundToolId = "late-child-background-tool";
    const backgroundTaskId = "late-child-background-task";
    const lateStreamId = randomUUID();
    const lateAssistantId = randomUUID();
    const lateTaskNotificationId = randomUUID();
    const messages = [
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolUseId, name: "Agent", input: { prompt: "run child" } } },
      },
      {
        type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId,
        task_type: "agent", subagent_type: "general-purpose", description: "run child", uuid: randomUUID(), ...base,
      },
      {
        type: "assistant", parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "text", text: "first child result" }] },
      },
      {
        type: "assistant", parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{
          type: "tool_use", id: backgroundToolId, name: "Bash",
          input: { command: "sleep 45; echo CHILD_OK", run_in_background: true },
        }] },
      },
      {
        type: "system", subtype: "task_started", task_id: backgroundTaskId, tool_use_id: backgroundToolId,
        task_type: "local_bash", description: "sleep 45; echo CHILD_OK", uuid: randomUUID(), ...base,
      },
      {
        type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: toolUseId,
        status: "completed", output_file: join(directory, "unused-child-output"),
        summary: "first child result", uuid: randomUUID(), ...base,
      },
      {
        type: "stream_event", parent_tool_use_id: toolUseId, uuid: lateStreamId, ...base,
        event: { type: "message_start", message: {} },
      },
      {
        type: "assistant", parent_tool_use_id: toolUseId, uuid: lateAssistantId, ...base,
        message: { role: "assistant", content: [{ type: "text", text: "late resumed child result" }] },
      },
      {
        type: "system", subtype: "task_notification", task_id: backgroundTaskId,
        tool_use_id: backgroundToolId, status: "completed",
        output_file: join(directory, "late-child-background.output"),
        summary: "Background command completed (exit code 0)", uuid: lateTaskNotificationId, ...base,
      },
    ] as unknown as SDKMessage[];
    let releaseProvider!: () => void;
    const providerPause = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined, messages,
      { afterIndex: messages.length - 1, wait: providerPause },
    );
    const hub = new SubscriptionHub();
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(config(directory), hub, new Logger("error"), store, fake.factory);
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "late-child", (method, params) => events.push({ method, params }));
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "spawn and resume child", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(
      () => [lateStreamId, lateAssistantId].every((id) => store.listProviderEvents(started.thread.id)
        .some((event) => event.providerEventId === id && event.disposition === "retainedOnly"))
        && store.listProviderEvents(started.thread.id).some((event) =>
          event.providerEventId === lateTaskNotificationId && event.disposition === "projected"),
      "late child output retention",
    );

    const turn = service.readThread(started.thread.id, true).thread.turns[0]!;
    expect(turn).toMatchObject({ status: "inProgress", error: null });
    expect(events.some((event) => event.method === "item/agentMessage/delta"
      && JSON.stringify(event.params).includes("has no active turn"))).toBe(false);
    const childId = turn.items.find((item) => item.type === "collabAgentToolCall")?.receiverThreadIds[0];
    expect(service.readThread(childId!, true).thread.turns[0]).toMatchObject({ status: "completed" });
    expect(store.listProviderEvents(started.thread.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerEventId: lateStreamId, disposition: "retainedOnly" }),
      expect.objectContaining({ providerEventId: lateAssistantId, disposition: "retainedOnly" }),
      expect.objectContaining({ providerEventId: lateTaskNotificationId, disposition: "projected", error: null }),
    ]));
    await service.interruptTurn({ threadId: started.thread.id, turnId: prepared.response.turn.id });
    expect(service.readThread(started.thread.id, true).thread.turns[0]).toMatchObject({
      status: "interrupted", error: null,
    });
    releaseProvider();
    await service.close();
  });

  it("resumes a completed subagent through native SendMessage without stranding the parent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-resumed-child-"));
    directories.push(directory);
    const base = { session_id: "resumed-child-session" };
    const spawnToolId = "spawn-tool";
    const sendToolId = "send-tool";
    const taskId = "stable-provider-task";
    const resumedText = "The resumed child finished the conversion.";
    const messages = [
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: {
          type: "tool_use", id: spawnToolId, name: "Agent", input: { prompt: "Convert the data" },
        } },
      },
      {
        type: "system", subtype: "task_started", task_id: taskId, tool_use_id: spawnToolId,
        task_type: "agent", subagent_type: "general-purpose", description: "Convert the data",
        prompt: "Convert the data", uuid: randomUUID(), ...base,
      },
      {
        type: "assistant", parent_tool_use_id: spawnToolId, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "text", text: "Initial child pass completed." }] },
      },
      {
        type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: spawnToolId,
        status: "completed", summary: "Initial child pass completed.", uuid: randomUUID(), ...base,
      },
      {
        type: "assistant", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "tool_use", id: sendToolId, name: "SendMessage", input: {
          to: taskId, message: "Continue and finish the conversion", summary: "Continue conversion",
        } }] },
      },
      {
        type: "system", subtype: "task_started", task_id: taskId, tool_use_id: sendToolId,
        task_type: "local_agent", subagent_type: "general-purpose", description: "Convert the data",
        prompt: "Continue and finish the conversion", uuid: randomUUID(), ...base,
      },
      {
        type: "user", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        message: { role: "user", content: [{
          type: "tool_result", tool_use_id: sendToolId, content: "Agent resumed in the background.",
        }] },
        tool_use_result: { success: true },
      },
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: spawnToolId, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: spawnToolId, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      },
      {
        type: "stream_event", parent_tool_use_id: spawnToolId, uuid: randomUUID(), ...base,
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: resumedText } },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: spawnToolId, uuid: randomUUID(), ...base },
      {
        type: "assistant", parent_tool_use_id: spawnToolId, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "text", text: resumedText }] },
      },
      {
        type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: sendToolId,
        status: "completed", summary: resumedText, uuid: randomUUID(), ...base,
      },
      {
        type: "assistant", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "text", text: "Parent received the resumed result." }] },
      },
    ] as unknown as SDKMessage[];
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined, messages,
    );
    const hub = new SubscriptionHub();
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(config(directory), hub, new Logger("error"), store, fake.factory);
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "spawn, then resume the child", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "resumed child parent completion",
    );

    const parent = service.readThread(started.thread.id, true).thread;
    const spawn = parent.turns[0]!.items.find((item) =>
      item.type === "collabAgentToolCall" && item.tool === "spawnAgent");
    const send = parent.turns[0]!.items.find((item) =>
      item.type === "collabAgentToolCall" && item.tool === "sendInput");
    expect(spawn).toMatchObject({ type: "collabAgentToolCall", status: "completed" });
    const childThreadId = spawn?.type === "collabAgentToolCall" ? spawn.receiverThreadIds[0] : undefined;
    expect(send).toMatchObject({
      type: "collabAgentToolCall", status: "completed", receiverThreadIds: [childThreadId],
      prompt: "Continue and finish the conversion",
    });
    expect(parent.turns[0]!.items.some((item) =>
      item.type === "dynamicToolCall" && item.tool === "SendMessage")).toBe(false);
    const parentEvents = service.eventsAfter(started.thread.id, 0);
    expect(parentEvents.filter((event) => event.method === "item/started"
      && (event.params as { item?: { id?: string } }).item?.id === sendToolId)).toEqual([
      expect.objectContaining({ params: expect.objectContaining({
        item: expect.objectContaining({
          type: "collabAgentToolCall", tool: "sendInput", receiverThreadIds: [childThreadId],
        }),
      }) }),
    ]);
    expect(parentEvents.filter((event) => event.method === "item/completed"
      && (event.params as { item?: { id?: string } }).item?.id === sendToolId)).toHaveLength(1);
    const child = service.readThread(childThreadId!, true).thread;
    expect(child.turns).toHaveLength(2);
    expect(child.turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({
        status: "completed",
        items: expect.arrayContaining([
          expect.objectContaining({ type: "userMessage" }),
          expect.objectContaining({ type: "agentMessage", text: resumedText, phase: "final_answer" }),
        ]),
      }),
    ]));
    expect(service.eventsAfter(childThreadId!, 0).filter((event) => event.method === "turn/started")).toHaveLength(2);
    expect(store.listProviderEvents(started.thread.id).some((event) => event.disposition === "failed")).toBe(false);
    await service.close();
  });

  it("terminalizes the parent when provider projection fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-projection-failure-"));
    directories.push(directory);
    const base = { session_id: "projection-failure-session" };
    const spawnToolId = "spawn-tool";
    const sendToolId = "send-tool";
    const taskId = "provider-task";
    const messages = [
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: {
          type: "tool_use", id: spawnToolId, name: "Agent", input: { prompt: "Initial work" },
        } },
      },
      {
        type: "system", subtype: "task_started", task_id: taskId, tool_use_id: spawnToolId,
        task_type: "agent", subagent_type: "general-purpose", description: "Initial work",
        uuid: randomUUID(), ...base,
      },
      {
        type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: spawnToolId,
        status: "completed", summary: "Initial work completed.", uuid: randomUUID(), ...base,
      },
      {
        type: "assistant", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "tool_use", id: sendToolId, name: "SendMessage", input: {
          to: taskId, message: "Resume after projection corruption",
        } }] },
      },
      {
        type: "system", subtype: "task_started", task_id: taskId, tool_use_id: sendToolId,
        task_type: "local_agent", subagent_type: "general-purpose", description: "Initial work",
        prompt: "Resume after projection corruption", uuid: randomUUID(), ...base,
      },
    ] as unknown as SDKMessage[];
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined, messages,
      { afterIndex: 3, wait: pause },
    );
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), store, fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "projection failure", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(() => {
      const call = service.readThread(started.thread.id, true).thread.turns[0]?.items
        .find((item) => item.type === "collabAgentToolCall");
      return call?.type === "collabAgentToolCall" && call.status === "completed";
    }, "initial child completion before projection failure");
    const call = service.readThread(started.thread.id, true).thread.turns[0]!.items
      .find((item) => item.type === "collabAgentToolCall");
    const childThreadId = call?.type === "collabAgentToolCall" ? call.receiverThreadIds[0]! : "";
    store.deleteThread(childThreadId);
    release();
    await waitFor(
      () => store.listProviderEvents(started.thread.id).some((event) => event.disposition === "failed"),
      "failed provider projection journal",
    );
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status !== "inProgress",
      "projection failure terminal lifecycle",
    );
    const root = service.readThread(started.thread.id, true).thread.turns[0]!;
    expect(root).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("Claude provider projection failed") },
    });
    expect(store.listProviderEvents(started.thread.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ disposition: "failed", error: expect.stringContaining("Unknown Claude child thread") }),
    ]));
    await service.close();
  });

  it("cleans child background terminals and fences late task events after parent Stop", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-stop-late-task-"));
    directories.push(directory);
    const outputFile = join(directory, "child-background.output");
    writeFileSync(outputFile, "");
    const base = { session_id: "session" };
    const agentToolId = "agent-tool-stop-race";
    const agentTaskId = "agent-task-stop-race";
    const childBashId = "child-bash-stop-race";
    const childBackgroundId = "child-background-stop-race";
    expect(stopLifecycleSample.methods).toEqual([
      "thread/backgroundTerminals/clean", "turn/interrupt", "turn/completed", "thread/status/changed",
      "turn/started", "item/started", "turn/interrupt",
    ]);
    const lateTaskId = stopLifecycleSample.lateChildTaskId;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const messages = [
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: agentToolId, name: "Agent", input: { prompt: "Child lifecycle background test" } } },
      },
      {
        type: "system", subtype: "task_started", task_id: agentTaskId, tool_use_id: agentToolId,
        task_type: "agent", subagent_type: "general-purpose", description: "Child lifecycle background test",
        uuid: randomUUID(), ...base,
      },
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: agentToolId, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: agentToolId, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: childBashId, name: "Bash", input: { command: "sleep 15; echo CHILD_BACKGROUND_OK", run_in_background: true } } },
      },
      {
        type: "user", parent_tool_use_id: agentToolId, uuid: randomUUID(), ...base,
        message: { role: "user", content: [{
          type: "tool_result", tool_use_id: childBashId,
          content: `Command running in background with ID: ${childBackgroundId}. Output is being written to: ${outputFile}.`,
        }] },
        tool_use_result: { stdout: "", stderr: "", backgroundTaskId: childBackgroundId },
      },
      {
        type: "system", subtype: "background_tasks_changed",
        tasks: [{ task_id: childBackgroundId, task_type: "bash", description: "child background" }],
        uuid: randomUUID(), ...base,
      },
      {
        type: "system", subtype: "task_started", task_id: lateTaskId,
        task_type: "agent", subagent_type: "general-purpose", description: "Child lifecycle background test",
        uuid: randomUUID(), ...base,
      },
      {
        type: "system", subtype: "task_notification", task_id: lateTaskId, status: "stopped",
        output_file: outputFile, summary: "Interrupted", uuid: randomUUID(), ...base,
      },
      { type: "system", subtype: "background_tasks_changed", tasks: [], uuid: randomUUID(), ...base },
    ] as unknown as SDKMessage[];
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, messages, {
      afterIndex: 6,
      wait,
    });
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      { ...config(directory), idleTimeoutSeconds: -1 }, hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "stop-race", (method, params) => events.push({ method, params }));
    const prepared = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "run then stop", text_elements: [] }],
    });
    const parentTurnId = prepared.response.turn.id;
    prepared.announce();
    prepared.start();
    const childThreadId = await new Promise<string>((resolve) => {
      const poll = () => {
        const child = service.listThreads({ limit: 10, parentThreadId: started.thread.id })[0];
        child ? resolve(child.id) : setTimeout(poll, 5);
      };
      poll();
    });
    await new Promise<void>((resolve) => {
      const poll = async () => {
        const terminals = await service.listBackgroundTerminals({ threadId: childThreadId });
        terminals.data.length > 0 ? resolve() : setTimeout(() => void poll(), 5);
      };
      void poll();
    });

    await expect(service.listBackgroundTerminals({ threadId: childThreadId })).resolves.toMatchObject({
      data: [{
        processId: childBackgroundId,
        command: "sleep 15; echo CHILD_BACKGROUND_OK",
        cwd: directory,
        osPid: null,
      }],
      nextCursor: null,
    });
    await (service as unknown as { unloadIdleRuntimes(): Promise<void> }).unloadIdleRuntimes();
    expect(service.readThread(started.thread.id, true).thread.status).toMatchObject({ type: "active" });
    await expect(service.listBackgroundTerminals({ threadId: childThreadId })).resolves.toMatchObject({
      data: [{ processId: childBackgroundId }],
    });
    await expect(service.cleanBackgroundTerminals({ threadId: childThreadId })).resolves.toEqual({});
    await expect(service.listBackgroundTerminals({ threadId: childThreadId })).resolves.toMatchObject({ data: [] });
    await service.interruptTurn({ threadId: started.thread.id, turnId: parentTurnId });
    await expect(service.interruptTurn({ threadId: started.thread.id, turnId: parentTurnId })).resolves.toBeUndefined();
    expect(fake.stoppedTaskIds).toEqual([childBackgroundId, agentTaskId]);
    expect(service.readThread(started.thread.id, true).thread.turns).toHaveLength(1);
    expect(service.readThread(started.thread.id, true).thread.turns[0]).toMatchObject({ status: "interrupted" });

    const terminalIndex = events.findIndex((event) => event.method === "turn/completed"
      && (event.params as { turn?: { id?: string } }).turn?.id === parentTurnId);
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    release();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(service.readThread(started.thread.id, true).thread.turns).toHaveLength(1);
    expect(service.readThread(started.thread.id, true).thread.status).toEqual({ type: "idle" });
    expect(events.slice(terminalIndex + 1).some((event) => event.method === "turn/started"
      || event.method === "thread/status/changed"
        && (event.params as { status?: { type?: string } }).status?.type === "active")).toBe(false);
    expect(JSON.stringify(service.eventsAfter(started.thread.id, 0))).not.toContain(lateTaskId);
    expect(service.eventsAfter(started.thread.id, 0).filter((event) => event.method === "turn/completed"
      && (event.params as { turn?: { id?: string } }).turn?.id === parentTurnId)).toHaveLength(1);
    expect(service.readThread(childThreadId, true).thread.turns).toHaveLength(1);
    expect(JSON.stringify(service.readThread(childThreadId, true))).not.toContain("◆ **CCodex** │ ⚠️");
    await service.close();
  });

  it("never advertises a raw Claude task id as a navigable child thread", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-orphan-agent-task-"));
    directories.push(directory);
    const taskId = "a3cbe6de2d6dd4191";
    const base = { session_id: "session" };
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined,
      [{
        type: "system", subtype: "task_started", task_id: taskId,
        task_type: "agent", subagent_type: "general-purpose", description: "orphan provider task",
        uuid: randomUUID(), ...base,
      }, {
        type: "system", subtype: "task_notification", task_id: taskId, status: "completed",
        output_file: join(directory, "unused"), summary: "done", uuid: randomUUID(), ...base,
      }] as unknown as SDKMessage[],
    );
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "orphan task", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "orphan task turn completion",
    );
    const turn = service.readThread(started.thread.id, true).thread.turns[0]!;
    const task = turn.items.find((item) => item.type === "collabAgentToolCall");
    expect(task).toMatchObject({ type: "collabAgentToolCall", tool: "spawnAgent", status: "completed" });
    const childThreadId = task?.type === "collabAgentToolCall" ? task.receiverThreadIds[0] : undefined;
    expect(childThreadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(childThreadId).not.toBe(taskId);
    expect(service.readThread(childThreadId!, true).thread.turns[0]).toMatchObject({ status: "completed" });
    await service.close();
  });

  it("preserves nested subagent hierarchy instead of flattening it into the main turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-nested-child-"));
    directories.push(directory);
    const base = { session_id: "session" };
    const outerTool = "outer-agent-tool";
    const innerTool = "inner-agent-tool";
    const outerTask = "outer-agent-task";
    const innerTask = "inner-agent-task";
    const messages = [
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), ...base },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: outerTool, name: "Agent", input: { prompt: "Spawn nested" } } },
      },
      { type: "system", subtype: "task_started", task_id: outerTask, tool_use_id: outerTool, subagent_type: "general-purpose", description: "Spawn nested", prompt: "Spawn nested", uuid: randomUUID(), ...base },
      {
        type: "assistant", parent_tool_use_id: outerTool, subagent_type: "general-purpose", uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "tool_use", id: innerTool, name: "Agent", input: { prompt: "Read package.json" } }] },
      },
      { type: "system", subtype: "task_started", task_id: innerTask, tool_use_id: innerTool, subagent_type: "general-purpose", description: "Read package.json", uuid: randomUUID(), ...base },
      { type: "system", subtype: "task_notification", task_id: innerTask, tool_use_id: innerTool, status: "completed", summary: "@gkorepanov/ccodex", uuid: randomUUID(), ...base },
      {
        type: "user", parent_tool_use_id: outerTool, subagent_type: "general-purpose", uuid: randomUUID(), ...base,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: innerTool, content: "@gkorepanov/ccodex" }] },
      },
      {
        type: "assistant", parent_tool_use_id: outerTool, subagent_type: "general-purpose", uuid: randomUUID(), ...base,
        message: { role: "assistant", content: [{ type: "text", text: "Nested agent returned the package name." }] },
      },
      { type: "system", subtype: "task_notification", task_id: outerTask, tool_use_id: outerTool, status: "completed", summary: "Outer child completed", uuid: randomUUID(), ...base },
    ] as unknown as SDKMessage[];
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, messages);
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "nested", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed" ? resolve() : setTimeout(poll, 5);
      poll();
    });

    const mainCalls = service.readThread(started.thread.id, true).thread.turns[0]!.items
      .filter((item) => item.type === "collabAgentToolCall");
    expect(mainCalls).toHaveLength(1);
    const childThreadId = mainCalls[0]!.type === "collabAgentToolCall" ? mainCalls[0]!.receiverThreadIds[0]! : "";
    const childTurn = service.readThread(childThreadId, true).thread.turns[0]!;
    const nestedCall = childTurn.items.find((item) => item.type === "collabAgentToolCall");
    expect(nestedCall).toMatchObject({ senderThreadId: childThreadId, status: "completed" });
    const grandchildThreadId = nestedCall?.type === "collabAgentToolCall" ? nestedCall.receiverThreadIds[0]! : "";
    const grandchild = service.readThread(grandchildThreadId, true).thread;
    expect(grandchild).toMatchObject({ parentThreadId: childThreadId, threadSource: "subagent", status: { type: "idle" } });
    expect(grandchild.source).toMatchObject({ subAgent: { thread_spawn: { parent_thread_id: childThreadId, depth: 2 } } });
    expect(grandchild.turns[0]).toMatchObject({
      status: "completed",
      items: expect.arrayContaining([
        expect.objectContaining({ type: "agentMessage", text: "@gkorepanov/ccodex", phase: "final_answer" }),
      ]),
    });
    await service.close();
  });

  it("projects user-relevant long-tail SDK events and journals every disposition", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-long-tail-"));
    directories.push(directory);
    const base = { session_id: "session" };
    const messages = [
      { type: "system", subtype: "api_retry", attempt: 1, max_retries: 3, retry_delay_ms: 500, error_status: 529, error: "overloaded", uuid: randomUUID(), ...base },
      { type: "system", subtype: "notification", key: "notice", text: "Provider maintenance", priority: "high", uuid: randomUUID(), ...base },
      { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "denied", message: "Policy denied it", uuid: randomUUID(), ...base },
      { type: "tool_use_summary", summary: "Inspected the tool result", preceding_tool_use_ids: ["denied"], uuid: randomUUID(), ...base },
      { type: "prompt_suggestion", suggestion: "Continue", uuid: randomUUID(), ...base },
    ] as unknown as SDKMessage[];
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, messages);
    const service = new ClaudeService(config(directory), new SubscriptionHub(), new Logger("error"), store, fake.factory);
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "long tail", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed" ? resolve() : setTimeout(poll, 5);
      poll();
    });
    const text = service.readThread(started.thread.id, true).thread.turns[0]?.items.flatMap((item) => item.type === "agentMessage" ? [item.text] : []).join("\n") ?? "";
    expect(text).toContain("◆ **CCodex** │ Claude API retry 1/3");
    expect(text).toContain("◆ **CCodex** │ Provider maintenance");
    expect(text).toContain("◆ **CCodex** │ ⚠️ Bash was denied: Policy denied it");
    expect(text).toContain("◆ **CCodex** │ Inspected the tool result");
    const journal = store.listProviderEvents(started.thread.id);
    expect(journal.some((event) => event.providerEventType === "prompt_suggestion" && event.disposition === "retainedOnly")).toBe(true);
    expect(journal.every((event) => event.disposition !== "pending" && event.disposition !== "failed" && event.disposition !== "unsupportedVisible")).toBe(true);
    await service.close();
  });

  it("journals provider admission before projection and disposition after it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-provider-order-"));
    directories.push(directory);
    const store = new ProviderOrderStore(join(directory, "state.sqlite"));
    const message = {
      type: "system",
      subtype: "notification",
      key: "ordered",
      text: "Ordered provider notice",
      priority: "normal",
      uuid: "ordered-provider-event",
      session_id: "ordered-session",
    } as unknown as SDKMessage;
    const service = new ClaudeService(
      config(directory),
      new SubscriptionHub(),
      new Logger("error"),
      store,
      new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, [message]).factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "ordered", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "ordered provider turn",
    );

    expect(store.order[0]).toBe("journal:pending");
    expect(store.order.some((entry) => entry.startsWith("projection:"))).toBe(true);
    expect(store.order.at(-1)).toBe("journal:projected");
    expect(store.listProviderEvents(started.thread.id)).toContainEqual(expect.objectContaining({
      providerEventId: "ordered-provider-event",
      disposition: "projected",
    }));
    await service.close();
  });

  it("surfaces and journals an unknown future provider event", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-unknown-provider-event-"));
    directories.push(directory);
    const unknown = {
      type: "future_runtime_event", detail: "new provider behavior",
      uuid: randomUUID(), session_id: "session",
    } as unknown as SDKMessage;
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, [unknown]);
    const service = new ClaudeService(config(directory), new SubscriptionHub(), new Logger("error"), store, fake.factory);
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "future event", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed" ? resolve() : setTimeout(poll, 5);
      poll();
    });
    const messages = service.readThread(started.thread.id, true).thread.turns[0]!.items
      .flatMap((item) => item.type === "agentMessage" ? [item.text] : []);
    expect(messages).toContain("◆ **CCodex** │ ⚠️ Unsupported Claude provider event 'future_runtime_event' was retained for audit.");
    expect(store.listProviderEvents(started.thread.id, "unsupportedVisible")).toMatchObject([{
      providerEventType: "future_runtime_event", payload: unknown,
    }]);
    await service.close();
  });

  it("evicts refusal-fallback partial items and emits the native reroute event", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-refusal-fallback-"));
    directories.push(directory);
    const session_id = "session";
    const refusedUuid = randomUUID();
    const replacementUuid = randomUUID();
    const streamText = (text: string) => [
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null, uuid: randomUUID(), session_id },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null, uuid: randomUUID(), session_id },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, parent_tool_use_id: null, uuid: randomUUID(), session_id },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null, uuid: randomUUID(), session_id },
    ];
    const before = [
      ...streamText("REFUSED PARTIAL"),
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "REFUSED PARTIAL" }] }, parent_tool_use_id: null, uuid: refusedUuid, session_id },
      ...streamText("SAFE REPLACEMENT"),
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "SAFE REPLACEMENT" }] }, parent_tool_use_id: null, supersedes: [refusedUuid], uuid: replacementUuid, session_id },
      {
        type: "system", subtype: "model_refusal_fallback", trigger: "refusal", direction: "retry",
        original_model: "claude-fable-5", fallback_model: "claude-sonnet-4-6", request_id: "request-1",
        retracted_message_uuids: [refusedUuid], refused_user_message_uuid: null,
        content: "Switched to a safe fallback.", uuid: randomUUID(), session_id,
      },
    ] as unknown as SDKMessage[];
    const hub = new SubscriptionHub();
    const events: Array<{ method: string; params: unknown }> = [];
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), store,
      new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, before).factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));
    const prepared = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "fallback", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed" ? resolve() : setTimeout(poll, 5);
      poll();
    });
    const record = store.getThreadRecord(started.thread.id, true)!;
    const text = record.thread.turns[0]!.items.flatMap((item) => item.type === "agentMessage" ? [item.text] : []).join("\n");
    expect(text).not.toContain("REFUSED PARTIAL");
    expect(text).toContain("SAFE REPLACEMENT");
    expect(text).toContain("◆ **CCodex** │ Switched to a safe fallback.");
    expect(record.resolvedModel).toBe("claude-sonnet-4-6");
    expect(store.listProviderItemCorrelations(started.thread.id, [refusedUuid])).toEqual([]);
    expect(store.listProviderItemCorrelations(started.thread.id, [replacementUuid])).toHaveLength(1);
    expect(events).toContainEqual({
      method: "model/rerouted",
      params: {
        threadId: started.thread.id,
        turnId: record.thread.turns[0]!.id,
        fromModel: "claude-fable-5",
        toModel: "claude-sonnet-4-6",
        reason: "highRiskCyberActivity",
      },
    });
    await service.close();
  });

  it("keeps provider correlations durable across restart and retracts the original turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-correlation-restart-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const firstStore = new SqliteHybridStore(database);
    const first = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), firstStore, new FakeClaudeQuery().factory,
    );
    const started = await first.startThread({ model: "claude:haiku", cwd: directory });
    const initial = await first.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "persist correlation", text_elements: [] }],
    });
    initial.announce();
    initial.start();
    await waitFor(
      () => first.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "initial correlation turn",
    );
    const providerMessageId = firstStore.listProviderEvents(started.thread.id)
      .find((event) => event.providerEventType === "assistant")?.providerEventId;
    expect(providerMessageId).toBeTypeOf("string");
    const correlatedItems = firstStore.listProviderItemCorrelations(
      started.thread.id,
      [providerMessageId!],
    ).map((entry) => entry.itemId);
    const initialTurnId = first.readThread(started.thread.id, true).thread.turns[0]!.id;
    expect(correlatedItems.length).toBeGreaterThan(0);
    await first.close();

    const fallback = {
      type: "system",
      subtype: "model_refusal_fallback",
      trigger: "refusal",
      direction: "retry",
      original_model: "claude-haiku-4-5",
      fallback_model: "claude-sonnet-4-6",
      request_id: "restart-retraction",
      retracted_message_uuids: [providerMessageId],
      refused_user_message_uuid: null,
      content: "Retried after restart.",
      uuid: randomUUID(),
      session_id: "session",
    } as unknown as SDKMessage;
    const secondStore = new SqliteHybridStore(database);
    const second = new ClaudeService(
      config(directory),
      new SubscriptionHub(),
      new Logger("error"),
      secondStore,
      new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, [fallback]).factory,
    );
    await second.resumeThread(started.thread.id);
    const retried = await second.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "retry", text_elements: [] }],
    });
    retried.announce();
    retried.start();
    await waitFor(
      () => second.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed",
      "post-restart retraction",
    );

    const itemIds = second.readThread(started.thread.id, true).thread.turns
      .flatMap((turn) => turn.items.map((item) => item.id));
    expect(itemIds).not.toEqual(expect.arrayContaining(correlatedItems));
    expect(secondStore.listProviderItemCorrelations(started.thread.id, [providerMessageId!])).toEqual([]);
    expect(secondStore.getTurnClaudeMessageUuid(started.thread.id, initialTurnId)).toBeUndefined();
    const replacementTurn = second.readThread(started.thread.id, true).thread.turns.at(-1)!;
    expect(secondStore.getThreadRecord(started.thread.id)?.lastClaudeMessageUuid)
      .toBe(secondStore.getTurnClaudeMessageUuid(started.thread.id, replacementTurn.id));
    expect(secondStore.getThreadRecord(started.thread.id)?.lastClaudeMessageUuid).not.toBe(providerMessageId);
    await second.close();
  });

  it("remounts the durable provider session after conversation reset", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-conversation-reset-"));
    directories.push(directory);
    const nextSessionId = randomUUID();
    const reset = {
      type: "conversation_reset", new_conversation_id: nextSessionId,
      uuid: randomUUID(), session_id: "session",
    } as unknown as SDKMessage;
    const hub = new SubscriptionHub();
    const events: Array<{ method: string; params: unknown }> = [];
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), store,
      new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, [reset]).factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    await service.setThreadName({ threadId: started.thread.id, name: "Old provider title" });
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));
    const prepared = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "reset", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed" ? resolve() : setTimeout(poll, 5);
      poll();
    });
    const record = store.getThreadRecord(started.thread.id, true)!;
    expect(record.claudeSessionId).toBe(nextSessionId);
    expect(record.lastClaudeMessageUuid).not.toBeNull();
    expect(record.thread.name).toBeNull();
    expect(events).toContainEqual({
      method: "thread/name/updated",
      params: { threadId: started.thread.id, threadName: null },
    });
    expect(record.thread.turns[0]!.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agentMessage", text: `◆ **CCodex** │ Claude reset the provider conversation to ${nextSessionId}.` }),
    ]));
    await service.close();
  });

  it("applies conversation reset to the latest concurrent settings and metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-conversation-reset-race-"));
    directories.push(directory);
    const nextSessionId = randomUUID();
    let releaseReset!: () => void;
    const resetBarrier = new Promise<void>((resolve) => { releaseReset = resolve; });
    const barrierId = randomUUID();
    const messages = [
      {
        type: "prompt_suggestion",
        suggestion: "barrier",
        uuid: barrierId,
        session_id: "session",
      },
      {
        type: "conversation_reset",
        new_conversation_id: nextSessionId,
        uuid: randomUUID(),
        session_id: "session",
      },
    ] as unknown as SDKMessage[];
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const fake = new FakeClaudeQuery(
      undefined,
      undefined,
      [],
      false,
      undefined,
      undefined,
      undefined,
      messages,
      { afterIndex: 0, wait: resetBarrier },
    );
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), store, fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    await service.setThreadName({ threadId: started.thread.id, name: "Reset me" });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "reset concurrently", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(
      () => store.listProviderEvents(started.thread.id)
        .some((event) => event.providerEventId === barrierId && event.disposition === "retainedOnly"),
      "provider reset barrier",
    );

    await service.updateThreadMetadata({
      threadId: started.thread.id,
      gitInfo: { branch: "concurrent", sha: "abc123" },
    });
    await service.updateThreadSettings({
      threadId: started.thread.id,
      model: "claude:sonnet",
      effort: "high",
      serviceTier: "fast",
    });
    releaseReset();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "concurrent reset completion",
    );

    expect(store.getThreadRecord(started.thread.id)).toMatchObject({
      claudeSessionId: nextSessionId,
      lastClaudeMessageUuid: expect.any(String),
      modelPickerId: "claude:sonnet",
      claudeModelValue: "sonnet",
      reasoningEffort: "high",
      serviceTier: "fast",
      thread: {
        name: null,
        gitInfo: { branch: "concurrent", sha: "abc123" },
      },
    });
    await service.close();
  });

  it("resolves same-generation compaction against the reset provider conversation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-reset-compact-session-"));
    directories.push(directory);
    const nextSessionId = randomUUID();
    const reset = {
      type: "conversation_reset",
      new_conversation_id: nextSessionId,
      uuid: randomUUID(),
      session_id: "session",
    } as unknown as SDKMessage;
    const resolvedSessions: string[] = [];
    const brancher: TranscriptBrancher = {
      forkWithProvenance: async () => { throw new Error("unused transcript fork"); },
      resolveCompactionBoundary: async (sessionId, _cwd, boundary) => {
        resolvedSessions.push(sessionId);
        return boundary.uuid;
      },
      delete: async () => undefined,
    };
    const fake = new FakeClaudeQuery(
      undefined,
      undefined,
      [],
      true,
      undefined,
      undefined,
      undefined,
      [reset],
    );
    const service = new ClaudeService(
      config(directory),
      new SubscriptionHub(),
      new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      fake.factory,
      undefined,
      undefined,
      brancher,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const initial = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "reset first", text_elements: [] }],
    });
    initial.announce();
    initial.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "pre-compact reset",
    );
    expect(service.currentThreadSettings(started.thread.id)).toBeDefined();
    expect(service.readThread(started.thread.id, false).thread.name).toBeNull();

    await service.compactThread(started.thread.id);
    await waitFor(
      () => {
        const turns = service.readThread(started.thread.id, true).thread.turns;
        return turns.length === 2 && turns.at(-1)?.status === "completed";
      },
      "post-reset compact",
    );
    expect(resolvedSessions).toEqual([nextSessionId]);
    await service.close();
  });

  it("deduplicates a replayed provider message UUID before state mutation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-provider-dedup-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const base = { session_id: "session", parent_tool_use_id: null };
    const startedMessage = {
      type: "system", subtype: "task_started", task_id: "task-dedup", description: "Inspect once",
      subagent_type: "Explore", uuid: "provider-task-duplicate", ...base,
    } as unknown as SDKMessage;
    const messages = [
      startedMessage,
      structuredClone(startedMessage),
      { type: "system", subtype: "task_notification", task_id: "task-dedup", status: "completed", summary: "Done", uuid: "provider-task-terminal", ...base },
    ] as unknown as SDKMessage[];
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, messages);
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const prepared = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "dedup", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed" ? resolve() : setTimeout(poll, 5);
      poll();
    });
    const tasks = service.readThread(started.thread.id, true).thread.turns.flatMap((turn) =>
      turn.items.filter((item) => item.type === "collabAgentToolCall"),
    );
    expect(tasks).toHaveLength(1);
    await service.close();
  });

  it("acknowledges manual compaction before a delayed provider boundary and completes one native lifecycle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-compact-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const fake = new FakeClaudeQuery(undefined, undefined, [], true);
    let releaseBoundary!: () => void;
    fake.compactBoundaryWait = new Promise<void>((resolve) => { releaseBoundary = resolve; });
    fake.duplicateCompactBoundary = true;
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), store, fake.factory,
      undefined, undefined, immediateCompactionBoundary,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await service.compactThread(started.thread.id);
    const inProgress = service.readThread(started.thread.id, true).thread.turns[0]!;
    expect(inProgress).toMatchObject({ status: "inProgress", items: [{ type: "contextCompaction" }] });
    expect(events.map((event) => event.method)).toEqual([
      "thread/status/changed", "turn/started", "item/started",
    ]);

    await vi.advanceTimersByTimeAsync(143_000);
    expect(service.readThread(started.thread.id, true).thread.turns[0]).toMatchObject({ status: "inProgress" });
    expect(events.some((event) => event.method === "error")).toBe(false);

    releaseBoundary();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const completed = service.readThread(started.thread.id, true).thread.turns[0]!;
    expect(completed).toMatchObject({
      id: inProgress.id, status: "completed", items: [{ id: inProgress.items[0]!.id, type: "contextCompaction" }],
    });
    expect(events.find((event) => event.method === "thread/tokenUsage/updated")?.params).toMatchObject({
      tokenUsage: { total: { totalTokens: 0 }, last: { totalTokens: 24 }, modelContextWindow: 200_000 },
    });
    expect(events.filter((event) => event.method === "item/started")).toHaveLength(1);
    expect(events.filter((event) => event.method === "item/completed")).toHaveLength(1);
    expect(events.filter((event) => event.method === "thread/compacted")).toHaveLength(1);
    expect(events.filter((event) => event.method === "turn/completed")).toHaveLength(1);
    expect(events.map((event) => event.method)).toEqual([
      "thread/status/changed", "turn/started", "item/started", "item/completed", "thread/compacted",
      "thread/status/changed", "turn/completed", "thread/tokenUsage/updated",
    ]);
    await service.close();
  });

  it.each(["before", "after"] as const)(
    "awaits the native PostCompact summary %s the terminal boundary without publishing hidden UI events",
    async (hookOrder) => {
      const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-hidden-compact-"));
      directories.push(directory);
      const hub = new SubscriptionHub();
      const fake = new FakeClaudeQuery(undefined, undefined, [], true);
      fake.compactSummary = "Native Claude compact summary.";
      fake.compactSummaryAfterBoundary = hookOrder === "after";
      const service = new ClaudeService(
        config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")),
        fake.factory, undefined, undefined, immediateCompactionBoundary,
      );
      const started = await service.startThread({ model: "claude:haiku", cwd: directory });
      const events: Array<{ method: string; params: unknown }> = [];
      hub.subscribe(started.thread.id, "hidden-compact", (method, params) => events.push({ method, params }));

      const hiddenCompact = service.compactForHandoff(
        started.thread.id,
        "/compact preserve decisions and unfinished work",
      );
      await waitFor(() => fake.prompts.length === 1, "hidden compact prompt");
      await expect(hiddenCompact).resolves.toBe("Native Claude compact summary.");

      expect(fake.prompts.at(-1)?.message.content).toEqual([{
        type: "text",
        text: "/compact preserve decisions and unfinished work",
      }]);
      expect(events).toEqual([]);
      expect(service.readThread(started.thread.id, true).thread.turns.at(-1)).toMatchObject({
        status: "completed",
        items: [{ type: "contextCompaction" }],
      });
      await service.close();
    },
  );

  it("uses the native PostCompact summary when a hidden handoff boundary is absent from the transcript", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-hidden-compact-unpersisted-boundary-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery(undefined, undefined, [], true);
    fake.compactSummary = "Native summary from a long forked Claude task.";
    fake.compactSummaryAfterBoundary = true;
    const resolveCompactionBoundary = vi.fn(async () => {
      throw new Error("Claude transcript does not contain compact boundary 'captured-boundary'.");
    });
    const brancher: TranscriptBrancher = {
      forkWithProvenance: async () => { throw new Error("unused transcript fork"); },
      resolveCompactionBoundary,
      delete: async () => undefined,
    };
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
      undefined, undefined, brancher,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });

    await expect(service.compactForHandoff(started.thread.id, "/compact preserve the task"))
      .resolves.toBe("Native summary from a long forked Claude task.");
    expect(resolveCompactionBoundary).not.toHaveBeenCalled();
    expect(service.readThread(started.thread.id, true).thread.turns.at(-1)).toMatchObject({
      status: "completed", items: [{ type: "contextCompaction" }],
    });
    await service.close();
  });

  it("rejects a hidden handoff compaction on the provider terminal failure without publishing it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-hidden-compact-failure-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery(undefined, undefined, [], true);
    fake.compactFailure = "Provider refused hidden compaction.";
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")),
      fake.factory, undefined, undefined, immediateCompactionBoundary,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "hidden-compact-failure", (method, params) => events.push({ method, params }));

    await expect(service.compactForHandoff(started.thread.id))
      .rejects.toThrow("Provider refused hidden compaction.");
    expect(events).toEqual([]);
    await service.close();
  });

  it.each(["manual", "prompted"] as const)(
    "waits for an unloaded runtime to become session-ready before %s compaction",
    async (mode) => {
      const directory = mkdtempSync(join(tmpdir(), `codex-hybrid-${mode}-compact-rematerialize-`));
      directories.push(directory);
      let releaseInitialization!: () => void;
      const initialization = new Promise<void>((resolve) => { releaseInitialization = resolve; });
      let releaseBoundary!: () => void;
      const fake = new FakeClaudeQuery(undefined, undefined, [], true);
      fake.compactBoundaryWait = new Promise<void>((resolve) => { releaseBoundary = resolve; });
      let runtimeCount = 0;
      const delayedRematerialization: typeof fake.factory = (input) => {
        const query = fake.factory(input);
        if (runtimeCount++ === 0) return query;
        return new Proxy(query, {
          get(target, property) {
            if (property === "initializationResult") return async () => {
              await initialization;
              return target.initializationResult();
            };
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };
      const hub = new SubscriptionHub();
      const service = new ClaudeService(
        { ...config(directory), idleTimeoutSeconds: -1 },
        hub,
        new Logger("error"),
        new SqliteHybridStore(join(directory, "state.sqlite")),
        delayedRematerialization,
        undefined,
        undefined,
        immediateCompactionBoundary,
      );
      const started = await service.startThread({ model: "claude:haiku", cwd: directory });
      const first = await service.prepareTurn({
        threadId: started.thread.id,
        input: [{ type: "text", text: "seed durable history", text_elements: [] }],
      });
      first.announce();
      first.start();
      await waitFor(
        () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
        "seed turn completion",
      );
      await (service as unknown as { unloadIdleRuntimes(): Promise<void> }).unloadIdleRuntimes();
      expect(service.readThread(started.thread.id, false).thread.status.type).toBe("notLoaded");

      const events: Array<{ method: string; params: unknown }> = [];
      hub.subscribe(started.thread.id, `compact-${mode}`, (method, params) => {
        events.push({ method, params });
      });
      let prepared: Awaited<ReturnType<typeof service.preparePromptedCompact>> | undefined;
      let settled = false;
      const compact = (mode === "manual"
        ? service.compactThread(started.thread.id)
        : service.preparePromptedCompact(
            started.thread.id,
            "/compact retain the durable seed",
          ).then((value) => { prepared = value; }))
        .then(() => { settled = true; });

      await waitFor(() => fake.inputs.length === 2, `${mode} runtime rematerialization`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(events).toEqual([]);
      expect(service.readThread(started.thread.id, true).thread.turns).toHaveLength(1);

      releaseInitialization();
      await compact;
      await prepared?.announce();
      await waitFor(() => fake.prompts.length === 2, `${mode} compact provider command`);
      expect(fake.prompts.at(-1)?.message.content).toEqual([{
        type: "text",
        text: mode === "manual" ? "/compact" : "/compact retain the durable seed",
      }]);
      expect(events.slice(0, 4).map((event) => event.method)).toEqual([
        "thread/status/changed",
        "thread/status/changed",
        "turn/started",
        "item/started",
      ]);
      expect(events.some((event) => event.method === "error")).toBe(false);

      releaseBoundary();
      await waitFor(
        () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed",
        `${mode} compact completion`,
      );
      expect(service.readThread(started.thread.id, true).thread.turns.at(-1)?.items)
        .toEqual([expect.objectContaining({ type: "contextCompaction" })]);
      await service.close();
    },
  );

  it("intercepts a prompted Compact as native compaction and never steers into it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-prompted-compact-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery(undefined, undefined, [], true);
    let releaseBoundary!: () => void;
    fake.compactBoundaryWait = new Promise<void>((resolve) => { releaseBoundary = resolve; });
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")),
      fake.factory, undefined, undefined, immediateCompactionBoundary,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));
    const command = "/compact запомни только первое сообщение";

    const prepared = await service.preparePromptedCompact(started.thread.id, command);
    expect(prepared.response.turn).toMatchObject({
      status: "inProgress",
      items: [{ type: "contextCompaction" }],
    });
    expect(events.map((event) => event.method)).toEqual(["thread/status/changed"]);
    expect(fake.prompts).toHaveLength(0);

    await prepared.announce();
    await waitFor(() => fake.prompts.length === 1, "prompted compact provider command");
    expect(fake.prompts[0]?.message.content).toEqual([{ type: "text", text: command }]);
    expect(events.map((event) => event.method)).toEqual([
      "thread/status/changed", "turn/started", "item/started",
    ]);
    await expect(service.steerTurn({
      threadId: started.thread.id,
      expectedTurnId: prepared.response.turn.id,
      input: [{ type: "text", text: "это не должно прилипнуть", text_elements: [] }],
    })).rejects.toThrow();
    expect(fake.prompts).toHaveLength(1);

    releaseBoundary();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "prompted compact completion",
    );
    expect(events.map((event) => event.method)).toEqual([
      "thread/status/changed", "turn/started", "item/started", "item/completed", "thread/compacted",
      "thread/status/changed", "turn/completed", "thread/tokenUsage/updated",
    ]);
    expect(service.readThread(started.thread.id, true).thread.turns).toEqual([
      expect.objectContaining({
        id: prepared.response.turn.id,
        status: "completed",
        items: [expect.objectContaining({ type: "contextCompaction" })],
      }),
    ]);
    await service.close();
  });

  it("interrupts compaction exactly once and fences a late provider boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-compact-interrupt-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery(undefined, undefined, [], true);
    let releaseBoundary!: () => void;
    fake.compactBoundaryWait = new Promise<void>((resolve) => { releaseBoundary = resolve; });
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));
    await service.compactThread(started.thread.id);
    const turnId = service.readThread(started.thread.id, true).thread.turns[0]!.id;

    await service.interruptTurn({ threadId: started.thread.id, turnId });
    await service.interruptTurn({ threadId: started.thread.id, turnId });
    expect(service.readThread(started.thread.id, true).thread.turns).toEqual([
      expect.objectContaining({ id: turnId, status: "interrupted", items: [expect.objectContaining({ type: "contextCompaction" })] }),
    ]);
    expect(events.filter((event) => event.method === "turn/completed")).toHaveLength(1);
    expect(events.some((event) => event.method === "thread/compacted" || event.method === "error")).toBe(false);

    releaseBoundary();
    await waitFor(() => service.currentThreadSettings(started.thread.id).model === "claude:haiku", "late compact boundary drain");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(service.readThread(started.thread.id, true).thread.turns).toHaveLength(1);
    expect(service.readThread(started.thread.id, true).thread.status.type).toBe("idle");
    expect(events.filter((event) => event.method === "turn/completed")).toHaveLength(1);
    expect(events.some((event) => event.method === "thread/compacted" || event.method === "error")).toBe(false);
    await service.close();
  });

  it("fails a provider-rejected compaction after RPC acknowledgement and keeps the thread usable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-compact-failure-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery(undefined, undefined, [], true);
    fake.compactFailure = "Provider refused compaction.";
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "test", (method, params) => events.push({ method, params }));

    await service.compactThread(started.thread.id);
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "failed",
      "provider-declared compaction failure",
    );
    expect(service.readThread(started.thread.id, true).thread.turns[0]).toMatchObject({
      status: "failed", error: { message: "Provider refused compaction." }, items: [{ type: "contextCompaction" }],
    });
    expect(events.filter((event) => event.method === "error")).toHaveLength(1);
    expect(events.filter((event) => event.method === "thread/compacted")).toHaveLength(0);

    const next = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "still usable", text_elements: [] }],
    });
    next.announce();
    next.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed",
      "post-compaction turn",
    );
    expect(service.readThread(started.thread.id, true).thread.turns.at(-1)?.items)
      .toContainEqual(expect.objectContaining({ type: "agentMessage", text: "OK" }));

    await service.compactThread(started.thread.id);
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "failed",
      "repeat provider-declared compaction failure",
    );
    await service.close();
  });

  it("allows compaction retry after a rejected compact and a normal result without session-state events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-compact-retry-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery(undefined, undefined, [], true);
    fake.compactFailure = "Not enough messages to compact.";
    fake.emitSessionStateChanges = false;
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
      undefined, undefined, immediateCompactionBoundary,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });

    await service.compactThread(started.thread.id);
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "failed",
      "provider-declared compaction failure without idle event",
    );

    const next = await service.prepareTurn({
      threadId: started.thread.id, input: [{ type: "text", text: "settle", text_elements: [] }],
    });
    next.announce();
    next.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed",
      "normal turn after compact failure",
    );

    delete fake.compactFailure;
    await expect(service.compactThread(started.thread.id)).resolves.toEqual({});
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed",
      "successful compact retry without session-state events",
    );
    expect(service.readThread(started.thread.id, true).thread.turns.at(-1)?.items)
      .toContainEqual(expect.objectContaining({ type: "contextCompaction" }));
    await service.close();
  });

  it("resumes the same in-progress compaction ids and completes once for both subscribers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-compact-reconnect-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery(undefined, undefined, [], true);
    let releaseBoundary!: () => void;
    fake.compactBoundaryWait = new Promise<void>((resolve) => { releaseBoundary = resolve; });
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
      undefined, undefined, immediateCompactionBoundary,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const first: string[] = [];
    const second: string[] = [];
    hub.subscribe(started.thread.id, "first", (method) => first.push(method));
    await service.compactThread(started.thread.id);
    const inProgress = service.readThread(started.thread.id, true).thread.turns[0]!;
    const resumed = await service.resumeThread({ threadId: started.thread.id, excludeTurns: false });
    expect(resumed.thread.turns).toEqual([expect.objectContaining({
      id: inProgress.id, status: "inProgress", items: [expect.objectContaining({ id: inProgress.items[0]!.id })],
    })]);
    hub.subscribe(started.thread.id, "second", (method) => second.push(method));

    releaseBoundary();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "reconnected compaction completion",
    );
    expect(first.filter((method) => method === "turn/completed")).toHaveLength(1);
    expect(second.filter((method) => method === "turn/completed")).toHaveLength(1);
    expect(service.readThread(started.thread.id, true).thread.turns[0]).toMatchObject({
      id: inProgress.id, status: "completed", items: [{ id: inProgress.items[0]!.id, type: "contextCompaction" }],
    });
    await service.close();
  });

  it("reconciles a persisted in-progress compaction after gateway restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-compact-restart-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const first = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    const started = await first.startThread({ model: "claude:haiku", cwd: directory });
    await first.close();
    const seed = new SqliteHybridStore(database);
    const record = seed.getThreadRecord(started.thread.id, false)!;
    const crashed: Turn = {
      id: randomUUID(), items: [{ type: "contextCompaction", id: randomUUID() }], itemsView: "full",
      status: "inProgress", error: null, startedAt: Math.floor(Date.now() / 1_000), completedAt: null, durationMs: null,
    };
    seed.createTurn(started.thread.id, crashed);
    seed.updateThread({ ...record, thread: { ...record.thread, status: { type: "active", activeFlags: [] } } });
    seed.close();

    const recovered = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    await recovered.ready();
    expect(recovered.readThread(started.thread.id, true).thread.turns).toEqual([
      expect.objectContaining({
        id: crashed.id, status: "failed", items: [{ type: "contextCompaction", id: crashed.items[0]!.id }],
        error: expect.objectContaining({ message: "Gateway restarted while the Claude turn was active." }),
      }),
    ]);
    expect(recovered.readThread(started.thread.id, true).thread.status.type).toBe("systemError");
    await recovered.close();
  });

  it("continues cumulative token usage after a gateway restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-usage-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const firstHub = new SubscriptionHub();
    const firstFake = new FakeClaudeQuery();
    const first = new ClaudeService(config(directory), firstHub, new Logger("error"), new SqliteHybridStore(database), firstFake.factory);
    const started = await first.startThread({ model: "claude:haiku", cwd: directory });
    const firstUsage: unknown[] = [];
    firstHub.subscribe(started.thread.id, "first", (method, params) => {
      if (method === "thread/tokenUsage/updated") firstUsage.push(params);
    });
    const initial = await first.prepareTurn({ threadId: started.thread.id, input: [{ type: "text", text: "one", text_elements: [] }] });
    initial.announce();
    initial.start();
    await new Promise<void>((resolve) => {
      const poll = () => firstUsage.length ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(firstUsage[0]).toMatchObject({ tokenUsage: { total: { totalTokens: 5 }, last: { totalTokens: 24 } } });
    first.updateThreadMetadata({ threadId: started.thread.id, gitInfo: { branch: "persisted", sha: "abc123" } });
    await first.shellCommand({ threadId: started.thread.id, command: "printf persisted-shell" });
    await first.close();

    const secondHub = new SubscriptionHub();
    const secondFake = new FakeClaudeQuery();
    const second = new ClaudeService(config(directory), secondHub, new Logger("error"), new SqliteHybridStore(database), secondFake.factory);
    expect(second.readThread(started.thread.id, true).thread).toMatchObject({
      gitInfo: { branch: "persisted", sha: "abc123" },
      turns: expect.arrayContaining([expect.objectContaining({
        items: [expect.objectContaining({ type: "commandExecution", aggregatedOutput: "persisted-shell" })],
      })]),
    });
    await second.resumeThread(started.thread.id);
    const secondUsage: unknown[] = [];
    secondHub.subscribe(started.thread.id, "second", (method, params) => {
      if (method === "thread/tokenUsage/updated") secondUsage.push(params);
    });
    const resumed = await second.prepareTurn({ threadId: started.thread.id, input: [{ type: "text", text: "two", text_elements: [] }] });
    resumed.announce();
    resumed.start();
    await new Promise<void>((resolve) => {
      const poll = () => secondUsage.some((usage) =>
        (usage as { tokenUsage?: { total?: { totalTokens?: number } } }).tokenUsage?.total?.totalTokens === 10)
        ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(secondUsage.at(-1)).toMatchObject({ tokenUsage: { total: { totalTokens: 10 }, last: { totalTokens: 24 } } });
    await second.close();
  });

  it("reconstructs the latest desired settings after restart without inventing a failed turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-settings-restart-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const first = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), new FakeClaudeQuery().factory,
    );
    const started = await first.startThread({ model: "claude:claude-fable-5", cwd: directory });
    const prepared = await first.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "complete before restart", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(
      () => first.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "pre-restart completion",
    );
    await first.updateThreadSettings({
      threadId: started.thread.id,
      model: "claude:claude-opus-4-8",
      serviceTier: "fast",
      effort: "high",
    });
    await first.close();

    const secondFake = new FakeClaudeQuery();
    const second = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(database), secondFake.factory,
    );
    expect(second.readThread(started.thread.id, true).thread.turns).toEqual([
      expect.objectContaining({ status: "completed", error: null }),
    ]);
    await second.resumeThread(started.thread.id);
    expect(secondFake.inputs[0]?.options).toMatchObject({
      model: "claude-opus-4-8",
      effort: "high",
      settings: { fastMode: true },
    });
    expect(second.currentThreadSettings(started.thread.id)).toMatchObject({
      model: "claude:claude-opus-4-8", effort: "high", serviceTier: "fast",
    });
    expect(second.readThread(started.thread.id, true).thread.turns.some((turn) => turn.status === "failed")).toBe(false);
    await second.close();
  });

  it("validates model-specific settings and projects SDK structured_output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-structured-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, { answer: 42 });
    const catalog = { list: async () => [{
      id: "claude:haiku", model: "claude:haiku", upgrade: null, upgradeInfo: null, availabilityNux: null,
      displayName: "Haiku", description: "test", hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }], defaultReasoningEffort: "low",
      inputModalities: ["text" as const], supportsPersonality: true, additionalSpeedTiers: [], serviceTiers: [],
      defaultServiceTier: null, isDefault: false,
    }] };
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory, catalog,
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    await expect(service.updateThreadSettings({ threadId: started.thread.id, effort: "high" })).rejects.toThrow("does not support effort");
    const events: string[] = [];
    hub.subscribe(started.thread.id, "test", (method) => events.push(method));
    const prepared = await service.prepareTurn({
      threadId: started.thread.id, outputSchema: { type: "object" },
      input: [{ type: "text", text: "structured", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => events.includes("turn/completed") ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(service.readThread(started.thread.id, true).thread.turns[0]?.items).toContainEqual(expect.objectContaining({
      type: "agentMessage", text: "{\n  \"answer\": 42\n}",
    }));
    await service.close();
  });

  it("reconfigures a fresh ephemeral runtime for first-turn structured output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-ephemeral-structured-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, { title: "Ready", description: "Ephemeral" });
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory, ephemeral: true, permissions: ":read-only" });
    const events: string[] = [];
    hub.subscribe(started.thread.id, "test", (method) => events.push(method));
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object", properties: { title: { type: "string" } }, required: ["title"],
    };
    const claudeSchema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      permissions: ":read-only",
      outputSchema: schema,
      input: [{ type: "text", text: "generate metadata", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => events.includes("turn/completed") ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(fake.inputs).toHaveLength(1);
    expect(fake.inputs[0]?.options).toMatchObject({
      persistSession: false, outputFormat: { type: "json_schema", schema: claudeSchema },
    });
    expect(service.readThread(started.thread.id, true).thread.turns[0]?.status).toBe("completed");
    await expect(service.updateThreadSettings({
      threadId: started.thread.id, effort: "high",
    })).resolves.toEqual({});
    expect(service.currentThreadSettings(started.thread.id).effort).toBe("high");
    await service.close();
  });

  it("switches model, effort, and speed between ephemeral turns without replacing provider context", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-ephemeral-controls-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:sonnet", cwd: directory, ephemeral: true,
    });
    const first = await service.prepareTurn({
      threadId: started.thread.id,
      effort: "low",
      input: [{ type: "text", text: "remember nonce", text_elements: [] }],
    });
    first.announce();
    first.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "first ephemeral turn",
    );

    await service.updateThreadSettings({
      threadId: started.thread.id,
      model: "claude:claude-opus-4-8",
      effort: "high",
      serviceTier: "fast",
      summary: "detailed",
    });
    const second = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "recall nonce", text_elements: [] }],
    });
    expect(fake.inputs).toHaveLength(1);
    expect(fake.prompts).toHaveLength(1);
    expect(fake.controls).toEqual([
      { method: "setModel", value: "claude-opus-4-8" },
      { method: "applyFlagSettings", value: { effortLevel: "high", fastMode: true } },
      { method: "setMaxThinkingTokens", value: { tokens: null, display: "summarized" } },
      { method: "setPermissionMode", value: "default" },
    ]);
    second.announce();
    second.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[1]?.status === "completed",
      "second ephemeral turn",
    );
    expect(fake.inputs).toHaveLength(1);
    expect(fake.prompts).toHaveLength(2);
    expect(service.readThread(started.thread.id, true).thread.turns).toHaveLength(2);
    await service.close();
  });

  it("defers last-write-wins ephemeral controls until the active lifecycle drains", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-ephemeral-control-race-"));
    directories.push(directory);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const base = { parent_tool_use_id: null, session_id: "ephemeral-settings" };
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined,
      [{
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "message_start", message: {} },
      }] as unknown as SDKMessage[],
      { afterIndex: 0, wait },
    );
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:sonnet", cwd: directory, ephemeral: true,
    });
    const first = await service.prepareTurn({
      threadId: started.thread.id,
      effort: "low",
      input: [{ type: "text", text: "stay active", text_elements: [] }],
    });
    first.announce();
    first.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.status.type === "active",
      "active ephemeral turn",
    );
    await service.updateThreadSettings({
      threadId: started.thread.id, model: "claude:claude-opus-4-8", effort: "high",
    });
    await service.updateThreadSettings({
      threadId: started.thread.id, model: "claude:sonnet", effort: "medium", serviceTier: "fast",
    });
    expect(fake.controls).toEqual([]);
    expect(fake.returnCalls).toBe(0);

    release();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.status.type === "idle",
      "ephemeral lifecycle drain",
    );
    expect(fake.controls).toEqual([]);
    const second = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "latest settings", text_elements: [] }],
    });
    expect(fake.controls).toEqual([
      { method: "setModel", value: "sonnet" },
      { method: "applyFlagSettings", value: { effortLevel: "medium", fastMode: true } },
      { method: "setMaxThinkingTokens", value: { tokens: null, display: null } },
      { method: "setPermissionMode", value: "default" },
    ]);
    second.announce();
    second.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[1]?.status === "completed",
      "latest-settings turn",
    );
    expect(service.readThread(started.thread.id, true).thread.turns[0]?.status).toBe("completed");
    await service.close();
  });

  it("does not submit an ephemeral turn when a provider control fails and converges on retry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-ephemeral-control-failure-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory, ephemeral: true });
    const first = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "establish context", text_elements: [] }],
    });
    first.announce();
    first.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "ephemeral context turn",
    );
    await service.updateThreadSettings({
      threadId: started.thread.id, model: "claude:claude-opus-4-8", effort: "high",
    });
    fake.failControlOnce = "applyFlagSettings";
    await expect(service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "must not send", text_elements: [] }],
    })).rejects.toThrow("fake applyFlagSettings failure");
    expect(fake.prompts).toHaveLength(1);
    expect(service.readThread(started.thread.id, true).thread.turns).toHaveLength(1);

    const retry = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "retry safely", text_elements: [] }],
    });
    retry.announce();
    retry.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[1]?.status === "completed",
      "retried ephemeral turn",
    );
    expect(fake.inputs).toHaveLength(1);
    expect(fake.prompts).toHaveLength(2);
    expect(fake.controls.filter((control) => control.method === "setModel")).toHaveLength(2);
    await service.close();
  });

  it("live-applies max effort while retaining initialization-bound ephemeral settings", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-ephemeral-init-only-"));
    const otherDirectory = mkdtempSync(join(tmpdir(), "codex-hybrid-ephemeral-other-cwd-"));
    directories.push(directory, otherDirectory);
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory, ephemeral: true });
    const first = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "first", text_elements: [] }],
    });
    first.announce();
    first.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "initial ephemeral turn",
    );

    await service.updateThreadSettings({
      threadId: started.thread.id, effort: "max",
    });
    expect(fake.controls).toEqual([]);
    const second = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "use max effort", text_elements: [] }],
    });
    expect(fake.controls).toContainEqual({
      method: "applyFlagSettings", value: { effortLevel: "max", fastMode: false },
    });
    second.announce();
    second.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[1]?.status === "completed",
      "max-effort ephemeral turn",
    );
    await expect(service.updateThreadSettings({
      threadId: started.thread.id, personality: "friendly",
    })).rejects.toThrow("Cannot change personality");
    await expect(service.updateThreadSettings({
      threadId: started.thread.id, cwd: otherDirectory,
    })).rejects.toThrow("Cannot change cwd");
    await expect(service.updateThreadSettings({
      threadId: started.thread.id,
      collaborationMode: {
        mode: "default",
        settings: { model: "claude:sonnet", reasoning_effort: null, developer_instructions: "new" },
      },
    })).rejects.toThrow("Cannot change collaboration instructions");
    await expect(service.prepareTurn({
      threadId: started.thread.id,
      outputSchema: { type: "object" },
      input: [{ type: "text", text: "schema", text_elements: [] }],
    })).rejects.toThrow("Cannot change output schema");
    expect(fake.prompts).toHaveLength(2);
    expect(service.readThread(started.thread.id, true).thread.turns).toHaveLength(2);
    await service.close();
  });

  it("live-applies max effort after an ephemeral turn is prepared but unsent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-ephemeral-staged-settings-"));
    const otherDirectory = mkdtempSync(join(tmpdir(), "codex-hybrid-ephemeral-staged-cwd-"));
    directories.push(directory, otherDirectory);
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory, ephemeral: true });
    const first = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "prepared but not sent", text_elements: [] }],
    });
    expect(fake.prompts).toHaveLength(0);

    await service.updateThreadSettings({
      threadId: started.thread.id, effort: "max",
    });
    await expect(service.updateThreadSettings({
      threadId: started.thread.id, personality: "friendly",
    })).rejects.toThrow("Cannot change personality");
    await expect(service.updateThreadSettings({
      threadId: started.thread.id, cwd: otherDirectory,
    })).rejects.toThrow("Cannot change cwd");
    await expect(service.updateThreadSettings({
      threadId: started.thread.id,
      collaborationMode: {
        mode: "default",
        settings: { model: "claude:sonnet", reasoning_effort: null, developer_instructions: "new" },
      },
    })).rejects.toThrow("Cannot change collaboration instructions");
    expect(service.currentThreadSettings(started.thread.id)).toMatchObject({
      cwd: directory, effort: "max", personality: null,
    });

    first.announce();
    first.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "staged ephemeral turn",
    );
    await service.close();
  });

  it("uses the latest ephemeral permission policy after switching out of full access", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-ephemeral-permission-controls-"));
    directories.push(directory);
    const input = { url: "https://example.com" };
    const fake = new FakeClaudeQuery({ name: "WebFetch", input });
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:sonnet",
      cwd: directory,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const first = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "full access", text_elements: [] }],
    });
    first.announce();
    first.start();
    await waitFor(() => fake.permissionResults.length === 1, "full-access permission");
    expect(fake.permissionResults[0]).toMatchObject({ behavior: "allow" });
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "full-access turn",
    );

    await service.updateThreadSettings({
      threadId: started.thread.id,
      approvalPolicy: "on-request",
      permissions: ":workspace",
    });
    const requests: string[] = [];
    hub.subscribe(started.thread.id, "ephemeral-permission", () => undefined, (id, method) => {
      requests.push(method);
      void service.resolveServerRequest(id, { decision: "decline" });
    });
    const second = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "request access", text_elements: [] }],
    });
    expect(fake.controls.at(-1)).toEqual({ method: "setPermissionMode", value: "default" });
    second.announce();
    second.start();
    await waitFor(() => fake.permissionResults.length === 2, "on-request permission");
    expect(requests).toEqual(["item/permissions/requestApproval"]);
    expect(fake.permissionResults[1]).toEqual({
      behavior: "deny",
      message: "User declined tool execution.",
      decisionClassification: "user_reject",
    });
    await service.close();
  });

  it("enables ephemeral bypass capability without widening the initial permission mode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-ephemeral-bypass-capability-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:sonnet",
      cwd: directory,
      ephemeral: true,
      approvalPolicy: "on-request",
      permissions: ":workspace",
    });
    const first = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "default permissions", text_elements: [] }],
    });
    expect(fake.inputs[0]?.options).toMatchObject({
      permissionMode: "default",
      allowDangerouslySkipPermissions: true,
    });
    first.announce();
    first.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "default-permission ephemeral turn",
    );

    await service.updateThreadSettings({
      threadId: started.thread.id,
      approvalPolicy: "never",
      permissions: ":danger-full-access",
    });
    const second = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "explicit full access", text_elements: [] }],
    });
    expect(fake.controls.at(-1)).toEqual({ method: "setPermissionMode", value: "bypassPermissions" });
    second.announce();
    second.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[1]?.status === "completed",
      "full-access ephemeral turn",
    );
    await service.close();
  });

  it("maps captured mobile fast/priority and reasoning envelopes for direct Opus", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-mobile-opus-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:claude-opus-4-8", serviceTier: "fast", cwd: directory });
    expect(fake.inputs).toHaveLength(0);

    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      model: "claude:claude-opus-4-8",
      serviceTier: "priority",
      effort: "xhigh",
      input: [{ type: "text", text: "test", text_elements: [] }],
    });
    expect(fake.inputs[0]?.options).toMatchObject({
      model: "claude-opus-4-8",
      settings: { fastMode: true },
      effort: "xhigh",
    });
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed"
        ? resolve()
        : setTimeout(poll, 5);
      poll();
    });
    await service.close();
  });

  it("keeps captured App collaboration effort when turn/start top-level effort is null", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-collaboration-effort-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    const settings: Array<{ threadSettings: { effort: string | null; collaborationMode: unknown } }> = [];
    hub.subscribe(started.thread.id, "captured-effort", (method, params) => {
      if (method === "thread/settings/updated") settings.push(params as typeof settings[number]);
    });

    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      effort: null,
      collaborationMode: {
        mode: "default",
        settings: { model: "claude:sonnet", reasoning_effort: "low", developer_instructions: null },
      },
      input: [{ type: "text", text: "captured App turn", text_elements: [] }],
    });

    expect(service.currentThreadSettings(started.thread.id)).toMatchObject({
      effort: "low",
      collaborationMode: { settings: { model: "claude:sonnet", reasoning_effort: "low" } },
    });
    expect(settings).toContainEqual(expect.objectContaining({
      threadSettings: expect.objectContaining({
        effort: "low",
        collaborationMode: expect.objectContaining({
          settings: expect.objectContaining({ reasoning_effort: "low" }),
        }),
      }),
    }));
    expect(fake.inputs[0]?.options).toMatchObject({ model: "sonnet", effort: "low" });

    prepared.announce();
    prepared.start();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed"
        ? resolve()
        : setTimeout(poll, 5);
      poll();
    });
    await service.close();
  });

  it("replays the captured mobile direct Fable-to-Opus settings and turn sequence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-mobile-model-switch-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery(undefined, undefined, [], true);
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:claude-fable-5", cwd: directory, approvalPolicy: "never", sandbox: "danger-full-access",
      dynamicTools: [{
        type: "namespace", name: "codex_app", description: "mobile tools", tools: [{
          type: "function", name: "read_thread", description: "read", inputSchema: { type: "object" },
        }],
      }],
    });
    expect(fake.inputs).toHaveLength(0);

    const runTurn = async (model: string, serviceTier?: string) => {
      let terminal = false;
      const connectionId = randomUUID();
      hub.subscribe(started.thread.id, connectionId, (method) => {
        if (method === "turn/completed") terminal = true;
      });
      const prepared = await service.prepareTurn({
        threadId: started.thread.id, model, effort: "high", ...(serviceTier ? { serviceTier } : {}),
        input: [{ type: "text", text: "mobile turn", text_elements: [] }],
      });
      prepared.announce();
      prepared.start();
      await new Promise<void>((resolve) => {
        const poll = () => terminal ? resolve() : setTimeout(poll, 5);
        poll();
      });
      hub.unsubscribe(started.thread.id, connectionId);
    };

    await runTurn("claude:claude-fable-5");
    expect(fake.inputs.at(-1)?.options).toMatchObject({ model: "claude-fable-5", effort: "high" });
    await runTurn("claude:claude-fable-5");

    await service.updateThreadSettings({
      threadId: started.thread.id, model: "claude:claude-opus-4-8", serviceTier: null, effort: "high",
    });
    expect(service.currentThreadSettings(started.thread.id)).toMatchObject({
      model: "claude:claude-opus-4-8",
      effort: "high",
      collaborationMode: { settings: { model: "claude:claude-opus-4-8", reasoning_effort: "high" } },
    });
    await service.updateThreadSettings({
      threadId: started.thread.id, model: "claude:claude-opus-4-8", serviceTier: "fast", effort: "high",
    });
    await runTurn("claude:claude-opus-4-8", "priority");
    expect(fake.inputs.at(-1)?.options).toMatchObject({
      model: "claude-opus-4-8", effort: "high", settings: { fastMode: true },
    });
    await service.compactThread(started.thread.id);
    expect(service.readThread(started.thread.id, true).thread.turns.at(-1)?.items)
      .toContainEqual(expect.objectContaining({ type: "contextCompaction" }));
    await service.close();
  });

  it("defers active-turn settings with last-write-wins until the real terminal boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-deferred-settings-"));
    directories.push(directory);
    let releaseParent!: () => void;
    const parentWait = new Promise<void>((resolve) => { releaseParent = resolve; });
    const base = { parent_tool_use_id: null, session_id: "settings-parent" };
    const parent = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined,
      [{
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "message_start", message: {} },
      }, {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "test" } },
      }, {
        type: "stream_event", uuid: randomUUID(), ...base,
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Parent still running" } },
      }] as unknown as SDKMessage[],
      { afterIndex: 2, wait: parentWait },
    );
    const next = new FakeClaudeQuery();
    const runtimes = [parent, next];
    let runtimeIndex = 0;
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      (input) => runtimes[runtimeIndex++]!.factory(input),
    );
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory });
    await service.updateThreadSettings({ threadId: started.thread.id, effort: "medium" });
    const events: Array<{ method: string; params: unknown }> = [];
    hub.subscribe(started.thread.id, "settings-test", (method, params) => events.push({ method, params }));
    const first = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "run background lifecycle", text_elements: [] }],
    });
    first.announce();
    first.start();
    await new Promise<void>((resolve) => {
      const poll = () => events.some((event) => event.method === "item/reasoning/summaryTextDelta") ? resolve() : setTimeout(poll, 5);
      poll();
    });
    events.length = 0;

    const updateStarted = performance.now();
    await service.updateThreadSettings({
      ...deferredSettingsUpdate,
      threadId: started.thread.id,
    });
    await service.updateThreadSettings({
      threadId: started.thread.id,
      model: "claude:claude-opus-4-8",
      serviceTier: "fast",
      effort: "low",
      approvalPolicy: "never",
      permissions: ":danger-full-access",
    });
    expect(performance.now() - updateStarted).toBeLessThan(250);
    expect(service.currentThreadSettings(started.thread.id)).toMatchObject({
      model: "claude:claude-opus-4-8",
      serviceTier: "fast",
      effort: "low",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    expect(parent.inputs[0]?.options).toMatchObject({ model: "claude-fable-5", effort: "medium", permissionMode: "default" });
    expect(parent.returnCalls).toBe(0);
    expect(runtimeIndex).toBe(1);
    expect(service.readThread(started.thread.id, true).thread.status.type).toBe("active");
    expect(events.filter((event) => event.method === "thread/settings/updated").map((event) =>
      (event.params as { threadSettings: { effort: string } }).threadSettings.effort)).toEqual(["high", "low"]);
    expect(events.some((event) => event.method === "error" || event.method === "turn/completed")).toBe(false);
    expect(events.some((event) => event.method === "thread/status/changed"
      && (event.params as { status?: { type?: string } }).status?.type !== "active")).toBe(false);

    releaseParent();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.status.type === "idle" ? resolve() : setTimeout(poll, 5);
      poll();
    });
    await new Promise<void>((resolve) => {
      const poll = () => parent.returnCalls === 1 ? resolve() : setTimeout(poll, 5);
      poll();
    });
    const original = service.readThread(started.thread.id, true).thread.turns[0]!;
    expect(original).toMatchObject({ status: "completed", error: null });
    expect(events.filter((event) => event.method === "turn/completed")).toHaveLength(1);

    const second = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "use latest settings", text_elements: [] }],
    });
    expect(next.inputs[0]?.options).toMatchObject({
      model: "claude-opus-4-8",
      effort: "low",
      settings: { fastMode: true },
      permissionMode: "bypassPermissions",
    });
    second.announce();
    second.start();
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed"
        ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(runtimeIndex).toBe(2);
    await service.close();
  });

  it("freezes the applied permission policy for an approval already in flight", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-deferred-permission-"));
    directories.push(directory);
    const current = new FakeClaudeQuery({ name: "Bash", input: { command: "curl -s example.com" } });
    const next = new FakeClaudeQuery();
    let runtimeIndex = 0;
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      (input) => (runtimeIndex++ === 0 ? current : next).factory(input),
    );
    const started = await service.startThread({
      model: "claude:claude-fable-5",
      cwd: directory,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    let requestId: string | undefined;
    hub.subscribe(started.thread.id, "permission-race", () => undefined, (id) => { requestId = id; });
    const turn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "curl it", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await new Promise<void>((resolve) => {
      const poll = () => requestId ? resolve() : setTimeout(poll, 5);
      poll();
    });

    await service.updateThreadSettings({
      threadId: started.thread.id,
      approvalPolicy: "never",
      permissions: ":danger-full-access",
    });
    expect(service.currentThreadSettings(started.thread.id)).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    expect(current.inputs[0]?.options.permissionMode).toBe("default");
    expect(current.permissionResults).toEqual([]);
    expect(current.returnCalls).toBe(0);
    expect(current.inputs[0]?.options.canUseTool).toBeTypeOf("function");

    await expect(service.resolveServerRequest(requestId!, { decision: "accept" })).resolves.toBe(true);
    await new Promise<void>((resolve) => {
      const poll = () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed"
        ? resolve() : setTimeout(poll, 5);
      poll();
    });
    expect(current.permissionResults[0]).toMatchObject({ behavior: "allow" });
    await new Promise<void>((resolve) => {
      const poll = () => current.returnCalls === 1 ? resolve() : setTimeout(poll, 5);
      poll();
    });

    await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "next policy", text_elements: [] }],
    });
    expect(next.inputs[0]?.options.permissionMode).toBe("bypassPermissions");
    await service.close();
  });

  it("keeps the selected runtime reserved while turn input staging races a settings update", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-staged-settings-"));
    directories.push(directory);
    const current = new FakeClaudeQuery();
    const next = new FakeClaudeQuery();
    let runtimeIndex = 0;
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      (input) => (runtimeIndex++ === 0 ? current : next).factory(input),
    );
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory });
    await service.resumeThread(started.thread.id);
    const session = await (service as unknown as {
      sessions: { getOrCreate(threadId: string): Promise<ClaudeSession> };
    }).sessions.getOrCreate(started.thread.id);
    const originalPrepare = session.prepareRuntimeTurn.bind(session);
    let stagingStarted!: () => void;
    const staged = new Promise<void>((resolve) => { stagingStarted = resolve; });
    let releaseStaging!: () => void;
    const stagingBarrier = new Promise<void>((resolve) => { releaseStaging = resolve; });
    session.prepareRuntimeTurn = async (...args: Parameters<typeof session.prepareRuntimeTurn>) => {
      const result = await originalPrepare(...args);
      stagingStarted();
      await stagingBarrier;
      return result;
    };

    const preparing = service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "reserved generation", text_elements: [] }],
    });
    await staged;
    await service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });
    expect(current.returnCalls).toBe(0);
    releaseStaging();
    const turn = await preparing;
    turn.announce();
    turn.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "reserved turn completion",
    );
    expect(current.prompts).toHaveLength(1);
    await waitFor(() => current.returnCalls === 1, "reserved runtime retirement");

    await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "latest settings", text_elements: [] }],
    });
    expect(next.inputs[0]?.options.effort).toBe("high");
    await service.close();
  });

  it("does not retire a settings-stale runtime while its background Bash and output tailer can continue", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-deferred-background-"));
    directories.push(directory);
    const outputFile = join(directory, "background.output");
    writeFileSync(outputFile, "BG_DONE\n");
    let releaseBackground!: () => void;
    const backgroundWait = new Promise<void>((resolve) => { releaseBackground = resolve; });
    const base = { session_id: "background-settings" };
    const toolUseId = "background-tool";
    const taskId = "background-task";
    const current = new FakeClaudeQuery(
      undefined, undefined,
      [
        { type: "system", subtype: "background_tasks_changed", tasks: [], uuid: randomUUID(), ...base },
        {
          type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: toolUseId,
          status: "completed", output_file: outputFile, summary: "Background command completed (exit code 0)",
          usage: { total_tokens: 0, tool_uses: 1, duration_ms: 1_000 }, uuid: randomUUID(), ...base,
        },
      ] as unknown as SDKMessage[],
      false, undefined, undefined, undefined,
      [
        {
          type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
          event: { type: "message_start", message: {} },
        },
        {
          type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
          event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolUseId, name: "Bash", input: {} } },
        },
        {
          type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
          event: {
            type: "content_block_delta", index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "sleep 1; echo BG_DONE", run_in_background: true }) },
          },
        },
        {
          type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
          event: { type: "content_block_stop", index: 0 },
        },
        {
          type: "user", parent_tool_use_id: null, uuid: randomUUID(), ...base,
          message: { role: "user", content: [{
            type: "tool_result", tool_use_id: toolUseId,
            content: `Command running in background with ID: ${taskId}. Output is being written to: ${outputFile}.`,
          }] },
          tool_use_result: { stdout: "", stderr: "", backgroundTaskId: taskId },
        },
        {
          type: "system", subtype: "background_tasks_changed",
          tasks: [{ task_id: taskId, task_type: "bash", description: "background settings race" }],
          uuid: randomUUID(), ...base,
        },
        {
          type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId,
          task_type: "bash", description: "background settings race", uuid: randomUUID(), ...base,
        },
      ] as unknown as SDKMessage[],
      { afterIndex: 6, wait: backgroundWait },
    );
    const next = new FakeClaudeQuery();
    let runtimeIndex = 0;
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      (input) => (runtimeIndex++ === 0 ? current : next).factory(input),
    );
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory });
    const events: string[] = [];
    hub.subscribe(started.thread.id, "background-settings", (method) => events.push(method));
    const turn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "run background", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.items
      .some((item) => item.type === "commandExecution" && item.status === "inProgress") ?? false, "background command start");

    await service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });
    expect(current.returnCalls).toBe(0);
    expect(events.filter((method) => method === "turn/completed")).toHaveLength(0);
    releaseBackground();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "background parent completion",
    );
    expect(service.readThread(started.thread.id, true).thread.turns[0]?.items).toContainEqual(expect.objectContaining({
      type: "commandExecution", status: "completed", aggregatedOutput: "BG_DONE\n",
    }));
    expect(events.filter((method) => method === "turn/completed")).toHaveLength(1);
    await waitFor(() => current.returnCalls === 1, "stale background runtime retirement");

    await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "next generation", text_elements: [] }],
    });
    expect(next.inputs[0]?.options.effort).toBe("high");
    await service.close();
  });

  it("keeps a settings-stale runtime leased while a subagent is nonterminal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-deferred-subagent-"));
    directories.push(directory);
    let releaseChild!: () => void;
    const childWait = new Promise<void>((resolve) => { releaseChild = resolve; });
    const base = { session_id: "subagent-settings" };
    const toolUseId = "settings-agent-tool";
    const taskId = "settings-agent-task";
    const current = new FakeClaudeQuery(
      undefined, undefined,
      [
        {
          type: "assistant", parent_tool_use_id: toolUseId, uuid: randomUUID(), ...base,
          message: { role: "assistant", content: [{ type: "text", text: "Child completed after settings update." }] },
        },
        {
          type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: toolUseId,
          status: "completed", output_file: join(directory, "unused"), summary: "Child completed",
          usage: { total_tokens: 3, tool_uses: 0, duration_ms: 10 }, uuid: randomUUID(), ...base,
        },
      ] as unknown as SDKMessage[],
      false, undefined, undefined, undefined,
      [
        { type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base, event: { type: "message_start", message: {} } },
        {
          type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
          event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolUseId, name: "Agent", input: {} } },
        },
        {
          type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base,
          event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ prompt: "inspect settings race" }) } },
        },
        { type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), ...base, event: { type: "content_block_stop", index: 0 } },
        {
          type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId,
          task_type: "agent", subagent_type: "Explore", description: "inspect settings race", uuid: randomUUID(), ...base,
        },
      ] as unknown as SDKMessage[],
      { afterIndex: 4, wait: childWait },
    );
    const next = new FakeClaudeQuery();
    let runtimeIndex = 0;
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      (input) => (runtimeIndex++ === 0 ? current : next).factory(input),
    );
    const started = await service.startThread({ model: "claude:claude-fable-5", cwd: directory });
    const turn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "spawn child", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns[0]?.items
      .some((item) => item.type === "collabAgentToolCall" && item.status === "inProgress") ?? false, "subagent start");

    await service.updateThreadSettings({ threadId: started.thread.id, effort: "high" });
    expect(current.returnCalls).toBe(0);
    releaseChild();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "parent completion after child",
    );
    const collab = service.readThread(started.thread.id, true).thread.turns[0]?.items
      .find((item) => item.type === "collabAgentToolCall");
    const childThreadId = collab?.type === "collabAgentToolCall" ? collab.receiverThreadIds[0] : undefined;
    expect(childThreadId && service.readThread(childThreadId, true).thread.turns[0]).toMatchObject({ status: "completed" });
    await waitFor(() => current.returnCalls === 1, "stale subagent runtime retirement");
    await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "next generation", text_elements: [] }],
    });
    expect(next.inputs[0]?.options.effort).toBe("high");
    await service.close();
  });

  it("supports explicit custom aliases and recovers serialized ANSI residue", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-mobile-fable-"));
    directories.push(directory);
    const aliasFake = new FakeClaudeQuery();
    const alias = new ClaudeService(
      { ...config(directory), modelAliases: { "custom-claude-fable": "claude-fable-5" } },
      new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "alias.sqlite")), aliasFake.factory,
    );
    expect(alias.ownsModel("custom-claude-fable")).toBe(true);
    const aliasThread = await alias.startThread({ model: "custom-claude-fable", cwd: directory });
    expect(aliasFake.inputs).toHaveLength(0);
    await alias.prepareTurn({
      threadId: aliasThread.thread.id,
      input: [{ type: "text", text: "materialize alias", text_elements: [] }],
    });
    expect(aliasFake.inputs[0]?.options.model).toBe("claude-fable-5");
    await alias.close();

    const residueFake = new FakeClaudeQuery();
    const residue = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "residue.sqlite")), residueFake.factory,
    );
    const residueThread = await residue.startThread({ model: "claude:claude-fable-5[1m]", cwd: directory });
    expect(residueFake.inputs).toHaveLength(0);
    await residue.prepareTurn({
      threadId: residueThread.thread.id,
      input: [{ type: "text", text: "materialize residue", text_elements: [] }],
    });
    expect(residueFake.inputs[0]?.options.model).toBe("claude-fable-5");
    await residue.close();
  });

  it("reports a moved mobile project path instead of a fake Claude libc failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-missing-cwd-"));
    directories.push(directory);
    const missing = join(directory, "moved-project");
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    await expect(service.startThread({ model: "claude:claude-fable-5", cwd: missing }))
      .rejects.toThrow(`Claude thread cwd '${missing}' does not exist or is not a directory.`);
    expect(fake.inputs).toHaveLength(0);
    await service.close();
  });

  it("maps built-in Codex permission profiles used by Codex App turns", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-permission-profile-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:claude-fable-5", cwd: directory, permissions: ":read-only",
    });
    expect(started.sandbox).toEqual({ type: "readOnly", networkAccess: false });

    const settings: unknown[] = [];
    hub.subscribe(started.thread.id, "test", (method, params) => {
      if (method === "thread/settings/updated") settings.push(params);
    });
    await service.prepareTurn({
      threadId: started.thread.id,
      permissions: ":danger-full-access",
      input: [{ type: "text", text: "test", text_elements: [] }],
    });
    expect(settings).toContainEqual(expect.objectContaining({
      threadSettings: expect.objectContaining({ sandboxPolicy: { type: "dangerFullAccess" } }),
    }));
    expect(fake.inputs).toHaveLength(1);
    await expect(service.updateThreadSettings({
      threadId: started.thread.id, permissions: "custom-profile",
    })).rejects.toThrow("do not support Codex permission profile");
    await service.close();
  });

  it("downgrades mobile Fast to Standard when Fable does not advertise it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-fable-fast-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const catalog = { list: async () => [{
      id: "claude:claude-fable-5", model: "claude:claude-fable-5", upgrade: null, upgradeInfo: null,
      availabilityNux: null, displayName: "Fable", description: "test", hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "xhigh", description: "Extra high" }],
      defaultReasoningEffort: "xhigh", inputModalities: ["text" as const], supportsPersonality: true,
      additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, isDefault: false,
    }] };
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory, catalog,
    );
    const started = await service.startThread({
      model: "claude:claude-fable-5", serviceTier: "priority", cwd: directory,
    });
    expect(started).toMatchObject({
      model: "claude:claude-fable-5",
      modelProvider: "claude",
      serviceTier: null,
    });
    expect(service.currentThreadSettings(started.thread.id)).toMatchObject({
      model: "claude:claude-fable-5",
      serviceTier: null,
    });
    expect(fake.inputs).toHaveLength(0);
    await service.close();
  });

  it("downgrades captured inherited App priority to Standard for Fable and still runs the turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-fable-inherited-fast-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const hub = new SubscriptionHub();
    const catalog = { list: async () => [{
      id: "claude:claude-fable-5", model: "claude:claude-fable-5", upgrade: null, upgradeInfo: null,
      availabilityNux: null, displayName: "Fable", description: "test", hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "xhigh", description: "Extra high" }],
      defaultReasoningEffort: "xhigh", inputModalities: ["text" as const], supportsPersonality: true,
      additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, isDefault: false,
    }] };
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory, catalog,
    );
    const started = await service.startThread({
      model: "claude:claude-fable-5", serviceTier: null, cwd: directory,
    });
    const settings: unknown[] = [];
    hub.subscribe(started.thread.id, "captured-fable-priority", (method, params) => {
      if (method === "thread/settings/updated") settings.push(params);
    });

    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      model: "claude:claude-fable-5",
      serviceTier: "priority",
      effort: "xhigh",
      input: [{ type: "text", text: "Reply exactly OK", text_elements: [] }],
    });
    expect(service.currentThreadSettings(started.thread.id)).toMatchObject({
      model: "claude:claude-fable-5",
      serviceTier: null,
      effort: "xhigh",
    });
    expect(settings).toContainEqual(expect.objectContaining({
      threadSettings: expect.objectContaining({
        model: "claude:claude-fable-5",
        serviceTier: null,
        effort: "xhigh",
      }),
    }));
    expect(fake.inputs[0]?.options).toMatchObject({ model: "claude-fable-5", effort: "xhigh" });
    expect(fake.inputs[0]?.options.settings).not.toEqual(
      expect.objectContaining({ fastMode: true }),
    );

    prepared.announce();
    prepared.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "Fable inherited-priority turn",
    );
    await service.close();
  });

  it("downgrades literal fast to Standard for Fable and still runs the turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-fable-literal-fast-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const hub = new SubscriptionHub();
    const catalog = { list: async () => [{
      id: "claude:claude-fable-5", model: "claude:claude-fable-5", upgrade: null, upgradeInfo: null,
      availabilityNux: null, displayName: "Fable", description: "test", hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "xhigh", description: "Extra high" }],
      defaultReasoningEffort: "xhigh", inputModalities: ["text" as const], supportsPersonality: true,
      additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, isDefault: false,
    }] };
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory, catalog,
    );
    const started = await service.startThread({
      model: "claude:claude-fable-5", serviceTier: null, cwd: directory,
    });
    const settings: unknown[] = [];
    hub.subscribe(started.thread.id, "captured-fable-literal-fast", (method, params) => {
      if (method === "thread/settings/updated") settings.push(params);
    });

    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      model: "claude:claude-fable-5",
      serviceTier: "fast",
      effort: "xhigh",
      input: [{ type: "text", text: "Reply exactly OK", text_elements: [] }],
    });
    expect(service.currentThreadSettings(started.thread.id)).toMatchObject({
      model: "claude:claude-fable-5",
      serviceTier: null,
      effort: "xhigh",
    });
    expect(settings).toContainEqual(expect.objectContaining({
      threadSettings: expect.objectContaining({
        model: "claude:claude-fable-5",
        serviceTier: null,
        effort: "xhigh",
      }),
    }));
    expect(fake.inputs[0]?.options.settings).not.toEqual(
      expect.objectContaining({ fastMode: true }),
    );

    prepared.announce();
    prepared.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "completed",
      "Fable literal-fast turn",
    );
    await service.close();
  });

  it("keeps Claude model, speed, and effort across an omitted-settings fork", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-fork-settings-fidelity-"));
    directories.push(directory);
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      store, new FakeClaudeQuery().factory,
    );
    const source = await service.startThread({
      model: "claude:claude-opus-4-8", serviceTier: "fast", cwd: directory,
    });
    await service.updateThreadSettings({
      threadId: source.thread.id,
      model: "claude:claude-opus-4-8",
      serviceTier: "fast",
      effort: "high",
    });
    store.createTurn(source.thread.id, {
      id: "completed-provider-turn",
      items: [{
        type: "agentMessage", id: "provider-answer", text: "OK",
        phase: "final_answer", memoryCitation: null,
      }],
      itemsView: "full", status: "completed", error: null,
      startedAt: 1, completedAt: 2, durationMs: 1_000,
    });
    const sourceBefore = structuredClone(service.readThread(source.thread.id, true).thread);

    const inherited = await service.forkThread({ threadId: source.thread.id });
    expect(inherited).toMatchObject({
      model: "claude:claude-opus-4-8",
      modelProvider: "claude",
      serviceTier: "fast",
      reasoningEffort: "high",
      thread: { turns: [{ id: "completed-provider-turn" }] },
    });
    expect(service.readThread(source.thread.id, true).thread).toEqual(sourceBefore);

    await service.updateThreadSettings({
      threadId: source.thread.id,
      model: "claude:sonnet",
      serviceTier: "default",
      effort: "low",
    });
    const explicitlyChanged = await service.forkThread({ threadId: source.thread.id });
    expect(explicitlyChanged).toMatchObject({
      model: "claude:sonnet",
      modelProvider: "claude",
      serviceTier: "default",
      reasoningEffort: "low",
    });
    await service.close();
  });

  it("forks the latest durable Claude boundary when a transient CCodex message has no lastTurnId", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-fork-transient-notice-"));
    directories.push(directory);
    const store = new SqliteHybridStore(join(directory, "state.sqlite"));
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      store, new FakeClaudeQuery().factory,
    );
    const source = await service.startThread({ model: "claude:sonnet", cwd: directory });
    for (const [index, id] of ["provider-turn-a", "provider-turn-b"].entries()) {
      store.createTurn(source.thread.id, {
        id,
        items: [{
          type: "agentMessage", id: `provider-answer-${index}`, text: `answer ${index}`,
          phase: "final_answer", memoryCitation: null,
        }],
        itemsView: "full", status: "completed", error: null,
        startedAt: index * 2 + 1, completedAt: index * 2 + 2, durationMs: 1_000,
      });
    }

    // Transient CCodex turns are intentionally not persisted. App therefore
    // sends no durable lastTurnId when forking from their visible message.
    const fork = await service.forkThread({ threadId: source.thread.id });
    expect(fork.thread.turns.map((turn) => turn.id)).toEqual([
      "provider-turn-a",
      "provider-turn-b",
    ]);
    await expect(service.forkThread({
      threadId: source.thread.id,
      lastTurnId: "transient-ccodex-turn",
    })).rejects.toThrow("Unknown Claude turn 'transient-ccodex-turn'");
    await service.close();
  });

  it("evicts a runtime that exits during an active turn and rematerializes the next turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-runtime-exit-"));
    directories.push(directory);
    const crashed = new FakeClaudeQuery(undefined, {
      name: "Bash", input: { command: "sleep 10" }, execute: () => new Promise<void>(() => undefined),
    });
    const replacement = new FakeClaudeQuery();
    let generations = 0;
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      (input) => (++generations === 1 ? crashed : replacement).factory(input),
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const first = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "crash", text_elements: [] }],
    });
    first.announce(); first.start();
    await waitFor(() => crashed.prompts.length === 1, "first runtime input");
    crashed.exit();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "failed",
      "provider exit projection",
    );
    expect(service.readThread(started.thread.id, true).thread.turns[0]).toMatchObject({
      status: "failed", error: { message: "Claude runtime exited before the turn completed." },
    });
    expect(service.loadedThreadIds()).not.toContain(started.thread.id);

    const second = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "resume", text_elements: [] }],
    });
    second.announce(); second.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed",
      "replacement turn",
    );
    expect(generations).toBe(2);
    await service.close();
  });

  it("does not install a runtime whose provider exits before service ownership is published", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-early-runtime-exit-"));
    directories.push(directory);
    const replacement = new FakeClaudeQuery();
    let generations = 0;
    const dead = {
      next: async () => ({ value: undefined, done: true as const }),
      return: async () => ({ value: undefined, done: true as const }),
      throw: async (error?: unknown) => Promise.reject(error),
      [Symbol.asyncIterator]() { return this; },
      initializationResult: async () => ({}),
      getContextUsage: async () => ({ totalTokens: 0, maxTokens: 200_000 }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({}),
      reinitialize: async () => ({}),
      stopTask: async () => undefined,
      interrupt: async () => undefined,
    } as unknown as ReturnType<typeof replacement.factory>;
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      (input) => (++generations === 1 ? dead : replacement.factory(input)),
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    await expect(service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "fresh runtime", text_elements: [] }],
    })).rejects.toThrow("became unavailable during initialization");
    const turn = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "fresh retry", text_elements: [] }],
    });
    turn.announce(); turn.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed",
      "turn after early runtime exit",
    );
    expect(generations).toBe(2);
    await service.close();
  });

  it("retires a Stop-raced runtime before accepting the next turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-stop-raced-runtime-"));
    directories.push(directory);
    const blocked = new FakeClaudeQuery(undefined, {
      name: "Bash", input: { command: "sleep 10" }, execute: () => new Promise<void>(() => undefined),
    });
    blocked.interruptReceipt = true;
    blocked.cancelAsyncMessages = false;
    const replacement = new FakeClaudeQuery();
    let generations = 0;
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      (input) => (++generations === 1 ? blocked : replacement).factory(input),
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const first = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "race stop", text_elements: [] }],
    });
    first.announce(); first.start();
    await waitFor(() => blocked.prompts.length === 1, "raced runtime input");
    await service.interruptTurn({ threadId: started.thread.id, turnId: first.response.turn.id });
    expect(service.readThread(started.thread.id, true).thread.turns[0]?.status).toBe("interrupted");
    expect(blocked.interruptCalls).toBe(1);
    expect(blocked.returnCalls).toBe(1);
    expect(service.loadedThreadIds()).not.toContain(started.thread.id);
    const second = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "fresh after race", text_elements: [] }],
    });
    second.announce(); second.start();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed",
      "turn after raced Stop",
    );
    expect(generations).toBe(2);
    await service.close();
  });
});
