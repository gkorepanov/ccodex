import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { Config } from "../../src/config.js";
import { startGateway, type GatewayServer } from "../../src/gateway/server.js";
import { Logger } from "../../src/log.js";
import { testConfig } from "../fixtures/config.js";

export const FAKE_STOCK = fileURLToPath(new URL("../fixtures/fakeStock.mjs", import.meta.url));

type Message = Record<string, any>;

/** A JSON-RPC client over the gateway socket, like Desktop's stdio frontend. */
export class Client {
  public readonly messages: Message[] = [];
  public onRequest: (message: Message) => unknown = () => ({ decision: "accept" });
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Message;
      this.messages.push(message);
      if (message.method !== undefined && message.id !== undefined) {
        void Promise.resolve(this.onRequest(message)).then((result) => this.socket.send(JSON.stringify({ id: message.id, result })));
        return;
      }
      if (message.method !== undefined) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else pending?.resolve(message.result);
    });
  }

  public static async connect(socketPath: string, name = "codex_desktop"): Promise<Client> {
    const socket = new WebSocket("ws://ccodex/rpc", { createConnection: () => createConnection(socketPath), perMessageDeflate: false });
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const client = new Client(socket);
    await client.request("initialize", { clientInfo: { name, title: "Test", version: "1" }, capabilities: { experimentalApi: true } });
    client.socket.send(JSON.stringify({ method: "initialized" }));
    return client;
  }

  public request<T = any>(method: string, params: unknown = {}): Promise<T> {
    const id = ++this.nextId;
    return this.raw(JSON.stringify({ id, method, params }), id);
  }

  public raw<T = any>(text: string, id: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(text);
    });
  }

  public notifications(method: string, threadId?: string): Message[] {
    return this.messages.filter((message) => message.method === method && message.id === undefined
      && (threadId === undefined || message.params?.threadId === threadId || message.params?.thread?.id === threadId));
  }

  public async waitFor(method: string, predicate: (params: Message) => boolean = () => true, timeoutMs = 10_000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find((message) => message.method === method && message.id === undefined && predicate(message.params));
      if (found) return found.params;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${method}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Starts a turn and waits for its completion; returns the `turn/completed` params. */
  public async turn(threadId: string, text: string, extra: Message = {}): Promise<Message> {
    const before = this.messages.length;
    await this.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }], ...extra });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const done = this.messages.slice(before).filter((message) => message.method === "turn/completed" && message.params.threadId === threadId);
      const started = this.messages.slice(before).filter((message) => message.method === "turn/started" && message.params.threadId === threadId);
      if (done.length && done.length >= started.length) return done.at(-1)!.params;
      if (Date.now() > deadline) throw new Error(`turn on ${threadId} did not complete`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  public close(): void {
    this.socket.close();
  }
}

export interface TestGateway {
  readonly root: string;
  readonly config: Config;
  readonly server: GatewayServer;
  connect(name?: string): Promise<Client>;
  stop(): Promise<void>;
}

export async function startTestGateway(overrides: Partial<Config> = {}): Promise<TestGateway> {
  const root = mkdtempSync(join(tmpdir(), "ccodex-gw-"));
  const config = testConfig({
    codex: FAKE_STOCK,
    claudeHome: process.env.CLAUDE_CONFIG_DIR!,
    productHome: root,
    dataDir: join(root, "state"),
    publicSocket: join(root, "gateway.sock"),
    ...overrides,
  });
  const server = await startGateway(config, config.publicSocket, ["app-server"], new Logger("error"), false);
  const clients: Client[] = [];
  return {
    root, config, server,
    async connect(name) {
      const client = await Client.connect(config.publicSocket, name);
      clients.push(client);
      return client;
    },
    async stop() {
      for (const client of clients) client.close();
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
