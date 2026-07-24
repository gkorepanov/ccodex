import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, type InstallLayout } from "../management/layout.js";

export const LAUNCH_AGENT_LABEL = "dev.ccodex.gateway";
export const CODEX_CLI_PATH_LABEL = "dev.ccodex.codex-cli-path";
export const CODEX_CLI_PATH_ENV = "CODEX_CLI_PATH";
const LAUNCHCTL = "/bin/launchctl";
export const MANAGED_PLIST_MARKER = "Managed by CCodex — run 'ccodex uninstall' to remove.";

export interface LaunchAgentInstall {
  readonly path: string;
  readonly label: string;
  readonly socket: string;
  readonly nodeExecutable: string;
  readonly remoteControlEnabled: boolean;
  readonly contentHash: string;
}

export interface CliPathAgentInstall {
  readonly path: string;
  readonly label: string;
  readonly entryShimPath: string;
  readonly contentHash: string;
}

export interface AgentRef {
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
    const result = spawnSync(LAUNCHCTL, args, { encoding: "utf8" });
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fileHash(path: string): string {
  return sha256(readFileSync(path, "utf8"));
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
<!-- ${MANAGED_PLIST_MARKER} -->
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

export function managedCliPath(layout: InstallLayout): string {
  return join(
    layout.current,
    "node_modules",
    "@gkorepanov",
    "ccodex",
    "dist",
    "cli",
    "main.js",
  );
}

export function desktopPlist(
  layout: InstallLayout,
  socket: string,
  nodeExecutable: string,
  remoteControlEnabled: boolean,
): string {
  return renderPlist({
    label: LAUNCH_AGENT_LABEL,
    programArguments: [
      nodeExecutable,
      managedCliPath(layout),
      "app-server",
      ...(remoteControlEnabled ? ["--remote-control"] : []),
      "--listen",
      `unix://${socket}`,
    ],
    environment: { CCODEX_HOME: layout.home, CODEX_HOME: codexHome() },
    runAtLoad: true,
    keepAlive: true,
  });
}

export function codexCliPathPlist(entryShimPath: string): string {
  return renderPlist({
    label: CODEX_CLI_PATH_LABEL,
    programArguments: [LAUNCHCTL, "setenv", CODEX_CLI_PATH_ENV, entryShimPath],
    runAtLoad: true,
    keepAlive: false,
  });
}

function assertReplaceable(path: string, desired: string, previousHash?: string): void {
  if (!existsSync(path)) return;
  const current = readFileSync(path, "utf8");
  if (current === desired) return;
  if (previousHash && sha256(current) === previousHash) return;
  throw new Error(`Refusing to overwrite modified or unmanaged LaunchAgent ${path}`);
}

export function launchAgentLoaded(
  label = LAUNCH_AGENT_LABEL,
  runtime: LaunchctlRuntime = systemLaunchctl,
): boolean {
  return runtime.run(["print", `gui/${currentUid()}/${label}`]).status === 0;
}

export function bootoutLaunchAgent(ref: AgentRef, runtime: LaunchctlRuntime = systemLaunchctl): void {
  runtime.run(["bootout", `gui/${currentUid()}/${ref.label}`]);
}

export function bootstrapLaunchAgent(
  ref: AgentRef,
  runtime: LaunchctlRuntime = systemLaunchctl,
  kickstart = true,
): void {
  const domain = `gui/${currentUid()}`;
  const bootstrap = runtime.run(["bootstrap", domain, ref.path]);
  if (bootstrap.status !== 0) {
    runtime.run(["unload", ref.path]);
    const load = runtime.run(["load", ref.path]);
    if (load.status !== 0) {
      throw new Error(`launchctl could not load ${ref.path}: ${(bootstrap.stderr || load.stderr).trim()}`);
    }
  }
  if (kickstart) runtime.run(["kickstart", "-k", `${domain}/${ref.label}`]);
}

export function setCodexCliPathEnv(entryShimPath: string, runtime: LaunchctlRuntime = systemLaunchctl): void {
  const result = runtime.run(["setenv", CODEX_CLI_PATH_ENV, entryShimPath]);
  if (result.status !== 0) throw new Error(`launchctl could not set ${CODEX_CLI_PATH_ENV}: ${result.stderr.trim()}`);
}

export function getCodexCliPathEnv(runtime: LaunchctlRuntime = systemLaunchctl): string | undefined {
  const result = runtime.run(["getenv", CODEX_CLI_PATH_ENV]);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

export function unsetCodexCliPathEnv(runtime: LaunchctlRuntime = systemLaunchctl): void {
  const result = runtime.run(["unsetenv", CODEX_CLI_PATH_ENV]);
  if (result.status !== 0) throw new Error(`launchctl could not unset ${CODEX_CLI_PATH_ENV}: ${result.stderr.trim()}`);
}

export function installLaunchAgent(
  layout: InstallLayout,
  socket: string,
  nodeExecutable: string,
  remoteControlEnabled: boolean,
  previous?: LaunchAgentInstall,
): LaunchAgentInstall {
  const path = launchAgentPath();
  const content = desktopPlist(layout, socket, nodeExecutable, remoteControlEnabled);
  assertReplaceable(path, content, previous?.contentHash);
  atomicWrite(path, content, 0o644);
  return {
    path,
    label: LAUNCH_AGENT_LABEL,
    socket,
    nodeExecutable,
    remoteControlEnabled,
    contentHash: sha256(content),
  };
}

export function uninstallLaunchAgent(
  record: LaunchAgentInstall,
  runtime: LaunchctlRuntime = systemLaunchctl,
): boolean {
  if (!existsSync(record.path)) return true;
  if (fileHash(record.path) !== record.contentHash) return false;
  bootoutLaunchAgent(record, runtime);
  rmSync(record.path, { force: true });
  return true;
}

export function installCliPathAgent(
  entryShimPath: string,
  previous?: CliPathAgentInstall,
  runtime: LaunchctlRuntime = systemLaunchctl,
): CliPathAgentInstall {
  const path = codexCliPathAgentPath();
  const content = codexCliPathPlist(entryShimPath);
  assertReplaceable(path, content, previous?.contentHash);
  const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const wasLoaded = launchAgentLoaded(CODEX_CLI_PATH_LABEL, runtime);
  atomicWrite(path, content, 0o644);
  const record = {
    path,
    label: CODEX_CLI_PATH_LABEL,
    entryShimPath,
    contentHash: sha256(content),
  };
  try {
    bootoutLaunchAgent(record, runtime);
    bootstrapLaunchAgent(record, runtime, false);
    return record;
  } catch (error) {
    if (before === undefined) rmSync(path, { force: true });
    else atomicWrite(path, before, 0o644);
    if (wasLoaded && before !== undefined) {
      bootstrapLaunchAgent({ path, label: CODEX_CLI_PATH_LABEL }, runtime, false);
    }
    throw error;
  }
}

export function uninstallCliPathAgent(
  record: CliPathAgentInstall,
  runtime: LaunchctlRuntime = systemLaunchctl,
): boolean {
  if (!existsSync(record.path)) return true;
  if (fileHash(record.path) !== record.contentHash) return false;
  bootoutLaunchAgent(record, runtime);
  rmSync(record.path, { force: true });
  return true;
}
