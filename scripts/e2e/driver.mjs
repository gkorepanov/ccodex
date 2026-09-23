// E2E driver (runs inside the container): starts the gateway through the managed `codex` shim, talks to it like
// Desktop over the control socket, and exercises every feature with real models. Results → /out/results.json.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = homedir();
const PACKAGE = join(HOME, ".ccodex", "current", "node_modules", "@gkorepanov", "ccodex");
const require = createRequire(join(PACKAGE, "package.json"));
const WebSocket = require("ws");
const SOCKET = join(HOME, ".codex", "app-server-control", "app-server-control.sock");
const WORK = join(HOME, "work");
const GPT = "gpt-6-luna";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value) => [{ type: "text", text: value, text_elements: [] }];
const itemsOf = (turns) => turns.flatMap((turn) => turn.items.map((item) => item.type === "userMessage"
  ? `user:${item.content?.[0]?.text ?? ""}` : item.type === "agentMessage" ? `agent:${item.text}` : item.type));
const answers = (client, threadId, since = 0) => client.messages.slice(since)
  .filter((m) => m.method === "item/completed" && m.params.threadId === threadId && m.params.item.type === "agentMessage")
  .map((m) => m.params.item.text);

class Client {
  messages = [];
  onRequest = () => ({ decision: "accept" });
  asked = [];
  #next = 0;
  #pending = new Map();

  static async connect(name = "codex_desktop") {
    const socket = new WebSocket("ws://ccodex/rpc", { createConnection: () => createConnection(SOCKET), perMessageDeflate: false });
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

async function daemon(command) {
  const output = execFileSync("codex", ["app-server", "daemon", command], { encoding: "utf8", timeout: 60_000 });
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
    const claude = await client.waitFor("thread/name/updated", (p) => p.threadId === thread.id, 120_000, since);
    const { thread: gpt } = await client.request("thread/start", { model: GPT, cwd: WORK });
    await client.turn(gpt.id, "In one sentence: what is a semaphore?", { model: GPT });
    const stock = await client.waitFor("thread/name/updated", (p) => p.threadId === gpt.id, 120_000, since);
    check(claude.threadName.endsWith("✳️") && !stock.threadName.endsWith("✳️"), "✳️ only on Claude", { claude, stock });
    return { claude: claude.threadName, stock: stock.threadName };
  },

  async switchBothWays() {
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK });
    state.switched = thread.id;
    await client.turn(thread.id, "Remember this secret word: PINEAPPLE. Reply only with OK.");
    const toGpt = await client.turn(thread.id, "What is the secret word I told you? Reply with just the word.", { model: GPT }, 400_000, 2);
    check(toGpt.answers.join(" ").toUpperCase().includes("PINEAPPLE"), "gpt knows the word", toGpt.answers);
    const toClaude = await client.turn(thread.id, "Repeat the secret word once more, just the word.", { model: state.haiku }, 400_000, 2);
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
    const done = await client.turn(side.id, "What is my favorite color? One word.");
    check(done.answers.join(" ").toLowerCase().includes("teal"), "side sees the context", done.answers);
    const main = await client.request("thread/read", { threadId: thread.id, includeTurns: true });
    check(main.thread.turns.length === 1, "side leaves the thread alone", itemsOf(main.thread.turns));
    const stockSide = await client.request("thread/fork", { threadId: state.stock, ephemeral: true, excludeTurns: true, threadSource: "user" });
    const stockDone = await client.turn(stockSide.thread.id, "Reply with the word SIDE-OK.", { model: GPT });
    return { claude: done.answers, stock: stockDone.answers };
  },

  async subagents() {
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK, approvalPolicy: "never", sandbox: "danger-full-access" });
    const done = await client.turn(thread.id, "Use the Agent tool (subagent_type general-purpose) with the prompt 'Reply with the word SUBAGENT-OK'. Then tell me exactly what the subagent replied.", {}, 300_000);
    const children = await client.request("thread/list", { limit: 20, parentThreadId: thread.id, sourceKinds: ["subAgentThreadSpawn"] });
    const { thread: read } = await client.request("thread/read", { threadId: thread.id, includeTurns: true });
    const items = itemsOf(read.turns);
    check(children.data.length > 0, "sub-agent thread listed", { items, answers: done.answers });
    const child = await client.request("thread/read", { threadId: children.data[0].id, includeTurns: true });
    return { children: children.data.map((row) => row.id), items, childItems: itemsOf(child.thread.turns), answers: done.answers };
  },

  async codexMcpStreaming() {
    // codex ≥ 0.154 has no `mcp-server`: CCodex serves the same tools on `codex exec`.
    const config = join(HOME, ".claude.json");
    const current = existsSync(config) ? JSON.parse(readFileSync(config, "utf8")) : {};
    writeFileSync(config, JSON.stringify({ ...current, mcpServers: { codex: { type: "stdio", command: "codex", args: ["mcp-server"] } } }));
    const { thread } = await client.request("thread/start", { model: state.haiku, cwd: WORK, approvalPolicy: "never", sandbox: "danger-full-access" });
    const since = client.messages.length;
    const done = await client.turn(thread.id, `Call the mcp__codex__codex tool with prompt "Reply with the word MCP-OK" and model "${GPT}". Then tell me what it returned.`, {}, 400_000);
    const streamed = client.messages.slice(since).filter((m) => m.method === "item/completed" && m.params.threadId === thread.id)
      .map((m) => m.params.item).filter((item) => item.type === "agentMessage" && /Codex/u.test(item.text)).map((item) => item.text.slice(0, 120));
    const tools = itemsOf((await client.request("thread/read", { threadId: thread.id, includeTurns: true })).thread.turns);
    check(tools.includes("mcpToolCall"), "mcp tool call item", tools);
    check(streamed.length > 0, "codex messages streamed into the thread", { answers: done.answers });
    return { streamed, tools, answers: done.answers };
  },

  async cliSession() {
    const claude = join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json")), "claude");
    const run = spawnSync(claude, ["-p", "Reply with the word CLI-OK", "--model", "haiku"], { cwd: WORK, encoding: "utf8", timeout: 120_000 });
    check(run.status === 0, "claude -p ran", run.stderr);
    await sleep(1500);
    const list = await client.request("thread/list", { limit: 100 });
    const row = list.data.find((thread) => thread.modelProvider === "claude" && thread.preview.includes("CLI-OK"));
    check(row && row.archived === false, "CLI session listed", list.data.map((thread) => thread.preview.slice(0, 40)));
    return { id: row.id, preview: row.preview };
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
};

const wanted = process.argv.slice(2);
const started = await daemon("start");
console.log("daemon:", started.slice(0, 300));
client = await Client.connect();
for (const [name, run] of Object.entries(scenarios)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const at = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true, seconds: Math.round((Date.now() - at) / 1000), detail });
    console.log(`✅ ${name} (${Math.round((Date.now() - at) / 1000)}s)`, JSON.stringify(detail).slice(0, 600));
  } catch (error) {
    results.push({ name, ok: false, seconds: Math.round((Date.now() - at) / 1000), error: error.message, detail: error.detail });
    console.log(`❌ ${name}: ${error.message}`, JSON.stringify(error.detail ?? error.stack).slice(0, 1500));
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
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(0);
