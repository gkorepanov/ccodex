import type {
  EffortLevel,
  Options,
  PermissionMode,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../asyncQueue.js";
import { interruptAndCancelOwned, type InterruptCancellation } from "../interruptCompat.js";
import type { ClaudeQueryFactory } from "../queryFactory.js";
import {
  normalizeProviderMessage,
  type ClaudeProviderFact,
} from "./providerFacts.js";

export type ClaudeRuntimeFact = ClaudeProviderFact;

export interface ClaudeRuntimeSettings {
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly effort: EffortLevel | null | undefined;
  readonly fastMode: boolean;
  readonly thinkingDisplay: "summarized" | "omitted" | null;
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
  private readonly capabilities = new Set<string>();
  private readonly ownedMessageIds = new Set<string>();

  public constructor(
    private readonly runtimeGeneration: number,
    options: Options,
    queryFactory: ClaudeQueryFactory,
    private readonly submitFact: (fact: ClaudeRuntimeFact) => Promise<void>,
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
    this.query = queryFactory({
      prompt: this.input,
      options: { ...options, abortController: this.abort },
    });
  }

  public get pendingInputCount(): number {
    return this.input.pendingCount;
  }

  public initializationResult(): ReturnType<Query["initializationResult"]> {
    return Promise.race([
      this.query.initializationResult(),
      this.initializationExit,
    ]) as ReturnType<Query["initializationResult"]>;
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
    return this.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
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
    await this.query.return(undefined).catch(() => undefined);
    await this.consumer?.catch(() => undefined);
  }

  private async consume(): Promise<void> {
    let exitSubmitted = false;
    try {
      for await (const message of this.query) {
        await this.submitFact(normalizeProviderMessage(this.runtimeGeneration, message));
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

  private markExited(error?: unknown): void {
    this.exited = true;
    this.rejectInitializationExit(
      error instanceof Error
        ? error
        : new Error(`Claude runtime generation ${this.runtimeGeneration} exited during initialization.`),
    );
  }
}
