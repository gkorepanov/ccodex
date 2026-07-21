import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invalidParams } from "./errors.js";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
}

export function queryFingerprint(value: unknown): string {
  return createHmac("sha256", "codex-hybrid-query-v1").update(JSON.stringify(stable(value))).digest("base64url").slice(0, 16);
}

export class CursorCodec {
  public constructor(private readonly key: Buffer) {}

  public static load(dataDir: string): CursorCodec {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, "cursor.key");
    try {
      return new CursorCodec(readFileSync(path));
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const key = randomBytes(32);
    try {
      writeFileSync(path, key, { flag: "wx", mode: 0o600 });
      return new CursorCodec(key);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      return new CursorCodec(readFileSync(path));
    }
  }

  public encode(scope: string, payload: unknown): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `hyb:${scope}:${body}.${this.sign(scope, body)}`;
  }

  public decode<T>(scope: string, value: string | null | undefined): T | undefined {
    if (!value) return undefined;
    const prefix = `hyb:${scope}:`;
    if (!value.startsWith(prefix)) throw invalidParams(`Invalid hybrid ${scope} cursor.`);
    const encoded = value.slice(prefix.length);
    const separator = encoded.lastIndexOf(".");
    if (separator < 1) throw invalidParams(`Invalid hybrid ${scope} cursor.`);
    const body = encoded.slice(0, separator);
    const signature = encoded.slice(separator + 1);
    const expected = Buffer.from(this.sign(scope, body));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalidParams(`Invalid hybrid ${scope} cursor signature.`);
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    } catch {
      throw invalidParams(`Invalid hybrid ${scope} cursor payload.`);
    }
  }

  private sign(scope: string, body: string): string {
    return createHmac("sha256", this.key).update(`${scope}\0${body}`).digest("base64url");
  }
}
