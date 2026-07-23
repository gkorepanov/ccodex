import { join } from "node:path";
import type { InstallLayout } from "../management/layout.js";
import {
  bootoutLaunchAgent, bootstrapLaunchAgent, installCliPathAgent, installLaunchAgent,
  type LaunchAgentInstall, type LaunchctlRuntime, setCodexCliPathEnv, systemLaunchctl,
  uninstallCliPathAgent, uninstallLaunchAgent, unsetCodexCliPathEnv,
} from "./launchAgent.js";

export interface DesktopAppInstall {
  readonly launchAgentPath: string;
  readonly label: string;
  readonly controlSocket: string;
  readonly entryShimPath: string;
  readonly cliPathAgentPath: string;
}

function launchAgentRecord(record: DesktopAppInstall): LaunchAgentInstall {
  return { path: record.launchAgentPath, label: record.label, socket: record.controlSocket };
}

export function installDesktopApp(
  layout: InstallLayout,
  socket: string,
  previous?: DesktopAppInstall,
  runtime: LaunchctlRuntime = systemLaunchctl,
): DesktopAppInstall {
  const entryShimPath = join(layout.bin, "codex-desktop");
  const agent = installLaunchAgent(layout, socket, previous ? launchAgentRecord(previous) : undefined, runtime);
  const cliPathAgentPath = installCliPathAgent(entryShimPath, runtime);
  // Publish CODEX_CLI_PATH into the running GUI session now; the login agent covers reboots.
  setCodexCliPathEnv(entryShimPath, runtime);
  return {
    launchAgentPath: agent.path,
    label: agent.label,
    controlSocket: agent.socket,
    entryShimPath,
    cliPathAgentPath,
  };
}

export function startDesktopApp(record: DesktopAppInstall, runtime: LaunchctlRuntime = systemLaunchctl): void {
  bootstrapLaunchAgent(launchAgentRecord(record), runtime);
}

export function stopDesktopApp(record: DesktopAppInstall, runtime: LaunchctlRuntime = systemLaunchctl): void {
  bootoutLaunchAgent(launchAgentRecord(record), runtime);
}

export function restoreDesktopApp(
  current?: DesktopAppInstall,
  previous?: DesktopAppInstall,
  runtime: LaunchctlRuntime = systemLaunchctl,
): void {
  if (!current) return;
  try {
    if (previous) {
      // The plists target bin/ccodex and bin/codex-desktop (version-independent), so
      // reloading the previous gateway record restores the rolled-back socket owner.
      bootoutLaunchAgent(launchAgentRecord(previous), runtime);
      bootstrapLaunchAgent(launchAgentRecord(previous), runtime);
      return;
    }
    uninstallDesktopApp(current, runtime);
  } catch (error) {
    process.stderr.write(`CCodex rollback could not restore the desktop LaunchAgent: ${String(error)}\n`);
  }
}

export function uninstallDesktopApp(record: DesktopAppInstall, runtime: LaunchctlRuntime = systemLaunchctl): string[] {
  unsetCodexCliPathEnv(runtime);
  const preserved: string[] = [];
  if (!uninstallCliPathAgent(record.cliPathAgentPath, runtime)) preserved.push(record.cliPathAgentPath);
  if (!uninstallLaunchAgent(launchAgentRecord(record), runtime)) preserved.push(record.launchAgentPath);
  return preserved;
}
