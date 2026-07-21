import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import WebSocket from "ws";

const env = (name) => process.env[`CCODEX_${name}`] ?? process.env[`CODEX_HYBRID_${name}`];
const proxyCommand = env("PROXY_COMMAND");
const cwd = env("PROBE_CWD");
const model = process.env.CODEX_HYBRID_TEST_MODEL ?? "claude:haiku";
const serviceTier = process.env.CODEX_HYBRID_TEST_SERVICE_TIER;
const effort = process.env.CODEX_HYBRID_TEST_EFFORT;
const permissions = process.env.CODEX_HYBRID_TEST_PERMISSIONS;
const approvalPolicy = process.env.CODEX_HYBRID_TEST_APPROVAL_POLICY ?? "never";
const sandbox = process.env.CODEX_HYBRID_TEST_SANDBOX ?? "read-only";
const approvalsReviewer = process.env.CODEX_HYBRID_TEST_APPROVALS_REVIEWER;
const prompt = process.env.CODEX_HYBRID_TEST_PROMPT ?? "Reply with exactly SSH_PROXY_OK.";
const expectedText = process.env.CODEX_HYBRID_EXPECT_TEXT ?? "SSH_PROXY_OK";
const expectedCommand = process.env.CODEX_HYBRID_EXPECT_COMMAND === "1";
const rejectedModel = process.env.CODEX_HYBRID_EXPECT_REJECTED_MODEL;
const expectedTurnError = process.env.CODEX_HYBRID_EXPECT_TURN_ERROR;
const resumeThreadId = process.env.CODEX_HYBRID_RESUME_THREAD_ID;
const catalogOnly = env("CATALOG_ONLY") === "1";
const startOnly = process.env.CODEX_HYBRID_START_ONLY === "1";
const expectedProvider = process.env.CODEX_HYBRID_EXPECT_PROVIDER;
if (!proxyCommand) throw new Error("CCODEX_PROXY_COMMAND is required.");
if (!cwd) throw new Error("CCODEX_PROBE_CWD must name a directory on the gateway host.");

const children = new Set();
const sockets = new Set();
const bridge = createServer((socket) => {
  sockets.add(socket);
  const child = spawn(process.env.SHELL ?? "/bin/sh", ["-lc", proxyCommand], { stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let stderr = "";
  child.stderr.on("data", (bytes) => { stderr += bytes.toString(); });
  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
  socket.on("close", () => {
    sockets.delete(socket);
    child.kill("SIGTERM");
  });
  child.on("close", (code) => {
    children.delete(child);
    if (code && stderr) process.stderr.write(stderr);
    socket.destroy();
  });
});
await new Promise((resolve, reject) => {
  bridge.once("error", reject);
  bridge.listen(0, "127.0.0.1", resolve);
});
const address = bridge.address();
if (!address || typeof address === "string") throw new Error("Failed to allocate local proxy bridge.");

const ws = new WebSocket(`ws://127.0.0.1:${address.port}/rpc`, { perMessageDeflate: false });
const pending = new Map();
const notifications = [];
let nextId = 0;
ws.on("message", (data) => {
  const message = JSON.parse(data.toString());
  if (message.id !== undefined && message.method) {
    ws.send(JSON.stringify({ id: message.id, result: { decision: "decline", action: "cancel" } }));
    return;
  }
  const call = pending.get(message.id);
  if (call) {
    pending.delete(message.id);
    message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result);
  } else if (message.method) notifications.push(message);
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Proxy WebSocket handshake timed out.")), 20_000);
  ws.once("open", () => { clearTimeout(timer); resolve(); });
  ws.once("error", (error) => { clearTimeout(timer); reject(error); });
});
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const waitForTerminal = async (threadId, turnId, timeoutMs = 90_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const terminal = notifications.find((message) => message.method === "turn/completed"
      && message.params?.threadId === threadId && message.params?.turn?.id === turnId);
    if (terminal) return terminal.params.turn;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Proxy Claude turn timed out.");
};
let threadId;
let ownsThread = false;
let modelProvider;
let providerNotice;
let errorNotice;
try {
  await rpc("initialize", {
    clientInfo: { name: "ssh-proxy-acceptance", title: "SSH Proxy Acceptance", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  ws.send(JSON.stringify({ method: "initialized", params: {} }));
  const catalog = await rpc("model/list", { limit: 100 });
  assert.ok(catalog.data.some((entry) => entry.id.startsWith("gpt-")), "Stock models are absent through proxy.");
  assert.ok(catalog.data.some((entry) => entry.id.startsWith("claude:")), "Claude models are absent through proxy.");
  if (!catalogOnly) {
    const started = resumeThreadId
      ? await rpc("thread/resume", { threadId: resumeThreadId, excludeTurns: false })
      : await rpc("thread/start", {
          model,
          cwd,
          approvalPolicy,
          sandbox,
          ...(approvalsReviewer ? { approvalsReviewer } : {}),
          ...(serviceTier ? { serviceTier } : {}),
        });
    threadId = started.thread.id;
    ownsThread = !resumeThreadId;
    modelProvider = started.modelProvider;
    if (expectedProvider) assert.equal(modelProvider, expectedProvider);
    if (expectedTurnError) {
      const failed = await rpc("turn/start", {
        threadId,
        model,
        effort: "invalid-probe-effort",
        input: [{ type: "text", text: "must not reach provider", text_elements: [] }],
      });
      errorNotice = await waitForTerminal(threadId, failed.turn.id);
      assert.equal(errorNotice.status, "completed");
      assert.equal(
        errorNotice.items.find((item) => item.type === "agentMessage")?.text,
        `⚠️ CCodex ERROR · ${expectedTurnError}`,
      );
      assert.ok(!notifications.some((message) => message.method === "error" && message.params?.threadId === threadId));
      const read = await rpc("thread/read", { threadId, includeTurns: true });
      assert.ok(!read.thread.turns.some((turn) => turn.id === failed.turn.id), "System error notice became durable.");
    } else if (rejectedModel) {
      const blocked = await rpc("turn/start", {
        threadId,
        model: rejectedModel,
        input: [{ type: "text", text: "must fail", text_elements: [] }],
      });
      providerNotice = await waitForTerminal(threadId, blocked.turn.id);
      assert.equal(providerNotice.status, "completed");
      assert.match(
        providerNotice.items.find((item) => item.type === "agentMessage")?.text ?? "",
        new RegExp(`Provider change to '${rejectedModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' requires Fork`),
      );
      const read = await rpc("thread/read", { threadId, includeTurns: true });
      assert.ok(!read.thread.turns.some((turn) => turn.id === blocked.turn.id), "Provider notice became durable.");
    } else if (!startOnly) {
      const running = await rpc("turn/start", {
        threadId,
        model,
        ...(serviceTier ? { serviceTier } : {}),
        ...(permissions ? { permissions } : {}),
        ...(effort ? { effort } : {}),
        input: [{ type: "text", text: prompt, text_elements: [] }],
      });
      const terminal = await waitForTerminal(threadId, running.turn.id);
      assert.equal(terminal.status, "completed");
      const completedItems = terminal.items.length > 0
        ? terminal.items
        : notifications
            .filter((message) => message.method === "item/completed" && message.params?.turnId === running.turn.id)
            .map((message) => message.params.item);
      assert.equal(completedItems.find((item) => item.type === "agentMessage")?.text.trim(), expectedText);
      if (expectedCommand) {
        assert.ok(completedItems.some((item) => item.type === "commandExecution" && item.status === "completed" && item.exitCode === 0));
      }
      const read = await rpc("thread/read", { threadId, includeTurns: true });
      assert.equal(read.thread.turns.at(-1)?.id, terminal.id);
    }
    if (ownsThread) {
      await rpc("thread/delete", { threadId });
      threadId = undefined;
    }
  }
  process.stdout.write(`${JSON.stringify({
    proxyTransport: true,
    stockModels: catalog.data.filter((entry) => entry.id.startsWith("gpt-")).length,
    claudeModels: catalog.data.filter((entry) => entry.id.startsWith("claude:")).length,
    claudeModelIds: catalog.data.filter((entry) => entry.id.startsWith("claude:")).map((entry) => entry.id),
    ...(catalogOnly ? {} : {
      ...(expectedTurnError
        ? { errorNotice: errorNotice.items.find((item) => item.type === "agentMessage")?.text }
        : rejectedModel
          ? { providerNotice: providerNotice.items.find((item) => item.type === "agentMessage")?.text }
          : startOnly ? {} : { turn: expectedText }),
      model, modelProvider, serviceTier: serviceTier ?? null, approvalPolicy, sandbox,
      approvalsReviewer: approvalsReviewer ?? null, effort: effort ?? null, permissions: permissions ?? null,
    }),
  }, null, 2)}\n`);
} finally {
  if (threadId && ownsThread) await rpc("thread/delete", { threadId }).catch(() => undefined);
  ws.terminate();
  for (const socket of sockets) socket.destroy();
  for (const child of children) child.kill("SIGTERM");
  await new Promise((resolve) => bridge.close(resolve));
}
