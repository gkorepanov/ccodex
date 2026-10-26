import { createConnection } from "node:net";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import WebSocket from "ws";
import type { Config } from "../config.js";
import { runDaemonCommand } from "../daemon/daemon.js";
import { applyLaunchConfig } from "./launchConfig.js";

const INITIAL_CONNECT_DEADLINE_MS = 20_000;
const RETRY_DELAY_MS = 200;
const INPUT_HIGH_WATER = 256;
const INPUT_LOW_WATER = 64;
const OUTPUT_HIGH_WATER = 256;
const OUTPUT_LOW_WATER = 64;

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface StdioFrontendDeps {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly kick?: (config: Config) => Promise<void>;
  readonly initialConnectDeadlineMs?: number;
  readonly retryDelayMs?: number;
  readonly configOverrides?: readonly string[];
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

async function defaultKick(config: Config): Promise<void> {
  try {
    await runDaemonCommand(config, { command: "start", remoteControl: false, desktop: process.env.CODEX_APP_TOOLS_PIPE_PATH, app: true }, process.argv[1] ?? process.execPath);
  } catch (error) {
    process.stderr.write(`ccodex stdio frontend: gateway autostart failed: ${String(error)}\n`);
  }
}

/**
 * The Codex App's `codex app-server` over stdio, relayed to the gateway line for line. Like stock's
 * `codex app-server proxy`, it ends when the gateway goes: the App then starts it again and resumes its chats.
 */
class StdioFrontend {
  private readonly reader: ReadlineInterface;
  private readonly output: Writable;
  private readonly inputLines: string[] = [];
  private readonly outputLines: string[] = [];
  private socket: WebSocket | undefined;
  private inputEnded = false;
  private outputFailed = false;
  private inputDraining = false;
  private outputDraining = false;

  public constructor(
    private readonly config: Config,
    private readonly socketPath: string,
    private readonly input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
    private readonly kick: (config: Config) => Promise<void>,
    private readonly initialConnectDeadlineMs: number,
    private readonly retryDelayMs: number,
    private readonly configOverrides: readonly string[],
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
    const socket = await this.connect();
    if (!socket) {
      this.reader.close();
      return 1;
    }
    await this.serve(socket);
    const lost = !this.inputEnded && !this.outputFailed;
    if (lost) process.stderr.write("ccodex stdio frontend: gateway connection closed\n");
    this.reader.close();
    // An open stdin would keep the process (and so the App's idea of a live app-server) alive.
    (this.input as Readable).destroy();
    await this.flushOutput();
    return lost || this.outputFailed ? 1 : 0;
  }

  private async connect(): Promise<WebSocket | undefined> {
    await this.kick(this.config);
    const deadline = Date.now() + this.initialConnectDeadlineMs;
    while (!this.inputEnded && !this.outputFailed && Date.now() < deadline) {
      try {
        return await openSocket(this.socketPath);
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
      socket.on("message", (data: WebSocket.RawData) => this.receive(data.toString()));
      socket.once("close", () => resolve());
      socket.once("error", (error) => {
        process.stderr.write(`ccodex stdio frontend: gateway connection failed: ${String(error)}\n`);
        resolve();
      });
      void this.flushInput();
    });
  }

  private enqueueInput(line: string): void {
    if (line.length === 0) return;
    this.inputLines.push(applyLaunchConfig(line, this.configOverrides));
    if (this.inputLines.length >= INPUT_HIGH_WATER) this.reader.pause();
    void this.flushInput();
  }

  private async flushInput(): Promise<void> {
    const socket = this.socket;
    if (this.inputDraining || !socket || socket.readyState !== WebSocket.OPEN) return;
    this.inputDraining = true;
    try {
      while (socket.readyState === WebSocket.OPEN) {
        const line = this.inputLines.shift();
        if (line === undefined) break;
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
    this.outputLines.push(line);
    if (this.outputLines.length >= OUTPUT_HIGH_WATER) this.socket?.pause();
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
  config: Config,
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
    deps.configOverrides ?? [],
  ).run();
}
