import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, fakeQuery, fakeStartup } from "../fixtures/fakeClaude.js";
import { startTestGateway, type Client, type TestGateway } from "./harness.js";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ccodex-claude-"));
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "ccodex-codex-home-"));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({ ...await importOriginal<object>(), query: fakeQuery, startup: fakeStartup }));
vi.mock("../../src/claude/processes.js", () => ({ sessionProcesses: () => [], killProcesses: () => undefined }));

let gateway: TestGateway;
let client: Client;

/** The turns as the client saw them live: ids in order, with the items each one completed. */
function liveTurns(threadId: string): Array<{ id: string; items: string[] }> {
  const items = client.notifications("item/completed", threadId).map((message) => message.params);
  return client.notifications("turn/started", threadId).map((message) => message.params.turn.id).map((id: string) => ({
    id, items: [...new Set(items.filter((params) => params.turnId === id).map((params) => `${params.item.type}:${params.item.text ?? ""}`))],
  }));
}

async function historyTurns(threadId: string): Promise<Array<{ id: string; items: string[]; status: string }>> {
  const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
  return thread.turns.map((turn: any) => ({ id: turn.id, status: turn.status, items: turn.items.map((item: any) => `${item.type}:${item.text ?? ""}`) }));
}

async function chat(): Promise<string> {
  const { thread } = await client.request("thread/start", { model: "claude:claude-opus-5-5", cwd: "/work" });
  return thread.id;
}

describe("Claude going on after an answer: a turn of its own, as history shows it", () => {
  beforeEach(async () => {
    fakeClaude.reset();
    gateway = await startTestGateway();
    client = await gateway.connect();
  });
  afterEach(async () => { await gateway.stop(); });

  it("ends the turn at a message of an answer's length when more work follows; the work goes on without a prompt", async () => {
    const threadId = await chat();
    await client.turn(threadId, "report at length: audit");
    const live = liveTurns(threadId);
    expect(live).toHaveLength(2);
    expect(live[0]!.items.map((item) => item.split(":")[0])).toEqual(["userMessage", "agentMessage"]);
    expect(live[0]!.items[1]).toMatch(/^agentMessage:audit: all checks passed/u);
    expect(live[1]!.items).toEqual(["commandExecution:", "agentMessage:checked"]);
    expect(live[1]!.id).toMatch(/:0:continued$/u);
    // Desktop's chat stays busy across the split.
    const statuses = client.notifications("thread/status/changed", threadId).map((message) => message.params.status.type);
    expect(statuses.filter((status) => status === "idle")).toHaveLength(1);
    expect(await historyTurns(threadId)).toEqual(live.map((turn) => ({ ...turn, status: "completed" })));
  });

  it("ends the turn at Claude's answer while a background task runs; a new turn stays open and takes the task's wakeup", async () => {
    const threadId = await chat();
    const answered = client.turn(threadId, "watch in background: sleep 1");
    const first = await client.waitFor("turn/completed", (params) => params.threadId === threadId);
    const holder = await client.waitFor("turn/started", (params) => params.threadId === threadId && params.turn.id !== first.turn.id);
    expect(holder.turn.id).toMatch(/:0:continued$/u);
    const open = await historyTurns(threadId);
    expect(open.map((turn) => [turn.id, turn.status])).toEqual([[first.turn.id, "completed"], [holder.turn.id, "inProgress"]]);
    await answered;
    const live = liveTurns(threadId);
    expect(live.map((turn) => turn.id)).toEqual([first.turn.id, holder.turn.id]);
    expect(live[0]!.items.at(-1)).toBe("agentMessage:watching");
    expect(live[1]!.items).toEqual(["agentMessage:the task finished"]);
    expect(await historyTurns(threadId)).toEqual(live.map((turn) => ({ ...turn, status: "completed" })));
  });

  it("starts a prompt sent while Claude only waits on a background task at once, as a turn of its own", async () => {
    fakeClaude.backgroundMs = 3_000;
    const threadId = await chat();
    void client.turn(threadId, "watch in background: sleep 3");
    const first = await client.waitFor("turn/completed", (params) => params.threadId === threadId);
    const holder = await client.waitFor("turn/started", (params) => params.threadId === threadId && params.turn.id !== first.turn.id);
    await client.request("thread/queue/add", { threadId, input: [{ type: "text", text: "and meanwhile?", text_elements: [] }] });
    expect((await client.request("thread/queue/list", { threadId })).data).toEqual([]);
    await client.waitFor("turn/completed", (params) => params.turn.id === holder.turn.id, 500);
    const next = await client.waitFor("turn/started", (params) => params.threadId === threadId && ![first.turn.id, holder.turn.id].includes(params.turn.id), 500);
    const prompt = await client.waitFor("item/completed", (params) => params.turnId === next.turn.id && params.item.type === "userMessage", 500);
    expect(prompt.item.content[0].text).toBe("and meanwhile?");
  });
});
