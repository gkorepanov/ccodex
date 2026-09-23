import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, fakeQuery } from "../fixtures/fakeClaude.js";
import { startTestGateway, type Client, type TestGateway } from "./harness.js";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ccodex-claude-"));
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "ccodex-codex-home-"));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...await importOriginal<object>(),
  query: fakeQuery,
}));
vi.setConfig({ testTimeout: 30_000 });

const CLAUDE = "claude:claude-opus-5-5";
const text = (value: string) => [{ type: "text", text: value, text_elements: [] }];
const itemsOf = (turns: any[]) => turns.flatMap((turn) => turn.items.map((item: any) => item.type === "userMessage"
  ? `user:${item.content[0]?.text}` : item.type === "agentMessage" ? `agent:${item.text}` : item.type));

let gateway: TestGateway;
let client: Client;

async function claudeThread(): Promise<string> {
  const { thread } = await client.request("thread/start", { model: CLAUDE, cwd: "/work" });
  return thread.id;
}

async function stockThread(): Promise<string> {
  const { thread } = await client.request("thread/start", { model: "gpt-6-luna", cwd: "/work" });
  return thread.id;
}

describe("gateway (black box: fake stock + fake Claude)", () => {
  beforeEach(async () => {
    fakeClaude.reset();
    gateway = await startTestGateway();
    client = await gateway.connect();
  });
  afterEach(async () => { await gateway.stop(); });
  afterAll(() => undefined);

  it("passes stock requests through byte for byte", async () => {
    const raw = `{"id":7,  "method":"weird/method","params":{"ü":"✓","n":1.50}}`;
    const result = await client.raw(raw, 7);
    expect(result).toEqual({ echo: "weird/method", raw });
  });

  it("passes stock server requests through and returns the client's answer", async () => {
    client.onRequest = () => ({ decision: "acceptForSession" });
    expect(await client.request("test/approval")).toEqual({ decision: "acceptForSession" });
  });

  it("merges models and skills of both providers", async () => {
    const models = await client.request("model/list", {});
    expect(models.data.map((model: any) => model.id)).toEqual(expect.arrayContaining(["gpt-6-luna", CLAUDE]));
    const skills = await client.request("skills/list", { cwds: ["/work"] });
    expect(skills.data[0].skills.map((skill: any) => skill.name)).toEqual(["stock-skill", "claude:review-pr"]);
  });

  it("runs a Claude thread: stream, persist, read back, list", async () => {
    const threadId = await claudeThread();
    const done = await client.turn(threadId, "hello");
    expect(done.turn.status).toBe("completed");
    const deltas = client.notifications("item/agentMessage/delta", threadId).map((message) => message.params.delta);
    expect(deltas).toEqual(["claude: hello"]);
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(itemsOf(thread.turns)).toEqual(["user:hello", "agent:claude: hello"]);
    expect(thread.turns[0].id).toBe(done.turn.id);
    const list = await client.request("thread/list", { limit: 50 });
    expect(list.data.map((row: any) => row.id)).toContain(threadId);
  });

  it("shows a session made in the claude CLI at once, with its whole history in Desktop's pages", async () => {
    const directory = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-cli");
    mkdirSync(directory, { recursive: true });
    const id = "0a0a0a0a-0000-4000-8000-000000000001";
    const record = (n: number, type: "user" | "assistant", content: unknown) => ({
      type, uuid: `${type}-${n}`, parentUuid: type === "user" ? (n > 1 ? `assistant-${n - 1}` : null) : `user-${n}`,
      sessionId: id, cwd: "/cli", timestamp: new Date(Date.UTC(2026, 8, 23, 0, 0, n)).toISOString(),
      message: type === "user" ? { role: "user", content }
        : { role: "assistant", model: "claude-sonnet-5", id: `msg_${n}`, content: [{ type: "text", text: content }], stop_reason: "end_turn" },
    });
    const turns = Array.from({ length: 130 }, (_, index) => index + 1);
    writeFileSync(join(directory, `${id}.jsonl`), turns.flatMap((n) => [record(n, "user", `question ${n}`), record(n, "assistant", `answer ${n}`)])
      .map((line) => `${JSON.stringify(line)}\n`).join(""));
    const started = await client.waitFor("thread/started", (params) => params.thread.id === id);
    expect(started.thread).toMatchObject({ preview: "question 1", modelProvider: "claude", cwd: "/cli" });
    const list = await client.request("thread/list", { limit: 200 });
    expect(list.data.find((thread: any) => thread.id === id)).toMatchObject({ preview: "question 1", archived: false });

    await client.request("thread/resume", { threadId: id });
    const pages: string[][] = [];
    let cursor = null;
    do {
      const page: any = await client.request("thread/turns/list", { threadId: id, cursor, limit: 100, sortDirection: "desc" });
      pages.push(page.data.map((turn: any) => itemsOf([turn]).join(" / ")));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages.map((page) => page.length)).toEqual([100, 30]);
    expect(pages.flat().reverse()).toEqual(turns.map((n) => `user:question ${n} / agent:answer ${n}`));
  });

  it("pages through the list whatever rows fall on a page boundary (switched threads included)", async () => {
    const older = await stockThread();
    await client.turn(older, "old");
    const claude = await claudeThread();
    await client.turn(claude, "claude");
    const switched = await stockThread();
    await client.turn(switched, "first");
    await client.request("turn/start", { threadId: switched, model: CLAUDE, input: text("second") });
    await client.waitFor("turn/completed", (params) => params.threadId === switched
      && client.notifications("item/completed", switched).some((message) => message.params.item.text === "claude: second"));
    const all = (await client.request("thread/list", { limit: 200 })).data.map((row: any) => row.id);
    expect(all).toEqual(expect.arrayContaining([older, claude, switched]));
    for (const limit of [1, 2]) {
      const paged: string[] = [];
      let cursor = null;
      do {
        const page: any = await client.request("thread/list", { limit, cursor });
        paged.push(...page.data.map((row: any) => row.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(paged).toEqual(all);
    }
  });

  it("keeps Claude threads in stock's sections", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "pin me");
    await client.request("thread/section/move", { threadId, sectionId: "section-pinned" });
    const pinned = await client.request("thread/list", { limit: 50, sectionId: "section-pinned", sortKey: "section_position" });
    expect(pinned.data.map((row: any) => row.id)).toEqual([threadId]);
    expect(pinned.data[0].section).toEqual({ id: "section-pinned", name: "Pinned", appearance: null });
    await client.request("thread/section/move", { threadId, sectionId: null });
    expect((await client.request("thread/list", { limit: 50, sectionId: "section-pinned" })).data).toEqual([]);
  });

  it("keeps the manual order of a section across stock and Claude threads", async () => {
    const [a, c, b] = [await stockThread(), await claudeThread(), await stockThread()];
    await client.turn(c, "pin me");
    const pinned = async () => (await client.request("thread/list", { limit: 50, sectionId: "section-pinned", sortKey: "section_position" }))
      .data.map((row: any) => row.id);
    for (const threadId of [a, c, b]) await client.request("thread/section/move", { threadId, sectionId: "section-pinned", beforeThreadId: null });
    expect(await pinned()).toEqual([a, c, b]);
    await client.request("thread/section/move", { threadId: b, sectionId: "section-pinned", beforeThreadId: c });
    expect(await pinned()).toEqual([a, b, c]);
    await client.request("thread/section/move", { threadId: c, sectionId: "section-pinned", beforeThreadId: a });
    expect(await pinned()).toEqual([c, a, b]);
    await client.request("thread/section/move", { threadId: a, sectionId: null });
    expect(await pinned()).toEqual([c, b]);
  });

  it("shows a Claude file change's patch before asking to approve it (Desktop needs it to render the approval)", async () => {
    const threadId = await claudeThread();
    const asked: any[] = [];
    client.onRequest = (message) => { asked.push({ message, patches: client.notifications("item/fileChange/patchUpdated", threadId).length }); return { decision: "accept" }; };
    await client.turn(threadId, "this needs file approval");
    expect(asked[0].message).toMatchObject({ method: "item/fileChange/requestApproval", params: { threadId } });
    expect(asked[0].patches).toBe(1);
    expect(client.notifications("item/fileChange/patchUpdated", threadId)[0]!.params).toMatchObject({
      itemId: asked[0].message.params.itemId, changes: [{ path: "/work/notes.txt", kind: { type: "add" }, diff: "fruit=kiwi\n" }],
    });
  });

  it("reports Claude token usage (Desktop's context meter)", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "first");
    await client.turn(threadId, "second");
    const usage = client.notifications("thread/tokenUsage/updated", threadId).at(-1)!.params.tokenUsage;
    expect(usage.last).toMatchObject({ inputTokens: 10, outputTokens: 3 });
    expect(usage.total).toMatchObject({ inputTokens: 20, outputTokens: 6 });
  });

  it("reports a resumed Claude thread's context usage like stock does (Desktop's /status shows it)", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "first");
    const other = await gateway.connect("other");
    const resumed = other.messages.length;
    await other.request("thread/resume", { threadId });
    const usage = await other.waitFor("thread/tokenUsage/updated", (params) => params.threadId === threadId);
    expect(other.messages.slice(resumed).findIndex((message) => message.method === "thread/tokenUsage/updated"))
      .toBeGreaterThan(other.messages.slice(resumed).findIndex((message) => message.result?.thread?.id === threadId));
    expect(usage.tokenUsage).toMatchObject({ last: { inputTokens: 10, outputTokens: 3, totalTokens: 13 }, modelContextWindow: 200_000 });
  });

  it("asks the client to approve Claude tool use", async () => {
    const threadId = await claudeThread();
    const asked: any[] = [];
    client.onRequest = (message) => { asked.push(message); return { decision: "accept" }; };
    await client.turn(threadId, "this needs approval");
    expect(asked[0]).toMatchObject({ method: "item/commandExecution/requestApproval", params: { threadId, command: "touch /tmp/approved" } });
    expect(String(asked[0].id)).toMatch(/^ccodex:/u);
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(itemsOf(thread.turns).at(-1)).toBe("agent:approval allow");
    expect(client.notifications("serverRequest/resolved", threadId)).toHaveLength(1);
  });

  it("follows Desktop's approval toggle on a Claude thread (ask / full access / approve for me)", async () => {
    const { thread } = await client.request("thread/start", { model: "claude:claude-haiku-4-5-20251001", cwd: "/work" });
    const threadId = thread.id;
    const asked: string[] = [];
    client.onRequest = (message) => { asked.push(message.method); return { decision: "accept" }; };
    const turn = async (settings: object, model?: string) => {
      asked.length = 0;
      await client.request("turn/start", { threadId, input: text("this needs approval"), ...(model ? { model } : {}), ...settings });
      await client.waitFor("turn/completed", (params) => params.threadId === threadId);
      client.messages.length = 0;
      return asked.length;
    };
    // Desktop's three options, as it sends them.
    const ask = { approvalPolicy: { granular: { sandbox_approval: false, rules: true, mcp_elicitations: true } }, permissions: ":workspace" };
    const full = { approvalPolicy: "never", permissions: ":danger-full-access" };
    const approveForMe = { approvalPolicy: "on-request", approvalsReviewer: "guardian_subagent", permissions: ":workspace" };
    expect(await turn(ask)).toBe(1);
    expect(await turn(full)).toBe(0);
    expect(await turn(ask)).toBe(1);
    // Claude has no auto mode on Haiku (it asks), but does once the thread moves to a model that has it.
    expect(await turn(approveForMe)).toBe(1);
    expect(await turn(approveForMe, CLAUDE)).toBe(0);
  });

  it("shows a finished Claude turn in a read right after it, however recently the thread was read", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "one");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await client.request("thread/read", { threadId, includeTurns: true });
    await client.turn(threadId, "two");
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(itemsOf(thread.turns)).toEqual(["user:one", "agent:claude: one", "user:two", "agent:claude: two"]);
  });

  it("keeps a Claude model switch out of the thread's history", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "on opus");
    const before = (await client.request("thread/read", { threadId, includeTurns: true })).thread.turns[0];
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await client.request("thread/settings/update", { threadId, model: "claude:claude-haiku-4-5-20251001" });
    await client.turn(threadId, "on haiku");
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(itemsOf(thread.turns)).toEqual(["user:on opus", "agent:claude: on opus", "user:on haiku", "agent:claude: on haiku"]);
    expect(thread.turns[0].completedAt).toBe(before.completedAt);
  });

  it("answers /ccstatus and /ccstate with a synthetic turn", async () => {
    const threadId = await stockThread();
    await client.turn(threadId, "/ccstatus");
    const answer = client.notifications("item/completed", threadId).map((message) => message.params.item).find((item) => item.type === "agentMessage");
    expect(answer.text).toContain("◆ **CCodex** │ status");
    expect(answer.text).toContain("֎ **Codex** · ✅ ready");
    const claude = await claudeThread();
    await client.turn(claude, "/ccstate");
    const state = client.notifications("item/completed", claude).map((message) => message.params.item).find((item) => item.type === "agentMessage");
    expect(state.text).toContain("permissions ▸ default");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.notifications("thread/status/changed", claude).at(-1)!.params.status).toEqual({ type: "idle" });
    const { thread } = await client.request("thread/read", { threadId: claude, includeTurns: true });
    expect(thread.turns).toHaveLength(0);
  });

  it("serves /side on a Claude thread through the source session", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "context");
    const { thread: side } = await client.request("thread/fork", { threadId, ephemeral: true, excludeTurns: true, threadSource: "user" });
    // Desktop opens a side chat with a boundary message.
    await client.request("thread/inject_items", { threadId: side.id, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Side conversation boundary." }] }] });
    await client.turn(side.id, "what did I say?");
    const answer = client.notifications("item/completed", side.id).map((message) => message.params.item).find((item) => item.type === "agentMessage");
    expect(answer.text).toBe("side: what did I say?");
  });

  it("maps /goal to Claude's native goal the way stock runs goals", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "start");
    const before = client.messages.length;
    const set = await client.request("thread/goal/set", { threadId, objective: "ship it" });
    expect(set.goal).toMatchObject({ objective: "ship it", status: "active" });
    // Desktop adds the goal message itself on the answer; the goal's turn starts after it and shows no user message.
    await client.waitFor("turn/completed", (params) => params.threadId === threadId && fakeClaude.prompts.at(-1)?.text === "/goal ship it");
    const sequence = client.messages.slice(before).map((message) => message.method ?? (message.result?.goal ? "answer" : null));
    expect(sequence.filter((method) => method === "answer" || method === "turn/started")).toEqual(["answer", "turn/started"]);
    const turn = client.messages.slice(before).find((message) => message.method === "turn/started")!.params.turn;
    expect(client.notifications("item/started", threadId).filter((params) => params.params.turnId === turn.id && params.params.item.type === "userMessage")).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await client.request("thread/goal/get", { threadId })).goal).toMatchObject({ objective: "ship it", status: "active" });
    expect(fakeClaude.prompts.map((prompt) => prompt.text)).toContain("/goal ship it");

    // Claude drops a met goal: reported complete once, then Desktop's clear sends Claude nothing.
    await client.turn(threadId, "this meets the goal: ship it");
    await client.waitFor("thread/goal/updated", (params) => params.threadId === threadId && params.goal.status === "complete");
    const prompts = fakeClaude.prompts.length;
    expect(await client.request("thread/goal/clear", { threadId })).toEqual({ cleared: true });
    expect(fakeClaude.prompts).toHaveLength(prompts);
    expect((await client.request("thread/goal/get", { threadId })).goal).toBeNull();

    await client.request("thread/goal/set", { threadId, objective: "again" });
    await client.waitFor("turn/completed", (params) => params.threadId === threadId && fakeClaude.prompts.at(-1)?.text === "/goal again");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await client.request("thread/goal/clear", { threadId });
    expect(fakeClaude.prompts.at(-1)?.text).toBe("/goal clear");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await client.request("thread/goal/get", { threadId })).goal).toBeNull();
    const history = await client.request("thread/read", { threadId, includeTurns: true });
    const texts = history.thread.turns.flatMap((t: any) => t.items).filter((item: any) => item.type === "userMessage").map((item: any) => item.content[0].text);
    expect(texts).toEqual(["start", "/goal ship it", "this meets the goal: ship it", "/goal again"]);
  });

  it("keeps the latest name of a new Claude thread (a name set before its first message waits for it)", async () => {
    const threadId = await claudeThread();
    await client.request("thread/name/set", { threadId, name: "provisional" });
    // The title arrives while the first turn still runs (here: waits for approval).
    client.onRequest = async () => {
      await client.request("thread/name/set", { threadId, name: "Final title" });
      return { decision: "accept" };
    };
    await client.turn(threadId, "this needs approval");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await client.request("thread/read", { threadId })).thread.name).toBe("Final title");
    expect(client.notifications("thread/name/updated", threadId).at(-1)!.params.threadName).toBe("Final title");
  });

  it("continues Claude from before a reverted turn (Desktop's message edit)", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "apple");
    const { turn } = await client.turn(threadId, "banana");
    await client.request("thread/revert", { threadId, beforeTurnId: turn.id });
    await client.turn(threadId, "cherry");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(thread.turns.map((t: any) => t.items[0].content[0].text)).toEqual(["apple", "cherry"]);
    // Any input continues from the leaf, not only turn/start (here a queued message on an idle thread).
    await client.request("thread/revert", { threadId, beforeTurnId: thread.turns[1].id });
    await client.request("thread/queue/add", { threadId, input: [{ type: "text", text: "date", text_elements: [] }] });
    await client.waitFor("turn/completed", (params) => params.threadId === threadId && fakeClaude.prompts.at(-1)?.text === "date");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await client.request("thread/read", { threadId, includeTurns: true });
    expect(after.thread.turns.map((t: any) => t.items[0].content[0].text)).toEqual(["apple", "date"]);
  });

  it("announces a Claude sub-agent before its spawn completes, before Claude has written its transcript", async () => {
    const threadId = await claudeThread();
    const before = client.messages.length;
    await client.turn(threadId, "spawn a sub-agent");
    const childId = "agent-a1b2c3";
    const events = client.messages.slice(before).map((message) => message.method === "thread/started" ? `started ${message.params.thread.id}`
      : message.method === "item/completed" && message.params.item.type === "collabAgentToolCall" ? `spawned ${message.params.item.receiverThreadIds}` : null).filter(Boolean);
    expect(events).toEqual([`started ${childId}`, `spawned ${childId}`]);
    const { thread } = await client.request("thread/read", { threadId: childId });
    expect(thread).toMatchObject({ parentThreadId: threadId, agentNickname: "Helper [Haiku 4.5]", preview: "Reply SUB-OK", status: { type: "idle" } });
    expect(client.notifications("thread/status/changed", childId).map((message) => message.params.status.type)).toEqual(["idle"]);
    const listed = await client.request("thread/list", { ancestorThreadId: threadId, sourceKinds: ["subAgentThreadSpawn"] });
    expect(listed.data.map((row: any) => row.id)).toEqual([childId]);
  });

  it("shows what Codex says in a Claude thread's Codex MCP call, live and in history", async () => {
    const threadId = await claudeThread();
    const before = client.messages.length;
    await client.turn(threadId, "ask codex: DIG");
    const codex = ["◆ CCodex │ Codex MCP prompt\n\nDIG", "◆ CCodex │ Codex MCP message\n\ncodex says: DIG"];
    const live = client.messages.slice(before).filter((message) => message.method === "item/completed" && message.params.item.text?.startsWith("◆"))
      .map((message) => message.params.item);
    expect(live.map((item) => item.text)).toEqual(codex);
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    const items = thread.turns[0].items;
    expect(items.map((item: any) => item.type === "agentMessage" ? item.text : item.type)).toEqual(["userMessage", "mcpToolCall", ...codex, "claude: ask codex: DIG"]);
    expect(items.filter((item: any) => item.text?.startsWith("◆")).map((item: any) => item.id)).toEqual(live.map((item) => item.id));
  });

  it("shows a codex sub-agent's Codex conversation live in the sub-agent's own thread", async () => {
    const threadId = await claudeThread();
    const childId = "agent-c0d3c0d3";
    const done = client.turn(threadId, "ask a codex sub-agent: DIG");
    await client.waitFor("thread/started", (params) => params.thread.id === childId);
    await client.request("thread/resume", { threadId: childId });
    await done;
    expect(await client.request("thread/resume", { threadId: childId })).toMatchObject({ model: "claude:claude-sonnet-5", cwd: "/work" });
    await client.waitFor("turn/completed", (params) => params.threadId === childId);
    const shown = client.notifications("item/completed", childId).map((message) => message.params.item)
      .map((item) => item.type === "agentMessage" ? item.text : item.type === "userMessage" ? `user:${item.content[0].text}` : item.type);
    const conversation = ["user:DIG", "mcpToolCall", "◆ CCodex │ Codex MCP prompt\n\nDIG", "◆ CCodex │ Codex MCP message\n\ncodex says: DIG", "Codex is done"];
    expect([...new Set(shown)]).toEqual(conversation);
    const { thread: child } = await client.request("thread/read", { threadId: childId, includeTurns: true });
    expect(itemsOf(child.turns)).toEqual(["user:DIG", "mcpToolCall", ...conversation.slice(2).map((text) => `agent:${text}`)]);
    const { thread: parent } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(itemsOf(parent.turns).filter((item) => item.includes("◆"))).toEqual([]);
  });

  it("keeps a Claude default model, effort and speed out of Codex's config.toml, showing them through config/read", async () => {
    const edits = (model: string, effort: string) => [
      { keyPath: "model", value: model, mergeStrategy: "upsert" }, { keyPath: "model_reasoning_effort", value: effort, mergeStrategy: "upsert" }];
    await client.request("config/batchWrite", { edits: edits(CLAUDE, "max"), filePath: null, expectedVersion: null });
    expect((await client.request("test/config")).config).toEqual({ model: "gpt-6-luna" });
    expect((await client.request("config/read", {})).config).toMatchObject({ model: CLAUDE, model_reasoning_effort: "max" });
    await client.request("config/value/write", { keyPath: "model_reasoning_effort", value: "ultra", mergeStrategy: "upsert" });
    await client.request("config/batchWrite", { edits: [{ keyPath: "service_tier", value: "fast", mergeStrategy: "upsert" }] });
    expect((await client.request("test/config")).config).toEqual({ model: "gpt-6-luna" });
    expect((await client.request("config/read", {})).config).toMatchObject({ model: CLAUDE, model_reasoning_effort: "ultra", service_tier: "fast" });
    await client.request("config/batchWrite", { edits: edits("gpt-6-sol", "high") });
    expect((await client.request("config/read", {})).config).toEqual({ model: "gpt-6-sol", model_reasoning_effort: "high" });
  });

  /** Desktop gives its optimistic message to the first turn that starts: live, only the user's turn may start. */
  const expectLiveSwitch = (threadId: string, before: number, turnId: string) => {
    expect(new Set(client.notifications("turn/started", threadId).slice(before).map((message) => message.params.turn.id))).toEqual(new Set([turnId]));
    expect(client.notifications("item/completed", threadId).some((message) => message.params.item.type === "contextCompaction" && message.params.turnId === turnId)).toBe(true);
  };

  it("switches claude → gpt: native /compact, new stock thread with the summary, stitched history", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "first");
    const before = client.notifications("turn/started", threadId).length;
    const { turn: answered } = await client.request("turn/start", { threadId, model: "gpt-6-luna", input: text("second") });
    await client.waitFor("turn/completed", (params) => params.threadId === threadId && client.notifications("item/completed", threadId)
      .some((message) => message.params.item.text === "gpt: second"));
    expectLiveSwitch(threadId, before, answered.id);
    const { threads } = await client.request("test/threads");
    const backend = threads.find((thread: any) => thread.injected.length);
    expect(backend.injected[0].content[0].text).toContain("SUMMARY(You are performing a CONTEXT CHECKPOINT COMPACTION");
    const meta = JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8"));
    expect(meta.lineages[threadId].map((segment: any) => segment.provider)).toEqual(["claude", "codex"]);
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(itemsOf(thread.turns)).toEqual(["user:first", "agent:claude: first", "contextCompaction", "user:second", "agent:gpt: second"]);
    expect(thread.turns.at(-1).id).toBe(answered.id);
    const list = await client.request("thread/list", { limit: 200 });
    // The stock backend is never listed on its own (and every frame names it by the public id).
    expect(backend.id).toBe(threadId);
    expect(list.data.filter((row: any) => row.id === threadId)).toHaveLength(1);
    expect(list.data.find((row: any) => row.id === threadId)).toMatchObject({ modelProvider: "openai" });
    // A fork at the last turn before the switch is a fork of the uncompacted Claude session.
    const { thread: fork } = await client.request("thread/fork", { threadId, lastTurnId: thread.turns[0].id });
    const forkRead = await client.request("thread/read", { threadId: fork.id, includeTurns: true });
    expect(itemsOf(forkRead.thread.turns)).toEqual(["user:first", "agent:claude: first"]);
    // The next turn goes straight to the stock backend, answered under the public id.
    const next = await client.turn(threadId, "third", { model: "gpt-6-luna" });
    expect(next.threadId).toBe(threadId);
  });

  it("resumes gpt → claude → gpt with the row's rollout path (Desktop after a restart)", async () => {
    const threadId = await stockThread();
    await client.turn(threadId, "first");
    await client.turn(threadId, "second", { model: CLAUDE });
    await client.turn(threadId, "third", { model: "gpt-6-luna" });
    const { data } = await client.request("thread/list", { limit: 200 });
    const row = data.find((entry: any) => entry.id === threadId);
    const fresh = await gateway.connect();
    const resumed = await fresh.request("thread/resume", { threadId, path: row.path, history: null });
    expect(itemsOf(resumed.thread.turns)).toEqual(["user:first", "agent:gpt: first", "contextCompaction", "user:second", "agent:claude: second",
      "contextCompaction", "user:third", "agent:gpt: third"]);
  });

  it("switches gpt → claude: summary from an ephemeral fork, injected without a reply", async () => {
    const threadId = await stockThread();
    await client.turn(threadId, "first");
    const before = client.notifications("turn/started", threadId).length;
    const { turn: answered } = await client.request("turn/start", { threadId, model: CLAUDE, input: text("second") });
    await client.waitFor("item/completed", (params) => params.threadId === threadId && params.item.text === "claude: second");
    expectLiveSwitch(threadId, before, answered.id);
    const injected = fakeClaude.prompts.find((prompt) => !prompt.shouldQuery);
    expect(injected?.text).toContain(`GPT-SUMMARY(${threadId})`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(itemsOf(thread.turns)).toEqual(["user:first", "agent:gpt: first", "contextCompaction", "user:second", "agent:claude: second"]);
    expect(thread.turns.at(-1).id).toBe(answered.id);
    const list = await client.request("thread/list", { limit: 200 });
    expect(list.data.filter((row: any) => row.modelProvider === "claude" && row.preview === "")).toHaveLength(0);
    // Forking at the gpt turn forks the stock segment only.
    const { thread: fork } = await client.request("thread/fork", { threadId, lastTurnId: thread.turns[0].id });
    const forkRead = await client.request("thread/read", { threadId: fork.id, includeTurns: true });
    expect(itemsOf(forkRead.thread.turns)).toEqual(["user:first", "agent:gpt: first"]);
    // Rolling back to before the switch returns the thread to its stock segment.
    await client.request("thread/rollback", { threadId, numTurns: 2 });
    const meta = JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8"));
    expect(meta.lineages[threadId]).toBeUndefined();
    const after = await client.request("thread/read", { threadId, includeTurns: true });
    expect(itemsOf(after.thread.turns)).toEqual(["user:first", "agent:gpt: first"]);
  });
});

describe("threads migrated from 0.4", () => {
  afterEach(async () => { await gateway.stop(); });

  it("keep their 0.4 id: listed, read, streamed and continued under it", async () => {
    fakeClaude.reset();
    const session = "0b0b0b0b-0000-4000-8000-000000000002";
    const legacy = "0b0b0b0b-0000-4000-8000-00000000aaaa";
    const directory = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-work");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${session}.jsonl`), `${JSON.stringify({
      type: "user", uuid: "m1", parentUuid: null, sessionId: session, cwd: "/work", timestamp: "2026-09-20T00:00:00.000Z",
      origin: { kind: "human" }, message: { role: "user", content: "old question" },
    })}\n`);
    gateway = await startTestGateway({}, { lineages: { [legacy]: [{ provider: "claude", threadId: session, lastTurnId: null }] } });
    client = await gateway.connect();
    const ids = (await client.request("thread/list", { limit: 200 })).data.map((row: any) => row.id);
    expect(ids).toContain(legacy);
    expect(ids).not.toContain(session);
    const done = await client.turn(legacy, "new question", { model: CLAUDE });
    expect(done.threadId).toBe(legacy);
    expect(fakeClaude.prompts.at(-1)).toMatchObject({ sessionId: session, text: "new question" });
    expect(JSON.stringify(client.messages)).not.toContain(session);
    const { thread } = await client.request("thread/read", { threadId: legacy, includeTurns: true });
    expect(thread.id).toBe(legacy);
    expect(itemsOf(thread.turns)).toEqual(["user:old question", "user:new question", "agent:claude: new question"]);
    // Switching provider keeps the 0.4 id as the public one.
    await client.request("turn/start", { threadId: legacy, model: "gpt-6-luna", input: text("to gpt") });
    await client.waitFor("item/completed", (params) => params.threadId === legacy && params.item.text === "gpt: to gpt");
    const switched = await client.request("thread/read", { threadId: legacy, includeTurns: true });
    expect(itemsOf(switched.thread.turns)).toEqual(["user:old question", "user:new question", "agent:claude: new question", "contextCompaction", "user:to gpt", "agent:gpt: to gpt"]);
    const rows = (await client.request("thread/list", { limit: 200 })).data.filter((row: any) => row.id === legacy);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ modelProvider: "openai", preview: "old question" });
    await client.request("thread/archive", { threadId: legacy });
    expect((await client.request("thread/list", { limit: 200, archived: true })).data.map((row: any) => row.id)).toContain(legacy);
  });

  it("stay listed and readable when Claude cleaned up the transcript of an earlier segment", async () => {
    fakeClaude.reset();
    const expired = "0c0c0c0c-0000-4000-8000-000000000001";
    const session = "0c0c0c0c-0000-4000-8000-000000000002";
    const directory = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-work");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${session}.jsonl`), `${JSON.stringify({
      type: "user", uuid: "n1", parentUuid: null, sessionId: session, cwd: "/work", timestamp: "2026-09-20T00:00:00.000Z",
      origin: { kind: "human" }, message: { role: "user", content: "after the switch" },
    })}\n`);
    gateway = await startTestGateway({}, { lineages: { [expired]: [
      { provider: "claude", threadId: expired, lastTurnId: "gone" },
      { provider: "claude", threadId: session, lastTurnId: null },
    ] } });
    client = await gateway.connect();
    const ids = (await client.request("thread/list", { limit: 200 })).data.map((row: any) => row.id);
    expect(ids).toContain(expired);
    expect(ids).not.toContain(session);
    const { thread } = await client.request("thread/read", { threadId: expired, includeTurns: true });
    expect(itemsOf(thread.turns)).toEqual(["user:after the switch"]);
  });
});

describe("titles (rename_prompt)", () => {
  beforeEach(async () => {
    fakeClaude.reset();
    gateway = await startTestGateway({ renamePrompt: "Make a title." });
    client = await gateway.connect();
  });
  afterEach(async () => { await gateway.stop(); });

  it("names new threads with the title model; ✳️ for Claude; ignores Desktop's prompt-prefix names", async () => {
    const stock = await stockThread();
    await client.turn(stock, "please refactor the parser module");
    await client.waitFor("thread/name/updated", (params) => params.threadId === stock && params.threadName === "🦊 Fox Title");
    expect(await client.request("thread/name/set", { threadId: stock, name: "please refactor the parser…" })).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.notifications("thread/name/updated", stock).map((message) => message.params.threadName)).toEqual(["🦊 Fox Title"]);
    const claude = await claudeThread();
    await client.turn(claude, "hello there");
    await client.waitFor("thread/name/updated", (params) => params.threadId === claude && params.threadName === "🦊 Fox Title ✳️");
    // Desktop's own title turn gets an empty answer.
    const { thread: titleThread } = await client.request("thread/start", { model: "gpt-6-luna", ephemeral: true });
    const done = await client.turn(titleThread.id, "User prompt:\nhello", { turnTrigger: "thread_title" });
    expect(done.turn.status).toBe("completed");
    expect(client.notifications("item/completed", titleThread.id)).toHaveLength(0);
  });
});
