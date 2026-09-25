import { randomUUID } from "node:crypto";
import type { JsonObject, ThreadItem, Turn } from "../protocol/codex.js";
import { startedTurn } from "../protocol/turnPagination.js";
import type { Connection } from "./connection.js";
import type { Gateway } from "./server.js";

type Command = "status" | "state";

export function ccodexCommand(params: JsonObject): Command | undefined {
  const input = params.input ?? [];
  if (input.length !== 1 || input[0]?.type !== "text") return undefined;
  const text = String(input[0].text).trim().toLowerCase();
  return text === "/ccstatus" ? "status" : text === "/ccstate" ? "state" : undefined;
}

interface Window {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

function windowLine(value: Window | null | undefined): string | undefined {
  if (!value) return undefined;
  const label = value.windowDurationMins === 300 ? "5h" : value.windowDurationMins === 10_080 ? "7d" : `${value.windowDurationMins ?? "?"}m`;
  const reset = value.resetsAt ? new Date(value.resetsAt * 1000).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "unknown";
  return `${label} ▸ ${value.usedPercent}% used · resets ${reset}`;
}

function block(title: string, lines: readonly (string | undefined)[]): string[] {
  const shown = lines.filter((line): line is string => Boolean(line));
  return [title, ...shown.map((line, index) => `  ${index === shown.length - 1 ? "└" : "├"} ${line}`)];
}

function compact(value: number): string {
  if (value < 1000) return String(value);
  return value < 1_000_000 ? `${(value / 1000).toFixed(1).replace(/\.0$/u, "")}k` : `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/u, "")}m`;
}

async function statusText(gateway: Gateway, connection: Connection): Promise<string> {
  const claudeModels = await gateway.claude.models().then(() => undefined, (error: unknown) => String(error));
  const claude = (await gateway.claude.rateLimits()).rateLimits;
  const codex: JsonObject = await connection.upstream.request("account/rateLimits/read", {}).then(
    (value: JsonObject) => value.rateLimits as JsonObject,
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  return [
    "◆ **CCodex** │ status",
    "",
    ...block(`❋ **Claude** · ${claudeModels ? `⚠️ ${claudeModels}` : "✅ ready"}`,
      claude.primary || claude.secondary ? [windowLine(claude.primary), windowLine(claude.secondary)] : ["limits appear after the first Claude turn"]),
    "",
    ...block(`֎ **Codex** · ${codex.error ? `⚠️ ${codex.error}` : "✅ ready"}`,
      codex.error ? [] : [windowLine(codex.primary), windowLine(codex.secondary)]),
  ].join("\n");
}

async function stateText(gateway: Gateway, connection: Connection, threadId: string): Promise<string> {
  const segments = gateway.meta.lineage(threadId);
  const current = segments?.at(-1)?.threadId ?? threadId;
  const lines: string[] = [];
  if (gateway.isClaudeThread(threadId)) {
    const state = gateway.claude.state(current);
    const usage = state.lastUsage as JsonObject | undefined;
    lines.push(
      `model ▸ ${state.model}${state.effort ? ` · effort ${state.effort}` : ""}${state.fast ? " · fast" : ""}`,
      `permissions ▸ ${state.permissionMode}`,
      `session ▸ ${state.running ? "running" : state.process ? "loaded" : state.loaded ? "loaded · no Claude process (the next prompt starts it)" : "not loaded"}${state.backgroundTasks ? ` · ${state.backgroundTasks} background task(s)` : ""}`,
      ...(usage?.totalTokens ? [`context ▸ ${compact(usage.inputTokens)}${state.contextWindow ? ` / ${compact(Number(state.contextWindow))}` : ""} tokens`] : []),
      ...(state.costUsd ? [`cost (this process) ▸ $${Number(state.costUsd).toFixed(2)}`] : []),
      ...(state.actions as { at: number; text: string }[]).map((action) =>
        `CCodex ▸ ${new Date(action.at).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} ${action.text}`),
    );
  } else {
    const { thread } = await connection.upstream.request("thread/read", { threadId: current });
    lines.push(`model ▸ ${thread.model ?? "default"}${thread.reasoningEffort ? ` · effort ${thread.reasoningEffort}` : ""}`, `cwd ▸ ${thread.cwd}`);
  }
  if (segments) lines.push(`segments ▸ ${segments.map((segment) => segment.provider).join(" → ")}`);
  return [`◆ **CCodex** │ state of \`${threadId}\``, "", ...block(gateway.isClaudeThread(threadId) ? "❋ **Claude**" : "֎ **Codex**", lines)].join("\n");
}

/** `/ccstatus` and `/ccstate`: a turn that exists only on the wire, never in any transcript. */
export async function synthesizeTurn(gateway: Gateway, connection: Connection, params: JsonObject, command: Command): Promise<unknown> {
  const threadId: string = params.threadId;
  const id = `ccodex-${randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const turn: Turn = { id, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: now, completedAt: null, durationMs: null };
  const user: ThreadItem = { type: "userMessage", id: `${id}:user`, clientId: params.clientUserMessageId ?? null, content: params.input };
  setImmediate(() => void (async () => {
    connection.notify("turn/started", { threadId, turn });
    connection.notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
    connection.notify("item/started", { item: user, threadId, turnId: id, startedAtMs: Date.now() });
    connection.notify("item/completed", { item: user, threadId, turnId: id, completedAtMs: Date.now() });
    const text = await (command === "status" ? statusText(gateway, connection) : stateText(gateway, connection, threadId))
      .catch((error: unknown) => `◆ **CCodex** │ ${command} failed: ${error instanceof Error ? error.message : String(error)}`);
    const answer: ThreadItem = { type: "agentMessage", id: `${id}:answer`, text, phase: "final_answer", memoryCitation: null };
    connection.notify("item/started", { item: { ...answer, text: "" }, threadId, turnId: id, startedAtMs: Date.now() });
    connection.notify("item/agentMessage/delta", { threadId, turnId: id, itemId: answer.id, delta: text });
    connection.notify("item/completed", { item: answer, threadId, turnId: id, completedAtMs: Date.now() });
    connection.notify("turn/completed", { threadId, turn: { ...turn, status: "completed", completedAt: Math.floor(Date.now() / 1000), durationMs: Date.now() - now * 1000 } });
    // Desktop keeps the thread spinning in the sidebar until the thread is idle again.
    connection.notify("thread/status/changed", { threadId, status: { type: "idle" } });
  })());
  return { turn: startedTurn(turn) };
}
