import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HybridConfig } from "../config/config.js";
import type { DaemonCommand } from "../cli/args.js";
import { installLayout } from "../management/layout.js";
import { runPidDaemonCommand } from "./pidDaemon.js";

interface DaemonInvocation {
  readonly command: DaemonCommand;
  readonly remoteControl: boolean;
}

function launchdInstalled(): boolean {
  if (process.platform !== "darwin") return false;
  const manifestPath = installLayout().manifest;
  if (!existsSync(manifestPath)) return false;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    desktopAppActive?: boolean;
    desktopApp?: { gatewayAgent?: { path?: string; contentHash?: string } };
  };
  if (!manifest.desktopApp || manifest.desktopAppActive === false) return false;
  const record = manifest.desktopApp.gatewayAgent;
  if (!record?.path || !record.contentHash || !existsSync(record.path)) {
    throw new Error("CCodex desktop LaunchAgent is missing. Run: ccodex setup --repair");
  }
  const hash = createHash("sha256").update(readFileSync(record.path)).digest("hex");
  if (hash !== record.contentHash) {
    throw new Error(`CCodex desktop LaunchAgent was modified: ${record.path}`);
  }
  return true;
}

export async function runDaemonCommand(
  config: HybridConfig,
  invocation: DaemonInvocation,
  wrapperPath: string,
): Promise<Record<string, string | number | boolean | undefined>> {
  if (launchdInstalled()) {
    const { runLaunchdDaemonCommand } = await import("../desktop/launchdSupervisor.js");
    return runLaunchdDaemonCommand(config, invocation, wrapperPath);
  }
  return runPidDaemonCommand(config, invocation, wrapperPath);
}

export function daemonSettingsPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-daemon", "settings.json");
}
