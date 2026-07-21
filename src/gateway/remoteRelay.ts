import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RemoteControlStatusChangedNotification } from "../codex/generated/v2/RemoteControlStatusChangedNotification.js";
import type { Logger } from "../observability/logger.js";
import type { RemoteControlHub } from "./remoteControlHub.js";

const START_TIMEOUT_MS = 10_000;
const require = createRequire(import.meta.url);

const RELAY_PACKAGES: Readonly<Record<string, string>> = {
  "darwin-arm64": "@gkorepanov/ccodex-relay-darwin-arm64",
  "linux-arm64-gnu": "@gkorepanov/ccodex-relay-linux-arm64-gnu",
  "linux-x64-gnu": "@gkorepanov/ccodex-relay-linux-x64-gnu",
};

export interface RemoteRelay {
  readonly child: ChildProcess;
  stop(): Promise<void>;
}

function platformKey(): string {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform !== "linux") return `${process.platform}-${process.arch}`;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return `linux-${process.arch}-${report?.header?.glibcVersionRuntime ? "gnu" : "musl"}`;
}

export function relayBinary(): string {
  const override = process.env.CCODEX_REMOTE_RELAY ?? process.env.CODEX_HYBRID_REMOTE_RELAY;
  if (override) return override;

  const key = platformKey();
  const packageName = RELAY_PACKAGES[key];
  if (packageName) {
    try {
      return join(dirname(require.resolve(`${packageName}/package.json`)), "bin", "ccodex-relay");
    } catch {
      // Source builds keep a local relay next to compiled JavaScript.
    }
  }

  const local = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "ccodex-relay");
  if (existsSync(local)) return local;
  throw new Error(
    `CCodex relay package for '${key}' is missing. Reinstall @gkorepanov/ccodex with optional dependencies enabled.`,
  );
}

export async function startRemoteRelay(
  socketPath: string,
  hub: RemoteControlHub,
  logger: Logger,
): Promise<RemoteRelay> {
  const binary = relayBinary();
  if (!existsSync(binary)) throw new Error(`CCodex remote-control relay binary was not found: ${binary}`);
  const env = { ...process.env };
  delete env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED;
  const child = spawn(binary, ["--socket", socketPath], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stopping = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timeout = setTimeout(() => readyReject(new Error("Timed out starting remote-control relay.")), START_TIMEOUT_MS);

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      try {
        const event = JSON.parse(line) as { type?: string; params?: RemoteControlStatusChangedNotification };
        if (event.type === "status" && event.params) hub.update(event.params);
        if (event.type === "ready") readyResolve();
      } catch (error) {
        logger.warn("remote-relay.stdout.invalid", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => logger.debug("remote-relay.stderr", { output: chunk.toString("utf8").trimEnd() }));
  child.once("error", (error) => readyReject(error));
  child.once("exit", (code, signal) => {
    if (!stopping) {
      const error = new Error(`Remote-control relay exited unexpectedly (${signal ?? code ?? "unknown"}).`);
      readyReject(error);
      logger.error("remote-relay.exited", { code, signal });
      process.kill(process.pid, "SIGTERM");
    }
  });

  try {
    await ready;
  } catch (error) {
    stopping = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  logger.info("remote-relay.started", { pid: child.pid, socketPath });

  return {
    child,
    async stop(): Promise<void> {
      stopping = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGINT");
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          new Promise<void>((resolve) => setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            resolve();
          }, 3_000)),
        ]);
      }
      logger.info("remote-relay.stopped", { pid: child.pid });
    },
  };
}
