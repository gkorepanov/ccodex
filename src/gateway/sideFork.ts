import type { ThreadForkParams } from "../codex/generated/v2/ThreadForkParams.js";

export function isUserSideFork(params: ThreadForkParams): boolean {
  return params.ephemeral === true
    && params.excludeTurns === true
    && (params.threadSource == null || params.threadSource === "user");
}

export function normalizeUserSideFork(params: ThreadForkParams): ThreadForkParams {
  return isUserSideFork(params) && params.threadSource !== "user"
    ? { ...params, threadSource: "user" }
    : params;
}
