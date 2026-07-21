type Provider = "stock" | "claude";
type TerminalStatus = "completed" | "failed" | "interrupted";

interface Latency {
  count: number;
  totalMs: number;
  maxMs: number;
}

export class MetricsRegistry {
  private activeConnections = 0;
  private loadedClaudeRuntimes = 0;
  private readonly pending = new Map<string, number>();
  private readonly turns: Record<TerminalStatus, number> = { completed: 0, failed: 0, interrupted: 0 };
  private claudeRuntimeStarts = 0;
  private sdkCliRestarts = 0;
  private modelProbeFailures = 0;
  private eventDeduplications = 0;
  private readonly providerEvents = new Map<string, number>();
  private readonly latency: Record<Provider, Latency> = {
    stock: { count: 0, totalMs: 0, maxMs: 0 },
    claude: { count: 0, totalMs: 0, maxMs: 0 },
  };

  public connectionOpened(): void { this.activeConnections += 1; }
  public connectionClosed(): void { this.activeConnections = Math.max(0, this.activeConnections - 1); }

  public runtimeLoaded(resume: boolean): void {
    this.loadedClaudeRuntimes += 1;
    this.claudeRuntimeStarts += 1;
    if (resume) this.sdkCliRestarts += 1;
  }

  public runtimeUnloaded(): void { this.loadedClaudeRuntimes = Math.max(0, this.loadedClaudeRuntimes - 1); }
  public turnCompleted(status: TerminalStatus): void { this.turns[status] += 1; }
  public modelProbeFailed(): void { this.modelProbeFailures += 1; }
  public eventDeduplicated(): void { this.eventDeduplications += 1; }
  public providerEvent(type: string, disposition: string): void {
    const key = `${type}:${disposition}`;
    this.providerEvents.set(key, (this.providerEvents.get(key) ?? 0) + 1);
  }
  public pendingOpened(id: string, createdAt: number): void { this.pending.set(id, createdAt); }
  public pendingClosed(id: string): void { this.pending.delete(id); }

  public observeLatency(provider: Provider, durationMs: number): void {
    const latency = this.latency[provider];
    latency.count += 1;
    latency.totalMs += durationMs;
    latency.maxMs = Math.max(latency.maxMs, durationMs);
  }

  public snapshot(now = Date.now()): Record<string, unknown> {
    const oldest = this.pending.size > 0 ? Math.min(...this.pending.values()) : undefined;
    const latency = (provider: Provider) => ({
      count: this.latency[provider].count,
      averageMs: this.latency[provider].count === 0 ? 0 : this.latency[provider].totalMs / this.latency[provider].count,
      maxMs: this.latency[provider].maxMs,
    });
    return {
      gauges: {
        activeAppConnections: this.activeConnections,
        loadedClaudeRuntimes: this.loadedClaudeRuntimes,
        pendingApprovals: this.pending.size,
        oldestPendingApprovalAgeMs: oldest === undefined ? 0 : Math.max(0, now - oldest),
      },
      counters: {
        turnsByTerminalStatus: { ...this.turns },
        claudeRuntimeStarts: this.claudeRuntimeStarts,
        sdkCliRestarts: this.sdkCliRestarts,
        modelProbeFailures: this.modelProbeFailures,
        eventDeduplications: this.eventDeduplications,
        providerEventsByTypeAndDisposition: Object.fromEntries(this.providerEvents),
      },
      requestLatency: { stock: latency("stock"), claude: latency("claude") },
    };
  }
}
