import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, fakeQuery, fakeStartup } from "../fixtures/fakeClaude.js";
import { startTestGateway, type TestGateway } from "./harness.js";
import { peerBindings, peerFrame, preparePeerBinding } from "../../src/claude/nativePeer.js";
import { testConfig } from "../fixtures/config.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({ ...await original<object>(), query: fakeQuery, startup: fakeStartup }));
const originalEnv = { ...process.env };
const roots: string[] = [];
let gateway: TestGateway | undefined;
afterEach(async () => { await gateway?.stop(); gateway = undefined; process.env = { ...originalEnv }; for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const text = (value: string) => [{ type: "text" as const, text: value, text_elements: [] }];

async function fixture() {
  fakeClaude.reset();
  const root = mkdtempSync("/tmp/ccx-peer-test-"); roots.push(root);
  const home = join(root, "claude"), product = join(root, "product"), state = join(root, "jobs"), sid = randomUUID();
  const dir = join(home, "projects", "-work");mkdirSync(dir, { recursive: true });mkdirSync(join(home, "sessions"));mkdirSync(product);
  const transcript = join(dir, sid + ".jsonl"), at = new Date().toISOString();
  writeFileSync(transcript, [
    { type: "user", uuid: "initial-user", parentUuid: null, sessionId: sid, timestamp: at, cwd: "/work", message: { role: "user", content: "seed" } },
    { type: "assistant", uuid: "initial-agent", parentUuid: "initial-user", sessionId: sid, timestamp: at, message: { role: "assistant", model: "claude-opus-5-5", id: "msg_initial", content: [{ type: "text", text: "seed ready" }], stop_reason: "end_turn" } },
  ].map((v) => JSON.stringify(v)).join("\n") + "\n");
  writeFileSync(join(home, "sessions", process.pid + ".json"), JSON.stringify({ pid: process.pid, sessionId: sid, version: "2.1.325" }));
  writeFileSync(join(product, "native-peer-bridge.json"), JSON.stringify({ enabled: true, python: process.execPath, script: resolve("tests/fixtures/fakePeerBridge.mjs"), stateDir: state }));
  process.env.CLAUDE_CONFIG_DIR = home;process.env.CODEX_HOME = join(root, "codex");process.env.FAKE_PEER_OWNER_PID = String(process.pid);process.env.FAKE_PEER_TRANSCRIPT = transcript;process.env.FAKE_PEER_SENDS = join(root, "sends.jsonl");
  gateway = await startTestGateway({ claudeHome: home, productHome: product, dataDir: join(root, "data"), claudeVisualize: false });
  const client = await gateway.connect();
  await client.request("thread/resume", { threadId: sid, excludeTurns: true });
  return { root, sid, client, transcript, state };
}

describe("shared native App writer", () => {
  it("uses the existing owner only, returns native reply, and keeps refresh/paging IDs stable", async () => {
    const { root, sid, client } = await fixture();const clientId = randomUUID(), before = fakeClaude.prompts.length;
    const result = await client.request("turn/start", { threadId: sid, clientUserMessageId: clientId, input: text("hello shared") });
    const done = await client.waitFor("turn/completed", (p) => p.threadId === sid && p.turn.id === result.turn.id, 10000);
    expect(done.turn.status).toBe("completed");expect(fakeClaude.prompts.length).toBe(before);
    const history = (await client.request("thread/read", { threadId: sid, includeTurns: true })).thread;
    const turn = history.turns.find((t: any) => t.id === result.turn.id);
    expect(turn.items.filter((i: any) => i.type === "userMessage")).toMatchObject([{ id: result.turn.id, clientId, content: text("hello shared") }]);
    expect(turn.items.some((i: any) => i.type === "agentMessage" && i.text === "app: hello shared")).toBe(true);
    expect(history.turns.filter((t: any) => t.id === result.turn.id)).toHaveLength(1);
    const items = await client.request("thread/items/list", { threadId: sid, turnId: result.turn.id, limit: 100 });expect(items.data.length).toBeGreaterThan(0);
    const beforeRetry = client.messages.length;
    const retried = await client.request("turn/start", { threadId: sid, clientUserMessageId: clientId, input: text("hello shared") });
    await client.waitFor("turn/completed", (p) => p.threadId === sid && p.turn.id === retried.turn.id
      && client.messages.slice(beforeRetry).some((m) => m.method === "turn/completed" && m.params.turn.id === retried.turn.id), 10000);
    expect(readFileSync(join(root, "sends.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(fakeClaude.prompts.length).toBe(before);
    rmSync(join(root, "claude", "sessions", process.pid + ".json"));
    const afterOwnerExit = client.messages.length;
    await client.request("turn/start", { threadId: sid, clientUserMessageId: clientId, input: text("hello shared") });
    await client.waitFor("turn/completed", (p) => p.threadId === sid
      && client.messages.slice(afterOwnerExit).some((m) => m.method === "turn/completed" && m.params.threadId === sid), 10000);
    expect(fakeClaude.prompts.length).toBe(before);
    expect(readFileSync(join(root, "sends.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  }, 20000);

  it("does not stop/steer the original App and rejects unsupported attachments before sending", async () => {
    const { root, sid, client } = await fixture();
    await expect(client.request("thread/settings/update", { threadId: sid, model: "claude:claude-haiku-4-5-20251001" })).rejects.toThrow("no setting was changed");
    await expect(client.request("thread/revert", { threadId: sid, beforeTurnId: "initial-user" })).rejects.toThrow("no App task or history was changed");
    await expect(client.request("thread/compact/start", { threadId: sid })).rejects.toThrow("no App task or history was changed");
    await expect(client.request("turn/start", { threadId: sid, clientUserMessageId: randomUUID(), input: [{ type: "audio", url: "data:audio/wav;base64,fixture" }] })).rejects.toThrow("supports text and images");
    expect(existsSync(join(root, "sends.jsonl"))).toBe(false);
    const clientId = randomUUID();
    await client.request("turn/start", { threadId: sid, clientUserMessageId: clientId, input: text("one") });
    await expect(client.request("turn/start", { threadId: sid, clientUserMessageId: clientId, input: text("different") })).rejects.toThrow("identity conflict");
    await expect(client.request("turn/interrupt", { threadId: sid })).rejects.toThrow("No App task was stopped");
    await expect(client.request("turn/steer", { threadId: sid, input: text("two") })).rejects.toThrow("stable client message");
    const done = await client.waitFor("turn/completed", (p) => p.threadId === sid, 10000);expect(done.turn.status).toBe("completed");
    expect(fakeClaude.calls.some((c) => c.method === "interrupt")).toBe(false);
  }, 20000);

  it("passes same-chat mobile images to the native owner and replays the receipt after an upload expires", async () => {
    const { root, sid, client, state } = await fixture();
    const attachmentDir = join("/tmp/codex-remote-attachments", sid);
    const uploadDir = join(attachmentDir, randomUUID());
    roots.push(attachmentDir);
    mkdirSync(uploadDir, { recursive: true });
    const image = join(uploadDir, "照片 1.jpg");
    const input = [{ type: "localImage" as const, path: image }];
    await expect(client.request("turn/start", { threadId: sid, clientUserMessageId: randomUUID(), input: [{ type: "localImage", path: join(root, "outside.jpg") }] })).rejects.toThrow("uploaded to this chat");
    const outside = join(root, "outside.jpg");
    writeFileSync(outside, "fixture");
    symlinkSync(outside, image);
    const rejected = await client.request("turn/start", { threadId: sid, clientUserMessageId: randomUUID(), input });
    const failed = await client.waitFor("turn/completed", (p) => p.threadId === sid && p.turn.id === rejected.turn.id, 10000);
    expect(failed.turn.error.message).toContain("no message was sent");
    expect(existsSync(join(root, "sends.jsonl"))).toBe(false);
    rmSync(image);
    writeFileSync(image, "fixture");
    const params = { threadId: sid, clientUserMessageId: randomUUID(), input };
    const result = await client.request("turn/start", params);
    const done = await client.waitFor("turn/completed", (p) => p.threadId === sid && p.turn.id === result.turn.id, 10000);
    expect(done.turn.status).toBe("completed");
    const binding = preparePeerBinding(sid, params.clientUserMessageId, input);
    const job = JSON.parse(readFileSync(join(state, `${binding.jobId}.json`), "utf8"));
    expect(job.prompt).toContain(`\n${JSON.stringify(image)}`);
    const turn = (await client.request("thread/read", { threadId: sid, includeTurns: true })).thread.turns.find((item: any) => item.id === result.turn.id);
    expect(turn.items.find((item: any) => item.type === "userMessage").content).toEqual(input);
    rmSync(image);
    const replay = await client.request("turn/start", params);
    expect(replay.turn.id).toBe(result.turn.id);
    expect(readFileSync(join(root, "sends.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(fakeClaude.prompts).toHaveLength(0);
  }, 20000);

  it("stages inline images without persisting base64 or duplicating a native send", async () => {
    const { root, sid, client, state } = await fixture();
    roots.push(join("/tmp/codex-remote-attachments", sid));
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    const clientId = randomUUID();
    const input = [...text("read the inline image"), { type: "image" as const, url: `data:image/png;base64,${png}` }];
    const params = { threadId: sid, clientUserMessageId: clientId, input };
    await expect(client.request("turn/start", { ...params, input: [{ type: "image", url: `data:image/gif;base64,${png}` }] })).rejects.toThrow("image");
    await expect(client.request("turn/start", { ...params, input: [{ type: "image", url: "https://example.invalid/image.png" }] })).rejects.toThrow("image");
    expect(existsSync(join(root, "sends.jsonl"))).toBe(false);
    const { turn } = await client.request("turn/start", params);
    expect((await client.request("turn/start", params)).turn.id).toBe(turn.id);
    const done = await client.waitFor("turn/completed", (p) => p.threadId === sid && p.turn.id === turn.id, 10000);
    expect(done.turn.status).toBe("completed");
    const history = (await client.request("thread/read", { threadId: sid, includeTurns: true })).thread.turns.find((t: any) => t.id === turn.id);
    const bubble = history.items.find((i: any) => i.type === "userMessage");
    const image = bubble.content.find((item: any) => item.type === "localImage");
    expect(image.path).toMatch(new RegExp(`^/tmp/codex-remote-attachments/${sid}/`));
    expect(readFileSync(image.path)).toEqual(Buffer.from(png, "base64"));
    expect(statSync(image.path).mode & 0o777).toBe(0o600);
    const binding = preparePeerBinding(sid, clientId, input);
    const job = readFileSync(join(state, `${binding.jobId}.json`), "utf8");
    expect(job).toContain(image.path);
    expect(job).not.toContain(png);
    expect(readFileSync(join(root, "data", "native-peer-turns.json"), "utf8")).not.toContain(png);
    expect(readFileSync(join(root, "sends.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  }, 20000);

  it("soft-steers the active App turn, deduplicates corrections, and retains their client bubbles", async () => {
    process.env.FAKE_PEER_DELAY = "1200";
    const { root, sid, client, state } = await fixture();
    const firstId = randomUUID(), nextId = randomUUID(), lastId = randomUUID(), queuedId = randomUUID();
    const result = await client.request("turn/start", { threadId: sid, clientUserMessageId: firstId, input: text("one") });
    const deadline = Date.now() + 3000;
    while (!existsSync(join(root, "sends.jsonl")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const correction = { threadId: sid, expectedTurnId: result.turn.id, clientUserMessageId: nextId, input: text("two") };
    expect(await client.request("turn/steer", correction)).toEqual({ turnId: result.turn.id });
    expect(await client.request("turn/steer", correction)).toEqual({ turnId: result.turn.id });
    const extra = await client.request("turn/start", { threadId: sid, clientUserMessageId: lastId, input: text("three") });
    expect(extra.turn.id).toBe(result.turn.id);
    await client.request("thread/queue/add", { threadId: sid, clientUserMessageId: queuedId, input: text("four") });
    expect((await client.request("thread/queue/list", { threadId: sid })).data).toHaveLength(0);
    const done = await client.waitFor("turn/completed", (p) => p.threadId === sid && p.turn.id === result.turn.id, 10000);
    expect(done.turn.status).toBe("completed");
    const turns = (await client.request("thread/read", { threadId: sid, includeTurns: true })).thread.turns;
    const turn = turns.find((t: any) => t.id === result.turn.id);
    expect(turn.items.filter((i: any) => i.type === "userMessage").map((i: any) => i.clientId)).toEqual([firstId, nextId, lastId, queuedId]);
    expect(turn.items.some((i: any) => i.type === "agentMessage" && i.text.includes("two") && i.text.includes("three"))).toBe(true);
    expect(readFileSync(join(root, "sends.jsonl"), "utf8").trim().split("\n")).toHaveLength(4);
    expect(await client.request("turn/steer", correction)).toEqual({ turnId: result.turn.id });
    expect(readFileSync(join(root, "sends.jsonl"), "utf8").trim().split("\n")).toHaveLength(4);
    const paged = await client.request("thread/items/list", { threadId: sid, turnId: result.turn.id, limit: 100 });
    expect(paged.data.filter((v: any) => v.item.type === "userMessage").map((v: any) => v.item.clientId)).toEqual([firstId, nextId, lastId, queuedId]);
    const receipts = readFileSync(join(root, "sends.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(receipts.length).toBe(4);
    expect(fakeClaude.calls.some((c) => c.method === "interrupt" || c.method === "backgroundTasks")).toBe(false);
    expect(fakeClaude.prompts.length).toBe(0);
  }, 20000);

  it("preserves unrelated frames and normal RPC identities; maps inclusive cursors both ways", () => {
    const root = mkdtempSync("/tmp/ccx-peer-map-");roots.push(root);const config = testConfig({ dataDir: root });
    const b = preparePeerBinding(randomUUID(), randomUUID(), text("hi"));b.nativeUuid = randomUUID();peerBindings(config).save(b);
    const plain = '{"id":7,  "result":{"echo":"unchanged"}}';expect(peerFrame(plain, config)).toBe(plain);
    const quotedId = `{ "id": 9, "result": {"text":"literal ${b.nativeUuid}"} }`;
    expect(peerFrame(quotedId, config)).toBe(quotedId);
    const oversized = JSON.stringify({ id: 8, result: { turnId: b.nativeUuid, text: "large".repeat(30) } });
    expect(peerFrame(oversized, { ...config, rpcLimitBytes: 50 })).toBe(oversized);
    const out = JSON.parse(peerFrame(JSON.stringify({ id: b.nativeUuid, result: { data: [{ id: b.nativeUuid, items: [], status: "completed" }], nextCursor: JSON.stringify({ turnId: b.nativeUuid, includeAnchor: true }) } }), config));
    expect(out.id).toBe(b.nativeUuid);expect(out.result.data[0].id).toBe(b.turnId);expect(JSON.parse(out.result.nextCursor).turnId).toBe(b.turnId);
    const incoming = JSON.parse(peerFrame(JSON.stringify({ id: b.turnId, method: "thread/turns/list", params: { threadId: b.threadId, cursor: out.result.nextCursor } }), config, true));
    expect(incoming.id).toBe(b.turnId);expect(JSON.parse(incoming.params.cursor).turnId).toBe(b.nativeUuid);
  });
});
