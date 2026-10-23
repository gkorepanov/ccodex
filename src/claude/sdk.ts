import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { query, type ModelInfo, type Options, type PermissionMode, type Query, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import type { JsonObject } from "../protocol/codex.js";
import type { SessionSettings } from "./session.js";
import { modelCatalogValue, normalizeClaudeModelIdentifier } from "./modelSelection.js";
import { claudeSkillFile } from "./toolMapper.js";
import { ULTRA } from "./delegation.js";

export function claudeEnvironment(): Record<string, string | undefined> {
  // Claude chats are a desktop app's, like Claude Desktop's: background commands run with no time limit (Claude Code
  // stops them after 30 min to 2 h in Agent SDK sessions, which it takes for unattended).
  // Transcripts leave out what Claude Code 2.1.300+ records of each API request (prompt, tools, parameters): half again
  // a long chat's size, all read through when paging back.
  // At a usage limit, or while the API is overloaded, Claude Code waits and retries in the same turn, as its unattended
  // mode does, up to 10 hours (a limit that resets later ends the turn at once).
  const env: Record<string, string | undefined> = {
    ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDE_CODE_ELEGANT_MEADOW: "0",
    CLAUDE_CODE_RETRY_WATCHDOG: "1", CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: "36000000", CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS: "36000000",
  };
  delete env.CCODEX_SHIM_ACTIVE;
  delete env.CODEX_CLI_PATH;
  return env;
}

export function baseOptions(config: Config): Options {
  return {
    pathToClaudeCodeExecutable: config.claudeBinary,
    settingSources: ["user", "project", "local"],
    env: claudeEnvironment(),
  };
}

// ---- permissions: modes map directly, no sandbox emulation ----

export interface CodexPermissions {
  readonly approvalPolicy: string;
  readonly approvalsReviewer: string;
  readonly sandboxPolicy: JsonObject;
  readonly activePermissionProfile: { id: string; extends: null };
}

/** Codex permission fields (thread/start, turn/start, settings/update) → Claude permission mode; undefined = none sent. */
function chosenPermissionMode(params: JsonObject, current: PermissionMode): PermissionMode | undefined {
  const sandbox = params.sandboxPolicy?.type ?? params.sandbox ?? params.permissions;
  const fullAccess = sandbox === "dangerFullAccess" || sandbox === "danger-full-access" || sandbox === ":danger-full-access";
  if (params.approvalsReviewer && params.approvalsReviewer !== "user") return "auto";
  if (params.approvalPolicy === "never") return fullAccess ? "bypassPermissions" : "dontAsk";
  if (params.approvalPolicy !== undefined && params.approvalPolicy !== null) return "default";
  if (fullAccess) return "bypassPermissions";
  if (params.approvalsReviewer === "user" && current === "auto") return "default";
  return undefined;
}

/**
 * The chat's permissions and plan mode after a Codex settings change, apart like stock's: the permission mode changes
 * only with the permission fields Desktop sends (null to keep them), plan mode with the collaboration mode.
 */
export function permissionSettings(params: JsonObject, current: Pick<SessionSettings, "permissionMode" | "plan">): Pick<SessionSettings, "permissionMode" | "plan"> {
  const collaboration = params.collaborationMode?.mode;
  return {
    permissionMode: chosenPermissionMode(params, current.permissionMode) ?? current.permissionMode,
    plan: collaboration ? collaboration === "plan" : current.plan,
  };
}

/** The mode Claude runs in: its plan mode while the chat is in plan mode. */
export function claudeMode(settings: Pick<SessionSettings, "permissionMode" | "plan">): PermissionMode {
  return settings.plan ? "plan" : settings.permissionMode;
}

export function codexPermissions(mode: string | null, cwd: string): CodexPermissions {
  if (mode === "bypassPermissions") {
    return {
      approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" },
      activePermissionProfile: { id: ":danger-full-access", extends: null },
    };
  }
  const sandboxPolicy = {
    type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
  };
  const profile = { id: ":workspace", extends: null };
  if (mode === "dontAsk") return { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy, activePermissionProfile: profile };
  if (mode === "auto") return { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy, activePermissionProfile: profile };
  return { approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy, activePermissionProfile: profile };
}

// ---- models ----

const effortDescriptions: Record<string, string> = {
  low: "Faster responses with less reasoning.",
  medium: "Balanced reasoning effort.",
  high: "Deep reasoning for complex work.",
  xhigh: "Extra-high reasoning effort.",
  max: "Maximum available reasoning effort.",
  ultra: "Maximum reasoning with automatic task delegation",
};

export function claudeModelDisplayName(model: ModelInfo): string {
  const displayName = model.displayName.replace(/\s*\(1M context\)\s*$/iu, "");
  const resolved = model.resolvedModel && normalizeClaudeModelIdentifier(model.resolvedModel);
  const version = resolved && /^claude-([a-z][a-z0-9]*?)-(\d+)(?:-(\d{1,2})(?=-|$))?/u.exec(resolved);
  if (!version) return displayName;
  const [, family, major, minor] = version;
  const label = `${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
  if (displayName.toLocaleLowerCase().includes(label.toLocaleLowerCase())) return displayName;
  if (displayName.toLocaleLowerCase().startsWith(family!)) {
    return `${displayName.slice(0, family!.length)} ${major}${minor ? `.${minor}` : ""}${displayName.slice(family!.length)}`;
  }
  return `${displayName} · ${label}`;
}

export function mapClaudeModel(model: ModelInfo, prefix: string): JsonObject {
  const supported: string[] = model.supportsEffort ? (model.supportedEffortLevels ?? []) : [];
  // Stock's `ultra`: Claude's max with proactive sub-agent delegation.
  const efforts = supported.includes("max") ? [...supported, ULTRA] : supported;
  // Like stock models: Desktop adds the standard speed itself.
  const serviceTiers = model.supportsFastMode ? [{ id: "fast", name: "Fast", description: "Claude fast mode." }] : [];
  const id = `${prefix}${modelCatalogValue(model)}`;
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    modelSpecialty: null,
    multiAgentVersion: null,
    displayName: claudeModelDisplayName(model),
    description: model.description,
    hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: effortDescriptions[reasoningEffort] ?? `${reasoningEffort} reasoning effort.`,
    })),
    defaultReasoningEffort: efforts.includes("high") ? "high" : efforts.includes("medium") ? "medium" : efforts[0] ?? "medium",
    inputModalities: ["text", "image"],
    supportsPersonality: true,
    additionalSpeedTiers: serviceTiers.map((tier) => tier.id),
    serviceTiers,
    defaultServiceTier: null,
    availableAccessPrograms: null,
    isDefault: false,
  };
}

async function* idle(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** Runs `use` against a throwaway, never-prompted query (model list, skills, account info). */
export async function withProbeQuery<T>(config: Config, cwd: string | undefined, use: (query: Query) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const probe = query({
    prompt: idle(abort.signal),
    options: { ...baseOptions(config), ...(cwd ? { cwd } : {}), persistSession: false, abortController: abort, allowedTools: [] },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      probe.initializationResult().then(() => use(probe)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Claude probe timed out.")), 20_000); }),
    ]);
  } finally {
    clearTimeout(timer);
    abort.abort();
    probe.close();
  }
}

/**
 * A Claude skill as stock lists it. Its path is Claude's own file for it, which a GPT chat mentioning it reads; a
 * built-in, plugin or MCP command has none and points at a note that it runs only in Claude chats.
 */
export async function mapSkill(config: Config, cwd: string, skill: SlashCommand): Promise<JsonObject> {
  let path = claudeSkillFile(skill.name, cwd, config.claudeHome);
  if (!path) {
    path = join(config.dataDir, "virtual", "claude-skills", encodeURIComponent(skill.name), "SKILL.md");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `---\nname: claude:${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n\`/${skill.name}\` is a Claude Code command without a file of its own (built in, or from a plugin or MCP server). It runs only in Claude chats: to use it, the user switches this chat to a Claude model.\n`);
  }
  return {
    name: `claude:${skill.name}`,
    description: skill.argumentHint ? `${skill.description} Arguments: ${skill.argumentHint}` : skill.description,
    path,
    scope: "user",
    enabled: true,
    pluginId: null,
  };
}

const CLAUDE_SKILL_CHIP = /\[\$claude:([^\]\r\n]+)\]\([^)]+\)/gu;

/** Desktop renders Claude skills as `[$claude:name](path)` chips; Claude wants `/name`. */
export function decodeClaudeSkillChips(text: string): string {
  return text.replace(CLAUDE_SKILL_CHIP, (_chip, name: string) => `/${name}`);
}
