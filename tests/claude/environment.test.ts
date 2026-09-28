import { describe, expect, it } from "vitest";
import { claudeEnvironment } from "../../src/claude/environment.js";

describe("claude runtime environment", () => {
  it("strips the shim guard and applies config overrides over the process environment", () => {
    const env = claudeEnvironment(
      { PATH: "/bin", CCODEX_SHIM_ACTIVE: "1", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "90" },
      { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "65", EXTRA: "1" },
    );
    expect(env).toEqual({ PATH: "/bin", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "65", EXTRA: "1" });
  });

  it("leaves the environment untouched when no overrides are configured", () => {
    expect(claudeEnvironment({ A: "1" })).toEqual({ A: "1" });
  });
});
