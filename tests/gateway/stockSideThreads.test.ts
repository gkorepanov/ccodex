import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import { Logger } from "../../src/observability/logger.js";
import type { RpcMessage } from "../../src/protocol/envelopes.js";
import {
  STOCK_SIDE_THREAD_SOURCE,
  StockSideThreads,
} from "../../src/gateway/stockSideThreads.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";

function thread(id: string, threadSource: string | null = STOCK_SIDE_THREAD_SOURCE): Thread {
  return {
    id, extra: null, sessionId: id, forkedFromId: "parent", parentThreadId: null,
    preview: "side", ephemeral: false, historyMode: "legacy", modelProvider: "openai",
    createdAt: 1, updatedAt: Math.floor(Date.now() / 1_000), recencyAt: 1,
    status: { type: "idle" }, path: `/rollouts/${id}.jsonl`, cwd: "/repo", cliVersion: "test",
    source: "appServer", threadSource, agentNickname: null, agentRole: null,
    gitInfo: null, name: null, turns: [],
  };
}

function forwarded(projection: ReturnType<StockSideThreads["projectMessage"]>): RpcMessage {
  expect(projection.kind).toBe("forward");
  return (projection as { kind: "forward"; message: RpcMessage }).message;
}

describe("stock side-chat promotion", () => {
  it("projects a hidden native rollout as ephemeral and promotes it with an ordinary stock fork", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const cleanupStock = { request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      return method === "thread/list" ? { data: [], nextCursor: null } : {};
    } };
    const sides = new StockSideThreads(true, cleanupStock as never, new Logger("error"), 10);
    const create = await sides.prepareRequest("app", {
      id: "create", method: "thread/fork", params: {
        threadId: "parent", ephemeral: true, excludeTurns: true, threadSource: "user",
      },
    }, cleanupStock as never) as Extract<RpcMessage, { id: unknown; method: string }>;
    expect(create.params).toMatchObject({
      threadId: "parent", ephemeral: false, excludeTurns: true,
      threadSource: STOCK_SIDE_THREAD_SOURCE,
    });

    const started = forwarded(sides.projectMessage("app", {
      method: "thread/started", params: { thread: thread("side") },
    }));
    expect(started).toMatchObject({ params: { thread: {
      id: "side", ephemeral: true, path: null, threadSource: "user",
    } } });
    const created = forwarded(sides.projectMessage("app", {
      id: "create", result: { thread: thread("side"), model: "gpt-5.6-terra", serviceTier: null },
    }));
    expect(created).toMatchObject({ result: { thread: {
      id: "side", ephemeral: true, path: null, threadSource: "user",
    } } });

    const promote = await sides.prepareRequest("app", {
      id: "promote", method: "thread/fork", params: {
        threadId: "side", path: null, cwd: "/repo", threadSource: "user",
      },
    }, cleanupStock as never) as Extract<RpcMessage, { id: unknown; method: string }>;
    expect(promote.params).toMatchObject({
      threadId: "side", ephemeral: false, threadSource: "user",
    });
    const promoted = forwarded(sides.projectMessage("app", {
      id: "promote", result: { thread: thread("durable", "user") },
    }));
    expect(promoted).toMatchObject({ result: { thread: {
      id: "durable", ephemeral: false, threadSource: "user",
    } } });
    expect(sides.filterThreads([thread("side"), thread("durable", "user")]).map((item) => item.id))
      .toEqual(["durable"]);
    sides.close();
  });

  it("projects a logical source id through the hidden native side rollout", async () => {
    const native = thread("side");
    native.forkedFromId = "stock-backend";
    const stock = {
      request: vi.fn(async () => ({
        thread: native,
        model: "gpt-5.6-terra",
        modelProvider: "openai",
        serviceTier: null,
      })),
    };
    const sides = new StockSideThreads(true, stock as never, new Logger("error"));

    const result = await sides.forkSide("app", {
      threadId: "stock-backend",
      ephemeral: true,
      excludeTurns: true,
      threadSource: "user",
    }, "public-thread", stock as never);

    expect(stock.request).toHaveBeenCalledWith("thread/fork", expect.objectContaining({
      threadId: "stock-backend",
      ephemeral: false,
      threadSource: STOCK_SIDE_THREAD_SOURCE,
    }));
    expect(result.thread).toMatchObject({
      id: "side",
      forkedFromId: "public-thread",
      ephemeral: true,
      path: null,
      threadSource: "user",
    });
    sides.close();
  });

  it("binds an optimistic public id and suppresses the later provider thread/started", async () => {
    const native = thread("native-side");
    native.forkedFromId = "stock-backend";
    const stock = {
      request: vi.fn(async () => ({
        thread: native,
        model: "gpt-5.6-terra",
        modelProvider: "openai",
        serviceTier: null,
      })),
      respond: vi.fn(async () => undefined),
    };
    const sides = new StockSideThreads(true, stock as never, new Logger("error"));

    const prepared = await sides.prepareOptimisticSide({
      threadId: "stock-backend",
      ephemeral: true,
      excludeTurns: true,
      threadSource: "user",
    }, "public-parent", "public-side");

    expect(prepared).toMatchObject({
      backendThreadId: "native-side",
      response: { thread: {
        id: "public-side",
        forkedFromId: "public-parent",
        ephemeral: true,
      } },
    });
    expect(sides.projectMessage("daemon", {
      method: "thread/started",
      params: { thread: native },
    }, false)).toEqual({ kind: "drop" });
    expect(forwarded(sides.projectMessage("daemon", {
      method: "turn/started",
      params: { threadId: "native-side", turn: { id: "turn" } },
    }, false))).toMatchObject({
      params: { threadId: "public-side" },
    });

    const hub = new SubscriptionHub();
    let approvalId = "";
    hub.subscribe("public-side", "app", vi.fn(), (id) => { approvalId = id; });
    expect(sides.captureDaemonMessage({
      id: "provider-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "native-side", turnId: "turn", itemId: "item" },
    }, hub)).toBe(true);
    expect(approvalId).toMatch(/^optimistic-stock:/);
    await sides.resolveServerRequest(approvalId, { decision: "accept" });
    expect(stock.respond).toHaveBeenCalledWith("provider-approval", { decision: "accept" });
    const resolved = vi.fn();
    hub.subscribe("public-side", "app", resolved);
    expect(sides.captureDaemonMessage({
      method: "serverRequest/resolved",
      params: {
        threadId: "native-side",
        requestId: "provider-approval",
        decision: "accept",
      },
    }, hub)).toBe(true);
    expect(resolved).toHaveBeenCalledWith("serverRequest/resolved", {
      threadId: "public-side",
      requestId: approvalId,
      decision: "accept",
    });
    sides.close();
  });

  it("deletes an abandoned hidden rollout after the disconnect grace", async () => {
    vi.useFakeTimers();
    const deleted: string[] = [];
    const stock = { request: async (method: string, params: unknown) => {
      if (method === "thread/delete") deleted.push((params as { threadId: string }).threadId);
      return method === "thread/list" ? { data: [], nextCursor: null } : {};
    } };
    const sides = new StockSideThreads(true, stock as never, new Logger("error"), 1_000);
    sides.projectMessage("app", { method: "thread/started", params: { thread: thread("side") } });
    sides.detachConnection("app");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deleted).toEqual(["side"]);
    sides.close();
    vi.useRealTimers();
  });

  it("starts the cleanup grace after a successful promotion", async () => {
    vi.useFakeTimers();
    const deleted: string[] = [];
    const stock = { request: async (method: string, params: unknown) => {
      if (method === "thread/delete") deleted.push((params as { threadId: string }).threadId);
      return method === "thread/list" ? { data: [], nextCursor: null } : {};
    } };
    const sides = new StockSideThreads(true, stock as never, new Logger("error"), 1_000);
    sides.projectMessage("app", { method: "thread/started", params: { thread: thread("side") } });
    await sides.prepareRequest("app", {
      id: "promote", method: "thread/fork", params: { threadId: "side", threadSource: "user" },
    }, stock as never);
    sides.projectMessage("app", {
      id: "promote", result: { thread: thread("durable", "user") },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deleted).toEqual(["side"]);
    sides.close();
    vi.useRealTimers();
  });

  it("recovers a hidden rollout when stock thread/list drops its custom threadSource", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ccodex-side-recovery-"));
    try {
      const hidden = thread("hidden", null);
      hidden.path = join(directory, "hidden.jsonl");
      await writeFile(hidden.path, `${JSON.stringify({
        type: "session_meta",
        payload: { id: hidden.id, thread_source: STOCK_SIDE_THREAD_SOURCE },
      })}\n`);
      const visible = thread("visible", "user");
      const stock = { request: vi.fn(async (method: string) =>
        method === "thread/list"
          ? { data: [hidden, visible], nextCursor: null }
          : {}) };
      const sides = new StockSideThreads(true, stock as never, new Logger("error"));

      await sides.recover();

      expect(sides.filterThreads([hidden, visible]).map((item) => item.id)).toEqual(["visible"]);
      sides.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
