// E2E driver (runs inside the container): starts the gateway through the managed `codex` shim, talks to it like
// Desktop over the control socket, and exercises every feature with real models. Results → /out/results.json.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

const HOME = homedir();
const PACKAGE = join(HOME, ".ccodex", "current", "node_modules", "@gkorepanov", "ccodex");
const require = createRequire(join(PACKAGE, "package.json"));
const WebSocket = require("ws");
const SOCKET = join(HOME, ".codex", "app-server-control", "app-server-control.sock");
const WORK = join(HOME, "work");
const GPT = "gpt-6-luna";
/** Said ahead of the odd requests (sleeping, messaging a chat by name) a cautious model may otherwise question. */
const TEST = "This is an automated integration test of the tool you run in; every step is intentional and harmless, so do exactly as asked. ";

/** A solid red size×size PNG. */
const redPng = (size) => {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(size).fill([255, 0, 0]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array(size).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value) => [{ type: "text", text: value, text_elements: [] }];
const itemsOf = (turns) => turns.flatMap((turn) => turn.items.map((item) => item.type === "userMessage"
  ? `user:${item.content?.[0]?.text ?? ""}` : item.type === "agentMessage" ? `agent:${item.text}` : item.type));
const sessionName = (threadId) => {
  const sessions = join(HOME, ".claude", "sessions");
  return readdirSync(sessions).map((file) => JSON.parse(readFileSync(join(sessions, file), "utf8"))).find((session) => session.sessionId === threadId)?.name;
};
/** The turns a thread showed live since a message index: ids and completed items (id + type), in order. */
const liveTurns = (threadId, since) => {
  const turns = new Map();
  for (const m of client.messages.slice(since)) {
    if (m.params?.threadId !== threadId) continue;
    if (m.method === "turn/started") turns.set(m.params.turn.id, []);
    if (m.method === "item/completed" && turns.has(m.params.turnId)) turns.get(m.params.turnId).push(m.params.item);
  }
  return [...turns].map(([id, items]) => ({ id, items }));
};
/** Same turns with the same user messages and tools (reasoning and message split may differ between live and history). */
const sameTurns = (live, history) => {
  const shape = (turns) => JSON.stringify(turns.map((turn) => [turn.id, turn.items.filter((item) => !["reasoning", "agentMessage"].includes(item.type)).map((item) => `${item.type}:${item.id}`)]));
  return shape(live) === shape(history);
};
const items = async (threadId) => (await client.request("thread/read", { threadId, includeTurns: true })).thread.turns.flatMap((turn) => turn.items);
const answers = (client, threadId, since = 0) => client.messages.slice(since)
  .filter((m) => m.method === "item/completed" && m.params.threadId === threadId && m.params.item.type === "agentMessage")
  .map((m) => m.params.item.text);

class Client {
  messages = [];
  onRequest = () => ({ decision: "accept" });
  asked = [];
  #next = 0;
  #pending = new Map();

  static async connect(name = "codex_desktop", path = SOCKET) {
    const socket = new WebSocket("ws://ccodex/rpc", { createConnection: () => createConnection(path), perMessageDeflate: false });
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const client = new Client(socket);
    await client.request("initialize", { clientInfo: { name, title: "E2E", version: "26.917.51856" }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: "initialized" }));
    return client;
  }

  constructor(socket) {
    this.socket = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      this.messages.push(message);
      if (message.method !== undefined && message.id !== undefined) {
        this.asked.push(message);
        void Promise.resolve(this.onRequest(message)).then((result) => socket.send(JSON.stringify({ id: message.id, result })));
        return;
      }
      if (message.method !== undefined) return;
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) pending?.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else pending?.resolve(message.result);
    });
  }

  request(method, params = {}, timeoutMs = 120_000) {
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      this.#pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async waitFor(method, predicate = () => true, timeoutMs = 180_000, since = 0) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.slice(since).find((m) => m.method === method && m.id === undefined && predicate(m.params));
      if (found) return found.params;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${method}`);
      await sleep(50);
    }
  }

  /** turn/start, then wait until `turns` turns (2 for a provider switch) have started and completed. */
  async turn(threadId, value, extra = {}, timeoutMs = 240_000, turns = 1) {
    const before = this.messages.length;
    const response = await this.request("turn/start", { threadId, input: text(value), ...extra });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const recent = this.messages.slice(before);
      const done = recent.filter((m) => m.method === "turn/completed" && m.params.threadId === threadId);
      const started = recent.filter((m) => m.method === "turn/started" && m.params.threadId === threadId);
      if (done.length >= turns && done.length >= started.length) return { ...done.at(-1).params, response, answers: answers(this, threadId, before) };
      if (Date.now() > deadline) throw new Error(`turn on ${threadId} did not complete`);
      await sleep(100);
    }
  }

  close() { this.socket.close(); }
}

const results = [];
const state = {};
let client;

function check(condition, message, detail) {
  if (!condition) throw Object.assign(new Error(message), { detail });
}

async function daemon(command, env = process.env) {
  const output = execFileSync("codex", ["app-server", "daemon", command], { encoding: "utf8", timeout: 60_000, env });
  for (let attempt = 0; command !== "stop" && !existsSync(SOCKET) && attempt < 100; attempt += 1) await sleep(100);
  return output.trim();
}

const scenarios = {
  async basics() {
    const models = (await client.request("model/list", { includeHidden: false })).data;
    state.models = models.map((model) => model.id);
    state.haiku = state.models.find((id) => id.startsWith("claude:") && id.includes("haiku"));
    state.opus = state.models.find((id) => id.startsWith("claude:") && id.includes("opus"));
    check(state.haiku && state.opus && state.models.includes(GPT), "models merged", state.models);
    const skills = await client.request("skills/list", { cwds: [WORK] });
    const limits = await client.request("account/rateLimits/read", {});
    return { models: state.models, skills: skills.data[0].skills.map((skill) => skill.name).slice(0, 20), limits: Object.keys(limits) };
  },

  /** What the gateway adds to each request Desktop makes on start, next to its own stock app-server (A/B). */
  async latency() {
    client.close();
    let at = performance.now();
    await daemon("restart");
    const restartMs = Math.round(performance.now() - at);
    client = await Client.connect();
    const run = join(HOME, ".ccodex", "state", "run");
    const stock = await Client.connect("codex_desktop", readdirSync(run).map((pid) => join(run, pid, "stock.sock")).find(existsSync));
    const { thread } = await stock.request("thread/start", { model: GPT, cwd: WORK });
    await stock.turn(thread.id, "Reply OK", { model: GPT });
    const methods = [
      ["model/list", { includeHidden: false }], ["skills/list", {}], ["plugin/list", {}], ["account/rateLimits/read", {}],
      ["account/read", {}], ["config/read", {}], ["thread/list", { limit: 50 }], ["thread/read", { threadId: thread.id, includeTurns: true }],
    ];
    const rows = [];
    for (const [method, params] of methods) {
      const time = async (target) => { const start = performance.now(); await target.request(method, params); return performance.now() - start; };
      const gateway = [], direct = [];
      for (let round = 0; round < 7; round += 1) { direct.push(await time(stock)); gateway.push(await time(client)); }
      const median = (values) => values.slice(1).sort((left, right) => left - right)[3];
      rows.push({ method, stockMs: +median(direct).toFixed(1), gatewayMs: +median(gateway).toFixed(1), firstStockMs: Math.round(direct[0]), firstGatewayMs: Math.round(gateway[0]) });
    }
    stock.close();
    // Methods stock answers from the network (plugins, rate limits) vary by hundreds of ms: reported, not checked.
    const slow = rows.filter((row) => row.stockMs < 50 && row.gatewayMs > row.stockMs + 5);
    check(!slow.length, "the gateway adds no noticeable latency", rows);
    return { restartMs, rows };
  },

  async stockPassthrough() {
    const { thread } = await client.request("thread/start", { model: GPT, cwd: WORK });
    const done = await client.turn(thread.id, "Reply with exactly the word STOCK-OK and nothing else.", { model: GPT });
    check(done.answers.join(" ").includes("STOCK-OK"), "stock answer", done.answers);
    state.stock = thread.id;
    return { answers: done.answers };
  },

  async claudeTools() {
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK, approvalPolicy: "on-request", sandbox: "workspace-write" });
    state.claude = thread.id;
    client.asked.length = 0;
    const done = await client.turn(thread.id, "Use the Bash tool to run exactly this command: echo e2e-ok > /home/node/work/approved.txt\nThen reply with the single word DONE.");
    check(existsSync(join(WORK, "approved.txt")), "command ran", done.answers);
    const approvals = client.asked.filter((m) => m.method === "item/commandExecution/requestApproval").map((m) => m.params.command);
    check(approvals.length > 0, "approval asked", client.asked.map((m) => m.method));
    const { thread: read } = await client.request("thread/read", { threadId: thread.id, includeTurns: true });
    const items = itemsOf(read.turns);
    check(items.includes("commandExecution"), "commandExecution item persisted", items);
    const list = await client.request("thread/list", { limit: 50 });
    check(list.data.some((row) => row.id === thread.id), "listed", list.data.map((row) => row.id));
    return { approvals, items, answers: done.answers };
  },

  /** Claude's process starts ahead of a first prompt: a new chat's at once, an earlier chat's once it stayed open 10 s. */
  async prewarm() {
    const running = (flag, id) => spawnSync("pgrep", ["-f", `claude .*--${flag}=${id}`]).status === 0;
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK, approvalPolicy: "never", sandbox: "danger-full-access" });
    await sleep(4_000);
    check(running("session-id", thread.id), "a new chat's process runs before its first prompt");
    let at = Date.now();
    const fresh = await client.turn(thread.id, "Reply with the single word WARM-NEW.");
    const newMs = Date.now() - at;
    check(fresh.answers.join(" ").includes("WARM-NEW"), "the new chat answers", fresh.answers);

    client.close();
    await daemon("restart");
    client = await Client.connect();
    await client.request("thread/resume", { threadId: thread.id });
    await sleep(3_000);
    check(!running("resume", thread.id), "an earlier chat just opened has no process yet");
    await sleep(9_000);
    check(running("resume", thread.id), "an earlier chat open for 10 s has its process");
    at = Date.now();
    const again = await client.turn(thread.id, "What single word did you reply before? Reply with it only.");
    const resumedMs = Date.now() - at;
    check(again.answers.join(" ").includes("WARM-NEW"), "the earlier chat answers knowing its history", again.answers);
    return { newMs, resumedMs };
  },

  async status() {
    const stock = await client.turn(state.stock, "/ccstatus");
    const claude = await client.turn(state.claude, "/ccstate");
    check(stock.answers[0]?.includes("CCodex"), "/ccstatus", stock.answers);
    check(claude.answers[0]?.includes("permissions"), "/ccstate", claude.answers);
    return { status: stock.answers[0], state: claude.answers[0] };
  },

  async titles() {
    const since = client.messages.length;
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK });
    await client.turn(thread.id, "In one sentence: what is a mutex?");
    const claude = await client.waitFor("thread/name/updated", (p) => p.threadId === thread.id && p.threadName.endsWith("✳️"), 120_000, since);
    const { thread: gpt } = await client.request("thread/start", { model: GPT, cwd: WORK });
    await client.turn(gpt.id, "In one sentence: what is a semaphore?", { model: GPT });
    const stock = await client.waitFor("thread/name/updated", (p) => p.threadId === gpt.id, 120_000, since);
    check(claude.threadName.endsWith("✳️") && !stock.threadName.endsWith("✳️"), "✳️ only on Claude", { claude, stock });
    // Claude's own title of the session (in its transcript) never shows: CCodex names it.
    const shown = client.messages.slice(since).filter((m) => m.method === "thread/name/updated" && m.params.threadId === thread.id).map((m) => m.params.threadName);
    check(shown.every((name) => name.endsWith("✳️")), "only CCodex's title shown", shown);
    return { claude: shown, stock: stock.threadName };
  },

  async switchBothWays() {
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK });
    state.switched = thread.id;
    await client.turn(thread.id, "Remember this secret word: PINEAPPLE. Reply only with OK.");
    const toGpt = await client.turn(thread.id, "What is the secret word I told you? Reply with just the word.", { model: GPT }, 400_000);
    check(toGpt.answers.join(" ").toUpperCase().includes("PINEAPPLE"), "gpt knows the word", toGpt.answers);
    const toClaude = await client.turn(thread.id, "Repeat the secret word once more, just the word.", { model: state.haiku }, 400_000);
    check(toClaude.answers.join(" ").toUpperCase().includes("PINEAPPLE"), "claude knows the word", toClaude.answers);
    const { thread: read } = await client.request("thread/read", { threadId: thread.id, includeTurns: true });
    state.switchedTurns = read.turns;
    const items = itemsOf(read.turns);
    check(items.filter((item) => item === "contextCompaction").length >= 2, "two compactions in stitched history", items);
    const rows = (await client.request("thread/list", { limit: 100 })).data.filter((row) => row.id === thread.id);
    check(rows.length === 1, "one row", rows);
    return { items, row: { provider: rows[0].modelProvider, model: rows[0].model, name: rows[0].name } };
  },

  async forkBeforeCompaction() {
    const first = state.switchedTurns[0];
    const { thread } = await client.request("thread/fork", { threadId: state.switched, lastTurnId: first.id });
    const { thread: read } = await client.request("thread/read", { threadId: thread.id, includeTurns: true });
    const items = itemsOf(read.turns);
    check(!items.includes("contextCompaction") && read.turns.length === 1, "fork has only the first turn", items);
    const done = await client.turn(thread.id, "What is the secret word? Just the word.", { model: state.haiku });
    check(done.answers.join(" ").toUpperCase().includes("PINEAPPLE"), "fork continues with full context", done.answers);
    return { items, answers: done.answers };
  },

  async rollbackAcrossSwitch() {
    const before = state.switchedTurns.length;
    const result = await client.request("thread/rollback", { threadId: state.switched, numTurns: 2 });
    const { thread: read } = await client.request("thread/read", { threadId: state.switched, includeTurns: true });
    check(read.turns.length === before - 2, "two turns fewer", { before, after: read.turns.length, items: itemsOf(read.turns) });
    const done = await client.turn(state.switched, "Say the secret word again, just the word.", { model: GPT }, 300_000);
    check(done.answers.join(" ").toUpperCase().includes("PINEAPPLE"), "continues after rollback", done.answers);
    return { after: itemsOf(read.turns), rollbackTurns: result.thread.turns.length, answers: done.answers };
  },

  async goal() {
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK });
    await client.turn(thread.id, "Reply only with OK.");
    const since = client.messages.length;
    const set = await client.request("thread/goal/set", { threadId: thread.id, objective: "Reply with the single word GOAL-DONE." });
    check(set.goal?.status === "active", "goal set", set);
    await client.waitFor("thread/goal/updated", (p) => p.threadId === thread.id, 120_000, since);
    await client.waitFor("turn/completed", (p) => p.threadId === thread.id, 240_000, since);
    const got = await client.request("thread/goal/get", { threadId: thread.id });
    await client.request("thread/goal/clear", { threadId: thread.id });
    await sleep(3000);
    const cleared = await client.request("thread/goal/get", { threadId: thread.id });
    return { set: set.goal, got: got.goal, cleared: cleared.goal, answers: answers(client, thread.id, since) };
  },

  async side() {
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK });
    await client.turn(thread.id, "My favorite color is teal. Reply only with OK.");
    const { thread: side } = await client.request("thread/fork", { threadId: thread.id, ephemeral: true, excludeTurns: true, threadSource: "user" });
    // Desktop opens a side chat with a boundary message.
    const boundary = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Side conversation boundary." }] }];
    await client.request("thread/inject_items", { threadId: side.id, items: boundary });
    const done = await client.turn(side.id, "What is my favorite color? One word.");
    check(done.answers.join(" ").toLowerCase().includes("teal"), "side sees the context", done.answers);
    const main = await client.request("thread/read", { threadId: thread.id, includeTurns: true });
    check(main.thread.turns.length === 1, "side leaves the thread alone", itemsOf(main.thread.turns));
    const stockSide = await client.request("thread/fork", { threadId: state.stock, ephemeral: true, excludeTurns: true, threadSource: "user" });
    await client.request("thread/inject_items", { threadId: stockSide.thread.id, items: boundary });
    const stockDone = await client.turn(stockSide.thread.id, "Reply with the word SIDE-OK.", { model: GPT });
    return { claude: done.answers, stock: stockDone.answers };
  },

  async subagents() {
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK, approvalPolicy: "never", sandbox: "danger-full-access" });
    const done = await client.turn(thread.id, "In ONE message, launch TWO Agent tool calls in parallel (subagent_type general-purpose): one described 'Alpha echo' with the prompt 'Reply with the word ALPHA-OK', one described 'Beta echo' with the prompt 'Reply with the word BETA-OK'. Then tell me exactly what each replied.", {}, 300_000);
    const children = (await client.request("thread/list", { limit: 20, parentThreadId: thread.id, sourceKinds: ["subAgentThreadSpawn"] })).data;
    const { thread: read } = await client.request("thread/read", { threadId: thread.id, includeTurns: true });
    const spawns = read.turns.flatMap((turn) => turn.items).filter((item) => item.type === "collabAgentToolCall");
    const names = children.map((child) => child.agentNickname);
    check(children.length === 2 && names.some((name) => /Alpha/u.test(name)) && names.some((name) => /Beta/u.test(name)), "both parallel sub-agents listed by name", { names, answers: done.answers });
    check(spawns.length >= 2 && spawns.every((item) => item.status === "completed"), "both spawns settled in the parent", spawns.map((item) => item.status));
    const childItems = [];
    for (const child of children) childItems.push(itemsOf((await client.request("thread/read", { threadId: child.id, includeTurns: true })).thread.turns));
    check(childItems.some((items) => items.some((item) => item.includes("ALPHA-OK"))) && childItems.some((items) => items.some((item) => item.includes("BETA-OK"))), "each sub-agent's chat has its answer", childItems);
    return { names, childItems, answers: done.answers };
  },

  /** What `ccodex setup` installs on a clean machine lets Claude delegate to Codex: codex-wrapper → codex MCP → Codex's messages in the sub-agent's chat. */
  async codexSubagent() {
    const agent = join(HOME, ".claude", "agents", "codex-wrapper.md");
    const skill = join(HOME, ".claude", "skills", "workforce", "SKILL.md");
    const server = JSON.parse(readFileSync(join(HOME, ".claude.json"), "utf8")).mcpServers?.codex;
    check(existsSync(agent) && existsSync(skill) && server?.command === "codex" && server.args?.[0] === "mcp-server", "setup installed the Claude stack", { agent: existsSync(agent), skill: existsSync(skill), server });
    const settings = JSON.parse(readFileSync(join(HOME, ".claude", "settings.json"), "utf8"));
    check(settings.cleanupPeriodDays === 36_500, "setup keeps Claude's transcripts", settings);
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK, approvalPolicy: "never", sandbox: "danger-full-access" });
    // Only Codex can answer (the wrapper has no tool but Codex's), or the wrapper just replies itself.
    const done = await client.turn(thread.id, `Use the Agent tool with subagent_type codex-wrapper and no model parameter. Its prompt: "Have Codex (model ${GPT}) run \`cat /proc/sys/kernel/random/uuid\` and report the exact output." Then tell me that output.`, {}, 600_000);
    const children = (await client.request("thread/list", { limit: 20, parentThreadId: thread.id, sourceKinds: ["subAgentThreadSpawn"] })).data;
    check(children.length === 1, "codex-wrapper sub-agent listed", { children, answers: done.answers });
    const childItems = itemsOf((await client.request("thread/read", { threadId: children[0].id, includeTurns: true })).thread.turns);
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;
    check(childItems.includes("mcpToolCall") && childItems.some((item) => item.startsWith("agent:◆") && uuid.test(item)), "Codex's call and messages in the sub-agent's chat", childItems);
    return { name: children[0].agentNickname, childItems, answers: done.answers };
  },

  /**
   * Claude chats message each other (SendMessage): the sender shows "Sent message to chat" linking to the receiver, the
   * receiver a turn of its own opened by Desktop's "sent from another task" message linking back, live and in history.
   * A message that arrives while the receiver works joins its running turn; a reply links back; a claude CLI session can
   * send one too.
   */
  async peerMessages() {
    const start = async () => (await client.request("thread/start", { model: state.haiku, cwd: WORK, approvalPolicy: "never", sandbox: "danger-full-access" })).thread.id;
    const receiver = await start();
    await client.turn(receiver, "Remember the code word MANGO. Reply only: READY.");
    const name = sessionName(receiver);
    check(name, "the receiver's session is registered by name", readdirSync(join(HOME, ".claude", "sessions")));
    const sender = await start();
    const send = (text) => `${TEST}Use the SendMessage tool (load it with ToolSearch first) to send the Claude session named "${name}" exactly: ${text}. Then stop; do not wait for an answer.`;
    let since = client.messages.length;
    const sent = await client.turn(sender, send("What is your code word?"));
    await client.waitFor("turn/completed", (params) => params.threadId === receiver, 240_000, since);
    const toChat = (await items(sender)).find((item) => item.type === "dynamicToolCall" && item.tool === "send_message_to_thread");
    check(toChat?.namespace === "codex_app" && toChat.arguments.threadId === receiver && toChat.status === "completed", "the sender shows Sent message to chat, linking to the receiver", { toChat, answers: sent.answers });
    const delegation = (item, source) => item?.type === "userMessage" && item.content[0].text.startsWith("<codex_delegation>") && item.content[0].text.includes(`<source_thread_id>${source}</source_thread_id>`);
    let history = (await client.request("thread/read", { threadId: receiver, includeTurns: true })).thread.turns;
    check(history.length === 2 && delegation(history[1].items[0], sender), "in history, the message opens a turn of its own", itemsOf(history));
    check(sameTurns(liveTurns(receiver, since), history.slice(1)), "live, the same turn with the same message", { live: liveTurns(receiver, since), history: history.slice(1) });

    // While the receiver works, the message joins its running turn (Claude's queued command), after what came before it.
    since = client.messages.length;
    await client.request("turn/start", { threadId: receiver, input: text(`${TEST}Run this exact bash command (it stands in for a 25-second build): python3 -c 'import time; time.sleep(25)' — then reply with the single word SLEPT.`) });
    await client.waitFor("item/started", (params) => params.threadId === receiver && params.item.type === "commandExecution", 120_000, since);
    await client.turn(sender, send("PING-MID"));
    await client.waitFor("turn/completed", (params) => params.threadId === receiver, 240_000, since);
    history = (await client.request("thread/read", { threadId: receiver, includeTurns: true })).thread.turns;
    const running = history.at(-1).items;
    const mid = running.findIndex((item) => delegation(item, sender) && item.content[0].text.includes("PING-MID"));
    check(history.length === 3 && mid > running.findIndex((item) => item.type === "commandExecution"), "a message sent while the receiver works joins its running turn", itemsOf(history.slice(2)));
    check(sameTurns(liveTurns(receiver, since), history.slice(2)), "live too", { live: liveTurns(receiver, since), history: history.slice(2) });

    // A reply goes to the address the message came from (uds:<socket>), not a name.
    since = client.messages.length;
    await client.turn(receiver, "Use SendMessage to reply PONG to the agent that sent you PING-MID (to: the address it came from). Then stop; do not wait for an answer.");
    const reply = (item) => item.type === "dynamicToolCall" && item.tool === "send_message_to_thread" && item.arguments.threadId === sender;
    const liveReply = client.messages.slice(since).find((m) => m.method === "item/completed" && m.params.threadId === receiver && (m.params.item.type === "dynamicToolCall" || m.params.item.tool === "sendInput"))?.params.item;
    check(liveReply && reply(liveReply), "a reply shows Sent message to chat, linking to the sender", liveReply);
    history = (await client.request("thread/read", { threadId: receiver, includeTurns: true })).thread.turns;
    check(history.at(-1).items.some(reply), "in history too", itemsOf(history.slice(3)));
    await client.waitFor("turn/completed", (params) => params.threadId === sender, 240_000, since).catch(() => undefined);

    // A claude CLI session (listed as a chat of its own) sends one.
    since = client.messages.length;
    const claude = join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json")), "claude");
    const cli = spawnSync(claude, ["-p", send("FROM-CLI"), "--model", "haiku", "--dangerously-skip-permissions", "--output-format", "json"], { cwd: WORK, encoding: "utf8", timeout: 180_000 });
    check(cli.status === 0, "claude -p ran", cli.stderr);
    const { session_id: cliSession, result: cliSaid } = JSON.parse(cli.stdout);
    await client.waitFor("turn/completed", (params) => params.threadId === receiver, 240_000, since)
      .catch((error) => { throw Object.assign(error, { detail: { cliSaid } }); });
    history = (await client.request("thread/read", { threadId: receiver, includeTurns: true })).thread.turns;
    check(delegation(history.at(-1).items[0], cliSession), "a CLI session's message links to its chat", itemsOf(history.slice(4)));
    check(sameTurns(liveTurns(receiver, since), history.slice(4)), "live too", { live: liveTurns(receiver, since), history: history.slice(4) });
    return { name, toChat: toChat.arguments, midTurn: itemsOf(history.slice(2, 3)), cli: cliSession };
  },

  /**
   * A chat's sub-agents: a message to one shows as "Messaged <agent>" (also in a chat's first turn, and after the daemon
   * restarted), a message from one to the chat opens a turn of its own linking to the sub-agent, live and in history.
   */
  async peerSubagents() {
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK, approvalPolicy: "never", sandbox: "danger-full-access" });
    let since = client.messages.length;
    await client.turn(thread.id, "Use the Agent tool with run_in_background: true, subagent_type general-purpose, no model parameter, description 'Reporter' and prompt: 'Use the SendMessage tool (load it with ToolSearch first) to send the main agent that started you (your parent / team lead) the message REPORT-OK. Then reply with the word DONE.'. Right after, use SendMessage to send that agent (to: its agent id) the message 'Thanks.'. Then stop without waiting.", {}, 300_000);
    const child = client.messages.slice(since).find((m) => m.method === "item/completed" && m.params.threadId === thread.id && m.params.item.tool === "spawnAgent")?.params.item.receiverThreadIds[0];
    const message = (item) => item.type === "collabAgentToolCall" && item.tool === "sendInput";
    const liveMessage = client.messages.slice(since).find((m) => m.method === "item/completed" && m.params.threadId === thread.id && message(m.params.item))?.params.item;
    check(child && liveMessage?.receiverThreadIds[0] === child, "in a chat's first turn, a message to its sub-agent goes to its thread (Messaged <agent>)", { child, liveMessage });
    // The sub-agent's message (no command of its own): a turn of its own when it came after the turn's result (Claude
    // answers it right away), else part of the running turn.
    const delegated = (turn) => turn.items.some((item) => item.type === "userMessage" && item.content[0].text.includes(`<source_thread_id>${child}</source_thread_id>`) && item.content[0].text.includes("REPORT-OK"));
    for (let attempt = 0; attempt < 600 && !liveTurns(thread.id, since).some(delegated); attempt += 1) await sleep(200);
    await client.waitFor("thread/status/changed", (params) => params.threadId === thread.id && params.status.type === "idle", 240_000, client.messages.length - 1).catch(() => undefined);
    await sleep(3000);
    const history = (await client.request("thread/read", { threadId: thread.id, includeTurns: true })).thread.turns;
    check(history.some(delegated), "the sub-agent's message links to its thread", itemsOf(history));
    check(sameTurns(liveTurns(thread.id, since), history), "live, the same turns", { live: liveTurns(thread.id, since), history });

    // After a restart the chat's process is new; its earlier sub-agent is still known.
    client.close();
    await daemon("restart");
    client = await Client.connect();
    await client.request("thread/resume", { threadId: thread.id });
    since = client.messages.length;
    await client.turn(thread.id, `Use SendMessage to send the agent ${child.slice("agent-".length)} (to: that id) the message 'Again.'. Then stop without waiting.`, {}, 300_000);
    const again = client.messages.slice(since).find((m) => m.method === "item/completed" && m.params.threadId === thread.id && message(m.params.item))?.params.item;
    check(again?.receiverThreadIds[0] === child, "after a restart, a message to an earlier sub-agent goes to its thread", again);
    return { child, turns: history.map((turn) => turn.items[0]?.content?.[0]?.text?.slice(0, 80)) };
  },

  /** An image attached in Desktop (a local file) reaches Claude and stays on the user message. */
  async claudeImage() {
    const image = join(WORK, "red.png");
    writeFileSync(image, redPng(64));
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK });
    const input = [...text("What single color fills this image? Reply with one lowercase word."), { type: "localImage", path: image }];
    const done = await client.turn(thread.id, "", { input });
    check(/\bred\b/iu.test(done.answers.join(" ")), "Claude saw the image", done.answers);
    const user = (await client.request("thread/read", { threadId: thread.id, includeTurns: true })).thread.turns[0].items.find((item) => item.type === "userMessage");
    // Read back from Claude's transcript, the file comes back inlined.
    check(user.content.some((part) => part.type === "image" && part.url.startsWith("data:image/png;base64,")), "image kept on the user message", user.content.map((part) => part.type));
    return { answers: done.answers };
  },

  /** Both providers' skills are listed in every chat (Desktop asks per cwd): a Claude skill mentioned in a GPT chat is Claude's own file. */
  async claudeSkillInGpt() {
    const skill = join(HOME, ".claude", "skills", "workforce", "SKILL.md");
    const listed = (await client.request("skills/list", { cwds: [WORK] })).data[0].skills.find((entry) => entry.name === "claude:workforce");
    check(listed?.path === skill, "Claude skill listed with its file", listed);
    const { thread } = await client.request("thread/start", { model: GPT, cwd: WORK, approvalPolicy: "never", sandbox: "danger-full-access" });
    const done = await client.turn(thread.id, `[$claude:workforce](${skill}) Open this skill's file and reply with only its first line that starts with "# ".`, { model: GPT });
    check(done.answers.join(" ").includes("Subagents and token usage"), "GPT read the Claude skill", done.answers);
    return { answers: done.answers };
  },

  async codexMcpStreaming() {
    // codex ≥ 0.154 has no `mcp-server`: CCodex serves the same tools on `codex exec` (registered by `ccodex setup`).
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK, approvalPolicy: "never", sandbox: "danger-full-access" });
    const since = client.messages.length;
    const done = await client.turn(thread.id, `Call the mcp__codex__codex tool with prompt "Reply with the word MCP-OK" and model "${GPT}". Then tell me what it returned.`, {}, 400_000);
    const streamed = client.messages.slice(since).filter((m) => m.method === "item/completed" && m.params.threadId === thread.id)
      .map((m) => m.params.item).filter((item) => item.type === "agentMessage" && /Codex/u.test(item.text)).map((item) => item.text.slice(0, 120));
    const tools = itemsOf((await client.request("thread/read", { threadId: thread.id, includeTurns: true })).thread.turns);
    check(tools.includes("mcpToolCall"), "mcp tool call item", tools);
    check(streamed.length > 0, "codex messages streamed into the thread", { answers: done.answers });
    // The prompt names what codex ran it with (its journal's turn_context; no effort there = the model's default).
    check(streamed.some((text) => new RegExp(`^◆ CCodex │ Codex MCP prompt · ${GPT}( · \\w+)?\n`, "u").test(text)), "prompt labelled with model and effort", streamed);
    return { streamed, tools, answers: done.answers };
  },

  /** Claude's Skill tool shows as stock shows a skill: a read of the skill's SKILL.md, named after it. */
  async claudeSkillCall() {
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK, approvalPolicy: "never", sandbox: "danger-full-access" });
    const done = await client.turn(thread.id, "Use the Skill tool to load the workforce skill, then reply with just SKILL-OK.");
    const skill = join(HOME, ".claude", "skills", "workforce", "SKILL.md");
    const reads = (await client.request("thread/read", { threadId: thread.id, includeTurns: true })).thread.turns.flatMap((turn) => turn.items)
      .filter((item) => item.type === "commandExecution").flatMap((item) => item.commandActions);
    check(reads.some((action) => action.type === "read" && action.name === "workforce skill" && action.path === skill), "Skill call shown as a read of its SKILL.md", reads);
    return { reads, answers: done.answers };
  },

  async interruptSteerQueue() {
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK, approvalPolicy: "never", sandbox: "danger-full-access" });
    let since = client.messages.length;
    const { turn } = await client.request("turn/start", { threadId: thread.id, input: text("Use the Bash tool to run `sleep 20`, then reply DONE.") });
    await client.waitFor("item/started", (p) => p.threadId === thread.id && p.item.type === "commandExecution", 60_000, since);
    await client.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
    const interrupted = await client.waitFor("turn/completed", (p) => p.threadId === thread.id, 60_000, since);
    check(interrupted.turn.status === "interrupted", "interrupted", interrupted.turn);

    since = client.messages.length;
    const second = await client.request("turn/start", { threadId: thread.id, input: text("Use the Bash tool to run `sleep 6`, then reply with one short sentence.") });
    await client.waitFor("item/started", (p) => p.threadId === thread.id && p.item.type === "commandExecution", 60_000, since);
    await client.request("turn/steer", { threadId: thread.id, expectedTurnId: second.turn.id, input: text("Also include the word ZEBRA in your reply.") });
    const queued = await client.request("thread/queue/add", { threadId: thread.id, input: text("Reply with the word QUEUED-OK."), clientUserMessageId: "e2e-queue" });
    const listed = await client.request("thread/queue/list", { threadId: thread.id });
    await client.waitFor("item/completed", (p) => p.threadId === thread.id && p.item.type === "agentMessage" && /QUEUED-OK/u.test(p.item.text), 180_000, since);
    const steered = answers(client, thread.id, since).join(" ");
    check(/ZEBRA/u.test(steered), "steer reached the running turn", steered);
    const { thread: read } = await client.request("thread/read", { threadId: thread.id, includeTurns: true });
    check(read.turns[0].status === "interrupted", "interrupted in history", read.turns.map((t) => t.status));
    state.lifecycle = thread.id;
    return { queuedId: queued.queuedSubmission.id, listed: listed.data.length, answers: answers(client, thread.id, since), turns: read.turns.map((t) => `${t.status}:${t.items.length}`) };
  },

  async compactRollbackManage() {
    const threadId = state.lifecycle;
    const since = client.messages.length;
    await client.request("thread/compact/start", { threadId });
    await client.waitFor("item/completed", (p) => p.threadId === threadId && p.item.type === "contextCompaction", 180_000, since);
    await client.waitFor("turn/completed", (p) => p.threadId === threadId, 60_000, since);
    const before = (await client.request("thread/read", { threadId, includeTurns: true })).thread.turns.length;
    const after = await client.turn(threadId, "What word did I ask you to include earlier? One word.");
    check(after.answers.join(" ").toUpperCase().includes("ZEBRA"), "context survives /compact", after.answers);
    await client.request("thread/rollback", { threadId, numTurns: 1 });
    const rolled = (await client.request("thread/read", { threadId, includeTurns: true })).thread.turns.length;
    check(rolled === before, "rollback drops the last turn", { before, rolled });
    await client.request("thread/name/set", { threadId, name: "Manual name" });
    check((await client.request("thread/read", { threadId })).thread.name === "Manual name", "manual rename");
    await client.request("thread/archive", { threadId });
    const archived = (await client.request("thread/list", { limit: 100, archived: true })).data.some((row) => row.id === threadId);
    await client.request("thread/unarchive", { threadId });
    const back = (await client.request("thread/list", { limit: 100 })).data.some((row) => row.id === threadId);
    check(archived && back, "archive round trip", { archived, back });
    await client.request("thread/delete", { threadId });
    const gone = !(await client.request("thread/list", { limit: 100 })).data.some((row) => row.id === threadId);
    check(gone, "deleted");
    return { before, rolled };
  },

  async askUserQuestion() {
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK });
    const previous = client.onRequest;
    client.onRequest = (message) => message.method === "item/tool/requestUserInput"
      ? { answers: Object.fromEntries(message.params.questions.map((q) => [q.id, { answers: [q.options?.[1]?.label ?? "Blue"] }])) }
      : previous(message);
    client.asked.length = 0;
    const done = await client.turn(thread.id, "Use the AskUserQuestion tool to ask me to pick a color with the options Red and Blue. Then tell me which one I picked.");
    client.onRequest = previous;
    const asked = client.asked.filter((m) => m.method === "item/tool/requestUserInput");
    check(asked.length === 1, "question asked", client.asked.map((m) => m.method));
    check(/blue/iu.test(done.answers.join(" ")), "answer reached Claude", done.answers);
    return { question: asked[0].params.questions[0], answers: done.answers };
  },

  /** A session started with the claude CLI shows up by itself (the image has no ~/.claude/projects yet), continues
   *  through CCodex, and the CLI sees what was said there. */
  async cliSession() {
    const claude = join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json")), "claude");
    const cli = (...args) => {
      const run = spawnSync(claude, ["-p", ...args, "--model", "haiku", "--output-format", "json"], { cwd: WORK, encoding: "utf8", timeout: 120_000 });
      check(run.status === 0, "claude -p ran", run.stderr);
      return JSON.parse(run.stdout);
    };
    const since = client.messages.length;
    const sessionId = cli("Remember the code word KIWI-42. Reply with just OK.").session_id;
    await client.waitFor("thread/started", (params) => params.thread.id === sessionId, 30_000, since);
    await client.request("thread/resume", { threadId: sessionId });
    const done = await client.turn(sessionId, "What code word did I ask you to remember? Reply with just the word.");
    check(done.answers.join(" ").includes("KIWI-42"), "CCodex continued the CLI session", done.answers);
    const back = cli("--resume", sessionId, "Quote my previous question to you verbatim.");
    check(back.session_id === sessionId && /code word/iu.test(back.result), "the CLI sees the CCodex turn", back);
    const users = itemsOf((await client.request("thread/read", { threadId: sessionId, includeTurns: true })).thread.turns).filter((item) => item.startsWith("user:"));
    check(users.length === 3, "all three turns in the thread", users);
    return { sessionId, answers: done.answers, cli: back.result };
  },

  /** Smoke: the plain `codex` TUI (delegated to the installed codex) runs a gpt turn. */
  async tui() {
    const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8" });
    tmux("new-session", "-d", "-s", "tui", "-x", "160", "-y", "45", "-c", WORK, `codex -m ${GPT}`);
    let screen = "";
    let sent = false;
    for (let attempt = 0; attempt < 60 && !screen.includes("TUI-OK."); attempt += 1) {
      await sleep(2000);
      screen = tmux("capture-pane", "-p", "-t", "tui");
      if (/trust/iu.test(screen) && !sent) tmux("send-keys", "-t", "tui", "Enter");
      else if (!sent && /›|context left|send/iu.test(screen)) {
        tmux("send-keys", "-t", "tui", "-l", "Reply with exactly: TUI-OK.");
        await sleep(500);
        tmux("send-keys", "-t", "tui", "Enter");
        sent = true;
      }
    }
    tmux("kill-server");
    check(screen.includes("TUI-OK."), "TUI answered", screen);
    return { screen: screen.split("\n").filter((line) => line.trim()).slice(-12) };
  },

  /** Claude processes nobody uses go like stock's idle threads, never taking work that still runs with them. */
  async idleUnload() {
    client.close();
    await daemon("restart", { ...process.env, CCODEX_E2E_IDLE_MS: "8000" });
    client = await Client.connect();
    try {
      const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK, approvalPolicy: "never", sandbox: "danger-full-access" });
      // A background command that computes for 25 s (3× the idle wait) finishes; one that sleeps is ended once idle.
      let at = Date.now();
      await client.turn(thread.id, "Use the Bash tool with run_in_background set to true to run exactly: timeout 25 sh -c 'while :; do :; done'; echo busy-done > /home/node/work/busy.txt\nThen reply STARTED at once, without waiting for it.");
      const busySeconds = (Date.now() - at) / 1_000;
      check(existsSync(join(WORK, "busy.txt")) && busySeconds >= 25, "a working background command runs to its end", busySeconds);
      at = Date.now();
      await client.turn(thread.id, "Use the Bash tool to run exactly: nohup sleep 600 >/dev/null 2>&1 & echo $! > /home/node/work/detached.pid\nThen use the Bash tool with run_in_background set to true to run exactly: sleep 600; echo slept > /home/node/work/hung.txt\nThen reply STARTED at once, without waiting for it.");
      const hungSeconds = (Date.now() - at) / 1_000;
      check(!existsSync(join(WORK, "hung.txt")) && hungSeconds < 120, "a hung background command is ended", hungSeconds);
      // Stopped the way Claude's stop control does: Claude does not take it for a failure to retry.
      await sleep(10_000);
      const sleeps = (await items(thread.id)).filter((item) => item.type === "commandExecution" && /sleep 600;/u.test(item.command));
      check(sleeps.length === 1, "the stopped command is not run again", sleeps.map((item) => item.command));
      const detached = Number(readFileSync(join(WORK, "detached.pid"), "utf8"));

      // Nobody subscribed and nothing to do: unloaded, the command it detached lives on.
      const since = client.messages.length;
      await client.request("thread/unsubscribe", { threadId: thread.id });
      await client.waitFor("thread/closed", (p) => p.threadId === thread.id, 60_000, since);
      const status = (await client.request("thread/read", { threadId: thread.id })).thread.status.type;
      check(status === "notLoaded", "unloaded", status);
      check((() => { try { return process.kill(detached, 0); } catch { return false; } })(), "detached command survives");
      process.kill(detached, "SIGKILL");
      await client.request("thread/resume", { threadId: thread.id });
      const again = await client.turn(thread.id, "Which file was the `timeout 25` command to write? Reply with its file name only.");
      check(/busy\.txt/u.test(again.answers.join(" ")), "resumed with its history", again.answers);

      // A session cron keeps its chat loaded.
      const { thread: cron } = await client.request("thread/start", { model: state.haiku, cwd: WORK, approvalPolicy: "never", sandbox: "danger-full-access" });
      await client.turn(cron.id, "Use the CronCreate tool (load it with ToolSearch first if needed) to schedule the prompt 'Reply with the word TICK.' to run once per hour. Then reply DONE.");
      check(/CronCreate/u.test(JSON.stringify(await items(cron.id))), "cron created", await items(cron.id));
      const cronSince = client.messages.length;
      await client.request("thread/unsubscribe", { threadId: cron.id });
      await sleep(20_000);
      check(!client.messages.slice(cronSince).some((m) => m.method === "thread/closed" && m.params.threadId === cron.id), "a chat with a cron stays loaded");
      return { busySeconds, hungSeconds };
    } finally {
      client.close();
      await daemon("restart");
      client = await Client.connect();
    }
  },

  async restartDeterminism() {
    const ids = [state.claude, state.switched].filter(Boolean);
    const read = async () => Promise.all(ids.map(async (threadId) => {
      const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
      return JSON.stringify({ ...thread, status: null, updatedAt: null, recencyAt: null });
    }));
    const before = await read();
    client.close();
    const restart = await daemon("restart");
    client = await Client.connect();
    const after = await read();
    const diffs = before.flatMap((value, index) => {
      if (value === after[index]) return [];
      let at = 0;
      while (value[at] === after[index][at]) at += 1;
      return [{ before: value.slice(Math.max(0, at - 150), at + 150), after: after[index].slice(Math.max(0, at - 150), at + 150) }];
    });
    check(!diffs.length, "identical after restart", diffs);
    return { restart: restart.slice(0, 200), threads: ids.length };
  },

  /** 0.4 → 0.5 on copies of a real install mounted at /mig (experiments/…/migration_e2e.sh prepares them). */
  async migration() {
    if (!existsSync("/mig")) return { skipped: "no /mig data" };
    client.close();
    await daemon("stop");
    // Earlier scenarios' stock databases go first: their WAL files would apply to the copied ones.
    execFileSync("sh", ["-c", "rm -f ~/.codex/*.sqlite* && cp -r /mig/claude/projects ~/.claude/ && cp -r /mig/codex/. ~/.codex/ && mkdir -p ~/.ccodex/state && cp /mig/state04/*.sqlite ~/.ccodex/state/"]);
    const migrated = execFileSync("node", [join(PACKAGE, "scripts", "migrate-0.4-to-0.5.mjs")], { encoding: "utf8" });
    await daemon("start");
    client = await Client.connect();
    const meta = JSON.parse(readFileSync(join(HOME, ".ccodex", "state", "meta.json"), "utf8"));
    const transcripts = new Set(readdirSync(join(HOME, ".claude", "projects"))
      .flatMap((directory) => readdirSync(join(HOME, ".claude", "projects", directory))).map((file) => file.replace(/\.jsonl$/, "")));
    const { DatabaseSync } = await import("node:sqlite");
    const stock = new DatabaseSync(join(HOME, ".codex", "state_5.sqlite"), { readOnly: true });
    const stockRow = (id) => stock.prepare("select archived from threads where id = ?").get(id);
    const exists = (segment) => segment.provider === "codex" ? Boolean(stockRow(segment.threadId)) : transcripts.has(segment.threadId);
    const isArchived = (segment) => segment.provider === "codex" ? stockRow(segment.threadId).archived === 1 : meta.archived.includes(segment.threadId);

    const list = async () => {
      const rows = new Map();
      for (const archived of [false, true]) {
        let cursor = null;
        do {
          const page = await client.request("thread/list", { limit: 100, cursor, archived });
          for (const thread of page.data) rows.set(thread.id, { ...thread, archived });
          cursor = page.nextCursor;
        } while (cursor);
      }
      return rows;
    };
    const rows = await list();
    const lineages = Object.entries(meta.lineages);
    const rowOf = (publicId, segments) => segments.find((segment) => segment.threadId === publicId) ?? segments[0];
    const rowIds = new Set(lineages.map(([publicId, segments]) => rowOf(publicId, segments).threadId));
    const hidden = lineages.flatMap(([, segments]) => segments.map((segment) => segment.threadId)).filter((id) => !rowIds.has(id));
    check(!hidden.some((id) => rows.has(id)), "hidden segments are not listed", hidden.filter((id) => rows.has(id)));

    const problems = [];
    const readable = [];
    for (const [publicId, segments] of lineages) {
      const current = segments.at(-1);
      if (!exists(rowOf(publicId, segments)) || !exists(current)) continue;
      const row = rows.get(publicId);
      if (!row) { problems.push({ publicId, problem: "not listed" }); continue; }
      if (row.archived !== isArchived(current)) problems.push({ publicId, problem: `archived ${row.archived}, current backend ${isArchived(current)}` });
      try {
        const { thread } = await client.request("thread/read", { threadId: publicId, includeTurns: true });
        // Switches to Claude show a synthetic compaction turn (switches to gpt have it in the stock thread).
        const switches = thread.turns.filter((turn) => turn.id.startsWith("switch:")).length;
        const toClaude = segments.filter((segment, index) => index > 0 && segment.provider === "claude").length;
        if (!thread.turns.length || switches !== toClaude) problems.push({ publicId, problem: `turns ${thread.turns.length}, switches ${switches}/${toClaude}` });
        else readable.push({ publicId, segments: segments.length, turns: thread.turns.length, size: JSON.stringify(thread).length, name: thread.name, model: thread.model });
      } catch (error) {
        problems.push({ publicId, problem: error.message });
      }
    }
    check(!problems.length, "migrated lineages list and read", problems);
    // Every visible 0.4 Claude thread that still has a transcript is listed under its 0.4 id (lineage parts aside).
    const backends = new Set(lineages.flatMap(([, segments]) => segments.map((segment) => segment.threadId)));
    const state04 = new DatabaseSync("/mig/state04/state.sqlite", { readOnly: true });
    const missing = state04.prepare(`select id, claude_session_id session from threads where deletion_pending = 0
      and json_extract(thread_json, '$.parentThreadId') is null`).all()
      .filter((thread) => {
        const expected = meta.lineages[thread.id] ? thread.id : thread.session;
        return transcripts.has(thread.session) && !(expected === thread.session && backends.has(expected)) && !rows.has(expected);
      });
    check(!missing.length, "0.4 Claude threads listed", missing.slice(0, 20));

    // A turn on the smallest migrated Claude thread keeps its 0.4 id.
    const alias = readable.filter((entry) => entry.segments === 1).sort((a, b) => a.size - b.size)[0];
    const { thread: before } = await client.request("thread/resume", { threadId: alias.publicId });
    execFileSync("mkdir", ["-p", before.cwd]);
    const reply = await client.turn(alias.publicId, "Reply with exactly: MIGRATED-OK", { model: state.haiku });
    check(reply.answers.some((answer) => answer.includes("MIGRATED-OK")), "turn on a migrated thread", reply.answers);
    const { thread: after } = await client.request("thread/read", { threadId: alias.publicId, includeTurns: true });
    check(after.turns.length === alias.turns + 1, "the turn is in its history", { before: alias.turns, after: after.turns.length });

    // A thread whose transcript Claude had deleted is back as text, and Claude continues it knowing what was said.
    const copied = new Set(readdirSync("/mig/claude/projects").flatMap((directory) => readdirSync(join("/mig/claude/projects", directory))).map((file) => file.replace(/\.jsonl$/, "")));
    const restoredThreads = readable.filter((entry) => entry.segments === 1 && !copied.has(meta.lineages[entry.publicId][0].threadId));
    check(restoredThreads.length > 0, "restored threads list and read", migrated.split("\n").filter((line) => line.startsWith("restored")));
    const small = restoredThreads.sort((a, b) => a.size - b.size)[0];
    await client.request("thread/resume", { threadId: small.publicId });
    const { thread: old } = await client.request("thread/read", { threadId: small.publicId, includeTurns: true });
    const first = old.turns.flatMap((turn) => turn.items).find((item) => item.type === "userMessage").content[0].text.trim().slice(0, 40);
    execFileSync("mkdir", ["-p", old.cwd]);
    const recall = await client.turn(small.publicId, "Quote verbatim the very first message I sent in this chat, nothing else.", { model: state.haiku });
    check(recall.answers.some((answer) => answer.includes(first.slice(0, 20))), "a restored thread continues with its history", { first, answers: recall.answers });

    client.close();
    await daemon("restart");
    client = await Client.connect();
    const again = await list();
    const key = (map) => [...map.values()].map((thread) => `${thread.id}:${thread.archived}:${thread.name}`).sort().join("\n");
    check(key(again) === key(rows), "same list after restart", { before: rows.size, after: again.size });
    return { restored: small.publicId, migrated: migrated.split("\n").filter((line) => !line.startsWith("fork ")), listed: rows.size, readable: readable.length, alias: alias.publicId, names: readable.filter((entry) => entry.name).length };
  },

  /**
   * Codex's own installer (what Desktop's "Update Codex" runs) replaces the `~/.local/bin/codex` link that Desktop over
   * SSH runs first: doctor flags it, `ccodex setup` takes the link back and keeps the installed codex as stock.
   */
  async officialInstaller() {
    const remote = join(HOME, ".local", "bin", "codex");
    const desktopSsh = { ...process.env, PATH: `${dirname(remote)}:${process.env.PATH}` };
    const script = execFileSync("curl", ["-fsSL", "https://chatgpt.com/codex/install.sh"], { encoding: "utf8", timeout: 60_000 });
    execFileSync("sh", ["-c", script], { encoding: "utf8", timeout: 300_000, env: { ...process.env, CODEX_NON_INTERACTIVE: "1" } });
    const installed = execFileSync("readlink", [remote], { encoding: "utf8" }).trim();
    check(installed.includes("/.codex/packages/standalone/"), "the installer took ~/.local/bin/codex", installed);
    const flagged = JSON.parse(spawnSync("ccodex", ["doctor", "--json"], { encoding: "utf8" }).stdout).checks.find((entry) => entry.id === "install");
    check(!flagged.ok && flagged.detail.includes("ccodex setup"), "doctor flags the takeover", flagged);
    const setup = execFileSync("ccodex", ["setup"], { encoding: "utf8", timeout: 120_000 }).trim();
    check(execFileSync("readlink", [remote], { encoding: "utf8" }).trim() === join(HOME, ".ccodex", "bin", "codex"), "setup took the link back", setup);
    check(execFileSync("readlink", [join(HOME, ".ccodex", "backups", "remote-codex")], { encoding: "utf8" }).trim() === installed, "the installed codex kept aside");
    // Like Desktop over SSH: ~/.local/bin first. The gateway runs on the installer's codex.
    client.close();
    await daemon("restart", desktopSsh);
    client = await Client.connect();
    const doctor = JSON.parse(spawnSync("ccodex", ["doctor", "--json"], { encoding: "utf8", env: desktopSsh }).stdout);
    const codex = doctor.checks.find((entry) => entry.id === "codex").detail;
    check(doctor.checks.every((entry) => entry.ok) && codex.startsWith(join(HOME, ".ccodex", "backups", "remote-codex")), "doctor: stock is the installed codex", doctor.checks);
    const standalone = execFileSync(installed, ["--version"], { encoding: "utf8" }).trim();
    const replies = [];
    for (const [model, word] of [[state.haiku, "CLAUDE-AFTER-INSTALL"], [GPT, "GPT-AFTER-INSTALL"]]) {
      const { thread } = await client.request("thread/start", { model, cwd: WORK });
      const reply = await client.turn(thread.id, `Reply with exactly: ${word}`);
      check(reply.answers.some((answer) => answer.includes(word)), `${model} turn after setup`, reply.answers);
      replies.push(...reply.answers);
    }
    check(codex.includes(standalone.split(" ").at(-1)), "the gateway's codex is the installed version", { codex, standalone });
    return { installed, standalone, codex, replies };
  },

  /** Desktop's terminal/git helpers (process/spawn, no thread) run on stock; doctor; uninstall leaves plain codex. */
  async management() {
    const before = client.messages.length;
    await client.request("process/spawn", { command: ["bash", "-lc", "echo TERM-OK"], cwd: WORK, streamStdoutStderr: true, streamStdin: true, timeoutMs: 10_000, processHandle: "process:e2e" });
    const exited = await client.waitFor("process/exited", (params) => params.processHandle === "process:e2e", 30_000, before);
    const output = client.messages.slice(before).filter((m) => m.method === "process/outputDelta" && m.params.processHandle === "process:e2e")
      .map((m) => Buffer.from(m.params.deltaBase64, "base64").toString()).join("");
    check(output.includes("TERM-OK") && exited.exitCode === 0, "process/spawn through the gateway", { output, exited });
    const doctor = JSON.parse(spawnSync("ccodex", ["doctor", "--json"], { encoding: "utf8" }).stdout);
    check(doctor.checks.every((entry) => entry.ok), "doctor", doctor);
    client.close();
    const uninstalled = execFileSync("ccodex", ["uninstall"], { encoding: "utf8" }).trim();
    const codex = execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8", env: { ...process.env, PATH: process.env.PATH.replace(`${HOME}/.ccodex/bin:`, "") } }).trim();
    check(!existsSync(join(HOME, ".ccodex", "bin")) && !existsSync(SOCKET), "uninstalled", { uninstalled, codex });
    const stock = execFileSync(codex, ["exec", "--skip-git-repo-check", "-m", GPT, "Reply with exactly: PLAIN-OK"], { cwd: WORK, encoding: "utf8", timeout: 180_000 });
    check(stock.includes("PLAIN-OK"), "plain codex after uninstall", stock);
    return { output: output.trim(), doctor: doctor.checks.map((entry) => `${entry.id}: ${entry.detail}`), uninstalled, codex };
  },
};

/** Scenarios that install, migrate or uninstall: a second attempt would not start from the same state. */
const NO_RETRY = new Set(["migration", "officialInstaller", "management"]);

/** What each chat last said: tells a model that did not do as asked from a bug. */
const lastAnswers = (messages) => Object.fromEntries(messages
  .filter((m) => m.method === "item/completed" && m.params.item.type === "agentMessage")
  .map((m) => [m.params.threadId, m.params.item.text.slice(0, 400)]));

/** Everything needed to tell why a scenario failed: Claude's transcripts and registry, the gateway's state and logs, the protocol. */
function keepArtifacts(name, attempt) {
  const dir = `/out/failed/${name}-${attempt}`;
  spawnSync("sh", ["-c", `mkdir -p ${dir} && cp -r ${HOME}/.claude/projects ${HOME}/.claude/sessions ${HOME}/.ccodex/state ${HOME}/.codex/app-server-daemon ${dir}/ 2>/dev/null; ps -eo pid,ppid,rss,etime,args > ${dir}/ps.txt`]);
  writeFileSync(join(dir, "messages.json"), JSON.stringify(client.messages));
  return dir;
}

const wanted = process.argv.slice(2);
spawnSync("rm", ["-rf", "/out/failed"]);
const started = await daemon("start");
console.log("daemon:", started.slice(0, 300));
client = await Client.connect();
// A failed scenario runs once more (real models sometimes decline a test's odd request); a pass on retry shows as 🔁
// with the first attempt's failure, so a flaky bug stays visible.
for (const [name, run] of Object.entries(scenarios)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const failures = [];
  for (let attempt = 1; ; attempt += 1) {
    const at = Date.now();
    const [before, since] = [client, client.messages.length];
    try {
      const detail = await run();
      const seconds = Math.round((Date.now() - at) / 1000);
      results.push({ name, ok: true, seconds, detail, failures });
      console.log(`${failures.length ? "🔁" : "✅"} ${name} (${seconds}s)`, failures.length ? `passed on retry after: ${JSON.stringify(failures[0]).slice(0, 1500)}` : "", JSON.stringify(detail).slice(0, 600));
      break;
    } catch (error) {
      const failure = { error: error.message, detail: error.detail ?? error.stack, modelSaid: lastAnswers(client === before ? client.messages.slice(since) : client.messages), artifacts: keepArtifacts(name, attempt) };
      failures.push(failure);
      if (attempt < 2 && !NO_RETRY.has(name)) continue;
      results.push({ name, ok: false, seconds: Math.round((Date.now() - at) / 1000), ...failure, failures });
      console.log(`❌ ${name}: ${error.message}`, JSON.stringify(failures).slice(0, 3000));
      break;
    }
  }
}
writeFileSync("/out/results.json", JSON.stringify(results, null, 2));
writeFileSync("/out/messages.json", JSON.stringify(client.messages));
for (const file of ["rpc.jsonl", "meta.json"]) {
  const path = join(HOME, ".ccodex", "state", file);
  if (existsSync(path)) copyFileSync(path, join("/out", file));
}
const daemonState = join(HOME, ".codex", "app-server-daemon");
if (existsSync(daemonState)) for (const file of readdirSync(daemonState)) if (file.endsWith(".log")) copyFileSync(join(daemonState, file), join("/out", file));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed (${results.filter((r) => r.ok && r.failures.length).length} on retry)`);
process.exit(0);
