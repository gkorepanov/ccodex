import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { claimOrphanedSubagentChats, forgetSubagentChat, recordSubagentChat } from "../../src/mcp/subagentRegistry.js";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { GatewayUnavailable, archiveViaGateway, claudeModelId, replyViaGateway, startViaGateway } from "../../src/mcp/gatewayReply.js";

const OPEN = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

/** A gateway that answers like the real one: a chat's reply arrives as notifications after `turn/start`. */
function gateway(options: { resumeError?: string; failTurn?: boolean; hold?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ccodex-gw-"));
  const path = join(dir, "gw.sock");
  const calls: Array<{ method: string; params: any }> = [];
  const http: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws)));
  wss.on("connection", (ws) => ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.id === undefined) return;
    calls.push({ method: message.method, params: message.params });
    const reply = (result: unknown) => ws.send(JSON.stringify({ id: message.id, result }));
    if (message.method === "thread/list") reply({ data: [{ id: OPEN, name: "Router-vp ✳️" }, { id: "x", name: "Router-vp-old" }] });
    else if (message.method === "thread/resume" && !options.resumeError) reply({ model: "claude:sonnet" });
    else if (message.method === "thread/resume" && options.resumeError) ws.send(JSON.stringify({ id: message.id, error: { code: -32600, message: options.resumeError } }));
    else if (message.method === "thread/start") reply({ thread: { id: NEW } });
    else if (message.method === "turn/start" && options.hold) reply({ turn: { id: "t1" } });
    else if (message.method === "turn/start" && options.failTurn) {
      reply({ turn: { id: "t1" } });
      const threadId = message.params.threadId;
      ws.send(JSON.stringify({ method: "item/completed", params: { threadId, item: { type: "agentMessage", phase: "final_answer", text: "model problem" } } }));
      ws.send(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: "t1", status: "failed", error: { message: "model problem" } } } }));
    } else if (message.method === "turn/start") {
      reply({ turn: { id: "t1" } });
      const threadId = message.params.threadId;
      ws.send(JSON.stringify({ method: "item/completed", params: { threadId, item: { type: "agentMessage", phase: "final_answer", text: `got: ${message.params.input[0].text}` } } }));
      ws.send(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: "t1", status: "completed" } } }));
    } else reply({});
  }));
  return new Promise<{ path: string; calls: typeof calls }>((resolve) => {
    http.listen(path, () => {
      cleanup.push(() => { wss.close(); http.close(); rmSync(dir, { recursive: true, force: true }); });
      resolve({ path, calls });
    });
  });
}

describe("replyViaGateway", () => {
  it("resumes the chat and returns its final answer", async () => {
    const { path, calls } = await gateway();
    expect(await replyViaGateway(path, OPEN, "hello")).toEqual({ threadId: OPEN, content: "got: hello" });
    expect(calls.map((call) => call.method)).toEqual(["initialize", "thread/resume", "turn/start"]);
    // The turn names the chat's current model, so it cannot complete a switch left pending on the chat.
    expect(calls.at(-1)!.params.model).toBe("claude:sonnet");
  });

  it("finds a chat by title, ignoring the Claude mark and similar titles", async () => {
    const { path } = await gateway();
    expect((await replyViaGateway(path, "Router-vp", "hi")).threadId).toBe(OPEN);
    expect((await replyViaGateway(path, "Router-vp ✳️", "hi")).threadId).toBe(OPEN);
  });

  it("reports an unknown title and a thread the gateway cannot resume as unavailable", async () => {
    const { path } = await gateway();
    await expect(replyViaGateway(path, "Nobody", "hi")).rejects.toThrow(GatewayUnavailable);
    const broken = await gateway({ resumeError: "thread not found" });
    await expect(replyViaGateway(broken.path, OPEN, "hi")).rejects.toThrow(GatewayUnavailable);
  });

  it("reports a missing gateway as unavailable", async () => {
    await expect(replyViaGateway(join(tmpdir(), "ccodex-no-such.sock"), OPEN, "hi")).rejects.toThrow(GatewayUnavailable);
  });
});

describe("startViaGateway", () => {
  it("starts a chat on the given model, runs the prompt on it and archives the chat", async () => {
    const { path, calls } = await gateway();
    const result = await startViaGateway(path, { prompt: "work", model: "claude:haiku", cwd: "/tmp/x", name: "Sub-agent: work" });
    expect(result).toEqual({ threadId: NEW, content: "got: work" });
    expect(calls.map((call) => call.method)).toEqual(["initialize", "thread/start", "thread/name/set", "turn/start", "thread/archive"]);
    expect(calls[1].params).toMatchObject({ model: "claude:haiku", cwd: "/tmp/x", sandbox: "read-only", approvalPolicy: "never" });
    expect(calls[3].params.model).toBe("claude:haiku");
  });

  it("keeps the chat unarchived when asked", async () => {
    const { path, calls } = await gateway();
    await startViaGateway(path, { prompt: "work", model: "claude:sonnet", archive: false });
    expect(calls.map((call) => call.method)).not.toContain("thread/archive");
  });

  it("reports a missing gateway as unavailable", async () => {
    await expect(startViaGateway(join(tmpdir(), "ccodex-no-such.sock"), { prompt: "x", model: "claude:haiku" })).rejects.toThrow(GatewayUnavailable);
  });
});

describe("claudeModelId", () => {
  it("maps Claude names to gateway ids and leaves other models alone", () => {
    expect(claudeModelId("claude:haiku")).toBe("claude:haiku");
    expect(claudeModelId("Haiku")).toBe("claude:haiku");
    expect(claudeModelId("claude-haiku-5-5")).toBe("claude:claude-haiku-5-5");
    expect(claudeModelId("gpt-6.1-sol")).toBeUndefined();
    expect(claudeModelId(undefined)).toBeUndefined();
  });
});

describe("startViaGateway failures", () => {
  it("rejects a failed turn even when it left a message, and still archives the chat", async () => {
    const { path, calls } = await gateway({ failTurn: true });
    await expect(startViaGateway(path, { prompt: "x", model: "claude:nonexistent" })).rejects.toThrow("model problem");
    expect(calls.map((call) => call.method)).toContain("thread/archive");
  });

  it("interrupts the turn, archives the chat and rejects when aborted", async () => {
    const { path, calls } = await gateway({ hold: true });
    const controller = new AbortController();
    const run = startViaGateway(path, { prompt: "x", model: "claude:haiku", signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    await expect(run).rejects.toThrow("Cancelled");
    expect(calls.map((call) => call.method)).toEqual(expect.arrayContaining(["turn/interrupt", "thread/archive"]));
  });

  it("archives chats by id", async () => {
    const { path, calls } = await gateway();
    expect(await archiveViaGateway(path, [OPEN, NEW])).toEqual([OPEN, NEW]);
    expect(calls.filter((call) => call.method === "thread/archive").map((call) => call.params.threadId)).toEqual([OPEN, NEW]);
  });
});

describe("sub-agent chat registry", () => {
  it("hands out only chats whose server is gone, once", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccodex-reg-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    recordSubagentChat(dir, "mine");
    writeFileSync(join(dir, "subagent-chats.json"), JSON.stringify({ mine: { pid: process.pid, at: 1 }, dead: { pid: 2 ** 22 + 12345, at: 1 }, gone: { pid: 2 ** 22 + 54321, at: 1 } }));
    forgetSubagentChat(dir, "gone");
    expect(claimOrphanedSubagentChats(dir)).toEqual(["dead"]);
    expect(claimOrphanedSubagentChats(dir)).toEqual([]);
  });
});

describe("publicChatId", () => {
  it("maps a segment of a chat that switched provider to the chat's public id", async () => {
    const { publicChatId } = await import("../../src/mcp/server.js");
    const dir = mkdtempSync(join(tmpdir(), "ccodex-meta-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ lineages: { [OPEN]: [{ provider: "codex", threadId: OPEN }, { provider: "claude", threadId: "c" }, { provider: "codex", threadId: NEW }] } }));
    expect(publicChatId(dir, NEW)).toBe(OPEN);
    expect(publicChatId(dir, OPEN)).toBe(OPEN);
    expect(publicChatId(dir, "other")).toBe("other");
    expect(publicChatId(join(dir, "missing"), NEW)).toBe(NEW);
  });
});
