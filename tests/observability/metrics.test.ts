import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "../../src/observability/metrics.js";

describe("metrics registry", () => {
  it("tracks lifecycle gauges, counters, pending age and provider latency", () => {
    const metrics = new MetricsRegistry();
    metrics.connectionOpened();
    metrics.runtimeLoaded(false);
    metrics.runtimeLoaded(true);
    metrics.runtimeUnloaded();
    metrics.pendingOpened("request", 1_000);
    metrics.turnCompleted("failed");
    metrics.modelProbeFailed();
    metrics.eventDeduplicated();
    metrics.observeLatency("stock", 10);
    metrics.observeLatency("claude", 20);
    expect(metrics.snapshot(1_025)).toMatchObject({
      gauges: { activeAppConnections: 1, loadedClaudeRuntimes: 1, pendingApprovals: 1, oldestPendingApprovalAgeMs: 25 },
      counters: { turnsByTerminalStatus: { completed: 0, failed: 1, interrupted: 0 }, sdkCliRestarts: 1, modelProbeFailures: 1, eventDeduplications: 1 },
      requestLatency: { stock: { count: 1, averageMs: 10 }, claude: { count: 1, averageMs: 20 } },
    });
    metrics.pendingClosed("request");
    metrics.connectionClosed();
    expect(metrics.snapshot()).toMatchObject({ gauges: { activeAppConnections: 0, pendingApprovals: 0 } });
  });
});
