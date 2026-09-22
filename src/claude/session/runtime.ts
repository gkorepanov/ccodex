import type {
  EffortLevel,
  Options,
  PermissionMode,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { AsyncQueue } from "../asyncQueue.js";
import { interruptAndCancelOwned, type InterruptCancellation } from "../interruptCompat.js";
import type { ClaudeQueryFactory } from "../queryFactory.js";
import {
  normalizeProviderMessage,
  type ClaudeProviderFact,
} from "./providerFacts.js";

export type ClaudeRuntimeFact = ClaudeProviderFact;

/** Longest stretch a buffered SDK batch may hold the event loop before socket reads get a turn. */
export const EVENT_LOOP_YIELD_BUDGET_MS = 20;

export interface ClaudeRuntimeSettings {
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly effort: EffortLevel | null | undefined;
  readonly fastMode: boolean;
  readonly thinkingDisplay: "summarized" | "omitted" | null;
}

export class ClaudeRuntimeStartupError extends Error {
  public constructor(
    message: string,
    public readonly retryableEarlyExit: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClaudeRuntimeStartupError";
  }
}

export function isRetryableClaudeRuntimeStartupError(error: unknown): boolean {
  return error instanceof ClaudeRuntimeStartupError && error.retryableEarlyExit;
}

export class ClaudeRuntime {
  private readonly input: AsyncQueue<SDKUserMessage>;
  private readonly abort = new AbortController();
  private readonly query: Query;
  private readonly initializationExit: Promise<never>;
  private rejectInitializationExit!: (error: Error) => void;
  private consumer: Promise<void> | undefined;
  private closed = false;
  private closing = false;
  private exited = false;
  private awaitingNext = false;
  private readonly capabilities = new Set<string>();
  private readonly ownedMessageIds = new Set<string>();
  private stderrTail = "";
  private providerOutputSeen = false;

  public constructor(
    private readonly runtimeGeneration: number,
    options: Options,
    queryFactory: ClaudeQueryFactory,
    private readonly submitFact: (fact: ClaudeRuntimeFact) => Promise<void>,
    private readonly disposeResources: () => void = () => undefined,
  ) {
    this.initializationExit = new Promise<never>((_resolve, reject) => {
      this.rejectInitializationExit = reject;
    });
    void this.initializationExit.catch(() => undefined);
    this.input = new AsyncQueue(() => {
      void this.submitFact({
        kind: "inputPending",
        runtimeGeneration: this.runtimeGeneration,
        pendingInputs: this.input.pendingCount,
      });
    });
    const stderr = options.stderr;
    this.query = queryFactory({
      prompt: this.input,
      options: {
        ...options,
        abortController: this.abort,
        stderr: (line) => {
          this.stderrTail = `${this.stderrTail}${line}`.slice(-8_192);
          stderr?.(line);
        },
      },
    });
  }

  public get pendingInputCount(): number {
    return this.input.pendingCount;
  }

  public initializationResult(): ReturnType<Query["initializationResult"]> {
    return Promise.race([
      this.query.initializationResult(),
      this.initializationExit,
    ]).catch((error) => Promise.reject(this.initializationFailure(error))) as ReturnType<Query["initializationResult"]>;
  }

  public initializationFailure(error: unknown): ClaudeRuntimeStartupError {
    if (error instanceof ClaudeRuntimeStartupError) return error;
    const cause = error instanceof Error ? error : new Error(String(error));
    const stderr = this.stderrTail.trim();
    const message = stderr ? `${cause.message}\nClaude stderr: ${stderr}` : cause.message;
    return new ClaudeRuntimeStartupError(
      message,
      !this.providerOutputSeen && /Query closed before response received|exited during initialization|became unavailable during initialization/iu.test(cause.message),
      { cause },
    );
  }

  public start(): void {
    if (this.consumer) return;
    this.consumer = this.consume();
  }

  public get hasExited(): boolean {
    return this.exited;
  }

  public beginClose(): boolean {
    if (this.closing) return false;
    this.closing = true;
    return true;
  }

  public send(message: SDKUserMessage): void {
    this.input.push(message);
  }

  public ownMessage(messageUuid: string): void {
    this.ownedMessageIds.add(messageUuid);
  }

  public releaseMessage(messageUuid: string): void {
    this.ownedMessageIds.delete(messageUuid);
  }

  public setCapabilities(capabilities: readonly string[]): void {
    this.capabilities.clear();
    for (const capability of capabilities) this.capabilities.add(capability);
  }

  public reinitialize(): ReturnType<Query["reinitialize"]> {
    return this.query.reinitialize();
  }

  public async applySettings(settings: ClaudeRuntimeSettings): Promise<void> {
    await this.query.setModel(settings.model);
    await this.query.applyFlagSettings({
      ...(settings.effort === undefined ? {} : { effortLevel: settings.effort }),
      fastMode: settings.fastMode,
    });
    await this.query.setMaxThinkingTokens(null, settings.thinkingDisplay);
    await this.query.setPermissionMode(settings.permissionMode);
  }

  public stopTask(taskId: string): Promise<void> {
    return this.query.stopTask(taskId);
  }

  public getContextUsage(): ReturnType<Query["getContextUsage"]> {
    return this.query.getContextUsage();
  }

  public usageSnapshot(): ReturnType<Query["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]> {
    return this.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  }

  public interruptOwned(
    ownedMessageIds: ReadonlySet<string> = this.ownedMessageIds,
  ): Promise<InterruptCancellation> {
    return interruptAndCancelOwned(this.query, ownedMessageIds, this.capabilities);
  }

  public async close(): Promise<void> {
    if (this.closed) {
      await this.consumer?.catch(() => undefined);
      return;
    }
    this.closed = true;
    this.input.close();
    this.abort.abort();
    this.disposeResources();
    await this.query.return(undefined).catch(() => undefined);
    await this.consumer?.catch(() => undefined);
  }

  private async consume(): Promise<void> {
    let exitSubmitted = false;
    try {
      // A buffered SDK batch resolves through microtasks only, so the poll
      // phase never runs and every stock/App socket stays unread until the
      // batch drains. Hop a macrotask once a batch has held the loop for the
      // budget; hopping after every message would widen the window in which
      // an SDK callback (canUseTool) outruns its preceding message.
      const iterator = this.query[Symbol.asyncIterator]();
      let loopHeldSince = performance.now();
      for (;;) {
        const waitedFrom = performance.now();
        this.awaitingNext = true;
        const next = await iterator.next();
        this.awaitingNext = false;
        if (next.done) break;
        // A next() that had to wait means the loop ran other work meanwhile;
        // only an instantly resolved (buffered) message accrues held time.
        if (performance.now() - waitedFrom >= 1) loopHeldSince = performance.now();
        this.providerOutputSeen = true;
        try {
          await this.submitFact(normalizeProviderMessage(this.runtimeGeneration, next.value));
        } catch (error) {
          await iterator.return?.(undefined).catch(() => undefined);
          throw error;
        }
        if (performance.now() - loopHeldSince >= EVENT_LOOP_YIELD_BUDGET_MS) {
          await yieldToEventLoop();
          loopHeldSince = performance.now();
        }
      }
      this.markExited();
      exitSubmitted = true;
      await this.submitFact({
        kind: "exit",
        runtimeGeneration: this.runtimeGeneration,
      });
    } catch (error) {
      if (exitSubmitted) return;
      this.markExited(error);
      await this.submitFact({
        kind: "exit",
        runtimeGeneration: this.runtimeGeneration,
        error,
      });
    }
  }

  /**
   * Resolves once every SDK message buffered before now has been submitted.
   * SDK callbacks (canUseTool, hooks, elicitation) bypass the message stream;
   * gating them here keeps a callback from outrunning the message that
   * precedes it while the consumer yields the event loop mid-batch.
   */
  public async drained(): Promise<void> {
    do await yieldToEventLoop();
    while (!this.awaitingNext && !this.exited);
  }

  private markExited(error?: unknown): void {
    this.exited = true;
    this.disposeResources();
    this.rejectInitializationExit(this.initializationFailure(
      error ?? new Error(`Claude runtime generation ${this.runtimeGeneration} exited during initialization.`),
    ));
  }
}
