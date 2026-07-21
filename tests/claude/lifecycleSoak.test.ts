import { describe, expect, it } from "vitest";
import { ClaudeService } from "../../src/claude/service.js";
import type { HybridConfig } from "../../src/config/config.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import { MetricsRegistry } from "../../src/observability/metrics.js";
import { MemoryHybridStore } from "../../src/store/memoryStore.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";

const config: HybridConfig = {
  realCodex: "/bin/false",
  claudeBinary: "/bin/false",
  dataDir: "/tmp/ccodex-lifecycle-soak",
  publicSocket: "/tmp/ccodex-lifecycle-soak.sock",
  modelPrefix: "claude:",
  idleTimeoutSeconds: 900,
  modelCacheSeconds: 300,
  logLevel: "error",
  logPrompts: false,
  debugCapture: false,
  debugLogMaxBytes: 1_048_576,
  rpcCapture: false,
  rpcCaptureIncludeContent: false,
  rpcCaptureMaxBytes: 1_048_576,
  modelAliases: {},
};

describe("Claude lifecycle accelerated soak", () => {
  it("completes 250 sequential turns without pending journal entries or runtime leaks", async () => {
    const hub = new SubscriptionHub();
    const store = new MemoryHybridStore();
    const metrics = new MetricsRegistry();
    const service = new ClaudeService(config, hub, new Logger("error"), store, new FakeClaudeQuery().factory, undefined, metrics);
    const started = await service.startThread({ model: "claude:haiku", cwd: process.cwd() });
    let completed = 0;
    hub.subscribe(started.thread.id, "soak", (method) => {
      if (method === "turn/completed") completed += 1;
    });

    for (let index = 0; index < 250; index += 1) {
      const prepared = await service.prepareTurn({
        threadId: started.thread.id,
        input: [{ type: "text", text: `turn ${index}`, text_elements: [] }],
      });
      prepared.announce();
      prepared.start();
      while (completed <= index) await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const turns = service.readThread(started.thread.id, true).thread.turns;
    expect(turns).toHaveLength(250);
    expect(turns.every((turn) => turn.status === "completed")).toBe(true);
    expect(turns.every((turn) => turn.items.filter((item) => item.type === "agentMessage" && item.phase === "final_answer").length === 1)).toBe(true);
    expect(store.listProviderEvents(started.thread.id).every((event) => event.disposition !== "pending" && event.disposition !== "failed")).toBe(true);
    expect(metrics.snapshot()).toMatchObject({
      gauges: { loadedClaudeRuntimes: 1, pendingApprovals: 0 },
      counters: { turnsByTerminalStatus: { completed: 250, failed: 0, interrupted: 0 } },
    });
    await service.close();
    expect(metrics.snapshot()).toMatchObject({ gauges: { loadedClaudeRuntimes: 0, pendingApprovals: 0 } });
  });
});
