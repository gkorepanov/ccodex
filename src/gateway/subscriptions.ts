import { projectRpcToPublicThread } from "./logicalThreadProjection.js";

export type NotificationSink = (method: string, params: unknown) => void;
export type ServerRequestSink = (id: string, method: string, params: unknown) => void;

interface Subscription {
  readonly connectionId: string;
  readonly sink: NotificationSink;
  readonly requestSink?: ServerRequestSink;
}

export class SubscriptionHub {
  private readonly subscriptions = new Map<string, Map<string, Subscription>>();
  private readonly connections = new Map<string, Subscription>();
  private readonly suppressedThreads = new Set<string>();
  private readonly mutedByConnection = new Map<string, Set<string>>();
  private readonly requestRecipients = new Map<string, Set<string>>();
  private readonly threadAliases = new Map<string, string>();
  private readonly hiddenUserMessageTurns = new Map<string, Set<string>>();

  private static readonly globalThreadNotifications = new Set([
    "thread/started",
    "thread/status/changed",
    "thread/name/updated",
    "thread/archived",
    "thread/unarchived",
    "thread/deleted",
    "thread/closed",
  ]);

  public attach(connectionId: string, sink: NotificationSink, requestSink?: ServerRequestSink): void {
    this.connections.set(connectionId, { connectionId, sink, ...(requestSink ? { requestSink } : {}) });
  }

  public subscribe(
    threadId: string,
    connectionId: string,
    sink: NotificationSink,
    requestSink?: ServerRequestSink,
  ): boolean {
    const threadSubscriptions = this.subscriptions.get(threadId) ?? new Map();
    threadSubscriptions.set(connectionId, { connectionId, sink, ...(requestSink ? { requestSink } : {}) });
    this.subscriptions.set(threadId, threadSubscriptions);
    return true;
  }

  public unsubscribe(threadId: string, connectionId: string): void {
    const threadSubscriptions = this.subscriptions.get(threadId);
    threadSubscriptions?.delete(connectionId);
    if (threadSubscriptions?.size === 0) this.subscriptions.delete(threadId);
  }

  public hasSubscribers(threadId: string): boolean {
    return (this.subscriptions.get(this.publicThreadId(threadId))?.size ?? 0) > 0;
  }

  public detach(connectionId: string): void {
    this.connections.delete(connectionId);
    this.mutedByConnection.delete(connectionId);
    for (const recipients of this.requestRecipients.values()) recipients.delete(connectionId);
    for (const [threadId, threadSubscriptions] of this.subscriptions) {
      threadSubscriptions.delete(connectionId);
      if (threadSubscriptions.size === 0) this.subscriptions.delete(threadId);
    }
  }

  public emit(threadId: string, method: string, params: unknown): void {
    if (this.suppressedThreads.has(threadId)) return;
    this.emitVisible(threadId, method, params, false);
  }

  public emitPublic(publicThreadId: string, method: string, params: unknown): void {
    this.emitVisible(publicThreadId, method, params, true);
  }

  private emitVisible(threadId: string, method: string, params: unknown, alreadyPublic: boolean): void {
    const visibleParams = this.withoutHiddenUserMessage(threadId, method, params);
    if (visibleParams === undefined) return;
    const publicThreadId = alreadyPublic ? threadId : this.publicThreadId(threadId);
    const projectedParams = publicThreadId === threadId ? visibleParams : projectRpcToPublicThread(
      { params: visibleParams }, { publicThreadId, backendThreadId: threadId },
    ).params;
    if (method === "serverRequest/resolved") {
      const requestId = projectedParams && typeof projectedParams === "object" && "requestId" in projectedParams
        ? (projectedParams as { requestId?: unknown }).requestId
        : undefined;
      if (typeof requestId !== "string") return;
      const recipients = this.requestRecipients.get(requestId) ?? new Set<string>();
      for (const connectionId of recipients) {
        const connection = this.connections.get(connectionId);
        if (connection) connection.sink(method, projectedParams);
        else this.subscriptions.get(publicThreadId)?.get(connectionId)?.sink(method, projectedParams);
      }
      this.requestRecipients.delete(requestId);
      return;
    }
    if (SubscriptionHub.globalThreadNotifications.has(method)) {
      for (const connection of this.connections.values()) {
        if (!this.isMuted(publicThreadId, connection.connectionId)) connection.sink(method, projectedParams);
      }
      for (const subscription of this.subscriptions.get(publicThreadId)?.values() ?? []) {
        if (!this.connections.has(subscription.connectionId) && !this.isMuted(publicThreadId, subscription.connectionId)) {
          subscription.sink(method, projectedParams);
        }
      }
      return;
    }
    for (const subscription of this.subscriptions.get(publicThreadId)?.values() ?? []) {
      if (!this.isMuted(publicThreadId, subscription.connectionId)) subscription.sink(method, projectedParams);
    }
  }

  public request(
    threadId: string,
    id: string,
    method: string,
    params: unknown,
    connectionId?: string,
  ): boolean {
    if (this.suppressedThreads.has(threadId)) return false;
    const publicThreadId = this.publicThreadId(threadId);
    const projectedParams = publicThreadId === threadId ? params : projectRpcToPublicThread(
      { params }, { publicThreadId, backendThreadId: threadId },
    ).params;
    if (connectionId) {
      const target = this.subscriptions.get(publicThreadId)?.get(connectionId) ?? this.connections.get(connectionId);
      if (!target?.requestSink) return false;
      target.requestSink(id, method, projectedParams);
      const recipients = this.requestRecipients.get(id) ?? new Set<string>();
      recipients.add(connectionId);
      this.requestRecipients.set(id, recipients);
      return true;
    }
    let delivered = false;
    const recipients = this.requestRecipients.get(id) ?? new Set<string>();
    for (const subscription of this.subscriptions.get(publicThreadId)?.values() ?? []) {
      if (!subscription.requestSink) continue;
      subscription.requestSink(id, method, projectedParams);
      recipients.add(subscription.connectionId);
      delivered = true;
    }
    if (delivered) {
      this.requestRecipients.set(id, recipients);
      return true;
    }
    // Subagent threads are projections and the App commonly subscribes only to
    // their parent. An approval still has to reach every attached App surface;
    // the request params retain the canonical child thread/turn/item identity.
    for (const connection of this.connections.values()) {
      if (!connection.requestSink) continue;
      connection.requestSink(id, method, projectedParams);
      recipients.add(connection.connectionId);
    }
    if (recipients.size > 0) this.requestRecipients.set(id, recipients);
    return recipients.size > 0;
  }

  public suppress(threadId: string): void { this.suppressedThreads.add(threadId); }
  public unsuppress(threadId: string): void { this.suppressedThreads.delete(threadId); }
  public isSuppressed(threadId: string): boolean { return this.suppressedThreads.has(threadId); }
  public threadDeleted(threadId: string): void {
    this.emit(threadId, "thread/deleted", { threadId });
    this.hiddenUserMessageTurns.delete(threadId);
  }
  public hideUserMessages(threadId: string, turnId: string): void {
    const turns = this.hiddenUserMessageTurns.get(threadId) ?? new Set<string>();
    turns.add(turnId);
    this.hiddenUserMessageTurns.set(threadId, turns);
  }
  public aliasThread(backendThreadId: string, publicThreadId: string): void {
    if (backendThreadId === publicThreadId) return;
    this.threadAliases.set(backendThreadId, publicThreadId);
  }
  public unaliasThread(backendThreadId: string): void { this.threadAliases.delete(backendThreadId); }
  public mute(threadId: string, connectionId: string): void {
    const threads = this.mutedByConnection.get(connectionId) ?? new Set<string>();
    threads.add(threadId);
    this.mutedByConnection.set(connectionId, threads);
  }
  public unmute(threadId: string, connectionId: string): void {
    const threads = this.mutedByConnection.get(connectionId);
    threads?.delete(threadId);
    if (threads?.size === 0) this.mutedByConnection.delete(connectionId);
  }
  private isMuted(threadId: string, connectionId: string): boolean {
    return this.mutedByConnection.get(connectionId)?.has(threadId) ?? false;
  }
  private publicThreadId(threadId: string): string {
    return this.threadAliases.get(threadId) ?? threadId;
  }

  private withoutHiddenUserMessage(threadId: string, method: string, params: unknown): unknown | undefined {
    if (!params || typeof params !== "object") return params;
    const record = params as Record<string, unknown>;
    const turn = record.turn && typeof record.turn === "object"
      ? record.turn as { id?: unknown; items?: unknown[] }
      : undefined;
    const turnId = typeof record.turnId === "string"
      ? record.turnId
      : typeof turn?.id === "string" ? turn.id : undefined;
    if (!turnId || !this.hiddenUserMessageTurns.get(threadId)?.has(turnId)) return params;
    const item = record.item && typeof record.item === "object"
      ? record.item as { type?: unknown }
      : undefined;
    if ((method === "item/started" || method === "item/completed") && item?.type === "userMessage") {
      return undefined;
    }
    const visible = Array.isArray(turn?.items) && turn.items.some((candidate) =>
      candidate && typeof candidate === "object" && (candidate as { type?: unknown }).type === "userMessage")
      ? { ...record, turn: { ...turn, items: turn.items.filter((candidate) =>
          !candidate || typeof candidate !== "object" || (candidate as { type?: unknown }).type !== "userMessage") } }
      : params;
    if (method === "turn/completed") {
      const turns = this.hiddenUserMessageTurns.get(threadId)!;
      turns.delete(turnId);
      if (turns.size === 0) this.hiddenUserMessageTurns.delete(threadId);
    }
    return visible;
  }
}
