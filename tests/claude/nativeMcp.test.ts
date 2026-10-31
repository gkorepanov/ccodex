import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NativeMcpBridge, nativeToolName, type NativeMcpContext, type NativeMcpTransport } from "../../src/claude/nativeMcp.js";
import type { Connection } from "../../src/gateway/connection.js";
import { Gateway } from "../../src/gateway/server.js";
import { Logger } from "../../src/log.js";
import { testConfig } from "../fixtures/config.js";

const context = (): NativeMcpContext => ({
  threadId: "claude-owner", turnId: "turn-1", model: "claude:sonnet", cwd: "/work", runtimeWorkspaceRoots: ["/work"],
  approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly", networkAccess: false }, plan: false,
});
const definition = { name: "read.profile", description: "Read a profile", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } }, annotations: { readOnlyHint: true }, _meta: { origin: "native" } };
function fixture(onRequest?: (method: string, params: any, signal?: AbortSignal) => Promise<unknown>) {
  let current = context();
  const requests: { method: string; params: any }[] = [];
  let callback: (method: string, params: any) => Promise<unknown>;
  let closed = 0;
  let connections = 0;
  let action: (() => Promise<any>) | undefined;
  const bridge = new NativeMcpBridge(() => current, onRequest ?? (async (_method, params) => ({ action: "decline", echoed: params })), (onRequest) => {
    callback = onRequest;
    connections++;
    const id = `helper-${connections}`;
    return {
      async request(method, params) {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id } };
        if (method === "mcpServerStatus/list") return params.cursor
          ? { data: [{ name: "app", pluginId: "disabled@personal", tools: { write: { ...definition, name: "write", annotations: { readOnlyHint: false } } } }], nextCursor: null }
          : { data: [{ name: "github", tools: { read: definition, ui: { ...definition, _meta: { ui: { visibility: ["app"] } } } } }], nextCursor: "page-2" };
        if (method === "mcpServer/tool/call") return action ? action() : { content: [{ type: "text", text: "native result" }], structuredContent: null, isError: false };
        return {};
      },
      close() { closed++; },
    } satisfies NativeMcpTransport;
  });
  return { bridge, requests, callback: (method: string, params: any) => callback!(method, params), setContext: (value: NativeMcpContext) => { current = value; }, get current() { return current; }, setAction: (value: () => Promise<any>) => { action = value; }, get closed() { return closed; }, get connections() { return connections; } };
}

describe("native MCP bridge", () => {
  it("exposes paginated schemas and metadata through a real SDK MCP transport", async () => {
    const f = fixture();
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await f.bridge.mcpServer.instance.connect(a);
    await client.connect(b);
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(2);
    expect(listed.tools[0]).toMatchObject({ inputSchema: definition.inputSchema, annotations: definition.annotations, _meta: definition._meta });
    const result = await client.callTool({ name: nativeToolName("github", "read"), arguments: { id: "7" } });
    expect(result).toMatchObject({ content: [{ type: "text", text: "native result" }] });
    expect(f.requests.find(r => r.method === "mcpServer/tool/call")?.params).toMatchObject({
      threadId: "helper-1", server: "github", tool: "read", arguments: { id: "7" },
      _meta: { "x-codex-turn-metadata": { thread_id: "claude-owner", session_id: "claude-owner", turn_id: "turn-1", model: "claude:sonnet" } },
    });
    await client.close(); f.bridge.close();
  });

  it("refuses calls outside an active turn and recovers on the next turn", async () => {
    const f = fixture(); f.setContext({ ...f.current, turnId: null });
    await expect(f.bridge.call({ name: nativeToolName("github", "read") })).rejects.toThrow(/active Claude turn/);
    expect(f.requests.some(r => r.method === "mcpServer/tool/call")).toBe(false);
    f.setContext({ ...f.current, turnId: "next" });
    await expect(f.bridge.call({ name: nativeToolName("github", "read") })).resolves.toHaveProperty("content");
    f.bridge.close();
  });

  it("rejects a stale turn before dispatch after discovery", async () => {
    const f = fixture();
    await f.bridge.tools();
    f.setContext({ ...f.current, turnId: "turn-2" });
    await expect(f.bridge.call({ name: nativeToolName("github", "missing") })).rejects.toThrow(/unavailable/);
    expect(f.requests.some(r => r.method === "mcpServer/tool/call")).toBe(false);
    f.bridge.close();
  });

  it("rejects queued calls from an ended turn before they can use the next turn's authority", async () => {
    const f = fixture();
    let started!: () => void;
    let release!: () => void;
    const active = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.setAction(async () => { started(); await blocked; return { content: [] }; });
    const first = f.bridge.call({ name: nativeToolName("app", "write") }).catch(error => error);
    await active;
    const queued = f.bridge.call({ name: nativeToolName("app", "write") }).catch(error => error);
    f.setContext({ ...f.current, turnId: "turn-2" });
    release();
    expect(await first).toBeInstanceOf(Error);
    expect(await queued).toBeInstanceOf(Error);
    expect(f.requests.filter(request => request.method === "mcpServer/tool/call")).toHaveLength(1);
    f.setAction(async () => ({ content: [] }));
    await expect(f.bridge.call({ name: nativeToolName("app", "write") })).resolves.toEqual({ content: [] });
    f.bridge.close();
  });

  it("rotates the private helper when permissions change", async () => {
    const f = fixture(); await f.bridge.tools();
    f.setContext({ ...f.current, sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never" });
    await f.bridge.call({ name: nativeToolName("github", "read") });
    expect(f.connections).toBe(2); expect(f.closed).toBe(1);
    expect(f.requests.findLast(r => r.method === "thread/start")?.params.sandbox).toBe("danger-full-access");
    f.bridge.close();
  });

  it("preserves the original native policy and additional workspace roots", async () => {
    const f = fixture();
    f.setContext({ ...f.current, access: { sandboxPolicy: { type: "readOnly", networkAccess: false }, runtimeWorkspaceRoots: ["/work", "/extra"], approvalPolicy: "untrusted", approvalsReviewer: "auto_review" } });
    await f.bridge.tools();
    expect(f.requests.find(r => r.method === "thread/start")?.params).toMatchObject({ sandbox: "read-only", runtimeWorkspaceRoots: ["/work", "/extra"], approvalPolicy: "untrusted", approvalsReviewer: "auto_review" });
    f.bridge.close();
  });

  it("passes a named permission profile without a conflicting sandbox", async () => {
    const f = fixture(); f.setContext({ ...f.current, access: { permissions: "restricted", config: { 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled': true }, disabledPluginIds: ["disabled@personal"] } });
    await f.bridge.tools();
    const params = f.requests.find(r => r.method === "thread/start")!.params;
    expect(params.permissions).toBe("restricted"); expect(params.sandbox).toBeUndefined();
    expect(params.config['plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled']).toBe(true);
    expect(params.disabledPluginIds).toBeUndefined();
    expect(f.requests.find(r => r.method === "thread/settings/update")?.params).toEqual({ threadId: "helper-1", disabledPluginIds: ["disabled@personal"] });
    expect(f.requests.findIndex(r => r.method === "thread/settings/update")).toBeLessThan(f.requests.findIndex(r => r.method === "mcpServerStatus/list"));
    expect((await f.bridge.tools()).map(t => t.name)).not.toContain(nativeToolName("app", "write"));
    await expect(f.bridge.call({ name: nativeToolName("app", "write") })).rejects.toThrow(/unavailable/);
    f.bridge.close();
  });

  it("keeps stock defaults when the app did not specify native permissions", async () => {
    const f = fixture(); f.setContext({ ...f.current, access: {} }); await f.bridge.tools();
    const params = f.requests.find(r => r.method === "thread/start")!.params;
    expect(params.sandbox).toBeUndefined(); expect(params.approvalPolicy).toBeUndefined(); f.bridge.close();
  });

  it("preserves native approval metadata and binds it to the owning turn", async () => {
    const f = fixture();
    f.setAction(async () => {
      const reply = await f.callback("mcpServer/elicitation/request", { threadId: "helper-1", _meta: { policy: "native" }, mode: "form" });
      expect(reply).toMatchObject({ action: "decline", echoed: { threadId: "claude-owner", turnId: "turn-1", _meta: { policy: "native" } } });
      return { content: [{ type: "text", text: "declined" }], isError: true };
    });
    await expect(f.bridge.call({ name: nativeToolName("github", "read") })).resolves.toHaveProperty("isError", true);
    await expect(f.callback("unknown/request", {})).rejects.toThrow();
    f.bridge.close();
  });

  it("closes a cancelled operation and permits a fresh call", async () => {
    const f = fixture(); const abort = new AbortController();
    f.setAction(async () => { abort.abort(); throw new Error("cancelled"); });
    await expect(f.bridge.call({ name: nativeToolName("github", "read") }, abort.signal)).rejects.toThrow();
    f.setAction(async () => ({ content: [{ type: "text", text: "recovered" }] }));
    await expect(f.bridge.call({ name: nativeToolName("github", "read") })).resolves.toHaveProperty("content");
    expect(f.connections).toBe(2); f.bridge.close();
  });

  it.each(["refresh", "abort", "close"] as const)("cancels only its native interaction on %s", async (reason) => {
    const root = mkdtempSync(join(tmpdir(), "native-interaction-"));
    const gateway = new Gateway(testConfig({ dataDir: root }), join(root, "gateway.sock"), new Logger("error"));
    const prompts: { id: string; method: string }[] = [];
    const events: any[] = [];
    gateway.subscribe("claude-owner", {
      request: (id: string, method: string) => prompts.push({ id, method }),
      send: (frame: string) => events.push(JSON.parse(frame)),
    } as unknown as Connection);
    const unrelated = gateway.serverRequest("claude-owner", "tool/requestUserInput", {}).catch(error => error);
    const f = fixture((method, params, signal) => gateway.serverRequest("claude-owner", method, params, signal));
    const abort = new AbortController();
    let started!: () => void;
    const forwarded = new Promise<void>(resolve => { started = resolve; });
    f.setAction(async () => {
      const interaction = f.callback("mcpServer/elicitation/request", { mode: "form" });
      started();
      await interaction;
      return { content: [] };
    });
    const running = f.bridge.call({ name: nativeToolName("github", "read") }, abort.signal).catch(error => error);
    try {
      await forwarded;
      const native = prompts.find(prompt => prompt.method === "mcpServer/elicitation/request")!;
      if (reason === "abort") abort.abort();
      else f.bridge[reason]();
      const replayed: string[] = [];
      gateway.subscribe("claude-owner", {
        request: (_id: string, method: string) => replayed.push(method), send: () => undefined,
      } as unknown as Connection);
      expect(replayed).toEqual(["tool/requestUserInput"]);
      expect(events).toContainEqual({ method: "serverRequest/resolved", params: { threadId: "claude-owner", requestId: native.id } });
      expect(await running).toBeInstanceOf(Error);
    } finally {
      gateway.cancelServerRequests("claude-owner");
      f.bridge.close();
      await running;
      await unrelated;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("limits plan mode to tools explicitly marked read-only", async () => {
    const f = fixture(); f.setContext({ ...f.current, plan: true });
    expect(await f.bridge.tools()).toHaveLength(2);
    await expect(f.bridge.call({ name: nativeToolName("app", "write") })).rejects.toThrow(/unavailable|plan/);
    expect(f.requests.some(r => r.method === "mcpServer/tool/call")).toBe(false); f.bridge.close();
  });

  it("restores write calls after leaving plan mode without changing the catalog", async () => {
    const f = fixture(); f.setContext({ ...f.current, plan: true });
    const listed = await f.bridge.tools();
    await expect(f.bridge.call({ name: nativeToolName("app", "write") })).rejects.toThrow(/plan/);
    f.setContext({ ...f.current, plan: false });
    await expect(f.bridge.call({ name: nativeToolName("app", "write") })).resolves.toHaveProperty("content");
    expect((await f.bridge.tools()).map(t => t.name)).toEqual(listed.map(t => t.name)); f.bridge.close();
  });

  it("does not let caller metadata replace the actual owner", async () => {
    const f = fixture();
    await f.bridge.call({ name: nativeToolName("github", "read"), _meta: { "openai/threadId": "other", "openai/turnId": "other-turn", "x-codex-turn-metadata": { thread_id: "other" } } });
    expect(f.requests.find(r => r.method === "mcpServer/tool/call")?.params._meta["x-codex-turn-metadata"].thread_id).toBe("claude-owner");
    expect(f.requests.find(r => r.method === "mcpServer/tool/call")?.params._meta["openai/threadId"]).toBe("claude-owner");
    f.bridge.close();
  });

  it("gives distinct, bounded names to ambiguous original names", () => {
    expect(nativeToolName("a.b", "c")).not.toBe(nativeToolName("a_b", "c"));
    expect(nativeToolName("a__b", "c")).not.toBe(nativeToolName("a", "b__c"));
    expect(nativeToolName("x".repeat(120), "c").length).toBeLessThanOrEqual(100);
  });
});
