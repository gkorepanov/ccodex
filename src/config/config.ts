import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { parse } from "smol-toml";
import { DEFAULT_CLAUDE_MODEL_ALIASES } from "../claude/modelSelection.js";
import { bundledClaudeExecutable, pinnedCodexExecutable } from "../runtime/dependencies.js";

export interface HybridConfig {
  /** Exact Codex dependency used for app-server, daemon, and proxy operations. */
  readonly realCodex: string;
  /** Optional external Codex used only for ordinary CLI delegation. */
  readonly delegateCodex?: string;
  readonly claudeBinary: string;
  readonly dataDir: string;
  readonly publicSocket: string;
  readonly modelPrefix: string;
  readonly modelAliases?: Readonly<Record<string, string>>;
  readonly idleTimeoutSeconds: number;
  readonly modelCacheSeconds: number;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly logPrompts: boolean;
  readonly debugCapture: boolean;
  readonly debugLogMaxBytes: number;
  readonly rpcCapture?: boolean;
  readonly rpcCaptureIncludeContent?: boolean;
  readonly rpcCaptureMaxBytes?: number;
  /** Presence enables CCodex title rewriting; absence preserves stock Codex title behavior. */
  readonly renamePrompt?: string;
  /** Optional UX conveniences. Missing values remain enabled for backwards compatibility. */
  readonly features?: FeatureConfig;
}

export interface FeatureConfig {
  readonly statusCommand: boolean;
}

interface ConfigFile {
  app_server_codex?: unknown;
  delegate_codex?: unknown;
  real_codex?: unknown;
  claude_binary?: unknown;
  data_dir?: unknown;
  public_socket?: unknown;
  model_prefix?: unknown;
  model_aliases?: unknown;
  idle_timeout_seconds?: unknown;
  model_cache_seconds?: unknown;
  log_level?: unknown;
  log_prompts?: unknown;
  debug_capture?: unknown;
  debug_log_max_bytes?: unknown;
  rpc_capture?: unknown;
  rpc_capture_include_content?: unknown;
  rpc_capture_max_bytes?: unknown;
  rename_prompt?: unknown;
  features?: unknown;
}

export const DEFAULT_FEATURES: FeatureConfig = {
  statusCommand: true,
};

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

[features]
status_command = true
`;
}

function expandHome(value: string): string {
  return value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function optionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value.trim();
}

function stringMap(value: unknown, fallback: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (value === undefined) return fallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("model_aliases must be a TOML table.");
  const entries = Object.entries(value);
  if (entries.some(([, target]) => typeof target !== "string" || target.length === 0)) {
    throw new Error("model_aliases values must be non-empty strings.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function featureConfig(value: unknown): FeatureConfig {
  if (value === undefined) return DEFAULT_FEATURES;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[features] must be a TOML table.");
  }
  const table = value as Record<string, unknown>;
  for (const key of ["status_command"] as const) {
    if (table[key] !== undefined && typeof table[key] !== "boolean") {
      throw new Error(`features.${key} must be a boolean.`);
    }
  }
  return {
    statusCommand: table.status_command as boolean | undefined ?? true,
  };
}

function environment(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}

function environmentBoolean(primary: string, legacy: string, fallback: boolean): boolean {
  const value = environment(primary, legacy);
  return value === undefined ? fallback : value === "1" || value === "true";
}

function environmentNumber(primary: string, legacy: string, fallback: number): number {
  const value = environment(primary, legacy);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${primary} must be a positive number.`);
  return parsed;
}

function findExecutable(command: string): string | undefined {
  if (command.includes("/")) {
    const candidate = resolve(expandHome(command));
    return existsSync(candidate) ? candidate : undefined;
  }

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function insideManagedTree(candidate: string, productHome: string): boolean {
  const home = existsSync(productHome) ? realpathSync(productHome) : resolve(productHome);
  const path = realpathSync(candidate);
  const child = relative(home, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function externalExecutable(configured: string, label: string, productHome: string): string {
  const candidate = resolveExecutable(configured, label);
  if (insideManagedTree(candidate, productHome)) {
    throw new Error(`${label} resolves inside managed CCodex home '${productHome}'. Configure an external Codex executable.`);
  }
  return candidate;
}

function persistedDelegate(productHome: string): string | undefined {
  const path = join(productHome, "install.json");
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { delegateCodex?: unknown };
    return typeof value.delegateCodex === "string" && value.delegateCodex.length > 0
      ? value.delegateCodex
      : undefined;
  } catch {
    return undefined;
  }
}

export function findDelegatedCodex(appServerCodex: string, productHome: string): string | undefined {
  const excluded = new Set<string>();
  for (const path of [
    appServerCodex,
    process.argv[1],
    join(productHome, "bin", "codex"),
    join(productHome, "bin", "ccodex"),
    join(productHome, "current", "node_modules", ".bin", "ccodex"),
  ]) {
    if (!path || !existsSync(path)) continue;
    excluded.add(realpathSync(path));
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory || ".", "codex");
    if (!existsSync(candidate)) continue;
    const resolved = realpathSync(candidate);
    if (!excluded.has(resolved) && !insideManagedTree(candidate, productHome)) return candidate;
  }
  return undefined;
}

function resolveExecutable(configured: string, label: string): string {
  const candidate = findExecutable(configured);
  if (!candidate) throw new Error(`${label} executable '${configured}' was not found.`);

  const ownPath = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : undefined;
  if (ownPath && realpathSync(candidate) === ownPath) {
    throw new Error(`${label} resolves to CCodex itself. Configure an absolute upstream executable.`);
  }
  return candidate;
}

function readConfigFile(path: string): ConfigFile {
  if (!existsSync(path)) return {};
  return parse(readFileSync(path, "utf8")) as ConfigFile;
}

export function delegatedCodexExecutable(
  productHome: string,
  appServerCodex: string,
  configPath = join(productHome, "config.toml"),
): string | undefined {
  const file = readConfigFile(configPath);
  const configured = process.env.CCODEX_DELEGATE_CODEX ??
    (typeof file.delegate_codex === "string" ? file.delegate_codex : undefined);
  if (configured) return externalExecutable(configured, "Delegated Codex", productHome);

  const persisted = persistedDelegate(productHome);
  if (persisted) {
    try {
      return externalExecutable(persisted, "Persisted delegated Codex", productHome);
    } catch {
      // A removed or moved global Codex is rediscovered from the current PATH below.
    }
  }
  return findDelegatedCodex(appServerCodex, productHome);
}

export function loadConfig(): HybridConfig {
  const productHome = expandHome(process.env.CCODEX_HOME ?? join(homedir(), ".ccodex"));
  const defaultDataDir = join(productHome, "state");
  const configPath = expandHome(
    environment("CCODEX_CONFIG", "CODEX_HYBRID_CONFIG") ?? join(productHome, "config.toml"),
  );
  const file = readConfigFile(configPath);
  const dataDir = expandHome(
    environment("CCODEX_DATA_DIR", "CODEX_HYBRID_DATA_DIR") ?? stringValue(file.data_dir, defaultDataDir),
  );
  const realCodexOverride = process.env.CCODEX_APP_SERVER_CODEX ?? process.env.CODEX_HYBRID_REAL_CODEX;
  const configuredAppServerCodex = realCodexOverride ??
    stringValue(file.app_server_codex, stringValue(file.real_codex, pinnedCodexExecutable()));
  const realCodex = resolveExecutable(configuredAppServerCodex, "App-server Codex");
  const logLevel = stringValue(file.log_level, environment("CCODEX_LOG_LEVEL", "CODEX_HYBRID_LOG_LEVEL") ?? "info");
  if (!(["debug", "info", "warn", "error"] as const).includes(logLevel as HybridConfig["logLevel"])) {
    throw new Error(`Invalid log level '${logLevel}'.`);
  }
  const delegateCodex = delegatedCodexExecutable(productHome, realCodex, configPath);
  const renamePrompt = optionalString(file.rename_prompt, "rename_prompt");

  return {
    realCodex,
    ...(delegateCodex ? { delegateCodex } : {}),
    claudeBinary:
      process.env.CCODEX_CLAUDE_BINARY ?? process.env.CODEX_HYBRID_CLAUDE_BINARY ??
        stringValue(file.claude_binary, bundledClaudeExecutable()),
    dataDir,
    publicSocket: expandHome(
      environment("CCODEX_SOCKET", "CODEX_HYBRID_SOCKET") ??
        stringValue(
          file.public_socket,
          join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-control", "app-server-control.sock"),
        ),
    ),
    modelPrefix: environment("CCODEX_MODEL_PREFIX", "CODEX_HYBRID_MODEL_PREFIX") ?? stringValue(file.model_prefix, "claude:"),
    modelAliases: stringMap(file.model_aliases, DEFAULT_CLAUDE_MODEL_ALIASES),
    idleTimeoutSeconds: numberValue(file.idle_timeout_seconds, 900),
    modelCacheSeconds: numberValue(file.model_cache_seconds, 300),
    logLevel: logLevel as HybridConfig["logLevel"],
    logPrompts: environmentBoolean("CCODEX_LOG_PROMPTS", "CODEX_HYBRID_LOG_PROMPTS", booleanValue(file.log_prompts, false)),
    debugCapture: environmentBoolean("CCODEX_DEBUG_CAPTURE", "CODEX_HYBRID_DEBUG_CAPTURE", booleanValue(file.debug_capture, false)),
    debugLogMaxBytes: numberValue(file.debug_log_max_bytes, 1_048_576),
    rpcCapture: environmentBoolean("CCODEX_RPC_CAPTURE", "CODEX_HYBRID_RPC_CAPTURE", booleanValue(file.rpc_capture, true)),
    rpcCaptureIncludeContent: environmentBoolean(
      "CCODEX_RPC_CAPTURE_INCLUDE_CONTENT",
      "CODEX_HYBRID_RPC_CAPTURE_INCLUDE_CONTENT",
      booleanValue(file.rpc_capture_include_content, true),
    ),
    rpcCaptureMaxBytes: environmentNumber(
      "CCODEX_RPC_CAPTURE_MAX_BYTES",
      "CODEX_HYBRID_RPC_CAPTURE_MAX_BYTES",
      numberValue(file.rpc_capture_max_bytes, 1_073_741_824),
    ),
    ...(renamePrompt ? { renamePrompt } : {}),
    features: featureConfig(file.features),
  };
}
