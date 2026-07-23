import type { Query, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Logger } from "../observability/logger.js";

const rateWindowSchema = z.object({
  utilization: z.number().nullable(),
  resets_at: z.string().nullable(),
  // Claude Code 2.1.211 adds these account-billing fields although the
  // Agent SDK 0.3.209 declaration omits them. They are validated but never
  // projected into Codex credits because their billing semantics differ.
  limit_dollars: z.number().nullable().optional(),
  used_dollars: z.number().nullable().optional(),
  remaining_dollars: z.number().nullable().optional(),
}).strict();

const modelWindowSchema = rateWindowSchema.extend({ display_name: z.string().min(1) }).strict();

const rateLimitsSchema = z.object({
  five_hour: rateWindowSchema.nullable().optional(),
  seven_day: rateWindowSchema.nullable().optional(),
  seven_day_oauth_apps: rateWindowSchema.nullable().optional(),
  seven_day_opus: rateWindowSchema.nullable().optional(),
  seven_day_sonnet: rateWindowSchema.nullable().optional(),
  model_scoped: z.array(modelWindowSchema).optional(),
  extra_usage: z.object({
    is_enabled: z.boolean(),
    monthly_limit: z.number().nullable(),
    used_credits: z.number().nullable(),
    utilization: z.number().nullable(),
    currency: z.string().nullable().optional(),
  // Claude Code 2.1.209 added decimal_places, disabled_reason, daily and
  // weekly here. Keep the fields we consume strict while allowing additive
  // billing detail at this exact envelope; none of it has Codex semantics.
  }).passthrough().nullable().optional(),
// Claude's usage endpoint adds experimental/codename windows plus limits,
// spend and dashboard metadata here. Known windows remain strictly validated
// by their schemas above; unknown siblings are deliberately ignored.
}).passthrough();

const usageSchema = z.object({
  session: z.object({
    total_cost_usd: z.number(),
    total_api_duration_ms: z.number(),
    total_duration_ms: z.number(),
    total_lines_added: z.number(),
    total_lines_removed: z.number(),
    model_usage: z.record(z.string(), z.unknown()),
  }).strict(),
  subscription_type: z.string().nullable(),
  rate_limits_available: z.boolean(),
  rate_limits: rateLimitsSchema.nullable(),
  // Claude Code 2.1.209 adds account behavior analytics beside usage. It has no
  // rate-limit semantics, so accept it only at its observed top-level location.
  behaviors: z.unknown().optional(),
  // Sanitized protocol fixtures carry capture provenance beside the raw shape.
  capture: z.object({
    agentSdkVersion: z.string(),
    claudeCodeVersion: z.string(),
    modelPromptsSubmitted: z.number().int().nonnegative(),
    note: z.string(),
  }).strict().optional(),
}).strict();

type Usage = z.infer<typeof usageSchema>;
type UsageWindow = z.infer<typeof rateWindowSchema>;

export interface ClaudeRateLimitWindow {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface ClaudeRateLimitSnapshot {
  limitId: string;
  limitName: string;
  primary: ClaudeRateLimitWindow | null;
  secondary: ClaudeRateLimitWindow | null;
  credits: null;
  individualLimit: null;
  planType: "pro" | "team" | "enterprise" | "unknown";
  rateLimitReachedType: "rate_limit_reached" | null;
}

export interface ClaudeRateLimitsResponse {
  rateLimits: ClaudeRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, ClaudeRateLimitSnapshot>;
  rateLimitResetCredits: null;
}

export class ClaudeUsageSchemaError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ClaudeUsageSchemaError";
  }
}

function percent(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.min(100, value));
}

function resetSeconds(value: string | null): number | null {
  if (value === null) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new ClaudeUsageSchemaError(`Malformed Claude rate-limit reset timestamp '${value}'.`);
  return Math.floor(millis / 1_000);
}

export function providerResetSeconds(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) throw new ClaudeUsageSchemaError(`Malformed Claude rate-limit reset value '${value}'.`);
  return Math.floor(value > 10_000_000_000 ? value / 1_000 : value);
}

function window(value: UsageWindow | null | undefined, duration: number): ClaudeRateLimitWindow | null {
  if (!value) return null;
  return { usedPercent: percent(value.utilization), windowDurationMins: duration, resetsAt: resetSeconds(value.resets_at) };
}

function plan(value: string | null): ClaudeRateLimitSnapshot["planType"] {
  if (value === "pro" || value === "team" || value === "enterprise") return value;
  return "unknown";
}

function slug(value: string): string {
  const normalized = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || "unknown";
}

function snapshot(
  limitId: string,
  limitName: string,
  primary: ClaudeRateLimitWindow | null,
  secondary: ClaudeRateLimitWindow | null,
  planType: ClaudeRateLimitSnapshot["planType"],
): ClaudeRateLimitSnapshot {
  return {
    limitId, limitName, primary, secondary, credits: null, individualLimit: null, planType, rateLimitReachedType: null,
  };
}

export function unavailableClaudeRateLimits(): ClaudeRateLimitsResponse {
  const aggregate = snapshot("claude", "Claude (unavailable)", null, null, "unknown");
  return { rateLimits: aggregate, rateLimitsByLimitId: { claude: aggregate }, rateLimitResetCredits: null };
}

export function mapClaudeUsage(raw: unknown): ClaudeRateLimitsResponse {
  const parsed = usageSchema.safeParse(raw);
  if (!parsed.success) throw new ClaudeUsageSchemaError(`Claude experimental usage schema mismatch: ${z.prettifyError(parsed.error)}`);
  const usage: Usage = parsed.data;
  if (!usage.rate_limits_available) return unavailableClaudeRateLimits();
  if (!usage.rate_limits) throw new ClaudeUsageSchemaError("Claude reported rate_limits_available=true without rate_limits.");
  const mappedPlan = plan(usage.subscription_type);
  const aggregate = snapshot(
    "claude", "Claude", window(usage.rate_limits.five_hour, 300), window(usage.rate_limits.seven_day, 10_080), mappedPlan,
  );
  const buckets: Record<string, ClaudeRateLimitSnapshot> = { claude: aggregate };
  const add = (id: string, name: string, value: UsageWindow | null | undefined) => {
    if (value) buckets[id] = snapshot(id, name, window(value, 10_080), null, mappedPlan);
  };
  add("claude-seven-day-opus", "Claude Opus · 7 day", usage.rate_limits.seven_day_opus);
  add("claude-seven-day-sonnet", "Claude Sonnet · 7 day", usage.rate_limits.seven_day_sonnet);
  add("claude-oauth-apps", "Claude OAuth apps · 7 day", usage.rate_limits.seven_day_oauth_apps);
  for (const value of usage.rate_limits.model_scoped ?? []) {
    const id = `claude-model-${slug(value.display_name)}`;
    if (buckets[id]) throw new ClaudeUsageSchemaError(`Duplicate Claude model-scoped rate-limit id '${id}'.`);
    buckets[id] = snapshot(id, `Claude ${value.display_name} · 7 day`, window(value, 10_080), null, mappedPlan);
  }
  return { rateLimits: aggregate, rateLimitsByLimitId: buckets, rateLimitResetCredits: null };
}

export interface ClaudeUsageSource {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): ReturnType<Query["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]>;
}

interface CacheEntry {
  readonly response: ClaudeRateLimitsResponse;
  readonly fetchedAt: number;
  readonly subscriptionType: string | null;
  readonly complete: boolean;
}

export interface ClaudeRateLimitTransition {
  readonly bucket: string;
  readonly status: "allowed_warning" | "rejected";
  readonly resetsAt: number | null;
}

type Listener = (
  response: ClaudeRateLimitsResponse,
  transition?: ClaudeRateLimitTransition,
) => void;

export interface ClaudeRateLimitCoordinatorOptions {
  readonly ttlMs?: number;
  readonly staleTtlMs?: number;
  readonly now?: () => number;
}

export interface ClaudeRateLimitStatus {
  readonly rateLimits: ClaudeRateLimitsResponse;
  readonly unavailableReason: string | null;
}

function hasRateLimitWindows(response: ClaudeRateLimitsResponse): boolean {
  return Object.values(response.rateLimitsByLimitId)
    .some((bucket) => bucket.primary !== null || bucket.secondary !== null);
}

export class ClaudeRateLimitCoordinator {
  private readonly sources = new Map<number, ClaudeUsageSource>();
  private readonly listeners = new Map<string, Listener>();
  private readonly ttlMs: number;
  private readonly staleTtlMs: number;
  private readonly now: () => number;
  private nextGeneration = 0;
  private cache: CacheEntry | undefined;
  private inFlight: Promise<ClaudeRateLimitsResponse> | undefined;
  private unavailableReason: string | null = "No authenticated Claude runtime is loaded.";
  private readonly notices = new Map<string, ClaudeRateLimitTransition>();

  public constructor(private readonly logger: Logger, options: ClaudeRateLimitCoordinatorOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.staleTtlMs = options.staleTtlMs ?? 120_000;
    this.now = options.now ?? Date.now;
  }

  public register(source: ClaudeUsageSource): number {
    const generation = ++this.nextGeneration;
    this.sources.set(generation, source);
    // A newly authenticated Query may belong to a changed Claude account.
    // Force the next status read through the account-level control surface.
    this.cache = undefined;
    this.inFlight = undefined;
    this.unavailableReason = "Claude usage has not been loaded from the authenticated runtime yet.";
    return generation;
  }

  public unregister(generation: number): void {
    this.sources.delete(generation);
  }

  public subscribe(connectionId: string, listener: Listener): void {
    this.listeners.set(connectionId, listener);
  }

  public get hasLiveSource(): boolean {
    return this.sources.size > 0;
  }

  public unsubscribe(connectionId: string): void {
    this.listeners.delete(connectionId);
  }

  public invalidate(reason: string): void {
    this.nextGeneration += 1;
    this.cache = undefined;
    this.inFlight = undefined;
    this.unavailableReason = `Claude authentication changed (${reason}).`;
    this.notices.clear();
    this.logger.warn("claude.rate-limits.invalidated", { reason });
  }

  public async read(): Promise<ClaudeRateLimitsResponse> {
    const cached = this.cache;
    if (cached?.complete && this.now() - cached.fetchedAt <= this.ttlMs) return cached.response;
    if (this.inFlight) return this.inFlight;
    const refresh = this.refresh();
    this.inFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (this.inFlight === refresh) this.inFlight = undefined;
    }
  }

  public async readStatus(): Promise<ClaudeRateLimitStatus> {
    const rateLimits = await this.read();
    return {
      rateLimits,
      unavailableReason: hasRateLimitWindows(rateLimits)
        ? null
        : this.unavailableReason ?? "Claude returned no usable rate-limit data.",
    };
  }

  public cached(): ClaudeRateLimitsResponse {
    const cache = this.cache;
    return cache && this.now() - cache.fetchedAt <= this.staleTtlMs ? cache.response : unavailableClaudeRateLimits();
  }

  public mergeEvent(generation: number, info: SDKRateLimitInfo): void {
    if (!this.sources.has(generation)) {
      this.logger.debug("claude.rate-limits.stale-event", { generation });
      return;
    }
    const target = eventTarget(info.rateLimitType);
    if (!target) return;
    const previousResponse = this.cached();
    const response = structuredClone(previousResponse);
    const bucket = response.rateLimitsByLimitId[target.id]
      ?? snapshot(target.id, target.name, null, null, response.rateLimits.planType);
    const current = target.secondary ? response.rateLimits.secondary : bucket.primary;
    const incoming: ClaudeRateLimitWindow = {
      usedPercent: info.utilization === undefined ? current?.usedPercent ?? null : percent(info.utilization),
      windowDurationMins: target.duration,
      resetsAt: info.resetsAt === undefined ? current?.resetsAt ?? null : providerResetSeconds(info.resetsAt),
    };
    if (info.status !== "allowed" && current && incoming.resetsAt !== null && current.resetsAt !== null) {
      if (incoming.resetsAt < current.resetsAt) return;
      if (incoming.resetsAt === current.resetsAt && incoming.usedPercent !== null && current.usedPercent !== null
        && incoming.usedPercent < current.usedPercent) return;
    }
    const previousReached = target.id === "claude" ? response.rateLimits.rateLimitReachedType : bucket.rateLimitReachedType;
    const reached: ClaudeRateLimitSnapshot["rateLimitReachedType"] = info.status === "rejected"
      ? "rate_limit_reached"
      : info.status === "allowed" ? null : previousReached;
    if (target.id === "claude" && target.secondary) {
      response.rateLimits = { ...response.rateLimits, limitName: "Claude", secondary: incoming, rateLimitReachedType: reached };
    } else {
      const next = { ...bucket, limitName: target.name, primary: incoming, rateLimitReachedType: reached };
      response.rateLimitsByLimitId[target.id] = next;
      if (target.id === "claude") response.rateLimits = next;
    }
    response.rateLimitsByLimitId.claude = response.rateLimits;
    const noticeBucket = `${target.id}:${target.secondary ? "secondary" : "primary"}`;
    let transition: ClaudeRateLimitTransition | undefined;
    if (info.status === "allowed") {
      this.notices.delete(noticeBucket);
    } else {
      const candidate: ClaudeRateLimitTransition = {
        bucket: noticeBucket,
        status: info.status,
        resetsAt: incoming.resetsAt,
      };
      const previous = this.notices.get(noticeBucket);
      if (!previous || previous.status !== candidate.status || previous.resetsAt !== candidate.resetsAt) {
        this.notices.set(noticeBucket, candidate);
        transition = candidate;
      }
    }
    if (JSON.stringify(previousResponse) === JSON.stringify(response) && !transition) return;
    this.cache = {
      response,
      fetchedAt: this.now(),
      subscriptionType: this.cache?.subscriptionType ?? null,
      complete: this.cache?.complete ?? false,
    };
    if (hasRateLimitWindows(response)) this.unavailableReason = null;
    for (const listener of this.listeners.values()) listener(response, transition);
  }

  private async refresh(): Promise<ClaudeRateLimitsResponse> {
    const attemptGeneration = this.nextGeneration;
    const candidates = [...this.sources.entries()].sort(([a], [b]) => b - a);
    if (candidates.length === 0) {
      this.unavailableReason = "No authenticated Claude runtime is loaded.";
      this.logger.warn("claude.rate-limits.unavailable", { reason: "no-live-runtime" });
      return this.staleOrUnavailable();
    }
    let lastError: unknown;
    for (const [generation, source] of candidates) {
      try {
        const raw = await source.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
        if (attemptGeneration !== this.nextGeneration || !this.sources.has(generation)) {
          this.logger.debug("claude.rate-limits.stale-refresh", { generation });
          return this.staleOrUnavailable();
        }
        const response = mapClaudeUsage(raw);
        const parsedUsage = usageSchema.parse(raw);
        const subscriptionType = parsedUsage.subscription_type;
        if (this.cache?.subscriptionType !== undefined && this.cache.subscriptionType !== subscriptionType) {
          this.logger.info("claude.rate-limits.account-changed", {
            previousSubscriptionType: this.cache.subscriptionType,
            subscriptionType,
          });
        }
        this.cache = { response, fetchedAt: this.now(), subscriptionType, complete: true };
        this.unavailableReason = parsedUsage.rate_limits_available
          ? hasRateLimitWindows(response) ? null : "Claude returned no rate-limit windows."
          : "Claude reports that rate-limit data is unavailable for this account.";
        return response;
      } catch (error) {
        lastError = error;
        if (error instanceof ClaudeUsageSchemaError) {
          this.cache = undefined;
          this.unavailableReason = error.message;
          this.logger.error("claude.rate-limits.schema-mismatch", { error: error.message });
          return unavailableClaudeRateLimits();
        }
      }
    }
    this.unavailableReason = lastError instanceof Error
      ? `Claude usage request failed: ${lastError.message}`
      : `Claude usage request failed: ${String(lastError)}`;
    this.logger.warn("claude.rate-limits.refresh-failed", { error: lastError instanceof Error ? lastError.message : String(lastError) });
    return this.staleOrUnavailable();
  }

  private staleOrUnavailable(): ClaudeRateLimitsResponse {
    const cache = this.cache;
    if (cache && this.now() - cache.fetchedAt <= this.staleTtlMs) return cache.response;
    return unavailableClaudeRateLimits();
  }
}

function eventTarget(type: SDKRateLimitInfo["rateLimitType"]): {
  id: string; name: string; duration: number; secondary: boolean;
} | undefined {
  switch (type) {
    case "five_hour": return { id: "claude", name: "Claude", duration: 300, secondary: false };
    case "seven_day": return { id: "claude", name: "Claude", duration: 10_080, secondary: true };
    case "seven_day_opus": return { id: "claude-seven-day-opus", name: "Claude Opus · 7 day", duration: 10_080, secondary: false };
    case "seven_day_sonnet": return { id: "claude-seven-day-sonnet", name: "Claude Sonnet · 7 day", duration: 10_080, secondary: false };
    default: return undefined;
  }
}

export function rateLimitNotifications(response: ClaudeRateLimitsResponse): Array<{
  method: "account/rateLimits/updated"; params: { rateLimits: ClaudeRateLimitSnapshot };
}> {
  const aggregate = response.rateLimits;
  const buckets = Object.values(response.rateLimitsByLimitId)
    .filter((rateLimits) => rateLimits.limitId !== aggregate.limitId);
  return [...buckets, aggregate].map((rateLimits) => ({
    method: "account/rateLimits/updated" as const, params: { rateLimits },
  }));
}
