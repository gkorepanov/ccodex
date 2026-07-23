import { describe, expect, it } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import { StockStateTracker } from "../../src/state/stockStateTracker.js";

function thread(): Thread {
  return {
    id: "stock-1", extra: null, sessionId: "stock-1", forkedFromId: null, parentThreadId: null,
    preview: "", ephemeral: false, historyMode: "paginated", modelProvider: "openai",
    createdAt: 1, updatedAt: 1, recencyAt: 1, status: { type: "idle" }, path: null,
    cwd: "/tmp", cliVersion: "0.144.4", source: "appServer", threadSource: "user",
    agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [],
  };
}

describe("stock state tracker", () => {
  it("keeps successful resume/settings/turn overrides and exact usage across connections", () => {
    const tracker = new StockStateTracker();
    tracker.observeRequest("desktop", {
      id: "resume", method: "thread/resume", params: { threadId: "stock-1" },
    });
    tracker.observeResponse("desktop", {
      id: "resume",
      result: {
        thread: thread(),
        model: "gpt-5.6-sol",
        serviceTier: "default",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
        reasoningEffort: "high",
      },
    });
    tracker.observeNotification({
      method: "thread/settings/updated",
      params: {
        threadId: "stock-1",
        threadSettings: {
          model: "gpt-5.6-sol", serviceTier: "priority", effort: "xhigh",
          approvalPolicy: "on-request", approvalsReviewer: "auto_review",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        },
      },
    });
    tracker.observeNotification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "stock-1", turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 100, inputTokens: 80, cachedInputTokens: 40,
            outputTokens: 20, reasoningOutputTokens: 5,
          },
          last: {
            totalTokens: 60, inputTokens: 50, cachedInputTokens: 30,
            outputTokens: 10, reasoningOutputTokens: 2,
          },
          modelContextWindow: 200,
        },
      },
    });

    expect(tracker.snapshot(thread())).toMatchObject({
      model: "Codex 5.6 Sol",
      effort: "xhigh",
      serviceTier: "priority",
      approvalsReviewer: "auto_review",
      tokenUsage: { total: { totalTokens: 100 }, last: { totalTokens: 60 } },
      providerCostUsd: null,
    });
  });

  it("does not apply failed sticky-setting updates", () => {
    const tracker = new StockStateTracker();
    tracker.observeRequest("desktop", {
      id: "turn", method: "turn/start",
      params: { threadId: "stock-1", model: "gpt-5.6-terra", effort: "medium" },
    });
    tracker.observeResponse("desktop", {
      id: "turn", error: { code: -32602, message: "rejected" },
    });
    expect(tracker.snapshot(thread())).toMatchObject({
      model: "Codex Unknown",
      effort: null,
    });
  });

  it("completes omitted fork settings while preserving explicit overrides", () => {
    const tracker = new StockStateTracker();
    tracker.observeRequest("desktop", {
      id: "resume", method: "thread/resume", params: { threadId: "stock-1" },
    });
    tracker.observeResponse("desktop", {
      id: "resume",
      result: {
        thread: thread(),
        model: "gpt-5.6-sol",
        serviceTier: "default",
        reasoningEffort: "medium",
      },
    });

    expect(tracker.completeForkParams({ threadId: "stock-1" })).toEqual({
      threadId: "stock-1",
      model: "gpt-5.6-sol",
      serviceTier: "default",
      config: { model_reasoning_effort: "medium" },
    });
    expect(tracker.completeForkParams({
      threadId: "stock-1",
      model: "gpt-5.6-terra",
      serviceTier: "priority",
      config: { model_reasoning_effort: "high", web_search: true },
    })).toEqual({
      threadId: "stock-1",
      model: "gpt-5.6-terra",
      serviceTier: "priority",
      config: { model_reasoning_effort: "high", web_search: true },
    });
    expect(tracker.completeForkParams({
      threadId: "stock-1",
      model: null,
      serviceTier: null,
      config: { model_reasoning_effort: null },
    })).toEqual({
      threadId: "stock-1",
      model: null,
      serviceTier: null,
      config: { model_reasoning_effort: null },
    });
  });

  it("builds an immediate empty side snapshot from the observed resume", () => {
    const tracker = new StockStateTracker();
    tracker.observeRequest("desktop", {
      id: "resume", method: "thread/resume", params: { threadId: "stock-1" },
    });
    tracker.observeResponse("desktop", {
      id: "resume",
      result: {
        thread: thread(),
        model: "gpt-5.6-terra",
        modelProvider: "openai",
        serviceTier: "default",
        cwd: "/tmp",
        runtimeWorkspaceRoots: ["/tmp"],
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly" },
        activePermissionProfile: null,
        reasoningEffort: "medium",
        multiAgentMode: "explicitRequestOnly",
        initialTurnsPage: null,
      },
    });

    expect(tracker.sideSnapshot({
      threadId: "stock-1",
      ephemeral: true,
      excludeTurns: true,
      threadSource: "user",
    }, "public-side")).toMatchObject({
      thread: {
        id: "public-side",
        forkedFromId: "stock-1",
        ephemeral: true,
        path: null,
        turns: [],
      },
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
  });
});
