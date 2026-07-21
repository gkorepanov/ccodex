import { describe, expect, it } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import {
  formatCCodexState,
  isCCodexStateCommand,
  stateModelName,
  type ThreadStateSnapshot,
} from "../../src/state/stateCommand.js";

function thread(): Thread {
  return {
    id: "thread-1", extra: null, sessionId: "session-1", forkedFromId: null, parentThreadId: null,
    preview: "hello", ephemeral: false, historyMode: "paginated", modelProvider: "openai",
    createdAt: 1_700_000_000, updatedAt: 1_700_007_200, recencyAt: 1_700_007_200,
    status: { type: "idle" }, path: null, cwd: "/tmp", cliVersion: "0.144.4",
    source: "appServer", threadSource: "user", agentNickname: null, agentRole: null,
    gitInfo: null, name: "test", turns: [
      {
        id: "turn-1", itemsView: "full", status: "completed", error: null,
        startedAt: 1_700_000_100, completedAt: 1_700_000_160, durationMs: 60_000,
        items: [
          {
            type: "userMessage", id: "user-1", clientId: null,
            content: [{ type: "text", text: "inspect", text_elements: [] }],
          },
          {
            type: "commandExecution", id: "read-1", command: "Read /tmp/a", cwd: "/tmp",
            processId: null, source: "agent", status: "completed",
            commandActions: [{ type: "read", command: "Read /tmp/a", name: "a", path: "/tmp/a" }],
            aggregatedOutput: "a", exitCode: 0, durationMs: 10,
          },
          {
            type: "commandExecution", id: "bash-1", command: "pwd", cwd: "/tmp",
            processId: null, source: "agent", status: "completed",
            commandActions: [{ type: "unknown", command: "pwd" }],
            aggregatedOutput: "/tmp", exitCode: 0, durationMs: 10,
          },
          {
            type: "fileChange", id: "edit-1", changes: [], status: "completed",
          },
          {
            type: "agentMessage", id: "assistant-1", text: "done",
            phase: "final_answer", memoryCitation: null,
          },
        ],
      },
      {
        id: "compact-1", itemsView: "full", status: "completed", error: null,
        startedAt: 1_700_006_300, completedAt: 1_700_006_300, durationMs: 0,
        items: [{ type: "contextCompaction", id: "compact-item" }],
      },
      {
        id: "state-1", itemsView: "full", status: "inProgress", error: null,
        startedAt: 1_700_007_200, completedAt: null, durationMs: null,
        items: [{
          type: "userMessage", id: "state-user", clientId: null,
          content: [{ type: "text", text: "/ccstate", text_elements: [] }],
        }],
      },
    ],
  };
}

describe("CCodex state command", () => {
  it("recognizes only the exact slash command and formats provider ids", () => {
    expect(isCCodexStateCommand([{ type: "text", text: " /CCSTATE ", text_elements: [] }])).toBe(true);
    expect(isCCodexStateCommand([{ type: "text", text: "show /ccstate", text_elements: [] }])).toBe(false);
    expect(stateModelName("codex", "gpt-5.6-sol")).toBe("Codex 5.6 Sol");
    expect(stateModelName("claude", "claude:claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
  });

  it("renders truthful context, cumulative usage, chat, tools, mode, and provider cost", () => {
    const snapshot: ThreadStateSnapshot = {
      provider: "codex",
      model: "Codex 5.6 Sol",
      effort: "xhigh",
      serviceTier: "priority",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandboxPolicy: {
        type: "workspaceWrite", writableRoots: ["/tmp"], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false,
      },
      thread: thread(),
      tokenUsage: {
        total: {
          totalTokens: 412_000, inputTokens: 312_000, cachedInputTokens: 277_680,
          outputTokens: 100_000, reasoningOutputTokens: 20_000,
        },
        last: {
          totalTokens: 68_000, inputTokens: 60_000, cachedInputTokens: 50_000,
          outputTokens: 8_000, reasoningOutputTokens: 1_000,
        },
        modelContextWindow: 200_000,
      },
      providerCostUsd: 1.84,
    };
    expect(formatCCodexState(snapshot, 1_700_007_200_000)).toBe([
      "◆ **CCodex** │ /ccstate",
      "",
      "֎ **Codex 5.6 Sol** · xhigh · ⚡ fast",
      "  ├ context   ▸ ▰▰▰▱▱▱▱▱▱▱ 34% · 68k/200k",
      "  ├ tokens    ▸ 412k processed (312k in / 100k out)",
      "  └ cache     ▸ 89% hit rate",
      "",
      "💬 **Chat**",
      "  ├ messages  ▸ 1 user / 1 assistant / 2 total",
      "  ├ compacts  ▸ 1 (last: 15m ago)",
      "  └ session   ▸ started 2h 0m ago",
      "",
      "⚙️ **Session**",
      "  ├ mode      ▸ ᗢ approve for me",
      "  ├ agent     ▸ 1m 0s cumulative turn time",
      "  ├ tools     ▸ 3 calls (bash 1 · edit 1 · read 1)",
      "  └ cost      ▸ $1.84 provider estimate",
    ].join("\n"));
  });

  it("does not invent stock state that has not been observed", () => {
    const value = formatCCodexState({
      provider: "codex", model: "Codex Unknown", effort: null, serviceTier: null,
      approvalPolicy: null, approvalsReviewer: null, sandboxPolicy: null,
      thread: { ...thread(), turns: [] }, tokenUsage: null, providerCostUsd: null,
    }, 1_700_000_000_000);
    expect(value).toContain("context   ▸ unavailable");
    expect(value).toContain("mode      ▸ unavailable");
    expect(value).toContain("cost      ▸ unavailable for subscription");
  });
});
