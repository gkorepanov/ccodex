/**
 * Claude's messages between agents (`SendMessage`; a user record whose `origin.kind` is "peer") shown as stock shows
 * messages between threads. Best effort throughout: when Claude does not tell where a message came from or went (or
 * tells it differently in a later version), the message shows without its thread; it never breaks the chat.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeHome } from "../config.js";
import type { ThreadItem } from "../protocol/codex.js";

/** Which sessions sent and got cross-session messages (`msg_id`), as their transcripts tell. */
export interface PeerDirectory {
  sender(msgId: string): string | undefined;
  receiver(msgId: string): string | undefined;
  /** A listed thread: a link to anything else would not open. */
  has(sessionId: string): boolean;
}

export interface Peers {
  readonly directory: PeerDirectory;
  /** Agent ids of the session's sub-agents. */
  readonly children: ReadonlySet<string>;
  readonly home?: string;
}

export const NO_PEERS: Peers = {
  directory: { sender: () => undefined, receiver: () => undefined, has: () => false },
  children: new Set(),
};

type Fields = Readonly<Record<string, unknown>>;

function fields(value: unknown): Fields | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : typeof value === "number" ? String(value) : undefined;
}

export function peerOrigin(origin: unknown): Fields | undefined {
  const peer = fields(origin);
  return peer?.kind === "peer" ? peer : undefined;
}

/** Claude's registry of running sessions (`~/.claude/sessions/<pid>.json`); an entry goes when its process exits. */
function runningSession(home: string, match: (session: Fields) => boolean): string | undefined {
  try {
    const directory = join(home, "sessions");
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const session = fields(JSON.parse(readFileSync(join(directory, name), "utf8")));
        if (session && match(session)) return text(session.sessionId);
      } catch {}
    }
  } catch {}
  return undefined;
}

function thread(peers: Peers, sessionId: string | undefined): string | undefined {
  return sessionId && peers.directory.has(sessionId) ? sessionId : undefined;
}

/** The thread a peer message came from: a sub-agent of this session, or the session that sent it. */
export function peerSource(origin: Fields, peers: Peers): string | undefined {
  const task = text(origin.senderTaskId);
  if (task && peers.children.has(task)) return `agent-${task}`;
  const msgId = text(origin.msg_id);
  const pid = text(origin.verifiedPeerPid);
  const procStart = text(origin.verifiedPeerProcStart);
  const name = text(origin.name);
  return thread(peers, msgId && peers.directory.sender(msgId))
    ?? thread(peers, runningSession(peers.home ?? claudeHome(), (session) => pid !== undefined
      ? text(session.pid) === pid && (!procStart || !session.procStart || text(session.procStart) === procStart)
      : name !== undefined && session.name === name));
}

/** What the peer wrote: Claude's `origin.body`, else its record without Claude's envelope. */
function peerBody(origin: Fields, recordText: string): string {
  const body = text(origin.body);
  if (body) return body;
  const inner = /<(cross-session-message|agent-message)\b[^>]*>([\s\S]*?)<\/\1>/u.exec(recordText)?.[2];
  return (inner ?? recordText).trim();
}

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * A message another agent sent, as Desktop shows one another thread sent ("Sent by Codex from another task", linking
 * to it): its `<codex_delegation>` user message. Without a known thread, a plain message saying so.
 */
export function peerMessageItem(id: string, origin: Fields, recordText: string, peers: Peers): ThreadItem {
  const body = peerBody(origin, recordText);
  const source = peerSource(origin, peers);
  const name = text(origin.name);
  const message = source
    ? ["<codex_delegation>", `  <source_thread_id>${escape(source)}</source_thread_id>`, `  <input>${escape(body)}</input>`, "</codex_delegation>"].join(" ")
    : `Message from ${name ? `Claude agent ${name}` : "another Claude agent"} (CCodex does not know its chat):\n\n${body}`;
  return { type: "userMessage", id, clientId: null, content: [{ type: "text", text: message, text_elements: [] }] };
}

/**
 * A `SendMessage` as stock shows a message to another thread: "Messaged <agent>" to a sub-agent of this session (a
 * `sendInput` to its thread), "Sent message to chat" (linking to it) to another session's chat. Otherwise it stays a
 * `sendInput` to no known thread.
 */
export function sentMessageItem(item: ThreadItem, input: Fields, result: Fields | undefined, peers: Peers): ThreadItem {
  if (item.type !== "collabAgentToolCall" || item.tool !== "sendInput") return item;
  const to = text(input.to) ?? text(input.recipient);
  const agent = [to, text(fields(result?.pin)?.id)].find((id) => id !== undefined && peers.children.has(id));
  if (agent) return { ...item, receiverThreadIds: [`agent-${agent}`] };
  const msgId = text(result?.msg_id);
  // `to` names a session as ListAgents lists it: "work-8c", or "work-8c [5bc12a]".
  const name = to?.replace(/\s*\[[^\]]*\]$/u, "");
  const target = thread(peers, msgId && peers.directory.receiver(msgId))
    ?? thread(peers, name && runningSession(peers.home ?? claudeHome(), (session) => session.name === name || session.sessionId === name));
  if (!target) return item;
  return {
    type: "dynamicToolCall", id: item.id, namespace: "codex_app", tool: "send_message_to_thread",
    arguments: { threadId: target, message: item.prompt ?? "" }, status: item.status,
    contentItems: null, success: item.status === "inProgress" ? null : item.status === "completed", durationMs: null,
  };
}
