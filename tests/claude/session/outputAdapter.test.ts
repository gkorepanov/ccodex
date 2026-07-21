import { describe, expect, it } from "vitest";
import { SubscriptionHub } from "../../../src/gateway/subscriptions.js";
import { ClaudeOutputAdapter } from "../../../src/claude/session/outputAdapter.js";

describe("ClaudeOutputAdapter internal thread visibility", () => {
  it("keeps global sidebar output hidden and always releases suppression after failure", async () => {
    const hub = new SubscriptionHub();
    const output = new ClaudeOutputAdapter(hub);
    const methods: string[] = [];
    hub.attach("sidebar", (method) => methods.push(method));

    await expect(output.withInternalThreadHidden("temporary", async () => {
      expect(hub.isSuppressed("temporary")).toBe(true);
      output.emit("temporary", "thread/started", { thread: { id: "temporary" } });
      throw new Error("handoff failed");
    })).rejects.toThrow("handoff failed");

    expect(methods).toEqual([]);
    expect(hub.isSuppressed("temporary")).toBe(false);
    output.emit("temporary", "thread/started", { thread: { id: "temporary" } });
    expect(methods).toEqual(["thread/started"]);
  });
});
