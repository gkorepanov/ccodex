import { describe, expect, it } from "vitest";
import type { Turn } from "../../../src/codex/generated/v2/Turn.js";
import type { InternalGoal } from "../../../src/store/HybridStore.js";
import { bindGoalTurn, finishGoalTurn, newGoalState, type GoalContext } from "../../../src/claude/session/goalState.js";

function harness() {
  let goal: InternalGoal = {
    goalId: "g1", threadId: "t", objective: "ship", status: "active", tokenBudget: null,
    tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
  };
  const published: string[] = [];
  const repository = {
    goal: () => goal,
    setGoal: (_threadId: string, patch: { status?: InternalGoal["status"] }) => (goal = { ...goal, ...patch }),
    accountGoalUsage: () => undefined,
    read: () => ({ thread: { parentThreadId: null, ephemeral: false } }),
  };
  const context = {
    threadId: "t", repository, turnId: undefined, active: false, quiescent: true, planMode: false, eligible: true,
    runtimeGeneration: 1, updatePreview: () => undefined, publish: (_turn: string | null, method: string, params: unknown) => {
      published.push(`${method}:${(params as { goal: InternalGoal }).goal.status}`);
    }, emit: () => undefined,
  } as unknown as GoalContext;
  return { context, published, status: () => goal.status };
}

const command = (id: string, status: "completed" | "failed") => ({
  type: "commandExecution", id, command: "x", cwd: "/", status, source: "agent",
} as unknown as Turn["items"][number]);
const turn = (id: string, items: Turn["items"]): Turn => ({
  id, items, itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1,
});

describe("goal execution breaker", () => {
  it("blocks the goal after three goal turns whose only tool activity failed", () => {
    const { context, published, status } = harness();
    const state = newGoalState();
    const run = (id: string, items: Turn["items"]) => {
      bindGoalTurn(state, context, id);
      finishGoalTurn(state, context, turn(id, items));
    };
    run("1", [command("c1", "failed")]);
    run("2", [command("c2", "failed"), command("c3", "completed")]); // a successful tool resets the breaker
    run("3", [command("c4", "failed")]);
    run("4", []); // tool-free turns neither count nor reset
    run("5", [command("c5", "failed")]);
    expect(status()).toBe("active");
    run("6", [command("c6", "failed")]);
    expect(status()).toBe("blocked");
    expect(published).toEqual(["thread/goal/updated:blocked"]);
  });
});
