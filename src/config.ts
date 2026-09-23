import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { parse } from "smol-toml";

export interface Config {
  /** The codex installed on the machine (PATH, skipping our shims), or `codex_binary`. */
  readonly codex: string;
  readonly claudeBinary: string;
  readonly claudeHome: string;
  readonly productHome: string;
  readonly dataDir: string;
  readonly publicSocket: string;
  readonly modelPrefix: string;
  readonly idleTimeoutSeconds: number;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly rpcCapture: boolean;
  readonly rpcCaptureMaxBytes: number;
  /** Presence enables CCodex titles; absence keeps stock title behaviour. */
  readonly renamePrompt?: string;
  /** Model that writes titles; default: stock's fast one (…-luna / …-mini), else its default model. */
  readonly titleModel?: string;
  /** What a plain `codex …` (TUI, exec, login) runs; defaults to the installed codex. */
  readonly delegateCodex: string;
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

export function runtimePlatformKey(): string {
  if (process.platform !== "linux") return `${process.platform}-${process.arch}`;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return `linux-${process.arch}-${report?.header?.glibcVersionRuntime ? "gnu" : "musl"}`;
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

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function inside(path: string, root: string): boolean {
  const child = relative(existsSync(root) ? realpathSync(root) : resolve(root), realpathSync(path));
  return child === "" || (child !== ".." && !child.startsWith("../"));
}

/** First `codex` on PATH that is not CCodex itself (shims, managed installs, this entrypoint). */
export function findInstalledCodex(home = productHome()): string | undefined {
  const own = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : undefined;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory || ".", "codex");
    if (!existsSync(candidate) || inside(candidate, home)) continue;
    const real = realpathSync(candidate);
    if (real === own || real.includes("/@gkorepanov/ccodex/")) continue;
    return candidate;
  }
  return undefined;
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
    claudeBinary: process.env.CCODEX_CLAUDE_BINARY ?? file.claude_binary ?? bundledClaudeExecutable(),
    claudeHome: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    productHome: home,
    dataDir: expandHome(process.env.CCODEX_DATA_DIR ?? file.data_dir ?? join(home, "state")),
    publicSocket: expandHome(process.env.CCODEX_SOCKET ?? file.public_socket
      ?? join(codexHome(), "app-server-control", "app-server-control.sock")),
    modelPrefix: file.model_prefix ?? "claude:",
    idleTimeoutSeconds: file.idle_timeout_seconds ?? 900,
    logLevel: process.env.CCODEX_LOG_LEVEL as Config["logLevel"] ?? file.log_level ?? "info",
    rpcCapture: process.env.CCODEX_RPC_CAPTURE ? process.env.CCODEX_RPC_CAPTURE === "1" : file.rpc_capture ?? true,
    rpcCaptureMaxBytes: file.rpc_capture_max_bytes ?? 1_073_741_824,
    ...(renamePrompt ? { renamePrompt } : {}),
    ...(file.title_model ? { titleModel: file.title_model as string } : {}),
    delegateCodex: expandHome(process.env.CCODEX_DELEGATE_CODEX ?? file.delegate_codex ?? codex),
  };
}
