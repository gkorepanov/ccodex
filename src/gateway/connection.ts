import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { withFormatting } from "../instructions.js";
import type { Provider } from "../meta.js";
import { rpcError, type JsonObject, type RequestId } from "../protocol/codex.js";
import type { Gateway } from "./server.js";
import type { StockClient } from "./stock.js";

/** Methods that take an optional threadId only as context; for Claude threads it is dropped and stock answers. */
const THREAD_CONTEXT_METHODS = new Set([
  "app/installed", "app/list", "app/read", "experimentalFeature/list", "feedback/upload", "mcpServerStatus/list",
  "mcpServer/tool/call", "mcpServer/resource/read", "mcpServer/oauth/login", "mcpServer/event/stream/start",
]);

/** Requests that carry the client's developer instructions (Desktop's app context). */
const INSTRUCTED_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);

type Handler = (connection: Connection, params: any) => Promise<unknown>;

/**
 * One client (Desktop, TUI, relay-bridged mobile client). Everything that is not ours is forwarded byte for
 * byte to this client's own stock connection and back.
 */
export class Connection {
  public readonly id = randomUUID();
  public clientName?: string;
  /** Provider of the thread this client last worked in (rate limits follow it). */
  public provider: Provider = "codex";
  /** Ephemeral threads this client is creating: only their creator hears of them (stock tells every client). */
  public readonly ephemeralRequests = new Set<RequestId>();
  /** The developer instructions this client last sent; the stock threads the gateway starts or resumes for it get them too. */
  public developerInstructions?: string;
  private closed = false;
  /** What the client sent past its handshake before the gateway was ready, in order. */
  private backlog?: string[] = [];

  public constructor(
    private readonly gateway: Gateway,
    private readonly client: WebSocket,
    public readonly upstream: StockClient,
  ) {
    gateway.recorder.connection("opened", this.id);
    client.on("message", (data) => this.onClientText(data.toString()));
    client.once("close", () => this.close());
    client.on("error", () => this.close());
    upstream.onFrame = (text) => this.onStockText(text);
    upstream.onClose = () => this.close();
    void gateway.ready.then(() => {
      const backlog = this.backlog ?? [];
      this.backlog = undefined;
      for (const text of backlog) this.dispatch(text);
    });
  }

  /** Everything to the client goes here; a switched thread's current backend id reads as its public id. */
  public send(text: string, raw = false): void {
    if (this.closed || this.client.readyState !== WebSocket.OPEN) return;
    if (!raw) text = this.gateway.lineages.rewrite(text);
    const limit = this.gateway.config.rpcLimitBytes;
    if (limit && Buffer.byteLength(text) > limit) {
      const held = this.overLimit(text, limit);
      if (held === undefined) return;
      text = held;
    }
    this.gateway.recorder.frame(this.id, "gateway_to_client", text);
    this.client.send(text);
  }

  /**
   * A message over `rpc_limit_mb` holds up everything else on the client's one connection (over SSH, the phone's) or
   * breaks it: an answer the client waits for fails instead, anything else is dropped.
   */
  private overLimit(text: string, limit: number): string | undefined {
    const message = JSON.parse(text) as JsonObject;
    const size = `${(Buffer.byteLength(text) / 1_000_000).toFixed(1)} MB`;
    this.gateway.logger.warn("rpc.over-limit", { method: message.method, id: message.id, size });
    if (message.method !== undefined || message.id === undefined) return undefined;
    return JSON.stringify({ id: message.id, error: { code: -32603, message: `CCodex held back this ${size} answer: over rpc_limit_mb (${limit / 1_000_000} MB) in ~/.ccodex/config.toml.` } });
  }

  public notify(method: string, params: unknown): void {
    this.send(JSON.stringify({ method, params }));
  }

  public respond(id: RequestId, result: unknown): void {
    this.ephemeralRequests.delete(id);
    this.send(JSON.stringify({ id, result }));
  }

  /** Server→client request originated by CCodex (string ids never collide with stock's numeric ids). */
  public request(id: string, method: string, params: unknown): void {
    this.send(JSON.stringify({ id, method, params }));
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.gateway.detach(this);
    this.gateway.recorder.connection("closed", this.id);
    if (this.client.readyState === WebSocket.OPEN) this.client.close();
    this.upstream.close();
  }

  private forward(text: string): void {
    this.upstream.send(text).catch(() => this.close());
  }

  private onClientText(text: string): void {
    this.gateway.recorder.frame(this.id, "client_to_gateway", text);
    if (this.backlog && !/^\{(?:"id":[^,]*,)?"method":"initialized?"/u.test(text)) this.backlog.push(text);
    else this.dispatch(text);
  }

  private dispatch(text: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(text) as JsonObject;
    } catch {
      this.forward(text);
      return;
    }
    if (INSTRUCTED_METHODS.has(message.method) && message.params?.developerInstructions) {
      if (this.gateway.config.improveModelsFormatting) {
        message.params.developerInstructions = withFormatting(message.params.developerInstructions);
        text = JSON.stringify(message);
      }
      this.developerInstructions = message.params.developerInstructions;
    }
    // Desktop shows a remote host's file by an uncapped `cat` (a video: hundreds of MB on the connection every chat
    // shares): stock's own output cap stops it at the limit. A terminal (tty) streams on.
    const limit = this.gateway.config.rpcLimitBytes;
    if (message.method === "process/spawn" && limit && !message.params.tty
      && (message.params.outputBytesCap === null || message.params.outputBytesCap > limit)) {
      message.params.outputBytesCap = limit;
      text = JSON.stringify(message);
    }
    if ((message.method === "thread/start" || message.method === "thread/fork") && message.params?.ephemeral === true) {
      this.ephemeralRequests.add(message.id);
    }
    if (message.method === undefined) {
      if (typeof message.id === "string" && message.id.startsWith("ccodex:")) this.gateway.resolveServerRequest(message);
      else this.forward(text);
      return;
    }
    if (message.id === undefined) {
      this.forward(text);
      return;
    }
    const handler = this.route(message.method, message.params ?? {});
    if (!handler) {
      this.forward(text);
      return;
    }
    handler(this, message.params ?? {}).then(
      (result) => this.respond(message.id, result),
      (error: unknown) => {
        this.gateway.logger.warn("request.failed", { method: message.method, error: String(error) });
        this.send(JSON.stringify({ id: message.id, error: rpcError(error) }));
      },
    );
  }

  private route(method: string, params: JsonObject): Handler | undefined {
    const gateway = this.gateway;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const own = gateway.handlers.get(method);
    if (own) return own;
    if (threadId && THREAD_CONTEXT_METHODS.has(method) && gateway.isClaudeThread(threadId)) {
      const { threadId: _, ...rest } = params;
      return () => this.upstream.request(method, rest);
    }
    return gateway.threadHandler(this, method, params);
  }

  private onStockText(text: string): void {
    if (this.ephemeralRequests.size && text.startsWith("{\"id\"")) this.ephemeralRequests.delete((JSON.parse(text) as JsonObject).id);
    const rewritten = this.gateway.fromBackendFrame(this, text);
    if (rewritten !== undefined) this.send(rewritten);
  }
}
