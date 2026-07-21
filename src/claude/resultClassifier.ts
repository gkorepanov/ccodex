import type { CodexErrorInfo } from "../codex/generated/v2/CodexErrorInfo.js";
import {
  ORG_POLICY_LIMIT_PREFIXES,
  USAGE_LIMIT_ERROR_PREFIXES,
  USAGE_TRANSITION_PREFIXES,
  USAGE_WARNING_PREFIXES,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeResultClassification {
  readonly status: "completed" | "interrupted" | "failed";
  readonly error?: string;
  readonly codexErrorInfo?: CodexErrorInfo;
}

export interface ClaudeResultInput {
  readonly subtype: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly errors?: readonly string[];
  readonly terminal_reason?: string | null;
}

function providerErrorInfo(providerError: string | undefined, message: string | undefined): CodexErrorInfo | undefined {
  if (providerError === "authentication_failed" || providerError === "oauth_org_not_allowed") return "unauthorized";
  if (providerError === "billing_error" || providerError === "rate_limit") return "usageLimitExceeded";
  if (providerError === "overloaded") return "serverOverloaded";
  if (providerError === "server_error") return "internalServerError";
  if (providerError === "invalid_request" || providerError === "model_not_found" || providerError === "max_output_tokens") return "badRequest";
  if (providerError === "unknown") return "other";
  if (message && ORG_POLICY_LIMIT_PREFIXES.some((prefix) => message.startsWith(prefix))) return "badRequest";
  if (message && USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))) return "usageLimitExceeded";
  if (message && [...USAGE_TRANSITION_PREFIXES, ...USAGE_WARNING_PREFIXES].some((prefix) => message.startsWith(prefix))) {
    return undefined;
  }
  const normalized = message?.toLocaleLowerCase() ?? "";
  if (/auth|oauth|unauthori[sz]ed/.test(normalized)) return "unauthorized";
  if (/rate.?limit|billing|credit|usage.?limit/.test(normalized)) return "usageLimitExceeded";
  if (/overload/.test(normalized)) return "serverOverloaded";
  if (/model.?not.?found|invalid.?request/.test(normalized)) return "badRequest";
  return undefined;
}

export function classifyClaudeRuntimeError(message: string): CodexErrorInfo {
  if (/disconnect|stream.*closed|exited before|eof/i.test(message)) {
    return { responseStreamDisconnected: { httpStatusCode: null } };
  }
  if (/connect|socket|network|timed?\s*out|econn/i.test(message)) {
    return { httpConnectionFailed: { httpStatusCode: null } };
  }
  return providerErrorInfo(undefined, message) ?? "other";
}

export function classifyClaudeResult(
  message: ClaudeResultInput,
  providerError?: string,
): ClaudeResultClassification {
  if (message.subtype === "success" && !message.is_error && !providerError) return { status: "completed" };
  const errors = message.subtype === "success"
    ? [providerError, message.result].filter((value): value is string => Boolean(value))
    : message.errors ?? [];
  const interrupted = message.terminal_reason === "aborted_tools" || message.terminal_reason === "aborted_streaming" ||
    errors.some((value) => value.toLocaleLowerCase().includes("interrupt") || value.toLocaleLowerCase().includes("abort"));
  const error = errors[0];
  const codexErrorInfo = interrupted ? undefined : providerErrorInfo(providerError, error);
  return {
    status: interrupted ? "interrupted" : "failed",
    ...(error ? { error } : {}),
    ...(codexErrorInfo ? { codexErrorInfo } : {}),
  };
}
