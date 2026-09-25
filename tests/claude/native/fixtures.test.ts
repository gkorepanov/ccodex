import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectTranscript } from "../../../src/claude/native/projector.js";
import { projectSubagents } from "../../../src/claude/native/subagents.js";

const projectDirectory = fileURLToPath(new URL("../../fixtures/nativeClaudeHome/projects/-home-user-project/", import.meta.url));

async function fixture(sessionId: string) {
  return projectTranscript({ sessionId, path: `${projectDirectory}${sessionId}.jsonl` });
}

describe("native Claude fixtures", () => {
  it("projects the fork fixture with stable turn and item structure", async () => {
    const sessionId = "888c9222-8727-4bad-b970-13fdd721db04";
    const first = await fixture(sessionId);
    const second = await fixture(sessionId);

    expect(first.turns).toHaveLength(4);
    expect(first.turns.map((turn) => turn.items.map((item) => item.id)))
      .toEqual(second.turns.map((turn) => turn.items.map((item) => item.id)));
    expect(first.turns[0]!.items.map((item) => item.type)).toEqual([
      "userMessage", "reasoning", "commandExecution", "reasoning", "agentMessage",
      "collabAgentToolCall", "reasoning", "agentMessage",
    ]);
  });

  it("keeps the compaction marker and the complete pre-compaction turn history", async () => {
    const projection = await fixture("a0cd4fcb-7bd4-43fa-b0d3-7d46e39e912a");

    // One turn Claude went on in after a finished task woke it up.
    expect(projection.turns).toHaveLength(8);
    expect(projection.compactionBoundaries.size).toBe(1);
    expect(projection.turns.at(-1)!.items.map((item) => item.type)).toEqual([
      "userMessage", "reasoning", "agentMessage", "commandExecution", "reasoning",
      "commandExecution", "commandExecution", "reasoning", "commandExecution", "reasoning",
      "commandExecution", "reasoning", "commandExecution", "reasoning", "commandExecution",
      "reasoning", "commandExecution", "reasoning", "commandExecution", "reasoning",
      "commandExecution", "reasoning", "commandExecution", "contextCompaction",
    ]);
  });

  it("projects the root and retained sub-agent threads", async () => {
    const sessionId = "d7dbe40e-3c05-40e6-b17f-40e4ff574798";
    const root = await fixture(sessionId);
    const children = await projectSubagents(`${projectDirectory}${sessionId}`, sessionId);

    // Three turns Claude went on in: after a finished task woke it up, or after a message of an answer's length.
    expect(root.turns).toHaveLength(21);
    expect(root.turns[1]!.items.map((item) => item.type)).toEqual([
      "userMessage", "reasoning", "commandExecution", "reasoning", "agentMessage",
    ]);
    expect(children.map((child) => ({
      id: child.projection.thread.id,
      parent: child.projection.thread.parentThreadId,
      turns: child.projection.turns.length,
      agentPath: typeof child.projection.thread.source === "object" && "subAgent" in child.projection.thread.source
        && typeof child.projection.thread.source.subAgent === "object"
        && "thread_spawn" in child.projection.thread.source.subAgent
        ? child.projection.thread.source.subAgent.thread_spawn.agent_path
        : "not-subagent",
    }))).toEqual([
      { id: "agent-a983e9a50320b4bb8", parent: sessionId, turns: 1, agentPath: null },
      { id: "agent-aba9cfd32e2f49189", parent: sessionId, turns: 1, agentPath: null },
    ]);
  });
});
