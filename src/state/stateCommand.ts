import type { ApprovalsReviewer } from "../codex/generated/v2/ApprovalsReviewer.js";
import type { AskForApproval } from "../codex/generated/v2/AskForApproval.js";
import type { SandboxPolicy } from "../codex/generated/v2/SandboxPolicy.js";
import type { Thread } from "../codex/generated/v2/Thread.js";
import type { ThreadItem } from "../codex/generated/v2/ThreadItem.js";
import type { ThreadTokenUsage } from "../codex/generated/v2/ThreadTokenUsage.js";
import type { UserInput } from "../codex/generated/v2/UserInput.js";

export interface ThreadStateSnapshot {
  readonly provider: "claude" | "codex";
  readonly model: string;
  readonly effort: string | null;
  readonly serviceTier: string | null;
  readonly approvalPolicy: AskForApproval | null;
  readonly approvalsReviewer: ApprovalsReviewer | null;
  readonly sandboxPolicy: SandboxPolicy | null;
  readonly thread: Thread;
  readonly tokenUsage: ThreadTokenUsage | null;
  readonly providerCostUsd: number | null;
}

export function isCCodexStateCommand(input: UserInput[]): boolean {
  return input.length === 1
    && input[0]?.type === "text"
    && input[0].text.trim().toLowerCase() === "/ccstate";
}

export function stateModelName(provider: "claude" | "codex", value: string): string {
  const withoutProvider = value
    .replace(/^claude:/, "")
    .replace(/^claude-/, "")
    .replace(/^gpt-/, "");
  const words = withoutProvider.split("-").filter(Boolean);
  const version = words.length >= 2
    && /^\d+$/.test(words.at(-1)!)
    && /^\d+$/.test(words.at(-2)!)
    ? `${words.splice(-2).join(".")}`
    : undefined;
  const name = words.map((word) =>
    word.length <= 3 && /^\d+$/.test(word)
      ? word
      : `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
  return `${provider === "claude" ? "Claude" : "Codex"} ${name}${version ? ` ${version}` : ""}`.trim();
}

function compactNumber(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  const units = [
    { size: 1_000_000_000, suffix: "b" },
    { size: 1_000_000, suffix: "m" },
    { size: 1_000, suffix: "k" },
  ];
  const unit = units.find((candidate) => value >= candidate.size)!;
  const scaled = value / unit.size;
  const precision = scaled >= 100 || Number.isInteger(scaled) ? 0 : 1;
  return `${scaled.toFixed(precision).replace(/\.0$/, "")}${unit.suffix}`;
}

function elapsed(valueMs: number): string {
  const seconds = Math.max(0, Math.floor(valueMs / 1_000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds % 86_400 / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  const remainder = seconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

function relative(valueSeconds: number, nowMs: number): string {
  const delta = Math.max(0, nowMs - valueSeconds * 1_000);
  if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function syntheticTurn(items: readonly ThreadItem[]): boolean {
  const user = items.find((item) => item.type === "userMessage");
  if (user?.type !== "userMessage") return false;
  return isCCodexStateCommand(user.content)
    || (user.content.length === 1 && user.content[0]?.type === "text"
      && ["/ccstatus", "ccodex status", "/ccodex-status"]
        .includes(user.content[0].text.trim().toLowerCase()));
}

function toolKind(item: ThreadItem): string | undefined {
  if (item.type === "fileChange") return "edit";
  if (item.type === "collabAgentToolCall") return "agent";
  if (item.type === "mcpToolCall") return "mcp";
  if (item.type === "dynamicToolCall") return item.tool.toLowerCase();
  if (item.type === "webSearch") return "web";
  if (item.type === "imageView") return "read";
  if (item.type === "imageGeneration") return "image";
  if (item.type === "sleep") return "sleep";
  if (item.type !== "commandExecution") return undefined;
  const actions = item.commandActions.map((action) => action.type);
  if (actions.some((type) => type === "read")) return "read";
  if (actions.some((type) => type === "search" || type === "listFiles")) return "search";
  return "bash";
}

function mode(snapshot: ThreadStateSnapshot): string {
  if (snapshot.approvalsReviewer === "auto_review") return "ᗢ approve for me";
  if (snapshot.approvalPolicy === "on-request" || snapshot.approvalPolicy === "untrusted"
    || snapshot.approvalPolicy !== null && typeof snapshot.approvalPolicy === "object") {
    return "◇ ask for approval";
  }
  if (snapshot.sandboxPolicy?.type === "dangerFullAccess") return "◆ full access";
  if (snapshot.sandboxPolicy?.type === "readOnly") return "◈ read only";
  if (!snapshot.approvalPolicy || !snapshot.sandboxPolicy) return "unavailable";
  return "◇ no approvals";
}

function header(snapshot: ThreadStateSnapshot): string {
  const avatar = snapshot.provider === "claude" ? "❋" : "֎";
  const speed = snapshot.serviceTier === "fast" || snapshot.serviceTier === "priority"
    ? "⚡ fast"
    : "standard";
  return [
    `${avatar} **${snapshot.model}**`,
    snapshot.effort,
    speed,
  ].filter(Boolean).join(" · ");
}

function tree(lines: readonly string[]): string[] {
  return lines.map((line, index) => `  ${index === lines.length - 1 ? "└" : "├"} ${line}`);
}

export function formatCCodexState(snapshot: ThreadStateSnapshot, nowMs = Date.now()): string {
  const turns = snapshot.thread.turns.filter((turn) => !syntheticTurn(turn.items));
  let userMessages = 0;
  let assistantMessages = 0;
  const tools = new Map<string, number>();
  for (const item of turns.flatMap((turn) => turn.items)) {
    if (item.type === "userMessage") userMessages += 1;
    else if (item.type === "agentMessage") assistantMessages += 1;
    const kind = toolKind(item);
    if (kind) tools.set(kind, (tools.get(kind) ?? 0) + 1);
  }
  const compacts = turns.filter((turn) => turn.items.some((item) => item.type === "contextCompaction"));
  const lastCompact = compacts.map((turn) => turn.completedAt ?? turn.startedAt).filter((value): value is number =>
    value !== null).at(-1);
  const runTimeMs = turns.reduce((total, turn) => total + (turn.durationMs
    ?? (turn.startedAt === null ? 0 : Math.max(0, nowMs - turn.startedAt * 1_000))), 0);
  const usage = snapshot.tokenUsage;
  const context = usage?.last.totalTokens;
  const window = usage?.modelContextWindow;
  const contextPercent = context !== undefined && window
    ? Math.min(100, Math.max(0, Math.round(context / window * 100)))
    : null;
  const filled = contextPercent === null || contextPercent === 0
    ? 0
    : contextPercent === 100 ? 10 : Math.max(1, Math.floor(contextPercent / 10));
  const contextBar = contextPercent === null
    ? "unavailable"
    : `${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${contextPercent}% · ${compactNumber(context!)}/${compactNumber(window!)}`;
  const total = usage?.total;
  const cacheRate = total && total.inputTokens > 0
    ? `${Math.round(total.cachedInputTokens / total.inputTokens * 100)}% hit rate`
    : "unavailable";
  const toolEntries = [...tools.entries()].sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0]));
  const toolTotal = toolEntries.reduce((sum, [, count]) => sum + count, 0);
  const visibleTools = toolEntries.slice(0, 5);
  const hiddenTools = toolEntries.slice(5).reduce((sum, [, count]) => sum + count, 0);
  const toolDetails = visibleTools.length > 0
    ? ` (${[
        ...visibleTools.map(([name, count]) => `${name} ${count}`),
        ...(hiddenTools ? [`other ${hiddenTools}`] : []),
      ].join(" · ")})`
    : "";
  const cost = snapshot.providerCostUsd === null
    ? "unavailable for subscription"
    : `$${snapshot.providerCostUsd.toFixed(2)} provider estimate`;

  return [
    "◆ **CCodex** │ /ccstate",
    "",
    header(snapshot),
    ...tree([
      `context   ▸ ${contextBar}`,
      `tokens    ▸ ${total
        ? `${compactNumber(total.totalTokens)} processed (${compactNumber(total.inputTokens)} in / ${compactNumber(total.outputTokens)} out)`
        : "unavailable"}`,
      `cache     ▸ ${cacheRate}`,
    ]),
    "",
    "💬 **Chat**",
    ...tree([
      `messages  ▸ ${userMessages} user / ${assistantMessages} assistant / ${userMessages + assistantMessages} total`,
      `compacts  ▸ ${compacts.length}${lastCompact ? ` (last: ${relative(lastCompact, nowMs)})` : ""}`,
      `session   ▸ started ${elapsed(nowMs - snapshot.thread.createdAt * 1_000)} ago`,
    ]),
    "",
    "⚙️ **Session**",
    ...tree([
      `mode      ▸ ${mode(snapshot)}`,
      `agent     ▸ ${elapsed(runTimeMs)} cumulative turn time`,
      `tools     ▸ ${toolTotal} calls${toolDetails}`,
      `cost      ▸ ${cost}`,
    ]),
  ].join("\n");
}
