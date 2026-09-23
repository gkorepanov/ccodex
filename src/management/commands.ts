import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { delegate } from "../cli/delegate.js";
import { defaultConfigToml, productHome, type Config } from "../config.js";
import { probeAppServer } from "../daemon/probe.js";
import { reconcileManagedProcess, stopManagedProcess } from "../daemon/supervisor.js";
import { reconcileOwnedGateway, stopSocketOwner } from "../daemon/ownership.js";
import { installCliPathAgent, uninstallCliPathAgent, type CliPathAgentInstall } from "../desktop/launchAgent.js";
import { relayBinary } from "../gateway/remote.js";
import { atomicSymlink, atomicWrite } from "./files.js";
import { compareSemver } from "./shimSelect.js";

const execute = promisify(execFile);
const PACKAGE = "@gkorepanov/ccodex";
const BEGIN = "# >>> ccodex >>>";
const END = "# <<< ccodex <<<";

/** `~/.ccodex/install.json`, kept compatible with 0.4 so upgrades and uninstall keep working. */
interface Manifest {
  readonly schemaVersion: 1;
  readonly package: typeof PACKAGE;
  readonly activeVersion: string;
  readonly delegateCodex?: string | null;
  readonly publicSocket?: string;
  readonly managedShellFiles: string[];
  readonly shimHashes: Record<string, string>;
  readonly remoteCodexShim?: { path: string; target: string; backupPath?: string };
  readonly desktopCliPath?: CliPathAgentInstall;
  readonly nodeExecutable: string;
  readonly installedAt: string;
}

const layout = () => {
  const home = productHome();
  return {
    home, bin: join(home, "bin"), versions: join(home, "versions"), state: join(home, "state"),
    current: join(home, "current"), manifest: join(home, "install.json"),
  };
};

export function packageVersion(): string {
  return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

function readManifest(): Manifest | undefined {
  const path = layout().manifest;
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Manifest : undefined;
}

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

function shim(name: "codex" | "ccodex", node: string): string {
  const prelude = `#!/bin/sh
set -eu
if [ "\${CCODEX_SHIM_ACTIVE:-}" = 1 ]; then
  printf '%s\\n' 'CCodex recursion guard: managed shim attempted to invoke itself.' >&2
  exit 70
fi
CCODEX_SHIM_ACTIVE=1
CCODEX_HOME=\${CCODEX_HOME:-"$HOME/.ccodex"}
CCODEX_NODE=${quote(node)}
if [ ! -x "$CCODEX_NODE" ]; then
  CCODEX_NODE=$(command -v node 2>/dev/null || true)
fi
if [ -z "$CCODEX_NODE" ] || [ ! -x "$CCODEX_NODE" ]; then
  printf '%s\\n' 'CCodex Node runtime is missing. Reinstall Node.js, then run: npm install -g ${PACKAGE} && ccodex setup' >&2
  exit 69
fi
export CCODEX_SHIM_ACTIVE CCODEX_HOME
`;
  const current = `exec "$CCODEX_NODE" "$CCODEX_HOME/current/node_modules/${PACKAGE}/dist/cli/main.js" "$@"\n`;
  if (name === "codex") return `${prelude}${current}`;
  // Management commands prefer a newer globally installed package (npm i -g → ccodex setup).
  return `${prelude}case "\${1:-}" in
  setup|update|uninstall|doctor|auth)
    global_package="$(npm root -g 2>/dev/null || true)/${PACKAGE}"
    if [ -f "$global_package/dist/cli/main.js" ] && "$CCODEX_NODE" "$global_package/dist/management/shimSelect.js" "$CCODEX_HOME/current/node_modules/${PACKAGE}/package.json"; then
      exec "$CCODEX_NODE" "$global_package/dist/cli/main.js" "$@"
    fi
    ;;
esac
${current}`;
}

function shellBlock(fish: boolean, bin: string): string {
  const cliPath = process.platform === "darwin"
    ? fish ? `set -gx CODEX_CLI_PATH "${bin}/codex"\n` : `export CODEX_CLI_PATH="${bin}/codex"\n`
    : "";
  return `${BEGIN}\n${fish ? `fish_add_path --move --prepend "${bin}"` : `export PATH="${bin}:$PATH"`}\n${cliPath}${END}\n`;
}

const BLOCK_PATTERN = new RegExp(`${BEGIN}\\n[\\s\\S]*?${END}\\n?`, "u");

function shellFiles(): string[] {
  const home = homedir();
  const login = existsSync(join(home, ".bash_profile")) ? join(home, ".bash_profile") : join(home, ".profile");
  return [login, join(home, ".bashrc"), join(home, ".zprofile"), join(home, ".zshrc"), join(home, ".config", "fish", "config.fish")];
}

function writeShellBlock(path: string, bin: string): void {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block = shellBlock(path.endsWith(".fish"), bin);
  const next = BLOCK_PATTERN.test(existing)
    ? existing.replace(BLOCK_PATTERN, block)
    : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${block}`;
  if (next !== existing) atomicWrite(path, next, existsSync(path) ? statSync(path).mode & 0o777 : 0o600);
}

/** `~/.local/bin/codex` → the managed shim, so SSH Desktop sessions (which use that path) reach CCodex. */
function installRemoteShim(home: string, bin: string, previous: Manifest["remoteCodexShim"]): Manifest["remoteCodexShim"] {
  const path = join(resolve(process.env.CODEX_INSTALL_DIR ?? join(homedir(), ".local", "bin")), "codex");
  const target = join(bin, "codex");
  if (path === target) return undefined;
  let backupPath = previous?.backupPath;
  const ours = existsSync(path) && lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === target;
  if (existsSync(path) && !ours && !backupPath) {
    backupPath = join(home, "backups", "remote-codex");
    mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
    renameSync(path, backupPath);
  }
  mkdirSync(dirname(path), { recursive: true });
  atomicSymlink(target, path);
  return { path, target, ...(backupPath ? { backupPath } : {}) };
}

export async function setup(args: readonly string[]): Promise<number> {
  if (process.getuid?.() === 0) throw new Error("Do not run CCodex setup as root or with sudo.");
  const versionIndex = args.indexOf("--version");
  const version = versionIndex >= 0 ? args[versionIndex + 1] : packageVersion();
  if (!version) throw new Error("Usage: ccodex setup [--version VERSION] [--repair]");
  const paths = layout();
  for (const directory of [paths.home, paths.bin, paths.versions, paths.state]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(paths.versions, version);
  if (!existsSync(target) || args.includes("--repair")) {
    const temporary = `${target}.installing-${process.pid}`;
    rmSync(temporary, { recursive: true, force: true });
    // Dev builds (never published) come as tarballs: the package and its platform relay package.
    const specs = [process.env.CCODEX_PACKAGE_SPEC ?? `${PACKAGE}@${version}`, ...(process.env.CCODEX_RELAY_PACKAGE_SPEC ? [process.env.CCODEX_RELAY_PACKAGE_SPEC] : [])];
    process.stdout.write(`Installing ${specs.join(" ")} into ${target}\n`);
    await execute("npm", ["install", "--prefix", temporary, "--include=optional", "--ignore-scripts", "--save=false", "--no-audit", "--no-fund", ...specs], {
      timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024,
    });
    rmSync(target, { recursive: true, force: true });
    renameSync(temporary, target);
  }
  // The version being activated finishes its own setup (shims and layout are its business).
  if (version !== packageVersion()) {
    const cli = join(target, "node_modules", PACKAGE, "dist", "cli", "main.js");
    const child = spawn(process.execPath, [cli, "setup", "--version", version], { stdio: "inherit" });
    return new Promise((done, fail) => {
      child.once("error", fail);
      child.once("exit", (code) => done(code ?? 1));
    });
  }
  const previous = readManifest();
  atomicSymlink(join("versions", version), paths.current);
  const shimHashes: Record<string, string> = {};
  for (const name of ["codex", "ccodex"] as const) {
    const content = shim(name, process.execPath);
    atomicWrite(join(paths.bin, name), content, 0o755);
    shimHashes[name] = sha256(content);
  }
  const managedShellFiles = shellFiles();
  for (const path of managedShellFiles) writeShellBlock(path, paths.bin);
  const remoteCodexShim = installRemoteShim(paths.home, paths.bin, previous?.remoteCodexShim);
  const configPath = join(paths.home, "config.toml");
  if (!existsSync(configPath)) atomicWrite(configPath, defaultConfigToml(), 0o600);
  const desktopCliPath = process.platform === "darwin" ? installCliPathAgent(join(paths.bin, "codex"), previous?.desktopCliPath) : undefined;
  const manifest: Manifest = {
    schemaVersion: 1,
    package: PACKAGE,
    activeVersion: version,
    delegateCodex: previous?.delegateCodex ?? null,
    publicSocket: previous?.publicSocket ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-control", "app-server-control.sock"),
    managedShellFiles,
    shimHashes,
    ...(remoteCodexShim ? { remoteCodexShim } : {}),
    ...(desktopCliPath ? { desktopCliPath } : {}),
    nodeExecutable: process.execPath,
    installedAt: new Date().toISOString(),
  };
  atomicWrite(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  // Old versions stay only as long as they are the one just replaced.
  for (const name of readdirSync(paths.versions)) {
    if (name !== version && name !== previous?.activeVersion) rmSync(join(paths.versions, name), { recursive: true, force: true });
  }
  for (const stale of ["staging", "previous"]) rmSync(join(paths.home, stale), { recursive: true, force: true });
  process.stdout.write(`CCodex ${version} activated. Restart the gateway: codex app-server daemon restart\n`
    + `Open a new shell or run: export PATH="${paths.bin}:$PATH"\n`);
  return 0;
}

export async function update(args: readonly string[]): Promise<number> {
  const channel = args.includes("--next") ? "next" : "latest";
  const { stdout } = await execute("npm", ["view", PACKAGE, `dist-tags.${channel}`, "--json"], { timeout: 30_000 });
  const latest = JSON.parse(stdout) as string;
  const current = readManifest()?.activeVersion;
  if (current && compareSemver(latest, current) <= 0) {
    process.stdout.write(`CCodex ${current} is current.\n`);
    return 0;
  }
  if (args.includes("--check")) {
    process.stdout.write(`CCodex ${latest} is available (current: ${current ?? "none"}).\n`);
    return 0;
  }
  return setup(["--version", latest]);
}

export async function uninstall(args: readonly string[]): Promise<number> {
  const purge = args.includes("--purge");
  if (purge && !args.includes("--yes")) throw new Error("Purging removes all CCodex state. Confirm with: ccodex uninstall --purge --yes");
  const paths = layout();
  const manifest = readManifest();
  if (!manifest) throw new Error("CCodex is not activated.");
  const pidFile = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-daemon", "app-server.pid");
  const managed = reconcileManagedProcess(pidFile);
  if (managed) await stopManagedProcess(pidFile, managed);
  else if (manifest.publicSocket) {
    const owner = reconcileOwnedGateway(manifest.publicSocket);
    if (owner) await stopSocketOwner(manifest.publicSocket, owner);
  }
  for (const path of manifest.managedShellFiles) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    if (BLOCK_PATTERN.test(content)) atomicWrite(path, content.replace(BLOCK_PATTERN, ""), statSync(path).mode & 0o777);
  }
  const remote = manifest.remoteCodexShim;
  if (remote && existsSync(remote.path) && lstatSync(remote.path).isSymbolicLink()) {
    rmSync(remote.path);
    if (remote.backupPath && existsSync(remote.backupPath)) renameSync(remote.backupPath, remote.path);
  }
  if (manifest.desktopCliPath) uninstallCliPathAgent(manifest.desktopCliPath);
  for (const name of Object.keys(manifest.shimHashes)) rmSync(join(paths.bin, name), { force: true });
  for (const path of [paths.current, join(paths.home, "previous"), paths.versions, join(paths.home, "staging"), paths.manifest, paths.bin]) {
    rmSync(path, { recursive: true, force: true });
  }
  if (purge) rmSync(paths.home, { recursive: true, force: true });
  process.stdout.write(purge ? "CCodex uninstalled and state purged.\n" : `CCodex uninstalled; state kept in ${paths.state}.\n`);
  return 0;
}

async function version(command: string, args: readonly string[]): Promise<string> {
  const { stdout, stderr } = await execute(command, args, { timeout: 15_000 });
  return `${stdout}${stderr}`.trim().split("\n")[0]!;
}

/** Minimal health report: runtimes, auth, relay, gateway. */
export async function doctor(config: Config, json: boolean): Promise<number> {
  const check = async (id: string, run: () => Promise<string> | string): Promise<{ id: string; ok: boolean; detail: string }> => {
    try {
      return { id, ok: true, detail: await run() };
    } catch (error) {
      return { id, ok: false, detail: error instanceof Error ? error.message.split("\n")[0]! : String(error) };
    }
  };
  const checks = await Promise.all([
    check("node", () => process.version),
    check("codex", async () => `${config.codex} (${await version(config.codex, ["--version"])})`),
    check("codex-auth", async () => {
      const status = await version(config.codex, ["login", "status"]);
      if (/not logged in/iu.test(status)) throw new Error(`${status} → run: ccodex auth codex`);
      return status;
    }),
    check("claude", async () => `${config.claudeBinary} (${await version(config.claudeBinary, ["--version"])})`),
    check("claude-auth", async () => {
      const { stdout } = await execute(config.claudeBinary, ["auth", "status", "--json"], { timeout: 15_000 }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "{}" }));
      const status = JSON.parse(stdout || "{}") as { loggedIn?: boolean; email?: string; authMethod?: string };
      if (!status.loggedIn) throw new Error("not logged in → run: ccodex auth claude");
      return `${status.email ?? "logged in"} (${status.authMethod ?? "unknown"})`;
    }),
    check("relay", () => {
      const binary = relayBinary();
      if (!existsSync(binary)) throw new Error(`missing: ${binary}`);
      return binary;
    }),
    check("gateway", async () => {
      await probeAppServer(config.publicSocket);
      return `listening on ${config.publicSocket}`;
    }),
    check("install", () => {
      const manifest = readManifest();
      if (!manifest) throw new Error("not activated → run: ccodex setup");
      return `${manifest.activeVersion} (${basename(readlinkSync(layout().current))})`;
    }),
  ]);
  if (json) process.stdout.write(`${JSON.stringify({ ok: checks.every((item) => item.ok || item.id === "gateway"), checks }, null, 2)}\n`);
  else for (const item of checks) process.stdout.write(`${item.ok ? "✓" : "✗"} ${item.id}: ${item.detail}\n`);
  return checks.every((item) => item.ok || item.id === "gateway") ? 0 : 1;
}

export async function runManagementCommand(args: readonly string[], config: () => Config): Promise<number | undefined> {
  switch (args[0]) {
    case "setup": return setup(args.slice(1));
    case "update": return update(args.slice(1));
    case "uninstall": return uninstall(args.slice(1));
    case "doctor": return doctor(config(), args.includes("--json"));
    case "auth":
      if (args[1] === "codex") return delegate(config().codex, ["login"]);
      if (args[1] === "claude") return delegate(config().claudeBinary, ["auth", "login"]);
      throw new Error("Usage: ccodex auth codex|claude");
    default: return undefined;
  }
}

