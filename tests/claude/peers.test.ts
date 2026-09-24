import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectTranscript } from "../../src/claude/native/projector.js";
import type { AssistantRecord, TranscriptRecord, UserRecord } from "../../src/claude/native/records.js";
import { TranscriptSummarizer } from "../../src/claude/native/summary.js";
import { peerMessageItem, sentMessageItem, type PeerDirectory, type Peers } from "../../src/claude/peers.js";
import type { ThreadItem } from "../../src/protocol/codex.js";

const SENDER = "5bc12a00-0000-4000-8000-000000000001";
const envelope = (uuid: string, parentUuid: string | null, second: number, promptId?: string) => ({
  uuid, parentUuid, timestamp: `2026-09-25T01:00:${String(second).padStart(2, "0")}.000Z`, sessionId: "receiver",
  cwd: "/workspace", ...(promptId ? { promptId } : {}),
});
const human = (uuid: string, parent: string | null, text: string, second: number, promptId?: string): UserRecord =>
  ({ type: "user", ...envelope(uuid, parent, second, promptId), origin: { kind: "human" }, message: { role: "user", content: text } });
const reply = (uuid: string, parent: string, text: string, second: number, content?: AssistantRecord["message"]["content"]): AssistantRecord => ({
  type: "assistant", ...envelope(uuid, parent, second),
  message: { id: `message-${uuid}`, role: "assistant", model: "claude-haiku-4-5", content: content ?? [{ type: "text", text }], stop_reason: content ? "tool_use" : "end_turn" },
});
const crossSession = (body: string) => `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/553289.sock" from-name="work-7f" from-mode="bypass">\n${body}\n</cross-session-message>\n\nThis came from another Claude session — not typed by your user.`;
const peer = (uuid: string, parent: string, second: number, origin: Record<string, unknown>, promptId?: string, body = "What is your code word?"): UserRecord => ({
  type: "user", ...envelope(uuid, parent, second, promptId), isMeta: true, origin: { kind: "peer", ...origin },
  message: { role: "user", content: crossSession(body) },
});
const ORIGIN = {
  from: "uds:/tmp/cc-socks/553289.sock", verifiedPeerPid: 553289, verifiedPeerProcStart: "1593235708",
  msg_id: "msg-1", name: "work-7f", fromMode: "bypass", body: "What is your code word?",
};
const delegation = (source: string, input: string) =>
  `<codex_delegation>   <source_thread_id>${source}</source_thread_id>   <input>${input}</input> </codex_delegation>`;
const directory = (known: Partial<Record<"senders" | "receivers", Record<string, string>>> = {}, threads = [SENDER]): PeerDirectory => ({
  sender: (id) => known.senders?.[id], receiver: (id) => known.receivers?.[id], has: (id) => threads.includes(id),
});
const emptyHome = () => mkdtempSync(join(tmpdir(), "ccodex-peers-"));
function registry(sessions: Array<Record<string, unknown> | string>): string {
  const home = emptyHome();
  mkdirSync(join(home, "sessions"));
  sessions.forEach((session, index) => writeFileSync(join(home, "sessions", `${index + 1}.json`), typeof session === "string" ? session : JSON.stringify(session)));
  return home;
}
const peers = (home: string, known?: Parameters<typeof directory>[0], children = new Set<string>()): Peers => ({ directory: directory(known), children, home });
const text = (item: ThreadItem) => item.type === "userMessage" && item.content[0]?.type === "text" ? item.content[0].text : undefined;

describe("messages between Claude agents", () => {
  it("shows a message another session sent as its own turn, sent by that session's chat", async () => {
    const records: TranscriptRecord[] = [
      human("prompt", null, "Remember MANGO", 1, "p1"), reply("ready", "prompt", "B READY", 2),
      peer("peer", "ready", 3, ORIGIN, "p2"), reply("answer", "peer", "MANGO", 4),
    ];
    const projection = await projectTranscript({ sessionId: "receiver", path: "/tmp/r.jsonl", records, peers: directory({ senders: { "msg-1": SENDER } }) });
    expect(projection.turns.map((turn) => turn.id)).toEqual(["prompt", "peer"]);
    expect(projection.turns[1]!.items.map((item) => item.type)).toEqual(["userMessage", "agentMessage"]);
    expect(text(projection.turns[1]!.items[0]!)).toBe(delegation(SENDER, "What is your code word?"));
    expect(projection.thread.preview).toBe("Remember MANGO");
  });

  it("says the sender's chat is unknown when nothing tells it, and reads the message out of Claude's envelope", async () => {
    const records: TranscriptRecord[] = [
      human("prompt", null, "Hi", 1, "p1"), reply("hello", "prompt", "Hello", 2),
      // No promptId, body, pid or name: whatever a later Claude writes, the message still shows as a turn.
      peer("peer", "hello", 3, {}, undefined, "a <b> & c"), reply("answer", "peer", "Ok", 4),
    ];
    const projection = await projectTranscript({ sessionId: "receiver", path: "/tmp/r.jsonl", records });
    expect(projection.turns.map((turn) => turn.id)).toEqual(["prompt", "peer"]);
    expect(text(projection.turns[1]!.items[0]!)).toBe("Message from another Claude agent (CCodex does not know its chat):\n\na <b> & c");
  });

  it("keeps a message that arrived while Claude was working in the running turn (Claude's queued command)", async () => {
    const queued: TranscriptRecord = {
      type: "attachment", ...envelope("queued", "result", 4),
      attachment: { type: "queued_command", prompt: crossSession("PING-MID").split("\n").slice(1, 4).join("\n"), source_uuid: "command", commandMode: "prompt", origin: { kind: "peer", ...ORIGIN, body: "PING-MID" }, isMeta: true },
    };
    const records: TranscriptRecord[] = [
      human("prompt", null, "Work", 1, "p1"), reply("tool", "prompt", "", 2, [{ type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "true" } }]),
      { type: "user", ...envelope("result", "tool", 3, "p1"), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "" }] } },
      queued, reply("done", "queued", "Done", 5),
    ];
    const projection = await projectTranscript({ sessionId: "receiver", path: "/tmp/r.jsonl", records, peers: directory({ senders: { "msg-1": SENDER } }) });
    expect(projection.turns.map((turn) => turn.items.map((item) => item.type))).toEqual([["userMessage", "commandExecution", "userMessage", "agentMessage"]]);
    expect(projection.turns[0]!.items[2]).toMatchObject({ id: "command" });
    expect(text(projection.turns[0]!.items[2]!)).toBe(delegation(SENDER, "PING-MID"));
  });

  it("gives a message that waited in Claude's queue a turn of its own, and no queued task notification is a user message", async () => {
    const queue = (operation: string, content?: string): TranscriptRecord => ({ type: "queue-operation", operation, sessionId: "receiver", ...(content ? { content } : {}) });
    const envelopeOnly = crossSession("REPORT-OK").split("\n").slice(1, 4).join("\n");
    const notification = "<task-notification>\n<task-id>a0eb</task-id>\n</task-notification>";
    const records: TranscriptRecord[] = [
      queue("enqueue", "Start bob"), queue("dequeue"), human("prompt", null, "Start bob", 1, "p1"),
      queue("enqueue", envelopeOnly), reply("launched", "prompt", "Launched", 2), queue("dequeue"),
      peer("peer", "launched", 3, { senderTaskId: "a0eb", body: "REPORT-OK" }, "p2", "REPORT-OK"),
      queue("enqueue", notification), reply("ack", "peer", "Acknowledged", 4), queue("dequeue"),
      { type: "user", ...envelope("note", "ack", 5, "p3"), origin: { kind: "task-notification" }, message: { role: "user", content: notification } },
      reply("noted", "note", "Noted", 6),
    ];
    const projection = await projectTranscript({ sessionId: "receiver", path: "/tmp/r.jsonl", records });
    expect(projection.turns.map((turn) => [turn.id, turn.items.map((item) => item.type)])).toEqual([
      ["prompt", ["userMessage", "agentMessage"]],
      ["peer", ["userMessage", "agentMessage", "agentMessage"]],
    ]);
  });

  it("finds the sender among running sessions, trusting a pid only with its process start", () => {
    const home = registry([
      "{ not json", "null",
      { pid: 553289, procStart: "1593235708", sessionId: SENDER, name: "work-7f" },
    ]);
    expect(text(peerMessageItem("id", { kind: "peer", ...ORIGIN, msg_id: undefined }, "", peers(home)))).toBe(delegation(SENDER, "What is your code word?"));
    const reused = { kind: "peer", ...ORIGIN, msg_id: undefined, verifiedPeerProcStart: "1" };
    expect(text(peerMessageItem("id", reused, "", peers(home)))).toMatch(/^Message from Claude agent work-7f/u);
    expect(text(peerMessageItem("id", { kind: "peer", name: "work-7f", body: "x" }, "", peers(home)))).toBe(delegation(SENDER, "x"));
    // A session that is no listed thread is not linked.
    expect(text(peerMessageItem("id", { kind: "peer", ...ORIGIN }, "", { ...peers(home), directory: directory({}, []) })))
      .toMatch(/^Message from Claude agent work-7f/u);
    expect(text(peerMessageItem("id", { kind: "peer", ...ORIGIN }, "", peers(join(home, "missing"))))).toMatch(/does not know its chat/u);
  });

  it("links a message from a sub-agent of the session to that sub-agent, escaping it as Desktop does", () => {
    const item = peerMessageItem("id", { kind: "peer", senderTaskId: "a0eb", body: "<b>&" }, "", peers(emptyHome(), {}, new Set(["a0eb"])));
    expect(text(item)).toBe(delegation("agent-a0eb", "&lt;b&gt;&amp;"));
  });

  it("shows a SendMessage as stock shows a message to a sub-agent (Messaged <agent>) or to another chat", () => {
    const call: ThreadItem = {
      type: "collabAgentToolCall", id: "toolu-send", tool: "sendInput", status: "completed", senderThreadId: "receiver",
      receiverThreadIds: [], prompt: "Hi", model: null, reasoningEffort: null, agentsStates: {},
    };
    const home = registry([{ pid: 1, sessionId: SENDER, name: "work-8c", messagingSocketPath: "/tmp/cc-socks/1.sock" }]);
    expect(sentMessageItem(call, { to: "a0eb" }, { success: true, pin: { id: "a0eb" } }, peers(home, {}, new Set(["a0eb"]))))
      .toEqual({ ...call, receiverThreadIds: ["agent-a0eb"] });
    const chat = {
      type: "dynamicToolCall", id: "toolu-send", namespace: "codex_app", tool: "send_message_to_thread",
      arguments: { threadId: SENDER, message: "Hi" }, status: "completed", contentItems: null, success: true, durationMs: null,
    };
    expect(sentMessageItem(call, { to: "gone" }, { msg_id: "m" }, peers(emptyHome(), { receivers: { m: SENDER } }))).toEqual(chat);
    expect(sentMessageItem(call, { to: "work-8c [5bc12a]" }, undefined, peers(home))).toEqual(chat);
    // A reply goes to the address the message came from.
    expect(sentMessageItem(call, { to: "uds:/tmp/cc-socks/1.sock" }, undefined, peers(home))).toEqual(chat);
    expect(sentMessageItem(call, { to: "work-99" }, { msg_id: "other" }, peers(home))).toBe(call);
    expect(sentMessageItem(call, {}, undefined, peers(home))).toBe(call);
  });

  it("shows a SendMessage to a sub-agent the session started, from history", async () => {
    const records: TranscriptRecord[] = [
      human("prompt", null, "Start bob, then message him", 1, "p1"),
      reply("spawn", "prompt", "", 2, [{ type: "tool_use", id: "toolu-agent", name: "Agent", input: { description: "Sleep and report", prompt: "sleep" } }]),
      { type: "user", ...envelope("spawned", "spawn", 3, "p1"), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-agent", content: "launched" }] },
        toolUseResult: { status: "async_launched", agentId: "a0eb", description: "Sleep and report" } },
      reply("send", "spawned", "", 4, [{ type: "tool_use", id: "toolu-send", name: "SendMessage", input: { to: "a0eb", message: "KIWI" } }]),
      { type: "user", ...envelope("sent", "send", 5, "p1"), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-send", content: "queued" }] },
        toolUseResult: { success: true, pin: { id: "a0eb" } } },
    ];
    const projection = await projectTranscript({ sessionId: "receiver", path: "/tmp/r.jsonl", records });
    expect(projection.turns[0]!.items.find((item) => item.id === "toolu-send")).toMatchObject({
      type: "collabAgentToolCall", tool: "sendInput", status: "completed", prompt: "KIWI", receiverThreadIds: ["agent-a0eb"],
    });
  });

  it("remembers the messages a session sent and got", () => {
    const summarizer = new TranscriptSummarizer();
    summarizer.accept(human("prompt", null, "Hi", 1, "p1"));
    summarizer.accept({ type: "user", ...envelope("sent", "prompt", 2, "p1"), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "" }] }, toolUseResult: { success: true, msg_id: "out" } });
    summarizer.accept(peer("peer", "sent", 3, ORIGIN, "p2"));
    expect(summarizer.snapshot()).toMatchObject({ sentMessages: ["out"], receivedMessages: ["msg-1"] });
  });
});
