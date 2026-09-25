import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, fakeQuery, fakeStartup } from "../fixtures/fakeClaude.js";
import { startTestGateway, type Client, type TestGateway } from "./harness.js";

// At most 2 Claude processes; a 5 s idle wait (the sweep runs every 1.25 s), so only the cap closes one here.
vi.hoisted(() => {
  process.env.CCODEX_E2E_IDLE_MS = "5000";
  process.env.CCODEX_E2E_MAX_PROCESSES = "2";
});
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ccodex-claude-"));
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "ccodex-codex-home-"));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({ ...await importOriginal<object>(), query: fakeQuery, startup: fakeStartup }));
vi.mock("../../src/claude/processes.js", () => ({ sessionProcesses: () => [], killProcesses: () => undefined }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let gateway: TestGateway;
let client: Client;

describe("Claude processes: at most MAX_PROCESSES", () => {
  beforeEach(async () => {
    fakeClaude.reset();
    gateway = await startTestGateway();
    client = await gateway.connect();
  });
  afterEach(async () => { await gateway.stop(); });

  it("closes the process of the open chat used longest ago; the chat stays loaded", async () => {
    const chats: string[] = [];
    for (const text of ["one", "two", "three"]) {
      const { thread } = await client.request("thread/start", { model: "claude:claude-opus-5-5", cwd: "/work" });
      await client.turn(thread.id, text);
      chats.push(thread.id);
    }
    const closedProcesses = () => fakeClaude.calls.filter((call) => call.method === "close" && chats.includes(call.args[0] as string)).map((call) => call.args[0]);
    for (let waited = 0; !closedProcesses().length; waited += 50) {
      expect(waited).toBeLessThan(3_000);
      await sleep(50);
    }
    expect(closedProcesses()).toEqual([chats[0]]);
    expect((await client.request("thread/loaded/list", {})).data).toEqual(expect.arrayContaining(chats));
    await client.turn(chats[0]!, "/ccstate");
    const state = client.notifications("item/completed", chats[0]!).map((message) => message.params.item).filter((item) => item.type === "agentMessage").at(-1);
    expect(state.text).toContain("3 were running (at most 2) and this chat was used longest ago");
  });
});
