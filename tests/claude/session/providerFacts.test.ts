import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  normalizeProviderMessage,
  providerEventIdentity,
} from "../../../src/claude/session/providerFacts.js";

describe("provider fact normalization", () => {
  it("generation-fences an ordinary message with its neutral provider identity", () => {
    const message = {
      type: "system",
      subtype: "status",
      status: "requesting",
      uuid: "status-1",
      session_id: "session-1",
    } as unknown as SDKMessage;

    const fact = normalizeProviderMessage(17, message);

    expect(fact).toEqual({
      kind: "message",
      runtimeGeneration: 17,
      providerEventId: "status-1",
      providerEventType: "system/status",
      message,
    });
    expect(fact.message).toBe(message);
  });

  it("discriminates result boundaries as terminal facts", () => {
    const message = {
      type: "result",
      subtype: "success",
      uuid: "result-1",
      session_id: "session-1",
    } as unknown as SDKResultMessage;

    const fact = normalizeProviderMessage(3, message);

    expect(fact).toMatchObject({
      kind: "terminal",
      runtimeGeneration: 3,
      providerEventId: "result-1",
      providerEventType: "result",
    });
    if (fact.kind === "terminal") expect(fact.message.subtype).toBe("success");
  });

  it("keeps identity total for forward-compatible messages without a uuid", () => {
    const message = { type: "future_provider_event" } as unknown as SDKMessage;

    expect(providerEventIdentity(message)).toEqual({
      providerEventId: null,
      providerEventType: "future_provider_event",
    });
  });
});
