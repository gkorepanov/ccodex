import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, fakeQuery, fakeStartup } from "../fixtures/fakeClaude.js";
import { startTestGateway, type Client, type TestGateway } from "./harness.js";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ccodex-claude-"));
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "ccodex-codex-home-"));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...await importOriginal<object>(),
  query: fakeQuery,
  startup: fakeStartup,
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
    expect(skills.data[0].skills.map((skill: any) => skill.name)).toEqual(["ccodex:status", "stock-skill", "claude:review-pr"]);
    expect(skills.data[0].skills[0].interface.displayName).toBe("CCodex status");
    // What Desktop mostly sends: no cwds, stock's own cwd.
    const defaults = await client.request("skills/list", { forceReload: true });
    expect(defaults.data.map((entry: any) => [entry.cwd, entry.skills.map((skill: any) => skill.name)])).toEqual([["/home/fake", ["ccodex:status", "stock-skill", "claude:review-pr"]]]);
  });

  it("points a Claude skill at Claude's file for it, or at a note, so a GPT chat mentioning it can read it", async () => {
    const project = join(gateway.root, "project");
    const file = join(project, ".claude", "skills", "review-pr", "SKILL.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "---\nname: review-pr\n---\n");
    const [found, builtin] = (await client.request("skills/list", { cwds: [project, "/work"] })).data.map((entry: any) => entry.skills.at(-1).path);
    expect(found).toBe(file);
    expect(readFileSync(builtin, "utf8")).toContain("`/review-pr` is a Claude Code command without a file of its own");
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

  it("shows a Claude turn cut off with its process (a daemon restart mid-command) as interrupted, like stock's stale turns; a running one stays running", async () => {
    const directory = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-cut");
    mkdirSync(directory, { recursive: true });
    const id = "0a0a0a0a-0000-4000-8000-000000000002";
    const at = (n: number) => ({ sessionId: id, cwd: "/cut", timestamp: new Date(Date.UTC(2026, 8, 27, 0, 0, n)).toISOString() });
    const records = [
      { type: "user", uuid: "u1", parentUuid: null, ...at(1), message: { role: "user", content: "wait for the restart" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", ...at(2), message: { role: "assistant", model: "claude-opus-5-5", id: "msg_1", stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_cut", name: "Bash", input: { command: "until grep -q OK restart.log; do sleep 2; done" } }] } },
      { type: "user", uuid: "u2", parentUuid: "a1", ...at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_cut", content: "Exit code 137", is_error: true }] } },
    ];
    writeFileSync(join(directory, `${id}.jsonl`), records.map((line) => `${JSON.stringify(line)}\n`).join(""));
    await client.waitFor("thread/started", (params) => params.thread.id === id);
    const resumed = await client.request("thread/resume", { threadId: id, excludeTurns: true });
    expect(resumed.thread.status.type).not.toBe("active");
    const page = await client.request("thread/turns/list", { threadId: id, limit: 5, itemsView: "notLoaded", sortDirection: "desc" });
    expect(page.data.map((turn: any) => turn.status)).toEqual(["interrupted"]);
    const { thread } = await client.request("thread/read", { threadId: id, includeTurns: true });
    expect(thread.turns.map((turn: any) => turn.status)).toEqual(["interrupted"]);
    expect(thread.turns[0].items.find((item: any) => item.type === "commandExecution")).toMatchObject({ status: "failed", aggregatedOutput: "Exit code 137" });
    // The next prompt resumes it: Claude Code writes its filler for the cut turn (its own UI hides it) before the prompt.
    appendFileSync(join(directory, `${id}.jsonl`), [
      { type: "user", uuid: "u3", parentUuid: "u2", isMeta: true, ...at(4), message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] } },
      { type: "assistant", uuid: "a3", parentUuid: "u3", ...at(4), message: { role: "assistant", model: "<synthetic>", id: "synthetic-1", stop_reason: "stop_sequence", content: [{ type: "text", text: "No response requested." }] } },
      { type: "user", uuid: "u4", parentUuid: "a3", ...at(5), message: { role: "user", content: "is it back?" } },
      { type: "assistant", uuid: "a4", parentUuid: "u4", ...at(6), message: { role: "assistant", model: "claude-opus-5-5", id: "msg_4", stop_reason: "end_turn", content: [{ type: "text", text: "back" }] } },
    ].map((line) => `${JSON.stringify(line)}\n`).join(""));
    const resumed2 = (await client.request("thread/read", { threadId: id, includeTurns: true })).thread;
    expect(resumed2.turns.map((turn: any) => turn.status)).toEqual(["interrupted", "completed"]);
    expect(itemsOf(resumed2.turns)).toEqual(["user:wait for the restart", "commandExecution", "user:is it back?", "agent:back"]);

    // Mid-command (Claude waits for the approval): the turn runs, and so does the thread in the sidebar.
    const threadId = await claudeThread();
    let seen: unknown;
    client.onRequest = async () => {
      seen = {
        turns: (await client.request("thread/turns/list", { threadId, limit: 5, sortDirection: "desc" })).data.map((turn: any) => turn.status),
        read: (await client.request("thread/read", { threadId, includeTurns: true })).thread.turns.map((turn: any) => turn.status),
        thread: (await client.request("thread/read", { threadId })).thread.status.type,
      };
      return { decision: "accept" };
    };
    await client.turn(threadId, "this needs approval");
    expect(seen).toEqual({ turns: ["inProgress"], read: ["inProgress"], thread: "active" });
  });

  it("keeps a deleted Claude thread gone when Claude writes its closing metadata into the file afterwards", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "hello");
    const projects = join(process.env.CLAUDE_CONFIG_DIR!, "projects");
    const transcript = join(projects, readdirSync(projects).find((key) => existsSync(join(projects, key, `${threadId}.jsonl`)))!, `${threadId}.jsonl`);
    await client.request("thread/delete", { threadId });
    expect(existsSync(transcript)).toBe(false);
    // What the CLI writes after close() while a background task runs: a file with no conversation in it.
    writeFileSync(transcript, [
      { type: "last-prompt", lastPrompt: "hello", sessionId: threadId },
      { type: "ai-title", aiTitle: "Greeting", sessionId: threadId },
    ].map((line) => `${JSON.stringify(line)}\n`).join(""));
    await new Promise((resolve) => setTimeout(resolve, 600));
    const list = await client.request("thread/list", { limit: 50 });
    expect(list.data.map((row: any) => row.id)).not.toContain(threadId);
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

  it("pages the same list for concurrent requests (Desktop sends three at once when it starts)", async () => {
    for (const prompt of ["one", "two", "three"]) await client.turn(await stockThread(), prompt);
    await client.turn(await claudeThread(), "claude");
    const all = (await client.request("thread/list", { limit: 200 })).data.map((row: any) => row.id);
    const walk = async () => {
      const paged: string[] = [];
      let cursor = null;
      do {
        const page: any = await client.request("thread/list", { limit: 1, cursor });
        paged.push(...page.data.map((row: any) => row.id));
        cursor = page.nextCursor;
      } while (cursor);
      return paged;
    };
    expect(await Promise.all([walk(), walk(), walk()])).toEqual([all, all, all]);
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

  it("puts a deleted section's Claude threads back to no section, as stock does with its own", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "hi");
    await client.request("thread/section/move", { threadId, sectionId: "section-pinned" });
    await client.request("threadSection/delete", { sectionId: "section-pinned" });
    const unsectioned = await client.request("thread/list", { limit: 50, sectionId: null });
    expect(unsectioned.data.find((thread: any) => thread.id === threadId)?.section).toBeNull();
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
    // Claude's own window (getContextUsage) from the first turn on, not the model's raw one from the turn's result.
    expect(client.messages.find((message) => message.method === "thread/tokenUsage/updated")?.params.tokenUsage.modelContextWindow).toBe(400_000);
    const other = await gateway.connect("other");
    const resumed = other.messages.length;
    await other.request("thread/resume", { threadId });
    const usage = await other.waitFor("thread/tokenUsage/updated", (params) => params.threadId === threadId);
    expect(other.messages.slice(resumed).findIndex((message) => message.method === "thread/tokenUsage/updated"))
      .toBeGreaterThan(other.messages.slice(resumed).findIndex((message) => message.result?.thread?.id === threadId));
    expect(usage.tokenUsage).toMatchObject({ last: { inputTokens: 10, outputTokens: 3, totalTokens: 13 }, modelContextWindow: 400_000 });
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

  it("ends a Claude plan-mode turn with the proposed plan, and accepting it leaves plan mode for the mode before (stock plan mode)", async () => {
    const threadId = await claudeThread();
    const asked: any[] = [];
    client.onRequest = (message) => { asked.push(message); return { decision: "accept" }; };
    const full = { approvalPolicy: "never", permissions: ":danger-full-access" };
    const planned = await client.turn(threadId, "propose a plan: 1. add the flag", { ...full, collaborationMode: { mode: "plan", settings: { model: CLAUDE, reasoning_effort: null, developer_instructions: null } } });
    expect(fakeClaude.options.at(-1)!.permissionMode).toBe("plan");
    // Claude enters plan mode only as the user sets it.
    expect(fakeClaude.options.at(-1)!.disallowedTools).toEqual(["EnterPlanMode"]);
    // No approval of ExitPlanMode: the plan item is what Desktop asks "Implement this plan?" about once the turn completes.
    expect(asked).toEqual([]);
    expect(planned.turn.status).toBe("completed");
    const plan = client.notifications("item/completed", threadId).map((message) => message.params.item).find((item) => item.type === "plan");
    expect(plan).toMatchObject({ type: "plan", text: "1. add the flag" });
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(thread.turns.at(-1).items.find((item: any) => item.type === "plan")).toEqual(plan);
    expect(fakeClaude.options.at(-1)!.permissionMode).toBe("plan");
    // Desktop's "Yes, implement this plan": the collaboration mode goes back to default, then the plan is sent.
    await client.request("thread/settings/update", { threadId, collaborationMode: { mode: "default", settings: { model: CLAUDE, reasoning_effort: null, developer_instructions: null } } });
    expect(fakeClaude.calls.filter((call) => call.method === "setPermissionMode").at(-1)!.args).toEqual(["bypassPermissions"]);
    expect(client.notifications("thread/settings/updated", threadId).at(-1)!.params.threadSettings.collaborationMode.mode).toBe("default");
    await client.turn(threadId, "PLEASE IMPLEMENT THIS PLAN:\n1. add the flag; this needs approval", { turnTrigger: "plan_implementation", collaborationMode: { mode: "default", settings: { model: CLAUDE, reasoning_effort: null, developer_instructions: null } } });
    expect(asked).toEqual([]);
  });

  it("keeps a Claude chat's permissions apart from plan mode, after a restart too (meta.json: its transcript records only plan)", async () => {
    const threadId = await claudeThread();
    const asked: any[] = [];
    const mode = (name: string) => ({ mode: name, settings: { model: CLAUDE, reasoning_effort: null, developer_instructions: null } });
    await client.turn(threadId, "one", { approvalPolicy: "never", permissions: ":danger-full-access" });
    await client.turn(threadId, "propose a plan: 1. add the flag", { collaborationMode: mode("plan") });
    // Plan mode shows the chat's own permissions, like stock's.
    expect(client.notifications("thread/settings/updated", threadId).at(-1)!.params.threadSettings).toMatchObject({ approvalPolicy: "never", collaborationMode: { mode: "plan" } });
    const meta = JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8"));
    expect(meta.plans).toEqual({ [threadId]: { permissionMode: "bypassPermissions", model: "claude-opus-5-5", effort: null, plan: true } });
    await gateway.stop();
    gateway = await startTestGateway({}, meta);
    client = await gateway.connect();
    client.onRequest = (message) => { asked.push(message); return { decision: "accept" }; };
    // Like stock's, a resume tells the chat's collaboration mode (Desktop's composer shows plan mode from it).
    expect(await client.request("thread/resume", { threadId })).toMatchObject({ approvalPolicy: "never", collaborationMode: { mode: "plan", settings: { model: CLAUDE } } });
    await client.request("thread/settings/update", { threadId, collaborationMode: mode("default") });
    await client.turn(threadId, "PLEASE IMPLEMENT THIS PLAN:\n1. add the flag; this needs approval", { collaborationMode: mode("default") });
    expect(fakeClaude.options.at(-1)!.permissionMode).toBe("bypassPermissions");
    expect(asked).toEqual([]);
    expect(JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8")).plans).toEqual({});
  });

  it("keeps a Haiku chat on Haiku after a restart in plan mode (Claude plans it on Sonnet and records only that)", async () => {
    const haiku = "claude:claude-haiku-4-5-20251001";
    const mode = (name: string) => ({ mode: name, settings: { model: haiku, reasoning_effort: null, developer_instructions: null } });
    const { thread } = await client.request("thread/start", { model: haiku, cwd: "/work" });
    await client.turn(thread.id, "propose a plan: 1. add the flag", { collaborationMode: mode("plan") });
    const meta = JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8"));
    await gateway.stop();
    gateway = await startTestGateway({}, meta);
    client = await gateway.connect();
    expect((await client.request("thread/read", { threadId: thread.id })).thread).toMatchObject({ model: haiku, reasoningEffort: null });
    expect(await client.request("thread/resume", { threadId: thread.id })).toMatchObject({ model: haiku, reasoningEffort: null });
    await client.turn(thread.id, "PLEASE IMPLEMENT THIS PLAN:\n1. add the flag", { collaborationMode: mode("default") });
    expect(fakeClaude.options.at(-1)!.model).toBe("claude-haiku-4-5-20251001");
  });

  it("keeps a Claude chat's Full access and model when its plan message is edited after plan mode was turned off (its transcript still ends in plan)", async () => {
    const haiku = "claude:claude-haiku-4-5-20251001";
    const mode = (name: string) => ({ mode: name, settings: { model: haiku, reasoning_effort: null, developer_instructions: null } });
    const asked: any[] = [];
    client.onRequest = (message) => { asked.push(message); return { decision: "accept" }; };
    const { thread } = await client.request("thread/start", { model: haiku, cwd: "/work" });
    await client.turn(thread.id, "one", { approvalPolicy: "never", permissions: ":danger-full-access", collaborationMode: mode("default") });
    await client.turn(thread.id, "two", { collaborationMode: mode("default") });
    const { turn: planned } = await client.turn(thread.id, "propose a plan: 1. add the flag", { collaborationMode: mode("plan") });
    // The user skips "Implement this plan?" and turns the Plan chip off, then edits the plan message.
    await client.request("thread/settings/update", { threadId: thread.id, collaborationMode: mode("default") });
    await client.request("thread/revert", { threadId: thread.id, beforeTurnId: planned.id });
    await client.turn(thread.id, "touch c4edit.txt; this needs approval", { turnTrigger: "edit_user_message" });
    expect(fakeClaude.options.at(-1)).toMatchObject({ permissionMode: "bypassPermissions", model: "claude-haiku-4-5-20251001" });
    expect(asked).toEqual([]);
  });

  it("puts Claude's question to the user in the client's own question UI, even with full access", async () => {
    const threadId = await claudeThread();
    const asked: any[] = [];
    client.onRequest = (message) => {
      asked.push(message);
      return { answers: { [message.params.questions[0].id]: { answers: ["Blue"] } } };
    };
    await client.request("turn/start", { threadId, input: text("ask me: Which color? Red|Blue"), approvalPolicy: "never", permissions: ":danger-full-access" });
    await client.waitFor("turn/completed", (params) => params.threadId === threadId);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ method: "item/tool/requestUserInput", params: { threadId, isBlocking: true } });
    expect(asked[0].params.questions).toEqual([expect.objectContaining({
      question: "Which color?", header: "Pick", options: [{ label: "Red", description: "Red option" }, { label: "Blue", description: "Blue option" }],
    })]);
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(itemsOf(thread.turns).at(-1)).toBe("agent:you picked Blue");
  });

  it("shows Claude's thinking as a reasoning summary, live and in history", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "think: the answer");
    const summaries = (items: any[]) => items.filter((item) => item.type === "reasoning").map((item) => item.summary.join(""));
    const live = client.notifications("item/completed", threadId).map((message) => message.params.item);
    expect(summaries(live)).toEqual(["pondering the answer"]);
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(summaries(thread.turns[0].items)).toEqual(["pondering the answer"]);
  });

  it("shows Claude's task list as the turn's to-do list, like stock's plan updates", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "track tasks: Count files|Report|Clean up");
    const plans = client.notifications("turn/plan/updated", threadId).map((message) => message.params.plan);
    expect(plans).toEqual([
      [{ step: "Count files", status: "pending" }],
      [{ step: "Count files", status: "pending" }, { step: "Report", status: "pending" }],
      [{ step: "Count files", status: "pending" }, { step: "Report", status: "pending" }, { step: "Clean up", status: "pending" }],
      [{ step: "Count files", status: "inProgress" }, { step: "Report", status: "pending" }, { step: "Clean up", status: "pending" }],
      [{ step: "Count files (done)", status: "completed" }, { step: "Report", status: "pending" }, { step: "Clean up", status: "pending" }],
      [{ step: "Count files (done)", status: "completed" }, { step: "Clean up", status: "pending" }],
    ]);
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

  it("refuses a Claude turn while another live Claude process has the chat open (a stale registry entry does not count)", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "one");
    const sessions = join(process.env.CLAUDE_CONFIG_DIR!, "sessions");
    mkdirSync(sessions, { recursive: true });
    const register = (pid: number) => writeFileSync(join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId: threadId }));
    register(2 ** 22 + 1);
    await client.turn(threadId, "two");
    register(process.ppid);
    await expect(client.request("turn/start", { threadId, input: text("three") }))
      .rejects.toThrow(`This chat is open in another Claude process (pid ${process.ppid})`);
    rmSync(join(sessions, `${process.ppid}.json`));
    await client.turn(threadId, "four");
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(itemsOf(thread.turns)).toEqual(["user:one", "agent:claude: one", "user:two", "agent:claude: two", "user:four", "agent:claude: four"]);
  });

  it("shows a Claude chat's Fast off once Claude answered at standard speed for it (no usage credits)", async () => {
    fakeClaude.fastOff = true;
    const threadId = await claudeThread();
    await client.turn(threadId, "one", { serviceTier: "fast" });
    await vi.waitFor(() => expect(client.notifications("thread/settings/updated", threadId).at(-1)!.params.threadSettings).toMatchObject({ serviceTier: null }));
    expect(await client.request("thread/resume", { threadId })).toMatchObject({ serviceTier: null });
  });

  it("runs a Claude chat with no effort chosen at the effort the picker shows for its model, not Claude's own default", async () => {
    const opus = (await client.request("model/list", {})).data.find((model: any) => model.id === CLAUDE);
    const threadId = await claudeThread();
    await client.turn(threadId, "one");
    expect(fakeClaude.options.at(-1)!.effort).toBe(opus.defaultReasoningEffort);
  });

  it("offers stock's ultra effort on Claude models: Claude's max, delegation told on and off like stock's mode message, out of the history", async () => {
    const opus = (await client.request("model/list", {})).data.find((model: any) => model.id === CLAUDE);
    expect(opus.supportedReasoningEfforts.map((effort: any) => effort.reasoningEffort)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    const threadId = await claudeThread();
    await client.turn(threadId, "one", { effort: "ultra" });
    expect(fakeClaude.options.at(-1)!.effort).toBe("max");
    await client.turn(threadId, "two", { effort: "ultra" });
    await client.turn(threadId, "three", { effort: "high" });
    const told = fakeClaude.prompts.filter((prompt) => !prompt.shouldQuery).map((prompt) =>
      prompt.text.includes("Proactive multi-agent delegation is active") ? "on" : prompt.text.includes("delegation no longer applies") ? "off" : prompt.text);
    expect(told).toEqual(["on", "off"]);
    expect(fakeClaude.calls.filter((call) => call.method === "applyFlagSettings").map((call) => (call.args[0] as any).effortLevel)).toEqual(["high"]);
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(itemsOf(thread.turns)).toEqual(["user:one", "agent:claude: one", "user:two", "agent:claude: two", "user:three", "agent:claude: three"]);
  });

  it("keeps an ultra chat on ultra after a restart: delegation is told on once and off once (Claude records max and the mode message)", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "one", { effort: "ultra" });
    await gateway.stop();
    gateway = await startTestGateway();
    client = await gateway.connect();
    expect((await client.request("thread/read", { threadId })).thread.reasoningEffort).toBe("ultra");
    expect(await client.request("thread/resume", { threadId })).toMatchObject({ reasoningEffort: "ultra" });
    await client.turn(threadId, "two", { effort: null });
    await client.turn(threadId, "three", { effort: "high" });
    const told = fakeClaude.prompts.filter((prompt) => !prompt.shouldQuery).map((prompt) =>
      prompt.text.includes("Proactive multi-agent delegation is active") ? "on" : prompt.text.includes("delegation no longer applies") ? "off" : prompt.text);
    expect(told).toEqual(["on", "off"]);
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

  it("answers /cc and its aliases with a synthetic turn", async () => {
    const answerOf = (threadId: string) => client.notifications("item/completed", threadId).map((message) => message.params.item)
      .filter((item) => item.type === "agentMessage").at(-1).text as string;
    const threadId = await stockThread();
    await client.turn(threadId, "/ccstatus");
    expect(answerOf(threadId)).toMatch(/^### ◆ CCodex `[^`]+`\n\n\*\*֎ /u);
    // Claude's limits come from its /usage data before any Claude turn.
    expect(answerOf(threadId)).toContain("| **Claude 5h** | `█░░░░░░░░░░░░░░░░░░░` 5% |\n| **Claude week** | `█░░░░░░░░░░░░░░░░░░░` 3% |\n| **Claude Fable week** | `████████░░░░░░░░░░░░` 40% |");
    const claude = await claudeThread();
    // The skill Desktop's `/` menu offers arrives as its chip.
    const chip = `[$ccodex:status](${(await client.request("skills/list", {})).data[0].skills[0].path}) `;
    for (const command of ["/cc", "CC", " ccodex ", "/ccstate", "ccstatus", "$cc", "$ccodex:status", chip]) {
      await client.turn(claude, command);
      expect(answerOf(claude)).toContain("**❋ Claude Opus 5.5** · Ask · 🟡 Idle");
    }
    // Or as its `$` text plus the skill item.
    const path = (await client.request("skills/list", {})).data[0].skills[0].path;
    const answers = client.notifications("item/completed", claude).length;
    await client.turn(claude, "", { input: [
      { type: "text", text: "$ccodex:status", text_elements: [] }, { type: "skill", name: "ccodex:status", path }] });
    expect(client.notifications("item/completed", claude).length).toBeGreaterThan(answers);
    expect(answerOf(claude)).toContain("**❋ Claude Opus 5.5** · Ask · 🟡 Idle");
    expect(answerOf(claude)).toContain(`_Thread \`${claude}\``);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.notifications("thread/status/changed", claude).at(-1)!.params.status).toEqual({ type: "idle" });
    const { thread } = await client.request("thread/read", { threadId: claude, includeTurns: true });
    expect(thread.turns).toHaveLength(0);
    expect(fakeClaude.prompts).toHaveLength(0);
  });

  it("/cc: Claude's 5h and weekly windows come from its turns' rate limit events when its /usage data does not", async () => {
    const answerOf = (threadId: string) => client.notifications("item/completed", threadId).map((message) => message.params.item)
      .filter((item) => item.type === "agentMessage").at(-1).text as string;
    fakeClaude.usageDown = true;
    const threadId = await claudeThread();
    await client.turn(threadId, "/cc");
    expect(answerOf(threadId)).toContain("| **Claude** | 🔴 limits unavailable: claude.ai's usage endpoint did not answer |");
    await client.turn(threadId, "one");
    const limits = (await client.request("account/rateLimits/read", {})).rateLimits;
    expect([limits.primary, limits.secondary]).toEqual([
      { usedPercent: 10, windowDurationMins: 300, resetsAt: 1790539800 }, { usedPercent: 6, windowDurationMins: 10_080, resetsAt: 1791082800 }]);
    await client.turn(threadId, "/cc");
    expect(answerOf(threadId)).toMatch(/\| \*\*Claude 5h\*\* \| `█+░+` 10% · resets [^|]+ \|\n\| \*\*Claude week\*\* \| `█+░+` 6% · resets [^|]+ \|\n\| \*\*Codex/u);
  });

  it("answers /cc sent while a turn runs (steered or queued) at once inside that turn, never telling the model", async () => {
    const threadId = await claudeThread();
    // The turn waits on its tool approval until the test answers it.
    let approve!: () => void;
    client.onRequest = () => new Promise((resolve) => { approve = () => resolve({ decision: "accept" }); });
    const { turn } = await client.request("turn/start", { threadId, input: text("this needs approval") });
    await vi.waitFor(() => expect(approve).toBeDefined());
    expect(await client.request("turn/steer", { threadId, input: text("/cc"), expectedTurnId: turn.id, clientUserMessageId: "c1" })).toEqual({ turnId: turn.id });
    await vi.waitFor(() => expect(client.notifications("item/completed", threadId).map((message) => message.params)
      .find((params) => params.item.type === "agentMessage" && params.item.text.includes("🟢 Running"))?.turnId).toBe(turn.id));
    expect(client.notifications("item/completed", threadId).find((message) => message.params.item.clientId === "c1")!.params.turnId).toBe(turn.id);
    // Desktop's skill chip, queued behind the running turn.
    await client.request("thread/queue/add", { threadId, input: text("[$ccodex:status](/x/ccodex-status/SKILL.md) \n"), clientUserMessageId: "c2" });
    await vi.waitFor(() => expect(client.notifications("item/completed", threadId).find((message) => message.params.item.clientId === "c2")?.params.turnId).toBe(turn.id));
    expect((await client.request("thread/queue/list", { threadId })).data).toEqual([]);
    approve();
    await client.waitFor("turn/completed", (params) => params.turn.id === turn.id);
    expect(fakeClaude.prompts.map((prompt) => prompt.text)).toEqual(["this needs approval"]);
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(itemsOf(thread.turns).filter((item: string) => item.startsWith("user:"))).toEqual(["user:this needs approval"]);
  });

  it("drops a message steered into a command Claude waits on when Stop comes first, as stock and Claude Code do", async () => {
    const threadId = await claudeThread();
    const { turn } = await client.request("turn/start", { threadId, input: text("run until stopped: sleep 600") });
    await client.waitFor("item/started", (params) => params.threadId === threadId && params.item.type === "commandExecution");
    await client.request("turn/steer", { threadId, input: text("how are you?"), expectedTurnId: turn.id });
    await client.request("turn/interrupt", { threadId, turnId: turn.id });
    expect((await client.waitFor("turn/completed", (params) => params.turn.id === turn.id)).turn.status).toBe("interrupted");
    const next = await client.turn(threadId, "after the stop");
    expect(next.turn.id).not.toBe(turn.id);
    expect(fakeClaude.prompts.map((prompt) => prompt.text)).toEqual(["run until stopped: sleep 600", "after the stop"]);
  });

  it("moves the command a turn waits on to the background on a steer, as Claude Code's send now: Claude reads the message at once", async () => {
    const threadId = await claudeThread();
    const { turn } = await client.request("turn/start", { threadId, input: text("run until stopped: sleep 600") });
    await client.waitFor("item/started", (params) => params.threadId === threadId && params.item.type === "commandExecution");
    await client.request("turn/steer", { threadId, input: text("how are you?"), expectedTurnId: turn.id });
    expect(fakeClaude.calls.filter((call) => call.method === "backgroundTasks")).toEqual([{ method: "backgroundTasks", args: [undefined] }]);
    await client.request("turn/interrupt", { threadId, turnId: turn.id });
    await client.waitFor("turn/completed", (params) => params.turn.id === turn.id);
  });

  it("shows Claude's banners as Claude Code does: not its transcript-only info ones", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "banners");
    const texts = client.notifications("item/completed", threadId).map((message) => message.params.item.text);
    expect(texts).toContain("a warning");
    expect(texts).not.toContain("transcript-only detail");
  });

  it("shows the output a command Stop killed had so far, not Claude's refusal of the call (live and after a restart)", async () => {
    const threadId = await claudeThread();
    const { turn } = await client.request("turn/start", { threadId, input: text("run until stopped: ticks") });
    await client.waitFor("item/started", (params) => params.threadId === threadId && params.item.type === "commandExecution");
    // A command the turn waits on is no background task (/cc, Desktop's background terminals).
    expect((await client.request("thread/backgroundTerminals/list", { threadId })).data).toEqual([]);
    await client.request("turn/steer", { threadId, input: text("/cc"), expectedTurnId: turn.id });
    await vi.waitFor(() => expect(client.notifications("item/completed", threadId).some((message) => message.params.item.text?.includes("working on a turn"))).toBe(true));
    expect(client.notifications("item/completed", threadId).find((message) => message.params.item.text?.includes("working on a turn"))!.params.item.text).not.toContain("background task");
    await client.request("turn/interrupt", { threadId, turnId: turn.id });
    await client.waitFor("turn/completed", (params) => params.turn.id === turn.id);
    const command = (item: any) => [item.type, item.status, item.aggregatedOutput];
    const live = client.notifications("item/completed", threadId).map((message) => message.params.item).find((item) => item.type === "commandExecution");
    expect(command(live)).toEqual(["commandExecution", "failed", "tick 1\ntick 2\n"]);
    await gateway.stop();
    gateway = await startTestGateway();
    client = await gateway.connect();
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(command(thread.turns[0].items.find((item: any) => item.type === "commandExecution"))).toEqual(command(live));
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

  it("refuses a fork or an edit from a /cc answer with a clear error (the status turn is not part of the chat)", async () => {
    for (const threadId of [await claudeThread(), await stockThread()]) {
      await client.turn(threadId, "apple");
      const { turn: status } = await client.turn(threadId, "/cc");
      await expect(client.request("thread/fork", { threadId, lastTurnId: status.id })).rejects.toThrow("CCodex status message");
      await expect(client.request("thread/revert", { threadId, beforeTurnId: status.id })).rejects.toThrow("CCodex status message");
    }
  });

  it("answers Desktop's description turn on a Claude chat's ephemeral fork (after a rename) with JSON matching its schema", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "context");
    const { thread: fork } = await client.request("thread/fork", {
      threadId, model: "gpt-6-luna", approvalPolicy: "never", permissions: ":read-only", runtimeWorkspaceRoots: [], ephemeral: true,
      excludeTurns: true, threadSource: "thread_description",
    });
    const outputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { description: { type: "string", minLength: 1 } },
      required: ["description"], additionalProperties: false,
    };
    await client.turn(fork.id, "You are in a fork of an existing Codex thread.\nFill the structured description field.", {
      turnTrigger: "thread_description", permissions: ":read-only", summary: "none", outputSchema,
    });
    const answer = client.notifications("item/completed", fork.id).map((message) => message.params.item).find((item) => item.type === "agentMessage");
    expect(JSON.parse(answer.text)).toEqual({ description: "side: You are in a fork of an existing Codex thread." });
    // Asked of the chat's own session, never as a turn of the chat.
    expect(fakeClaude.prompts.map((prompt) => prompt.text)).toEqual(["context"]);
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

    // Claude's /goal has no pause: pausing clears it there and keeps it in meta.json, resuming sets it again.
    const turnsBefore = client.notifications("turn/started", threadId).length;
    expect((await client.request("thread/goal/set", { threadId, status: "paused" })).goal).toMatchObject({ objective: "ship it", status: "paused" });
    await vi.waitFor(() => expect(fakeClaude.prompts.at(-1)?.text).toBe("/goal clear"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await client.request("thread/goal/get", { threadId })).goal).toMatchObject({ objective: "ship it", status: "paused" });
    expect(JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8")).pausedGoals[threadId]).toMatchObject({ objective: "ship it" });
    expect(client.notifications("turn/started", threadId)).toHaveLength(turnsBefore);
    expect((await client.request("thread/goal/set", { threadId, status: "active" })).goal).toMatchObject({ objective: "ship it", status: "active" });
    await client.waitFor("turn/completed", (params) => params.threadId === threadId && fakeClaude.prompts.at(-1)?.text === "/goal ship it");
    expect(JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8")).pausedGoals).toEqual({});
    // Cleared while paused: Claude has nothing to clear.
    await client.request("thread/goal/set", { threadId, status: "paused" });
    await vi.waitFor(() => expect(fakeClaude.prompts.at(-1)?.text).toBe("/goal clear"));
    const beforeClear = fakeClaude.prompts.length;
    expect(await client.request("thread/goal/clear", { threadId })).toEqual({ cleared: true });
    expect((await client.request("thread/goal/get", { threadId })).goal).toBeNull();
    expect(fakeClaude.prompts).toHaveLength(beforeClear);
    await client.request("thread/goal/set", { threadId, objective: "ship it" });
    await client.waitFor("turn/completed", (params) => params.threadId === threadId && fakeClaude.prompts.at(-1)?.text === "/goal ship it");

    // Claude drops a met goal: reported complete once, then Desktop's clear sends Claude nothing.
    await client.turn(threadId, "this meets the goal: ship it");
    await client.waitFor("thread/goal/updated", (params) => params.threadId === threadId && params.goal.status === "complete");
    const prompts = fakeClaude.prompts.length;
    expect(await client.request("thread/goal/clear", { threadId })).toEqual({ cleared: true });
    expect(fakeClaude.prompts).toHaveLength(prompts);
    expect((await client.request("thread/goal/get", { threadId })).goal).toBeNull();

    // Claude pursues a goal in one turn and runs a command sent meanwhile only after it: an edit stops that turn first.
    await client.request("thread/goal/set", { threadId, objective: "keep going" });
    await client.waitFor("turn/started", (params) => params.threadId === threadId && fakeClaude.prompts.at(-1)?.text === "/goal keep going");
    const edited = client.notifications("turn/completed", threadId).length;
    const interrupts = () => fakeClaude.calls.filter((call) => call.method === "interrupt").length;
    const interrupted = interrupts();
    await client.request("thread/goal/set", { threadId, objective: "again" });
    await vi.waitFor(() => expect(client.notifications("turn/completed", threadId).slice(edited).map((message) => message.params.turn.status)).toEqual(["interrupted", "completed"]));
    expect(interrupts()).toBe(interrupted + 1);

    // Clearing is no turn.
    const turns = client.notifications("turn/started", threadId).length;
    const clearedAt = client.messages.length;
    expect(await client.request("thread/goal/clear", { threadId })).toEqual({ cleared: true });
    await vi.waitFor(() => expect(fakeClaude.prompts.at(-1)?.text).toBe("/goal clear"));
    expect(client.messages.slice(clearedAt).filter((message) => message.method === "thread/goal/cleared")).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.notifications("turn/started", threadId)).toHaveLength(turns);
    expect((await client.request("thread/goal/get", { threadId })).goal).toBeNull();
    expect(await client.request("thread/goal/clear", { threadId })).toEqual({ cleared: false });

    // Claude's own word on its goal ("Goal set: …", "Goal cleared: …") is no chat message, live or in history.
    const history = await client.request("thread/read", { threadId, includeTurns: true });
    const historyItems = history.thread.turns.flatMap((t: any) => t.items);
    const texts = historyItems.filter((item: any) => item.type === "userMessage").map((item: any) => item.content[0].text);
    expect(texts).toEqual(["start", "/goal ship it", "/goal ship it", "/goal ship it", "this meets the goal: ship it", "/goal keep going", "/goal again"]);
    const said = [...historyItems, ...client.notifications("item/completed", threadId).map((message) => message.params.item)]
      .filter((item: any) => item.type === "agentMessage").map((item: any) => item.text);
    expect(said.filter((text: string) => /Goal (?:set|cleared)|No goal/u.test(text))).toEqual([]);
    expect(history.thread.turns).toHaveLength(turns);
  });

  it("adds our formatting to Desktop's app context for stock, also for the stock thread a switch starts, and gives Claude its own", async () => {
    const desktop = "<app-context>\n# Codex desktop context\n</app-context>\n\n### Projectless Chat";
    const formatted = /^<app-context>\n# Codex desktop context\n\n### Formulas\n[\s\S]*### Plots\n[\s\S]*\n<\/app-context>\n\n### Projectless Chat$/u;
    const instructions = async () => Object.fromEntries((await client.request("test/threads")).threads.map((thread: any) => [thread.id, thread.instructions]));
    const { thread: gpt } = await client.request("thread/start", { model: "gpt-6-luna", cwd: "/work", developerInstructions: desktop });
    const { thread: claude } = await client.request("thread/start", { model: CLAUDE, cwd: "/work", developerInstructions: desktop });
    await client.turn(claude.id, "start");
    expect(fakeClaude.options.at(-1)!.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: expect.stringMatching(/^# Desktop app\n[\s\S]*\n\n### Formulas\n[\s\S]*### Plots\n/u) });
    await client.turn(claude.id, "go", { model: "gpt-6-luna" });
    const viewer = await gateway.connect();
    await viewer.request("thread/resume", { threadId: claude.id, developerInstructions: desktop });
    await viewer.turn(claude.id, "again");
    const all = await instructions();
    expect(all[gpt.id]).toEqual([expect.stringMatching(formatted)]);
    // The stock backend reads as the chat's own id: started by the switch, resumed for the other client.
    expect(all[claude.id]).toEqual([expect.stringMatching(formatted), expect.stringMatching(formatted)]);

    await gateway.stop();
    gateway = await startTestGateway({ improveModelsFormatting: false });
    client = await gateway.connect();
    const { thread: plain } = await client.request("thread/start", { model: "gpt-6-luna", cwd: "/work", developerInstructions: desktop });
    expect((await instructions())[plain.id]).toEqual([desktop]);
    await client.turn(await claudeThread(), "start");
    expect(fakeClaude.options.at(-1)!.systemPrompt.append).toMatch(/^# Desktop app\n/u);
    expect(fakeClaude.options.at(-1)!.systemPrompt.append).not.toContain("### Formulas");
  });

  it("carries a chat's goal to the model it switches to, active or paused, and stops the Claude session it leaves", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "start");
    await client.request("thread/goal/set", { threadId, objective: "ship it" });
    await vi.waitFor(async () => expect((await client.request("thread/goal/get", { threadId })).goal).toMatchObject({ status: "active" }), 2_000);
    await client.turn(threadId, "go", { model: "gpt-6-luna" });
    expect(fakeClaude.prompts.map((prompt) => prompt.text)).toContain("/goal clear");
    expect(fakeClaude.calls.filter((call) => call.method === "close").map((call) => call.args[0])).toContain(threadId);
    expect((await client.request("thread/goal/get", { threadId })).goal).toMatchObject({ threadId, objective: "ship it", status: "active" });
    expect(client.notifications("thread/goal/updated", threadId).at(-1)!.params.goal).toMatchObject({ threadId, objective: "ship it", status: "active" });

    await client.request("thread/goal/set", { threadId, status: "paused" });
    await client.turn(threadId, "back", { model: CLAUDE });
    const claude = JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8")).lineages[threadId].at(-1).threadId;
    expect((await client.request("thread/goal/get", { threadId })).goal).toMatchObject({ threadId, objective: "ship it", status: "paused" });
    expect(JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8")).pausedGoals[claude]).toMatchObject({ objective: "ship it" });
    await client.request("thread/goal/set", { threadId, status: "active" });
    await client.waitFor("turn/completed", (params) => params.threadId === threadId && fakeClaude.prompts.at(-1)?.text === "/goal ship it");
  });

  it("ends a Claude chat's background tasks before the switch away from it compacts (a task ending then would wake Claude up unseen)", async () => {
    fakeClaude.backgroundMs = 1_500;
    const threadId = await claudeThread();
    await client.turn(threadId, "watch in background: sleep 1");
    let compactedAfter: string[] | undefined;
    const prompts = fakeClaude.prompts;
    const push = prompts.push.bind(prompts);
    prompts.push = (...entries) => {
      if (entries.some((entry) => entry.text.startsWith("/compact"))) compactedAfter = fakeClaude.calls.map((call) => call.method);
      return push(...entries);
    };
    await client.turn(threadId, "go", { model: "gpt-6-luna" });
    prompts.push = push;
    expect(compactedAfter).toContain("stopTask");
  });

  it("takes Desktop's goal mode (a `/goal X` turn, then goal X set) as one goal that edits and pauses replace", async () => {
    const threadId = await claudeThread();
    const texts = () => fakeClaude.prompts.map((prompt) => prompt.text);
    // Desktop's goal mode sends the goal's message as a turn, then sets the goal: Claude gets `/goal` once.
    await client.request("turn/start", { threadId, input: text("/goal keep going\n") });
    await client.request("thread/goal/set", { threadId, objective: "keep going", status: "active" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(texts()).toEqual(["/goal keep going\n"]);
    // An edit stops the goal's turn and Claude pursues the new goal.
    await client.request("thread/goal/set", { threadId, objective: "met when stopped" });
    await vi.waitFor(() => expect(texts().at(-1)).toBe("/goal met when stopped"), 2_000);
    await client.waitFor("turn/started", (params) => params.threadId === threadId && texts().at(-1) === "/goal met when stopped");
    // Met just as an edit stops it (Claude yet to take the new goal): the replaced goal's completion is no news
    // (Desktop would clear the new goal for it).
    let release!: () => void;
    fakeClaude.goalHold = new Promise((resolve) => { release = resolve; });
    const turnsDone = client.notifications("turn/completed", threadId).length;
    await client.request("thread/goal/set", { threadId, objective: "keep going" });
    await vi.waitFor(() => expect(client.notifications("turn/completed", threadId)).toHaveLength(turnsDone + 1), 2_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await vi.waitFor(() => expect(texts().at(-1)).toBe("/goal keep going"), 2_000);
    expect(client.notifications("thread/goal/updated", threadId).filter((message) => message.params.goal.status === "complete")).toEqual([]);
    expect(client.notifications("thread/goal/cleared", threadId)).toEqual([]);
    // Pausing stops the goal's turn too; resuming sets it again.
    await client.request("thread/goal/set", { threadId, status: "paused" });
    await vi.waitFor(() => expect(texts().at(-1)).toBe("/goal clear"), 2_000);
    await client.request("thread/goal/set", { threadId, status: "active" });
    await vi.waitFor(() => expect(texts().at(-1)).toBe("/goal keep going"), 2_000);
    expect(texts()).toEqual(["/goal keep going\n", "/goal met when stopped", "/goal keep going", "/goal clear", "/goal keep going"]);
    await client.request("thread/goal/clear", { threadId });
    await vi.waitFor(() => expect(texts().at(-1)).toBe("/goal clear"), 2_000);
    // Paused right after Desktop's goal mode set it.
    await client.request("turn/start", { threadId, input: text("/goal keep going\n") });
    await client.request("thread/goal/set", { threadId, objective: "keep going", status: "active" });
    await vi.waitFor(async () => expect((await client.request("thread/goal/get", { threadId })).goal).toMatchObject({ status: "active" }), 2_000);
    await client.request("thread/goal/set", { threadId, status: "paused" });
    await vi.waitFor(() => expect(texts().slice(-3)).toEqual(["/goal clear", "/goal keep going\n", "/goal clear"]), 2_000);
    expect((await client.request("thread/goal/get", { threadId })).goal).toMatchObject({ objective: "keep going", status: "paused" });
  });

  it("pauses a Claude goal set a moment ago: Claude's goal turn stops and the goal stays paused", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "start");
    await client.request("thread/goal/set", { threadId, objective: "keep going" });
    await client.waitFor("turn/started", (params) => params.threadId === threadId && fakeClaude.prompts.at(-1)?.text === "/goal keep going");
    expect((await client.request("thread/goal/set", { threadId, status: "paused" })).goal).toMatchObject({ objective: "keep going", status: "paused" });
    await client.waitFor("turn/completed", (params) => params.threadId === threadId && params.turn.status === "interrupted");
    await vi.waitFor(() => expect(fakeClaude.prompts.at(-1)?.text).toBe("/goal clear"));
    expect((await client.request("thread/goal/get", { threadId })).goal).toMatchObject({ objective: "keep going", status: "paused" });
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

  it("runs a message queued during a Claude turn, as edited, once the turn ends (Desktop's queue)", async () => {
    const threadId = await claudeThread();
    let approve!: (value: unknown) => void;
    const asked = new Promise<void>((running) => {
      client.onRequest = () => new Promise((resolve) => { approve = resolve; running(); });
    });
    await client.request("turn/start", { threadId, input: text("this needs approval") });
    await asked;
    const { queuedSubmission } = await client.request("thread/queue/add", { threadId, input: text("queued") });
    const deleted = await client.request("thread/queue/add", { threadId, input: text("dropped") });
    await client.request("thread/queue/update", { threadId, queuedSubmissionId: queuedSubmission.id, input: text("queued, edited") });
    await client.request("thread/queue/delete", { threadId, queuedSubmissionId: deleted.queuedSubmission.id });
    expect((await client.request("thread/queue/list", { threadId })).data.map((entry: any) => entry.input[0].text)).toEqual(["queued, edited"]);
    approve({ decision: "accept" });
    await client.waitFor("turn/completed", (params) => params.threadId === threadId && fakeClaude.prompts.at(-1)?.text === "queued, edited");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(thread.turns.map((turn: any) => itemsOf([turn]).filter((item) => item.startsWith("user:") || item.startsWith("agent:")))).toEqual([
      ["user:this needs approval", "agent:approval allow"],
      ["user:queued, edited", "agent:claude: queued, edited"],
    ]);
    expect((await client.request("thread/queue/list", { threadId })).data).toEqual([]);
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

  it("shows a foreground Claude sub-agent settled: its spawn completes only after it finished", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "run a foreground sub-agent");
    const childId = "agent-f0f0f0";
    expect(client.notifications("thread/status/changed", childId).map((message) => message.params.status.type)).toEqual(["idle"]);
    const settled = await client.request("thread/read", { threadId: childId, includeTurns: true });
    expect(settled.thread).toMatchObject({ parentThreadId: threadId, status: { type: "idle" }, turns: [{ status: "completed" }] });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { thread } = await client.request("thread/read", { threadId: childId, includeTurns: true });
    expect(itemsOf(thread.turns)).toEqual(["user:Reply SUB-OK", "agent:SUB-OK"]);
    // Desktop's composer on the sub-agent's page shows the effort it ran with.
    expect(await client.request("thread/resume", { threadId: childId })).toMatchObject({ reasoningEffort: "high" });
  });

  it("shows a message to a finished Claude sub-agent in its thread, like stock's to an idle one: the sub-agent runs again in a turn of its own", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "run a foreground sub-agent");
    const childId = "agent-f0f0f0";
    await new Promise((resolve) => setTimeout(resolve, 400));
    await client.request("thread/resume", { threadId: childId });
    const before = client.messages.length;
    await client.turn(threadId, "message the finished sub-agent");
    await client.waitFor("turn/completed", (params) => params.threadId === childId);
    const live = client.messages.slice(before).filter((message) => message.params?.threadId === childId).map((message) =>
      message.method === "thread/status/changed" ? `status ${message.params.status.type}`
      : message.method === "item/completed" ? `item ${itemsOf([{ items: [message.params.item] }])}` : message.method);
    expect(live.filter((event, index) => event !== live[index - 1])).toEqual([
      "status active", "turn/started", "item/started", "item user:Now reply AGAIN-OK", "item/started", "item agent:AGAIN-OK", "turn/completed", "status idle",
    ]);
    const { thread } = await client.request("thread/read", { threadId: childId, includeTurns: true });
    expect(thread.turns.map((turn: any) => itemsOf([turn]))).toEqual([["user:Reply SUB-OK", "agent:SUB-OK"], ["user:Now reply AGAIN-OK", "agent:AGAIN-OK"]]);
  });

  it("shows what Codex says in a Claude thread's Codex MCP call, live and in history", async () => {
    const threadId = await claudeThread();
    const before = client.messages.length;
    await client.turn(threadId, "ask codex: DIG");
    const codex = ["◆ CCodex │ Codex MCP prompt · gpt-6-sol · high\n\nDIG", "◆ CCodex │ Codex MCP message\n\ncodex says: DIG"];
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
    const conversation = ["user:DIG", "mcpToolCall", "◆ CCodex │ Codex MCP prompt · gpt-6-sol · high\n\nDIG", "◆ CCodex │ Codex MCP message\n\ncodex says: DIG", "Codex is done"];
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

  it("switches claude → gpt again after an edit of the switched turn (Claude has nothing new to compact)", async () => {
    const other = await gateway.connect();
    const threadId = await claudeThread();
    await client.turn(threadId, "first");
    const { turn: switched } = await client.turn(threadId, "second", { model: "gpt-6-luna" });
    await client.request("thread/revert", { threadId, beforeTurnId: switched.id });
    // Undoing the switch archives only its backend: the thread stays loaded and listed for every client.
    for (const connection of [client, other]) {
      expect(connection.notifications("thread/archived", threadId)).toEqual([]);
      expect(connection.notifications("thread/status/changed", threadId).map((message) => message.params.status.type)).not.toContain("notLoaded");
    }
    const before = client.notifications("turn/started", threadId).length;
    const { turn } = await client.request("turn/start", { threadId, model: "gpt-6-luna", input: text("second, edited") });
    await client.waitFor("turn/completed", (params) => params.threadId === threadId && client.notifications("item/completed", threadId)
      .some((message) => message.params.item.text === "gpt: second, edited"));
    expectLiveSwitch(threadId, before, turn.id);
    const { threads } = await client.request("test/threads");
    expect(threads.filter((thread: any) => thread.injected.length).at(-1).injected[0].content[0].text).toContain("SUMMARY(You are performing");
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(itemsOf(thread.turns)).toEqual(["user:first", "agent:claude: first", "contextCompaction", "user:second, edited", "agent:gpt: second, edited"]);
  });

  // Like stock, every client with a chat open sees the turns another client runs there, and the model it picked.
  it.each([["gpt → claude", "gpt-6-luna", CLAUDE, "claude"], ["claude → gpt", CLAUDE, "gpt-6-luna", "gpt"]])(
    "shows a switch %s another client makes to every client with the chat open, and the model it switched to", async (_name, from, to, replier) => {
      const desktop = await gateway.connect();
      const { thread } = await desktop.request("thread/start", { model: from, cwd: "/work" });
      const threadId: string = thread.id;
      await desktop.turn(threadId, "first", { model: from });
      await client.request("thread/resume", { threadId });
      const since = [desktop.messages.length, client.messages.length];
      await client.turn(threadId, "second", { model: to });
      await client.turn(threadId, "third", { model: to });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const live = (connection: Client, from: number) => connection.messages.slice(from)
        .filter((message) => message.params?.threadId === threadId && /^(?:turn\/started|turn\/completed|item\/completed)$/u.test(message.method))
        .map((message) => `${message.method} ${message.params.turn?.id ?? message.params.turnId} ${message.params.item?.type ?? ""} ${message.params.item?.text ?? ""}`)
        .sort();
      expect(live(desktop, since[0]!)).toEqual(live(client, since[1]!));
      expect(live(desktop, since[0]!).filter((entry) => entry.includes("agentMessage")).map((entry) => entry.split(" agentMessage ")[1]))
        .toEqual(expect.arrayContaining([`${replier}: second`, `${replier}: third`]));
      expect(desktop.notifications("thread/settings/updated", threadId).at(-1)?.params.threadSettings.model).toBe(to);
    });

  it("tells every client with a Claude chat open the model another client's turn picked", async () => {
    const desktop = await gateway.connect();
    const { thread } = await desktop.request("thread/start", { model: CLAUDE, cwd: "/work" });
    await client.request("thread/resume", { threadId: thread.id });
    await client.turn(thread.id, "on haiku", { model: "claude:claude-haiku-4-5-20251001" });
    expect(desktop.notifications("thread/settings/updated", thread.id).at(-1)?.params.threadSettings.model).toBe("claude:claude-haiku-4-5-20251001");
  });

  // The live matrix (experiments/2026_09_23_thin_rewrite/scripts/edit_switch.mjs): a step is a turn, an edit of
  // turn N (Desktop: revert before it, then the step after it sends the new text) or a fork at turn N.
  type Step = { model: string; text: string } | { revert: number } | { fork: number; model: string; text: string };
  const GPT = "gpt-6-luna";
  const on = (model: string, text: string) => ({ model, text });
  const edits: Array<[string, string, Step[], string[], string[]?]> = [
    ["S1 claude→gpt, edit the gpt turn", CLAUDE, [on(CLAUDE, "one"), on(GPT, "two"), { revert: 1 }, on(GPT, "two, edited"), on(GPT, "three")],
      ["user:one", "agent:claude: one", "contextCompaction", "user:two, edited", "agent:gpt: two, edited", "user:three", "agent:gpt: three"]],
    ["S2 gpt→claude, edit the claude turn", GPT, [on(GPT, "one"), on(CLAUDE, "two"), { revert: 1 }, on(CLAUDE, "two, edited"), on(CLAUDE, "three")],
      ["user:one", "agent:gpt: one", "contextCompaction", "user:two, edited", "agent:claude: two, edited", "user:three", "agent:claude: three"]],
    ["S3 claude→gpt, edit the first message, switch again", CLAUDE, [on(CLAUDE, "one"), on(GPT, "two"), { revert: 0 }, on(CLAUDE, "one, edited"), on(GPT, "two, again")],
      ["user:one, edited", "agent:claude: one, edited", "contextCompaction", "user:two, again", "agent:gpt: two, again"]],
    ["S4 claude→gpt, edit the gpt turn on claude, switch again", CLAUDE, [on(CLAUDE, "one"), on(GPT, "two"), { revert: 1 }, on(CLAUDE, "two, on claude"), on(GPT, "three")],
      ["user:one", "agent:claude: one", "contextCompaction", "user:two, on claude", "agent:claude: two, on claude", "contextCompaction", "user:three", "agent:gpt: three"]],
    ["S5 claude→gpt→claude, edit the last turn twice", CLAUDE, [on(CLAUDE, "one"), on(GPT, "two"), on(CLAUDE, "three"), { revert: 2 }, on(CLAUDE, "three, edited"), { revert: 3 }, on(GPT, "three, on gpt")],
      ["user:one", "agent:claude: one", "contextCompaction", "user:two", "agent:gpt: two", "user:three, on gpt", "agent:gpt: three, on gpt"]],
    ["S6 claude→gpt, edit the gpt turn, fork at it", CLAUDE, [on(CLAUDE, "one"), on(GPT, "two"), { revert: 1 }, on(GPT, "two, edited"), { fork: 2, ...on(GPT, "forked") }],
      ["user:one", "agent:claude: one", "contextCompaction", "user:two, edited", "agent:gpt: two, edited"],
      ["user:one", "agent:claude: one", "contextCompaction", "user:two, edited", "agent:gpt: two, edited", "user:forked", "agent:gpt: forked"]],
    ["S7 gpt→claude, edit the first message, switch again", GPT, [on(GPT, "one"), on(CLAUDE, "two"), { revert: 0 }, on(GPT, "one, edited"), on(CLAUDE, "two, again")],
      ["user:one, edited", "agent:gpt: one, edited", "contextCompaction", "user:two, again", "agent:claude: two, again"]],
    ["S8 claude only, edit the only message twice", CLAUDE, [on(CLAUDE, "one"), { revert: 0 }, on(CLAUDE, "one, edited"), { revert: 1 }, on(CLAUDE, "one, again")],
      ["user:one, again", "agent:claude: one, again"]],
    ["S9 gpt only, edit the first message", GPT, [on(GPT, "one"), on(GPT, "two"), { revert: 0 }, on(GPT, "one, edited")],
      ["user:one, edited", "agent:gpt: one, edited"]],
  ];
  it.each(edits)("edits messages around switches: %s", async (_name, first, steps, expected, expectedFork) => {
    const other = await gateway.connect();
    const listed = async () => (await Promise.all([false, true].map((archived) => client.request("thread/list", { limit: 500, archived }))))
      .flatMap((page: any) => page.data.map((row: any) => row.id as string));
    const before = new Set(await listed());
    const { thread: started } = await client.request("thread/start", { model: first, cwd: "/work" });
    const threadId: string = started.id;
    const publicIds = [threadId];
    const turns: string[] = [];
    for (const step of steps) {
      if ("revert" in step) {
        await client.request("thread/revert", { threadId, beforeTurnId: turns[step.revert] });
      } else if ("fork" in step) {
        const { thread: fork } = await client.request("thread/fork", { threadId, lastTurnId: turns[step.fork] });
        publicIds.push(fork.id);
        await client.turn(fork.id, step.text, { model: step.model });
        const { thread } = await client.request("thread/read", { threadId: fork.id, includeTurns: true });
        expect(itemsOf(thread.turns)).toEqual(expectedFork);
      } else {
        const { turn } = await client.turn(threadId, step.text, { model: step.model });
        expect(turn.status).toBe("completed");
        turns.push(turn.id);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(itemsOf(thread.turns)).toEqual(expected);
    // Another window never hears the thread was archived or deleted (switch backends dropped by an edit are deleted).
    expect(other.notifications("thread/archived", threadId)).toEqual([]);
    expect(other.notifications("thread/deleted").filter((message) => publicIds.includes(message.params.threadId))).toEqual([]);
    // No backend is ever listed, not even archived once an edit dropped it (Desktop shows it as a thread of its own).
    expect(new Set((await listed()).filter((id) => !before.has(id)))).toEqual(new Set(publicIds));
  });

  it("previews a Claude thread by the start of its first prompt and searches its messages like stock", async () => {
    const threadId = await claudeThread();
    const prompt = `${"x ".repeat(40)}needle\n\n${"y".repeat(200)}`;
    await client.turn(threadId, prompt);
    await client.request("thread/name/set", { threadId, name: "Haystack title" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const row = (await client.request("thread/list", { limit: 200 })).data.find((thread: any) => thread.id === threadId);
    expect(row.preview).toBe(prompt.slice(0, 100));
    const found = async (searchTerm: string) => (await client.request("thread/search", { searchTerm, limit: 50 })).data
      .find((result: any) => result.thread.id === threadId)?.snippet;
    // Stock's snippet: 49 characters before the match and 96 after, whitespace collapsed; any case; names are not searched.
    expect(await found("NEEDLE")).toBe(`... ${"x ".repeat(24)}needle ${"y".repeat(95)} ...`);
    expect(await found("haystack")).toBeUndefined();
  });

  it("finds a Claude thread's occurrences like stock, and each one's turn through its cursor", async () => {
    const threadId = await claudeThread();
    const first = (await client.turn(threadId, "first needle")).turn;
    await client.turn(threadId, "nothing here");
    const third = (await client.turn(threadId, `${"é".repeat(60)} NEEDLE, **needle** 🙂`)).turn;
    const search = (params: object) => client.request("thread/searchOccurrences", { threadId, ...params });
    const { data, nextCursor } = await search({ searchTerm: "Needle" });
    expect(nextCursor).toBeNull();
    // Every match of the prompts and final answers ("claude: <prompt>"), oldest first; markdown is not searched.
    expect(data.map((found: any) => [found.turnId, found.snippet.slice(found.snippetMatchRange.start, found.snippetMatchRange.end)])).toEqual([
      [first.id, "needle"], [first.id, "needle"],
      [third.id, "NEEDLE"], [third.id, "needle"], [third.id, "NEEDLE"], [third.id, "needle"],
    ]);
    expect(data[2].snippet).toBe(`... ${"é".repeat(48)} NEEDLE, **needle** 🙂`);
    const paged = await search({ searchTerm: "needle", limit: 4 });
    expect(paged.data).toEqual(data.slice(0, 4));
    expect((await search({ searchTerm: "needle", cursor: paged.nextCursor })).data).toEqual(data.slice(4));
    expect((await search({ searchTerm: "absent" })).data).toEqual([]);
    // Desktop opens a match by its turn cursor.
    const { data: [turn] } = await client.request("thread/turns/list", { threadId, cursor: data[2].turnCursor, limit: 1, itemsView: "full" });
    expect(turn.id).toBe(third.id);
    expect(turn.items.map((item: any) => item.id)).toContain(data[2].itemId);
  });

  it("renames a Claude chat after Claude changed directory (its cwd stays the session's own, as a stock thread's)", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "one");
    await client.turn(threadId, "cd /work/sub");
    await client.request("thread/name/set", { threadId, name: "Named" });
    const { thread } = await client.request("thread/read", { threadId });
    expect([thread.name, thread.cwd]).toEqual(["Named", "/work"]);
  });

  it("keeps a Claude thread's name through an edit of its only message", async () => {
    const threadId = await claudeThread();
    const { turn } = await client.turn(threadId, "one");
    await client.request("thread/name/set", { threadId, name: "Named" });
    await client.request("thread/revert", { threadId, beforeTurnId: turn.id });
    expect((await client.request("thread/read", { threadId })).thread.name).toBe("Named");
    await client.turn(threadId, "one, edited");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await client.request("thread/read", { threadId })).thread.name).toBe("Named");
  });

  it("fails a switch to gpt Desktop can see fail: the failed turn was announced as started", async () => {
    const threadId = await claudeThread();
    // A Claude thread without a message has nothing to compact and no summary to carry over.
    await client.request("turn/start", { threadId, model: "gpt-6-luna", input: text("hello") });
    const { turn } = await client.waitFor("turn/completed", (params) => params.threadId === threadId);
    expect(turn.status).toBe("failed");
    expect(turn.error.message).toBe("Switching provider failed: Not enough messages to compact.");
    expect(client.notifications("turn/started", threadId).map((message) => message.params.turn.id)).toEqual([turn.id]);
  });

  it("fails a switch to gpt with Claude's compaction error, never with an earlier compaction's summary", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "first");
    const { turn: switched } = await client.turn(threadId, "second", { model: "gpt-6-luna" });
    await client.request("thread/revert", { threadId, beforeTurnId: switched.id });
    await client.turn(threadId, "second, on claude");
    fakeClaude.compactError = "Error during compaction: summarization produced empty response";
    const { turn } = await client.turn(threadId, "third", { model: "gpt-6-luna" });
    expect(turn.error.message).toBe(`Switching provider failed: ${fakeClaude.compactError}`);
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

  it("lists Claude's models at once after a restart, from the list Claude reported last time", async () => {
    await client.request("model/list", {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    const dataDir = mkdtempSync(join(tmpdir(), "ccodex-state-"));
    writeFileSync(join(dataDir, "claude-models.json"), readFileSync(join(gateway.config.dataDir, "claude-models.json")));
    await gateway.stop();
    fakeClaude.modelsHold = new Promise(() => undefined);
    gateway = await startTestGateway({ dataDir });
    client = await gateway.connect();
    const models = await client.request("model/list", {});
    expect(models.data.map((model: any) => model.id)).toContain(CLAUDE);
  });

  it("leaves the App's name on GPT requests to OpenAI, as with a stock app-server the App runs itself", async () => {
    expect(client.initialized.userAgent).toMatch(/^codex_desktop\//u);
  });

  it("lists every model Claude lists, though Claude refuses to switch to one of them", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ccodex-state-"));
    await gateway.stop();
    fakeClaude.refusedModel = "claude-haiku-4-5-20251001";
    gateway = await startTestGateway({ dataDir });
    client = await gateway.connect();
    const models = await client.request("model/list", {});
    expect(models.data.map((model: any) => model.id)).toEqual(expect.arrayContaining([CLAUDE, "claude:claude-haiku-4-5-20251001"]));
  });

  it("asks Claude again after an update: the list another version reported is stale (a new model)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ccodex-state-"));
    const stale = [{ value: "stale-model", resolvedModel: "claude-stale-1", displayName: "Stale 1", description: "" }];
    writeFileSync(join(dataDir, "claude-models.json"), JSON.stringify({ version: "0.0.1", models: stale }));
    await gateway.stop();
    fakeClaude.modelsHold = new Promise((resolve) => setTimeout(resolve, 300));
    gateway = await startTestGateway({ dataDir });
    client = await gateway.connect();
    const models = await client.request("model/list", {});
    expect(models.data.map((model: any) => model.id)).toContain(CLAUDE);
    expect(models.data.map((model: any) => model.id)).not.toContain("claude:stale-model");
  });

  it("clears the run directories of gateways killed without stopping", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ccodex-state-"));
    const dead = join(dataDir, "run", String(spawnSync("true").pid));
    mkdirSync(dead, { recursive: true });
    await gateway.stop();
    gateway = await startTestGateway({ dataDir });
    expect(readdirSync(join(dataDir, "run"))).toEqual([String(process.pid)]);
  });

  it("pages a switched thread's oldest turn items by its id alone (Desktop after a daemon restart, turns cached)", async () => {
    const threadId = await stockThread();
    await client.turn(threadId, "first");
    await client.turn(threadId, "second", { model: CLAUDE });
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    const page = await client.request("thread/items/list", { threadId, turnId: thread.turns[0].id, limit: 100, sortDirection: "desc" });
    expect(page.data.map((entry: any) => entry.item.type)).toContain("userMessage");
  });

  it("pages on with a stock turns cursor handed out before the thread switched to Claude (issue #33)", async () => {
    const threadId = await stockThread();
    for (const word of ["one", "two", "three"]) await client.turn(threadId, word);
    const page = (cursor: string | null) => client.request("thread/turns/list", { threadId, cursor, limit: 10, sortDirection: "desc" })
      .then((result: any) => itemsOf(result.data));
    const { nextCursor } = await client.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc" });
    const before = await page(nextCursor);
    expect(before).toEqual(["user:two", "agent:gpt: two", "user:one", "agent:gpt: one"]);
    await client.turn(threadId, "four", { model: CLAUDE });
    expect(await page(nextCursor)).toEqual(before);
  });

  it("reads a backend's id as the chat's public id only as a whole value: inside a string (a file path) it stays", async () => {
    fakeClaude.reply = (text) => text === "path" ? `saved /tasks/${fakeClaude.prompts.at(-1)!.sessionId}/out` : `claude: ${text}`;
    const threadId = await claudeThread();
    await client.turn(threadId, "one");
    const saved = async (model: string) => {
      await client.turn(threadId, "path", { model });
      const backend = JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8")).lineages[threadId].at(-1).threadId;
      const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
      return { backend, text: itemsOf(thread.turns).at(-1), live: client.notifications("item/completed", threadId).filter((message) => message.params.item.type === "agentMessage").at(-1)!.params };
    };
    for (const [model, path] of [["gpt-6-luna", "/images/%/a.png"], [CLAUDE, "/tasks/%/out"]] as const) {
      const { backend, text, live } = await saved(model);
      expect(backend).not.toBe(threadId);
      expect(text).toBe(`agent:saved ${path.replace("%", backend)}`);
      expect(live).toMatchObject({ threadId, item: { text: `saved ${path.replace("%", backend)}` } });
    }
  });

  it("opens and pages a claude → gpt thread with stock's cursors as the client got them (each names its own backend)", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "one");
    for (const word of ["two", "three"]) await client.turn(threadId, word, { model: "gpt-6-luna" });
    const desktop = await gateway.connect();
    const resumed = await desktop.request("thread/resume", { threadId, excludeTurns: true });
    const turns: any[] = [];
    let cursor = resumed.turnsBackwardsCursor;
    do {
      const page: any = await desktop.request("thread/turns/list", { threadId, cursor, limit: 1, itemsView: "full", sortDirection: "desc" });
      turns.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    expect(itemsOf(turns.reverse())).toEqual(["user:one", "agent:claude: one", "contextCompaction", "user:two", "agent:gpt: two", "user:three", "agent:gpt: three"]);
    const items: string[] = [];
    cursor = resumed.itemsBackwardsCursor;
    do {
      const page: any = await desktop.request("thread/items/list", { threadId, turnId: turns.at(-1).id, cursor, limit: 1, sortDirection: "desc" });
      items.push(...itemsOf([{ items: page.data.map((entry: any) => entry.item) }]));
      cursor = page.nextCursor;
    } while (cursor);
    expect(items).toEqual(["agent:gpt: three", "user:three"]);
  });

  it("shows a claude → gpt thread's generated image where stock saved it (its GPT backend's directory)", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "one");
    await client.turn(threadId, "two", { model: "gpt-6-luna" });
    const backend = JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8")).lineages[threadId].at(-1).threadId;
    await client.turn(threadId, "draw a red square");
    const saved = `/codex-home/generated_images/${backend}/ig.png`;
    expect(client.notifications("item/completed", threadId).find((message) => message.params.item.type === "imageGeneration")!.params.item.savedPath).toBe(saved);
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(thread.turns.at(-1).items.find((item: any) => item.type === "imageGeneration").savedPath).toBe(saved);
  });

  it("shows the output file Claude names in a gpt → claude thread where Claude writes it (its session's directory)", async () => {
    const threadId = await stockThread();
    await client.turn(threadId, "one");
    await client.turn(threadId, "two", { model: CLAUDE });
    const backend = JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8")).lineages[threadId].at(-1).threadId;
    // Like Claude answering where its background command writes: under the session's own directory.
    const said = `Output is being written to: /tmp/claude-1000/-work/${backend}/tasks/bg1.output`;
    fakeClaude.reply = () => said;
    await client.turn(threadId, "where does the command write?");
    expect(client.notifications("item/completed", threadId).at(-1)!.params.item.text).toBe(said);
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(thread.turns.at(-1).items.at(-1).text).toBe(said);
  });

  it("describes a Claude thread's environment like stock does (Desktop files remote projects' threads by it)", async () => {
    const { thread } = await client.request("thread/start", { model: CLAUDE, cwd: "/work/remote-project" });
    const environments = [{ environmentId: "local", cwd: "/work/remote-project", runtimeWorkspaceRoots: ["/work/remote-project"] }];
    expect(thread.environments).toEqual(environments);
    // Announced after the response, as stock: before it Desktop can't tell its new-chat draft and lists it as a chat.
    await vi.waitFor(() => expect(client.notifications("thread/started").find((message) => message.params.thread.id === thread.id)?.params.thread.environments).toEqual(environments));
    const order = client.messages.filter((message) => message.result?.thread?.id === thread.id || message.params?.thread?.id === thread.id);
    expect(order.map((message) => message.method ?? "response")).toEqual(["response", "thread/started"]);
  });

  it("keeps CCodex's internal threads out of the clients' view (switch summaries, the new Claude backend)", async () => {
    const threadId = await stockThread();
    await client.request("thread/name/set", { threadId, name: "Greeting" });
    await client.turn(threadId, "first");
    await client.request("turn/start", { threadId, model: CLAUDE, input: text("second") });
    await client.waitFor("item/completed", (params) => params.threadId === threadId && params.item.text === "claude: second");
    expect(client.notifications("thread/started").map((message) => message.params.thread.id)).toEqual([threadId]);
    expect(client.notifications("thread/name/updated").map((message) => message.params)).toEqual([
      { threadId, threadName: "Greeting" }, { threadId, threadName: "Greeting ✳️" },
    ]);
    // A client's own ephemeral thread (Desktop's side chat) is still announced to it.
    const { thread: side } = await client.request("thread/fork", { threadId: (await stockThread()), ephemeral: true });
    expect(client.notifications("thread/started").map((message) => message.params.thread.id)).toContain(side.id);
  });

  it("never announces a switch's new stock backend (Desktop keeps a row it was once told of, unopenable)", async () => {
    const other = await gateway.connect();
    const threadId = await claudeThread();
    await client.turn(threadId, "first");
    await client.turn(threadId, "second", { model: "gpt-6-luna" });
    const backendId: string = JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8")).lineages[threadId][1].threadId;
    for (const connection of [client, other]) {
      expect(JSON.stringify(connection.messages.filter((message) => message.method?.startsWith("thread/")))).not.toContain(backendId);
    }
    // A row some client kept anyway is gone, as stock says it, and deleted for that client (Desktop drops it from its
    // catalog); the backend is untouched.
    await expect(other.request("thread/archive", { threadId: backendId })).rejects.toThrow(`no rollout found for thread id ${backendId}`);
    expect(other.notifications("thread/deleted").map((message) => message.params)).toEqual([{ threadId: backendId }]);
    expect(client.notifications("thread/deleted")).toEqual([]);
    const next = await client.turn(threadId, "third", { model: "gpt-6-luna" });
    expect(next.threadId).toBe(threadId);
    expect(client.notifications("item/completed", threadId).some((message) => message.params.item.text === "gpt: third")).toBe(true);
  });

  it("tells a client a thread stock has nothing of is deleted (Desktop's catalog keeps a remote row until told)", async () => {
    const other = await gateway.connect();
    const gone = "01a0ceaa-ef3d-7019-80b2-19d560371ee6";
    await expect(client.request("thread/resume", { threadId: gone })).rejects.toThrow(`no rollout found for thread id ${gone}`);
    expect(client.notifications("thread/deleted").map((message) => message.params)).toEqual([{ threadId: gone }]);
    expect(other.notifications("thread/deleted")).toEqual([]);
  });

  it("lists a new Claude chat only once a turn starts in it (before that it is Desktop's new-chat draft)", async () => {
    const threadId = await claudeThread();
    const listed = async () => (await client.request("thread/list", { limit: 500 })).data.map((row: any) => row.id);
    expect(await listed()).not.toContain(threadId);
    await client.turn(threadId, "hi");
    expect(await listed()).toContain(threadId);
  });

  it("never lists a switch's new Claude backend, even while the switch is still writing it", async () => {
    const threadId = await stockThread();
    await client.turn(threadId, "first");
    let release!: () => void;
    fakeClaude.hold = new Promise((resolve) => { release = resolve; });
    const switched = client.turn(threadId, "second", { model: CLAUDE });
    await vi.waitFor(() => expect(fakeClaude.prompts).toHaveLength(1));
    const backendId = fakeClaude.prompts[0]!.sessionId;
    const pages = await Promise.all([false, true].map((archived) => client.request("thread/list", { limit: 500, archived })));
    release();
    expect(pages.flatMap((page: any) => page.data.map((row: any) => row.id))).not.toContain(backendId);
    expect((await switched).threadId).toBe(threadId);
  });

  it("leaves no empty Claude thread behind when a switch to Claude fails", async () => {
    const threadId = await stockThread();
    await client.turn(threadId, "first");
    fakeClaude.spawnError = "spawn claude EAGAIN";
    await client.request("turn/start", { threadId, model: CLAUDE, input: text("second") });
    await client.waitFor("turn/completed", (params) => params.threadId === threadId && params.turn.status === "failed");
    const list = await client.request("thread/list", { limit: 50 });
    expect(list.data.filter((row: any) => row.modelProvider === "claude" && row.preview === "")).toEqual([]);
  });

  it("fails a switch to Claude with Claude's error when Claude can't start, instead of compacting forever", async () => {
    const threadId = await stockThread();
    await client.turn(threadId, "first");
    fakeClaude.spawnError = "spawn claude EAGAIN";
    await client.request("turn/start", { threadId, model: CLAUDE, input: text("second") });
    const { turn } = await client.waitFor("turn/completed", (params) => params.threadId === threadId && params.turn.status !== "completed");
    expect(turn.status).toBe("failed");
    expect(turn.error.message).toContain("spawn claude EAGAIN");
  });

  it("fails a Claude turn with Claude's error when Claude can't start, and the next turn starts the chat anew", async () => {
    const threadId = await claudeThread();
    fakeClaude.spawnError = "spawn claude EAGAIN";
    const done = await client.turn(threadId, "hello");
    expect(done.turn.status).toBe("failed");
    expect(done.turn.error.message).toContain("spawn claude EAGAIN");
    fakeClaude.spawnError = null;
    expect((await client.turn(threadId, "again")).turn.status).toBe("completed");
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    expect(itemsOf(thread.turns).slice(-2)).toEqual(["user:again", "agent:claude: again"]);
  });

  it("opens a freshly switched thread like Desktop: every turn of the first page paged from resume's items cursor", async () => {
    const threadId = await stockThread();
    await client.turn(threadId, "first");
    await client.request("turn/start", { threadId, model: CLAUDE, input: text("second") });
    await client.waitFor("item/completed", (params) => params.threadId === threadId && params.item.text === "claude: second");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const resumed = await client.request("thread/resume", { threadId, excludeTurns: true });
    const page = await client.request("thread/turns/list", { threadId, cursor: resumed.turnsBackwardsCursor, limit: 5, itemsView: "notLoaded", sortDirection: "desc" });
    const items: string[][] = [];
    for (const turn of page.data) {
      const found = await client.request("thread/items/list", { threadId, turnId: turn.id, cursor: resumed.itemsBackwardsCursor, limit: 100, sortDirection: "desc" });
      items.push(found.data.map((entry: any) => entry.item.type));
    }
    expect(items).toEqual([["agentMessage", "userMessage"], ["contextCompaction"], ["agentMessage", "userMessage"]]);
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

  it("switches gpt → claude in plan mode with the chat's own permissions (Desktop sends none in plan mode)", async () => {
    const threadId = await stockThread();
    await client.turn(threadId, "first", { approvalPolicy: "never", permissions: ":danger-full-access" });
    const plan = { mode: "plan", settings: { model: CLAUDE, reasoning_effort: null, developer_instructions: null } };
    await client.request("thread/settings/update", { threadId, model: CLAUDE, collaborationMode: plan });
    const { turn } = await client.request("turn/start", { threadId, input: text("propose a plan: 1. add the flag"), collaborationMode: plan });
    await client.waitFor("turn/completed", (params) => params.threadId === threadId && params.turn.id === turn.id);
    expect(fakeClaude.options.at(-1)!.permissionMode).toBe("plan");
    expect(client.notifications("thread/settings/updated", threadId).at(-1)!.params.threadSettings).toMatchObject({ approvalPolicy: "never", collaborationMode: { mode: "plan" } });
    const meta = JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8"));
    expect(meta.plans[meta.lineages[threadId].at(-1).threadId].permissionMode).toBe("bypassPermissions");
  });
});

describe("lineages Claude cleaned up", () => {
  afterEach(async () => { await gateway.stop(); });

  it("list a lineage whose own segment's transcript is gone under its oldest segment kept, pinned as before", async () => {
    fakeClaude.reset();
    const expired = "0c0c0c0c-0000-4000-8000-000000000001";
    const session = "0c0c0c0c-0000-4000-8000-000000000002";
    const directory = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-work");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${session}.jsonl`), `${JSON.stringify({
      type: "user", uuid: "n1", parentUuid: null, sessionId: session, cwd: "/work", timestamp: "2026-09-20T00:00:00.000Z",
      origin: { kind: "human" }, message: { role: "user", content: "after the switch" },
    })}\n`);
    gateway = await startTestGateway({}, {
      lineages: { [expired]: [
        { provider: "claude", threadId: expired, lastTurnId: "gone" },
        { provider: "claude", threadId: session, lastTurnId: null },
      ] },
      sections: { [expired]: { sectionId: "section-pinned", enteredAt: 1 } },
    });
    client = await gateway.connect();
    const ids = (await client.request("thread/list", { limit: 200 })).data.map((row: any) => row.id);
    expect(ids).toContain(session);
    expect(ids).not.toContain(expired);
    const pinned = await client.request("thread/list", { limit: 50, sectionId: "section-pinned", sortKey: "section_position" });
    expect(pinned.data.map((row: any) => row.id)).toEqual([session]);
    const { thread } = await client.request("thread/read", { threadId: session, includeTurns: true });
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

  it("never shows the title Claude gives a switch's new Claude backend as the chat's name", async () => {
    const threadId = await stockThread();
    await client.request("thread/name/set", { threadId, name: "Greeting" });
    await client.turn(threadId, "first");
    const { turn } = await client.request("turn/start", { threadId, input: text("run until stopped: sleep 600"), model: CLAUDE });
    await client.waitFor("item/started", (params) => params.threadId === threadId && params.item.type === "commandExecution");
    const backendId = fakeClaude.prompts.at(-1)!.sessionId;
    const projects = join(process.env.CLAUDE_CONFIG_DIR!, "projects");
    const transcript = join(projects, readdirSync(projects).find((key) => existsSync(join(projects, key, `${backendId}.jsonl`)))!, `${backendId}.jsonl`);
    // Like Claude: it titles a session while the turn runs, and retitles it later (the first title is the one it's first seen with).
    for (const title of ["FIRST", "SECOND"]) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      appendFileSync(transcript, `${JSON.stringify({ type: "ai-title", aiTitle: title, sessionId: backendId })}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    await client.request("turn/interrupt", { threadId, turnId: turn.id });
    await client.waitFor("turn/completed", (params) => params.turn.id === turn.id);
    expect(client.notifications("thread/name/updated").map((message) => message.params.threadName)).not.toContain("SECOND");
  });

  it("keeps Claude's own title of a session unseen while CCodex names it", async () => {
    const threadId = await claudeThread();
    await client.turn(threadId, "a slow title");
    const projects = join(process.env.CLAUDE_CONFIG_DIR!, "projects");
    const transcript = join(projects, readdirSync(projects).find((key) => existsSync(join(projects, key, `${threadId}.jsonl`)))!, `${threadId}.jsonl`);
    appendFileSync(transcript, `${JSON.stringify({ type: "ai-title", aiTitle: "Claude's own title", sessionId: threadId })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await client.request("thread/list", { limit: 50 })).data.find((row: any) => row.id === threadId).name).toBeNull();
    await client.waitFor("thread/name/updated", (params) => params.threadId === threadId && params.threadName === "🦊 Fox Title ✳️");
    expect(client.notifications("thread/name/updated", threadId).map((message) => message.params.threadName)).not.toContain("Claude's own title");
  });
});
