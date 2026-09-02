import { describe, expect, it } from "vitest";
import type { HybridConfig } from "../../src/config/config.js";
import {
  claudeCatalogId,
  modelCatalogValue,
  normalizeClaudeModelIdentifier,
  normalizeClaudeServiceTier,
  parseClaudeModelVersion,
  pickClaudeModelReplacement,
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

  it("parses Claude model families and versions from catalog ids", () => {
    expect(parseClaudeModelVersion("claude-fable-5-1[1m]")).toEqual({ family: "fable", version: 5.01 });
    expect(parseClaudeModelVersion("claude-haiku-4-5-20251001")).toEqual({ family: "haiku", version: 4.05 });
    expect(parseClaudeModelVersion("sonnet")).toBeUndefined();
  });

  it("migrates a retired model id onto the newest entry of its family, else the catalog default", () => {
    const available = ["claude-opus-5", "claude-fable-5-1", "claude-fable-4-9", "sonnet"];
    expect(pickClaudeModelReplacement("claude-fable-5-1", available, "claude-opus-5")).toEqual({ value: "claude-fable-5-1", reason: "exact" });
    expect(pickClaudeModelReplacement("claude-fable-5", available, "claude-opus-5")).toEqual({ value: "claude-fable-5-1", reason: "family" });
    expect(pickClaudeModelReplacement("claude-fable-6", available, "claude-opus-5")).toEqual({ value: "claude-fable-5-1", reason: "family" });
    expect(pickClaudeModelReplacement("claude-mythos-5", available, "claude-opus-5")).toEqual({ value: "claude-opus-5", reason: "default" });
    expect(pickClaudeModelReplacement("claude-mythos-5", available, undefined)).toBeUndefined();
    expect(pickClaudeModelReplacement("sonnet", available, undefined)).toEqual({ value: "sonnet", reason: "exact" });
  });
});
