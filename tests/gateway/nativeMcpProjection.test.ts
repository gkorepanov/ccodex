import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, fakeQuery, fakeStartup } from "../fixtures/fakeClaude.js";
import { startTestGateway, type TestGateway } from "./harness.js";
import { StockClient } from "../../src/gateway/stock.js";

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

  it("retains App launch config when switching Claude back to GPT", async () => {
    gateway = await startTestGateway({ nativeMcp: true, claudeVisualize: false });
    const client = await gateway.connect();
    const config = { 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled': true };
    const { thread } = await client.request("thread/start", { model: "claude:claude-opus-5-5", cwd: gateway.root, config });
    await client.turn(thread.id, "first");
    const stock = vi.spyOn(StockClient.prototype, "request");
    try {
      await client.turn(thread.id, "continue using GPT", { model: "gpt-6-luna" });
      const started = stock.mock.calls.find(([method, params]) => method === "thread/start" && (params as { model?: string } | undefined)?.model === "gpt-6-luna");
      expect(started?.[1]).toMatchObject({ config });
    } finally { stock.mockRestore(); }
  });

  it("uses successful GPT settings changes when the first message switches to Claude", async () => {
    gateway = await startTestGateway({ nativeMcp: true, claudeVisualize: false });
    const client = await gateway.connect();
    const { thread } = await client.request("thread/start", { model: "gpt-6-luna", cwd: gateway.root, permissions: ":danger-full-access" });
    const sandboxPolicy = { type: "readOnly", networkAccess: false };
    await client.request("thread/settings/update", { threadId: thread.id, sandboxPolicy, disabledPluginIds: ["private@personal"] });
    await client.turn(thread.id, "continue with Claude", { model: "claude:claude-opus-5-5" });
    const meta = JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8"));
    expect(meta.nativeMcpAccess[thread.id]).toEqual({ sandboxPolicy, disabledPluginIds: ["private@personal"] });
  });

  it("does not remember rejected stock settings changes", async () => {
    gateway = await startTestGateway({ nativeMcp: true, claudeVisualize: false });
    const client = await gateway.connect();
    await client.request("thread/start", { model: "gpt-6-luna", cwd: gateway.root });
    await expect(client.request("thread/settings/update", { threadId: "missing", permissions: ":danger-full-access" })).rejects.toThrow(/thread not found/);
    const path = join(gateway.config.dataDir, "meta.json");
    const meta = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    expect(meta.nativeMcpAccess?.missing).toBeUndefined();
  });

  it.each([
    { cancel: {}, expected: { sandbox: "read-only" } },
    {
      cancel: { sandboxPolicy: { type: "readOnly", networkAccess: false }, disabledPluginIds: ["restricted@personal"] },
      expected: { sandboxPolicy: { type: "readOnly", networkAccess: false }, disabledPluginIds: ["restricted@personal"] },
    },
  ])("keeps only applied settings after a cancelled provider switch (%#)", async ({ cancel, expected }) => {
    gateway = await startTestGateway({ nativeMcp: true, claudeVisualize: false });
    const client = await gateway.connect();
    const { thread } = await client.request("thread/start", { model: "gpt-6-luna", cwd: gateway.root, sandbox: "read-only" });
    await client.request("thread/settings/update", { threadId: thread.id, model: "gpt-6-luna" });
    await client.request("thread/settings/update", { threadId: thread.id, model: "claude:claude-opus-5-5", permissions: ":danger-full-access", disabledPluginIds: ["cancelled@personal"] });
    await client.request("thread/settings/update", { threadId: thread.id, model: "gpt-6-luna", ...cancel });
    await client.turn(thread.id, "use Claude with the unchanged rights", { model: "claude:claude-opus-5-5" });
    const meta = JSON.parse(readFileSync(join(gateway.config.dataDir, "meta.json"), "utf8"));
    expect(meta.nativeMcpAccess[thread.id]).toEqual(expected);
  });

  it("reports the disabled plugins applied to Claude on start, updates, resume and fork", async () => {
    gateway = await startTestGateway({ nativeMcp: true, claudeVisualize: false });
    const client = await gateway.connect();
    const started = await client.request("thread/start", { model: "claude:claude-opus-5-5", cwd: gateway.root, disabledPluginIds: ["first@personal"] });
    expect(started.disabledPluginIds).toEqual(["first@personal"]);
    const id = started.thread.id;
    await client.turn(id, "hello");
    await client.request("thread/settings/update", { threadId: id, disabledPluginIds: ["second@personal"] });
    expect(client.notifications("thread/settings/updated", id).at(-1)?.params.threadSettings.disabledPluginIds).toEqual(["second@personal"]);
    expect((await client.request("thread/resume", { threadId: id })).disabledPluginIds).toEqual(["second@personal"]);
    expect((await client.request("thread/fork", { threadId: id })).disabledPluginIds).toEqual(["second@personal"]);
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
