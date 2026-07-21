import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

const sessionId = "00000000-0000-4000-8000-000000000001";
const ids = Array.from({ length: 9 }, (_, index) =>
  `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`);

export const compactedTranscript = {
  sessionId,
  appTurns: [
    { id: "turn-before-1", boundary: ids[1]!, status: "completed" },
    { id: "turn-before-2", boundary: ids[3]!, status: "completed" },
    { id: "turn-compact", boundary: ids[5]!, status: "completed" },
    { id: "turn-after", boundary: ids[6]!, status: "completed" },
    { id: "turn-interrupted", boundary: null, status: "interrupted" },
  ],
  entries: [
    {
      type: "user", uuid: ids[0], parentUuid: null, sessionId,
      message: { role: "user", content: "Remember the synthetic lighthouse." },
    },
    {
      type: "assistant", uuid: ids[1], parentUuid: ids[0], sessionId,
      message: { role: "assistant", content: [{ type: "text", text: "Remembered." }] },
    },
    {
      type: "user", uuid: ids[2], parentUuid: ids[1], sessionId,
      message: { role: "user", content: "Continue." },
    },
    {
      type: "assistant", uuid: ids[3], parentUuid: ids[2], sessionId,
      message: { role: "assistant", content: [{ type: "text", text: "Continuing." }] },
    },
    {
      type: "system", subtype: "compact_boundary", uuid: ids[4], parentUuid: null,
      logicalParentUuid: ids[3], sessionId,
      compactMetadata: {
        trigger: "auto", preTokens: 100_000, postTokens: 10_000,
        preservedSegment: { anchorUuid: ids[5] },
      },
    },
    {
      type: "user", uuid: ids[5], parentUuid: ids[4], sessionId, isCompactSummary: true,
      message: { role: "user", content: "Summary: synthetic lighthouse." },
    },
    {
      type: "assistant", uuid: ids[6], parentUuid: ids[5], sessionId,
      message: { role: "assistant", content: [{ type: "text", text: "After compaction." }] },
    },
    {
      type: "user", uuid: ids[7], parentUuid: ids[6], sessionId,
      message: { role: "user", content: "Start work." },
    },
    {
      type: "user", uuid: ids[8], parentUuid: ids[7], sessionId,
      message: { role: "user", content: "Pending input." },
    },
  ] as unknown as SessionStoreEntry[],
};
