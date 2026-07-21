import {
  appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type WebSocket from "ws";
import type { HybridConfig } from "../config/config.js";

export type RpcDirection = "client_to_gateway" | "gateway_to_client";

const secretKey = /authorization|api.?key|secret|password|cookie|^token$|access.?token|refresh.?token|id.?token/i;
const contentKey = /^(output|stdout|stderr|prompt|input|content|toolOutput|fileContent|env)$/i;

function sanitize(value: unknown, includeContent: boolean, key = ""): unknown {
  if (secretKey.test(key)) return value == null ? value : "<REDACTED>";
  if (!includeContent && contentKey.test(key)) return value == null ? value : "<CONTENT_REDACTED>";
  if (Array.isArray(value)) return value.map((item) => sanitize(item, includeContent, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [
      childKey, sanitize(item, includeContent, childKey),
    ]));
  }
  return value;
}

function rawBytes(data: WebSocket.RawData | string): Buffer {
  if (typeof data === "string") return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as Uint8Array);
}

function framePayload(data: WebSocket.RawData | string, isBinary: boolean): unknown {
  const bytes = rawBytes(data);
  if (isBinary) return { encoding: "base64", data: bytes.toString("base64") };
  const text = bytes.toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { encoding: "utf8", data: text };
  }
}

export class RpcRecorder {
  private readonly enabled: boolean;
  private readonly includeContent: boolean;
  private readonly totalMaxBytes: number;
  private readonly segmentMaxBytes: number;
  private readonly path: string;
  private sequence = 0;
  private failed = false;

  public constructor(config: HybridConfig) {
    this.enabled = config.rpcCapture !== false;
    this.includeContent = config.rpcCaptureIncludeContent !== false;
    this.totalMaxBytes = config.rpcCaptureMaxBytes ?? 1_073_741_824;
    this.segmentMaxBytes = Math.max(1, Math.floor(this.totalMaxBytes / 2));
    this.path = join(config.dataDir, "rpc.jsonl");
    if (!this.enabled) return;
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    process.stderr.write(
      `codex-hybrid: bounded RPC capture enabled at ${this.path}; content=${this.includeContent ? "included" : "redacted"}; totalBudget=${this.totalMaxBytes}.\n`,
    );
    this.lifecycle("recorder.started", { pid: process.pid });
  }

  public lifecycle(event: string, fields: Record<string, unknown> = {}): void {
    this.write({ type: "lifecycle", event, ...fields });
  }

  public connection(event: "opened" | "closed", connectionId: string, fields: Record<string, unknown> = {}): void {
    this.write({ type: "connection", event, connectionId, ...fields });
  }

  public frame(
    connectionId: string,
    direction: RpcDirection,
    data: WebSocket.RawData | string,
    isBinary: boolean,
  ): void {
    this.write({
      type: "frame",
      connectionId,
      direction,
      binary: isBinary,
      message: framePayload(data, isBinary),
    });
  }

  private write(fields: Record<string, unknown>): void {
    if (!this.enabled || this.failed) return;
    const record = sanitize({
      ts: new Date().toISOString(),
      sequence: ++this.sequence,
      ...fields,
    }, this.includeContent);
    const line = `${JSON.stringify(record)}\n`;
    try {
      if (existsSync(this.path) && statSync(this.path).size + Buffer.byteLength(line) > this.segmentMaxBytes) {
        const previous = `${this.path}.1`;
        if (existsSync(previous)) unlinkSync(previous);
        renameSync(this.path, previous);
      }
      appendFileSync(this.path, line, { mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch (error) {
      this.failed = true;
      process.stderr.write(`codex-hybrid: RPC capture disabled after write failure: ${String(error)}\n`);
    }
  }
}
