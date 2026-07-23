import { describe, expect, it, vi } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import { Logger } from "../../src/observability/logger.js";
import type { RpcMessage } from "../../src/protocol/envelopes.js";
import {
  STOCK_SIDE_THREAD_SOURCE,
  StockSideThreads,
} from "../../src/gateway/stockSideThreads.js";

function thread(id: string, threadSource = STOCK_SIDE_THREAD_SOURCE): Thread {
  return {
    id, extra: null, sessionId: id, forkedFromId: "parent", parentThreadId: null,
    preview: "side", ephemeral: false, historyMode: "legacy", modelProvider: "openai",
    createdAt: 1, updatedAt: Math.floor(Date.now() / 1_000), recencyAt: 1,
    status: { type: "idle" }, path: `/rollouts/${id}.jsonl`, cwd: "/repo", cliVersion: "test",
    source: "appServer", threadSource, agentNickname: null, agentRole: null,
    gitInfo: null, name: null, turns: [],
  };
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

    const started = sides.projectMessage("app", {
      method: "thread/started", params: { thread: thread("side") },
    });
    expect(started).toMatchObject({ params: { thread: {
      id: "side", ephemeral: true, path: null, threadSource: "user",
    } } });
    const created = sides.projectMessage("app", {
      id: "create", result: { thread: thread("side"), model: "gpt-5.6-terra", serviceTier: null },
    });
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
    const promoted = sides.projectMessage("app", {
      id: "promote", result: { thread: thread("durable", "user") },
    });
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
});
