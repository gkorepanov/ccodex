import { existsSync } from "node:fs";
import { join } from "node:path";
import type { InstallLayout } from "../management/layout.js";
import {
  bootoutLaunchAgent,
  bootstrapLaunchAgent,
  installCliPathAgent,
  installLaunchAgent,
  fileHash,
  type CliPathAgentInstall,
  type LaunchAgentInstall,
  type LaunchctlRuntime,
  setCodexCliPathEnv,
  systemLaunchctl,
  uninstallCliPathAgent,
  uninstallLaunchAgent,
  unsetCodexCliPathEnv,
} from "./launchAgent.js";

export interface DesktopAppInstall {
  readonly entryShimPath: string;
  readonly gatewayAgent: LaunchAgentInstall;
  readonly cliPathAgent: CliPathAgentInstall;
}

export function desktopAppFilesIntact(record: DesktopAppInstall): boolean {
  return existsSync(record.gatewayAgent.path)
    && fileHash(record.gatewayAgent.path) === record.gatewayAgent.contentHash
    && existsSync(record.cliPathAgent.path)
    && fileHash(record.cliPathAgent.path) === record.cliPathAgent.contentHash;
}

export function installDesktopApp(
  layout: InstallLayout,
  socket: string,
  nodeExecutable: string,
  remoteControlEnabled: boolean,
  previous?: DesktopAppInstall,
  runtime: LaunchctlRuntime = systemLaunchctl,
): DesktopAppInstall {
  const entryShimPath = join(layout.bin, "codex");
  let gatewayAgent: LaunchAgentInstall | undefined;
  let cliPathAgent: CliPathAgentInstall | undefined;
  try {
    gatewayAgent = installLaunchAgent(
      layout,
      socket,
      nodeExecutable,
      remoteControlEnabled,
      previous?.gatewayAgent,
    );
    cliPathAgent = installCliPathAgent(entryShimPath, previous?.cliPathAgent, runtime);
    setCodexCliPathEnv(entryShimPath, runtime);
    return { entryShimPath, gatewayAgent, cliPathAgent };
  } catch (error) {
    if (cliPathAgent) {
      if (previous) {
        installCliPathAgent(previous.entryShimPath, cliPathAgent, runtime);
        try { setCodexCliPathEnv(previous.entryShimPath, runtime); } catch { /* preserve primary failure */ }
      } else {
        uninstallCliPathAgent(cliPathAgent, runtime);
      }
    }
    if (gatewayAgent) {
      if (previous) {
        installLaunchAgent(
          layout,
          previous.gatewayAgent.socket,
          previous.gatewayAgent.nodeExecutable,
          previous.gatewayAgent.remoteControlEnabled,
          gatewayAgent,
        );
      } else {
        uninstallLaunchAgent(gatewayAgent, runtime);
      }
    }
    throw error;
  }
}

export function startDesktopApp(
  record: DesktopAppInstall,
  runtime: LaunchctlRuntime = systemLaunchctl,
): void {
  bootstrapLaunchAgent(record.gatewayAgent, runtime);
}

export function stopDesktopApp(
  record: DesktopAppInstall,
  runtime: LaunchctlRuntime = systemLaunchctl,
): void {
  bootoutLaunchAgent(record.gatewayAgent, runtime);
}

export function restoreDesktopApp(
  layout: InstallLayout,
  current?: DesktopAppInstall,
  previous?: DesktopAppInstall,
  runtime: LaunchctlRuntime = systemLaunchctl,
  startPrevious = true,
): void {
  if (!current) return;
  try {
    if (previous) {
      stopDesktopApp(current, runtime);
      const gatewayAgent = installLaunchAgent(
        layout,
        previous.gatewayAgent.socket,
        previous.gatewayAgent.nodeExecutable,
        previous.gatewayAgent.remoteControlEnabled,
        current.gatewayAgent,
      );
      const cliPathAgent = installCliPathAgent(
        previous.entryShimPath,
        current.cliPathAgent,
        runtime,
      );
      setCodexCliPathEnv(previous.entryShimPath, runtime);
      if (startPrevious) startDesktopApp({ ...previous, gatewayAgent, cliPathAgent }, runtime);
      return;
    }
    uninstallDesktopApp(current, runtime);
  } catch (error) {
    process.stderr.write(`CCodex rollback could not restore the desktop integration: ${String(error)}\n`);
  }
}

export function uninstallDesktopApp(
  record: DesktopAppInstall,
  runtime: LaunchctlRuntime = systemLaunchctl,
): string[] {
  unsetCodexCliPathEnv(runtime);
  const preserved: string[] = [];
  if (!uninstallCliPathAgent(record.cliPathAgent, runtime)) preserved.push(record.cliPathAgent.path);
  if (!uninstallLaunchAgent(record.gatewayAgent, runtime)) preserved.push(record.gatewayAgent.path);
  return preserved;
}
