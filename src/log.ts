import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

type Level = Config["logLevel"];
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const secretKey = /authorization|api.?key|secret|password|cookie|^token$|access.?token|refresh.?token|id.?token/i;

function redact(value: unknown, key = ""): unknown {
  if (secretKey.test(key)) return value == null ? value : "<REDACTED>";
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([child, item]) => [child, redact(item, child)]));
  }
  return value;
}

function appendBounded(path: string, line: string, maxBytes: number): void {
  if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > maxBytes) {
    if (existsSync(`${path}.1`)) unlinkSync(`${path}.1`);
    renameSync(path, `${path}.1`);
  }
  appendFileSync(path, line, { mode: 0o600 });
}

export class Logger {
  public constructor(private readonly minimum: Level = "info") {}

  public debug(message: string, fields: Record<string, unknown> = {}): void { this.write("debug", message, fields); }
  public info(message: string, fields: Record<string, unknown> = {}): void { this.write("info", message, fields); }
  public warn(message: string, fields: Record<string, unknown> = {}): void { this.write("warn", message, fields); }
  public error(message: string, fields: Record<string, unknown> = {}): void { this.write("error", message, fields); }

  private write(level: Level, message: string, fields: Record<string, unknown>): void {
    if (order[level] < order[this.minimum]) return;
    process.stderr.write(`${JSON.stringify(redact({ ts: new Date().toISOString(), level, message, ...fields }))}\n`);
  }
}

export type RpcDirection = "client_to_gateway" | "gateway_to_client";

/** Bounded `rpc.jsonl` capture of every frame between clients and the gateway (two rotating halves). */
export class RpcRecorder {
  private readonly path: string;
  private sequence = 0;
  private failed = false;

  public constructor(private readonly config: Pick<Config, "dataDir" | "rpcCapture" | "rpcCaptureMaxBytes">) {
    this.path = join(config.dataDir, "rpc.jsonl");
    if (config.rpcCapture) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  }

  public lifecycle(event: string, fields: Record<string, unknown> = {}): void {
    this.write({ type: "lifecycle", event, ...fields });
  }

  public connection(event: "opened" | "closed", connectionId: string, fields: Record<string, unknown> = {}): void {
    this.write({ type: "connection", event, connectionId, ...fields });
  }

  public frame(connectionId: string, direction: RpcDirection, text: string): void {
    if (!this.config.rpcCapture || this.failed) return;
    let message: unknown;
    try { message = JSON.parse(text); } catch { message = { encoding: "utf8", data: text }; }
    this.write({ type: "frame", connectionId, direction, binary: false, message });
  }

  private write(fields: Record<string, unknown>): void {
    if (!this.config.rpcCapture || this.failed) return;
    const line = `${JSON.stringify(redact({ ts: new Date().toISOString(), sequence: ++this.sequence, ...fields }))}\n`;
    try {
      appendBounded(this.path, line, Math.floor(this.config.rpcCaptureMaxBytes / 2));
    } catch (error) {
      this.failed = true;
      process.stderr.write(`ccodex: RPC capture disabled after write failure: ${String(error)}\n`);
    }
  }
}
