import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { HybridConfig } from "../config/config.js";

export const DEFAULT_CLAUDE_MODEL_ALIASES: Readonly<Record<string, string>> = {};

const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const LITERAL_STYLE_SUFFIX = /(?:\[(?:\d{1,3};)*\d{1,3}m\])+$/u;

export function normalizeClaudeModelIdentifier(value: string): string {
  return value.replace(ANSI_SEQUENCE, "").replace(LITERAL_STYLE_SUFFIX, "");
}

export function claudeModelLabel(value: string): string {
  const normalized = normalizeClaudeModelIdentifier(value);
  const version = /^claude-([a-z][a-z0-9]*?)-(\d+)(?:-(\d{1,2})(?=-|$))?/u.exec(normalized);
  const family = version?.[1] ?? /^(?:claude-)?([a-z][a-z0-9]*)/u.exec(normalized)?.[1] ?? normalized;
  const label = `${family[0]?.toUpperCase() ?? ""}${family.slice(1)}`;
  return version ? `${label} ${version[2]}${version[3] ? `.${version[3]}` : ""}` : label;
}

export function modelCatalogValue(model: ModelInfo): string {
  const value = normalizeClaudeModelIdentifier(model.value);
  const resolved = model.resolvedModel && normalizeClaudeModelIdentifier(model.resolvedModel);
  return value !== model.value && resolved ? resolved : value;
}

function aliases(config: HybridConfig): Readonly<Record<string, string>> {
  return config.modelAliases ?? DEFAULT_CLAUDE_MODEL_ALIASES;
}

export function isClaudeModelAlias(config: HybridConfig, pickerId: string): boolean {
  return Object.hasOwn(aliases(config), pickerId);
}

export function resolveClaudeModel(config: HybridConfig, pickerId: string): string | undefined {
  const configured = pickerId.startsWith(config.modelPrefix)
    ? pickerId.slice(config.modelPrefix.length)
    : aliases(config)[pickerId];
  if (!configured) return undefined;
  const value = configured.startsWith(config.modelPrefix)
    ? configured.slice(config.modelPrefix.length)
    : configured;
  return normalizeClaudeModelIdentifier(value);
}

export function claudeCatalogId(config: HybridConfig, pickerId: string): string | undefined {
  const value = resolveClaudeModel(config, pickerId);
  return value ? `${config.modelPrefix}${value}` : undefined;
}

export function normalizeClaudeServiceTier(
  config: HybridConfig,
  pickerId: string,
  serviceTier: string | null | undefined,
): string | null {
  if (serviceTier === "priority" && resolveClaudeModel(config, pickerId)) return "fast";
  return serviceTier ?? null;
}

const CLAUDE_MODEL_VERSION = /^claude-([a-z][a-z0-9]*?)-(\d+)(?:-(\d{1,2})(?=-|$))?/u;

export function parseClaudeModelVersion(value: string): { family: string; version: number } | undefined {
  const match = CLAUDE_MODEL_VERSION.exec(normalizeClaudeModelIdentifier(value));
  return match ? { family: match[1]!, version: Number(match[2]) + Number(match[3] ?? 0) / 100 } : undefined;
}

export type ClaudeModelReplacement = { readonly value: string; readonly reason: "exact" | "family" | "default" };

/**
 * Picks the catalog entry to use for a requested model value (picker id without prefix).
 * Exact match first; otherwise the newest catalog entry of the same family (so a retired
 * `claude-fable-5` lands on `claude-fable-5-1`); otherwise the catalog default, when known.
 */
export function pickClaudeModelReplacement(
  requested: string,
  available: readonly string[],
  defaultValue: string | undefined,
): ClaudeModelReplacement | undefined {
  const value = normalizeClaudeModelIdentifier(requested);
  if (available.includes(value)) return { value, reason: "exact" };
  const family = parseClaudeModelVersion(value)?.family;
  const candidates = family
    ? available.map((candidate) => ({ candidate, parsed: parseClaudeModelVersion(candidate) }))
      .filter((entry) => entry.parsed?.family === family)
      .sort((a, b) => b.parsed!.version - a.parsed!.version)
    : [];
  if (candidates[0]) return { value: candidates[0].candidate, reason: "family" };
  if (defaultValue && available.includes(defaultValue)) return { value: defaultValue, reason: "default" };
  return undefined;
}
