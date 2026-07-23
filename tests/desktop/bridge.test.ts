import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { HybridConfig } from "../../src/config/config.js";
import { runDesktopBridge } from "../../src/desktop/bridge.js";

const roots: string[] = [];
const servers: Server[] = [];

const config: HybridConfig = {
  realCodex: "/usr/bin/codex",
  claudeBinary: "/usr/bin/claude",
  dataDir: "/tmp/hybrid",
  publicSocket: "/tmp/hybrid.sock",
  modelPrefix: "claude:",
  idleTimeoutSeconds: 900,
  modelCacheSeconds: 300,
  logLevel: "warn",
  logPrompts: false,
  debugCapture: false,
  debugLogMaxBytes: 1_048_576,
};

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function socketPath(): string {
  const root = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "ccodex-bridge-"));
  roots.push(root);
  return join(root, "gw.sock");
}

async function startFakeGateway(path: string): Promise<{ received: string[] }> {
  const received: string[] = [];
  const webSockets = new WebSocketServer({ noServer: true });
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (client) => {
      client.on("message", (bytes) => {
        const line = bytes.toString();
        received.push(line);
        client.send(JSON.stringify({ echo: JSON.parse(line) }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  servers.push(server);
  return { received };
}

function collector(): { output: Writable; text: () => string } {
  const chunks: string[] = [];
  return {
    text: () => chunks.join(""),
    output: new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } }),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met before timeout");
}

describe("desktop stdio<->socket bridge", () => {
  it("relays newline-delimited JSON in both directions and exits when stdin closes", async () => {
    const path = socketPath();
    const gateway = await startFakeGateway(path);
    const input = new PassThrough();
    const { output, text } = collector();
    const done = runDesktopBridge(config, path, {
      input, output, kick: async () => undefined, connectDeadlineMs: 5_000, retryDelayMs: 50,
    });

    input.write('{"id":1,"method":"initialize"}\n');
    await waitFor(() => gateway.received.length === 1);
    expect(JSON.parse(gateway.received[0]!)).toEqual({ id: 1, method: "initialize" });
    await waitFor(() => text().includes('{"echo":{"id":1,"method":"initialize"}}\n'));

    input.end();
    expect(await done).toBe(0);
  }, 10_000);

  it("lazily starts the gateway and retries until it becomes reachable", async () => {
    const path = socketPath();
    let kicked = false;
    const input = new PassThrough();
    const { output, text } = collector();
    const done = runDesktopBridge(config, path, {
      input,
      output,
      kick: async () => { await startFakeGateway(path); kicked = true; },
      connectDeadlineMs: 5_000,
      retryDelayMs: 50,
    });

    input.write('{"id":7}\n');
    await waitFor(() => text().includes('{"echo":{"id":7}}\n'));
    expect(kicked).toBe(true);

    input.end();
    expect(await done).toBe(0);
  }, 10_000);

  it("exits non-zero after the deadline when the gateway never comes up", async () => {
    const path = socketPath();
    const { output } = collector();
    const code = await runDesktopBridge(config, path, {
      input: new PassThrough(),
      output,
      kick: async () => undefined,
      connectDeadlineMs: 250,
      retryDelayMs: 40,
    });
    expect(code).toBe(1);
  }, 10_000);
});
