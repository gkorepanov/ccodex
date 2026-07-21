import { describe, expect, it } from "vitest";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { safeSessionPermissionUpdates } from "../../src/claude/session/permissionUpdates.js";

const rule = (
  overrides: Partial<Extract<PermissionUpdate, { type: "addRules" }>> = {},
): PermissionUpdate => ({
  type: "addRules",
  rules: [{ toolName: "Bash", ruleContent: "printf ok" }],
  behavior: "allow",
  destination: "session",
  ...overrides,
});

describe("safeSessionPermissionUpdates", () => {
  it("returns the provider's complete safe session update set unchanged", () => {
    const suggestions: PermissionUpdate[] = [
      rule(),
      { type: "addDirectories", directories: ["/repo/output"], destination: "session" },
    ];

    expect(safeSessionPermissionUpdates({ suggestions })).toBe(suggestions);
  });

  it.each([
    ["missing suggestions", undefined],
    ["empty suggestions", []],
    ["persistent destination", [rule({ destination: "projectSettings" })]],
    ["ask rule", [rule({ behavior: "ask" })]],
    ["deny rule", [rule({ behavior: "deny" })]],
    ["replacement", [{ type: "replaceRules", rules: [], behavior: "allow", destination: "session" }]],
    ["removal", [{ type: "removeRules", rules: [], behavior: "allow", destination: "session" }]],
    ["mode change", [{ type: "setMode", mode: "bypassPermissions", destination: "session" }]],
    ["directory removal", [{ type: "removeDirectories", directories: ["/repo"], destination: "session" }]],
  ] satisfies Array<[string, PermissionUpdate[] | undefined]>)("rejects %s", (_name, suggestions) => {
    expect(safeSessionPermissionUpdates(suggestions ? { suggestions } : {})).toBeUndefined();
  });

  it("rejects session persistence when a configured ask rule forced the prompt", () => {
    expect(safeSessionPermissionUpdates({
      suggestions: [rule()],
      matchedAskRule: { source: "projectSettings", toolName: "Bash", ruleContent: "printf ok" },
    })).toBeUndefined();
  });
});
