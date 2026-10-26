import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "smol-toml";
import { compareSemver } from "./management/shimSelect.js";

export interface Config {
  /** The codex installed on the machine (PATH, skipping our shims), or `codex_binary`. */
  readonly codex: string;
  /** `codex_binary` (or `CCODEX_CODEX`) is set: the gateway runs that one too. */
  readonly codexConfigured: boolean;
  readonly claudeBinary: string;
  readonly claudeHome: string;
  readonly productHome: string;
  readonly dataDir: string;
  readonly publicSocket: string;
  readonly modelPrefix: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly rpcCapture: boolean;
  readonly rpcCaptureMaxBytes: number;
  /** The most a client gets in one message, or as one command's output (`rpc_limit_mb`); 0: no limit. */
  readonly rpcLimitBytes: number;
  /** Presence enables CCodex titles; absence keeps stock title behaviour. */
  readonly renamePrompt?: string;
  /** Model that writes titles; default: stock's fast one (…-luna / …-mini), else its default model. */
  readonly titleModel?: string;
  /** What a plain `codex …` (TUI, exec, login) runs; defaults to the installed codex. */
  readonly delegateCodex: string;
  /** Our formulas and plots instructions for Codex and Claude models in the app. */
  readonly improveModelsFormatting: boolean;
  /** Codex's bundled visualize skill (while enabled in Codex) in Claude chats too (`claude_visualize`). */
  readonly claudeVisualize: boolean;
}

export const DEFAULT_RENAME_PROMPT = `Create a concise, vivid, memorable title for the task.
Start with exactly one rare, expressive, context-relevant emoji followed by one space.
Avoid generic decorative emoji when a more specific symbol fits.
Keep the complete title, including emoji, within 36 characters.
Return only the title.`;

export function defaultConfigToml(): string {
  return `# Remove or comment out rename_prompt to restore stock Codex title generation.
rename_prompt = """
${DEFAULT_RENAME_PROMPT}
"""
`;
}

const require = createRequire(import.meta.url);

const CLAUDE_PACKAGES: Readonly<Record<string, string>> = {
  "darwin-arm64": "@anthropic-ai/claude-agent-sdk-darwin-arm64",
  "darwin-x64": "@anthropic-ai/claude-agent-sdk-darwin-x64",
  "linux-arm64-gnu": "@anthropic-ai/claude-agent-sdk-linux-arm64",
  "linux-arm64-musl": "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
  "linux-x64-gnu": "@anthropic-ai/claude-agent-sdk-linux-x64",
  "linux-x64-musl": "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
};

let platformKey: string | undefined;

/** Read once: the process report that tells glibc from musl takes tens of milliseconds. */
export function runtimePlatformKey(): string {
  if (platformKey) return platformKey;
  if (process.platform !== "linux") return platformKey = `${process.platform}-${process.arch}`;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return platformKey = `linux-${process.arch}-${report?.header?.glibcVersionRuntime ? "gnu" : "musl"}`;
}

export function bundledClaudeExecutable(): string {
  const packageName = CLAUDE_PACKAGES[runtimePlatformKey()];
  if (!packageName) return "claude";
  try {
    const binary = join(dirname(require.resolve(`${packageName}/package.json`)), "claude");
    if (existsSync(binary)) return binary;
  } catch {
    // Fall back to a separately installed Claude CLI.
  }
  return "claude";
}

export const expandHome = (value: string) =>
  value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;

export function productHome(): string {
  return expandHome(process.env.CCODEX_HOME ?? join(homedir(), ".ccodex"));
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function inside(path: string, root: string): boolean {
  const child = relative(existsSync(root) ? realpathSync(root) : resolve(root), realpathSync(path));
  return child === "" || (child !== ".." && !child.startsWith("../"));
}

/** Where Codex's installer (and Desktop over SSH) puts `codex`; `ccodex setup` links it to CCodex. */
export function remoteCodexPath(): string {
  return join(resolve(expandHome(process.env.CODEX_INSTALL_DIR ?? join(homedir(), ".local", "bin"))), "codex");
}

/** The `codex` that `ccodex setup` moved away from `remoteCodexPath()`. */
export function displacedCodexPath(home = productHome()): string {
  return join(home, "backups", "remote-codex");
}

/** CCodex itself: its shims, managed installs, this entrypoint. */
export function isCcodex(path: string, home = productHome()): boolean {
  const real = realpathSync(path);
  const own = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : undefined;
  return inside(path, join(home, "bin")) || inside(path, join(home, "versions")) || real === own || real.includes("/@gkorepanov/ccodex/");
}

/** Every `codex` on PATH that is not CCodex, in PATH order; at `remoteCodexPath()` the codex CCodex displaced there. */
export function installedCodexes(home = productHome()): string[] {
  const remote = remoteCodexPath();
  const displaced = displacedCodexPath(home);
  const found = new Map<string, string>();
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory || ".", "codex");
    if (!existsSync(candidate)) continue;
    const codex = !isCcodex(candidate, home) ? candidate
      : candidate === remote && existsSync(displaced) && !isCcodex(displaced, home) ? displaced : undefined;
    if (codex && !found.has(realpathSync(codex))) found.set(realpathSync(codex), codex);
  }
  return [...found.values()];
}

export function findInstalledCodex(home = productHome()): string | undefined {
  return installedCodexes(home)[0];
}

/** Codex Desktop's own CLI on this machine (macOS app bundle, Linux package), newest layout first. */
export function desktopCodex(): string | undefined {
  const apps = ["/Applications/ChatGPT.app", join(homedir(), "Applications", "ChatGPT.app")].flatMap((app) =>
    [join(app, "Contents", "Resources", "codex-cli", "bin", "codex"), join(app, "Contents", "Resources", "codex")]);
  return [...apps, "/usr/lib/chatgpt/resources/codex-cli/bin/codex", "/usr/lib/chatgpt/resources/codex"].find((path) => existsSync(path));
}

const execFileAsync = promisify(execFile);

/** A codex's version (`codex-cli 0.164.0` → `0.164.0`); undefined when it gives none. */
export async function codexVersion(codex: string): Promise<string | undefined> {
  const output = await execFileAsync(codex, ["--version"], { env: { ...process.env, CODEX_CLI_PATH: undefined }, timeout: 15_000 })
    .then(({ stdout }) => stdout, () => "");
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u.exec(output)?.[1];
}

/**
 * The codex the gateway runs as stock: `codex_binary` when set; started for a local Desktop, Desktop's own CLI (what
 * it runs without CCodex, so always one it works with); else, as for Desktop over SSH, the newest on the machine.
 */
export async function stockCodex(config: Config, desktop = desktopCodex()): Promise<string> {
  if (config.codexConfigured) return config.codex;
  if (desktop && process.env.CODEX_APP_TOOLS_PIPE_PATH) return desktop;
  const candidates = await Promise.all([...installedCodexes(config.productHome), ...desktop ? [desktop] : []]
    .map(async (path) => ({ path, version: await codexVersion(path) })));
  const known = candidates.filter((candidate): candidate is { path: string; version: string } => candidate.version !== undefined);
  return known.sort((left, right) => compareSemver(right.version, left.version))[0]?.path ?? config.codex;
}

export function loadConfig(): Config {
  const home = productHome();
  const configPath = expandHome(process.env.CCODEX_CONFIG ?? join(home, "config.toml"));
  const file = existsSync(configPath) ? parse(readFileSync(configPath, "utf8")) as Record<string, any> : {};
  const configuredCodex = process.env.CCODEX_CODEX ?? file.codex_binary as string | undefined;
  const codex = configuredCodex ? resolve(expandHome(configuredCodex)) : findInstalledCodex(home);
  if (!codex) throw new Error("No `codex` found on PATH. Install it with `npm i -g @openai/codex` or set codex_binary in ~/.ccodex/config.toml.");
  const renamePrompt = typeof file.rename_prompt === "string" && file.rename_prompt.trim() ? file.rename_prompt.trim() : undefined;
  return {
    codex,
    codexConfigured: configuredCodex !== undefined,
    claudeBinary: process.env.CCODEX_CLAUDE_BINARY ?? file.claude_binary ?? bundledClaudeExecutable(),
    claudeHome: claudeHome(),
    productHome: home,
    dataDir: expandHome(process.env.CCODEX_DATA_DIR ?? file.data_dir ?? join(home, "state")),
    publicSocket: expandHome(process.env.CCODEX_SOCKET ?? file.public_socket
      ?? join(codexHome(), "app-server-control", "app-server-control.sock")),
    modelPrefix: file.model_prefix ?? "claude:",
    logLevel: process.env.CCODEX_LOG_LEVEL as Config["logLevel"] ?? file.log_level ?? "info",
    rpcCapture: process.env.CCODEX_RPC_CAPTURE ? process.env.CCODEX_RPC_CAPTURE === "1" : file.rpc_capture ?? false,
    rpcCaptureMaxBytes: file.rpc_capture_max_bytes ?? 1_073_741_824,
    rpcLimitBytes: (file.rpc_limit_mb ?? 10) * 1_000_000,
    ...(renamePrompt ? { renamePrompt } : {}),
    ...(file.title_model ? { titleModel: file.title_model as string } : {}),
    delegateCodex: expandHome(process.env.CCODEX_DELEGATE_CODEX ?? file.delegate_codex ?? codex),
    improveModelsFormatting: file.improve_models_formatting_for_codex_app ?? true,
    claudeVisualize: file.claude_visualize ?? true,
  };
}
