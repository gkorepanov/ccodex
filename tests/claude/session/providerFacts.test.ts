import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  normalizeProviderMessage,
  providerEventIdentity,
  toolResults,
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

  it("uses Claude tool_result_meta instead of parsing denial prose", () => {
    const message = {
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "bash-1",
          content: "opaque provider text",
          is_error: true,
        }],
      },
      tool_result_meta: [{
        id: "bash-1",
        non_execution_kind: "user-rejected",
        user_feedback: "Do not run that.",
      }],
    } as unknown as SDKMessage;

    expect(toolResults(message)).toEqual([{
      toolUseId: "bash-1",
      output: "opaque provider text",
      isError: true,
      nonExecutionKind: "user-rejected",
      userFeedback: "Do not run that.",
    }]);
  });

  it("keeps a forked background Skill result on the generic tool lifecycle", () => {
    const message = {
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "skill-1",
          content: "Skill launched in background.",
        }],
      },
      tool_use_result: {
        type: "skill",
        background: true,
        agentId: "skill-agent-1",
      },
    } as unknown as SDKMessage;

    expect(toolResults(message)).toEqual([{
      toolUseId: "skill-1",
      output: "Skill launched in background.",
      isError: false,
    }]);
  });
});
