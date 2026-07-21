import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { HybridConfig } from "../config/config.js";

export const DEFAULT_CLAUDE_MODEL_ALIASES: Readonly<Record<string, string>> = {};

const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const LITERAL_STYLE_SUFFIX = /(?:\[(?:\d{1,3};)*\d{1,3}m\])+$/u;

export function normalizeClaudeModelIdentifier(value: string): string {
  return value.replace(ANSI_SEQUENCE, "").replace(LITERAL_STYLE_SUFFIX, "");
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
