import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "../management/layout.js";

export const CODEX_CLI_PATH_LABEL = "dev.ccodex.codex-cli-path";
export const CODEX_CLI_PATH_ENV = "CODEX_CLI_PATH";
const LAUNCHCTL = "/bin/launchctl";
const MANAGED_MARKER = "Managed by CCodex — run 'ccodex uninstall' to remove.";

export interface CliPathAgentInstall {
  readonly path: string;
  readonly label: string;
  readonly entryShimPath: string;
  readonly contentHash: string;
  readonly previousValue?: string;
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

const uid = () => process.getuid?.() ?? 0;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const fileHash = (path: string) => sha256(readFileSync(path, "utf8"));
const xmlEscape = (value: string) => value.replace(/[&<>]/gu, (character) =>
  character === "&" ? "&amp;" : character === "<" ? "&lt;" : "&gt;");

export function codexCliPathAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${CODEX_CLI_PATH_LABEL}.plist`);
}

export function codexCliPathPlist(entryShimPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MANAGED_MARKER} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${CODEX_CLI_PATH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${LAUNCHCTL}</string>
    <string>setenv</string>
    <string>${CODEX_CLI_PATH_ENV}</string>
    <string>${xmlEscape(entryShimPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

export function launchAgentLoaded(runtime: LaunchctlRuntime = systemLaunchctl): boolean {
  return runtime.run(["print", `gui/${uid()}/${CODEX_CLI_PATH_LABEL}`]).status === 0;
}

function bootout(runtime: LaunchctlRuntime): void {
  runtime.run(["bootout", `gui/${uid()}/${CODEX_CLI_PATH_LABEL}`]);
}

function bootstrap(path: string, runtime: LaunchctlRuntime): void {
  const domain = `gui/${uid()}`;
  const result = runtime.run(["bootstrap", domain, path]);
  if (result.status === 0) return;
  const fallback = runtime.run(["load", path]);
  if (fallback.status !== 0) {
    throw new Error(`launchctl could not load ${path}: ${(result.stderr || fallback.stderr).trim()}`);
  }
}

export function setCodexCliPathEnv(
  value: string | undefined,
  runtime: LaunchctlRuntime = systemLaunchctl,
): void {
  const args = value === undefined
    ? ["unsetenv", CODEX_CLI_PATH_ENV]
    : ["setenv", CODEX_CLI_PATH_ENV, value];
  const result = runtime.run(args);
  if (result.status !== 0) {
    throw new Error(`launchctl could not update ${CODEX_CLI_PATH_ENV}: ${result.stderr.trim()}`);
  }
}

export function getCodexCliPathEnv(runtime: LaunchctlRuntime = systemLaunchctl): string | undefined {
  const result = runtime.run(["getenv", CODEX_CLI_PATH_ENV]);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

export function installCliPathAgent(
  entryShimPath: string,
  previous?: CliPathAgentInstall,
  runtime: LaunchctlRuntime = systemLaunchctl,
): CliPathAgentInstall {
  const path = codexCliPathAgentPath();
  const content = codexCliPathPlist(entryShimPath);
  const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (before !== undefined && before !== content && fileHash(path) !== previous?.contentHash) {
    throw new Error(`Refusing to overwrite modified or unmanaged LaunchAgent ${path}`);
  }
  const previousValue = previous?.previousValue ?? getCodexCliPathEnv(runtime);
  const wasLoaded = launchAgentLoaded(runtime);
  const record = {
    path,
    label: CODEX_CLI_PATH_LABEL,
    entryShimPath,
    contentHash: sha256(content),
    ...(previousValue === undefined ? {} : { previousValue }),
  };
  try {
    atomicWrite(path, content, 0o644);
    bootout(runtime);
    bootstrap(path, runtime);
    setCodexCliPathEnv(entryShimPath, runtime);
    return record;
  } catch (error) {
    bootout(runtime);
    if (before === undefined) rmSync(path, { force: true });
    else {
      atomicWrite(path, before, 0o644);
      if (wasLoaded) bootstrap(path, runtime);
    }
    setCodexCliPathEnv(previousValue, runtime);
    throw error;
  }
}

export function uninstallCliPathAgent(
  record: CliPathAgentInstall,
  runtime: LaunchctlRuntime = systemLaunchctl,
): boolean {
  if (existsSync(record.path) && fileHash(record.path) !== record.contentHash) return false;
  bootout(runtime);
  rmSync(record.path, { force: true });
  if (getCodexCliPathEnv(runtime) === record.entryShimPath) {
    setCodexCliPathEnv(record.previousValue, runtime);
  }
  return true;
}
