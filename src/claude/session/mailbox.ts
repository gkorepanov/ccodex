export const DEFAULT_CLAUDE_MAILBOX_CAPACITY = 512;

export type ClaudeMailboxLane = "control" | "normal" | "provider";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export interface CommandEnvelope<TCommand, TResult = unknown> {
  readonly command: TCommand;
  readonly completion?: Deferred<TResult>;
}

export interface ProviderCoalescing<TCommand> {
  readonly key: string;
  readonly merge: (previous: TCommand, next: TCommand) => TCommand;
}

export interface MailboxEnqueueOptions<TCommand> {
  readonly lane?: ClaudeMailboxLane;
  readonly coalesce?: ProviderCoalescing<TCommand>;
}

export class ClaudeMailboxClosedError extends Error {
  public constructor(message = "Claude mailbox is closed.") {
    super(message);
    this.name = "ClaudeMailboxClosedError";
  }
}

export function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(reason) {
      if (settled) return;
      settled = true;
      rejectPromise(reason);
    },
  };
}

type StoredEnvelope<TCommand> = {
  envelope: CommandEnvelope<TCommand>;
  readonly lane: ClaudeMailboxLane;
  readonly sequence: number;
  readonly coalesce?: ProviderCoalescing<TCommand>;
};

type PendingAdmission<TCommand> = StoredEnvelope<TCommand> & {
  readonly accepted: Array<{
    readonly resolve: () => void;
    readonly reject: (reason: unknown) => void;
  }>;
};

export class ClaudeMailbox<TCommand> implements AsyncIterable<CommandEnvelope<TCommand>> {
  private readonly control: StoredEnvelope<TCommand>[] = [];
  private readonly regular: StoredEnvelope<TCommand>[] = [];
  private readonly pendingControl: PendingAdmission<TCommand>[] = [];
  private readonly pendingRegular: PendingAdmission<TCommand>[] = [];
  private consumer:
    | ((result: IteratorResult<CommandEnvelope<TCommand>>) => void)
    | undefined;
  private consumerAcquired = false;
  private closedError: Error | undefined;
  private sequence = 0;

  public constructor(public readonly capacity = DEFAULT_CLAUDE_MAILBOX_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Claude mailbox capacity must be a positive safe integer.");
    }
  }

  public get size(): number {
    return this.control.length + this.regular.length;
  }

  public get pendingAdmissions(): number {
    return this.pendingControl.length + this.pendingRegular.length;
  }

  public get closed(): boolean {
    return this.closedError !== undefined;
  }

  public enqueue<TResult = unknown>(
    envelope: CommandEnvelope<TCommand, TResult>,
    options: MailboxEnqueueOptions<TCommand> = {},
  ): Promise<void> {
    const completion = envelope.completion as Deferred<unknown> | undefined;
    const stored: StoredEnvelope<TCommand> = {
      envelope: completion ? { command: envelope.command, completion } : { command: envelope.command },
      lane: options.lane ?? "normal",
      sequence: this.sequence++,
      ...(options.coalesce ? { coalesce: options.coalesce } : {}),
    };
    if (stored.coalesce && stored.lane !== "provider") {
      return this.rejectEnvelope(stored, new TypeError("Only provider-lane envelopes may coalesce."));
    }
    if (this.closedError) return this.rejectEnvelope(stored, this.closedError);
    const coalesced = this.tryCoalesce(stored);
    if (coalesced) return coalesced;
    if (this.consumer && this.size === 0) {
      const consumer = this.consumer;
      this.consumer = undefined;
      consumer({ value: stored.envelope, done: false });
      return Promise.resolve();
    }
    if (this.size < this.capacity) {
      this.push(stored);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const pending = { ...stored, accepted: [{ resolve, reject }] };
      (stored.lane === "control" ? this.pendingControl : this.pendingRegular).push(pending);
    });
  }

  public submit<TResult>(
    command: TCommand,
    options: MailboxEnqueueOptions<TCommand> = {},
  ): Promise<TResult> {
    const completion = createDeferred<TResult>();
    void this.enqueue({ command, completion }, options).catch((error: unknown) => completion.reject(error));
    return completion.promise;
  }

  public close(error: Error = new ClaudeMailboxClosedError()): void {
    if (this.closedError) return;
    this.closedError = error;
    this.rejectPending(error);
    if (this.size === 0) this.finishConsumer();
  }

  public [Symbol.asyncIterator](): AsyncIterator<CommandEnvelope<TCommand>> {
    if (this.consumerAcquired) throw new Error("Claude mailbox supports exactly one consumer.");
    this.consumerAcquired = true;
    return {
      next: () => this.next(),
      return: () => {
        this.cancel(new ClaudeMailboxClosedError("Claude mailbox consumer stopped."));
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  private next(): Promise<IteratorResult<CommandEnvelope<TCommand>>> {
    const stored = this.shift();
    if (stored) {
      this.admitPending();
      return Promise.resolve({ value: stored.envelope, done: false });
    }
    if (this.closedError) return Promise.resolve({ value: undefined, done: true });
    if (this.consumer) throw new Error("Claude mailbox consumer called next() concurrently.");
    return new Promise((resolve) => {
      this.consumer = resolve;
    });
  }

  private push(stored: StoredEnvelope<TCommand>): void {
    (stored.lane === "control" ? this.control : this.regular).push(stored);
  }

  private shift(): StoredEnvelope<TCommand> | undefined {
    return this.control.shift() ?? this.regular.shift();
  }

  private admitPending(): void {
    while (!this.closedError && this.size < this.capacity) {
      const pending = this.pendingControl.shift() ?? this.pendingRegular.shift();
      if (!pending) return;
      this.push(pending);
      for (const waiter of pending.accepted) waiter.resolve();
    }
  }

  private tryCoalesce(incoming: StoredEnvelope<TCommand>): Promise<void> | undefined {
    if (!incoming.coalesce || incoming.envelope.completion) return undefined;
    const pending = this.pendingRegular.at(-1);
    const target = pending ?? this.regular.at(-1);
    if (!target?.coalesce || target.envelope.completion) return undefined;
    if (target.lane !== "provider" || target.coalesce.key !== incoming.coalesce.key) return undefined;
    const command = incoming.coalesce.merge(target.envelope.command, incoming.envelope.command);
    target.envelope = { command };
    if (pending) {
      return new Promise<void>((resolve, reject) => pending.accepted.push({ resolve, reject }));
    }
    return Promise.resolve();
  }

  private rejectEnvelope(stored: StoredEnvelope<TCommand>, error: unknown): Promise<never> {
    stored.envelope.completion?.reject(error);
    return Promise.reject(error);
  }

  private rejectPending(error: unknown): void {
    for (const pending of [...this.pendingControl.splice(0), ...this.pendingRegular.splice(0)]) {
      pending.envelope.completion?.reject(error);
      for (const waiter of pending.accepted) waiter.reject(error);
    }
  }

  private finishConsumer(): void {
    if (!this.consumer) return;
    const consumer = this.consumer;
    this.consumer = undefined;
    consumer({ value: undefined, done: true });
  }

  private cancel(error: Error): void {
    if (!this.closedError) this.closedError = error;
    this.rejectPending(this.closedError);
    for (const stored of [...this.control.splice(0), ...this.regular.splice(0)]) {
      stored.envelope.completion?.reject(this.closedError);
    }
    this.finishConsumer();
  }
}
