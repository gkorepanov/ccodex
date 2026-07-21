import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeRuntime, type ClaudeRuntimeFact } from "../../../src/claude/session/runtime.js";
import { FakeClaudeQuery } from "../../fixtures/fakeClaudeQuery.js";

const message = {
  type: "user",
  session_id: "session",
  parent_tool_use_id: null,
  uuid: "message",
  message: { role: "user", content: [{ type: "text", text: "hello" }] },
} as unknown as SDKUserMessage;

describe("ClaudeRuntime", () => {
  it("owns only SDK transport and submits generation-fenced provider facts", async () => {
    const query = new FakeClaudeQuery();
    const facts: ClaudeRuntimeFact[] = [];
    const runtime = new ClaudeRuntime(
      7,
      { cwd: "/workspace", model: "haiku" },
      query.factory,
      async (fact) => { facts.push(fact); },
    );

    runtime.start();
    await runtime.initializationResult();
    runtime.send(message);
    await vi.waitFor(() => expect(query.prompts).toHaveLength(1));
    await vi.waitFor(() => expect(facts.some((fact) =>
      fact.kind === "terminal" && fact.message.type === "result")).toBe(true));

    expect(facts.filter((fact) => fact.kind !== "exit")
      .every((fact) => fact.runtimeGeneration === 7)).toBe(true);
    expect(runtime.pendingInputCount).toBe(0);
    await runtime.close();
    expect(facts.at(-1)).toMatchObject({ kind: "exit", runtimeGeneration: 7 });
  });

  it("serializes provider delivery through the fact sink", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const delivered: SDKMessage[] = [];
    const query = new FakeClaudeQuery();
    const runtime = new ClaudeRuntime(
      1,
      { cwd: "/workspace", model: "haiku" },
      query.factory,
      async (fact) => {
        if (fact.kind === "exit" || fact.kind === "inputPending") return;
        delivered.push(fact.message);
        if (first) {
          first = false;
          await blocked;
        }
      },
    );

    runtime.start();
    await runtime.initializationResult();
    runtime.send(message);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0]?.type).toBe("system");
    release();
    await vi.waitFor(() => expect(delivered.some((value) => value.type === "result")).toBe(true));
    await runtime.close();
  });
});
