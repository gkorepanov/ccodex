import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { GatewayUnavailable, replyViaGateway } from "../../src/mcp/gatewayReply.js";

const OPEN = "11111111-1111-4111-8111-111111111111";
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

/** A gateway that answers like the real one: a chat's reply arrives as notifications after `turn/start`. */
function gateway(options: { resumeError?: string } = {}) {
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
    else if (message.method === "turn/start") {
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
