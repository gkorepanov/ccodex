import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { HybridConfig } from "../../src/config/config.js";
import { runStdioFrontend } from "../../src/desktop/stdioFrontend.js";

const roots: string[] = [];
const servers: Server[] = [];
const webSockets: WebSocketServer[] = [];

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
  for (const webSocket of webSockets.splice(0)) {
    for (const client of webSocket.clients) client.terminate();
    await new Promise<void>((resolve) => webSocket.close(() => resolve()));
  }
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function socketPath(): string {
  const root = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "ccodex-stdio-"));
  roots.push(root);
  return join(root, "gw.sock");
}

async function startFakeGateway(
  path: string,
  respond = true,
  initializeError = false,
): Promise<{ received: string[]; close: () => Promise<void> }> {
  if (existsSync(path)) rmSync(path, { force: true });
  const received: string[] = [];
  const sockets = new WebSocketServer({ noServer: true });
  const server = createServer();
  webSockets.push(sockets);
  servers.push(server);
  server.on("upgrade", (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (client) => {
      client.on("message", (bytes) => {
        const line = bytes.toString();
        received.push(line);
        const message = JSON.parse(line) as { id?: string | number; method?: string };
        if (message.method === "initialize") {
          client.send(JSON.stringify(initializeError
            ? { id: message.id, error: { code: -32600, message: "incompatible client" } }
            : { id: message.id, result: {} }));
        } else if (respond && message.id !== undefined) {
          client.send(JSON.stringify({ id: message.id, result: { echoed: message.method } }));
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  return {
    received,
    close: async () => {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function collector(highWaterMark = 16_384): { output: Writable; text: () => string } {
  const chunks: string[] = [];
  return {
    text: () => chunks.join(""),
    output: new Writable({
      highWaterMark,
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    }),
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

describe("desktop stdio frontend", () => {
  it("relays newline-delimited JSON in both directions and honors output backpressure", async () => {
    const path = socketPath();
    const gateway = await startFakeGateway(path);
    const input = new PassThrough();
    const { output, text } = collector(1);
    const done = runStdioFrontend(config, path, {
      input, output, kick: async () => undefined, initialConnectDeadlineMs: 5_000, retryDelayMs: 20,
    });

    input.write('{"id":1,"method":"initialize"}\n');
    await waitFor(() => text().includes('{"id":1,"result":{}}\n'));
    input.write('{"id":2,"method":"model/list"}\n');
    await waitFor(() => text().includes('{"id":2,"result":{"echoed":"model/list"}}\n'));
    expect(gateway.received.map((line) => JSON.parse(line))).toEqual([
      { id: 1, method: "initialize" },
      { id: 2, method: "model/list" },
    ]);

    input.end();
    expect(await done).toBe(0);
  });

  it("lazily starts a cold gateway without losing the initialize request", async () => {
    const path = socketPath();
    let gateway: Awaited<ReturnType<typeof startFakeGateway>> | undefined;
    const input = new PassThrough();
    const { output, text } = collector();
    const done = runStdioFrontend(config, path, {
      input,
      output,
      kick: async () => { gateway = await startFakeGateway(path); },
      initialConnectDeadlineMs: 5_000,
      retryDelayMs: 20,
    });

    input.write('{"id":"init","method":"initialize"}\n');
    await waitFor(() => text().includes('{"id":"init","result":{}}\n'));
    expect(gateway?.received).toHaveLength(1);
    input.end();
    expect(await done).toBe(0);
  });

  it("reconnects, replays only initialize, and fails an in-flight request explicitly", async () => {
    const path = socketPath();
    const first = await startFakeGateway(path, false);
    let second: Awaited<ReturnType<typeof startFakeGateway>> | undefined;
    const input = new PassThrough();
    const { output, text } = collector();
    const done = runStdioFrontend(config, path, {
      input,
      output,
      kick: async () => { second ??= await startFakeGateway(path); },
      initialConnectDeadlineMs: 5_000,
      retryDelayMs: 20,
    });

    input.write('{"id":1,"method":"initialize"}\n');
    await waitFor(() => text().includes('{"id":1,"result":{}}\n'));
    input.write('{"id":7,"method":"turn/start"}\n');
    await waitFor(() => first.received.some((line) => JSON.parse(line).id === 7));
    await first.close();

    await waitFor(() => text().includes('"code":-32001'));
    await waitFor(() => Boolean(second?.received.length));
    expect(second!.received.map((line) => JSON.parse(line))).toEqual([
      { id: 1, method: "initialize" },
    ]);
    expect(text().match(/"id":1,"result":\{\}/g)).toHaveLength(1);

    input.write('{"id":8,"method":"thread/list"}\n');
    await waitFor(() => text().includes('{"id":8,"result":{"echoed":"thread/list"}}\n'));
    expect(second!.received.some((line) => JSON.parse(line).id === 8)).toBe(true);
    input.end();
    expect(await done).toBe(0);
  });

  it("exits non-zero after the initial deadline when the gateway never starts", async () => {
    const path = socketPath();
    const input = new PassThrough();
    const { output } = collector();
    const code = await runStdioFrontend(config, path, {
      input,
      output,
      kick: async () => undefined,
      initialConnectDeadlineMs: 150,
      retryDelayMs: 20,
    });
    expect(code).toBe(1);
  });

  it("forwards an initialize rejection once and exits instead of reconnecting forever", async () => {
    const path = socketPath();
    const gateway = await startFakeGateway(path, true, true);
    const input = new PassThrough();
    const { output, text } = collector();
    const done = runStdioFrontend(config, path, {
      input, output, kick: async () => undefined, initialConnectDeadlineMs: 5_000, retryDelayMs: 20,
    });
    input.write('{"id":1,"method":"initialize"}\n');
    expect(await done).toBe(1);
    expect(text().match(/incompatible client/g)).toHaveLength(1);
    expect(gateway.received).toHaveLength(1);
  });
});
