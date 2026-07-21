import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, readFileSync, readlinkSync, rmSync, statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { atomicSymlink, atomicWrite, ensureLayout, installLayout } from "./layout.js";
import { readInstallManifest, setup, type InstallManifest } from "./setup.js";
import { reconcileManagedProcess } from "../daemon/supervisor.js";
import { uninstallRemoteCodexShim } from "./remoteShim.js";

const execute = promisify(execFile);
const BEGIN = "# >>> ccodex >>>";
const END = "# <<< ccodex <<<";

function posixBlock(layout: ReturnType<typeof installLayout>): string {
  return `${BEGIN}\nexport PATH="${layout.bin}:$PATH"\n${END}\n`;
}

function fishBlock(layout: ReturnType<typeof installLayout>): string {
  return `${BEGIN}\nfish_add_path --move --prepend "${layout.bin}"\n${END}\n`;
}

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

async function daemon(layout: ReturnType<typeof installLayout>, version: string, operation: "restart" | "stop"): Promise<void> {
  const command = join(layout.versions, version, "node_modules", ".bin", "ccodex");
  await execute(command, ["app-server", "daemon", operation], { timeout: 90_000, maxBuffer: 512 * 1024 });
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
  const daemonWasRunning = Boolean(reconcileManagedProcess(daemonPidFile()));
  atomicSymlink(join("versions", previous), layout.current);
  atomicSymlink(join("versions", current), layout.previous);
  try {
    if (daemonWasRunning) await daemon(layout, previous, "restart");
    const next: InstallManifest = { ...manifest, activeVersion: previous, previousVersion: current };
    atomicWrite(layout.manifest, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  } catch (error) {
    atomicSymlink(join("versions", current), layout.current);
    atomicSymlink(join("versions", previous), layout.previous);
    await daemon(layout, current, "restart").catch(() => undefined);
    throw error;
  }
  process.stdout.write(`CCodex rolled back from ${current} to ${previous}.\n`);
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
  if (!content.includes(block)) return false;
  const mode = statSync(path).mode & 0o777;
  atomicWrite(path, content.replace(block, ""), mode);
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
  if (existsSync(daemonPidFile()) || existsSync(`${publicSocket}.ccodex-owner.json`)) {
    await daemon(layout, manifest.activeVersion, "stop");
  }

  const preserved: string[] = [];
  for (const path of manifest.managedShellFiles) {
    if (!removeManagedShellFile(path, layout)) preserved.push(path);
  }
  if (manifest.remoteCodexShim && !uninstallRemoteCodexShim(manifest.remoteCodexShim)) {
    preserved.push(manifest.remoteCodexShim.path);
  }
  for (const [name, expected] of Object.entries(manifest.shimHashes)) {
    const path = join(layout.bin, name);
    if (!existsSync(path)) continue;
    if (hashFile(path) === expected) rmSync(path);
    else preserved.push(path);
  }
  for (const path of [layout.current, layout.previous, layout.versions, layout.staging, layout.manifest]) {
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
