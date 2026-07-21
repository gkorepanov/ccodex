import type { Query } from "@anthropic-ai/claude-agent-sdk";

interface CancelCompatibleQuery extends Query {
  cancelAsyncMessage?(messageUuid: string): Promise<boolean>;
}

export interface InterruptCancellation {
  readonly receiptSupported: boolean;
  readonly cancelled: string[];
  readonly raced: string[];
}

export async function interruptAndCancelOwned(
  query: Query,
  ownedMessageIds: ReadonlySet<string>,
  capabilities: ReadonlySet<string>,
): Promise<InterruptCancellation> {
  const receipt = await query.interrupt();
  if (!receipt || !capabilities.has("interrupt_receipt_v1")) {
    return { receiptSupported: false, cancelled: [], raced: [] };
  }
  const cancel = (query as CancelCompatibleQuery).cancelAsyncMessage;
  const ownedQueued = receipt.still_queued.filter((id) => ownedMessageIds.has(id));
  if (ownedQueued.length > 0 && !cancel) throw new Error("Claude CLI advertised interrupt receipts but the pinned SDK cannot cancel queued messages.");
  const cancelled: string[] = [];
  const raced: string[] = [];
  for (const id of ownedQueued) {
    if (await cancel!.call(query, id)) cancelled.push(id);
    else raced.push(id);
  }
  return { receiptSupported: true, cancelled, raced };
}
