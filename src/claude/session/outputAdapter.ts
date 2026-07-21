import type { SubscriptionHub } from "../../gateway/subscriptions.js";

export class ClaudeOutputAdapter {
  public constructor(private readonly hub: SubscriptionHub) {}

  public emit(threadId: string, method: string, params: unknown): void {
    this.hub.emit(threadId, method, params);
  }

  public request(
    threadId: string,
    requestId: string,
    method: string,
    params: unknown,
    connectionId?: string,
  ): boolean {
    return this.hub.request(threadId, requestId, method, params, connectionId);
  }

  public suppress(threadId: string): void {
    this.hub.suppress(threadId);
  }

  public unsuppress(threadId: string): void {
    this.hub.unsuppress(threadId);
  }

  public async withInternalThreadHidden<Result>(
    threadId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    this.hub.suppress(threadId);
    try {
      return await operation();
    } finally {
      this.hub.unsuppress(threadId);
    }
  }

  public threadDeleted(threadId: string): void {
    this.hub.threadDeleted(threadId);
  }
}
