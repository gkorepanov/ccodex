import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HybridConfig } from "../config/config.js";
import type { Logger } from "../observability/logger.js";

export interface StockProcess {
  readonly child: ChildProcess;
  readonly socketPath: string;
  stop(): Promise<void>;
}

function processTree(root: number): number[] {
  if (process.platform === "win32") return [root];
  const output = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" }).stdout;
  const children = new Map<number, number[]>();
  for (const line of output.trim().split("\n")) {
    const [pidText, parentText] = line.trim().split(/\s+/u);
    const pid = Number(pidText);
    const parent = Number(parentText);
    children.set(parent, [...children.get(parent) ?? [], pid]);
  }
  const tree = [root];
  for (let index = 0; index < tree.length; index += 1) tree.push(...children.get(tree[index]!) ?? []);
  return tree.reverse();
}

async function waitForSocket(child: ChildProcess, socketPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return;
    if (child.exitCode !== null) {
      throw new Error(`Stock Codex app-server exited with code ${child.exitCode}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for stock Codex socket '${socketPath}'.`);
}

export async function startStockProcess(
  config: HybridConfig,
  baseArgs: readonly string[],
  logger: Logger,
): Promise<StockProcess> {
  const runDir = join(config.dataDir, "run", String(process.pid));
  const socketPath = join(runDir, "stock.sock");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });

  const args = [...baseArgs, "--listen", `unix://${socketPath}`];
  const child = spawn(config.realCodex, args, {
    env: {
      ...process.env,
      CODEX_CLI_PATH: undefined,
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stopping = false;
  child.stderr?.on("data", (data: Buffer) => {
    logger.debug("stock.stderr", { output: data.toString("utf8").trimEnd() });
  });
  child.once("error", (error) => logger.error("stock.spawn.error", { error: error.message }));
  child.once("exit", (code, signal) => {
    if (!stopping) {
      logger.error("stock.exited", { code, signal });
      process.kill(process.pid, "SIGTERM");
    }
  });

  const signal = (name: NodeJS.Signals) => {
    if (!child.pid) return;
    for (const pid of processTree(child.pid)) {
      try { process.kill(pid, name); } catch { /* process already exited */ }
    }
  };

  try {
    await waitForSocket(child, socketPath);
  } catch (error) {
    stopping = true;
    signal("SIGTERM");
    throw error;
  }

  logger.info("stock.started", { pid: child.pid, socketPath });

  return {
    child,
    socketPath,
    async stop(): Promise<void> {
      stopping = true;
      if (child.exitCode === null) {
        signal("SIGTERM");
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          new Promise<void>((resolve) =>
            setTimeout(() => {
              if (child.exitCode === null) signal("SIGKILL");
              resolve();
            }, 3_000),
          ),
        ]);
      }
      rmSync(socketPath, { force: true });
      rmSync(dirname(socketPath), { recursive: true, force: true });
    },
  };
}
