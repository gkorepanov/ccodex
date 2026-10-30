import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, fakeQuery, fakeStartup } from "../fixtures/fakeClaude.js";
import { startTestGateway, type TestGateway } from "./harness.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...await original<object>(), query: fakeQuery, startup: fakeStartup,
}));
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const claudeHome = process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ct-claude-"));
const codexHome = process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "ct-codex-"));
afterAll(() => { rmSync(claudeHome, { recursive: true, force: true }); rmSync(codexHome, { recursive: true, force: true }); });

let gateway: TestGateway | undefined;
beforeEach(() => fakeClaude.reset());
afterEach(async () => { await gateway?.stop(); gateway = undefined; });

describe("Claude native MCP projection", () => {
  it("adds Codex-native tools without replacing the user's Claude MCP configuration", async () => {
    gateway = await startTestGateway({ nativeMcp: true, claudeVisualize: false });
    const client = await gateway.connect();
    const { thread } = await client.request("thread/start", { model: "claude:claude-opus-5-5", cwd: gateway.root });
    await client.turn(thread.id, "hello");
    const options = fakeClaude.options.find((option) => option.sessionId === thread.id);
    expect(options?.mcpServers?.codex_native).toBeDefined();
    expect(options?.strictMcpConfig).not.toBe(true);
  });

  it("applies resume permission overrides before the next Claude runtime starts", async () => {
    gateway = await startTestGateway({ nativeMcp: true, claudeVisualize: false });
    const client = await gateway.connect();
    const { thread } = await client.request("thread/start", { model: "claude:claude-opus-5-5", cwd: gateway.root, permissions: ":danger-full-access" });
    await client.turn(thread.id, "hello");
    const config = { 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled': true };
    await client.request("thread/resume", { threadId: thread.id, sandbox: "read-only", runtimeWorkspaceRoots: [gateway.root, "/extra"], config });
    const meta = JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8"));
    expect(meta.nativeMcpAccess[thread.id]).toEqual({ sandbox: "read-only", runtimeWorkspaceRoots: [gateway.root, "/extra"], config });
  });

  it("carries the stock sandbox across a GPT to Claude picker switch", async () => {
    gateway = await startTestGateway({ nativeMcp: true, claudeVisualize: false });
    const client = await gateway.connect();
    const config = { 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled': true };
    const { thread } = await client.request("thread/start", { model: "gpt-6-luna", cwd: gateway.root, sandbox: "read-only", config });
    await client.turn(thread.id, "first");
    const start = await client.request("turn/start", { threadId: thread.id, model: "claude:claude-opus-5-5", input: [{ type: "text", text: "second", text_elements: [] }] });
    await client.waitFor("turn/completed", p => p.threadId === thread.id && p.turn.id === start.turn.id);
    const meta = JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8"));
    const backend = meta.lineages[thread.id].at(-1).threadId;
    expect(meta.nativeMcpAccess[backend].sandboxPolicy.type).toBe("readOnly");
    expect(meta.nativeMcpAccess[backend].config).toEqual(config);
  });

  it("retains App launch config when switching an empty GPT chat to Claude", async () => {
    gateway = await startTestGateway({ nativeMcp: true, claudeVisualize: false });
    const client = await gateway.connect();
    const config = { 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled': true };
    const { thread } = await client.request("thread/start", { model: "gpt-6-luna", cwd: gateway.root, sandbox: "read-only", config });
    await client.turn(thread.id, "first, now using Claude", { model: "claude:claude-opus-5-5" });
    const meta = JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8"));
    expect(meta.nativeMcpAccess[thread.id]).toMatchObject({ sandbox: "read-only", config });
    expect(meta.lineages[thread.id]).toBeUndefined();
  });

  it("keeps the previous SDK configuration when native MCP is disabled", async () => {
    gateway = await startTestGateway({ claudeVisualize: false });
    const client = await gateway.connect();
    const { thread } = await client.request("thread/start", { model: "claude:claude-opus-5-5", cwd: gateway.root });
    await client.turn(thread.id, "hello");
    const options = fakeClaude.options.find((option) => option.sessionId === thread.id);
    expect(options?.mcpServers?.codex_native).toBeUndefined();
  });

  it("keeps a turn's stock settings path when native MCP is disabled", async () => {
    gateway = await startTestGateway({ claudeVisualize: false });
    const client = await gateway.connect();
    const { thread } = await client.request("thread/start", { model: "claude:claude-opus-5-5", cwd: gateway.root });
    await client.turn(thread.id, "first");
    const updates = client.notifications("thread/settings/updated", thread.id).length;
    await client.turn(thread.id, "second", { cwd: tmpdir(), sandbox: "read-only" });
    expect(client.notifications("thread/settings/updated", thread.id)).toHaveLength(updates);
  });
});
