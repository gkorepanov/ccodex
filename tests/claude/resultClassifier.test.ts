import { describe, expect, it } from "vitest";
import {
  ORG_POLICY_LIMIT_PREFIXES,
  type SDKResultMessage,
  USAGE_LIMIT_ERROR_PREFIXES,
  USAGE_TRANSITION_PREFIXES,
  USAGE_WARNING_PREFIXES,
} from "@anthropic-ai/claude-agent-sdk";
import { classifyClaudeResult } from "../../src/claude/resultClassifier.js";

describe("Claude result classification", () => {
  it("uses authoritative abort terminal reasons even with opaque diagnostics", () => {
    const result = {
      type: "result", subtype: "error_during_execution", is_error: true,
      terminal_reason: "aborted_tools", errors: ["[ede_diagnostic] stop_reason=tool_use"],
    } as unknown as SDKResultMessage;
    expect(classifyClaudeResult(result)).toEqual({ status: "interrupted", error: "[ede_diagnostic] stop_reason=tool_use" });
  });

  it("does not misclassify ordinary provider failures", () => {
    const result = {
      type: "result", subtype: "error_during_execution", is_error: true,
      terminal_reason: "api_error", errors: ["overloaded"],
    } as unknown as SDKResultMessage;
    expect(classifyClaudeResult(result)).toEqual({ status: "failed", error: "overloaded", codexErrorInfo: "serverOverloaded" });
  });

  it.each([
    ["authentication_failed", "unauthorized"],
    ["rate_limit", "usageLimitExceeded"],
    ["model_not_found", "badRequest"],
    ["server_error", "internalServerError"],
  ] as const)("maps %s into Codex error metadata", (providerError, codexErrorInfo) => {
    const result = {
      type: "result", subtype: "success", is_error: true, result: providerError,
    } as unknown as SDKResultMessage;
    expect(classifyClaudeResult(result, providerError)).toMatchObject({ status: "failed", codexErrorInfo });
  });

  it("uses Anthropic's official usage and org-policy message buckets", () => {
    const classify = (error: string) => classifyClaudeResult({
      type: "result", subtype: "error_during_execution", is_error: true, errors: [error],
    } as unknown as SDKResultMessage);
    for (const prefix of USAGE_LIMIT_ERROR_PREFIXES) {
      expect(classify(`${prefix} details`)).toMatchObject({ codexErrorInfo: "usageLimitExceeded" });
    }
    for (const prefix of ORG_POLICY_LIMIT_PREFIXES) {
      expect(classify(`${prefix} details`)).toMatchObject({ codexErrorInfo: "badRequest" });
    }
    for (const prefix of [...USAGE_TRANSITION_PREFIXES, ...USAGE_WARNING_PREFIXES]) {
      expect(classify(`${prefix} details`)).not.toHaveProperty("codexErrorInfo");
    }
  });
});
