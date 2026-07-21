export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  public constructor(private readonly onPendingChanged: () => void = () => undefined) {}

  public get pendingCount(): number {
    return this.values.length;
  }

  public push(value: T): void {
    if (this.closed) throw new Error("Queue is closed.");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else {
      this.values.push(value);
      this.onPendingChanged();
    }
  }

  public close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          this.onPendingChanged();
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
