import { createConnection } from "node:net";
import WebSocket from "ws";

type Message = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MARK = /\s*✳️\s*$/u;

/** A failure to reach the gateway or its thread, after which the caller may fall back to `codex exec`. */
export class GatewayUnavailable extends Error {}

type Gateway = { request: (method: string, params: object) => Promise<Message>; messages: Message[]; isClosed: () => boolean; close: () => void };

/** Opens CCodex's own socket as an app-like client and initializes it. */
async function connectGateway(socketPath: string): Promise<Gateway> {
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
  const close = () => { socket.removeAllListeners(); socket.terminate(); };
  try {
    await request("initialize", { clientInfo: { name: "ccodex_mcp", title: "CCodex MCP", version: "1" }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: "initialized" }));
  } catch (error) {
    close();
    throw error;
  }
  return { request, messages, isClosed: () => closed, close };
}

/** Starts a turn and waits for it: resolves with the turn's final agent message; a failed turn is an error, whatever it said. */
async function runTurn(gateway: Gateway, threadId: string, prompt: string, model: unknown, signal?: AbortSignal): Promise<string> {
  const { request, messages, isClosed } = gateway;
  const turnId = (await request("turn/start", { threadId, input: [{ type: "text", text: prompt }], ...(typeof model === "string" && model ? { model } : {}) })).turn?.id;
  let end: Message | undefined;
  while (!(end = messages.find((m) => m.method === "turn/completed" && m.params?.threadId === threadId && (!turnId || m.params?.turn?.id === turnId)))) {
    if (signal?.aborted) {
      await request("turn/interrupt", { threadId, ...(turnId ? { turnId } : {}) }).catch(() => undefined);
      throw new Error("Cancelled.");
    }
    if (isClosed()) throw new Error("CCodex gateway closed the connection.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (end.params?.turn?.status === "failed") throw new Error(String(end.params?.turn?.error?.message ?? "The turn failed."));
  const said = messages.filter((m) => m.method === "item/completed" && m.params?.threadId === threadId && m.params?.item?.type === "agentMessage");
  const final = said.filter((m) => m.params.item.phase === "final_answer").at(-1) ?? said.at(-1);
  return final?.params.item.text ?? "";
}

/** The gateway's id for a Claude model given as `claude:haiku`, `haiku` or a full id such as `claude-haiku-5-5`; undefined for anything else. */
export function claudeModelId(model: unknown): string | undefined {
  const name = typeof model === "string" ? model.trim() : "";
  if (/^claude:./u.test(name)) return name;
  if (/^claude-/u.test(name)) return `claude:${name}`;
  return /^(opus|sonnet|haiku|fable)$/iu.test(name) ? `claude:${name.toLowerCase()}` : undefined;
}

export type StartOptions = { prompt: string; model: string; cwd?: string; sandbox?: string; approvalPolicy?: string; name?: string; archive?: boolean; signal?: AbortSignal; onThread?: (threadId: string) => void };

/**
 * Runs a prompt in a new chat on a Claude model, which `codex exec` cannot do: the chat is created through the gateway
 * like one made in the app. Claude chats have no sandbox, only permission modes: `danger-full-access` runs it with all
 * tools allowed and anything else in don't-ask mode, where tools not already allowed (shell, edits) are denied. It is archived afterwards unless `archive` is false, so sub-agent runs do not pile up in
 * the sidebar; the thread id still works with `codex-reply`.
 */
export async function startViaGateway(socketPath: string, options: StartOptions): Promise<{ threadId: string; content: string }> {
  const gateway = await connectGateway(socketPath);
  try {
    const started = await gateway.request("thread/start", {
      model: options.model,
      cwd: options.cwd ?? process.cwd(),
      approvalPolicy: options.approvalPolicy ?? "never",
      sandbox: options.sandbox ?? "read-only",
      ephemeral: false,
    });
    const threadId = String(started.thread?.id ?? "");
    if (!threadId) throw new Error("CCodex gateway did not return a thread id.");
    options.onThread?.(threadId);
    if (options.name) await gateway.request("thread/name/set", { threadId, name: options.name }).catch(() => undefined);
    try {
      return { threadId, content: await runTurn(gateway, threadId, options.prompt, options.model, options.signal) };
    } finally {
      if (options.archive !== false) await gateway.request("thread/archive", { threadId }).catch(() => undefined);
    }
  } finally {
    gateway.close();
  }
}

/** Archives chats (best effort), for sub-agent chats left behind by a server that was killed mid-call. */
export async function archiveViaGateway(socketPath: string, threadIds: string[]): Promise<string[]> {
  const gateway = await connectGateway(socketPath);
  const archived: string[] = [];
  try {
    for (const threadId of threadIds) {
      try { await gateway.request("thread/archive", { threadId }); archived.push(threadId); } catch { /* gone or already archived */ }
    }
  } finally {
    gateway.close();
  }
  return archived;
}

/**
 * Sends a prompt to a chat through CCodex's own socket, as the Codex app does: a chat the app has open (it has an
 * active writer, which `codex exec resume` cannot take), a busy chat (the prompt joins its running turn) and a chat
 * now on a Claude model (the gateway routes it to the Claude session) all get it. `chat` is a thread id or a title.
 */
export async function replyViaGateway(socketPath: string, chat: string, prompt: string): Promise<{ threadId: string; content: string }> {
  const gateway = await connectGateway(socketPath);
  const { request } = gateway;
  try {
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
    let model: unknown;
    try {
      model = (await request("thread/resume", { threadId, excludeTurns: true })).model;
    } catch (error) {
      throw new GatewayUnavailable(error instanceof Error ? error.message : String(error));
    }
    // A `turn/start` without a model would complete a model switch someone left pending on the chat (the app sends the
    // model with each turn); naming the chat's own model keeps it on the provider it is on.
    return { threadId, content: await runTurn(gateway, threadId, prompt, model) };
  } finally {
    gateway.close();
  }
}
