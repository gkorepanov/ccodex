import {
  appendFileSync, chmodSync, existsSync, renameSync, statSync, unlinkSync,
} from "node:fs";
import type { HybridConfig } from "../config/config.js";

type Level = HybridConfig["logLevel"];

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const secretKey = /authorization|api.?key|secret|password|cookie|^token$|access.?token|refresh.?token|id.?token/i;
const contentKey = /^(output|stdout|stderr|prompt|input|content|toolOutput|fileContent|env)$/i;

export interface LoggerOptions {
  readonly includeContent?: boolean;
  readonly capturePath?: string;
  readonly maxBytes?: number;
}

function sanitize(value: unknown, includeContent: boolean, key = ""): unknown {
  if (secretKey.test(key)) return value == null ? value : "<REDACTED>";
  if (!includeContent && contentKey.test(key)) return value == null ? value : "<CONTENT_REDACTED>";
  if (typeof value === "string") return value.length > 2_048 ? `${value.slice(0, 2_048)}<TRUNCATED>` : value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, includeContent, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, sanitize(item, includeContent, childKey)]));
  }
  return value;
}

export class Logger {
  public constructor(private readonly minimum: Level, private readonly options: LoggerOptions = {}) {
    if (options.capturePath) {
      process.stderr.write(`codex-hybrid: bounded debug capture enabled at ${options.capturePath}; content remains redacted unless log_prompts=true.\n`);
    }
  }

  public debug(message: string, fields: Record<string, unknown> = {}): void {
    this.write("debug", message, fields);
  }

  public info(message: string, fields: Record<string, unknown> = {}): void {
    this.write("info", message, fields);
  }

  public warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", message, fields);
  }

  public error(message: string, fields: Record<string, unknown> = {}): void {
    this.write("error", message, fields);
  }

  private write(level: Level, message: string, fields: Record<string, unknown>): void {
    if (order[level] < order[this.minimum]) return;
    const line = `${JSON.stringify(sanitize({ ts: new Date().toISOString(), level, message, ...fields }, this.options.includeContent === true))}\n`;
    process.stderr.write(line);
    if (this.options.capturePath) this.capture(line);
  }

  private capture(line: string): void {
    const path = this.options.capturePath!;
    const maxBytes = this.options.maxBytes ?? 1_048_576;
    if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > maxBytes) {
      const previous = `${path}.1`;
      if (existsSync(previous)) unlinkSync(previous);
      renameSync(path, previous);
    }
    appendFileSync(path, line, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
}
