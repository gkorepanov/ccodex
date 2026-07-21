import type { UserInput } from "../codex/generated/v2/UserInput.js";
import type { GetAccountRateLimitsResponse } from "../codex/generated/v2/GetAccountRateLimitsResponse.js";
import type {
  ClaudeRateLimitStatus,
} from "./rateLimits.js";

interface StatusWindow {
  readonly usedPercent: number | null;
  readonly windowDurationMins: number | null;
  readonly resetsAt: number | null;
}

interface StatusSnapshot {
  readonly primary: StatusWindow | null;
  readonly secondary: StatusWindow | null;
}

export interface StatusProviderAvailability {
  readonly state: "ready" | "notAuthenticated" | "notInstalled";
  readonly action?: string;
}

export interface CCodexStatus {
  readonly claude: {
    readonly availability: StatusProviderAvailability;
    readonly usage?: ClaudeRateLimitStatus;
  };
  readonly codex: {
    readonly availability: StatusProviderAvailability;
    readonly rateLimits?: GetAccountRateLimitsResponse;
  };
}

export function isCCodexStatusCommand(input: UserInput[]): boolean {
  if (input.length !== 1 || input[0]?.type !== "text") return false;
  const command = input[0].text.trim().toLowerCase();
  return command === "/ccstatus" || command === "ccodex status" || command === "/ccodex-status";
}

/** Backwards-compatible internal name used by persisted-turn recovery. */
export const isClaudeStatusCommand = isCCodexStatusCommand;

function sameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function resetText(resetsAt: number | null, now: Date): string | undefined {
  if (resetsAt === null) return undefined;
  const reset = new Date(resetsAt * 1_000);
  if (sameLocalDay(reset, now)) {
    return `${String(reset.getHours()).padStart(2, "0")}:${String(reset.getMinutes()).padStart(2, "0")}`;
  }
  return reset.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function durationLabel(window: StatusWindow, fallback: string): string {
  if (window.windowDurationMins === 300) return "5h";
  if (window.windowDurationMins === 10_080) return "7d";
  return fallback;
}

function windowText(label: string, value: StatusWindow | null, now: Date): string | undefined {
  if (!value) return undefined;
  const usage = value.usedPercent === null ? "usage unavailable" : `${value.usedPercent}% used`;
  const reset = resetText(value.resetsAt, now);
  return `${label} ▸ ${usage} · ${reset ? `resets ${reset}` : "reset unavailable"}`;
}

function aggregateWindows(snapshot: StatusSnapshot, now: Date): string[] {
  return [
    snapshot.primary ? windowText(durationLabel(snapshot.primary, "primary"), snapshot.primary, now) : undefined,
    snapshot.secondary ? windowText(durationLabel(snapshot.secondary, "secondary"), snapshot.secondary, now) : undefined,
  ].filter((line): line is string => Boolean(line));
}

function claudeWindows(status: ClaudeRateLimitStatus | undefined, now: Date): string[] {
  if (!status) return [];
  const aggregate = status.rateLimits.rateLimits;
  const lines = aggregateWindows(aggregate, now);
  const buckets = Object.values(status.rateLimits.rateLimitsByLimitId)
    .filter((bucket) => bucket.limitId !== aggregate.limitId)
    .sort((left, right) => left.limitId < right.limitId ? -1 : left.limitId > right.limitId ? 1 : 0);
  for (const bucket of buckets) {
    const window = bucket.primary ?? bucket.secondary;
    if (!window) continue;
    const name = bucket.limitName
      .replace(/^Claude\s+/, "")
      .replace(/\s+·\s+7 day$/, " 7d");
    const line = windowText(name, window, now);
    if (line) lines.push(line);
  }
  if (lines.length === 0 && status.unavailableReason) lines.push(`limits unavailable · ${status.unavailableReason}`);
  return lines;
}

function codexWindows(rateLimits: GetAccountRateLimitsResponse | undefined, now: Date): string[] {
  if (!rateLimits) return [];
  const buckets = rateLimits.rateLimitsByLimitId
    ? Object.values(rateLimits.rateLimitsByLimitId).filter((bucket) => bucket !== undefined)
    : [rateLimits.rateLimits];
  return buckets.flatMap((bucket) => aggregateWindows(bucket, now));
}

function providerBlock(
  avatar: string,
  name: string,
  availability: StatusProviderAvailability,
  windows: readonly string[],
): string[] {
  if (availability.state !== "ready") {
    const state = availability.state === "notAuthenticated" ? "⚠️ not authenticated" : "❌ not installed";
    return [
      `${avatar} **${name}** · ${state}`,
      ...(availability.action ? [`  ↳ \`${availability.action}\``] : []),
    ];
  }
  const content = windows.length > 0 ? windows : ["limits unavailable"];
  return [
    `${avatar} **${name}** · ✅ ready`,
    ...content.map((line, index) => `  ${index === content.length - 1 ? "└" : "├"} ${line}`),
  ];
}

export function formatCCodexStatus(status: CCodexStatus, now = new Date()): string {
  return [
    "◆ **CCodex** │ status",
    "",
    ...providerBlock("❋", "Claude", status.claude.availability, claudeWindows(status.claude.usage, now)),
    "",
    ...providerBlock("֎", "Codex", status.codex.availability, codexWindows(status.codex.rateLimits, now)),
  ].join("\n");
}
