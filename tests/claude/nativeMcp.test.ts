import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { NativeMcpBridge, nativeSandbox, nativeToolName, type NativeMcpContext, type NativeMcpRequest } from "../../src/claude/nativeMcp.js";

const context = (): NativeMcpContext => ({
  threadId: "claude-thread", sessionId: "actual-session", turnId: "active-turn", model: "claude:sonnet",
  cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace", "/extra"], approvalPolicy: "on-request",
  approvalsReviewer: "user", sandboxPolicy: { type: "readOnly", networkAccess: false },
});
const definition = { name: "get.profile", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  annotations: { readOnlyHint: true }, _meta: { policy: "preserve" } };
function fixture(initial = context()) {
  let current = initial;
  let onRequest: NativeMcpRequest;
  let pages: { data: { name: string; tools: Record<string, typeof definition> }[]; nextCursor: string | null }[] = [{ data: [{ name: "connected", tools: { "get.profile": definition } }], nextCursor: null as string | null }];
  const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
    if (method === "initialize") return {};
    if (method === "model/list") return { data: [{ id: "native-default", isDefault: true }] };
    if (method === "thread/start") return { thread: { id: "native-helper" } };
    if (method === "mcpServerStatus/list") return pages[(params as { cursor: string }).cursor === "second" ? 1 : 0];
    if (method === "mcpServer/tool/call") return { content: [{ type: "text", text: "ok" }], isError: false, structuredContent: null };
    throw new Error(method);
  });
  const close = vi.fn();
  const interaction = vi.fn(async () => ({ action: "decline", content: null }));
  const transport = vi.fn((handler: NativeMcpRequest) => { onRequest = handler; return { request, close }; });
  const bridge = new NativeMcpBridge(async () => current, interaction, transport);
  return { bridge, request, close, transport, interaction,
    setContext(value: NativeMcpContext) { current = value; },
    setPages(value: typeof pages) { pages = value; },
    incoming(method: string, params: Record<string, unknown>) { return onRequest!(method, params); },
  };
}

describe("native Codex MCP projection", () => {
  it("serves discovery and execution over the actual SDK MCP transport", async () => {
    const f = fixture();
    const client = new Client({ name: "native-mcp-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await f.bridge.mcpServer.instance.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools[0]?.inputSchema).toEqual(definition.inputSchema);
      expect(await client.callTool({ name: "connected__get_profile", arguments: { id: "42" } }))
        .toMatchObject({ content: [{ type: "text", text: "ok" }], isError: false });
    } finally { await client.close(); f.bridge.close(); }
  });
  it("uses native discovery, preserving schemas and policy metadata without an inference turn", async () => {
    const f = fixture();
    expect(await f.bridge.tools()).toEqual([{ ...definition, name: "connected__get_profile" }]);
    expect(f.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ model: "native-default", ephemeral: true,
      cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace", "/extra"], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "read-only" }));
    expect(f.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    f.bridge.close();
  });
  it("paginates and discovers newly connected services without a static allowlist", async () => {
    const f = fixture(); await f.bridge.tools();
    f.setPages([{ data: [], nextCursor: "second" }, { data: [{ name: "new", tools: { "get.profile": definition } }], nextCursor: null }]);
    expect((await f.bridge.tools()).map((tool) => tool.name)).toEqual(["new__get_profile"]);
    expect(f.transport).toHaveBeenCalledTimes(1); f.bridge.close();
  });
  it("forwards original names, arguments and actual turn metadata; preserves tool errors", async () => {
    const f = fixture(); await f.bridge.tools();
    f.request.mockImplementationOnce(async () => ({ content: [{ type: "text", text: "denied" }], isError: true, structuredContent: null }));
    expect(await f.bridge.call({ name: "connected__get_profile", arguments: { id: "42" }, _meta: { trace: "keep" } }))
      .toEqual({ content: [{ type: "text", text: "denied" }], isError: true });
    expect(f.request).toHaveBeenLastCalledWith("mcpServer/tool/call", { threadId: "native-helper", server: "connected", tool: "get.profile", arguments: { id: "42" },
      _meta: { trace: "keep", "x-codex-turn-metadata": { thread_id: "claude-thread", session_id: "actual-session", turn_id: "active-turn", model: "claude:sonnet" } } });
    f.bridge.close();
  });
  it("rejects unknown tools and calls outside an active turn", async () => {
    const f = fixture();
    await expect(f.bridge.call({ name: "invented" })).rejects.toThrow("unavailable");
    f.setContext({ ...context(), turnId: null });
    await expect(f.bridge.call({ name: "connected__get_profile" })).rejects.toThrow("active Claude turn");
    expect(f.request.mock.calls.some(([method]) => method === "mcpServer/tool/call")).toBe(false); f.bridge.close();
  });
  it("never merges projected names that collide", async () => {
    const f = fixture(); f.setPages([{ data: [{ name: "connected", tools: { "get.profile": definition, get_profile: definition } }], nextCursor: null }]);
    await expect(f.bridge.tools()).rejects.toThrow("collide"); f.bridge.close();
  });
  it("uses separate connections for separate runtimes and closes on disposal", async () => {
    const a = fixture(); const b = fixture({ ...context(), sessionId: "second" });
    await Promise.all([a.bridge.tools(), b.bridge.tools()]);
    a.bridge.close(); expect(a.close).toHaveBeenCalledTimes(1); expect(b.close).not.toHaveBeenCalled();
    await expect(a.bridge.tools()).rejects.toThrow("closed"); b.bridge.close();
  });
  it("rebuilds the helper when permission settings change", async () => {
    const f = fixture(); await f.bridge.tools(); f.setContext({ ...context(), approvalPolicy: "never" });
    await f.bridge.tools(); expect(f.close).toHaveBeenCalledTimes(1); expect(f.transport).toHaveBeenCalledTimes(2); f.bridge.close();
  });
  it("forwards a native approval including policy metadata, and does not auto-approve", async () => {
    const f = fixture(); await f.bridge.tools();
    f.request.mockImplementationOnce(async () => {
      const result = await f.incoming("mcpServer/elicitation/request", { threadId: "native-helper", _meta: { strict_review: true }, message: "Allow?" });
      expect(result).toEqual({ action: "decline", content: null });
      return { content: [] };
    });
    await f.bridge.call({ name: "connected__get_profile" });
    expect(f.interaction).toHaveBeenCalledWith("mcpServer/elicitation/request", { threadId: "claude-thread", turnId: "active-turn", _meta: { strict_review: true }, message: "Allow?" });
    await expect(f.incoming("mcpServer/elicitation/request", {})).rejects.toThrow("No active"); f.bridge.close();
  });
  it("rejects approval requests after the owning turn changed", async () => {
    const f = fixture(); await f.bridge.tools();
    f.request.mockImplementationOnce(async () => {
      f.setContext({ ...context(), turnId: "next-turn" });
      await expect(f.incoming("mcpServer/elicitation/request", {})).rejects.toThrow("No active");
      return { content: [] };
    });
    await f.bridge.call({ name: "connected__get_profile" }); expect(f.interaction).not.toHaveBeenCalled(); f.bridge.close();
  });
  it("cancels an in-flight request and reconnects before another call", async () => {
    const f = fixture(); await f.bridge.tools();
    const abort = new AbortController();
    f.request.mockImplementationOnce(async () => {
      abort.abort();
      return { content: [{ type: "text", text: "late" }] };
    });
    await expect(f.bridge.call({ name: "connected__get_profile" }, abort.signal)).rejects.toThrow("cancelled");
    expect(f.close).toHaveBeenCalledTimes(1);
    await f.bridge.tools(); expect(f.transport).toHaveBeenCalledTimes(2); f.bridge.close();
  });
  it("bounds long names deterministically", () => {
    expect(nativeToolName("service", "a".repeat(200))).toHaveLength(100);
    expect(nativeToolName("service", "a".repeat(200))).not.toBe(nativeToolName("service", "a".repeat(199) + "b"));
  });
  it("does not widen unknown sandbox policies", () => {
    expect(() => nativeSandbox({ type: "externalSandbox" })).toThrow("without changing access");
    expect(() => nativeSandbox({ type: "readOnly", networkAccess: true })).toThrow("without changing access");
    expect(nativeSandbox({ type: "workspaceWrite", writableRoots: ["/extra"], networkAccess: true }))
      .toEqual({ sandbox: "workspace-write", config: { sandbox_workspace_write: { writable_roots: ["/extra"], network_access: true, exclude_tmpdir_env_var: false, exclude_slash_tmp: false } } });
  });
});
