import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import type { HybridConfig } from "../config/config.js";
import { runDaemonCommand } from "../daemon/daemon.js";
import { LAUNCH_AGENT_LABEL } from "./launchAgent.js";

const CONNECT_DEADLINE_MS = 20_000;
const RETRY_DELAY_MS = 200;

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface BridgeDeps {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly kick?: (config: HybridConfig, socketPath: string) => Promise<void>;
  readonly connectDeadlineMs?: number;
  readonly retryDelayMs?: number;
}

function openBridgeSocket(socketPath: string): Promise<WebSocket> {
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

async function kickGateway(config: HybridConfig, _socketPath: string): Promise<void> {
  if (process.platform === "darwin") {
    const kicked = spawnSync(
      "launchctl",
      ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${LAUNCH_AGENT_LABEL}`],
      { encoding: "utf8" },
    );
    if (!kicked.error && kicked.status === 0) return;
  }
  // Fall back to the detached PID daemon so a missing/unregistered agent still recovers.
  try {
    await runDaemonCommand(config, { command: "start", remoteControl: false }, process.argv[1] ?? process.execPath);
  } catch (error) {
    process.stderr.write(`ccodex desktop bridge: gateway autostart failed: ${String(error)}\n`);
  }
}

async function connect(
  config: HybridConfig,
  socketPath: string,
  kick: (config: HybridConfig, socketPath: string) => Promise<void>,
  deadlineMs: number,
  retryDelayMs: number,
): Promise<WebSocket | undefined> {
  const deadline = Date.now() + deadlineMs;
  let kicked = false;
  while (Date.now() < deadline) {
    try {
      return await openBridgeSocket(socketPath);
    } catch {
      // Lazily start the gateway once, then keep retrying so a cold start never crashes
      // the App: it just waits for the KeepAlive agent (or detached daemon) to come up.
      if (!kicked) {
        await kick(config, socketPath);
        kicked = true;
      }
      await sleep(retryDelayMs);
    }
  }
  return undefined;
}

function pump(socket: WebSocket, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const reader = createInterface({ input });
    reader.on("line", (line) => {
      if (line.length > 0 && socket.readyState === WebSocket.OPEN) socket.send(line);
    });
    reader.once("close", () => {
      // The App closed stdin; drain the gateway and exit cleanly.
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    });
    socket.on("message", (data: WebSocket.RawData) => { output.write(`${data.toString()}\n`); });
    socket.once("close", () => {
      reader.close();
      finish(0);
    });
    socket.once("error", (error) => {
      process.stderr.write(`ccodex desktop bridge: ${String(error)}\n`);
      reader.close();
      finish(1);
    });
  });
}

export async function runDesktopBridge(
  config: HybridConfig,
  socketPath: string,
  deps: BridgeDeps = {},
): Promise<number> {
  // The marker routed this process to the bridge; clear it so any gateway/daemon this
  // process spawns as a fallback classifies normally instead of recursing into a bridge.
  delete process.env.CCODEX_DESKTOP;
  const socket = await connect(
    config,
    socketPath,
    deps.kick ?? kickGateway,
    deps.connectDeadlineMs ?? CONNECT_DEADLINE_MS,
    deps.retryDelayMs ?? RETRY_DELAY_MS,
  );
  if (!socket) {
    process.stderr.write(`ccodex desktop bridge: gateway ${socketPath} did not become ready\n`);
    return 1;
  }
  return pump(socket, deps.input ?? process.stdin, deps.output ?? process.stdout);
}
