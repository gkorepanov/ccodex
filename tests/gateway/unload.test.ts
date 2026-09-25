import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, fakeQuery, fakeStartup } from "../fixtures/fakeClaude.js";
import { startTestGateway, type Client, type TestGateway } from "./harness.js";

// A 200 ms idle wait (the sweep runs every 50 ms); the session's commands are what `commands.read` says.
const commands = vi.hoisted(() => {
  process.env.CCODEX_E2E_IDLE_MS = "200";
  return { read: (): { pid: number; session: string; cpu: number }[] => [], killed: [] as number[][] };
});
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ccodex-claude-"));
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "ccodex-codex-home-"));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({ ...await importOriginal<object>(), query: fakeQuery, startup: fakeStartup }));
vi.mock("../../src/claude/processes.js", () => ({
  sessionProcesses: () => commands.read(),
  killProcesses: (pids: number[]) => void commands.killed.push([...pids]),
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let gateway: TestGateway;
let client: Client;

/** A Claude chat with one finished turn that nobody has open any more. */
async function leftChat(): Promise<string> {
  const { thread } = await client.request("thread/start", { model: "claude:claude-opus-5-5", cwd: "/work" });
  await client.turn(thread.id, "hello");
  await client.request("thread/unsubscribe", { threadId: thread.id });
  return thread.id;
}

const closed = (threadId: string) => client.notifications("thread/closed", threadId).length > 0;

describe("unloading Claude chats nobody uses", () => {
  beforeEach(async () => {
    fakeClaude.reset();
    commands.read = () => [];
    commands.killed.length = 0;
    gateway = await startTestGateway();
    client = await gateway.connect();
  });
  afterEach(async () => { await gateway.stop(); });

  it("unloads a quiet chat when its commands can't be read, ending none", async () => {
    commands.read = () => { throw new Error("ps: not found"); };
    const threadId = await leftChat();
    await client.waitFor("thread/closed", (params) => params.threadId === threadId, 3_000);
    await sleep(50);
    expect(commands.killed.flat()).toEqual([]);
  });

  it("keeps a chat whose command still computes, and ends it with the chat once it stops", async () => {
    let cpu = 0;
    let working = true;
    const threadId = await leftChat();
    commands.read = () => [{ pid: 4242, session: threadId, cpu: working ? cpu++ : cpu }];
    await sleep(600);
    expect(closed(threadId)).toBe(false);
    working = false;
    await client.waitFor("thread/closed", (params) => params.threadId === threadId, 3_000);
    await sleep(50);
    expect(commands.killed).toContainEqual([4242]);
  });
});
