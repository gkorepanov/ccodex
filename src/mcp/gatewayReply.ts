import { createConnection } from "node:net";
import WebSocket from "ws";

type Message = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MARK = /\s*✳️\s*$/u;

/** A failure to reach the gateway or its thread, after which the caller may fall back to `codex exec`. */
export class GatewayUnavailable extends Error {}

/**
 * Sends a prompt to a chat through CCodex's own socket, as the Codex app does: a chat the app has open (it has an
 * active writer, which `codex exec resume` cannot take), a busy chat (the prompt joins its running turn) and a chat
 * now on a Claude model (the gateway routes it to the Claude session) all get it. `chat` is a thread id or a title.
 */
export async function replyViaGateway(socketPath: string, chat: string, prompt: string): Promise<{ threadId: string; content: string }> {
  const socket = new WebSocket("ws://ccodex/rpc", { createConnection: () => createConnection(socketPath), perMessageDeflate: false });
  try {
    await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  } catch (error) {
    throw new GatewayUnavailable(error instanceof Error ? error.message : String(error));
  }
  const messages: Message[] = [];
  const waiting = new Map<number, { resolve: (value: Message) => void; reject: (error: Error) => void }>();
  let closed = false;
  const fail = (error: Error) => { closed = true; for (const entry of waiting.values()) entry.reject(error); waiting.clear(); };
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Message;
    if (message.method !== undefined && message.id !== undefined) {
      // The gateway asks the app's client for approvals; this client is no user, so it declines.
      socket.send(JSON.stringify({ id: message.id, result: { decision: "decline", action: "decline" } }));
      return;
    }
    if (message.method !== undefined) { messages.push(message); return; }
    const entry = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) entry?.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else entry?.resolve(message.result);
  });
  socket.once("close", () => fail(new Error("CCodex gateway closed the connection.")));
  let next = 0;
  const request = (method: string, params: object): Promise<Message> => new Promise((resolve, reject) => {
    if (closed) return reject(new Error("CCodex gateway closed the connection."));
    const id = ++next;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await request("initialize", { clientInfo: { name: "ccodex_mcp", title: "CCodex MCP", version: "1" }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: "initialized" }));
    let threadId = chat.trim();
    if (!UUID.test(threadId)) {
      const wanted = threadId.replace(MARK, "").toLowerCase();
      const found = ((await request("thread/list", { searchTerm: threadId.replace(MARK, ""), limit: 50 })).data ?? [])
        .filter((thread: Message) => String(thread.name ?? "").replace(MARK, "").toLowerCase() === wanted);
      if (found.length !== 1) {
        throw new GatewayUnavailable(found.length ? `Several chats are titled "${chat}": ${found.map((thread: Message) => thread.id).join(", ")}. Use a thread id.` : `No chat is titled "${chat}".`);
      }
      threadId = found[0].id;
    }
    try {
      await request("thread/resume", { threadId, excludeTurns: true });
    } catch (error) {
      throw new GatewayUnavailable(error instanceof Error ? error.message : String(error));
    }
    const turnId = (await request("turn/start", { threadId, input: [{ type: "text", text: prompt }] })).turn?.id;
    const done = async () => {
      for (;;) {
        const end = messages.find((m) => m.method === "turn/completed" && m.params?.threadId === threadId && (!turnId || m.params?.turn?.id === turnId));
        if (end) return end;
        if (closed) throw new Error("CCodex gateway closed the connection.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const end = await done();
    const said = messages.filter((m) => m.method === "item/completed" && m.params?.threadId === threadId && m.params?.item?.type === "agentMessage");
    const final = said.filter((m) => m.params.item.phase === "final_answer").at(-1) ?? said.at(-1);
    const failure = end.params?.turn?.status === "failed" ? end.params?.turn?.error?.message : undefined;
    if (failure && !final) throw new Error(String(failure));
    return { threadId, content: final?.params.item.text ?? "" };
  } finally {
    socket.removeAllListeners();
    socket.terminate();
  }
}
