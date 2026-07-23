import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, type InstallLayout } from "../management/layout.js";

export const LAUNCH_AGENT_LABEL = "dev.ccodex.gateway";
export const CODEX_CLI_PATH_LABEL = "dev.ccodex.codex-cli-path";
export const CODEX_CLI_PATH_ENV = "CODEX_CLI_PATH";
const LAUNCHCTL = "/bin/launchctl";
const MANAGED_MARKER = "Managed by CCodex — run 'ccodex uninstall' to remove.";

export interface LaunchAgentInstall {
  readonly path: string;
  readonly label: string;
  readonly socket: string;
}

interface AgentRef {
  readonly path: string;
  readonly label: string;
}

export interface LaunchctlResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LaunchctlRuntime {
  readonly run: (args: readonly string[]) => LaunchctlResult;
}

export const systemLaunchctl: LaunchctlRuntime = {
  run: (args) => {
    const result = spawnSync("launchctl", args, { encoding: "utf8" });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  },
};

function currentUid(): number {
  return process.getuid?.() ?? 0;
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>]/gu, (character) =>
    character === "&" ? "&amp;" : character === "<" ? "&lt;" : "&gt;");
}

function renderPlist(options: {
  readonly label: string;
  readonly programArguments: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly runAtLoad: boolean;
  readonly keepAlive: boolean;
}): string {
  const args = options.programArguments.map((value) => `    <string>${xmlEscape(value)}</string>`).join("\n");
  const environment = options.environment
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${
      Object.entries(options.environment)
        .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
        .join("\n")
    }\n  </dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MANAGED_MARKER} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${environment}  <key>RunAtLoad</key>
  <${options.runAtLoad}/>
  <key>KeepAlive</key>
  <${options.keepAlive}/>
</dict>
</plist>
`;
}

export function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

export function codexCliPathAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${CODEX_CLI_PATH_LABEL}.plist`);
}

export function desktopPlist(layout: InstallLayout, socket: string): string {
  return renderPlist({
    label: LAUNCH_AGENT_LABEL,
    programArguments: [join(layout.bin, "ccodex"), "app-server", "--remote-control", "--listen", `unix://${socket}`],
    environment: { CCODEX_HOME: layout.home, CODEX_HOME: codexHome() },
    runAtLoad: true,
    keepAlive: true,
  });
}

export function codexCliPathPlist(entryShimPath: string): string {
  // A one-shot login agent (KeepAlive=false) that publishes CODEX_CLI_PATH into the GUI
  // launchd session so Finder/Dock-launched Codex App instances reach bin/codex-desktop.
  return renderPlist({
    label: CODEX_CLI_PATH_LABEL,
    programArguments: [LAUNCHCTL, "setenv", CODEX_CLI_PATH_ENV, entryShimPath],
    runAtLoad: true,
    keepAlive: false,
  });
}

function isOwnedPlist(path: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").includes(MANAGED_MARKER);
}

export function bootoutLaunchAgent(ref: AgentRef, runtime: LaunchctlRuntime = systemLaunchctl): void {
  // Ignore the status: launchctl reports failure when the label is not loaded.
  runtime.run(["bootout", `gui/${currentUid()}/${ref.label}`]);
}

export function bootstrapLaunchAgent(ref: AgentRef, runtime: LaunchctlRuntime = systemLaunchctl, kickstart = true): void {
  const domain = `gui/${currentUid()}`;
  const bootstrap = runtime.run(["bootstrap", domain, ref.path]);
  if (bootstrap.status !== 0) {
    // Older launchd releases lack bootstrap/bootout; fall back to load/unload.
    runtime.run(["unload", ref.path]);
    const load = runtime.run(["load", ref.path]);
    if (load.status !== 0) {
      throw new Error(`launchctl could not load ${ref.path}: ${(bootstrap.stderr || load.stderr).trim()}`);
    }
  }
  // Force a clean (re)start so a KeepAlive agent owns its socket immediately.
  if (kickstart) runtime.run(["kickstart", "-k", `${domain}/${ref.label}`]);
}

export function setCodexCliPathEnv(entryShimPath: string, runtime: LaunchctlRuntime = systemLaunchctl): void {
  // Best-effort: fails on a session without a GUI launchd domain (SSH/CI); the login
  // agent still republishes it at next login.
  try {
    runtime.run(["setenv", CODEX_CLI_PATH_ENV, entryShimPath]);
  } catch {
    // No GUI launchd session to publish into.
  }
}

export function unsetCodexCliPathEnv(runtime: LaunchctlRuntime = systemLaunchctl): void {
  try {
    runtime.run(["unsetenv", CODEX_CLI_PATH_ENV]);
  } catch {
    // No GUI launchd session; nothing to clear.
  }
}

export function installLaunchAgent(
  layout: InstallLayout,
  socket: string,
  previous?: LaunchAgentInstall,
  runtime: LaunchctlRuntime = systemLaunchctl,
): LaunchAgentInstall {
  const path = launchAgentPath();
  if (previous && existsSync(previous.path) && !isOwnedPlist(previous.path)) {
    throw new Error(`Refusing to overwrite modified managed LaunchAgent ${previous.path}`);
  }
  if (existsSync(path) && !isOwnedPlist(path)) {
    throw new Error(`Refusing to overwrite unmanaged LaunchAgent ${path}`);
  }
  const record: LaunchAgentInstall = { path, label: LAUNCH_AGENT_LABEL, socket };
  atomicWrite(path, desktopPlist(layout, socket), 0o644);
  bootoutLaunchAgent(record, runtime);
  bootstrapLaunchAgent(record, runtime);
  return record;
}

export function uninstallLaunchAgent(record: LaunchAgentInstall, runtime: LaunchctlRuntime = systemLaunchctl): boolean {
  if (!existsSync(record.path)) return true;
  if (!isOwnedPlist(record.path)) return false;
  bootoutLaunchAgent(record, runtime);
  rmSync(record.path, { force: true });
  return true;
}

export function installCliPathAgent(entryShimPath: string, runtime: LaunchctlRuntime = systemLaunchctl): string {
  const path = codexCliPathAgentPath();
  if (existsSync(path) && !isOwnedPlist(path)) {
    throw new Error(`Refusing to overwrite unmanaged LaunchAgent ${path}`);
  }
  atomicWrite(path, codexCliPathPlist(entryShimPath), 0o644);
  const ref: AgentRef = { path, label: CODEX_CLI_PATH_LABEL };
  bootoutLaunchAgent(ref, runtime);
  bootstrapLaunchAgent(ref, runtime, false);
  return path;
}

export function uninstallCliPathAgent(path: string, runtime: LaunchctlRuntime = systemLaunchctl): boolean {
  if (!existsSync(path)) return true;
  if (!isOwnedPlist(path)) return false;
  bootoutLaunchAgent({ path, label: CODEX_CLI_PATH_LABEL }, runtime);
  rmSync(path, { force: true });
  return true;
}
