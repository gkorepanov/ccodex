import type { ThreadForkResponse } from "../codex/generated/v2/ThreadForkResponse.js";

export const OPTIMISTIC_SIDE_GRACE_MS = 60 * 60_000;

export interface OptimisticSideTarget {
  readonly provider: "claude" | "stock";
  readonly backendThreadId: string;
}

interface State {
  readonly response: ThreadForkResponse;
  readonly connections: Set<string>;
  readonly cleanup: (target: OptimisticSideTarget) => Promise<void>;
  readonly ready: Promise<OptimisticSideTarget>;
  readonly resolve: (target: OptimisticSideTarget) => void;
  readonly reject: (error: Error) => void;
  tail: Promise<void>;
  target?: OptimisticSideTarget;
  failure?: Error;
  failureReported: boolean;
  deleted: boolean;
  timer?: NodeJS.Timeout;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export class OptimisticSideThreads {
  private readonly states = new Map<string, State>();

  public constructor(private readonly graceMs = OPTIMISTIC_SIDE_GRACE_MS) {}

  public open(
    connectionId: string,
    response: ThreadForkResponse,
    prepare: () => Promise<OptimisticSideTarget>,
    cleanup: (target: OptimisticSideTarget) => Promise<void>,
    failed: (threadId: string, error: Error) => void,
  ): ThreadForkResponse {
    const ready = deferred<OptimisticSideTarget>();
    const state: State = {
      response,
      connections: new Set([connectionId]),
      cleanup,
      ready: ready.promise,
      resolve: ready.resolve,
      reject: ready.reject,
      tail: Promise.resolve(),
      failureReported: false,
      deleted: false,
    };
    void state.ready.catch(() => undefined);
    this.states.set(response.thread.id, state);
    queueMicrotask(() => {
      void prepare().then(async (target) => {
        if (state.deleted) {
          await cleanup(target).catch(() => undefined);
          this.states.delete(response.thread.id);
          return;
        }
        state.target = target;
        state.resolve(target);
      }, (value: unknown) => {
        const error = value instanceof Error ? value : new Error(String(value));
        state.failure = error;
        state.reject(error);
        if (state.deleted) this.states.delete(response.thread.id);
        else failed(response.thread.id, error);
      });
    });
    return response;
  }

  public owns(threadId: string): boolean {
    return this.states.has(threadId);
  }

  public snapshot(threadId: string): ThreadForkResponse | undefined {
    return this.states.get(threadId)?.response;
  }

  public phase(threadId: string): "preparing" | "ready" | "failed" | undefined {
    const state = this.states.get(threadId);
    if (!state) return undefined;
    if (state.failure) return "failed";
    return state.target ? "ready" : "preparing";
  }

  public target(threadId: string): OptimisticSideTarget | undefined {
    return this.states.get(threadId)?.target;
  }

  public run<T>(
    threadId: string,
    operation: (target: OptimisticSideTarget) => Promise<T>,
  ): Promise<T> {
    const state = this.states.get(threadId);
    if (!state) return Promise.reject(new Error(`Unknown optimistic side thread '${threadId}'.`));
    const result = state.tail.then(async () => {
      if (state.failure) throw state.failure;
      return operation(await state.ready);
    });
    state.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  public fail(threadId: string, error: Error): void {
    const state = this.states.get(threadId);
    if (state && !state.failure) state.failure = error;
  }

  public attach(threadId: string, connectionId: string): void {
    const state = this.states.get(threadId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    delete state.timer;
    state.connections.add(connectionId);
  }

  public detach(threadId: string, connectionId: string): void {
    const state = this.states.get(threadId);
    if (!state) return;
    state.connections.delete(connectionId);
    if (state.connections.size === 0) this.scheduleCleanup(threadId, state);
  }

  public detachConnection(connectionId: string): void {
    for (const [threadId, state] of this.states) {
      if (!state.connections.delete(connectionId) || state.connections.size > 0) continue;
      this.scheduleCleanup(threadId, state);
    }
  }

  public async delete(threadId: string): Promise<void> {
    const state = this.states.get(threadId);
    if (!state || state.deleted) return;
    state.deleted = true;
    if (state.timer) clearTimeout(state.timer);
    state.reject(new Error("Optimistic side thread was deleted before preparation completed."));
    if (state.failure) {
      this.states.delete(threadId);
      return;
    }
    if (!state.target) return;
    await state.cleanup(state.target);
    this.states.delete(threadId);
  }

  public forgetPromoted(threadId: string): void {
    const state = this.states.get(threadId);
    if (state?.timer) clearTimeout(state.timer);
    this.states.delete(threadId);
  }

  public claimFailure(threadId: string): Error | undefined {
    const state = this.states.get(threadId);
    if (!state?.failure || state.failureReported) return undefined;
    state.failureReported = true;
    return state.failure;
  }

  public close(): void {
    for (const state of this.states.values()) if (state.timer) clearTimeout(state.timer);
  }

  private scheduleCleanup(threadId: string, state: State): void {
    if (state.timer || state.deleted) return;
    state.timer = setTimeout(() => {
      delete state.timer;
      if (state.connections.size > 0) return;
      void this.delete(threadId);
    }, this.graceMs);
    state.timer.unref();
  }
}
