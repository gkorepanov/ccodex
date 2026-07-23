import { describe, expect, it, vi } from "vitest";
import type { Query, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { Logger } from "../../src/observability/logger.js";
import {
  ClaudeRateLimitCoordinator,
  ClaudeUsageSchemaError,
  mapClaudeUsage,
  providerResetSeconds,
  rateLimitNotifications,
  unavailableClaudeRateLimits,
} from "../../src/claude/rateLimits.js";
import { usageSamples } from "../fixtures/protocolSamples.js";
import { formatCCodexStatus, isClaudeStatusCommand } from "../../src/claude/statusCommand.js";

function usage(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    session: {
      total_cost_usd: 1,
      total_api_duration_ms: 2,
      total_duration_ms: 3,
      total_lines_added: 4,
      total_lines_removed: 5,
      model_usage: {},
    },
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: {
        utilization: 12.5, resets_at: "2026-07-17T01:02:03.999Z",
        limit_dollars: null, used_dollars: null, remaining_dollars: null,
      },
      seven_day: { utilization: 34, resets_at: "2026-07-20T00:00:00Z" },
      seven_day_opus: { utilization: 101, resets_at: "2026-07-21T00:00:00Z" },
      seven_day_sonnet: { utilization: -4, resets_at: null },
      seven_day_oauth_apps: { utilization: null, resets_at: null },
      model_scoped: [{ display_name: "Fable 5", utilization: 44, resets_at: "2026-07-22T00:00:00Z" }],
      extra_usage: null,
    },
    ...overrides,
  };
}

function source(read: () => Promise<unknown>) {
  return {
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: read,
  } as unknown as Pick<Query, "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET">;
}

describe("Claude rate-limit wire mapping", () => {
  it("freezes the authenticated control API's 0..100 utilization units", () => {
    const mapped = mapClaudeUsage(usageSamples.stable);
    expect(mapped.rateLimits.primary?.usedPercent).toBe(16);
    expect(mapped.rateLimits.secondary?.usedPercent).toBe(11);
    expect(mapped.rateLimitsByLimitId["claude-model-fable"]?.primary?.usedPercent).toBe(18);
  });

  it("accepts Claude Code 2.1.209 additive envelopes while preserving known windows", () => {
    const mapped = mapClaudeUsage(usageSamples.additive);
    expect(mapped.rateLimits).toMatchObject({
      limitId: "claude",
      limitName: "Claude",
      primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1_784_287_200 },
      secondary: { usedPercent: 11, windowDurationMins: 10_080, resetsAt: 1_784_430_000 },
    });
    expect(mapped.rateLimitsByLimitId["claude-model-fable"]).toMatchObject({
      limitId: "claude-model-fable",
      primary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_784_430_000 },
    });
    expect(mapped.rateLimitsByLimitId).not.toHaveProperty("claude-seven-day-cowork");
    expect(mapped.rateLimitsByLimitId).not.toHaveProperty("claude-limits");
    expect(mapped.rateLimits.credits).toBeNull();
  });

  it("maps aggregate and all provider buckets without inventing credits or Max plan semantics", () => {
    const mapped = mapClaudeUsage(usage());
    expect(mapped).toEqual({
      rateLimits: {
        limitId: "claude", limitName: "Claude",
        primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_784_250_123 },
        secondary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: 1_784_505_600 },
        credits: null, individualLimit: null, planType: "unknown", rateLimitReachedType: null,
      },
      rateLimitsByLimitId: {
        claude: {
          limitId: "claude", limitName: "Claude",
          primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_784_250_123 },
          secondary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: 1_784_505_600 },
          credits: null, individualLimit: null, planType: "unknown", rateLimitReachedType: null,
        },
        "claude-seven-day-opus": {
          limitId: "claude-seven-day-opus", limitName: "Claude Opus · 7 day",
          primary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 1_784_592_000 },
          secondary: null, credits: null, individualLimit: null, planType: "unknown", rateLimitReachedType: null,
        },
        "claude-seven-day-sonnet": {
          limitId: "claude-seven-day-sonnet", limitName: "Claude Sonnet · 7 day",
          primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: null },
          secondary: null, credits: null, individualLimit: null, planType: "unknown", rateLimitReachedType: null,
        },
        "claude-oauth-apps": {
          limitId: "claude-oauth-apps", limitName: "Claude OAuth apps · 7 day",
          primary: { usedPercent: null, windowDurationMins: 10_080, resetsAt: null },
          secondary: null, credits: null, individualLimit: null, planType: "unknown", rateLimitReachedType: null,
        },
        "claude-model-fable-5": {
          limitId: "claude-model-fable-5", limitName: "Claude Fable 5 · 7 day",
          primary: { usedPercent: 44, windowDurationMins: 10_080, resetsAt: 1_784_678_400 },
          secondary: null, credits: null, individualLimit: null, planType: "unknown", rateLimitReachedType: null,
        },
      },
      rateLimitResetCredits: null,
    });
  });

  it("keeps null values null and maps exact supported subscription labels only", () => {
    const raw = usage({
      subscription_type: "team",
      rate_limits: { five_hour: { utilization: null, resets_at: null }, seven_day: null },
    });
    expect(mapClaudeUsage(raw).rateLimits).toMatchObject({
      primary: { usedPercent: null, resetsAt: null }, secondary: null, planType: "team",
    });
  });

  it("returns labelled unavailable data without fake zero usage", () => {
    expect(mapClaudeUsage(usage({ rate_limits_available: false, rate_limits: null }))).toEqual(unavailableClaudeRateLimits());
    expect(unavailableClaudeRateLimits().rateLimits).toMatchObject({
      limitId: "claude", limitName: "Claude (unavailable)", primary: null, secondary: null, credits: null,
    });
  });

  it("fails loudly on malformed dates, schema drift, contradictory availability, and slug collisions", () => {
    const malformed = usage();
    (malformed as any).rate_limits.five_hour.resets_at = "Thursdayish";
    expect(() => mapClaudeUsage(malformed)).toThrow(ClaudeUsageSchemaError);
    expect(() => mapClaudeUsage({ ...usage(), rate_limits_available: "yes" })).toThrow("schema mismatch");
    expect(() => mapClaudeUsage({ ...usage(), unexpected_top_level: true })).toThrow("schema mismatch");
    expect(() => mapClaudeUsage(usage({
      rate_limits: {
        ...usage().rate_limits,
        five_hour: { utilization: "5", resets_at: null },
      },
    }))).toThrow("schema mismatch");
    expect(() => mapClaudeUsage(usage({
      rate_limits: {
        ...usage().rate_limits,
        extra_usage: {
          is_enabled: "false", monthly_limit: null, used_credits: null, utilization: null,
        },
      },
    }))).toThrow("schema mismatch");
    expect(() => mapClaudeUsage(usage({ rate_limits: null }))).toThrow("without rate_limits");
    const collision = usage();
    (collision as any).rate_limits.model_scoped = [
      { display_name: "Fable 5", utilization: 1, resets_at: null },
      { display_name: "Fable-5", utilization: 2, resets_at: null },
    ];
    expect(() => mapClaudeUsage(collision)).toThrow("Duplicate Claude model-scoped");
  });

  it("emits only truthful provider-labelled buckets", () => {
    const mapped = mapClaudeUsage(usageSamples.additive);
    const notifications = rateLimitNotifications(mapped);
    expect(notifications.map(({ params }) => params.rateLimits.limitId)).toEqual([
      "claude-model-fable",
      "claude",
    ]);
    expect(notifications.at(-1)?.params.rateLimits).toMatchObject({
      limitId: "claude",
      limitName: "Claude",
      primary: { usedPercent: 5 },
      secondary: { usedPercent: 11 },
    });
    expect(mapped.rateLimits.limitId).toBe("claude");
    expect(rateLimitNotifications(unavailableClaudeRateLimits())).toEqual([{
      method: "account/rateLimits/updated",
      params: { rateLimits: unavailableClaudeRateLimits().rateLimits },
    }]);
  });
});

describe("ClaudeRateLimitCoordinator", () => {
  it("deduplicates concurrent refreshes and honors fresh/stale TTLs", async () => {
    let now = 1_000;
    let release!: (value: unknown) => void;
    const read = vi.fn(() => new Promise<unknown>((resolve) => { release = resolve; }));
    const coordinator = new ClaudeRateLimitCoordinator(new Logger("error"), { ttlMs: 60, staleTtlMs: 120, now: () => now });
    coordinator.register(source(read));
    const first = coordinator.read();
    const concurrent = coordinator.read();
    expect(read).toHaveBeenCalledTimes(1);
    release(usage());
    expect(await first).toEqual(await concurrent);
    now += 59;
    await coordinator.read();
    expect(read).toHaveBeenCalledTimes(1);
    now += 2;
    read.mockRejectedValueOnce(new Error("transport"));
    expect((await coordinator.read()).rateLimits.limitName).toBe("Claude");
    now += 60;
    read.mockRejectedValueOnce(new Error("transport"));
    expect((await coordinator.read()).rateLimits.limitName).toBe("Claude (unavailable)");
  });

  it("merges rolling buckets monotonically and fans out exactly once", async () => {
    let now = 10;
    const coordinator = new ClaudeRateLimitCoordinator(new Logger("error"), { now: () => now });
    const generation = coordinator.register(source(async () => usage()));
    await coordinator.read();
    const listener = vi.fn();
    coordinator.subscribe("desktop", listener);
    const event = (patch: Partial<SDKRateLimitInfo>) => coordinator.mergeEvent(generation, {
      status: "allowed_warning", rateLimitType: "five_hour", utilization: 20, resetsAt: 1_800_000_000_000, ...patch,
    });
    event({});
    expect(listener).toHaveBeenCalledTimes(1);
    expect(coordinator.cached().rateLimits.primary).toEqual({ usedPercent: 20, windowDurationMins: 300, resetsAt: 1_800_000_000 });
    event({ utilization: 19 });
    event({ resetsAt: 1_700_000_000_000, utilization: 80 });
    expect(listener).toHaveBeenCalledTimes(1);
    now += 1;
    event({ status: "rejected", resetsAt: 1_900_000_000_000, utilization: 1 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(coordinator.cached().rateLimits.rateLimitReachedType).toBe("rate_limit_reached");
    event({ status: "allowed", resetsAt: 1_900_000_000_000, utilization: 2 });
    expect(coordinator.cached().rateLimits.rateLimitReachedType).toBeNull();
  });

  it("normalizes provider reset timestamps in seconds or milliseconds exactly once", () => {
    expect(providerResetSeconds(1_785_034_800)).toBe(1_785_034_800);
    expect(providerResetSeconds(1_785_034_800_000)).toBe(1_785_034_800);
    expect(new Date(providerResetSeconds(1_785_034_800)! * 1_000).toISOString())
      .toBe("2026-07-26T03:00:00.000Z");
  });

  it("deduplicates warning and rejection transitions per bucket and reset window", async () => {
    const coordinator = new ClaudeRateLimitCoordinator(new Logger("error"));
    const generation = coordinator.register(source(async () => usage()));
    await coordinator.read();
    const listener = vi.fn();
    coordinator.subscribe("app", listener);
    const event = (
      status: SDKRateLimitInfo["status"],
      rateLimitType: NonNullable<SDKRateLimitInfo["rateLimitType"]>,
      resetsAt: number,
    ) =>
      coordinator.mergeEvent(generation, { status, rateLimitType, utilization: 90, resetsAt });

    event("allowed", "five_hour", 1_785_034_800);
    event("allowed_warning", "five_hour", 1_785_034_800);
    event("allowed_warning", "five_hour", 1_785_034_800);
    event("allowed_warning", "seven_day", 1_785_120_000);
    event("rejected", "seven_day", 1_785_120_000);
    event("rejected", "seven_day", 1_785_120_000);
    event("allowed", "five_hour", 1_785_034_800);
    event("allowed_warning", "five_hour", 1_785_207_600);

    expect(listener.mock.calls.flatMap((call) => call[1] ? [call[1]] : [])).toEqual([
      { bucket: "claude:primary", status: "allowed_warning", resetsAt: 1_785_034_800 },
      { bucket: "claude:secondary", status: "allowed_warning", resetsAt: 1_785_120_000 },
      { bucket: "claude:secondary", status: "rejected", resetsAt: 1_785_120_000 },
      { bucket: "claude:primary", status: "allowed_warning", resetsAt: 1_785_207_600 },
    ]);
  });

  it("does not replay an unchanged transition after an App reconnect", async () => {
    const coordinator = new ClaudeRateLimitCoordinator(new Logger("error"));
    const generation = coordinator.register(source(async () => usage()));
    await coordinator.read();
    const desktop = vi.fn();
    coordinator.subscribe("desktop", desktop);
    coordinator.mergeEvent(generation, {
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 90,
      resetsAt: 1_785_034_800,
    });
    expect(desktop.mock.calls.flatMap((call) => call[1] ? [call[1]] : [])).toHaveLength(1);

    coordinator.unsubscribe("desktop");
    const mobile = vi.fn();
    coordinator.subscribe("mobile", mobile);
    coordinator.mergeEvent(generation, {
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 90,
      resetsAt: 1_785_034_800,
    });

    expect(mobile).not.toHaveBeenCalled();
    expect(coordinator.cached().rateLimits.primary).toMatchObject({
      usedPercent: 90,
      resetsAt: 1_785_034_800,
    });
  });

  it("does not mistake a partial rolling event for a complete account snapshot", async () => {
    const read = vi.fn(async () => usage());
    const coordinator = new ClaudeRateLimitCoordinator(new Logger("error"));
    const generation = coordinator.register(source(read));
    coordinator.mergeEvent(generation, {
      status: "allowed", rateLimitType: "five_hour", utilization: 7, resetsAt: 1_800_000_000_000,
    });
    coordinator.mergeEvent(generation, {
      status: "allowed", rateLimitType: "seven_day", utilization: 8, resetsAt: 1_900_000_000_000,
    });
    expect(coordinator.cached().rateLimits.primary?.usedPercent).toBe(7);
    expect(rateLimitNotifications(coordinator.cached()).map(({ params }) => params.rateLimits.limitId)).toEqual(["claude"]);
    const complete = await coordinator.read();
    expect(complete.rateLimits.primary?.usedPercent).toBe(12.5);
    expect(rateLimitNotifications(complete).at(-1)?.params.rateLimits.limitId).toBe("claude");
    expect(read).toHaveBeenCalledOnce();
  });

  it("fences unloaded runtime events and refresh results", async () => {
    let release!: (value: unknown) => void;
    const coordinator = new ClaudeRateLimitCoordinator(new Logger("error"));
    const generation = coordinator.register(source(() => new Promise((resolve) => { release = resolve; })));
    const pending = coordinator.read();
    coordinator.unregister(generation);
    release(usage());
    expect((await pending).rateLimits.limitName).toBe("Claude (unavailable)");
    const listener = vi.fn();
    coordinator.subscribe("mobile", listener);
    coordinator.mergeEvent(generation, { status: "allowed", rateLimitType: "five_hour", utilization: 50 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("invalidates on auth/account change and treats experimental schema mismatch as unavailable immediately", async () => {
    const coordinator = new ClaudeRateLimitCoordinator(new Logger("error"));
    coordinator.register(source(async () => usage()));
    await coordinator.read();
    coordinator.invalidate("logout");
    expect(coordinator.cached().rateLimits.limitName).toBe("Claude (unavailable)");
    coordinator.register(source(async () => ({ ...usage(), rate_limits_available: 1 })));
    expect((await coordinator.read()).rateLimits.limitName).toBe("Claude (unavailable)");
  });

  it("uses only the control call and never submits a prompt", async () => {
    const read = vi.fn(async () => usage());
    const coordinator = new ClaudeRateLimitCoordinator(new Logger("error"));
    coordinator.register(source(read));
    await coordinator.read();
    expect(read).toHaveBeenCalledOnce();
  });

  it("reports the precise reason when account usage cannot be read", async () => {
    const coordinator = new ClaudeRateLimitCoordinator(new Logger("error"));
    expect((await coordinator.readStatus()).unavailableReason).toBe("No authenticated Claude runtime is loaded.");
    coordinator.register(source(async () => usage({ rate_limits_available: false, rate_limits: null })));
    expect((await coordinator.readStatus()).unavailableReason).toBe(
      "Claude reports that rate-limit data is unavailable for this account.",
    );
  });
});

describe("CCodex status command", () => {
  it("matches only exact trimmed commands", () => {
    const input = (text: string) => [{ type: "text" as const, text, text_elements: [] }];
    expect(isClaudeStatusCommand(input(" /CCSTATUS "))).toBe(true);
    expect(isClaudeStatusCommand(input("  cCoDeX StAtUs\n"))).toBe(true);
    expect(isClaudeStatusCommand(input(" /CCODEX-STATUS "))).toBe(true);
    expect(isClaudeStatusCommand(input("please show CCodex status"))).toBe(false);
    expect(isClaudeStatusCommand(input("CCodex  status"))).toBe(false);
    expect(isClaudeStatusCommand([...input("CCodex status"), { type: "image" as const, url: "data:image/png;base64,x" }])).toBe(false);
  });

  it("renders both providers with branded avatars and concise local reset times", () => {
    const rateLimits = mapClaudeUsage(usage());
    const now = new Date(2026, 6, 19, 10);
    rateLimits.rateLimits.primary!.resetsAt = Math.floor(new Date(2026, 6, 19, 12, 10).getTime() / 1_000);
    expect(formatCCodexStatus({
      claude: { availability: { state: "ready" }, usage: { rateLimits, unavailableReason: null } },
      codex: {
        availability: { state: "ready" },
        rateLimits: {
          rateLimits: {
            limitId: "codex", limitName: null,
            primary: {
              usedPercent: 12, windowDurationMins: 300,
              resetsAt: Math.floor(new Date(2026, 6, 19, 14, 30).getTime() / 1_000),
            },
            secondary: null, credits: null, individualLimit: null, planType: "pro", rateLimitReachedType: null,
          },
          rateLimitsByLimitId: null,
          rateLimitResetCredits: null,
        },
      },
    }, now)).toBe([
      "◆ **CCodex** │ status",
      "",
      "❋ **Claude** · ✅ ready",
      "  ├ 5h ▸ 12.5% used · resets 12:10",
      "  ├ 7d ▸ 34% used · resets Jul 20",
      "  ├ Fable 5 7d ▸ 44% used · resets Jul 22",
      "  ├ OAuth apps 7d ▸ usage unavailable · reset unavailable",
      "  ├ Opus 7d ▸ 100% used · resets Jul 21",
      "  └ Sonnet 7d ▸ 0% used · reset unavailable",
      "",
      "֎ **Codex** · ✅ ready",
      "  └ 5h ▸ 12% used · resets 14:30",
    ].join("\n"));
  });

  it("renders actionable provider availability without fabricating usage", () => {
    expect(formatCCodexStatus({
      claude: {
        availability: { state: "ready" },
        usage: {
          rateLimits: unavailableClaudeRateLimits(),
          unavailableReason: "Claude usage endpoint is unavailable.",
        },
      },
      codex: {
        availability: { state: "notAuthenticated", action: "codex auth login" },
      },
    })).toBe([
      "◆ **CCodex** │ status",
      "",
      "❋ **Claude** · ✅ ready",
      "  └ limits unavailable · Claude usage endpoint is unavailable.",
      "",
      "֎ **Codex** · ⚠️ not authenticated",
      "  ↳ `codex auth login`",
    ].join("\n"));
  });
});
