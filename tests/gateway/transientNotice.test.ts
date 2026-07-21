import { describe, expect, it } from "vitest";
import {
  systemNoticeText, transientAgentNotice, transientCommandNotice, transientSystemNotice,
} from "../../src/gateway/transientNotice.js";

describe("transientAgentNotice", () => {
  it("builds a successful agent-message lifecycle without durable provider input", () => {
    const notice = transientAgentNotice("thread-1", "Fork is processing.", 1_700_000_000_000);
    expect(notice.response.turn).toMatchObject({ status: "inProgress", items: [] });
    expect(notice.notifications.map((entry) => entry.method)).toEqual([
      "turn/started",
      "item/started",
      "item/agentMessage/delta",
      "item/completed",
      "turn/completed",
    ]);
    expect(notice.notifications.at(-1)?.params).toMatchObject({
      threadId: "thread-1",
      turn: { status: "completed", items: [{ type: "agentMessage", text: "Fork is processing." }] },
    });
  });

  it("marks non-model information and errors with distinct emoji prefixes", () => {
    expect(systemNoticeText("Fork is processing.")).toBe("◆ **CCodex** │ Fork is processing.");
    expect(systemNoticeText("Provider exploded.", "error")).toBe("◆ **CCodex** │ ⚠️ Provider exploded.");
    expect(transientSystemNotice("thread-1", "Provider exploded.", "error", 1_700_000_000_000)
      .notifications.at(-1)?.params).toMatchObject({
      turn: { items: [{ text: "◆ **CCodex** │ ⚠️ Provider exploded." }] },
    });
  });

  it("projects a zero-token command response as one complete transient turn", () => {
    const input = [{ type: "text" as const, text: "/ccstatus", text_elements: [] }];
    const notice = transientCommandNotice(
      "thread-1",
      input,
      "◆ **CCodex** │ status",
      "client-status",
      1_700_000_000_000,
    );
    expect(notice.response.turn).toMatchObject({
      status: "inProgress",
      items: [{ type: "userMessage", clientId: "client-status", content: input }],
    });
    expect(notice.notifications.map((event) => event.method)).toEqual([
      "turn/started",
      "item/started",
      "item/completed",
      "item/started",
      "item/agentMessage/delta",
      "item/completed",
      "turn/completed",
    ]);
    expect(notice.notifications.at(-1)).toMatchObject({
      params: {
        turn: {
          status: "completed",
          items: [
            { type: "userMessage", content: input },
            { type: "agentMessage", text: "◆ **CCodex** │ status", phase: "final_answer" },
          ],
        },
      },
    });
  });
});
