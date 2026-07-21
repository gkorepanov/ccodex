import { describe, expect, it } from "vitest";
import type { HybridConfig } from "../../src/config/config.js";
import {
  claudeCatalogId,
  modelCatalogValue,
  normalizeClaudeModelIdentifier,
  normalizeClaudeServiceTier,
  resolveClaudeModel,
} from "../../src/claude/modelSelection.js";

const config = {
  modelPrefix: "claude:",
} as HybridConfig;
const aliasedConfig = {
  ...config,
  modelAliases: { "custom-claude-opus": "claude-opus-4-8" },
} as HybridConfig;

describe("Claude model selection", () => {
  it("removes real and serialized ANSI style residue", () => {
    expect(normalizeClaudeModelIdentifier("claude-fable-5[1m]")).toBe("claude-fable-5");
    expect(normalizeClaudeModelIdentifier("\u001b[1mclaude-fable-5\u001b[0m")).toBe("claude-fable-5");
    expect(modelCatalogValue({
      value: "opus[1m]",
      resolvedModel: "claude-opus-4-8[1m]",
      displayName: "Opus",
      description: "test",
    })).toBe("claude-opus-4-8");
  });

  it("keeps every stock model id stock unless an alias is explicitly configured", () => {
    expect(resolveClaudeModel(config, "gpt-5.6-sol")).toBeUndefined();
    expect(resolveClaudeModel(config, "gpt-5.6-terra")).toBeUndefined();
    expect(resolveClaudeModel(config, "gpt-5.5")).toBeUndefined();
    expect(resolveClaudeModel(config, "gpt-5.4")).toBeUndefined();
    expect(resolveClaudeModel(aliasedConfig, "custom-claude-opus")).toBe("claude-opus-4-8");
    expect(claudeCatalogId(aliasedConfig, "custom-claude-opus")).toBe("claude:claude-opus-4-8");
  });

  it("maps Codex priority to Claude fast for aliases and direct Claude models", () => {
    expect(normalizeClaudeServiceTier(aliasedConfig, "custom-claude-opus", "priority")).toBe("fast");
    expect(normalizeClaudeServiceTier(config, "claude:sonnet", "priority")).toBe("fast");
    expect(normalizeClaudeServiceTier(config, "gpt-5.6-terra", "priority")).toBe("priority");
  });
});
