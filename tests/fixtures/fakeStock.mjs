#!/usr/bin/env node
// Minimal scripted `codex app-server --listen unix://…`: in-memory threads, the notifications stock sends, and a
// few test hooks. Enough to exercise CCodex's gateway as a black box.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const listen = process.argv[process.argv.indexOf("--listen") + 1];
const socketPath = listen.slice("unix://".length);
const threads = new Map();
const connections = new Set();
let clock = 1_790_000_000;

const now = () => ++clock;
const summary = (thread) => ({ ...thread, turns: [], injected: undefined });
const full = (thread) => ({ ...thread, injected: undefined });

function newThread(params, extra = {}) {
  const at = now();
  const thread = {
    id: randomUUID(), projectId: null, forkedFromId: null, parentThreadId: null, preview: "", ephemeral: params.ephemeral === true,
    modelProvider: "openai", model: params.model ?? "gpt-6-luna", reasoningEffort: null, createdAt: at, updatedAt: at,
    recencyAt: at, status: { type: "idle" }, path: null, cwd: params.cwd ?? "/work", cliVersion: "0.156.0", source: "vscode",
    threadSource: "user", agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [], archived: false,
    injected: [], ...extra,
  };
  thread.sessionId = thread.id;
  threads.set(thread.id, thread);
  return thread;
}

function settings(thread) {
  return {
    model: thread.model, modelProvider: "openai", serviceTier: null, disabledPluginIds: [], cwd: thread.cwd,
    runtimeWorkspaceRoots: [thread.cwd], instructionSources: [], approvalPolicy: "on-request", approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite" }, activePermissionProfile: null, reasoningEffort: null, multiAgentMode: "explicitRequestOnly",
  };
}

function broadcast(method, params) {
  for (const connection of connections) if (connection.initialized) connection.notify(method, params);
}

function reply(thread, text) {
  if (text.includes("CONTEXT CHECKPOINT COMPACTION")) return `GPT-SUMMARY(${thread.forkedFromId})`;
  if (text.includes("<user_prompt>")) return "🦊 Fox Title";
  return `gpt: ${text}`;
}

function runTurn(connection, thread, params) {
  const text = (params.input ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const turn = { id: randomUUID(), items: [], itemsView: "full", status: "inProgress", error: null, startedAt: now(), completedAt: null, durationMs: null };
  const user = { type: "userMessage", id: randomUUID(), clientId: params.clientUserMessageId ?? null, content: params.input };
  const agent = { type: "agentMessage", id: randomUUID(), text: reply(thread, text), phase: "final_answer", memoryCitation: null };
  thread.turns.push(turn);
  if (!thread.preview) thread.preview = text;
  setImmediate(() => {
    const send = (method, payload) => { for (const c of thread.subscribers) c.notify(method, payload); };
    send("turn/started", { threadId: thread.id, turn: { ...turn, items: [], itemsView: "notLoaded" } });
    for (const item of [user, agent]) {
      send("item/started", { threadId: thread.id, turnId: turn.id, item, startedAtMs: Date.now() });
      send("item/completed", { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() });
      turn.items.push(item);
    }
    Object.assign(turn, { status: "completed", completedAt: now(), durationMs: 1 });
    thread.updatedAt = turn.completedAt;
    send("turn/completed", { threadId: thread.id, turn: { ...turn, items: [], itemsView: "notLoaded" } });
  });
  return { turn: { ...turn, items: [], itemsView: "notLoaded" } };
}

function paginate(list, params) {
  const offset = Number(params.cursor ?? 0);
  const limit = Number(params.limit ?? 50);
  const data = list.slice(offset, offset + limit);
  return { data, nextCursor: offset + limit < list.length ? String(offset + limit) : null, backwardsCursor: null };
}

const config = { model: "gpt-6-luna" };
const handlers = {
  initialize: (connection) => { connection.initialized = true; return { userAgent: "fake-stock/0.156.0", codexHome: "/fake", platformFamily: "unix", platformOs: "linux" }; },
  "thread/start": (connection, params) => {
    const thread = newThread(params);
    thread.subscribers = new Set([connection]);
    broadcast("thread/started", { thread: summary(thread) });
    return { thread: summary(thread), ...settings(thread) };
  },
  "thread/resume": (connection, params) => {
    const thread = threads.get(params.threadId);
    thread.subscribers.add(connection);
    return { thread: params.excludeTurns ? summary(thread) : full(thread), ...settings(thread), initialTurnsPage: null };
  },
  "thread/read": (_connection, params) => ({ thread: params.includeTurns ? full(threads.get(params.threadId)) : summary(threads.get(params.threadId)) }),
  "thread/list": (_connection, params) => {
    const list = [...threads.values()].filter((thread) => !thread.ephemeral && thread.archived === (params.archived ?? false))
      .sort((left, right) => right.createdAt - left.createdAt).map(summary);
    return paginate(list, params);
  },
  "thread/loaded/list": () => ({ data: [...threads.values()].filter((thread) => thread.subscribers.size).map((thread) => thread.id), nextCursor: null }),
  "thread/search": () => ({ data: [], nextCursor: null, backwardsCursor: null }),
  "thread/turns/list": (_connection, params) => {
    const turns = [...threads.get(params.threadId).turns];
    if (params.sortDirection !== "asc") turns.reverse();
    return paginate(turns, params);
  },
  "thread/fork": (connection, params) => {
    const source = threads.get(params.threadId);
    let turns = source.turns;
    if (params.lastTurnId) turns = turns.slice(0, turns.findIndex((turn) => turn.id === params.lastTurnId) + 1);
    if (params.beforeTurnId) turns = turns.slice(0, turns.findIndex((turn) => turn.id === params.beforeTurnId));
    const thread = newThread({ ...source, ephemeral: params.ephemeral }, { forkedFromId: source.id, turns: structuredClone(turns), preview: source.preview });
    thread.subscribers = new Set([connection]);
    if (!thread.ephemeral) broadcast("thread/started", { thread: summary(thread) });
    return { thread: params.excludeTurns ? summary(thread) : full(thread), ...settings(thread) };
  },
  "thread/revert": (connection, params) => {
    const thread = threads.get(params.threadId);
    thread.turns = thread.turns.slice(0, thread.turns.findIndex((turn) => turn.id === params.beforeTurnId));
    for (const c of thread.subscribers) c.notify("thread/reverted", { threadId: thread.id });
    return { thread: summary(thread), turnsBackwardsCursor: null, itemsBackwardsCursor: null };
  },
  "thread/inject_items": (_connection, params) => { threads.get(params.threadId).injected.push(...params.items); return {}; },
  "thread/name/set": (_connection, params) => {
    threads.get(params.threadId).name = params.name;
    broadcast("thread/name/updated", { threadId: params.threadId, threadName: params.name });
    return {};
  },
  "thread/archive": (_connection, params) => { threads.get(params.threadId).archived = true; broadcast("thread/archived", { threadId: params.threadId }); return {}; },
  "thread/unsubscribe": (connection, params) => { threads.get(params.threadId)?.subscribers.delete(connection); return { status: "unsubscribed" }; },
  "turn/start": (connection, params) => {
    const thread = threads.get(params.threadId);
    if (!thread) throw Object.assign(new Error(`thread not found: ${params.threadId}`), { code: -32600 });
    if (!thread.subscribers.has(connection)) throw Object.assign(new Error(`thread not loaded: ${params.threadId}`), { code: -32600 });
    if (params.model) thread.model = params.model;
    return runTurn(connection, thread, params);
  },
  "threadSection/list": () => ({ data: [{ id: "section-pinned", name: "Pinned", appearance: null }], nextCursor: null }),
  "thread/section/move": () => ({}),
  "model/list": () => ({ data: [{ id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6 Luna", isDefault: true }], nextCursor: null }),
  "skills/list": (_connection, params) => ({ data: (params.cwds ?? []).map((cwd) => ({ cwd, skills: [{ name: "stock-skill" }], errors: [] })) }),
  "account/rateLimits/read": () => ({ rateLimits: { limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null }, secondary: null }, rateLimitsByLimitId: null }),
  "config/batchWrite": (_connection, params) => {
    for (const edit of params.edits) config[edit.keyPath] = edit.value;
    return { status: "ok", version: "v", filePath: "/fake/config.toml", overriddenMetadata: null };
  },
  "config/read": () => ({ config: { ...config }, origins: {} }),
  "test/config": () => ({ config: { ...config } }),
  // Test hooks.
  "test/threads": () => ({ threads: [...threads.values()].map((thread) => ({ ...thread, subscribers: thread.subscribers.size })) }),
  "test/approval": async (connection) => ({ decision: await connection.ask("item/commandExecution/requestApproval", { threadId: "stock-thread", command: "ls" }) }),
};

const server = createServer();
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) => {
  let nextAsk = 0;
  const asks = new Map();
  const connection = {
    initialized: false,
    notify: (method, params) => socket.send(JSON.stringify({ method, params })),
    ask: (method, params) => new Promise((resolve) => {
      const id = ++nextAsk;
      asks.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    }),
  };
  connections.add(connection);
  socket.on("close", () => {
    connections.delete(connection);
    for (const thread of threads.values()) thread.subscribers?.delete(connection);
  });
  socket.on("message", async (data) => {
    const text = data.toString();
    const message = JSON.parse(text);
    if (message.method === undefined) {
      asks.get(message.id)?.(message.result?.decision ?? message.result);
      return;
    }
    if (message.id === undefined) return;
    const handler = handlers[message.method];
    try {
      const result = handler ? await handler(connection, message.params ?? {}) : { echo: message.method, raw: text };
      socket.send(JSON.stringify({ id: message.id, result }));
    } catch (error) {
      socket.send(JSON.stringify({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }));
    }
  });
});
server.listen(socketPath);
process.on("SIGTERM", () => process.exit(0));
