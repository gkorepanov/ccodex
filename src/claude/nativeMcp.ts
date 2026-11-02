import { createHash } from "node:crypto";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { StockClient, openStockSocket } from "../gateway/stock.js";
import type { NativeMcpAccess } from "./nativeAccess.js";

export interface NativeMcpContext {
  threadId: string;
  turnId: string | null;
  model: string;
  cwd: string;
  runtimeWorkspaceRoots: readonly string[];
  approvalPolicy: unknown;
  approvalsReviewer: string;
  sandboxPolicy: Record<string, any>;
  plan: boolean;
  access?: NativeMcpAccess;
}

export interface NativeMcpTransport {
  request(method: string, params: Record<string, any>): Promise<any>;
  close(): void;
}
type Interaction = (method: string, params: Record<string, any>, signal?: AbortSignal) => Promise<unknown>;
const INTERACTIONS = new Set([
  "mcpServer/elicitation/request", "item/tool/requestUserInput", "tool/requestUserInput",
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
]);

/** Native execution stays in stock, on its private socket, with no inference turn. */
export function nativeMcpTransport(socketPath: string, onRequest: Interaction): NativeMcpTransport {
  const client = new StockClient(openStockSocket(socketPath));
  client.onFrame = (text) => {
    const message = JSON.parse(text) as Record<string, any>;
    if (message.id === undefined || typeof message.method !== "string") return;
    void onRequest(message.method, message.params ?? {}).then(
      (result) => client.send(JSON.stringify({ id: message.id, result })),
      () => client.send(JSON.stringify({ id: message.id, error: { code: -32603, message: "Native interaction declined or its Claude turn ended." } })),
    ).catch(() => undefined);
  };
  return {
    async request(method, params) {
      const result = await client.request(method, params);
      if (method === "initialize") client.notify("initialized");
      return result;
    },
    close: () => client.close(),
  };
}

export function nativeToolName(server: string, tool: string): string {
  const original = `${server}__${tool}`;
  const safe = original.replace(/[^a-zA-Z0-9_-]/gu, "_");
  if (safe === original && !server.includes("__") && !tool.includes("__") && safe.length <= 100) return safe;
  return `${safe.slice(0, 83)}_${createHash("sha256").update(JSON.stringify([server, tool])).digest("hex").slice(0, 16)}`;
}

function nativeSandbox(context: NativeMcpContext): Record<string, unknown> {
  if (context.plan) return { sandbox: "read-only" };
  if (context.access?.permissions) return { permissions: context.access.permissions };
  if (context.access?.sandbox) return { sandbox: context.access.sandbox };
  const policy = context.access === undefined ? context.sandboxPolicy : context.access.sandboxPolicy;
  if (!policy) return {};
  if (policy.type === "dangerFullAccess") return { sandbox: "danger-full-access" };
  if (policy.type === "readOnly" && !policy.networkAccess) return { sandbox: "read-only" };
  if (policy.type === "workspaceWrite") return { sandbox: "workspace-write", config: { sandbox_workspace_write: {
    writable_roots: policy.writableRoots ?? [], network_access: policy.networkAccess ?? false,
    exclude_tmpdir_env_var: policy.excludeTmpdirEnvVar ?? false, exclude_slash_tmp: policy.excludeSlashTmp ?? false,
  } } };
  throw new Error("The current Claude sandbox cannot be projected without changing access. Select a supported Codex permission mode.");
}

/** A separate SDK server and ephemeral native thread for each Claude runtime. */
export class NativeMcpBridge {
  public readonly mcpServer = createSdkMcpServer({ name: "codex_native", version: "1.0.0", tools: [] });
  private connection?: NativeMcpTransport;
  private nativeThread?: string;
  private policyKey?: string;
  private inventory = new Map<string, { server: string; tool: string; definition: Tool }>();
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;
  private callContext?: NativeMcpContext;
  private callAbort?: AbortController;
  private workspaceCall = false;
  private readonly workspaceUpdates: (() => Promise<void>)[] = [];

  public constructor(
    private readonly context: () => NativeMcpContext,
    private readonly onRequest: Interaction,
    private readonly transport: (onRequest: Interaction) => NativeMcpTransport,
  ) {
    const server = this.mcpServer.instance.server;
    server.registerCapabilities({ tools: { listChanged: true } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.tools() }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => this.call(params, extra.signal));
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(() => {
      if (this.closed) throw new Error("Native MCP runtime is closed.");
      return operation();
    });
    this.serial = result.catch(() => undefined);
    return result;
  }

  private key(context: NativeMcpContext): string {
    const { cwd, runtimeWorkspaceRoots, approvalPolicy, approvalsReviewer, sandboxPolicy, plan, access } = context;
    return JSON.stringify({ cwd, runtimeWorkspaceRoots, approvalPolicy, approvalsReviewer, sandboxPolicy, plan, access });
  }

  private assertOwner(owner: NativeMcpContext): void {
    const current = this.context();
    if (!owner.turnId || current.threadId !== owner.threadId || current.turnId !== owner.turnId || this.key(current) !== this.key(owner)) {
      throw new Error("Native MCP tools require the same active Claude turn and permissions.");
    }
  }

  private async requestFromStock(method: string, params: Record<string, any>, connection: NativeMcpTransport): Promise<unknown> {
    const owner = this.callContext;
    const abort = this.callAbort;
    if (this.connection !== connection || !owner || !abort || !INTERACTIONS.has(method)) throw new Error("Unsupported or unowned native interaction.");
    abort.signal.throwIfAborted();
    this.assertOwner(owner);
    const result = await this.onRequest(method, { ...params, threadId: owner.threadId, turnId: owner.turnId }, abort.signal);
    abort.signal.throwIfAborted();
    this.assertOwner(owner);
    return result;
  }

  private async ensureThread(context: NativeMcpContext): Promise<NativeMcpTransport> {
    const key = this.key(context);
    const sandbox = nativeSandbox(context);
    if (this.connection && this.policyKey !== key) this.invalidate();
    if (!this.connection) {
      const connection: NativeMcpTransport = this.transport((method, params) => this.requestFromStock(method, params, connection));
      this.connection = connection;
      this.policyKey = key;
      try {
        await connection.request("initialize", {
          clientInfo: { name: "ccodex_native_mcp", version: "1.0.0" },
          capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
        });
        const result = await connection.request("thread/start", {
          cwd: context.cwd, runtimeWorkspaceRoots: context.access?.runtimeWorkspaceRoots ?? context.runtimeWorkspaceRoots,
          ...(context.access === undefined
            ? { approvalPolicy: context.approvalPolicy, approvalsReviewer: context.approvalsReviewer }
            : { approvalPolicy: context.access.approvalPolicy, approvalsReviewer: context.access.approvalsReviewer }),
          ...sandbox,
          config: { ...context.access?.config, ...(sandbox.config as Record<string, unknown> | undefined) },
          ephemeral: true, threadSource: "system",
        });
        if (this.closed || this.connection !== connection) throw new Error("Native MCP runtime closed while initializing.");
        this.nativeThread = result.thread.id;
        if (context.access?.disabledPluginIds) await connection.request("thread/settings/update", {
          threadId: this.nativeThread, disabledPluginIds: context.access.disabledPluginIds,
        });
      } catch (error) { this.invalidate(); throw error; }
    }
    return this.connection!;
  }

  private async discover(connection: NativeMcpTransport, context: NativeMcpContext): Promise<Tool[]> {
    const inventory = new Map<string, { server: string; tool: string; definition: Tool }>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await connection.request("mcpServerStatus/list", { threadId: this.nativeThread, detail: "toolsAndAuthOnly", limit: 100, cursor });
      for (const server of page.data) {
        // MCP status includes plugin servers even when their tools are disabled for this chat.
        if (server.pluginId && context.access?.disabledPluginIds?.includes(server.pluginId)) continue;
        for (const [original, raw] of Object.entries(server.tools ?? {})) {
          const definition = raw as Tool;
          const visibility = (definition._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility;
          if (visibility && !visibility.includes("model")) continue;
          const name = nativeToolName(server.name, original);
          if (inventory.has(name)) throw new Error("Native tool projection produced duplicate names.");
          inventory.set(name, { server: server.name, tool: original, definition: { ...definition, name } });
        }
      }
      cursor = page.nextCursor ?? null;
      if (cursor && cursors.has(cursor)) throw new Error("Native MCP discovery repeated a pagination cursor.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.inventory = inventory;
    return [...inventory.values()].map(item => item.definition);
  }

  public tools(): Promise<Tool[]> {
    return this.run(async () => {
      try {
        const context = this.context();
        return await this.discover(await this.ensureThread(context), context);
      } catch (error) { this.invalidate(); throw error; }
    });
  }

  /** App worktree tools update their owning chat before returning; rotate the helper after that result settles. */
  public deferWorkingDirectoryUpdate(params: Record<string, unknown>, apply: () => Promise<void>): boolean {
    if (!this.callContext || !this.workspaceCall || typeof params.cwd !== "string"
      || Object.keys(params).some(key => key !== "threadId" && key !== "cwd")) return false;
    this.workspaceUpdates.push(apply);
    return true;
  }

  public call(params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }, signal?: AbortSignal): Promise<Record<string, any>> {
    const context = structuredClone(this.context());
    return this.run(async () => {
      const cancel = () => this.invalidate();
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        if (signal?.aborted) throw new Error("Native MCP call cancelled.");
        this.assertOwner(context);
        const connection = await this.ensureThread(context);
        if (!this.inventory.has(params.name)) await this.discover(connection, context);
        const selected = this.inventory.get(params.name);
        if (!selected) throw new Error("Tool is unavailable in the current native Codex inventory.");
        if (context.plan && selected.definition.annotations?.readOnlyHint !== true) throw new Error("Native tools with side effects are unavailable in plan mode.");
        this.assertOwner(context);
        if (signal?.aborted) throw new Error("Native MCP call cancelled.");
        this.callContext = context;
        this.callAbort = new AbortController();
        this.workspaceCall = selected.server === "codex_app" && ["create_worktree", "attach_worktree", "restore_worktree"].includes(selected.tool);
        const result = await connection.request("mcpServer/tool/call", {
          threadId: this.nativeThread, server: selected.server, tool: selected.tool, arguments: params.arguments ?? {},
          _meta: { ...params._meta, "openai/threadId": context.threadId, "openai/turnId": context.turnId, "x-codex-turn-metadata": {
            thread_id: context.threadId, session_id: context.threadId, turn_id: context.turnId, model: context.model,
          } },
        });
        this.assertOwner(context);
        if (signal?.aborted) throw new Error("Native MCP call cancelled.");
        return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== null));
      } catch (error) { this.invalidate(); throw error; }
      finally {
        this.callAbort?.abort();
        this.callAbort = undefined;
        this.callContext = undefined;
        this.workspaceCall = false;
        signal?.removeEventListener("abort", cancel);
        for (const apply of this.workspaceUpdates.splice(0)) await apply();
      }
    });
  }

  private invalidate(): void {
    this.callAbort?.abort();
    this.callAbort = undefined;
    this.connection?.close();
    this.connection = undefined;
    this.nativeThread = undefined;
    this.inventory.clear();
  }

  public refresh(): void {
    this.invalidate();
    void this.mcpServer.instance.server.sendToolListChanged().catch(() => undefined);
  }

  public close(): void { this.closed = true; this.invalidate(); }
}
