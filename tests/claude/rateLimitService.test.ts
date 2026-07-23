import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeService } from "../../src/claude/service.js";
import type { HybridConfig } from "../../src/config/config.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";

const directories: string[] = [];

function config(dataDir: string): HybridConfig {
  return {
    realCodex: "/bin/false", claudeBinary: "/bin/false", dataDir,
    publicSocket: join(dataDir, "gateway.sock"), modelPrefix: "claude:",
    idleTimeoutSeconds: 900, modelCacheSeconds: 300, logLevel: "error", logPrompts: false,
    debugCapture: false, debugLogMaxBytes: 1_048_576,
  };
}

function usage(utilization = 16): unknown {
  return {
    session: {
      total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0,
      total_lines_added: 0, total_lines_removed: 0, model_usage: {},
    },
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: {
        utilization, resets_at: "2026-07-17T01:00:00Z",
        limit_dollars: null, used_dollars: null, remaining_dollars: null,
      },
      seven_day: { utilization: 11, resets_at: "2026-07-20T01:00:00Z" },
      model_scoped: [{ display_name: "Fable", utilization: 18, resets_at: "2026-07-20T01:00:00Z" }],
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for rate-limit service event.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ClaudeService account rate limits", () => {
  it("reads usage from an authenticated live runtime without submitting a model prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-rate-service-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    fake.experimentalUsage = usage();
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    const result = await service.readRateLimits(started.thread.id);
    expect(result.rateLimits).toMatchObject({
      limitId: "claude", planType: "unknown", primary: { usedPercent: 16 }, secondary: { usedPercent: 11 },
    });
    expect(result.rateLimitsByLimitId["claude-model-fable"]?.primary?.usedPercent).toBe(18);
    expect(fake.experimentalUsageCalls).toBe(1);
    expect(fake.prompts).toHaveLength(0);
    await service.close();
  });

  it("merges runtime rate_limit_event updates and fans them out account-wide", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-rate-event-"));
    directories.push(directory);
    const rateEvent = {
      type: "rate_limit_event", uuid: randomUUID(), session_id: "session",
      rate_limit_info: {
        status: "rejected", rateLimitType: "five_hour", utilization: 22,
        resetsAt: Math.floor(Date.parse("2026-07-18T01:00:00Z") / 1_000),
      },
    } as unknown as SDKMessage;
    const duplicate = { ...rateEvent, uuid: randomUUID() } as unknown as SDKMessage;
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined, undefined, [rateEvent, duplicate],
    );
    fake.experimentalUsage = usage();
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    await service.readRateLimits();
    const listener = vi.fn();
    service.subscribeRateLimits("desktop", listener);
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "short", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(() => listener.mock.calls.length > 0);
    expect(listener.mock.calls.at(-1)?.[0].rateLimits).toMatchObject({
      primary: { usedPercent: 22, resetsAt: 1_784_336_400 }, rateLimitReachedType: "rate_limit_reached",
    });
    expect(listener.mock.calls.flatMap((call) => call[1] ? [call[1]] : [])).toEqual([{
      bucket: "claude:primary",
      status: "rejected",
      resetsAt: 1_784_336_400,
    }]);
    expect(JSON.stringify(service.readThread(started.thread.id, true))).not.toContain("Claude rate limit:");
    await service.close();
  });

  it("restores status on resume after gateway restart without a model turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-rate-restart-"));
    directories.push(directory);
    const database = join(directory, "state.sqlite");
    const initialFake = new FakeClaudeQuery();
    const initial = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(database), initialFake.factory,
    );
    const started = await initial.startThread({ model: "claude:sonnet", cwd: directory });
    await initial.close();

    const resumedFake = new FakeClaudeQuery();
    resumedFake.experimentalUsage = usage(27);
    const resumed = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"), new SqliteHybridStore(database), resumedFake.factory,
    );
    await resumed.resumeThread(started.thread.id);
    expect((await resumed.readRateLimits()).rateLimits.primary?.usedPercent).toBe(27);
    expect(resumedFake.prompts).toHaveLength(0);
    expect(resumedFake.experimentalUsageCalls).toBe(1);
    await resumed.close();
  });

  it("invalidates cached quota on SDK authentication failure without failing the active turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-rate-auth-"));
    directories.push(directory);
    const authFailure = {
      type: "auth_status", uuid: randomUUID(), session_id: "session", isAuthenticating: false,
      output: [], error: "OAuth scope revoked",
    } as unknown as SDKMessage;
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, [authFailure]);
    fake.experimentalUsage = usage();
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    await service.readRateLimits();
    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "short", text_elements: [] }],
    });
    prepared.announce();
    prepared.start();
    await waitFor(() => service.cachedRateLimits().rateLimits.limitName === "Claude (unavailable)");
    await waitFor(() => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed");
    expect(service.cachedRateLimits().rateLimits.primary).toBeNull();
    await service.close();
  });
});
