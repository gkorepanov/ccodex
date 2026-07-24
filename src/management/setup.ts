import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, statSync,
  unlinkSync, realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { compatibilityManifest } from "../compatibility/probe.js";
import { defaultConfigToml, delegatedCodexExecutable, loadConfig } from "../config/config.js";
import { pinnedCodexExecutable, runtimePlatformKey } from "../runtime/dependencies.js";
import { probeAppServer } from "../daemon/probe.js";
import { reconcileManagedProcess, stopManagedProcess } from "../daemon/supervisor.js";
import { daemonStateDirectory } from "../daemon/supervisor.js";
import { loadDaemonSettings } from "../daemon/settings.js";
import { atomicSymlink, atomicWrite, ensureLayout, installLayout, type InstallLayout } from "./layout.js";
import {
  fishManagedBlock as fishBlock, MANAGED_BLOCK_BEGIN as BEGIN,
  legacyFishManagedBlock as oldFishBlock, legacyPosixManagedBlock as legacyPosixBlock,
  posixManagedBlock as posixBlock,
} from "./shellRouting.js";
import {
  installManagedShims, restoreManagedShims, type ManagedShimChange,
} from "./shims.js";
import {
  installRemoteCodexShim, relocatedDelegate, restoreRemoteCodexShim, type RemoteCodexShim,
} from "./remoteShim.js";
import {
  installDesktopApp, restoreDesktopApp, type DesktopAppInstall,
} from "../desktop/install.js";

const execute = promisify(execFile);

interface ShellRouting {
  readonly managed: string[];
  readonly changed: Array<{ readonly path: string; readonly content?: string; readonly mode: number }>;
}

export interface InstallManifest {
  readonly schemaVersion: 1;
  readonly method: "npm" | "curl" | "migrated-local";
  readonly package: "@gkorepanov/ccodex";
  readonly activeVersion: string;
  readonly previousVersion: string | null;
  readonly delegateCodex?: string | null;
  readonly publicSocket?: string;
  readonly managedShellFiles: string[];
  readonly shimHashes: Readonly<Record<string, string>>;
  readonly remoteCodexShim?: RemoteCodexShim;
  readonly desktopApp?: DesktopAppInstall;
  readonly desktopAppActive?: boolean;
  readonly nodeExecutable?: string;
  readonly platformPackage: string;
  readonly compatibility: ReturnType<typeof compatibilityManifest>;
  readonly doctor: { readonly ok: true; readonly checkedAt: string };
  readonly installedAt: string;
}

function packageVersion(): string {
  return compatibilityManifest().productVersion;
}

async function npmStage(destination: string, version = packageVersion()): Promise<void> {
  const main = process.env.CCODEX_PACKAGE_SPEC ?? `@gkorepanov/ccodex@${version}`;
  const specs = [main, ...(process.env.CCODEX_RELAY_PACKAGE_SPEC ? [process.env.CCODEX_RELAY_PACKAGE_SPEC] : [])];
  await execute("npm", ["install", "--prefix", destination, "--include=optional", "--ignore-scripts", "--save=false", ...specs], {
    timeout: 20 * 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function stagedDoctor(staged: string, layout: InstallLayout): Promise<void> {
  const command = join(staged, "node_modules", ".bin", "ccodex");
  if (!existsSync(command)) throw new Error(`Staged CCodex executable is missing: ${command}`);
  try {
    const { stdout } = await execute(command, ["doctor", "--json"], {
      env: { ...process.env, CCODEX_HOME: layout.home, CCODEX_DATA_DIR: layout.state },
      timeout: 30_000,
      maxBuffer: 512 * 1024,
    });
    const result = JSON.parse(stdout) as {
      ok?: boolean;
      checks?: Array<{ id?: string; status?: string; detected?: string; repair?: string }>;
    };
    if (!result.ok) throw new Error(stdout);
    for (const warning of result.checks?.filter((item) => item.status === "warning") ?? []) {
      process.stderr.write(
        `CCodex setup warning: ${warning.id ?? "provider"}: ${warning.detected ?? "unavailable"}`
        + `${warning.repair ? `\n  Run: ${warning.repair}` : ""}\n`,
      );
    }
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    let detail = String(error);
    if (stdout) {
      try { detail = JSON.stringify(JSON.parse(stdout), null, 2); } catch { detail = stdout; }
    }
    throw new Error(`Staged CCodex doctor failed. Nothing was activated.\n${detail}`);
  }
}

async function startupSmoke(staged: string, layout: InstallLayout): Promise<void> {
  if (process.env.CCODEX_SKIP_STARTUP_SMOKE === "1") return;
  const command = join(staged, "node_modules", ".bin", "ccodex");
  const socket = join(layout.staging, `smoke-${process.pid}.sock`);
  rmSync(socket, { force: true });
  const detached = process.platform !== "win32";
  const child = spawn(command, ["app-server", "--listen", `unix://${socket}`], {
    env: { ...process.env, CCODEX_HOME: layout.home, CCODEX_DATA_DIR: layout.state },
    detached,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const signal = (name: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (detached) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      // The smoke process group already exited.
    }
  };
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
  try {
    const deadline = Date.now() + 20_000;
    let failure: unknown;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`gateway exited ${child.exitCode}: ${stderr}`);
      try {
        await probeAppServer(socket);
        return;
      } catch (error) {
        failure = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error(`gateway did not become ready: ${String(failure)}\n${stderr}`);
  } finally {
    if (child.exitCode === null) signal("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else {
        const timer = setTimeout(() => { signal("SIGKILL"); resolve(); }, 5_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      }
    });
    if (detached) signal("SIGKILL");
    rmSync(socket, { force: true });
    rmSync(`${socket}.ccodex-owner.json`, { force: true });
  }
}

function stagedCompatibility(staged: string): ReturnType<typeof compatibilityManifest> {
  const path = join(staged, "node_modules", "@gkorepanov", "ccodex", "config", "compatibility.json");
  const value = JSON.parse(readFileSync(path, "utf8")) as ReturnType<typeof compatibilityManifest>;
  return value;
}

function migrateLegacyState(layout: InstallLayout): void {
  const legacy = join(homedir(), ".codex-hybrid");
  if (!existsSync(legacy) || existsSync(join(layout.state, "state.sqlite"))) return;
  for (const name of [
    "state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "state.sqlite.bak",
    "handoffs.sqlite", "handoffs.sqlite-wal", "handoffs.sqlite-shm", "cursor.key",
    "rpc.jsonl", "rpc.jsonl.1", "debug.jsonl",
  ]) {
    const source = join(legacy, name);
    if (existsSync(source)) cpSync(source, join(layout.state, name), { preserveTimestamps: true });
  }
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validateManagedBlock(path: string, desired: string, legacy: string): void {
  if (!existsSync(path)) return;
  const existing = readFileSync(path, "utf8");
  if (!existing.includes(BEGIN) || existing.includes(desired) || existing.includes(legacy)) return;
  throw new Error(`Refusing to overwrite a modified CCodex block in ${path}`);
}

function installManagedBlock(
  path: string,
  desired: string,
  legacy: string,
): { readonly path: string; readonly content?: string; readonly mode: number } | undefined {
  const existed = existsSync(path);
  const existing = existed ? readFileSync(path, "utf8") : "";
  if (existing.includes(desired)) return undefined;
  const mode = existed ? statSync(path).mode & 0o777 : 0o600;
  const next = existing.includes(legacy)
    ? existing.replace(legacy, desired)
    : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${desired}`;
  atomicWrite(path, next, mode);
  return { path, ...(existed ? { content: existing } : {}), mode };
}

function installShellPaths(layout: InstallLayout): ShellRouting {
  const home = homedir();
  const shellBlock = posixBlock(layout);
  const oldShellBlock = legacyPosixBlock(layout);
  const bashLogin = existsSync(join(home, ".bash_profile")) ? join(home, ".bash_profile") : join(home, ".profile");
  const files = [bashLogin, join(home, ".bashrc"), join(home, ".zprofile"), join(home, ".zshrc")];
  for (const path of files) validateManagedBlock(path, shellBlock, oldShellBlock);
  const fish = join(home, ".config", "fish", "config.fish");
  const fishConfigBlock = fishBlock(layout);
  const oldFishConfigBlock = oldFishBlock(layout);
  validateManagedBlock(fish, fishConfigBlock, oldFishConfigBlock);
  const legacyFish = join(home, ".config", "fish", "conf.d", "ccodex.fish");
  const legacyFishFileBlock = `# Managed by CCodex.\nfish_add_path --prepend "${layout.bin}"\n`;
  if (existsSync(legacyFish) && readFileSync(legacyFish, "utf8") !== legacyFishFileBlock) {
    throw new Error(`Refusing to overwrite ${legacyFish}`);
  }

  const changed: Array<{ readonly path: string; readonly content?: string; readonly mode: number }> = [];
  try {
    for (const path of files) {
      const change = installManagedBlock(path, shellBlock, oldShellBlock);
      if (change) changed.push(change);
    }
    const fishChange = installManagedBlock(fish, fishConfigBlock, oldFishConfigBlock);
    if (fishChange) changed.push(fishChange);
    return {
      managed: [...files, fish, ...(existsSync(legacyFish) ? [legacyFish] : [])],
      changed,
    };
  } catch (error) {
    removeFirstInstallRouting(layout, changed, {});
    throw error;
  }
}

function removeFirstInstallRouting(
  layout: InstallLayout,
  changed: ReadonlyArray<{ readonly path: string; readonly content?: string; readonly mode: number }>,
  hashes: Readonly<Record<string, string>>,
): void {
  for (const change of [...changed].reverse()) {
    if (change.content === undefined) rmSync(change.path, { force: true });
    else atomicWrite(change.path, change.content, change.mode);
  }
  for (const [name, hash] of Object.entries(hashes)) {
    const path = join(layout.bin, name);
    if (existsSync(path) && hashFile(path) === hash) rmSync(path);
  }
}

async function verifyShellPaths(layout: InstallLayout): Promise<void> {
  const configured = process.env.SHELL;
  const shell = configured && ["bash", "zsh", "fish"].includes(basename(configured)) ? configured : "/bin/sh";
  const { stdout } = await execute(shell, ["-lc", "command -v codex"], { timeout: 10_000, maxBuffer: 64 * 1024 });
  if (stdout.trim() !== join(layout.bin, "codex")) {
    throw new Error(`${shell} resolves codex to '${stdout.trim()}', expected '${join(layout.bin, "codex")}'`);
  }
}

function removeActivationLink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(`CCodex rollback could not remove ${path}: ${String(error)}\n`);
    }
  }
}

export function readInstallManifest(layout = installLayout()): InstallManifest | undefined {
  return existsSync(layout.manifest) ? JSON.parse(readFileSync(layout.manifest, "utf8")) as InstallManifest : undefined;
}

export function activeVersion(layout: InstallLayout): string | null {
  if (!existsSync(layout.current) || !lstatSync(layout.current).isSymbolicLink()) return null;
  return basename(readlinkSync(layout.current));
}

export function installInitialConfig(layout: InstallLayout): boolean {
  const path = join(layout.home, "config.toml");
  if (existsSync(path)) return false;
  atomicWrite(path, defaultConfigToml(), 0o600);
  return true;
}

export function activate(layout: InstallLayout, version: string): string | null {
  const previous = activeVersion(layout);
  if (previous && previous !== version) atomicSymlink(join("versions", previous), layout.previous);
  atomicSymlink(join("versions", version), layout.current);
  return previous;
}

function daemonPidFile(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-daemon", "app-server.pid");
}

async function replaceRunningDaemon(layout: InstallLayout, version: string): Promise<void> {
  const command = join(
    layout.versions, version, "node_modules", "@gkorepanov", "ccodex", "dist", "cli", "main.js",
  );
  await execute(process.execPath, [command, "app-server", "daemon", "restart"], {
    timeout: 90_000,
    maxBuffer: 512 * 1024,
  });
}

async function stopDaemon(layout: InstallLayout, version: string): Promise<void> {
  const command = join(
    layout.versions, version, "node_modules", "@gkorepanov", "ccodex", "dist", "cli", "main.js",
  );
  await execute(process.execPath, [command, "app-server", "daemon", "stop"], {
    timeout: 90_000,
    maxBuffer: 512 * 1024,
  });
}

export async function setup(args: readonly string[]): Promise<number> {
  if (process.getuid?.() === 0) throw new Error("Do not run CCodex setup as root or with sudo.");
  const stagedIndex = args.indexOf("--staged");
  const supplied = stagedIndex >= 0 ? args[stagedIndex + 1] : undefined;
  const versionIndex = args.indexOf("--version");
  const requestedVersion = versionIndex >= 0 ? args[versionIndex + 1] : packageVersion();
  const valued = new Set([stagedIndex + 1, versionIndex + 1]);
  const unexpected = args.filter((arg, index) => !valued.has(index) && !["--repair", "--staged", "--version"].includes(arg));
  if (unexpected.length > 0 || (stagedIndex >= 0 && !supplied) || !requestedVersion) {
    throw new Error("Usage: ccodex setup [--repair] [--staged PATH] [--version VERSION]");
  }

  const layout = installLayout();
  ensureLayout(layout);
  migrateLegacyState(layout);
  const discoveredDelegate = delegatedCodexExecutable(layout.home, pinnedCodexExecutable());
  let delegateCodex = discoveredDelegate ? realpathSync(discoveredDelegate) : undefined;
  const publicSocket = loadConfig().publicSocket;
  const versionPath = join(layout.versions, requestedVersion);
  const repairExisting = args.includes("--repair") && existsSync(versionPath);
  let staged = repairExisting ? versionPath : supplied ? resolve(supplied) : join(layout.staging, `${requestedVersion}-${process.pid}`);
  if (!repairExisting && !supplied) {
    rmSync(staged, { recursive: true, force: true });
    await npmStage(staged, requestedVersion);
  }
  await stagedDoctor(staged, layout);
  await startupSmoke(staged, layout);
  const compatibility = stagedCompatibility(staged);
  if (compatibility.productVersion !== requestedVersion) {
    throw new Error(`Staged package is ${compatibility.productVersion}, expected ${requestedVersion}. Nothing was activated.`);
  }

  if (!existsSync(versionPath)) {
    renameSync(staged, versionPath);
    staged = versionPath;
  } else if (relative(versionPath, staged) !== "" && !relative(layout.staging, staged).startsWith("..")) {
    rmSync(staged, { recursive: true, force: true });
  }

  const before = activeVersion(layout);
  const beforePrevious = existsSync(layout.previous) && lstatSync(layout.previous).isSymbolicLink()
    ? readlinkSync(layout.previous)
    : undefined;
  const beforeManifest = existsSync(layout.manifest) ? readFileSync(layout.manifest, "utf8") : undefined;
  const previousManifest = beforeManifest ? JSON.parse(beforeManifest) as InstallManifest : undefined;
  const daemonWasRunning = Boolean(reconcileManagedProcess(daemonPidFile()));
  const gatewayWasRunning = await probeAppServer(publicSocket).then(() => true, () => false);
  let installedShellChanges: ShellRouting["changed"] = [];
  let installedShimChanges: readonly ManagedShimChange[] = [];
  let installedRemoteShim: RemoteCodexShim | undefined;
  let installedDesktopApp: DesktopAppInstall | undefined;
  let daemonReplacementAttempted = false;
  const configPath = join(layout.home, "config.toml");
  let installedConfig = false;
  try {
    const previous = activate(layout, requestedVersion);
    const installedShims = installManagedShims(
      layout.bin,
      process.execPath,
      previousManifest?.shimHashes,
    );
    const shimHashes = installedShims.hashes;
    installedShimChanges = installedShims.changes;
    const shellRouting = installShellPaths(layout);
    installedShellChanges = shellRouting.changed;
    await verifyShellPaths(layout);
    installedRemoteShim = installRemoteCodexShim(layout, previousManifest?.remoteCodexShim);
    delegateCodex = relocatedDelegate(installedRemoteShim, delegateCodex);
    installedConfig = installInitialConfig(layout);
    // The local Codex App only exists on macOS; the LaunchAgent + control socket are
    // never touched elsewhere so Linux/CI stays byte-identical.
    const remoteControlEnabled = loadDaemonSettings(
      join(daemonStateDirectory(), "settings.json"),
    ).remoteControlEnabled;
    const desktopApp = process.platform === "darwin"
      ? installDesktopApp(
        layout,
        publicSocket,
        process.execPath,
        remoteControlEnabled,
        previousManifest?.desktopApp,
      )
      : undefined;
    installedDesktopApp = desktopApp;
    const manifest: InstallManifest = {
      schemaVersion: 1,
      method: supplied ? "curl" : "npm",
      package: "@gkorepanov/ccodex",
      activeVersion: requestedVersion,
      previousVersion: previous,
      delegateCodex: delegateCodex ?? null,
      publicSocket,
      managedShellFiles: shellRouting.managed,
      shimHashes,
      ...(installedRemoteShim ? { remoteCodexShim: installedRemoteShim } : {}),
      ...(desktopApp ? { desktopApp } : {}),
      ...(desktopApp ? { desktopAppActive: true } : {}),
      nodeExecutable: process.execPath,
      platformPackage: compatibility.relayPackages[runtimePlatformKey()] ?? "unsupported",
      compatibility,
      doctor: { ok: true, checkedAt: new Date().toISOString() },
      installedAt: new Date().toISOString(),
    };
    atomicWrite(layout.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    // One lifecycle entrypoint selects launchd on installed macOS hosts and the
    // PID supervisor elsewhere. No setup-specific socket ownership choreography.
    daemonReplacementAttempted = true;
    await replaceRunningDaemon(layout, requestedVersion);
  } catch (error) {
    if (daemonReplacementAttempted) {
      await stopDaemon(layout, requestedVersion).catch(async () => {
        const managed = reconcileManagedProcess(daemonPidFile());
        if (managed) await stopManagedProcess(daemonPidFile(), managed).catch((cleanupError: unknown) => {
          process.stderr.write(`CCodex rollback could not stop partial gateway: ${String(cleanupError)}\n`);
        });
      });
    }
    if (installedConfig) rmSync(configPath, { force: true });
    if (before) {
      atomicSymlink(join("versions", before), layout.current);
      removeFirstInstallRouting(layout, installedShellChanges, {});
      restoreManagedShims(installedShimChanges);
      // Skip the detached-daemon restore when a previous LaunchAgent owns the socket;
      // restoreDesktopApp below reloads it, and a detached daemon would flap against it.
      if ((daemonWasRunning || gatewayWasRunning) && !previousManifest?.desktopApp) {
        await replaceRunningDaemon(layout, before).catch(() => undefined);
      }
    }
    else {
      removeActivationLink(layout.current);
      restoreRemoteCodexShim(installedRemoteShim, previousManifest?.remoteCodexShim);
      removeFirstInstallRouting(layout, installedShellChanges, {});
      restoreManagedShims(installedShimChanges);
    }
    restoreDesktopApp(
      layout,
      installedDesktopApp,
      previousManifest?.desktopApp,
      undefined,
      gatewayWasRunning,
    );
    if (before) restoreRemoteCodexShim(installedRemoteShim, previousManifest?.remoteCodexShim);
    if (beforePrevious) atomicSymlink(beforePrevious, layout.previous);
    else removeActivationLink(layout.previous);
    if (beforeManifest !== undefined) atomicWrite(layout.manifest, beforeManifest, 0o600);
    else rmSync(layout.manifest, { force: true });
    throw error;
  }
  process.stdout.write(`CCodex ${requestedVersion} activated. Open a new shell or run: export PATH="${layout.bin}:$PATH"\n`);
  return 0;
}
