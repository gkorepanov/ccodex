import { describe, expect, it } from "vitest";
import {
  assertClaudeControlSurface,
  claudeModelPickerIds,
  claudeModelDisplayName,
  mapClaudeModel,
  mapClaudeModels,
} from "../../src/claude/modelCatalog.js";
import { claudeModelLabel } from "../../src/claude/modelSelection.js";

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
      displayName: "Opus 4.8",
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

  it("maps the Fable 5.1 catalog entry observed on claude-code 2.1.258", () => {
    expect(mapClaudeModel({
      value: "claude-fable-5-1",
      resolvedModel: "claude-fable-5-1",
      displayName: "Fable 5.1",
      description: "Fable 5.1 · Most capable for your hardest and longest-running tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    }, "claude:")).toMatchObject({
      id: "claude:claude-fable-5-1",
      model: "claude:claude-fable-5-1",
      displayName: "Fable 5.1",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" },
        { reasoningEffort: "xhigh" }, { reasoningEffort: "max" },
      ].map((effort) => expect.objectContaining(effort)),
      serviceTiers: [],
      defaultServiceTier: null,
    });
  });

  it("hides the moving default alias and shows concise explicit versions", () => {
    const models = mapClaudeModels([{
      value: "default",
      resolvedModel: "claude-opus-5[1m]",
      displayName: "Default (recommended)",
      description: "Default Claude model.",
    }, {
      value: "opus[1m]",
      resolvedModel: "claude-opus-5[1m]",
      displayName: "Opus (1M context)",
      description: "Largest Claude context.",
    }], "claude:");
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "claude:claude-opus-5",
      displayName: "Opus 5",
    });

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
    expect(claudeModelLabel("claude-sonnet-5")).toBe("Sonnet 5");
    expect(claudeModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  it("maps provider aliases and resolved models to the advertised picker id", () => {
    const ids = claudeModelPickerIds([{
      value: "opus[1m]",
      resolvedModel: "claude-opus-5[1m]",
      displayName: "Opus (1M context)",
      description: "Largest Claude context.",
    }, {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      description: "Efficient Claude model.",
    }], "claude:");
    expect(ids.get("opus")).toBe("claude:claude-opus-5");
    expect(ids.get("claude-opus-5")).toBe("claude:claude-opus-5");
    expect(ids.get("sonnet")).toBe("claude:sonnet");
    expect(ids.get("claude-sonnet-5")).toBe("claude:sonnet");
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
