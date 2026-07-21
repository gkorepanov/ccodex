import { describe, expect, it } from "vitest";
import { assertClaudeControlSurface, mapClaudeModel } from "../../src/claude/modelCatalog.js";

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
    }, "claude:").id).toBe("claude:claude-fable-5");
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
