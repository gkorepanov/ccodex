import type { Thread } from "../codex/generated/v2/Thread.js";
import type { ThreadForkParams } from "../codex/generated/v2/ThreadForkParams.js";
import type { ThreadForkResponse } from "../codex/generated/v2/ThreadForkResponse.js";
import type { ThreadSettings } from "../codex/generated/v2/ThreadSettings.js";
import type { ThreadTokenUsage } from "../codex/generated/v2/ThreadTokenUsage.js";
import {
  isRequest,
  isResponse,
  type RequestId,
  type RpcMessage,
} from "../protocol/envelopes.js";
import { stateModelName, type ThreadStateSnapshot } from "./stateCommand.js";

interface Pending {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

type Settings = Pick<
ThreadSettings,
"model" | "serviceTier" | "effort" | "approvalPolicy" | "approvalsReviewer" | "sandboxPolicy"
>;

function key(connectionId: string, id: RequestId): string {
  return `${connectionId}:${typeof id}:${id}`;
}

function settingsFrom(value: Record<string, unknown>): Partial<Settings> {
  const collaboration = value.collaborationMode && typeof value.collaborationMode === "object"
    ? (value.collaborationMode as { settings?: Record<string, unknown> }).settings
    : undefined;
  const model = typeof value.model === "string"
    ? value.model
    : typeof collaboration?.model === "string" ? collaboration.model : undefined;
  const effort = typeof value.effort === "string"
    ? value.effort
    : typeof value.reasoningEffort === "string"
      ? value.reasoningEffort
      : typeof collaboration?.reasoning_effort === "string" ? collaboration.reasoning_effort : undefined;
  return {
    ...(model ? { model } : {}),
    ...("serviceTier" in value && (typeof value.serviceTier === "string" || value.serviceTier === null)
      ? { serviceTier: value.serviceTier } : {}),
    ...(effort ? { effort: effort as Settings["effort"] } : {}),
    ...(value.approvalPolicy ? { approvalPolicy: value.approvalPolicy as Settings["approvalPolicy"] } : {}),
    ...(value.approvalsReviewer
      ? { approvalsReviewer: value.approvalsReviewer as Settings["approvalsReviewer"] } : {}),
    ...(value.sandboxPolicy
      ? { sandboxPolicy: value.sandboxPolicy as Settings["sandboxPolicy"] }
      : value.sandbox ? { sandboxPolicy: value.sandbox as Settings["sandboxPolicy"] } : {}),
  };
}

export class StockStateTracker {
  private readonly pending = new Map<string, Pending>();
  private readonly settings = new Map<string, Partial<Settings>>();
  private readonly usage = new Map<string, ThreadTokenUsage>();
  private readonly threads = new Map<string, Thread>();
  private readonly responses = new Map<string, Omit<ThreadForkResponse, "thread">>();

  public observeRequest(connectionId: string, message: RpcMessage): void {
    if (!isRequest(message)) return;
    const params = message.params && typeof message.params === "object"
      ? message.params as Record<string, unknown>
      : {};
    if (["thread/start", "thread/resume", "thread/fork", "thread/settings/update", "turn/start"]
      .includes(message.method)) {
      this.pending.set(key(connectionId, message.id), { method: message.method, params });
    }
  }

  public observeResponse(connectionId: string, message: RpcMessage): void {
    if (!isResponse(message)) return;
    const pending = this.pending.get(key(connectionId, message.id));
    if (!pending) return;
    this.pending.delete(key(connectionId, message.id));
    if ("error" in message) return;
    const result = message.result && typeof message.result === "object"
      ? message.result as Record<string, unknown>
      : {};
    const thread = result.thread && typeof result.thread === "object"
      ? result.thread as Thread
      : undefined;
    const threadId = thread?.id
      ?? (typeof pending.params.threadId === "string" ? pending.params.threadId : undefined);
    if (!threadId) return;
    if (["thread/start", "thread/resume", "thread/fork"].includes(pending.method)) {
      this.merge(threadId, settingsFrom(result));
      if (thread) this.threads.set(threadId, thread);
      if (thread && typeof result.model === "string" && typeof result.modelProvider === "string"
        && typeof result.cwd === "string" && Array.isArray(result.runtimeWorkspaceRoots)
        && Array.isArray(result.instructionSources) && result.approvalPolicy && result.approvalsReviewer
        && result.sandbox && "activePermissionProfile" in result && "reasoningEffort" in result) {
        const { thread: _, ...response } = result as unknown as ThreadForkResponse;
        this.responses.set(threadId, response);
      }
    } else if (pending.method === "thread/settings/update") {
      this.merge(threadId, settingsFrom(pending.params));
    } else if (pending.method === "turn/start") {
      this.merge(threadId, settingsFrom(pending.params));
    }
  }

  public observeNotification(message: RpcMessage): void {
    if (!("method" in message) || "id" in message) return;
    const params = message.params && typeof message.params === "object"
      ? message.params as Record<string, unknown>
      : {};
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (message.method === "thread/settings/updated" && threadId
      && params.threadSettings && typeof params.threadSettings === "object") {
      this.merge(threadId, settingsFrom(params.threadSettings as Record<string, unknown>));
    } else if (message.method === "thread/tokenUsage/updated" && threadId
      && params.tokenUsage && typeof params.tokenUsage === "object") {
      this.usage.set(threadId, params.tokenUsage as ThreadTokenUsage);
    } else if (message.method === "thread/deleted" && threadId) {
      this.settings.delete(threadId);
      this.usage.delete(threadId);
      this.threads.delete(threadId);
      this.responses.delete(threadId);
    }
    const thread = params.thread && typeof params.thread === "object" ? params.thread as Thread : undefined;
    if (message.method === "thread/started" && thread) this.threads.set(thread.id, thread);
  }

  public completeForkParams(params: ThreadForkParams): ThreadForkParams {
    const source = this.settings.get(params.threadId);
    if (!source) return params;
    const config = params.config ?? {};
    const inheritEffort = source.effort !== undefined && !("model_reasoning_effort" in config);
    return {
      ...params,
      ...(params.model === undefined && source.model !== undefined ? { model: source.model } : {}),
      ...(params.serviceTier === undefined && source.serviceTier !== undefined
        ? { serviceTier: source.serviceTier }
        : {}),
      ...(inheritEffort
        ? { config: { ...config, model_reasoning_effort: source.effort } }
        : {}),
    };
  }

  public sideSnapshot(
    params: ThreadForkParams,
    targetThreadId: string,
  ): ThreadForkResponse | undefined {
    const source = this.threads.get(params.threadId);
    const response = this.responses.get(params.threadId);
    if (!source || !response) return undefined;
    const completed = this.completeForkParams(params);
    return {
      ...response,
      ...(completed.model ? { model: completed.model } : {}),
      ...(completed.serviceTier !== undefined ? { serviceTier: completed.serviceTier } : {}),
      thread: {
        ...source,
        id: targetThreadId,
        forkedFromId: params.threadId,
        ephemeral: true,
        path: null,
        cwd: params.cwd ?? source.cwd,
        threadSource: "user",
        status: { type: "idle" },
        name: source.name,
        turns: [],
      },
      cwd: params.cwd ?? response.cwd,
    };
  }

  public snapshot(thread: Thread): ThreadStateSnapshot {
    const settings = this.settings.get(thread.id);
    return {
      provider: "codex",
      model: stateModelName("codex", settings?.model ?? "unknown"),
      effort: settings?.effort ?? null,
      serviceTier: settings?.serviceTier ?? null,
      approvalPolicy: settings?.approvalPolicy ?? null,
      approvalsReviewer: settings?.approvalsReviewer ?? null,
      sandboxPolicy: settings?.sandboxPolicy ?? null,
      thread,
      tokenUsage: this.usage.get(thread.id) ?? null,
      providerCostUsd: null,
    };
  }

  public detach(connectionId: string): void {
    for (const pendingKey of this.pending.keys()) {
      if (pendingKey.startsWith(`${connectionId}:`)) this.pending.delete(pendingKey);
    }
  }

  private merge(threadId: string, update: Partial<Settings>): void {
    this.settings.set(threadId, { ...this.settings.get(threadId), ...update });
  }
}
