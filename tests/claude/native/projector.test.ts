import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { projectTranscript } from "../../../src/claude/native/projector.js";
import type {
  AssistantRecord,
  QueueOperationRecord,
  TitleRecord,
  TranscriptRecord,
  UserRecord,
} from "../../../src/claude/native/records.js";

const timestamp = (second: number) => `2026-09-18T01:00:${String(second).padStart(2, "0")}.000Z`;
const indexedFixtureSessionId = "a0cd4fcb-7bd4-43fa-b0d3-7d46e39e912a";
const indexedFixturePath = fileURLToPath(new URL(
  `../../fixtures/nativeClaudeHome/projects/-home-user-project/${indexedFixtureSessionId}.jsonl`,
  import.meta.url,
));
const envelope = (uuid: string, parentUuid: string | null, second: number) => ({
  uuid, parentUuid, timestamp: timestamp(second), sessionId: "session", isSidechain: false,
  cwd: "/workspace", gitBranch: "main", version: "2.1.261",
});

function prompt(uuid: string, parentUuid: string | null, text: string, second: number): UserRecord {
  return {
    type: "user", ...envelope(uuid, parentUuid, second), origin: { kind: "human" },
    message: { role: "user", content: text },
  };
}

function assistant(
  uuid: string,
  parentUuid: string,
  messageId: string,
  content: AssistantRecord["message"]["content"],
  second: number,
  stopReason: string | null = null,
): AssistantRecord {
  return {
    type: "assistant", ...envelope(uuid, parentUuid, second), effort: "high",
    message: { id: messageId, role: "assistant", model: "claude-sonnet-5", content, stop_reason: stopReason },
  };
}

function conversation(): TranscriptRecord[] {
  const user = prompt("prompt-1", null, "Build it", 1);
  const thinking = assistant("thinking-1", user.uuid, "message-1", [{
    type: "thinking", thinking: "Inspect first", signature: "secret-signature",
  }], 2);
  const text = assistant("text-1", thinking.uuid, "message-1", [{ type: "text", text: "Working" }], 3);
  const tool = assistant("tool-record", text.uuid, "message-1", [{
    type: "tool_use", id: "toolu-bash", name: "Bash", input: { command: "pwd" },
  }], 4, "tool_use");
  const result: UserRecord = {
    type: "user", ...envelope("result-1", tool.uuid, 5),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-bash", content: "/workspace\n" }] },
    toolUseResult: { stdout: "/workspace\n", stderr: "", interrupted: false },
  };
  const final = assistant("final-1", result.uuid, "message-2", [{ type: "text", text: "Done" }], 6, "end_turn");
  const aiTitle: TitleRecord = { type: "ai-title", aiTitle: "Generated title", sessionId: "session" };
  const customTitle: TitleRecord = { type: "custom-title", customTitle: "Chosen title", sessionId: "session" };
  return [user, thinking, text, tool, result, final, aiTitle, customTitle];
}

describe("native Claude transcript projector", () => {
  it("keeps a message sent mid-turn (Desktop's steer) in the running turn, like live; a message sent after it starts a turn", async () => {
    const queued = (operation: "enqueue" | "dequeue", content?: string): QueueOperationRecord =>
      ({ type: "queue-operation", operation, sessionId: "session", ...(content ? { content } : {}) });
    const story = prompt("story", null, "Write a story about a cat.\n", 1);
    const partial = assistant("story-text", story.uuid, "message-1", [{ type: "text", text: "The Night Watch…" }], 2, "end_turn");
    const steer = prompt("steer", partial.uuid, "After that, reply QUEUED-OK\n", 4);
    const answer = assistant("queued-text", steer.uuid, "message-2", [{ type: "text", text: "QUEUED-OK" }], 5, "end_turn");
    const next = prompt("next", answer.uuid, "Thanks\n", 7);
    const reply = assistant("next-text", next.uuid, "message-3", [{ type: "text", text: "You're welcome" }], 8, "end_turn");
    const records: TranscriptRecord[] = [
      queued("enqueue", story.message.content as string), queued("dequeue"), story,
      queued("enqueue", steer.message.content as string), partial, queued("dequeue"), steer, answer,
      queued("enqueue", next.message.content as string), queued("dequeue"), next, reply,
    ];
    const projection = await projectTranscript({ sessionId: "session", path: "/tmp/session.jsonl", records });
    expect(projection.turns.map((turn) => [turn.id, turn.items.map((item) => item.type === "userMessage" ? `user:${item.id}` : item.type)])).toEqual([
      ["story", ["user:story", "agentMessage", "user:steer", "agentMessage"]],
      ["next", ["user:next", "agentMessage"]],
    ]);
    // A fork at the steered turn keeps all of it.
    expect(projection.turnBoundaries[0]).toEqual({ turnId: "story", messageUuid: "queued-text", firstUuid: "story", lastUuid: "queued-text" });
  });

  it("projects deterministic protocol ids and current tool shapes", async () => {
    const records = conversation();
    const first = await projectTranscript({ sessionId: "session", path: "/tmp/session.jsonl", records });
    const second = await projectTranscript({ sessionId: "session", path: "/tmp/session.jsonl", records });
    const turn = first.turns[0]!;

    expect(second).toEqual(first);
    expect(turn.id).toBe("prompt-1");
    expect(turn.status).toBe("completed");
    expect(turn.items.map((item) => [item.type, item.id])).toEqual([
      ["userMessage", "prompt-1"],
      ["reasoning", "thinking-1:0"],
      ["agentMessage", "text-1:0"],
      ["commandExecution", "toolu-bash"],
      ["agentMessage", "final-1:0"],
    ]);
    expect(turn.items[1]).toMatchObject({ type: "reasoning", summary: ["Inspect first"], content: [] });
    expect(JSON.stringify(turn.items)).not.toContain("secret-signature");
    expect(turn.items[3]).toMatchObject({
      type: "commandExecution", command: "pwd", cwd: "/workspace", status: "completed",
      aggregatedOutput: "/workspace\n", exitCode: 0,
    });
    expect(first.thread).toMatchObject({
      id: "session", preview: "Build it", name: "Chosen title", model: "claude:claude-sonnet-5",
      reasoningEffort: "high", modelProvider: "claude", source: "vscode", threadSource: "user",
      parentThreadId: null, createdAt: 1_789_693_201, updatedAt: 1_789_693_206,
    });
  });

  it("keeps existing ids stable when non-chain state is appended", async () => {
    const records = conversation();
    const before = await projectTranscript({ sessionId: "session", path: "/tmp/session.jsonl", records });
    const appended: QueueOperationRecord = {
      type: "queue-operation", operation: "enqueue", content: "later", sessionId: "session", timestamp: timestamp(7),
    };
    const after = await projectTranscript({
      sessionId: "session", path: "/tmp/session.jsonl", records: [...records, appended],
    });
    expect(after.turns.map((turn) => turn.id)).toEqual(before.turns.map((turn) => turn.id));
    expect(after.turns.flatMap((turn) => turn.items.map((item) => item.id)))
      .toEqual(before.turns.flatMap((turn) => turn.items.map((item) => item.id)));
    expect(after.thread.updatedAt).toBe(1_789_693_207);
  });

  it("names the blocks of a legacy record without apiBlockIndex by its uuid and content position", async () => {
    const user = prompt("prompt", null, "Question", 1);
    const multi = assistant("answer", user.uuid, "message", [
      { type: "thinking", thinking: "Reason", signature: "hidden" },
      { type: "text", text: "Answer" },
    ], 2, "end_turn");
    const projection = await projectTranscript({
      sessionId: "session", path: "/tmp/session.jsonl", records: [user, multi],
    });
    expect(projection.turns[0]!.items.map((item) => item.id)).toEqual(["prompt", "answer:0", "answer:1"]);
  });

  it("orders an indexed text, tool, and thinking fixture response by API block index", async () => {
    const projection = await projectTranscript({
      sessionId: indexedFixtureSessionId,
      path: indexedFixturePath,
    });
    const items = projection.turns[0]!.items;
    const start = items.findIndex((item) => item.id === "msg_011CezukZZwYK9qbQqHK4dXw:0");

    expect(items.slice(start, start + 3).map((item) => [item.type, item.id])).toEqual([
      ["reasoning", "msg_011CezukZZwYK9qbQqHK4dXw:0"],
      ["agentMessage", "msg_011CezukZZwYK9qbQqHK4dXw:1"],
      ["commandExecution", "toolu_01VsEQQKaRdxjvWsj5NeXnS6"],
    ]);
  });

  it("groups two thinking fixture blocks into one reasoning item", async () => {
    const projection = await projectTranscript({
      sessionId: indexedFixtureSessionId,
      path: indexedFixturePath,
    });
    const reasoning = projection.turns[0]!.items.find((item) =>
      item.id === "msg_011Cezuoy2vGZPzXLyrRUhqN:0");

    expect(reasoning).toMatchObject({ type: "reasoning", id: "msg_011Cezuoy2vGZPzXLyrRUhqN:0" });
    expect(reasoning?.type === "reasoning" ? reasoning.summary : []).toHaveLength(2);
  });

  it("keeps reasoning from two fixture responses as two items in one turn", async () => {
    const projection = await projectTranscript({
      sessionId: indexedFixtureSessionId,
      path: indexedFixturePath,
    });
    const ids = projection.turns[0]!.items
      .filter((item) => item.type === "reasoning")
      .map((item) => item.id);

    expect(ids).toContain("msg_011CezukZZwYK9qbQqHK4dXw:0");
    expect(ids).toContain("msg_011Cezuoy2vGZPzXLyrRUhqN:0");
  });
  it("completes a local command turn (its output, no model reply)", async () => {
    const user = prompt("prompt-1", null, "/usage", 1);
    const output = {
      type: "system", subtype: "local_command", ...envelope("output-1", user.uuid, 2), level: "info",
      content: "<local-command-stdout>You are currently using your subscription</local-command-stdout>",
    } as unknown as TranscriptRecord;
    const { thread } = await projectTranscript({ sessionId: "session", path: "/tmp/session.jsonl", records: [user, output] });
    expect(thread.turns.map((turn) => turn.status)).toEqual(["completed"]);
    expect(thread.status).toEqual({ type: "idle" });
  });
  it("reports a failed turn's error as Claude's text (Desktop trims it)", async () => {
    const user = prompt("prompt-1", null, "hello", 1);
    const retry = {
      type: "system", subtype: "api_error", ...envelope("retry-1", user.uuid, 2), level: "error",
      error: { message: "401 {\"type\":\"error\"}", status: 401, formatted: "401 OAuth access token has been revoked." },
    } as unknown as TranscriptRecord;
    const reply = {
      ...assistant("reply-1", "retry-1", "message-1", [{ type: "text", text: "Failed to authenticate. API Error: 401" }], 3, "stop_sequence"),
      error: "authentication_failed", isApiErrorMessage: true,
    } as AssistantRecord;
    const failed = async (records: TranscriptRecord[]) =>
      (await projectTranscript({ sessionId: "session", path: "/tmp/session.jsonl", records })).thread.turns[0]!.error;
    expect(await failed([user, retry, reply])).toMatchObject({ message: "Failed to authenticate. API Error: 401" });
    expect(await failed([user, retry])).toMatchObject({ message: "401 OAuth access token has been revoked." });
  });
});
