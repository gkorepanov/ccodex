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

/** Starts a turn and waits for it alone to complete (`client.turn` waits for the turns that follow it too). */
async function answered(threadId: string, text: string): Promise<string> {
  const { turn } = await client.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
  await client.waitFor("turn/completed", (params) => params.turn.id === turn.id, 3_000);
  return turn.id;
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

  it("runs a background command on past its turn, like stock's background terminal: its end completes it there, and the wakeup is a turn of its own", async () => {
    const threadId = await chat();
    const first = await client.turn(threadId, "watch in background: sleep 1");
    const command = (params: any) => params.item.type === "commandExecution" && params.turnId === first.turn.id;
    expect(client.notifications("item/completed", threadId).filter((message) => command(message.params))).toEqual([]);
    expect(client.notifications("thread/status/changed", threadId).at(-1)!.params.status.type).toBe("idle");
    const running = await client.request("thread/read", { threadId, includeTurns: true });
    expect(running.thread.turns.map((turn: any) => [turn.id, turn.status])).toEqual([[first.turn.id, "completed"]]);
    expect(running.thread.turns[0].items.find((item: any) => item.type === "commandExecution")).toMatchObject({ status: "inProgress", processId: "bg1" });
    expect((await client.request("thread/backgroundTerminals/list", { threadId })).data).toMatchObject([{ processId: "bg1", command: "sleep 1" }]);
    const ended = await client.waitFor("item/completed", command, 3_000);
    expect(ended.item).toMatchObject({ status: "completed", processId: "bg1", exitCode: 0, aggregatedOutput: "BG-OUT\n" });
    const wakeup = await client.waitFor("turn/started", (params) => params.threadId === threadId && params.turn.id !== first.turn.id, 3_000);
    expect(wakeup.turn.id).toMatch(/:0:continued$/u);
    await client.waitFor("turn/completed", (params) => params.turn.id === wakeup.turn.id, 3_000);
    const live = liveTurns(threadId);
    expect(live.map((turn) => turn.id)).toEqual([first.turn.id, wakeup.turn.id]);
    expect(live[0]!.items).toEqual(["userMessage:", "agentMessage:watching", "commandExecution:"]);
    expect(live[1]!.items).toEqual(["agentMessage:the task finished"]);
    const history = await client.request("thread/read", { threadId, includeTurns: true });
    expect(history.thread.turns[0].items.find((item: any) => item.type === "commandExecution")).toMatchObject({ status: "completed", processId: "bg1", exitCode: 0, aggregatedOutput: "BG-OUT\n" });
    const page = await client.request("thread/turns/list", { threadId, limit: 5, sortDirection: "desc" });
    expect(page.data.map((turn: { id: string }) => turn.id)).toEqual([wakeup.turn.id, first.turn.id]);
  });

  it("starts a prompt sent while a background command runs at once, as a turn of its own", async () => {
    fakeClaude.backgroundMs = 3_000;
    const threadId = await chat();
    const first = await client.turn(threadId, "watch in background: sleep 3");
    await client.request("thread/queue/add", { threadId, input: [{ type: "text", text: "and meanwhile?", text_elements: [] }] });
    expect((await client.request("thread/queue/list", { threadId })).data).toEqual([]);
    const next = await client.waitFor("turn/started", (params) => params.threadId === threadId && params.turn.id !== first.turn.id, 500);
    const prompt = await client.waitFor("item/completed", (params) => params.turnId === next.turn.id && params.item.type === "userMessage", 500);
    expect(prompt.item.content[0].text).toBe("and meanwhile?");
    expect(fakeClaude.calls.some((call) => call.method === "stopTask")).toBe(false);
  });

  it("announces a background command with its process while its turn runs (Desktop shows a background terminal only then)", async () => {
    fakeClaude.backgroundMs = 3_000;
    const threadId = await chat();
    const since = client.messages.length;
    const first = await client.turn(threadId, "watch in background: sleep 3");
    const started = client.messages.slice(since).filter((message) => message.method === "item/started" && message.params.item.type === "commandExecution");
    expect(started.at(-1)?.params.item).toMatchObject({ status: "inProgress", processId: "bg1" });
    const completedAt = client.messages.findIndex((message) => message.method === "turn/completed" && message.params.turn.id === first.turn.id);
    expect(client.messages.indexOf(started.at(-1)!)).toBeLessThan(completedAt);
  });

  it("stops Claude's background commands from Desktop's background terminals panel: each ends as stopped in its turn", async () => {
    fakeClaude.backgroundMs = 3_000;
    const threadId = await chat();
    const first = await client.turn(threadId, "watch in background: sleep 3");
    await client.request("thread/backgroundTerminals/clean", { threadId });
    expect(fakeClaude.calls.filter((call) => call.method === "stopTask")).toEqual([{ method: "stopTask", args: ["bg1"] }]);
    const ended = await client.waitFor("item/completed", (params) => params.item.type === "commandExecution" && params.turnId === first.turn.id, 500);
    expect(ended.item).toMatchObject({ status: "failed", processId: "bg1", exitCode: null });
  });

  it("waits for Claude's background sub-agents in a turn of its own: the chat stays busy, Claude goes on in it as each one ends, as history shows", async () => {
    fakeClaude.backgroundMs = 300;
    const threadId = await chat();
    const first = await answered(threadId, "delegate in background: APPLE, BANANA");
    const waits: string[] = [];
    for (const word of ["APPLE", "BANANA"]) {
      const waiting = await client.waitFor("turn/started", (params) => params.threadId === threadId && ![first, ...waits].includes(params.turn.id), 3_000);
      waits.push(waiting.turn.id);
      await client.waitFor("turn/completed", (params) => params.turn.id === waiting.turn.id && params.turn.status === "completed", 3_000);
      expect(liveTurns(threadId).find((turn) => turn.id === waiting.turn.id)!.items.at(-1)).toBe(`agentMessage:the helper said ${word}`);
    }
    const live = liveTurns(threadId);
    expect(live.map((turn) => turn.id)).toEqual([first, ...waits]);
    expect(waits.every((id) => id.endsWith(":0:continued"))).toBe(true);
    const reasoning = client.notifications("item/completed", threadId).map((message) => message.params).filter((params) => params.item.type === "reasoning");
    expect(reasoning.map((params) => [params.turnId, params.item.summary])).toEqual([
      [waits[0], ["Waiting for 2 subagents to finish…"]], [waits[1], ["Waiting for 1 subagent to finish…"]],
    ]);
    // Desktop's sidebar shows the chat working until the last sub-agent ends.
    expect(client.notifications("thread/status/changed", threadId).map((message) => message.params.status.type).filter((status) => status === "idle")).toHaveLength(1);
    expect(client.notifications("thread/status/changed", threadId).at(-1)!.params.status.type).toBe("idle");
    // The wait is shown live only (the two spawns read as one, as live items are told apart by kind and text).
    const shown = live.map((turn) => ({ ...turn, items: turn.items.filter((item) => item !== "reasoning:") }));
    const history = (await historyTurns(threadId)).map((turn) => ({ ...turn, items: [...new Set(turn.items)] }));
    expect(history).toEqual(shown.map((turn) => ({ ...turn, status: "completed" })));
  });

  it("starts a prompt sent while Claude waits for its sub-agents at once, as a turn of its own; the sub-agents work on", async () => {
    fakeClaude.backgroundMs = 3_000;
    const threadId = await chat();
    const first = await answered(threadId, "delegate in background: APPLE");
    const waiting = await client.waitFor("turn/started", (params) => params.threadId === threadId && params.turn.id !== first, 500);
    await client.request("thread/queue/add", { threadId, input: [{ type: "text", text: "and meanwhile?", text_elements: [] }] });
    expect((await client.request("thread/queue/list", { threadId })).data).toEqual([]);
    await client.waitFor("turn/completed", (params) => params.turn.id === waiting.turn.id && params.turn.status === "completed", 500);
    const next = await client.waitFor("turn/started", (params) => params.threadId === threadId && ![first, waiting.turn.id].includes(params.turn.id), 500);
    const prompt = await client.waitFor("item/completed", (params) => params.turnId === next.turn.id && params.item.type === "userMessage", 500);
    expect(prompt.item.content[0].text).toBe("and meanwhile?");
    expect(fakeClaude.calls.some((call) => call.method === "stopTask")).toBe(false);
  });

  it("stops the sub-agents Claude waits for when the waiting turn is stopped, as Stop does mid-turn", async () => {
    fakeClaude.backgroundMs = 3_000;
    const threadId = await chat();
    const first = await answered(threadId, "delegate in background: APPLE");
    const waiting = await client.waitFor("turn/started", (params) => params.threadId === threadId && params.turn.id !== first, 500);
    await client.request("turn/interrupt", { threadId, turnId: waiting.turn.id });
    await client.waitFor("turn/completed", (params) => params.turn.id === waiting.turn.id && params.turn.status === "interrupted", 500);
    expect(fakeClaude.calls.filter((call) => call.method === "stopTask")).toEqual([{ method: "stopTask", args: ["b9a0"] }]);
    expect(client.notifications("thread/status/changed", threadId).at(-1)!.params.status.type).toBe("idle");
  });

  it("shows Claude stopping its background command on the command (stock's Ctrl-C), not as a call of its own", async () => {
    const threadId = await chat();
    const turn = await client.turn(threadId, "stop in background: sleep 9");
    const interaction = client.notifications("item/commandExecution/terminalInteraction", threadId).map((message) => message.params);
    expect(interaction).toMatchObject([{ turnId: turn.turn.id, processId: "bg1", stdin: "\u0003" }]);
    const live = liveTurns(threadId);
    expect(live[0]!.items).toEqual(["userMessage:", "commandExecution:", "agentMessage:stopped"]);
    const history = await client.request("thread/read", { threadId, includeTurns: true });
    const items = history.thread.turns[0].items;
    expect(items.map((item: any) => item.type)).toEqual(["userMessage", "commandExecution", "agentMessage"]);
    expect(items[1]).toMatchObject({ status: "failed", processId: "bg1", exitCode: null });
  });
});
