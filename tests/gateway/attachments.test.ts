import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, fakeQuery, fakeStartup } from "../fixtures/fakeClaude.js";
import { Meta } from "../../src/meta.js";
import { Attachments } from "../../src/gateway/attachments.js";
import { Gateway } from "../../src/gateway/server.js";
import type { Connection } from "../../src/gateway/connection.js";
import { Logger } from "../../src/log.js";
import { NativeSessionCatalog } from "../../src/claude/native/catalog.js";
import { startTestGateway, type TestGateway } from "./harness.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({ ...await original<object>(), query: fakeQuery, startup: fakeStartup }));
// Fake SDK sessions have no real command processes to sample on the host.
vi.mock("../../src/claude/processes.js", async (original) => ({ ...await original<object>(), sessionProcesses: () => [] }));
vi.spyOn(NativeSessionCatalog.prototype, "watch").mockReturnValue(() => {});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const claudeHome = process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ct-attachments-"));
const codexHome = process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "ct-codex-"));
let gateway: TestGateway;
beforeEach(async () => {
  fakeClaude.reset();
  gateway = await startTestGateway({ claudeVisualize: false });
  // Await the gateway's asynchronous virtual skill write before fast tests remove its directory.
  await (await gateway.connect()).request("skills/list", { cwds: [gateway.root] });
});
afterEach(async () => { await gateway?.stop(); });
afterAll(() => { for (const path of [claudeHome, codexHome]) rmSync(path, { recursive: true, force: true }); });
const identity = { attachmentType: "worktree", identityKey: "/work/isolated" };

describe("native attachments on Claude chats", () => {
  it("registers a worktree once, persists it, and removes it with native notifications", async () => {
    const client = await gateway.connect();
    const observer = await gateway.connect();
    const { thread } = await client.request("thread/start", { model: "claude:claude-opus-5-5", cwd: gateway.root });
    const params = { threadId: thread.id, ...identity, payload: { root: identity.identityKey } };
    const added = await client.request("thread/attachment/add", params);
    expect(added).toMatchObject({ outcome: "created", attachment: { ...identity, payload: { root: "/work/isolated" } } });
    expect(await client.request("thread/attachment/add", { ...params, payload: { root: "/different" } })).toEqual({ outcome: "existing", attachment: added.attachment });
    expect(await client.request("thread/attachment/list", { threadId: thread.id })).toEqual({ data: [added.attachment], nextCursor: null });
    const saved = new Meta(join(gateway.config.dataDir, "meta.json"));
    expect(saved.threadAttachments[thread.id]).toEqual([added.attachment]);
    await observer.waitFor("thread/attachment/updated", p => p.threadId === thread.id && p.operation === "created");
    expect(observer.notifications("thread/attachment/updated")).toHaveLength(1);
    await client.request("thread/attachment/remove", params);
    await client.request("thread/attachment/remove", params);
    expect(await client.request("thread/attachment/list", { threadId: thread.id })).toEqual({ data: [], nextCursor: null });
    await observer.waitFor("thread/attachment/updated", p => p.operation === "deleted");
    expect(observer.notifications("thread/attachment/updated")).toHaveLength(2);
  });

  it("finds Claude and GPT owners together, including archived empty chats", async () => {
    const client = await gateway.connect();
    const { thread: claude } = await client.request("thread/start", { model: "claude:claude-opus-5-5", cwd: gateway.root });
    const { thread: gpt } = await client.request("thread/start", { model: "gpt-6-luna", cwd: gateway.root });
    for (const threadId of [claude.id, gpt.id]) await client.request("thread/attachment/add", { threadId, ...identity, payload: null });
    const first = await client.request("thread/attachmentOwner/list", { ...identity, limit: 1 });
    const second = await client.request("thread/attachmentOwner/list", { ...identity, limit: 1, cursor: first.nextCursor });
    expect([...first.data, ...second.data].map(x => x.threadId).sort()).toEqual([claude.id, gpt.id].sort());
    expect(second.nextCursor).toBeNull();
    await client.request("thread/archive", { threadId: claude.id });
    expect(await client.request("thread/attachmentOwner/list", { ...identity, archived: false })).toEqual({ data: [{ threadId: gpt.id, archived: false }], nextCursor: null });
    expect(await client.request("thread/attachmentOwner/list", { ...identity, archived: true })).toEqual({ data: [{ threadId: claude.id, archived: true }], nextCursor: null });
  });

  it.each(["claude:claude-opus-5-5", "gpt-6-luna"])("keeps attachments on the public chat across a %s provider switch", async model => {
    const client = await gateway.connect();
    const { thread } = await client.request("thread/start", { model, cwd: gateway.root });
    await client.turn(thread.id, "first");
    const added = await client.request("thread/attachment/add", { threadId: thread.id, ...identity, payload: null });
    await client.turn(thread.id, "switch", { model: model.startsWith("claude:") ? "gpt-6-luna" : "claude:claude-opus-5-5" });
    expect(await client.request("thread/attachment/list", { threadId: thread.id })).toEqual({ data: [added.attachment], nextCursor: null });
    expect(await client.request("thread/attachmentOwner/list", identity)).toEqual({ data: [{ threadId: thread.id, archived: false }], nextCursor: null });
    await client.request("thread/attachment/remove", { threadId: thread.id, ...identity });
    expect(await client.request("thread/attachmentOwner/list", identity)).toEqual({ data: [], nextCursor: null });
  });

  it("paginates by attachment identity and rejects invalid writes and cursors", async () => {
    const client = await gateway.connect();
    const { thread } = await client.request("thread/start", { model: "claude:claude-opus-5-5", cwd: gateway.root });
    for (const attachmentType of ["worktree", "archived_worktree"]) await client.request("thread/attachment/add", { threadId: thread.id, ...identity, attachmentType, payload: null });
    const first = await client.request("thread/attachment/list", { threadId: thread.id, limit: 1 });
    const second = await client.request("thread/attachment/list", { threadId: thread.id, limit: 1, cursor: first.nextCursor });
    expect([...first.data, ...second.data].map(x => x.attachmentType).sort()).toEqual(["archived_worktree", "worktree"]);
    await expect(client.request("thread/attachment/add", { threadId: thread.id, ...identity, identityKey: "", payload: null })).rejects.toMatchObject({ code: -32602 });
    await expect(client.request("thread/attachment/list", { threadId: thread.id, cursor: "broken" })).rejects.toMatchObject({ code: -32602 });
    await client.request("thread/delete", { threadId: thread.id });
    expect(await client.request("thread/attachmentOwner/list", identity)).toEqual({ data: [], nextCursor: null });
  });

  it("keeps a worktree registered before an empty GPT chat switches to Claude", async () => {
    const client = await gateway.connect();
    const { thread } = await client.request("thread/start", { model: "gpt-6-luna", cwd: gateway.root });
    const added = await client.request("thread/attachment/add", { threadId: thread.id, ...identity, payload: null });
    await client.turn(thread.id, "first on Claude", { model: "claude:claude-opus-5-5" });
    expect(await client.request("thread/attachment/list", { threadId: thread.id })).toEqual({ data: [added.attachment], nextCursor: null });
    await client.request("thread/archive", { threadId: thread.id });
    expect(await client.request("thread/attachmentOwner/list", { ...identity, archived: true })).toEqual({ data: [{ threadId: thread.id, archived: true }], nextCursor: null });
    await client.request("thread/attachment/remove", { threadId: thread.id, ...identity });
    expect(await client.request("thread/attachmentOwner/list", identity)).toEqual({ data: [], nextCursor: null });
  });

  it("keeps migrated Meta attachments after an expired Claude row becomes a GPT row", async () => {
    const client = await gateway.connect();
    const { thread } = await client.request("thread/start", { model: "gpt-6-luna", cwd: gateway.root });
    const core = new Gateway(gateway.config, gateway.config.publicSocket, new Logger("error"));
    core.claude = { owns: () => false } as unknown as Gateway["claude"];
    const connection = { upstream: { request: (method: string, params: unknown) => client.request(method, params) } } as unknown as Connection;
    const attachments = new Attachments(core);
    const meta = core.meta;
    meta.setThreadAttachments("expired", [{ id: "saved", ...identity, payload: null, createdAt: 1 }]);
    meta.setLineage("expired", [{ provider: "claude", threadId: "expired", lastTurnId: "old" }, { provider: "codex", threadId: thread.id, lastTurnId: null }]);
    meta.prune(segment => segment.threadId !== "expired");
    await client.request("thread/archive", { threadId: thread.id });
    expect(await attachments.handle(connection, "thread/attachmentOwner/list", { ...identity, archived: true })).toEqual({ data: [{ threadId: thread.id, archived: true }], nextCursor: null });
    expect(await attachments.handle(connection, "thread/attachment/list", { threadId: thread.id })).toMatchObject({ data: [{ ...identity, payload: null }] });
    await attachments.handle(connection, "thread/attachment/remove", { threadId: thread.id, ...identity });
    expect(await attachments.handle(connection, "thread/attachmentOwner/list", identity)).toEqual({ data: [], nextCursor: null });
  });

  it("preserves concurrent Claude registrations while native discovery is pending", async () => {
    const core = new Gateway(gateway.config, gateway.config.publicSocket, new Logger("error"));
    core.claude = { owns: () => true } as unknown as Gateway["claude"];
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const connection = { upstream: { request: async () => { await pending; return { data: [], nextCursor: null }; } } } as unknown as Connection;
    const attachments = new Attachments(core);
    const add = (identityKey: string) => attachments.handle(connection, "thread/attachment/add", { threadId: "owner", ...identity, identityKey, payload: null });
    const first = add("first");
    const second = add("second");
    release();
    await Promise.all([first, second]);
    expect(core.meta.threadAttachments.owner?.map(a => a.identityKey).sort()).toEqual(["first", "second"]);
  });

  it.each(["remove", "clear"])("finishes one shared migration before concurrent %s can delete native ownership", async action => {
    const core = new Gateway(gateway.config, gateway.config.publicSocket, new Logger("error"));
    core.claude = { owns: () => false } as unknown as Gateway["claude"];
    core.meta.setThreadAttachments("owner", ["first", "second"].map(identityKey => ({ id: identityKey, ...identity, identityKey, payload: null, createdAt: 1 })));
    const native = new Map<string, object>();
    let started!: () => void, release!: () => void, additions = 0;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const connection = { upstream: { request: async (method: string, params: Record<string, any>) => {
      if (method === "thread/attachment/add") {
        if (params.identityKey === "first" && ++additions === 1) { started(); await pending; }
        native.set(params.identityKey, params);
        return {};
      }
      if (method === "thread/attachment/remove") { native.delete(params.identityKey); return {}; }
      if (method === "thread/attachment/list") return { data: [...native.values()], nextCursor: null };
      return { data: [], nextCursor: null };
    } } } as unknown as Connection;
    const attachments = new Attachments(core);
    const reading = attachments.handle(connection, "thread/attachmentOwner/list", { ...identity, identityKey: "second" });
    await ready;
    const removing = action === "clear" ? attachments.clear(connection, "owner")
      : attachments.handle(connection, "thread/attachment/remove", { threadId: "owner", ...identity, identityKey: "second" });
    await new Promise(resolve => setImmediate(resolve));
    release();
    await Promise.all([reading, removing]);
    expect([...native.keys()]).toEqual(action === "clear" ? [] : ["first"]);
  });
});
