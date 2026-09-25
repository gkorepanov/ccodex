/** Returns the stable Codex item id for a Claude API response block. */
export function assistantBlockItemId(messageId: string, apiBlockIndex: number): string {
  return `${messageId}:${apiBlockIndex}`;
}

/**
 * A message this long is an answer, not a remark on the way (Claude marks neither; sizes of interim messages cluster
 * under 300 and over 2000 characters). Desktop shows only a turn's last message unfolded: when work goes on after
 * such a message, it ends its turn and the work goes on in a new one.
 */
export const ANSWER_CHARS = 800;

/** The turn Claude goes on in after an answer, with no prompt of its own: named after the answer's last block. */
export function continuationTurnId(blockItemId: string): string {
  return `${blockItemId}:continued`;
}
