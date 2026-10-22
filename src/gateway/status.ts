import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { packageVersion } from "../management/commands.js";
import type { JsonObject, ThreadItem, Turn } from "../protocol/codex.js";
import { startedTurn } from "../protocol/turnPagination.js";
import type { Connection } from "./connection.js";
import type { Gateway } from "./server.js";

const COMMANDS = new Set(["cc", "ccstatus", "ccodex", "ccstate"]);
const SKILL = "ccodex:status";
/** What Desktop sends for the picked skill. */
const SKILL_CHIP = /^\[\$ccodex:status\]\([^)]*\)$/u;

/**
 * The command as a skill, so the App's `/` menu offers it: "CCodex status" comes first for `/cc`, `/ccodex`,
 * `/ccstatus`. Its SKILL.md is only what the App shows for it; the model never gets it.
 */
export async function statusSkill(dataDir: string): Promise<JsonObject> {
  const path = join(dataDir, "virtual", "ccodex-status", "SKILL.md");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nname: ${SKILL}\ndescription: CCodex status of this chat\n---\n\nCCodex answers this itself (same as \`/cc\`); the model never sees it.\n`);
  return {
    name: SKILL,
    description: "Model, context, Claude and Codex limits, session of this chat",
    interface: { displayName: "CCodex status", shortDescription: "Model, context, limits, session" },
    path,
    scope: "system",
    enabled: true,
    pluginId: null,
  };
}

/** `/cc` (or `/ccstatus`, `/ccodex`, `/ccstate`, `ccodex:status`, with `/`, `$` or nothing before, or the skill): CCodex's status of this chat. */
/** A status answer's turn (not part of the chat: nothing forks or edits from it). */
export function isStatusTurn(turnId: unknown): boolean {
  return typeof turnId === "string" && turnId.startsWith("ccodex-");
}

export function isStatusCommand(params: JsonObject): boolean {
  const input: JsonObject[] = params.input ?? [];
  // A skill picked in Desktop comes as its chip, or as `$ccodex:status` text plus the skill item.
  return input.length > 0 && input.every((item) => {
    if (item.type === "skill") return item.name === SKILL;
    const text = item.type === "text" ? String(item.text).trim() : "";
    const word = text.toLowerCase().replace(/^[/$]/u, "");
    return COMMANDS.has(word) || word === SKILL || SKILL_CHIP.test(text);
  });
}

interface Window {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

const PERMISSIONS: Record<string, string> = {
  default: "Ask", acceptEdits: "Accept edits", auto: "Auto", dontAsk: "Don't ask", bypassPermissions: "Bypass",
};

const DAY = 86_400_000;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const clock = (date: Date) => date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
/** A figure CCodex works out: one decimal below 10. */
const figure = (value: number) => String(value < 10 ? Math.round(value * 10) / 10 : Math.round(value));

function bar(percent: number): string {
  const filled = Math.round(Math.min(100, Math.max(0, percent)) / 5);
  return `\`${"█".repeat(filled)}${"░".repeat(20 - filled)}\``;
}

function tokens(value: number): string {
  return value < 1000 ? String(value) : value < 1_000_000 ? `${(value / 1000).toFixed(1).replace(/\.0$/u, "")}k` : `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/u, "")}M`;
}

/** A moment ahead: its day unless today, and the UTC offset of the gateway's machine, which may not be the user's. */
function moment(date: Date): string {
  const day = date.toDateString() === new Date().toDateString() ? "" : `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, `;
  const offset = -date.getTimezoneOffset();
  const minutes = Math.abs(offset) % 60;
  const zone = offset ? `UTC${offset > 0 ? "+" : "-"}${Math.floor(Math.abs(offset) / 60)}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}` : "UTC";
  return `${day}${clock(date)} ${zone}`;
}

/** A window's row; a week's also tells where its pace so far ends by the reset, and what is left a day till then. */
function limitRows(provider: string, limits: JsonObject): string[] {
  return [limits.primary, limits.secondary].filter((window): window is Window => Boolean(window)).flatMap((window) => {
    const label = window.windowDurationMins === 300 ? "5h" : window.windowDurationMins === 10_080 ? "week" : `${Math.round((window.windowDurationMins ?? 0) / 60)}h`;
    const used = window.usedPercent;
    const resetsAt = (window.resetsAt ?? 0) * 1000;
    const reset = resetsAt ? ` · resets ${moment(new Date(resetsAt))}` : "";
    const left = (resetsAt - Date.now()) / DAY;
    if (window.windowDurationMins !== 10_080 || left <= 0) return [`| **${provider} ${label}** | ${bar(used)} ${used}%${reset} |`];
    const spending = used / (7 - left);
    const forecast = used + spending * left;
    const outlook = forecast <= 100 ? ` → ${figure(forecast)}% by reset`
      : ` · 🔴 ${used >= 100 ? "used up" : `runs out ~${moment(new Date(Date.now() + (100 - used) / spending * DAY))}`}`;
    return [
      `| **${provider} ${label}** | ${bar(used)} ${used}%${outlook}${reset} |`,
      `| | spending ${figure(spending)}%/day · ${figure(Math.max(0, 100 - used) / left)}%/day left for ${figure(left)} days |`,
    ];
  });
}

async function statusText(gateway: Gateway, connection: Connection, threadId: string): Promise<string> {
  const segments = gateway.meta.lineage(threadId);
  const current = segments?.at(-1)?.threadId ?? threadId;
  const claudeLimits: JsonObject = (await gateway.claude.rateLimits()).rateLimits;
  const claudeError = await gateway.claude.models().then(() => undefined, (error: unknown) => String(error));
  const codexLimits: JsonObject = await connection.upstream.request("account/rateLimits/read", {}).then(
    (value: JsonObject) => value.rateLimits as JsonObject, (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  const rows: string[] = [];
  const session: string[] = [];
  let header: string;
  let cwd: string;
  let actions: { at: number; text: string }[] = [];
  if (gateway.isClaudeThread(threadId)) {
    const state = gateway.claude.state(current);
    const usage = state.lastUsage as JsonObject | undefined;
    const status = state.turnId ? "🟢 Running" : state.process ? "🟢 Ready" : "🟡 Idle";
    header = [`**❋ Claude ${state.model}**`, state.effort && capital(state.effort), state.fast && "Fast", PERMISSIONS[state.permissionMode] ?? state.permissionMode, state.plan && "Plan", status]
      .filter(Boolean).join(" · ");
    if (usage?.totalTokens && state.contextWindow) {
      const percent = Math.round(100 * usage.inputTokens / Number(state.contextWindow));
      rows.push(`| **Context** | ${bar(percent)} ${percent}% · ${tokens(usage.inputTokens)} / ${tokens(Number(state.contextWindow))} |`);
    }
    session.push(state.turnId ? "working on a turn" : state.process ? "Claude process running" : state.loaded
      ? "process unloaded, the next message restarts it" : "not opened since the gateway started");
    if (state.backgroundTasks) session.push(`${state.backgroundTasks} background task${state.backgroundTasks === 1 ? "" : "s"}`);
    cwd = state.cwd;
    actions = state.actions;
  } else {
    const { thread } = await connection.upstream.request("thread/read", { threadId: current });
    header = [`**֎ ${thread.model ?? "Codex"}**`, thread.reasoningEffort && capital(thread.reasoningEffort),
      thread.status?.type === "active" ? "🟢 Running" : "🟢 Ready"].filter(Boolean).join(" · ");
    cwd = thread.cwd;
  }
  if (segments) session.push(segments.map((segment) => segment.provider === "claude" ? "Claude" : "GPT").join(" → "));
  rows.push(...claudeError ? [`| **Claude** | 🔴 ${claudeError} |`]
    : claudeLimits.primary || claudeLimits.secondary
      ? [...limitRows("Claude", claudeLimits), ...gateway.claude.modelLimits.flatMap(({ name, window }) => limitRows(`Claude ${name}`, { primary: window }))] : [`| **Claude** | 🔴 ${gateway.claude.usageError ?? "limits unavailable"} |`]);
  rows.push(...codexLimits.error ? [`| **Codex** | 🔴 ${codexLimits.error} |`] : limitRows("Codex", codexLimits));
  const home = homedir();
  return [
    `### ◆ CCodex \`${packageVersion()}\``,
    "",
    header,
    "",
    "| | |",
    "|:--|:--|",
    ...rows,
    "",
    ...session.length ? [`**Session** — ${session.join(" · ")}`, ""] : [],
    ...actions.length ? ["**Recent actions**", ...actions.map((action) => `- \`${clock(new Date(action.at))}\` ${capital(action.text)}`), ""] : [],
    `_Thread \`${threadId}\` · \`${cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd}\`_`,
  ].join("\n");
}

async function answer(gateway: Gateway, connection: Connection, threadId: string, turnId: string, id: string, params: JsonObject): Promise<void> {
  const user: ThreadItem = { type: "userMessage", id: `${id}:user`, clientId: params.clientUserMessageId ?? null, content: params.input };
  connection.notify("item/started", { item: user, threadId, turnId, startedAtMs: Date.now() });
  connection.notify("item/completed", { item: user, threadId, turnId, completedAtMs: Date.now() });
  const text = await statusText(gateway, connection, threadId)
    .catch((error: unknown) => `### ◆ CCodex\n\n🔴 Status failed: ${error instanceof Error ? error.message : String(error)}`);
  const item: ThreadItem = { type: "agentMessage", id: `${id}:answer`, text, phase: "final_answer", memoryCitation: null };
  connection.notify("item/started", { item: { ...item, text: "" }, threadId, turnId, startedAtMs: Date.now() });
  connection.notify("item/agentMessage/delta", { threadId, turnId, itemId: item.id, delta: text });
  connection.notify("item/completed", { item, threadId, turnId, completedAtMs: Date.now() });
}

/** The thread's running turn, if any. */
async function runningTurn(gateway: Gateway, connection: Connection, threadId: string): Promise<string | undefined> {
  const current = gateway.meta.lineage(threadId)?.at(-1)?.threadId ?? threadId;
  if (gateway.isClaudeThread(threadId)) return gateway.claude.state(current).turnId ?? undefined;
  const { data } = await connection.upstream.request("thread/turns/list", { threadId: current, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
  return data[0]?.status === "inProgress" ? data[0].id : undefined;
}

/**
 * The status command: an answer that exists only on the wire, never in any transcript or before the model. Sent
 * while a turn runs (a steer, or queued behind it), it shows at once inside that turn and leaves the turn alone;
 * otherwise it is a turn of its own.
 */
export async function statusCommand(gateway: Gateway, connection: Connection, method: string, params: JsonObject): Promise<unknown> {
  const threadId: string = params.threadId;
  const id = `ccodex-${randomUUID()}`;
  const queued = method === "thread/queue/add";
  const running = method === "turn/steer" ? params.expectedTurnId : queued ? await runningTurn(gateway, connection, threadId) : undefined;
  // Nothing is queued: Desktop drops the message from its queue on the next `thread/queue/list`.
  const reply = queued ? { queuedSubmission: { id, input: params.input, clientUserMessageId: params.clientUserMessageId ?? null } } : undefined;
  if (queued) setImmediate(() => connection.notify("thread/queue/changed", { threadId }));
  if (running) {
    setImmediate(() => void answer(gateway, connection, threadId, running, id, params));
    return reply ?? { turnId: running };
  }
  const now = Math.floor(Date.now() / 1000);
  const turn: Turn = { id, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: now, completedAt: null, durationMs: null };
  setImmediate(() => void (async () => {
    connection.notify("turn/started", { threadId, turn });
    connection.notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
    await answer(gateway, connection, threadId, id, id, params);
    connection.notify("turn/completed", { threadId, turn: { ...turn, status: "completed", completedAt: Math.floor(Date.now() / 1000), durationMs: Date.now() - now * 1000 } });
    // Desktop keeps the thread spinning in the sidebar until the thread is idle again.
    connection.notify("thread/status/changed", { threadId, status: { type: "idle" } });
  })());
  return reply ?? { turn: startedTurn(turn) };
}
