import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { latestClaudeModels } from "../../src/claude/modelSelection.js";

const model = (value: string, resolvedModel?: string): ModelInfo => ({
  value, ...(resolvedModel ? { resolvedModel } : {}), displayName: value, description: value,
});

describe("latestClaudeModels", () => {
  it("keeps only the newest version in each family", () => {
    const models = [
      model("claude-sonnet-4-6"), model("claude-sonnet-5"), model("claude-sonnet-5-5"), model("claude-sonnet-5-10"),
      model("claude-haiku-4-5"), model("claude-haiku-5-5"),
      model("claude-opus-5-5"),
    ];

    expect(latestClaudeModels(models).map(({ value }) => value)).toEqual([
      "claude-sonnet-5-10", "claude-haiku-5-5", "claude-opus-5-5",
    ]);
  });

  it("keeps one canonical row when an alias resolves to the latest version", () => {
    const alias = model("sonnet", "claude-sonnet-5-5");
    const canonical = model("claude-sonnet-5-5");
    expect(latestClaudeModels([alias, canonical])).toEqual([canonical]);
  });

  it("preserves unversioned custom models", () => {
    const custom = model("custom-org-model");
    expect(latestClaudeModels([model("claude-haiku-4-5"), custom])).toEqual([custom]);
  });
});
