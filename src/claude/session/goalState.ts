import type { Turn } from "../../codex/generated/v2/Turn.js";
import { v7 as uuidv7 } from "uuid";
import { invalidParams } from "../../protocol/errors.js";
import type { InternalGoal } from "../../store/HybridStore.js";
import {
  BUDGET_LIMIT_TEMPLATE,
  CONTINUATION_TEMPLATE,
  OBJECTIVE_UPDATED_TEMPLATE,
  goalToolResponse,
  publicGoal,
  renderGoal,
  sameGoalVersion,
  validateBudget,
  validateObjective,
} from "../goalTools.js";
import type { GoalEffect, GoalSessionCommand, PreparedGoalMutation } from "./commands.js";
import type { ClaudeSessionRepository } from "./repository.js";

interface GoalTurn {
  turnId: string;
  goalId: string;
  accountingId: string;
  startedAtMs: number;
  flushSequence: number;
}

interface GoalOperation {
  id: string;
  kind: "ensureRuntime" | "continue";
  goalId: string;
  generation?: number;
}

export interface GoalState {
  turn?: GoalTurn;
  operation?: GoalOperation;
  pendingTurns: number;
  pendingNotifications: number;
  pendingSnapshots: Set<string>;
  latestMutation?: string;
  readyGeneration?: number;
}

export const newGoalState = (): GoalState => ({
  pendingTurns: 0, pendingNotifications: 0, pendingSnapshots: new Set(),
});

export interface GoalContext {
  threadId: string;
  repository: ClaudeSessionRepository;
  turnId: string | undefined;
  active: boolean;
  quiescent: boolean;
  planMode: boolean;
  eligible: boolean;
  runtimeGeneration: number | undefined;
  updatePreview(preview: string): void;
  publish(turnId: string | null, method: string, params: unknown, key?: string): void;
  emit(effects?: readonly GoalEffect[]): void;
}

const updated = (context: GoalContext, turnId: string | null, goal: InternalGoal, key?: string) =>
  context.publish(
    turnId,
    "thread/goal/updated",
    { threadId: context.threadId, turnId, goal: publicGoal(goal) },
    key && `goal:${key}`,
  );

function clear(state: GoalState): void {
  delete state.turn;
  delete state.operation;
}

export function invalidateGoalEffect(state: GoalState): void {
  delete state.operation;
}

export function runtimeSettingsChanged(state: GoalState): void {
  delete state.readyGeneration;
  delete state.operation;
}

function invalidateContinuation(state: GoalState): void {
  if (state.operation?.kind === "continue") delete state.operation;
}

function claimGoalOperation(
  state: GoalState,
  expected: { operationId: string; goalId?: string; generation?: number },
  consume = true,
): GoalOperation | undefined {
  const operation = state.operation;
  if (!operation
    || operation.id !== expected.operationId
    || expected.goalId !== undefined && operation.goalId !== expected.goalId
    || expected.generation !== undefined && operation.generation !== expected.generation) return;
  if (consume) delete state.operation;
  return operation;
}

function account(
  state: GoalState,
  context: GoalContext,
  tokenDelta: number,
  checkpoint: string,
  emit = true,
): { before: InternalGoal; goal: InternalGoal } | undefined {
  const active = state.turn;
  if (!active) return;
  const elapsed = Math.max(0, Math.floor((performance.now() - active.startedAtMs) / 1_000));
  if (!elapsed && !tokenDelta) return;
  const key = checkpoint.startsWith("usage:")
    ? checkpoint
    : `time:${active.accountingId}:${checkpoint}:${++active.flushSequence}`;
  const before = context.repository.goal(context.threadId);
  if (!before || before.goalId !== active.goalId) return;
  const goal = context.repository.accountGoalUsage({
    threadId: context.threadId,
    expectedGoalId: active.goalId,
    tokenDelta: Math.max(0, tokenDelta),
    timeDeltaSeconds: elapsed,
    checkpointKey: key,
  });
  if (!goal || goal.goalId !== active.goalId
    || goal.tokensUsed === before.tokensUsed && goal.timeUsedSeconds === before.timeUsedSeconds) return;
  active.startedAtMs += elapsed * 1_000;
  if (emit) updated(context, active.turnId, goal, key);
  return { before, goal };
}

const flush = (state: GoalState, context: GoalContext, checkpoint: string, emit = true) =>
  account(state, context, 0, checkpoint, emit);

export function bindGoalTurn(state: GoalState, context: GoalContext, turnId: string): void {
  state.pendingTurns = Math.max(0, state.pendingTurns - 1);
  const goal = context.repository.goal(context.threadId);
  if (!turnId || !goal || goal.status !== "active" || context.planMode) return;
  state.turn = {
    turnId,
    goalId: goal.goalId,
    accountingId: uuidv7(),
    startedAtMs: performance.now(),
    flushSequence: 0,
  };
  delete state.operation;
}

export function finishGoalTurn(state: GoalState, context: GoalContext, turn: Turn): void {
  const active = state.turn;
  if (!active || active.turnId !== turn.id) return;
  flush(state, context, `terminal:${turn.id}`);
  delete state.turn;
  const goal = context.repository.goal(context.threadId);
  if (!goal || goal.goalId !== active.goalId || goal.status !== "active") return;
  const status = turn.status === "interrupted" ? "paused"
    : turn.error?.codexErrorInfo === "usageLimitExceeded" ? "usageLimited"
      : turn.status === "failed" ? "blocked" : undefined;
  if (status) {
    updated(
      context,
      turn.id,
      context.repository.setGoal(context.threadId, { status }),
      `terminal-status:${turn.id}`,
    );
  }
}

export function goalEffects(state: GoalState, context: GoalContext): GoalEffect[] {
  const goal = context.repository.goal(context.threadId);
  if (
    !goal
    || goal.status !== "active"
    || context.planMode
    || !context.eligible
    || state.pendingNotifications
    || state.pendingSnapshots.size
    || state.pendingTurns
    || state.turn
    || state.operation
  ) return [];
  const generation = context.runtimeGeneration;
  if (generation === undefined) {
    const operation = state.operation = { id: uuidv7(), kind: "ensureRuntime", goalId: goal.goalId };
    return [{ kind: operation.kind, goalId: goal.goalId, operationId: operation.id }];
  }
  if (state.readyGeneration !== generation || !context.quiescent) return [];
  const operation = state.operation = { id: uuidv7(), kind: "continue", goalId: goal.goalId, generation };
  return [{
    kind: operation.kind,
    goalId: goal.goalId,
    operationId: operation.id,
    runtimeGeneration: generation,
    prompt: renderGoal(CONTINUATION_TEMPLATE, goal),
  }];
}

export const runtimeAttached = (state: GoalState, generation: number) => {
  if (state.readyGeneration !== generation) delete state.readyGeneration;
  if (state.operation?.generation !== undefined && state.operation.generation !== generation) delete state.operation;
};
export const runtimeDetached = (state: GoalState, generation: number): boolean => {
  if (state.readyGeneration !== generation && state.operation?.generation !== generation) return false;
  delete state.readyGeneration;
  if (state.operation?.generation === generation) delete state.operation;
  return true;
};

export function consumeGoalContinuation(
  state: GoalState,
  context: GoalContext,
  operationId: string,
  goalId: string,
  generation: number,
): boolean {
  const operation = claimGoalOperation(state, { operationId, goalId, generation });
  if (operation?.kind !== "continue") return false;
  const goal = context.repository.goal(context.threadId);
  if (
    !goal
    || goal.goalId !== goalId
    || goal.status !== "active"
    || context.runtimeGeneration !== generation
    || context.planMode
    || !context.eligible
    || state.pendingTurns
    || state.pendingNotifications
    || state.pendingSnapshots.size
    || !context.quiescent
  ) {
    return false;
  }
  return true;
}

export function dispatchGoal(state: GoalState, context: GoalContext, command: GoalSessionCommand): unknown {
  const record = context.repository.read(context.threadId, false)!;
  if (record.thread.parentThreadId) {
    if (command.kind === "resume") return;
    if (command.kind === "get") return;
    if (["prepareSet", "prepareClear"].includes(command.kind)
      || command.kind.startsWith("tool")) {
      const message = `projected Claude subagent thread does not support goals: ${context.threadId}`;
      if (command.kind.startsWith("tool")) throw new Error(message);
      throw invalidParams(message);
    }
    return command.kind === "admitEffect" ? false : undefined;
  }
  if (record.thread.ephemeral) {
    if (["get", "prepareSet", "prepareClear"].includes(command.kind)
      || command.kind.startsWith("tool")) {
      const message = `ephemeral thread does not support goals: ${context.threadId}`;
      if (command.kind.startsWith("tool")) throw new Error(message);
      throw invalidParams(message);
    }
    return command.kind === "admitEffect" ? false : undefined;
  }
  const repository = context.repository;
  if (command.kind === "get") return repository.goal(context.threadId);
  if (command.kind === "recoverRestart") {
    const goal = repository.goal(context.threadId);
    if (goal?.status === "active") {
      clear(state);
      updated(context, command.turnId, repository.setGoal(context.threadId, { status: "blocked" }),
        `restart-blocked:${command.turnId}`);
    }
    return;
  }
  if (command.kind === "prepareSet") {
    const previous = repository.goal(context.threadId);
    const objective = command.params.objective == null ? undefined : validateObjective(command.params.objective);
    validateBudget(command.params.tokenBudget);
    if (!previous && objective === undefined) {
      throw invalidParams(`cannot update goal for thread ${context.threadId}: no goal exists`);
    }
    flush(state, context, "external-mutation", false);
    invalidateContinuation(state);
    const budget = command.params.tokenBudget === undefined ? previous?.tokenBudget : command.params.tokenBudget;
    let status = command.params.status ?? previous?.status;
    if (previous?.status === "budgetLimited" && command.params.status === undefined
      && (budget === null || budget !== undefined && budget > previous.tokensUsed)) status = "active";
    const goal = repository.setGoal(context.threadId, {
      ...(objective === undefined ? {} : { objective }),
      ...(status === undefined ? {} : { status }),
      ...(command.params.tokenBudget === undefined ? {} : { tokenBudget: command.params.tokenBudget }),
    });
    if (objective !== undefined && !record.thread.preview) context.updatePreview(objective);
    if (goal.status !== "active") clear(state);
    state.pendingNotifications += 1;
    const mutationId = state.latestMutation = uuidv7();
    return {
      kind: "set",
      response: { goal: publicGoal(goal) },
      goal,
      objectiveChanged: objective !== undefined,
      newlyBudgetLimited: previous?.status === "active" && goal.status === "budgetLimited",
      mutationId,
    } satisfies PreparedGoalMutation;
  }
  if (command.kind === "prepareClear") {
    flush(state, context, "clear", false);
    const cleared = repository.clearGoal(context.threadId);
    clear(state);
    if (cleared) state.pendingNotifications += 1;
    const mutationId = state.latestMutation = uuidv7();
    return { kind: "clear", response: { cleared }, mutationId } satisfies PreparedGoalMutation;
  }
  if (command.kind === "finalize") {
    if (command.mutation.kind === "clear" && command.mutation.response.cleared) {
      state.pendingNotifications = Math.max(0, state.pendingNotifications - 1);
      context.publish(null, "thread/goal/cleared", { threadId: context.threadId });
    } else if (command.mutation.kind === "set") {
      updated(context, null, command.mutation.goal);
      state.pendingNotifications = Math.max(0, state.pendingNotifications - 1);
    }
    const latest = command.mutation.mutationId === state.latestMutation;
    if (latest) delete state.latestMutation;
    if (command.mutation.kind === "set" && latest) {
      const goal = repository.goal(context.threadId);
      if (goal && sameGoalVersion(goal, command.mutation.goal)) {
        if (goal.status === "active" && context.active && !state.turn) {
          bindGoalTurn(state, context, context.turnId ?? "");
        }
        if (
          command.mutation.objectiveChanged
          && context.active
          && !context.planMode
          && context.runtimeGeneration !== undefined
        ) {
          context.emit([{
            kind: "steer",
            prompt: renderGoal(OBJECTIVE_UPDATED_TEMPLATE, goal),
            goalId: goal.goalId,
            runtimeGeneration: context.runtimeGeneration,
          }]);
        }
        if (
          command.mutation.newlyBudgetLimited
          && context.active
          && context.runtimeGeneration !== undefined
        ) {
          context.emit([{
            kind: "steer",
            prompt: renderGoal(BUDGET_LIMIT_TEMPLATE, goal),
            goalId: goal.goalId,
            runtimeGeneration: context.runtimeGeneration,
          }]);
        }
      }
    }
    context.emit();
    return;
  }
  if (command.kind === "resume") {
    const goal = repository.goal(context.threadId);
    if (!goal) return;
    const reservationId = uuidv7();
    state.pendingSnapshots.add(reservationId);
    return { reservationId };
  }
  if (command.kind === "resumeSnapshot") {
    if (!state.pendingSnapshots.delete(command.reservationId)) return;
    const goal = repository.goal(context.threadId);
    context.emit();
    return goal
      ? { threadId: context.threadId, turnId: null, goal: publicGoal(goal) }
      : undefined;
  }
  if (command.kind === "reserveTurn") {
    state.pendingTurns += 1;
    delete state.operation;
    return;
  }
  if (command.kind === "cancelTurn") {
    state.pendingTurns = Math.max(0, state.pendingTurns - 1);
    context.emit();
    return;
  }
  if (command.kind === "runtimeReady") {
    if (context.runtimeGeneration === command.runtimeGeneration) {
      state.readyGeneration = command.runtimeGeneration;
      if (state.operation?.kind === "ensureRuntime") delete state.operation;
      context.emit();
    }
    return;
  }
  if (command.kind === "admitEffect") {
    const operation = claimGoalOperation(state, command, false);
    if (!operation) return false;
    const goal = repository.goal(context.threadId);
    if (
      operation.kind !== "ensureRuntime"
      || !goal
      || goal.goalId !== operation.goalId
      || goal.status !== "active"
      || context.planMode
      || !context.eligible
      || state.pendingTurns
      || state.pendingNotifications
      || state.pendingSnapshots.size
      || state.turn
      || !context.quiescent
    ) {
      delete state.operation;
      return false;
    }
    return true;
  }
  if (command.kind === "usage") {
    if (state.turn?.turnId !== command.turnId) return;
    const accounted = account(state, context, command.tokenDelta, `usage:${command.eventId}`);
    if (!accounted) return;
    const { before, goal } = accounted;
    if (before.status === "active" && goal.status === "budgetLimited") {
      const generation = context.runtimeGeneration;
      context.emit([{
        kind: "steer",
        prompt: renderGoal(BUDGET_LIMIT_TEMPLATE, goal),
        goalId: goal.goalId,
        ...(generation === undefined ? {} : { runtimeGeneration: generation }),
      }]);
    }
    return;
  }
  if (command.kind === "toolGet") return goalToolResponse(repository.goal(context.threadId));
  if (command.kind === "toolCreate") {
    const objective = validateObjective(command.objective);
    validateBudget(command.tokenBudget);
    const existing = repository.goal(context.threadId);
    if (existing && existing.status !== "complete") throw new Error(
      "cannot create a new goal because this thread has an unfinished goal; complete the existing goal first");
    const goal = repository.setGoal(context.threadId, {
      objective,
      status: "active",
      tokenBudget: command.tokenBudget ?? null,
      replace: true,
    });
    if (!record.thread.preview) context.updatePreview(objective);
    if (context.active) bindGoalTurn(state, context, context.turnId ?? "");
    updated(context, state.turn?.turnId ?? null, goal, `tool-create:${goal.goalId}`);
    return goalToolResponse(goal);
  }
  if (command.kind === "toolUpdate") {
    if (!repository.goal(context.threadId)) throw new Error("cannot update goal because this thread has no goal");
    const turnId = state.turn?.turnId ?? null;
    flush(state, context, `tool-update:${turnId ?? "none"}`, false);
    const goal = repository.setGoal(context.threadId, { status: command.status });
    clear(state);
    updated(context, turnId, goal, `tool-update:${turnId ?? goal.updatedAt}:${command.status}`);
    return goalToolResponse(goal, command.status === "complete");
  }
  if (command.kind === "detach") {
    flush(state, context, command.checkpoint);
    clear(state);
    return;
  }
  if (command.kind === "effectFailed") {
    const operation = claimGoalOperation(state, command);
    const goal = repository.goal(context.threadId);
    if (
      !operation
      || operation.id !== command.operationId
      || operation.goalId !== command.goalId
      || goal?.goalId !== command.goalId
      || goal.status !== "active"
      || state.turn
      || state.pendingTurns
      || !context.quiescent
    ) return;
    if (command.runtimeGeneration !== undefined && command.runtimeGeneration !== context.runtimeGeneration) return;
    delete state.turn;
    updated(
      context,
      null,
      repository.setGoal(context.threadId, { status: "blocked" }),
      `continuation-failed:${command.goalId}:${command.operationId}`,
    );
  }
}
