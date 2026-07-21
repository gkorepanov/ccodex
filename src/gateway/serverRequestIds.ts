export class ServerRequestIds {
  private nextId = 0;
  private readonly internalToWire = new Map<string, number>();
  private readonly wireToInternal = new Map<number, string>();

  public wireId(internalId: string): number {
    const existing = this.internalToWire.get(internalId);
    if (existing !== undefined) return existing;
    const wireId = ++this.nextId;
    this.internalToWire.set(internalId, wireId);
    this.wireToInternal.set(wireId, internalId);
    return wireId;
  }

  public internalId(wireId: string | number): string | undefined {
    if (typeof wireId === "number") return this.wireToInternal.get(wireId);
    return wireId.startsWith("hyb-claude-request:") ? wireId : undefined;
  }

  public release(internalId: string): void {
    const wireId = this.internalToWire.get(internalId);
    if (wireId === undefined) return;
    this.internalToWire.delete(internalId);
    this.wireToInternal.delete(wireId);
  }
}
