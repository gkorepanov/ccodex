import { describe, expect, it } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { interruptAndCancelOwned } from "../../src/claude/interruptCompat.js";

describe("Claude interrupt receipt compatibility", () => {
  it("cancels only bridge-owned queued messages and reports races", async () => {
    const calls: string[] = [];
    const query = {
      interrupt: async () => ({ still_queued: ["owned-1", "foreign", "owned-2"] }),
      cancelAsyncMessage: async (id: string) => {
        calls.push(id);
        return id === "owned-1";
      },
    } as unknown as Query;
    await expect(interruptAndCancelOwned(query, new Set(["owned-1", "owned-2"]), new Set(["interrupt_receipt_v1"])))
      .resolves.toEqual({ receiptSupported: true, cancelled: ["owned-1"], raced: ["owned-2"] });
    expect(calls).toEqual(["owned-1", "owned-2"]);
  });

  it("keeps compatibility with older CLIs without receipts", async () => {
    const query = { interrupt: async () => undefined } as unknown as Query;
    await expect(interruptAndCancelOwned(query, new Set(["owned"]), new Set())).resolves.toEqual({
      receiptSupported: false, cancelled: [], raced: [],
    });
  });
});
