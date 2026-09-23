import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMcpServer } from "../../src/mcp/server.js";
import { testConfig } from "../fixtures/config.js";

const FAKE = fileURLToPath(new URL("../fixtures/fakeCodexExec.mjs", import.meta.url));

async function session() {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = new Map<number, any>();
  let buffer = "";
  output.on("data", (data: Buffer) => {
    buffer += data.toString();
    for (const line of buffer.split("\n").slice(0, -1)) {
      const message = JSON.parse(line);
      replies.set(message.id, message);
    }
    buffer = buffer.split("\n").at(-1)!;
  });
  const done = runMcpServer(testConfig({ codex: FAKE }), "9.9.9", input, output);
  let id = 0;
  const call = async (method: string, params: object = {}) => {
    const current = ++id;
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
    while (!replies.has(current)) await new Promise((resolve) => setTimeout(resolve, 10));
    return replies.get(current);
  };
  return { call, close: async () => { input.end(); await done; } };
}

describe("codex mcp-server on codex exec", () => {
  it("serves the old codex tools and maps them to codex exec sessions", async () => {
    const { call, close } = await session();
    expect((await call("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo).toMatchObject({ name: "codex-mcp-server", version: "9.9.9" });
    expect((await call("tools/list")).result.tools.map((tool: any) => tool.name)).toEqual(["codex", "codex-reply"]);
    const started = (await call("tools/call", {
      name: "codex",
      arguments: { prompt: "hi", model: "gpt-6-luna", cwd: "/work", sandbox: "read-only", "approval-policy": "never", "developer-instructions": "be brief" },
    })).result;
    expect(started.structuredContent.threadId).toBe("0c0c0c0c-0000-4000-8000-000000000003");
    expect(JSON.parse(started.content[0].text)).toEqual([
      "exec", "--json", "--skip-git-repo-check", "--thread-source", "ccodex-mcp", "-C", "/work", "-m", "gpt-6-luna", "-s", "read-only",
      "-c", "approval_policy=\"never\"", "-c", "developer_instructions=\"be brief\"", "--", "hi",
    ]);
    const reply = (await call("tools/call", { name: "codex-reply", arguments: { threadId: "t-1", prompt: "more" } })).result;
    expect(JSON.parse(reply.content[0].text).slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(reply.structuredContent.threadId).toBe("t-1");
    const failed = (await call("tools/call", { name: "codex", arguments: { prompt: "fail" } })).result;
    expect(failed).toMatchObject({ isError: true, content: [{ text: "model not available" }] });
    await close();
  });
});
