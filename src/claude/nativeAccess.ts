import type { JsonObject } from "../protocol/codex.js";

/** Original Codex authority, kept separately from Claude's coarser permission modes. */
export interface NativeMcpAccess {
  permissions?: string;
  sandbox?: string;
  sandboxPolicy?: JsonObject;
  runtimeWorkspaceRoots?: string[];
  approvalPolicy?: unknown;
  approvalsReviewer?: string;
  config?: JsonObject;
  disabledPluginIds?: string[];
}

export function nativeAccessFrom(params: JsonObject, current: NativeMcpAccess = {}): NativeMcpAccess {
  const next = structuredClone(current);
  for (const key of ["runtimeWorkspaceRoots", "approvalPolicy", "approvalsReviewer", "config", "disabledPluginIds"] as const) {
    if (params[key] !== undefined && params[key] !== null) next[key] = structuredClone(params[key]);
  }
  const policy = params.sandboxPolicy ?? (typeof params.sandbox === "object" ? params.sandbox : undefined);
  if (policy) {
    delete next.permissions; delete next.sandbox;
    next.sandboxPolicy = structuredClone(policy);
  } else if (typeof params.permissions === "string") {
    delete next.sandbox; delete next.sandboxPolicy;
    next.permissions = params.permissions;
  } else if (typeof params.sandbox === "string") {
    delete next.permissions; delete next.sandboxPolicy;
    next.sandbox = params.sandbox;
  }
  return next;
}
