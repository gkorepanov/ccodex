import { describe, expect, it, vi } from "vitest";
import type { ThreadForkResponse } from "../../src/codex/generated/v2/ThreadForkResponse.js";
import { OptimisticSideThreads } from "../../src/gateway/optimisticSideThreads.js";

function response(id = "public-side"): ThreadForkResponse {
  return {
    thread: {
      id, extra: null, sessionId: "parent", forkedFromId: "parent", parentThreadId: null,
      preview: "", ephemeral: true, historyMode: "legacy", modelProvider: "claude",
      createdAt: 1, updatedAt: 1, recencyAt: 1, status: { type: "idle" }, path: null,
      cwd: "/repo", cliVersion: "test", source: "appServer", threadSource: "user",
      agentNickname: null, agentRole: null, gitInfo: null, name: "Side", turns: [],
    },
    model: "claude:sonnet",
    modelProvider: "claude",
    serviceTier: null,
    cwd: "/repo",
    runtimeWorkspaceRoots: ["/repo"],
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    reasoningEffort: "high",
    multiAgentMode: "explicitRequestOnly",
  };
}

describe("optimistic side readiness", () => {
  it("opens immediately and serializes boundary before the first turn", async () => {
    let ready!: (target: { provider: "claude"; backendThreadId: string }) => void;
    const prepare = new Promise<{ provider: "claude"; backendThreadId: string }>((resolve) => { ready = resolve; });
    const sides = new OptimisticSideThreads();
    const opened = sides.open("app", response(), () => prepare, vi.fn(), vi.fn());
    const order: string[] = [];

    const boundary = sides.run(opened.thread.id, async () => {
      order.push("boundary:start");
      await Promise.resolve();
      order.push("boundary:end");
    });
    const turn = sides.run(opened.thread.id, async () => {
      order.push("turn");
    });

    expect(opened.thread).toMatchObject({ id: "public-side", ephemeral: true, turns: [] });
    expect(sides.phase(opened.thread.id)).toBe("preparing");
    expect(order).toEqual([]);
    ready({ provider: "claude", backendThreadId: "backend-side" });
    await Promise.all([boundary, turn]);
    expect(order).toEqual(["boundary:start", "boundary:end", "turn"]);
    expect(sides.target(opened.thread.id)).toEqual({
      provider: "claude",
      backendThreadId: "backend-side",
    });
    sides.close();
  });

  it("keeps preparation alive across disconnect and cancels cleanup on reconnect", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn(async () => undefined);
    const sides = new OptimisticSideThreads(1_000);
    sides.open("first", response(), async () => ({
      provider: "claude", backendThreadId: "backend-side",
    }), cleanup, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    sides.detachConnection("first");
    await vi.advanceTimersByTimeAsync(500);
    sides.attach("public-side", "second");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cleanup).not.toHaveBeenCalled();
    expect(sides.phase("public-side")).toBe("ready");
    sides.close();
    vi.useRealTimers();
  });

  it("cleans a backend that appears after delete and reports preparation failure once", async () => {
    let ready!: (target: { provider: "stock"; backendThreadId: string }) => void;
    const prepare = new Promise<{ provider: "stock"; backendThreadId: string }>((resolve) => { ready = resolve; });
    const cleanup = vi.fn(async () => undefined);
    const failed = vi.fn();
    const sides = new OptimisticSideThreads();
    sides.open("app", response(), () => prepare, cleanup, failed);
    await sides.delete("public-side");
    ready({ provider: "stock", backendThreadId: "backend-side" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleanup).toHaveBeenCalledWith({ provider: "stock", backendThreadId: "backend-side" });
    expect(sides.owns("public-side")).toBe(false);

    sides.open("app", response("failed-side"), async () => {
      throw new Error("provider fork exploded");
    }, cleanup, failed);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failed).toHaveBeenCalledWith("failed-side", expect.objectContaining({
      message: "provider fork exploded",
    }));
    expect(sides.claimFailure("failed-side")?.message).toBe("provider fork exploded");
    expect(sides.claimFailure("failed-side")).toBeUndefined();
    sides.close();
  });
});
