import { describe, expect, it } from "vitest";
import {
  assertClaudeControlSurface,
  claudeModelDisplayName,
  mapClaudeModel,
} from "../../src/claude/modelCatalog.js";

describe("mapClaudeModel", () => {
  it("rejects an SDK query missing required lifecycle controls", () => {
    expect(() => assertClaudeControlSurface({ supportedModels() {} })).toThrow("missing required controls");
  });

  it("namespaces Claude models and maps effort and fast-mode metadata", () => {
    expect(mapClaudeModel({
      value: "opus[1m]",
      resolvedModel: "claude-opus-4-8[1m]",
      displayName: "Opus 4.8 (1M context)",
      description: "Largest Claude context.",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsFastMode: true,
    }, "claude:")).toMatchObject({
      id: "claude:claude-opus-4-8",
      model: "claude:claude-opus-4-8",
      defaultReasoningEffort: "high",
      inputModalities: ["text", "image"],
      isDefault: false,
      defaultServiceTier: "default",
      serviceTiers: [{ id: "default" }, { id: "fast" }],
    });
  });

  it("uses a clean resolved id when Claude leaks terminal styling into model values", () => {
    expect(mapClaudeModel({
      value: "claude-fable-5[1m]",
      resolvedModel: "claude-fable-5",
      displayName: "Fable",
      description: "Largest Claude model.",
    }, "claude:")).toMatchObject({
      id: "claude:claude-fable-5",
      displayName: "Fable 5",
    });
  });

  it("shows the resolved version beside every Claude alias", () => {
    expect(claudeModelDisplayName({
      value: "default",
      resolvedModel: "claude-opus-5[1m]",
      displayName: "Default (recommended)",
      description: "Default Claude model.",
    })).toBe("Default (recommended · Opus 5)");
    expect(claudeModelDisplayName({
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      description: "Efficient Claude model.",
    })).toBe("Sonnet 5");
    expect(claudeModelDisplayName({
      value: "haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
      displayName: "Haiku",
      description: "Fast Claude model.",
    })).toBe("Haiku 4.5");
    expect(claudeModelDisplayName({
      value: "opus",
      resolvedModel: "claude-opus-5",
      displayName: "Opus 5",
      description: "Already explicit.",
    })).toBe("Opus 5");
  });

  it("does not invent effort or service tiers", () => {
    const model = mapClaudeModel({
      value: "haiku",
      displayName: "Haiku",
      description: "Fast Claude model.",
    }, "claude:");
    expect(model.supportedReasoningEfforts).toEqual([]);
    expect(model.serviceTiers).toEqual([]);
    expect(model.defaultServiceTier).toBeNull();
  });
});
