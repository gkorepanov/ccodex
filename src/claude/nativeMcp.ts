import { createHash } from "node:crypto";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { connectStock } from "../codex/stockConnection.js";
import { StockRpc } from "../gateway/stockRpc.js";
import { isRequest, parseRpcMessage } from "../protocol/envelopes.js";
import type { ListMcpServerStatusResponse } from "../codex/generated/v2/ListMcpServerStatusResponse.js";
import type { Tool } from "../codex/generated/Tool.js";

export interface NativeMcpContext {
  threadId: string;
  sessionId: string;
  turnId: string | null;
  model: string;
  cwd: string;
  runtimeWorkspaceRoots: readonly string[];
  approvalPolicy: unknown;
  approvalsReviewer: string;
  sandboxPolicy: unknown;
}

export interface NativeMcpTransport {
  request(method: string, params: unknown): Promise<unknown>;
  close(): void;
}
export type NativeMcpRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** A private stock connection, never the public CCodex socket (which would recurse). */
export function nativeMcpTransport(socketPath: string, onRequest: NativeMcpRequest): NativeMcpTransport {
  const socket = connectStock(socketPath);
  const rpc = new StockRpc(socket);
  socket.on("message", (data, binary) => {
    const message = binary ? undefined : parseRpcMessage(data);
    if (!message || rpc.handle(message) || !isRequest(message)) return;
    void onRequest(message.method, (message.params ?? {}) as Record<string, unknown>)
      .then((result) => rpc.respond(message.id, result))
      .catch(() => rpc.respond(message.id, { rpcError: { code: -32603, message: "Native MCP request declined or no longer owned by an active Claude turn." } }))
      .catch(() => undefined);
  });
  return {
    request: (method, params) => rpc.request(method, params, 120_000),
    close: () => { rpc.close(new Error("Claude native MCP runtime closed.")); socket.close(); },
  };
}

export function nativeToolName(server: string, tool: string): string {
  const original = `${server}__${tool}`;
  const safe = original.replace(/[^a-zA-Z0-9_-]/gu, "_");
  return safe.length <= 100 ? safe : `${safe.slice(0, 83)}_${createHash("sha256").update(original).digest("hex").slice(0, 16)}`;
}

/** One instance per Claude runtime. No credentials, connector SDKs or inference calls. */
export class NativeMcpBridge {
  public readonly mcpServer = createSdkMcpServer({ name: "codex", version: "1.0.0", tools: [] });
  private connection: NativeMcpTransport | undefined;
  private initialized: Promise<void> | undefined;
  private nativeThread: string | undefined;
  private policyKey: string | undefined;
  private inventory = new Map<string, { server: string; tool: string; definition: Tool }>();
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;
  private callContext: NativeMcpContext | undefined;

  public constructor(
    private readonly context: () => Promise<NativeMcpContext>,
    private readonly onRequest: NativeMcpRequest,
    private readonly transport: (onRequest: NativeMcpRequest) => NativeMcpTransport,
  ) {
    const server = this.mcpServer.instance.server;
    server.registerCapabilities({ tools: {} });
    server.setRequestHandler(z.object({ method: z.literal("tools/list") }), async () => ({ tools: await this.tools() }));
    server.setRequestHandler(z.object({ method: z.literal("tools/call"), params: z.object({
      name: z.string(), arguments: z.record(z.string(), z.unknown()).optional(),
      _meta: z.record(z.string(), z.unknown()).optional(),
    }) }), async ({ params }, extra) => this.call(params, extra.signal));
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(() => {
      if (this.closed) throw new Error("Native MCP runtime is closed.");
      return operation();
    });
    this.serial = next.catch(() => undefined);
    return next;
  }

  private async requestFromStock(method: string, params: Record<string, unknown>): Promise<unknown> {
    // Only interactions belonging to this in-flight tool call may reach the UI.
    const owner = this.callContext;
    const current = await this.context();
    if (!owner?.turnId || owner.turnId !== current.turnId) throw new Error("No active native MCP call.");
    if (method !== "mcpServer/elicitation/request" && method !== "tool/requestUserInput") {
      throw new Error("Unsupported native MCP interaction.");
    }
    return this.onRequest(method, { ...params, threadId: owner.threadId, turnId: owner.turnId });
  }

  private async ensureThread(context: NativeMcpContext): Promise<NativeMcpTransport> {
    const { cwd, runtimeWorkspaceRoots, approvalPolicy, approvalsReviewer, sandboxPolicy } = context;
    const sandbox = nativeSandbox(sandboxPolicy);
    const key = JSON.stringify({ cwd, runtimeWorkspaceRoots, approvalPolicy, approvalsReviewer, sandboxPolicy });
    if (this.connection && this.policyKey !== key) {
      this.connection.close(); this.connection = undefined; this.nativeThread = undefined; this.initialized = undefined;
      this.inventory.clear();
    }
    if (!this.connection) {
      this.inventory.clear();
      this.nativeThread = undefined;
      this.policyKey = key;
      this.connection = this.transport((method, params) => this.requestFromStock(method, params));
      const connection = this.connection;
      this.initialized = (async () => {
        await connection.request("initialize", {
          clientInfo: { name: "ccodex-native-mcp", version: "1.0.0" },
          capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
        });
        const catalog = await connection.request("model/list", { limit: 100 }) as { data: { id: string; isDefault?: boolean }[] };
        const model = catalog.data.find((entry) => entry.isDefault)?.id ?? catalog.data[0]?.id;
        if (!model) throw new Error("Native Codex model catalog is empty.");
        const result = await connection.request("thread/start", {
          model, cwd, runtimeWorkspaceRoots, approvalPolicy, approvalsReviewer,
          ...sandbox, ephemeral: true, threadSource: "system",
        }) as { thread: { id: string } };
        this.nativeThread = result.thread.id;
      })();
    }
    try { await this.initialized; }
    catch (error) { this.connection?.close(); this.connection = undefined; this.initialized = undefined; throw error; }
    if (this.closed || !this.connection) throw new Error("Native MCP runtime is closed or cancelled.");
    return this.connection;
  }

  private async discover(connection: NativeMcpTransport): Promise<Tool[]> {
    let cursor: string | null = null;
    const inventory = new Map<string, { server: string; tool: string; definition: Tool }>();
    do {
      const page = await connection.request("mcpServerStatus/list", {
        threadId: this.nativeThread, detail: "toolsAndAuthOnly", limit: 100, cursor,
      }) as ListMcpServerStatusResponse;
      for (const server of page.data) {
        for (const [original, definition] of Object.entries(server.tools)) {
          if (!definition) continue;
          const meta = definition._meta as { ui?: { visibility?: string[] } } | undefined;
          if (meta?.ui?.visibility && !meta.ui.visibility.includes("model")) continue;
          const name = nativeToolName(server.name, original);
          if (inventory.has(name)) throw new Error("Native MCP tool names collide after projection.");
          inventory.set(name, { server: server.name, tool: original, definition: { ...definition, name } });
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.inventory = inventory;
    return [...inventory.values()].map((entry) => entry.definition);
  }

  public tools(): Promise<Tool[]> {
    return this.run(async () => this.discover(await this.ensureThread(await this.context())));
  }

  public call(
    params: { name: string; arguments?: Record<string, unknown> | undefined; _meta?: Record<string, unknown> | undefined },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.run(async () => {
      if (signal?.aborted) throw new Error("Native MCP call cancelled.");
      const cancel = () => this.invalidateConnection();
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const context = await this.context();
        if (!context.turnId) throw new Error("Native MCP tools require an active Claude turn.");
        const connection = await this.ensureThread(context);
        if (!this.inventory.has(params.name)) await this.discover(connection);
        const selected = this.inventory.get(params.name);
        if (!selected) throw new Error("Tool is unavailable in the current native Codex inventory.");
        if (signal?.aborted) throw new Error("Native MCP call cancelled.");
        this.callContext = context;
        const result = await connection.request("mcpServer/tool/call", {
          threadId: this.nativeThread, server: selected.server, tool: selected.tool,
          arguments: params.arguments ?? {},
          _meta: { ...params._meta, "x-codex-turn-metadata": {
            thread_id: context.threadId, session_id: context.sessionId,
            turn_id: context.turnId, model: context.model,
          } },
        }) as Record<string, unknown>;
        if (signal?.aborted) throw new Error("Native MCP call cancelled.");
        return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== null));
      } catch (error) {
        this.invalidateConnection();
        throw error;
      } finally {
        this.callContext = undefined;
        signal?.removeEventListener("abort", cancel);
      }
    });
  }

  private invalidateConnection(): void {
    this.connection?.close();
    this.connection = undefined;
    this.initialized = undefined;
    this.nativeThread = undefined;
    this.inventory.clear();
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.invalidateConnection();
  }
}

export function nativeSandbox(policy: unknown): Record<string, unknown> {
  const value = policy as { type?: string; writableRoots?: string[]; networkAccess?: boolean; excludeTmpdirEnvVar?: boolean; excludeSlashTmp?: boolean } | null;
  if (value?.type === "dangerFullAccess") return { sandbox: "danger-full-access" };
  if (value?.type === "readOnly" && !value.networkAccess) return { sandbox: "read-only" };
  if (value?.type === "workspaceWrite") return { sandbox: "workspace-write", config: {
    sandbox_workspace_write: { writable_roots: value.writableRoots ?? [], network_access: value.networkAccess ?? false,
      exclude_tmpdir_env_var: value.excludeTmpdirEnvVar ?? false, exclude_slash_tmp: value.excludeSlashTmp ?? false },
  } };
  throw new Error("Cannot project this Claude sandbox policy to native MCP without changing access.");
}
