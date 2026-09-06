import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeService } from "../../src/claude/service.js";
import { DEFAULT_RENAME_PROMPT, type HybridConfig } from "../../src/config/config.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { CrossProviderForks } from "../../src/handoff/service.js";
import { HandoffStore } from "../../src/handoff/store.js";
import { Logger } from "../../src/observability/logger.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function harness(customTitle?: string, renamePrompt: string | null = DEFAULT_RENAME_PROMPT) {
  const directory = mkdtempSync(join(tmpdir(), "ccodex-generated-title-"));
  const config: HybridConfig = {
    realCodex: "/bin/false", claudeBinary: "/bin/false", dataDir: directory,
    publicSocket: join(directory, "gateway.sock"), modelPrefix: "claude:",
    idleTimeoutSeconds: 900, modelCacheSeconds: 300, logLevel: "error",
    logPrompts: false, debugCapture: false, debugLogMaxBytes: 1_048_576,
  };
  const database = join(directory, "state.sqlite");
  const hub = new SubscriptionHub();
  const store = new SqliteHybridStore(database);
  let threadId = "";
  const service = new ClaudeService(
    config, hub, new Logger("error"), store, new FakeClaudeQuery().factory,
    undefined, undefined, undefined,
    { rename: async () => undefined, delete: async () => undefined },
    undefined, undefined, undefined,
    async () => [{
      sessionId: store.getThreadRecord(threadId, false)!.claudeSessionId,
      summary: "Native title without emoji", ...(customTitle ? { customTitle } : {}), lastModified: Date.now(),
    }],
  );
  const handoffs = new CrossProviderForks(new HandoffStore(join(directory, "handoffs.sqlite")), service, renamePrompt);
  threadId = (await service.startThread({ model: "claude:haiku", cwd: directory })).thread.id;
  cleanups.push(async () => {
    handoffs.close();
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const prompt = "Research fill-conditioned maker orders. ".repeat(80);
  await service.prepareAppTurn({ threadId, input: [{ type: "text", text: prompt, text_elements: [] }] });
  handoffs.observeDurableThread("phone", "claude", threadId);
  const events: Array<{ method: string; params: unknown }> = [];
  hub.subscribe(threadId, "phone", (method, params) => events.push({ method, params }));
  const title = "🧪 Fill-Conditioned Frontier ✳️";
  const prepareTitle = (userPrompt = prompt.slice(0, 2_000), connection = "phone") => {
    handoffs.registerForwardedEphemeralCandidate(connection, "worker", { model: "gpt-5.4-mini", ephemeral: true });
    handoffs.prepareTitleTurn(connection, {
      threadId: "worker",
      input: [{ type: "text", text: "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task.\n\nUser prompt:\n" + userPrompt, text_elements: [] }],
      outputSchema: { type: "object", properties: { title: { type: "string", maxLength: 36 } }, required: ["title"] },
    });
    handoffs.rewriteTitleMessages({
      method: "item/completed",
      params: { threadId: "worker", turnId: "title-turn", item: { type: "agentMessage", id: "title-item", text: JSON.stringify({ title }) } },
    });
  };
  const complete = (status = "completed") => handoffs.persistGeneratedTitle({
    method: "turn/completed", params: { threadId: "worker", turn: { status } },
  });
  return { service, handoffs, threadId, prompt, title, events, prepareTitle, complete, config, database };
}

describe("generated Claude title persistence", () => {
  it("saves the iPhone result without name/set and retains it after restart and native metadata refresh", async () => {
    const h = await harness();
    h.prepareTitle();
    // Opening another thread while the worker runs must not change its target.
    h.handoffs.observeDurableThread("phone", "claude", "another-thread");
    await h.complete();
    await h.complete();
    await h.service.refreshNativeMetadata();
    expect(h.service.readThread(h.threadId, false).thread.name).toBe(h.title);
    expect(h.events.filter((event) => event.method === "thread/name/updated")).toEqual([
      { method: "thread/name/updated", params: { threadId: h.threadId, threadName: h.title } },
    ]);
    await h.service.close();
    const reopened = new ClaudeService(
      h.config, new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(h.database), new FakeClaudeQuery().factory,
    );
    try {
      await reopened.ready();
      expect(reopened.listThreads({})[0]?.name).toBe(h.title);
      expect(reopened.readThread(h.threadId, false).thread.name).toBe(h.title);
      expect((await reopened.resumeThread({ threadId: h.threadId, excludeTurns: true })).thread.name).toBe(h.title);
    } finally { await reopened.close(); }
  });

  it.each(["before", "concurrent", "after"])("keeps a manual rename made %s automatic persistence", async (order) => {
    const h = await harness();
    h.prepareTitle();
    const manual = () => h.service.setThreadName({ threadId: h.threadId, name: "My manual name" });
    if (order === "before") { await manual(); await h.complete(); }
    else if (order === "after") { await h.complete(); await manual(); }
    else await Promise.all([manual(), h.complete()]);
    expect(h.service.readThread(h.threadId, false).thread.name).toBe("My manual name");
  });

  it("preserves a native Claude custom title", async () => {
    const h = await harness("Native manual name");
    await h.service.refreshNativeMetadata();
    h.prepareTitle();
    await h.complete();
    expect(h.service.readThread(h.threadId, false).thread.name).toBe("Native manual name");
    expect(h.events.filter((event) => event.method === "thread/name/updated")).toEqual([]);
  });

  it.each(["An unrelated task in another tab", "Research fill-conditioned maker orders."])("rejects an unrelated or incomplete first prompt: %s", async (prompt) => {
    const h = await harness();
    h.prepareTitle(prompt);
    await h.complete();
    expect(h.service.readThread(h.threadId, false).thread.name).toBeNull();
  });

  it.each(["failed", "interrupted"])("does not save output from a %s title turn", async (status) => {
    const h = await harness();
    h.prepareTitle();
    await h.complete(status);
    expect(h.service.readThread(h.threadId, false).thread.name).toBeNull();
  });

  it("does not guess an owner on another connection", async () => {
    const h = await harness();
    h.prepareTitle(h.prompt, "unowned");
    await h.complete();
    expect(h.service.readThread(h.threadId, false).thread.name).toBeNull();
  });

  it("keeps automatic persistence disabled when rename_prompt is absent", async () => {
    const h = await harness(undefined, null);
    h.prepareTitle();
    await h.complete();
    expect(h.service.readThread(h.threadId, false).thread.name).toBeNull();
  });
});
