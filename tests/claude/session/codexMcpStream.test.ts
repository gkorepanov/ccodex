import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread } from "../../../src/codex/generated/v2/Thread.js";
import type { ClaudeThreadRecord } from "../../../src/store/HybridStore.js";
import { MemoryHybridStore } from "../../../src/store/memoryStore.js";
import { SubscriptionHub } from "../../../src/gateway/subscriptions.js";
import type { ClaudeSessionCommand } from "../../../src/claude/session/commands.js";
import { ClaudeOutputAdapter } from "../../../src/claude/session/outputAdapter.js";
import { ClaudeSessionRepository } from "../../../src/claude/session/repository.js";
import { ClaudeSession } from "../../../src/claude/session/session.js";
import { ClaudeSessionRegistry } from "../../../src/claude/sessionRegistry.js";
import { MetricsRegistry } from "../../../src/observability/metrics.js";
import type { CodexRolloutLocator } from "../../../src/claude/session/codexRollout.js";

function record(threadId: string): ClaudeThreadRecord {
  const thread: Thread = {
    id: threadId, extra: null, sessionId: `session-${threadId}`, forkedFromId: null, parentThreadId: null,
    canAcceptDirectInput: true, preview: "", ephemeral: false, isPinned: false, historyMode: "legacy",
    modelProvider: "claude", createdAt: 1, updatedAt: 1, recencyAt: 1, status: { type: "idle" },
    path: null, cwd: "/workspace", cliVersion: "claude-code", source: "appServer", threadSource: null,
    agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [],
  };
  return {
    thread,
    claudeSessionId: `claude-${threadId}`,
    modelPickerId: "claude:sonnet",
    claudeModelValue: "sonnet",
    serviceTier: null,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    baseInstructions: null,
    developerInstructions: null,
    personality: null,
    resolvedModel: null,
    lastClaudeMessageUuid: null,
    lastCompletedTurnId: null,
    claudeCodeVersion: null,
    reasoningEffort: null,
    reasoningSummary: null,
    collaborationMode: null,
    outputSchema: null,
    tokenUsageTotal: {
      totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
    },
    tokenUsageLast: null,
    modelContextWindow: null,
  };
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

describe("codex MCP call streaming", () => {
  it("emits the prompt and streams journal messages into the calling thread", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-codex-mcp-"));
    const journal = join(directory, "rollout-2026-08-19T12-00-00-thread-a.jsonl");
    writeFileSync(
      journal,
      line({ type: "session_meta", payload: { session_id: "thread-a", id: "thread-a", source: "mcp" } })
        + line({ type: "event_msg", payload: { type: "user_message", message: "build it" } })
        + line({ type: "event_msg", payload: { type: "agent_reasoning", text: "thinking hard" } })
        + line({ type: "event_msg", payload: { type: "agent_message", message: "done, see diff", phase: "final_answer" } })
        + line({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "done, see diff" } }),
    );
    const locator: CodexRolloutLocator = {
      byThreadId: () => undefined,
      freshMcpSession: () => journal,
    };
    const store = new MemoryHybridStore();
    const repository = new ClaudeSessionRepository(store);
    const output = new ClaudeOutputAdapter(new SubscriptionHub());
    const registry = new ClaudeSessionRegistry<ClaudeSessionCommand, ClaudeSession>(
      (threadId) => new ClaudeSession(
        threadId, repository, output, undefined, new MetricsRegistry(),
        undefined, undefined, undefined, undefined, undefined, undefined, locator,
      ),
    );
    await registry.submit("thread-1", { type: "createThread", record: record("thread-1") });
    await registry.submit("thread-1", { type: "attachRuntime", runtimeGeneration: 1 });
    await registry.submit("thread-1", {
      type: "prepareTurn",
      params: { threadId: "thread-1", input: [{ type: "text", text: "ask codex", text_elements: [] }] },
    });
    const source = { providerEventId: "assistant", providerEventType: "assistant" };
    await registry.submit("thread-1", {
      type: "mainStream", runtimeGeneration: 1, source,
      fact: {
        kind: "toolStart", index: 0,
        block: { type: "tool_use", id: "codex-1", name: "mcp__codex__codex", input: { prompt: "build it" } },
      },
    });
    await expect(registry.submit("thread-1", {
      type: "codexMcpCallBegin", runtimeGeneration: 1,
      providerId: "codex-1", input: { prompt: "build it" },
    })).resolves.toBe(true);

    const items = () => store.getThreadRecord("thread-1", true)?.thread.turns.at(-1)?.items ?? [];
    await vi.waitFor(() => {
      expect(items().some((item) => item.type === "agentMessage" && item.text.includes("done, see diff"))).toBe(true);
    });

    const texts = items().flatMap((item) => item.type === "agentMessage" ? [item.text] : []);
    expect(texts).toContain("◆ CCodex │ Codex MCP prompt\n\nbuild it");
    expect(texts).toContain("◆ CCodex │ Codex MCP message\n\ndone, see diff");
    const reasoning = items().find((item) => item.type === "reasoning");
    expect(reasoning?.type === "reasoning" && reasoning.summary[0]).toBe(
      "◆ CCodex │ Codex MCP reasoning\n\nthinking hard",
    );
    const promptIndex = items().findIndex((item) => item.type === "agentMessage" && item.text.startsWith("◆ CCodex │ Codex MCP prompt"));
    const callIndex = items().findIndex((item) => item.type === "mcpToolCall");
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(promptIndex).toBeGreaterThan(callIndex);

    await registry.submit("thread-1", { type: "disposeRuntimeOperations" });
    await registry.close();
  });
});
