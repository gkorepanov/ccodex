import { chmodSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { ClaudeThreads } from "../claude/threads.js";
import type { Config } from "../config.js";
import { Logger, RpcRecorder } from "../log.js";
import { Meta } from "../meta.js";
import { RpcFailure, type JsonObject } from "../protocol/codex.js";
import { Catalog } from "./catalog.js";
import { Connection } from "./connection.js";
import { Lineages } from "./lineage.js";
import { RemoteControl } from "./remote.js";
import { acquireSocketStartupLock, prepareUnixSocket } from "./socket.js";
import { ccodexCommand, synthesizeTurn } from "./status.js";
import { StockClient, openStockSocket, startStockProcess, type StockProcess } from "./stock.js";
import { Titles } from "./titles.js";

type Handler = (connection: Connection, params: any) => Promise<unknown>;

interface PendingServerRequest {
  readonly threadId: string;
  readonly method: string;
  readonly params: unknown;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** Codex config keys the App writes with the picked model; kept out of config.toml while that model is Claude's. */
const CLAUDE_DEFAULT_KEYS = new Set(["model", "model_reasoning_effort", "service_tier"]);

/** Thread notifications stock broadcasts to every initialized connection. */
const GLOBAL_NOTIFICATIONS = new Set([
  "thread/started", "thread/status/changed", "thread/name/updated", "thread/archived", "thread/unarchived",
  "thread/deleted", "thread/closed",
]);

export class Gateway {
  public readonly connections = new Set<Connection>();
  public readonly handlers = new Map<string, Handler>();
  public readonly recorder: RpcRecorder;
  public readonly meta: Meta;
  /** Stock's sections by id (Claude rows name theirs from here); refreshed with each first list page. */
  public readonly sections = new Map<string, JsonObject>();
  public claude!: ClaudeThreads;
  public stock!: StockClient;
  public catalog!: Catalog;
  public lineages!: Lineages;
  public titles!: Titles;
  public remote!: RemoteControl;
  private stockProcess!: StockProcess;
  private readonly subscriptions = new Map<string, Set<Connection>>();
  private readonly serverRequests = new Map<string, PendingServerRequest>();
  private readonly internalTurns = new Map<string, { text: string; resolve: (text: string) => void; reject: (error: Error) => void }>();
  private nextServerRequest = 0;

  public constructor(
    public readonly config: Config,
    public readonly socketPath: string,
    public readonly logger: Logger,
  ) {
    this.recorder = new RpcRecorder(config);
    this.meta = new Meta(join(config.dataDir, "meta.json"));
  }

  public async start(stockArgs: readonly string[], remoteControl: boolean): Promise<void> {
    this.stockProcess = await startStockProcess(this.config, stockArgs, this.logger);
    this.stock = await StockClient.connect(this.stockProcess.socketPath, "ccodex-internal");
    this.stock.onFrame = (text) => this.internalFrame(text);
    this.claude = new ClaudeThreads(this.config, this, this.logger);
    this.catalog = new Catalog(this);
    this.lineages = new Lineages(this);
    this.titles = new Titles(this);
    this.remote = new RemoteControl(this.socketPath, this.logger, remoteControl);
    await this.claude.start();
    this.registerHandlers();
    await this.remote.start();
  }

  public connectionSocket(): string { return this.stockProcess.socketPath; }

  public async stop(): Promise<void> {
    await this.remote.stop();
    for (const request of this.serverRequests.values()) request.reject(new Error("Gateway shutting down."));
    await this.claude.close();
    this.stock.close();
    await this.stockProcess.stop();
  }

  // ---- subscriptions and fan-out for threads the gateway itself serves (Claude) ----

  public subscribe(threadId: string, connection: Connection): void {
    const set = this.subscriptions.get(threadId) ?? new Set();
    const fresh = !set.has(connection);
    set.add(connection);
    this.subscriptions.set(threadId, set);
    if (!fresh) return;
    for (const [id, request] of this.serverRequests) {
      if (request.threadId === threadId) connection.request(id, request.method, request.params);
    }
  }

  public unsubscribe(threadId: string, connection: Connection): void {
    this.subscriptions.get(threadId)?.delete(connection);
  }

  public subscribers(threadId: string): number {
    return this.subscriptions.get(threadId)?.size ?? 0;
  }

  public emit(threadId: string, method: string, params: unknown): void {
    if (GLOBAL_NOTIFICATIONS.has(method)) {
      this.broadcast(method, params);
      return;
    }
    const text = JSON.stringify({ method, params });
    for (const connection of this.subscriptions.get(threadId) ?? []) connection.send(text);
  }

  public broadcast(method: string, params: unknown): void {
    const text = JSON.stringify({ method, params });
    for (const connection of this.connections) connection.send(text);
  }

  /** Server→client request on a Claude thread: every subscriber sees it, the first answer wins. */
  public serverRequest<T = any>(threadId: string, method: string, params: unknown): Promise<T> {
    const id = `ccodex:${++this.nextServerRequest}`;
    return new Promise<T>((resolve, reject) => {
      this.serverRequests.set(id, { threadId, method, params, resolve: resolve as (value: unknown) => void, reject });
      for (const connection of this.subscriptions.get(threadId) ?? []) connection.request(id, method, params);
    });
  }

  public cancelServerRequests(threadId: string): void {
    for (const [id, request] of this.serverRequests) {
      if (request.threadId !== threadId) continue;
      this.serverRequests.delete(id);
      request.reject(new Error("Request cancelled."));
      this.emit(threadId, "serverRequest/resolved", { threadId, requestId: id });
    }
  }

  public resolveServerRequest(message: JsonObject): void {
    const request = this.serverRequests.get(message.id);
    if (!request) return;
    this.serverRequests.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message ?? "Client rejected the request."));
    else request.resolve(message.result);
    this.emit(request.threadId, "serverRequest/resolved", { threadId: request.threadId, requestId: message.id });
  }

  public detach(connection: Connection): void {
    this.connections.delete(connection);
    this.remote.detach(connection);
    for (const set of this.subscriptions.values()) set.delete(connection);
  }

  // ---- routing ----

  public isClaudeThread(threadId: string): boolean {
    const current = this.meta.current(threadId);
    return current ? current.provider === "claude" : this.claude.owns(threadId);
  }

  /** Handler for a request that carries a thread (or starts one); undefined = raw passthrough to stock. */
  public threadHandler(connection: Connection, method: string, params: JsonObject): Handler | undefined {
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (method === "thread/start") {
      if (!this.claude.isClaudeModel(params.model)) return undefined;
      connection.provider = "claude";
      return (conn, p) => this.claude.handle(conn, method, p);
    }
    if (!threadId) return undefined;
    // A row a client kept from a backend's announcement: gone, as stock says (Desktop then drops the row).
    if (this.lineages.isBackend(threadId)) {
      return async () => { throw new RpcFailure(-32600, `no rollout found for thread id ${threadId}`, undefined, true); };
    }
    if (method === "turn/start") {
      const command = ccodexCommand(params);
      if (command) return (conn, p) => synthesizeTurn(this, conn, p, command);
      if (params.turnTrigger === "thread_title" && this.config.renamePrompt) {
        return (conn, p) => this.titles.answerDesktopTitleTurn(conn, p);
      }
      this.titles.onTurnStart(threadId, params);
    }
    if (method === "thread/name/set" && this.config.renamePrompt) {
      return (conn, p) => this.titles.nameSet(conn, p);
    }
    return this.ownerHandler(connection, method, params);
  }

  /** The thread's owner: a switched thread's lineage, the Claude layer, or (undefined) stock. */
  private ownerHandler(connection: Connection, method: string, params: JsonObject): Handler | undefined {
    const threadId: string = params.threadId;
    if (this.meta.lineage(threadId) || this.lineages.switchRequested(method, params)) {
      return (conn, p) => this.lineages.handle(conn, method, p);
    }
    if (this.claude.owns(threadId)) {
      connection.provider = "claude";
      return (conn, p) => this.claude.handle(conn, method, p);
    }
    if (method === "turn/start" || method === "thread/resume") connection.provider = "codex";
    return undefined;
  }

  public threadRequest(connection: Connection, method: string, params: JsonObject): Promise<unknown> {
    const handler = this.ownerHandler(connection, method, params);
    return handler ? handler(connection, params) : connection.upstream.request(method, params);
  }

  /** Stock→client frame; undefined drops it. */
  public fromBackendFrame(connection: Connection, text: string): string | undefined {
    if (connection.provider === "claude" && text.startsWith("{\"method\":\"account/rateLimits/updated\"")) return undefined;
    // A new backend of a switched thread is announced by stock like any new thread; the public row stays.
    if (text.startsWith("{\"method\":\"thread/started\"")) {
      const thread = (JSON.parse(text) as JsonObject).params.thread;
      if (this.lineages.isBackend(thread.id)) return undefined;
      // CCodex's own (titles, switch summaries) or another client's ephemeral thread would show as a sidebar row.
      if (thread.ephemeral === true) return connection.ephemeralRequests.size ? text : undefined;
      if (this.lineages.holdAnnouncement(connection, thread.id, text)) return undefined;
    }
    if (text.startsWith("{\"method\":\"remoteControl/status/changed\"")) {
      this.remote.intercept(connection, (JSON.parse(text) as JsonObject).params);
      return undefined;
    }
    return text;
  }

  /** Runs one turn on an internal stock thread (titles, gpt summaries) and returns its final agent message. */
  public async internalTurn(threadId: string, text: string, extra: JsonObject = {}): Promise<string> {
    const done = new Promise<string>((resolve, reject) => this.internalTurns.set(threadId, { text: "", resolve, reject }));
    const timeout = setTimeout(() => this.finishInternalTurn(threadId, new Error("internal turn timed out")), 300_000);
    try {
      await this.stock.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }], ...extra });
      return await done;
    } catch (error) {
      this.internalTurns.delete(threadId);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private finishInternalTurn(threadId: string, result: string | Error): void {
    const turn = this.internalTurns.get(threadId);
    if (!turn) return;
    this.internalTurns.delete(threadId);
    if (typeof result === "string") turn.resolve(result);
    else turn.reject(result);
  }

  private internalFrame(text: string): void {
    const message = JSON.parse(text) as JsonObject;
    if (message.id !== undefined && message.method !== undefined) {
      // Internal ephemeral threads (titles, summaries) never ask for anything we would grant.
      void this.stock.send(JSON.stringify({ id: message.id, result: { decision: "decline" } })).catch(() => undefined);
      return;
    }
    const params = message.params ?? {};
    const turn = this.internalTurns.get(params.threadId);
    if (turn && message.method === "item/completed" && params.item?.type === "agentMessage") turn.text = params.item.text;
    if (turn && message.method === "turn/completed") {
      const status = params.turn?.status;
      this.finishInternalTurn(params.threadId, status === "completed"
        ? turn.text
        : new Error(params.turn?.error?.message ?? `internal turn ${status}`));
    }
    if (message.method === "thread/started") this.titles.observe(params.thread);
  }

  private registerHandlers(): void {
    const on = (method: string, handler: Handler) => this.handlers.set(method, handler);
    on("initialize", async (connection, params) => {
      connection.clientName = params?.clientInfo?.name;
      const result = await connection.upstream.request("initialize", params);
      if (connection.clientName === "codex-backend") {
        setImmediate(() => void this.catalog.announce(connection).catch((error: unknown) =>
          this.logger.warn("remote.catalog.announce-failed", { error: String(error) })));
      }
      return result;
    });
    on("thread/list", (connection, params) => this.catalog.list(connection, params));
    on("thread/search", (connection, params) => this.catalog.search(connection, params));
    on("thread/loaded/list", (connection, params) => this.catalog.loaded(connection, params));
    on("model/list", async (connection, params) => {
      const [stock, claude] = await Promise.all([
        connection.upstream.request("model/list", params),
        params?.cursor ? Promise.resolve([]) : this.claude.models().catch(() => []),
      ]);
      return { ...stock, data: [...stock.data, ...claude] };
    });
    on("skills/list", async (connection, params) => {
      const [stock, claude] = await Promise.all([
        connection.upstream.request("skills/list", params),
        this.claude.skills(params?.cwds ?? []).catch(() => new Map<string, unknown[]>()),
      ]);
      return {
        ...stock,
        data: stock.data.map((entry: JsonObject) => ({ ...entry, skills: [...entry.skills, ...claude.get(entry.cwd) ?? []] })),
      };
    });
    on("account/rateLimits/read", (connection, params) => connection.provider === "claude"
      ? this.claude.rateLimits()
      : connection.upstream.request("account/rateLimits/read", params));
    on("remoteControl/enable", (_connection, params) => this.remote.enable(params?.ephemeral === true));
    on("remoteControl/disable", (_connection, params) => this.remote.disable(params?.ephemeral === true));
    on("remoteControl/status/read", async (connection, params) =>
      this.remote.current() ?? connection.upstream.request("remoteControl/status/read", params));
    for (const method of ["remoteControl/pairing/start", "remoteControl/pairing/status"]) {
      on(method, (connection, params) => this.remote.pairing(method, params, connection.clientName));
    }
    on("thread/section/move", (connection, params) => this.catalog.moveInSection(connection, params));
    // The App saves the picked model, effort and speed as Codex's defaults. With a Claude model they must not reach
    // config.toml (plain `codex` and every stock thread without explicit settings would use them): they stay in meta
    // and show in config/read.
    for (const method of ["config/batchWrite", "config/value/write"]) {
      on(method, (connection, params) => {
        const edits: JsonObject[] = method === "config/batchWrite" ? params.edits : [params];
        const model = edits.find((edit) => edit.keyPath === "model");
        const current = this.meta.claudeDefaults;
        const claude = model ? this.claude.isClaudeModel(model.value) : Boolean(current);
        const kept = claude ? edits.filter((edit) => CLAUDE_DEFAULT_KEYS.has(edit.keyPath)) : [];
        if (model && !claude && current) this.meta.setClaudeDefaults(null);
        if (!kept.length) return connection.upstream.request(method, params);
        this.meta.setClaudeDefaults({ ...(model ? {} : current), ...Object.fromEntries(kept.map((edit) => [edit.keyPath, edit.value])) });
        const { keyPath: _keyPath, mergeStrategy: _mergeStrategy, value: _value, ...rest } = params;
        return connection.upstream.request("config/batchWrite", { ...rest, edits: edits.filter((edit) => !kept.includes(edit)) });
      });
    }
    on("config/read", async (connection, params) => {
      const result = await connection.upstream.request("config/read", params);
      return { ...result, config: { ...result.config, ...this.meta.claudeDefaults } };
    });
  }
}

export interface GatewayServer {
  stop(): Promise<void>;
}

export async function startGateway(
  config: Config,
  socketPath: string,
  stockArgs: readonly string[],
  logger: Logger,
  remoteControl: boolean,
): Promise<GatewayServer> {
  const release = await acquireSocketStartupLock(socketPath);
  try {
    await prepareUnixSocket(socketPath);
    const gateway = new Gateway(config, socketPath, logger);
    await gateway.start(stockArgs, remoteControl);
    const webSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    const server = createServer((request, response) => {
      if (request.url === "/readyz" || (request.url === "/healthz" && !request.headers.origin)) {
        response.writeHead(200).end("ok\n");
        return;
      }
      response.writeHead(request.headers.origin ? 403 : 404).end();
    });
    server.on("upgrade", (request, socket: Socket, head) => {
      if (request.url !== "/rpc") {
        socket.destroy();
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (client) => {
        const upstream = new StockClient(openStockSocket(gateway.connectionSocket()));
        gateway.connections.add(new Connection(gateway, client, upstream));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    chmodSync(socketPath, 0o600);
    logger.info("gateway.started", { socketPath, codex: config.codex });
    return {
      async stop() {
        for (const client of webSockets.clients) client.close(1001, "Gateway shutting down");
        const force = setTimeout(() => { for (const client of webSockets.clients) client.terminate(); }, 1_000);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        clearTimeout(force);
        await gateway.stop();
        rmSync(socketPath, { force: true });
        logger.info("gateway.stopped", { socketPath });
      },
    };
  } finally {
    release();
  }
}
