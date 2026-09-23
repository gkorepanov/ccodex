import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import WebSocket from "ws";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import { RpcFailure, type JsonObject } from "../protocol/codex.js";

export interface StockProcess {
  readonly socketPath: string;
  stop(): Promise<void>;
}

function processTree(root: number): number[] {
  const output = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" }).stdout;
  const children = new Map<number, number[]>();
  for (const line of output.trim().split("\n")) {
    const [pid, parent] = line.trim().split(/\s+/u).map(Number);
    children.set(parent!, [...children.get(parent!) ?? [], pid!]);
  }
  const tree = [root];
  for (let index = 0; index < tree.length; index += 1) tree.push(...children.get(tree[index]!) ?? []);
  return tree.reverse();
}

/** Spawns the installed `codex app-server` on a private unix socket. Its exit takes the gateway down. */
export async function startStockProcess(config: Config, args: readonly string[], logger: Logger): Promise<StockProcess> {
  const runDir = join(config.dataDir, "run", String(process.pid));
  const socketPath = join(runDir, "stock.sock");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });
  const child: ChildProcess = spawn(config.codex, [...args, "--listen", `unix://${socketPath}`], {
    env: { ...process.env, CODEX_CLI_PATH: undefined, CCODEX_SHIM_ACTIVE: undefined, CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stopping = false;
  child.stderr?.on("data", (data: Buffer) => logger.debug("stock.stderr", { output: data.toString("utf8").trimEnd() }));
  child.once("error", (error) => logger.error("stock.spawn.error", { error: error.message }));
  child.once("exit", (code, signal) => {
    if (stopping) return;
    logger.error("stock.exited", { code, signal });
    process.kill(process.pid, "SIGTERM");
  });
  const signal = (name: NodeJS.Signals) => {
    if (!child.pid) return;
    for (const pid of processTree(child.pid)) {
      try { process.kill(pid, name); } catch { /* already exited */ }
    }
  };
  const deadline = Date.now() + 15_000;
  while (!existsSync(socketPath)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      stopping = true;
      signal("SIGKILL");
      throw new Error(`Stock codex app-server did not start (${config.codex}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  logger.info("stock.started", { pid: child.pid, socketPath, codex: config.codex });
  return {
    socketPath,
    async stop() {
      stopping = true;
      if (child.exitCode === null) {
        signal("SIGTERM");
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 3_000)).then(() => signal("SIGKILL")),
        ]);
      }
      rmSync(runDir, { recursive: true, force: true });
    },
  };
}

export function openStockSocket(socketPath: string): WebSocket {
  return new WebSocket("ws://codex-app-server/rpc", {
    createConnection: () => createConnection(socketPath),
    perMessageDeflate: false,
    maxPayload: 256 * 1024 * 1024,
  });
}

interface Pending {
  readonly resolve: (value: any) => void;
  readonly reject: (error: Error) => void;
}

const OWN_ID = "\"ccodex-up:";

/**
 * One websocket to stock. Raw frames go to `onFrame` untouched; responses to requests made through
 * `request()` (string ids `ccodex-up:<n>`) are consumed here.
 */
export class StockClient {
  private readonly pending = new Map<string, Pending>();
  private readonly opened: Promise<void>;
  private nextId = 0;
  private closedError?: Error;
  public onFrame: (text: string) => void = () => undefined;
  public onClose: () => void = () => undefined;

  public constructor(public readonly socket: WebSocket) {
    this.opened = new Promise((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    this.opened.catch(() => undefined);
    socket.on("message", (data) => this.receive(data.toString()));
    socket.on("error", () => undefined);
    socket.once("close", () => {
      this.closedError = new Error("Stock app-server connection closed.");
      for (const pending of this.pending.values()) pending.reject(this.closedError);
      this.pending.clear();
      this.onClose();
    });
  }

  public static async connect(socketPath: string, clientName = "ccodex"): Promise<StockClient> {
    const client = new StockClient(openStockSocket(socketPath));
    await client.request("initialize", {
      clientInfo: { name: clientName, title: "CCodex", version: "0.5.0" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    return client;
  }

  public async send(text: string): Promise<void> {
    await this.opened;
    if (this.closedError) throw this.closedError;
    await new Promise<void>((resolve, reject) => this.socket.send(text, (error) => error ? reject(error) : resolve()));
  }

  public notify(method: string, params?: unknown): void {
    void this.send(JSON.stringify(params === undefined ? { method } : { method, params })).catch(() => undefined);
  }

  public request<T = any>(method: string, params?: unknown): Promise<T> {
    const id = `ccodex-up:${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(JSON.stringify({ id, method, params })).catch((error: Error) => {
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  public close(): void {
    this.socket.close();
  }

  private receive(text: string): void {
    if (text.includes(OWN_ID)) {
      const message = JSON.parse(text) as JsonObject;
      const pending = message.method === undefined && typeof message.id === "string" ? this.pending.get(message.id) : undefined;
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) pending.reject(new RpcFailure(message.error.code ?? -32603, message.error.message, message.error.data));
        else pending.resolve(message.result);
        return;
      }
    }
    this.onFrame(text);
  }
}
