import type { Thread } from "../codex/generated/v2/Thread.js";
import type { ThreadForkParams } from "../codex/generated/v2/ThreadForkParams.js";
import type { Logger } from "../observability/logger.js";
import { isRequest, isResponse, type RequestId, type RpcMessage } from "../protocol/envelopes.js";
import type { StockRpc } from "./stockRpc.js";

export const STOCK_SIDE_THREAD_SOURCE = "ccodexSide";
export const STOCK_SIDE_DISCONNECT_GRACE_MS = 60 * 60_000;

type PendingKind = "create" | "delete" | "promote";

interface Pending {
  readonly kind: PendingKind;
  readonly connectionId: string;
  readonly threadId?: string;
}

function requestKey(connectionId: string, id: RequestId): string {
  return `${connectionId}:${typeof id}:${id}`;
}

function isThread(value: unknown): value is Thread {
  return Boolean(value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string");
}

function isMarked(thread: Thread): boolean {
  return thread.threadSource === STOCK_SIDE_THREAD_SOURCE;
}

function userSideFork(params: ThreadForkParams): boolean {
  return params.ephemeral === true && params.excludeTurns === true && params.threadSource === "user";
}

function projectThread(thread: Thread): Thread {
  return { ...thread, ephemeral: true, path: null, threadSource: "user" };
}

/**
 * Keeps stock `/side` chats on native Codex rollout rails while projecting
 * them as ephemeral to App clients. A later ordinary fork therefore promotes
 * the hidden rollout without CCodex copying or rebuilding provider history.
 */
export class StockSideThreads {
  private readonly hidden = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly connectionsByThread = new Map<string, Set<string>>();
  private readonly threadsByConnection = new Map<string, Set<string>>();
  private readonly cleanupTimers = new Map<string, NodeJS.Timeout>();
  private closed = false;

  public constructor(
    private readonly enabled: boolean,
    private readonly cleanupStock: StockRpc,
    private readonly logger: Logger,
    private readonly graceMs = STOCK_SIDE_DISCONNECT_GRACE_MS,
  ) {}

  public async recover(): Promise<void> {
    if (!this.enabled) return;
    let cursor: string | null = null;
    do {
      const result = await this.cleanupStock.request("thread/list", { cursor, limit: 100 }) as {
        data: Thread[];
        nextCursor: string | null;
      };
      for (const thread of result.data) {
        if (!isMarked(thread)) continue;
        this.hidden.add(thread.id);
        const ageMs = Math.max(0, Date.now() - thread.updatedAt * 1_000);
        this.scheduleCleanup(thread.id, Math.max(0, this.graceMs - ageMs));
      }
      cursor = result.nextCursor;
    } while (cursor);
  }

  public async prepareRequest(connectionId: string, message: RpcMessage, stock: StockRpc): Promise<RpcMessage> {
    if (!this.enabled || !isRequest(message)) return message;
    const params = message.params && typeof message.params === "object"
      ? message.params as Record<string, unknown>
      : {};
    if (message.method === "thread/fork" && userSideFork(params as ThreadForkParams)) {
      this.pending.set(requestKey(connectionId, message.id), { kind: "create", connectionId });
      return {
        ...message,
        params: { ...params, ephemeral: false, threadSource: STOCK_SIDE_THREAD_SOURCE },
      } as RpcMessage;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (!threadId) return message;
    const hidden = this.hidden.has(threadId)
      || (["thread/fork", "thread/delete", "thread/unsubscribe"].includes(message.method)
        && await this.discover(threadId, stock));
    if (!hidden) return message;
    if (message.method === "thread/unsubscribe") {
      this.detachThread(connectionId, threadId);
      return message;
    }
    this.attach(connectionId, threadId);
    if (message.method === "thread/delete") {
      this.pending.set(requestKey(connectionId, message.id), { kind: "delete", connectionId, threadId });
    } else if (message.method === "thread/fork" && params.ephemeral !== true) {
      this.pending.set(requestKey(connectionId, message.id), { kind: "promote", connectionId, threadId });
      return { ...message, params: { ...params, ephemeral: false, threadSource: "user" } } as RpcMessage;
    }
    return message;
  }

  public projectMessage(connectionId: string, message: RpcMessage): RpcMessage {
    if (!this.enabled) return message;
    if (isResponse(message)) {
      const pending = this.pending.get(requestKey(connectionId, message.id));
      this.pending.delete(requestKey(connectionId, message.id));
      if (pending?.kind === "delete" && "result" in message && pending.threadId) this.forget(pending.threadId);
      if (pending?.kind === "promote" && "result" in message && pending.threadId) {
        this.detachThread(pending.connectionId, pending.threadId);
      }
      if (pending?.kind === "create" && "result" in message) {
        const thread = this.resultThread(message.result);
        if (thread) this.attach(connectionId, thread.id);
      }
    }
    const container = "result" in message
      ? message.result
      : "params" in message ? message.params : undefined;
    if (!container || typeof container !== "object") return message;
    if ("result" in message && Array.isArray((container as { data?: unknown }).data)) {
      const data = (container as { data: unknown[] }).data;
      const visible = data.filter((entry) => {
        if (!isThread(entry)) return true;
        if (isMarked(entry)) this.hidden.add(entry.id);
        return !this.hidden.has(entry.id);
      });
      if (visible.length !== data.length) {
        return { ...message, result: { ...(container as Record<string, unknown>), data: visible } };
      }
    }
    const thread = this.resultThread(container);
    if (!thread) return message;
    if (isMarked(thread)) this.attach(connectionId, thread.id);
    if (!this.hidden.has(thread.id)) return message;
    const projected = projectThread(thread);
    if ("result" in message) {
      return { ...message, result: { ...(message.result as Record<string, unknown>), thread: projected } };
    }
    if ("params" in message) {
      return { ...message, params: { ...(message.params as Record<string, unknown>), thread: projected } } as RpcMessage;
    }
    return message;
  }

  public filterThreads(threads: readonly Thread[]): Thread[] {
    if (!this.enabled) return [...threads];
    return threads.filter((thread) => {
      if (isMarked(thread)) this.hidden.add(thread.id);
      return !this.hidden.has(thread.id);
    });
  }

  public hiddenIds(threads: readonly Thread[]): ReadonlySet<string> {
    this.filterThreads(threads);
    return this.hidden;
  }

  public detachConnection(connectionId: string): void {
    for (const threadId of this.threadsByConnection.get(connectionId) ?? []) this.detachThread(connectionId, threadId);
    this.threadsByConnection.delete(connectionId);
    for (const [key, pending] of this.pending) {
      if (pending.connectionId === connectionId) this.pending.delete(key);
    }
  }

  public close(): void {
    this.closed = true;
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
    this.cleanupTimers.clear();
    this.pending.clear();
  }

  private resultThread(value: unknown): Thread | undefined {
    if (!value || typeof value !== "object") return undefined;
    const thread = (value as { thread?: unknown }).thread;
    return isThread(thread) ? thread : undefined;
  }

  private async discover(threadId: string, stock: StockRpc): Promise<boolean> {
    try {
      const result = await stock.request("thread/read", { threadId, includeTurns: false });
      const thread = this.resultThread(result);
      if (!thread || !isMarked(thread)) return false;
      this.hidden.add(threadId);
      return true;
    } catch {
      return false;
    }
  }

  private attach(connectionId: string, threadId: string): void {
    this.hidden.add(threadId);
    const timer = this.cleanupTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.cleanupTimers.delete(threadId);
    const connections = this.connectionsByThread.get(threadId) ?? new Set<string>();
    connections.add(connectionId);
    this.connectionsByThread.set(threadId, connections);
    const threads = this.threadsByConnection.get(connectionId) ?? new Set<string>();
    threads.add(threadId);
    this.threadsByConnection.set(connectionId, threads);
  }

  private detachThread(connectionId: string, threadId: string): void {
    const connections = this.connectionsByThread.get(threadId);
    connections?.delete(connectionId);
    if (connections?.size === 0) this.connectionsByThread.delete(threadId);
    const threads = this.threadsByConnection.get(connectionId);
    threads?.delete(threadId);
    if (threads?.size === 0) this.threadsByConnection.delete(connectionId);
    if (!this.connectionsByThread.has(threadId)) this.scheduleCleanup(threadId, this.graceMs);
  }

  private scheduleCleanup(threadId: string, delayMs: number): void {
    if (this.closed || this.cleanupTimers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(threadId);
      if (this.connectionsByThread.has(threadId)) return;
      void this.cleanupStock.request("thread/delete", { threadId }).then(
        () => this.forget(threadId),
        (error: unknown) => {
          this.logger.warn("stock.side.cleanup-failed", { threadId, error: String(error) });
          this.scheduleCleanup(threadId, Math.min(this.graceMs, 60_000));
        },
      );
    }, delayMs);
    timer.unref();
    this.cleanupTimers.set(threadId, timer);
  }

  private forget(threadId: string): void {
    const timer = this.cleanupTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.cleanupTimers.delete(threadId);
    this.hidden.delete(threadId);
    for (const connectionId of this.connectionsByThread.get(threadId) ?? []) {
      const threads = this.threadsByConnection.get(connectionId);
      threads?.delete(threadId);
      if (threads?.size === 0) this.threadsByConnection.delete(connectionId);
    }
    this.connectionsByThread.delete(threadId);
  }
}
