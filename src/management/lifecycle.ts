import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { atomicSymlink, atomicWrite, ensureLayout, installLayout } from "./layout.js";
import { readInstallManifest, setup, type InstallManifest } from "./setup.js";
import { reconcileManagedProcess, stopManagedProcess } from "../daemon/supervisor.js";
import { reconcileOwnedGateway, stopSocketOwner } from "../daemon/ownership.js";
import { uninstallRemoteCodexShim } from "./remoteShim.js";
import {
  fileHash, installCliPathAgent, uninstallCliPathAgent,
} from "../desktop/launchAgent.js";
import {
  fishManagedBlock as fishBlock,
  legacyFishManagedBlock as legacyFishBlock,
  legacyPosixManagedBlock as legacyPosixBlock,
  migrateDesktopShellBlocks,
  posixManagedBlock as posixBlock,
  restoreShellBlockChanges,
  type ShellBlockChange,
} from "./shellRouting.js";
import {
  installManagedShims, restoreManagedShims, type ManagedShimChange,
} from "./shims.js";

const execute = promisify(execFile);

async function registryVersion(channel: string): Promise<string> {
  const { stdout } = await execute("npm", ["view", "@gkorepanov/ccodex", `dist-tags.${channel}`, "--json"], {
    timeout: 30_000,
    maxBuffer: 128 * 1024,
  });
  const value = JSON.parse(stdout) as unknown;
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(value)) {
    throw new Error(`npm returned an invalid latest version: ${stdout.trim()}`);
  }
  return value;
}

function daemonPidFile(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-daemon", "app-server.pid");
}

function supportsDesktopApp(layout: ReturnType<typeof installLayout>, version: string): boolean {
  return existsSync(join(
    layout.versions,
    version,
    "node_modules",
    "@gkorepanov",
    "ccodex",
    "dist",
    "desktop",
    "stdioFrontend.js",
  ));
}

export async function update(args: readonly string[]): Promise<number> {
  const channelIndex = args.indexOf("--channel");
  const channel = channelIndex >= 0 ? args[channelIndex + 1] : "latest";
  const valued = new Set([channelIndex + 1]);
  if (!channel || !["latest", "next"].includes(channel) || args.some((arg, index) => !valued.has(index) && arg !== "--check" && arg !== "--channel")) {
    throw new Error("Usage: ccodex update [--check] [--channel latest|next]");
  }
  const layout = installLayout();
  const manifest = readInstallManifest(layout);
  if (!manifest) throw new Error("CCodex is not activated. Run: ccodex setup");
  const latest = await registryVersion(channel);
  const current = manifest.activeVersion;
  if (args.includes("--check")) {
    process.stdout.write(latest === current ? `CCodex ${current} is current.\n` : `CCodex ${latest} is available (current: ${current}).\n`);
    return 0;
  }
  if (latest === current) {
    process.stdout.write(`CCodex ${current} is already current.\n`);
    return 0;
  }
  return setup(["--version", latest]);
}

export async function rollback(args: readonly string[]): Promise<number> {
  if (args.length > 0) throw new Error("Usage: ccodex rollback");
  const layout = installLayout();
  const manifest = readInstallManifest(layout);
  if (!manifest) throw new Error("CCodex is not activated.");
  if (!existsSync(layout.previous) || !lstatSync(layout.previous).isSymbolicLink()) {
    throw new Error("No previous CCodex version is available.");
  }
  const previous = basename(readlinkSync(layout.previous));
  const current = manifest.activeVersion;
  if (!existsSync(join(layout.versions, previous))) throw new Error(`Previous CCodex ${previous} is missing.`);
  const desktopWasActive = process.platform === "darwin" && Boolean(manifest.desktopCliPath);
  const targetDesktop = process.platform === "darwin" && supportsDesktopApp(layout, previous);
  let shellChanges: ShellBlockChange[] = [];
  let removedDesktop = false;
  let installedDesktop: InstallManifest["desktopCliPath"];
  let shimChanges: readonly ManagedShimChange[] = [];
  try {
    if (desktopWasActive && !targetDesktop) {
      if (
        !existsSync(manifest.desktopCliPath!.path)
        || fileHash(manifest.desktopCliPath!.path) !== manifest.desktopCliPath!.contentHash
      ) {
        throw new Error("Cannot roll back: managed desktop files were modified.");
      }
      uninstallCliPathAgent(manifest.desktopCliPath!);
      removedDesktop = true;
      shellChanges = migrateDesktopShellBlocks(layout, manifest.managedShellFiles, false);
    }

    atomicSymlink(join("versions", previous), layout.current);
    atomicSymlink(join("versions", current), layout.previous);
    const shims = installManagedShims(layout.bin, process.execPath, manifest.shimHashes);
    shimChanges = shims.changes;

    let desktopCliPath = targetDesktop ? manifest.desktopCliPath : undefined;
    if (targetDesktop && !desktopWasActive) {
      shellChanges = migrateDesktopShellBlocks(layout, manifest.managedShellFiles, true);
      desktopCliPath = installCliPathAgent(join(layout.bin, "codex"));
      installedDesktop = desktopCliPath;
    }
    const {
      desktopCliPath: _oldDesktop, desktopApp: _legacyDesktop, desktopAppActive: _legacyActive, ...base
    } = manifest as InstallManifest & {
      readonly desktopApp?: unknown;
      readonly desktopAppActive?: boolean;
    };
    const next: InstallManifest = {
      ...base,
      activeVersion: previous,
      previousVersion: current,
      nodeExecutable: process.execPath,
      shimHashes: shims.hashes,
      ...(desktopCliPath ? { desktopCliPath } : {}),
    };
    atomicWrite(layout.manifest, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  } catch (error) {
    atomicSymlink(join("versions", current), layout.current);
    atomicSymlink(join("versions", previous), layout.previous);
    restoreManagedShims(shimChanges);
    restoreShellBlockChanges(shellChanges);
    if (installedDesktop) uninstallCliPathAgent(installedDesktop);
    if (removedDesktop && manifest.desktopCliPath) {
      installCliPathAgent(manifest.desktopCliPath.entryShimPath, manifest.desktopCliPath);
    }
    atomicWrite(layout.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    throw error;
  }
  process.stdout.write(
    `CCodex rolled back from ${current} to ${previous}.`
    + `${process.platform === "darwin" ? " Reconnect Codex App." : ""}\n`,
  );
  return 0;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function removeManagedShellFile(path: string, layout: ReturnType<typeof installLayout>): boolean {
  if (!existsSync(path)) return true;
  const content = readFileSync(path, "utf8");
  if (path.endsWith("ccodex.fish")) {
    const expected = `# Managed by CCodex.\nfish_add_path --prepend "${layout.bin}"\n`;
    if (content !== expected) return false;
    rmSync(path);
    return true;
  }
  const block = path.endsWith("config.fish") ? fishBlock(layout) : posixBlock(layout);
  const legacy = path.endsWith("config.fish") ? legacyFishBlock(layout) : legacyPosixBlock(layout);
  const present = content.includes(block) ? block : content.includes(legacy) ? legacy : undefined;
  if (!present) return false;
  const mode = statSync(path).mode & 0o777;
  atomicWrite(path, content.replace(present, ""), mode);
  return true;
}

export async function uninstall(args: readonly string[]): Promise<number> {
  if (args.some((arg) => arg !== "--purge" && arg !== "--yes")) throw new Error("Usage: ccodex uninstall [--purge --yes]");
  if (args.includes("--purge") && !args.includes("--yes")) {
    throw new Error("Purging removes all CCodex state and captures. Confirm with: ccodex uninstall --purge --yes");
  }
  const layout = installLayout();
  const manifest = readInstallManifest(layout);
  if (!manifest) throw new Error("CCodex is not activated.");
  const publicSocket = manifest.publicSocket ?? join(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "app-server-control",
    "app-server-control.sock",
  );
  const disabledCurrent = `${layout.current}.uninstalling-${process.pid}`;
  const currentTarget = existsSync(layout.current) && lstatSync(layout.current).isSymbolicLink()
    ? readlinkSync(layout.current)
    : undefined;
  if (currentTarget) renameSync(layout.current, disabledCurrent);
  try {
    const managed = reconcileManagedProcess(daemonPidFile());
    if (managed) await stopManagedProcess(daemonPidFile(), managed);
    else {
      const owner = reconcileOwnedGateway(publicSocket);
      if (owner) await stopSocketOwner(publicSocket, owner);
    }
  } catch (error) {
    if (currentTarget && existsSync(disabledCurrent)) renameSync(disabledCurrent, layout.current);
    throw error;
  }

  const preserved: string[] = [];
  for (const path of manifest.managedShellFiles) {
    if (!removeManagedShellFile(path, layout)) preserved.push(path);
  }
  if (manifest.remoteCodexShim && !uninstallRemoteCodexShim(manifest.remoteCodexShim)) {
    preserved.push(manifest.remoteCodexShim.path);
  }
  if (manifest.desktopCliPath && !uninstallCliPathAgent(manifest.desktopCliPath)) {
    preserved.push(manifest.desktopCliPath.path);
  }
  for (const [name, expected] of Object.entries(manifest.shimHashes)) {
    const path = join(layout.bin, name);
    if (!existsSync(path)) continue;
    if (hashFile(path) === expected) rmSync(path);
    else preserved.push(path);
  }
  for (const path of [disabledCurrent, layout.current, layout.previous, layout.versions, layout.staging, layout.manifest]) {
    rmSync(path, { recursive: true, force: true });
  }
  if (args.includes("--purge")) {
    rmSync(layout.state, { recursive: true, force: true });
    rmSync(join(layout.home, "config.toml"), { force: true });
  }
  for (const path of [layout.bin, layout.home]) {
    try { rmSync(path); } catch { /* preserved state, config, or modified owned file */ }
  }
  if (preserved.length > 0) process.stderr.write(`Preserved modified files:\n${preserved.map((path) => `  ${path}`).join("\n")}\n`);
  process.stdout.write(args.includes("--purge") ? "CCodex uninstalled and state purged.\n" : `CCodex uninstalled; state preserved in ${layout.state}.\n`);
  return 0;
}

export function ensureInstallLayout(): void {
  ensureLayout(installLayout());
}
