import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HybridConfig } from "../../src/config/config.js";
import { RpcRecorder } from "../../src/observability/rpcRecorder.js";

const directories: string[] = [];

function config(dataDir: string, includeContent: boolean): HybridConfig {
  return {
    realCodex: "/bin/false", claudeBinary: "/bin/false", dataDir, publicSocket: join(dataDir, "gateway.sock"),
    modelPrefix: "claude:", idleTimeoutSeconds: 900, modelCacheSeconds: 300, logLevel: "error",
    logPrompts: false, debugCapture: false, debugLogMaxBytes: 1_048_576,
    rpcCapture: true, rpcCaptureIncludeContent: includeContent, rpcCaptureMaxBytes: 1_048_576,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("RpcRecorder", () => {
  it("records ordered bidirectional frames with content and secret-key redaction", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-rpc-recorder-"));
    directories.push(directory);
    const recorder = new RpcRecorder(config(directory, true));
    recorder.connection("opened", "connection-1");
    recorder.frame("connection-1", "client_to_gateway", JSON.stringify({
      id: 1, method: "turn/start", params: { input: [{ type: "text", text: "scenario prompt" }], authorization: "Bearer secret" },
    }), false);
    recorder.frame("connection-1", "gateway_to_client", JSON.stringify({ id: 1, result: { ok: true } }), false);
    recorder.connection("closed", "connection-1", { code: 1000 });

    const path = join(directory, "rpc.jsonl");
    const records = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(records[2].message.params.input[0].text).toBe("scenario prompt");
    expect(records[2].message.params.authorization).toBe("<REDACTED>");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("redacts content unless full-content capture is explicit", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-rpc-redacted-"));
    directories.push(directory);
    const recorder = new RpcRecorder(config(directory, false));
    recorder.frame("connection-1", "client_to_gateway", JSON.stringify({ params: { input: ["private"] } }), false);
    const capture = readFileSync(join(directory, "rpc.jsonl"), "utf8");
    expect(capture).toContain("<CONTENT_REDACTED>");
    expect(capture).not.toContain("private");
  });

  it("treats max bytes as a shared two-segment rolling budget", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-rpc-rolling-"));
    directories.push(directory);
    const recorder = new RpcRecorder({ ...config(directory, true), rpcCaptureMaxBytes: 2_048 });
    for (let index = 0; index < 40; index += 1) {
      recorder.frame("connection-1", "client_to_gateway", JSON.stringify({ index, content: "x".repeat(100) }), false);
    }
    const current = join(directory, "rpc.jsonl");
    const previous = `${current}.1`;
    expect(existsSync(previous)).toBe(true);
    expect(statSync(current).size).toBeLessThanOrEqual(1_024);
    expect(statSync(previous).size).toBeLessThanOrEqual(1_024);
    expect(statSync(current).size + statSync(previous).size).toBeLessThanOrEqual(2_048);
  });
});
