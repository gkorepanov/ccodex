import { createConnection } from "node:net";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Writable } from "node:stream";
import WebSocket from "ws";
import type { HybridConfig } from "../config/config.js";
import { runDaemonCommand } from "../daemon/daemon.js";

const INITIAL_CONNECT_DEADLINE_MS = 20_000;
const RETRY_DELAY_MS = 200;
const INPUT_HIGH_WATER = 256;
const INPUT_LOW_WATER = 64;
const OUTPUT_HIGH_WATER = 256;
const OUTPUT_LOW_WATER = 64;

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

type RpcId = string | number;

interface RpcEnvelope {
  readonly id?: RpcId;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface StdioFrontendDeps {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly kick?: (config: HybridConfig) => Promise<void>;
  readonly initialConnectDeadlineMs?: number;
  readonly retryDelayMs?: number;
}

function parseEnvelope(line: string): RpcEnvelope | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? value as RpcEnvelope : undefined;
  } catch {
    return undefined;
  }
}

function requestKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

function openSocket(socketPath: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket("ws://ccodex/rpc", {
      createConnection: () => createConnection(socketPath),
      perMessageDeflate: false,
      maxPayload: 64 * 1024 * 1024,
    });
    const onOpen = () => {
      socket.off("error", onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      socket.off("open", onOpen);
      socket.terminate();
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function send(socket: WebSocket, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(line, (error) => error ? reject(error) : resolve());
  });
}

async function defaultKick(config: HybridConfig): Promise<void> {
  try {
    await runDaemonCommand(config, { command: "start", remoteControl: false }, process.argv[1] ?? process.execPath);
  } catch (error) {
    process.stderr.write(`ccodex stdio frontend: gateway autostart failed: ${String(error)}\n`);
  }
}

class StdioFrontend {
  private readonly reader: ReadlineInterface;
  private readonly output: Writable;
  private readonly inputLines: string[] = [];
  private readonly outputLines: string[] = [];
  private readonly pending = new Map<string, RpcId>();
  private readonly serverRequests = new Set<string>();
  private readonly abandonedServerRequests = new Set<string>();
  private socket: WebSocket | undefined;
  private inputEnded = false;
  private outputFailed = false;
  private failed = false;
  private inputDraining = false;
  private outputDraining = false;
  private connectedOnce = false;
  private ready = false;
  private initializeLine?: string;
  private initializeId?: RpcId;
  private initializeSent = false;
  private initialized = false;
  private suppressInitializeResponse = false;

  public constructor(
    private readonly config: HybridConfig,
    private readonly socketPath: string,
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
    private readonly kick: (config: HybridConfig) => Promise<void>,
    private readonly initialConnectDeadlineMs: number,
    private readonly retryDelayMs: number,
  ) {
    this.reader = createInterface({ input });
    this.output = output as Writable;
    this.reader.on("line", (line) => this.enqueueInput(line));
    this.reader.once("close", () => {
      this.inputEnded = true;
      this.socket?.close();
    });
    this.output.once("error", (error) => {
      this.outputFailed = true;
      process.stderr.write(`ccodex stdio frontend: stdout failed: ${String(error)}\n`);
      this.reader.close();
      this.socket?.terminate();
    });
  }

  public async run(): Promise<number> {
    while (!this.inputEnded && !this.outputFailed) {
      const socket = await this.connect();
      if (!socket) {
        this.reader.close();
        return 1;
      }
      await this.serve(socket);
      if (!this.inputEnded && !this.outputFailed) {
        this.failPendingRequests();
        for (const id of this.serverRequests) this.abandonedServerRequests.add(id);
        this.serverRequests.clear();
        this.ready = false;
        this.initializeSent = false;
      }
    }
    await this.flushOutput();
    return this.outputFailed || this.failed ? 1 : 0;
  }

  private async connect(): Promise<WebSocket | undefined> {
    await this.kick(this.config);
    const deadline = this.connectedOnce ? Number.POSITIVE_INFINITY : Date.now() + this.initialConnectDeadlineMs;
    while (!this.inputEnded && !this.outputFailed && Date.now() < deadline) {
      try {
        const socket = await openSocket(this.socketPath);
        this.connectedOnce = true;
        return socket;
      } catch {
        await sleep(this.retryDelayMs);
      }
    }
    if (!this.inputEnded && !this.outputFailed) {
      process.stderr.write(`ccodex stdio frontend: gateway ${this.socketPath} did not become ready\n`);
    }
    return undefined;
  }

  private serve(socket: WebSocket): Promise<void> {
    this.socket = socket;
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.socket === socket) this.socket = undefined;
        resolve();
      };
      socket.on("message", (data: WebSocket.RawData) => this.receive(data.toString()));
      socket.once("close", finish);
      socket.once("error", (error) => {
        process.stderr.write(`ccodex stdio frontend: gateway connection failed: ${String(error)}\n`);
        finish();
      });
      if (this.initializeLine) {
        this.suppressInitializeResponse = this.initialized;
        this.initializeSent = true;
        void send(socket, this.initializeLine).catch(() => socket.terminate());
      } else {
        this.ready = true;
        void this.flushInput();
      }
    });
  }

  private enqueueInput(line: string): void {
    if (line.length === 0) return;
    const envelope = parseEnvelope(line);
    if (envelope?.id !== undefined && envelope.method === "initialize") {
      this.initializeLine = line;
      this.initializeId = envelope.id;
    }
    if (envelope?.id !== undefined && envelope.method === undefined) {
      const key = requestKey(envelope.id);
      if (this.abandonedServerRequests.delete(key)) return;
      this.serverRequests.delete(key);
    }
    this.inputLines.push(line);
    if (this.inputLines.length >= INPUT_HIGH_WATER) this.reader.pause();
    void this.flushInput();
  }

  private async flushInput(): Promise<void> {
    if (this.inputDraining || !this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.inputDraining = true;
    const socket = this.socket;
    try {
      while (this.ready && this.socket === socket && socket.readyState === WebSocket.OPEN) {
        const line = this.inputLines.shift();
        if (line === undefined) break;
        const envelope = parseEnvelope(line);
        if (envelope?.id !== undefined && envelope.method === "initialize") {
          if (this.initializeSent) continue;
          this.initializeSent = true;
          this.suppressInitializeResponse = false;
          this.ready = false;
        } else if (envelope?.id !== undefined && envelope.method !== undefined) {
          this.pending.set(requestKey(envelope.id), envelope.id);
        }
        await send(socket, line);
        if (this.inputLines.length <= INPUT_LOW_WATER) this.reader.resume();
      }
    } catch {
      socket.terminate();
    } finally {
      this.inputDraining = false;
    }
  }

  private receive(line: string): void {
    const envelope = parseEnvelope(line);
    if (envelope?.id !== undefined && envelope.method !== undefined) {
      this.serverRequests.add(requestKey(envelope.id));
    }
    if (envelope?.id !== undefined && envelope.method === undefined) {
      const key = requestKey(envelope.id);
      if (this.initializeId !== undefined && key === requestKey(this.initializeId) && this.initializeSent) {
        const suppress = this.suppressInitializeResponse;
        this.suppressInitializeResponse = false;
        if (envelope.error) {
          this.failed = true;
          if (suppress) this.failPendingRequests();
          this.reader.close();
          this.socket?.close();
        } else {
          this.initialized = true;
          this.ready = true;
          void this.flushInput();
        }
        if (suppress) return;
      } else {
        this.pending.delete(key);
      }
    }
    this.outputLines.push(line);
    if (this.outputLines.length >= OUTPUT_HIGH_WATER) this.socket?.pause();
    void this.flushOutput();
  }

  private failPendingRequests(): void {
    for (const id of this.pending.values()) {
      this.outputLines.push(JSON.stringify({
        id,
        error: {
          code: -32001,
          message: "CCodex gateway restarted before this request completed. Retry the request.",
        },
      }));
    }
    this.pending.clear();
    void this.flushOutput();
  }

  private async flushOutput(): Promise<void> {
    if (this.outputDraining || this.outputFailed) return;
    this.outputDraining = true;
    try {
      while (this.outputLines.length > 0 && !this.outputFailed) {
        const line = this.outputLines.shift()!;
        if (!this.output.write(`${line}\n`)) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => { cleanup(); resolve(); };
            const onError = (error: Error) => { cleanup(); reject(error); };
            const cleanup = () => {
              this.output.off("drain", onDrain);
              this.output.off("error", onError);
            };
            this.output.once("drain", onDrain);
            this.output.once("error", onError);
          });
        }
        if (this.outputLines.length <= OUTPUT_LOW_WATER) this.socket?.resume();
      }
    } catch {
      this.outputFailed = true;
      this.reader.close();
      this.socket?.terminate();
    } finally {
      this.outputDraining = false;
    }
  }
}

export function runStdioFrontend(
  config: HybridConfig,
  socketPath: string,
  deps: StdioFrontendDeps = {},
): Promise<number> {
  return new StdioFrontend(
    config,
    socketPath,
    deps.input ?? process.stdin,
    deps.output ?? process.stdout,
    deps.kick ?? defaultKick,
    deps.initialConnectDeadlineMs ?? INITIAL_CONNECT_DEADLINE_MS,
    deps.retryDelayMs ?? RETRY_DELAY_MS,
  ).run();
}
