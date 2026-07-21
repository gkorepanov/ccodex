export interface ClaudeSessionHandle<Command = unknown> {
  readonly isLoaded?: boolean;
  submit<Result>(command: Command): Promise<Result>;
  close(): Promise<void>;
}

export type ClaudeSessionFactory<
  Command = unknown,
  Session extends ClaudeSessionHandle<Command> = ClaudeSessionHandle<Command>,
> = (threadId: string) => Session | Promise<Session>;

type ActiveEntry<Session> = {
  readonly state: "active";
  readonly session: Promise<Session>;
  resolved?: Session;
};

type RetiringEntry = {
  readonly state: "retiring";
  readonly done: Promise<void>;
};

type RegistryEntry<Session> = ActiveEntry<Session> | RetiringEntry;

export class ClaudeSessionRegistry<
  Command = unknown,
  Session extends ClaudeSessionHandle<Command> = ClaudeSessionHandle<Command>,
> {
  private readonly entries = new Map<string, RegistryEntry<Session>>();
  private readonly childOwners = new Map<string, string>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  public constructor(private readonly factory: ClaudeSessionFactory<Command, Session>) {}

  public ownerOf(threadId: string): string {
    return this.childOwners.get(threadId) ?? threadId;
  }

  public activeOwnerIds(): string[] {
    return [...this.entries]
      .filter((entry): entry is [string, ActiveEntry<Session>] => entry[1].state === "active")
      .map(([threadId]) => threadId);
  }

  public loadedOwnerIds(): string[] {
    return [...this.entries].flatMap(([threadId, entry]) =>
      entry.state === "active" && entry.resolved?.isLoaded ? [threadId] : []);
  }

  public resolvedSession(threadId: string): Session | undefined {
    const entry = this.entries.get(this.ownerOf(threadId));
    return entry?.state === "active" ? entry.resolved : undefined;
  }

  public registerChild(childThreadId: string, ownerThreadId: string): void {
    this.assertOpen();
    const owner = this.ownerOf(ownerThreadId);
    if (childThreadId === owner) throw new Error(`Thread '${childThreadId}' cannot own itself as a child.`);

    const existingOwner = this.childOwners.get(childThreadId);
    if (existingOwner !== undefined) {
      if (existingOwner !== owner) {
        throw new Error(`Thread '${childThreadId}' is already owned by '${existingOwner}'.`);
      }
      return;
    }
    if (this.entries.has(childThreadId)) {
      throw new Error(`Thread '${childThreadId}' already has an independent Claude session.`);
    }
    this.childOwners.set(childThreadId, owner);
  }

  public unregisterChild(childThreadId: string): void {
    this.childOwners.delete(childThreadId);
  }

  public async getOrCreate(threadId: string): Promise<Session> {
    this.assertOpen();
    const owner = this.ownerOf(threadId);

    while (true) {
      this.assertOpen();
      const existing = this.entries.get(owner);
      if (existing?.state === "active") return existing.session;
      if (existing?.state === "retiring") {
        await existing.done;
        continue;
      }

      const entry: ActiveEntry<Session> = {
        state: "active",
        session: Promise.resolve().then(() => this.factory(owner)),
      };
      this.entries.set(owner, entry);
      void entry.session.then((session) => {
        if (this.entries.get(owner) === entry) entry.resolved = session;
      }).catch(() => undefined);
      void entry.session.catch(() => {
        if (this.entries.get(owner) === entry) this.entries.delete(owner);
      });
      return entry.session;
    }
  }

  public async submit<Result>(threadId: string, command: Command): Promise<Result> {
    const session = await this.getOrCreate(threadId);
    return session.submit<Result>(command);
  }

  public retire(threadId: string): Promise<void> {
    return this.retireOwner(this.ownerOf(threadId));
  }

  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = Promise.allSettled(
      [...this.entries.keys()].map((owner) => this.retireOwner(owner)),
    ).then((results) => {
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      this.entries.clear();
      this.childOwners.clear();
      if (errors.length > 0) throw new AggregateError(errors, "Failed to close Claude sessions.");
    });
    return this.closePromise;
  }

  private retireOwner(owner: string): Promise<void> {
    const existing = this.entries.get(owner);
    if (!existing) return Promise.resolve();
    if (existing.state === "retiring") return existing.done;

    const retiring: RetiringEntry = {
      state: "retiring",
      done: existing.session.then((session) => session.close()),
    };
    this.entries.set(owner, retiring);
    const cleanup = () => {
      if (this.entries.get(owner) === retiring) this.entries.delete(owner);
    };
    void retiring.done.then(cleanup, cleanup);
    return retiring.done;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Claude session registry is closed.");
  }
}
