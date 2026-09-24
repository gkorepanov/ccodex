import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MCP_THREAD_SOURCE } from "../mcp/server.js";
import type { ThreadItem } from "../protocol/codex.js";

export const CODEX_MCP_TOOLS = new Set(["mcp__codex__codex", "mcp__codex__codex-reply"]);
export const CODEX_MCP_PROMPT_LABEL = "◆ CCodex │ Codex MCP prompt";
export const CODEX_MCP_MESSAGE_LABEL = "◆ CCodex │ Codex MCP message";
export const CODEX_MCP_REASONING_LABEL = "◆ CCodex │ Codex MCP reasoning";

/** Model and reasoning effort a codex turn ran with (its journal's `turn_context`). */
export interface CodexTurnContext {
  readonly kind: "context";
  readonly model: string;
  readonly effort: string | null;
}

export type CodexRolloutEvent =
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | CodexTurnContext
  | { readonly kind: "turnComplete" };

/** Locates the rollout journal for a codex MCP call; injectable for tests. */
export interface CodexRolloutLocator {
  /** Journal of an existing codex thread (codex-reply), by thread id. */
  byThreadId(threadId: string): string | undefined;
  /** Journal of a fresh MCP-sourced codex session started at or after `notBeforeMs`, excluding `claimed` paths. */
  freshMcpSession(notBeforeMs: number, claimed: ReadonlySet<string>): string | undefined;
}

function codexSessionsDir(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
}

function dayDirsNewestFirst(root: string, limit: number): string[] {
  const numericDesc = (values: string[]) =>
    values.filter((value) => /^\d+$/.test(value)).sort((a, b) => Number(b) - Number(a));
  const days: string[] = [];
  let entries: string[];
  try { entries = readdirSync(root); } catch { return []; }
  for (const year of numericDesc(entries)) {
    for (const month of numericDesc(readdirSync(join(root, year)))) {
      for (const day of numericDesc(readdirSync(join(root, year, month)))) {
        days.push(join(root, year, month, day));
        if (days.length >= limit) return days;
      }
    }
  }
  return days;
}

function sessionMeta(path: string): { source?: string; threadSource?: string; timestampMs?: number } | undefined {
  // The session_meta line embeds the full codex base instructions, so it can be
  // tens of kilobytes long — read a bounded head and require a complete line.
  let head: string;
  try {
    const buffer = Buffer.alloc(262_144);
    const fd = openSync(path, "r");
    try { head = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8"); }
    finally { closeSync(fd); }
  } catch { return undefined; }
  const end = head.indexOf("\n");
  if (end === -1) return undefined;
  const line = head.slice(0, end);
  try {
    const parsed = JSON.parse(line) as { type?: string; payload?: { source?: string; thread_source?: string; timestamp?: string } };
    if (parsed.type !== "session_meta") return undefined;
    const timestamp = parsed.payload?.timestamp ? Date.parse(parsed.payload.timestamp) : Number.NaN;
    return {
      ...(parsed.payload?.source === undefined ? {} : { source: parsed.payload.source }),
      ...(parsed.payload?.thread_source === undefined ? {} : { threadSource: parsed.payload.thread_source }),
      ...(Number.isNaN(timestamp) ? {} : { timestampMs: timestamp }),
    };
  } catch { return undefined; }
}

// `thread/revert` replaces a thread's journal with a new immutable file whose
// name carries a fresh rollout id; only the stock SQLite pointer identifies the
// current one, so a filename scan alone can attach to an obsolete journal.
function stockRolloutPointer(codexHome: string, threadId: string): string | undefined {
  let latest: { version: number; path: string } | undefined;
  try {
    for (const entry of readdirSync(codexHome)) {
      const match = /^state_(\d+)\.sqlite$/.exec(entry);
      if (match && (!latest || Number(match[1]) > latest.version)) {
        latest = { version: Number(match[1]), path: join(codexHome, entry) };
      }
    }
  } catch { return undefined; }
  if (!latest) return undefined;
  try {
    const database = new DatabaseSync(latest.path, { readOnly: true });
    try {
      const row = database.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId) as
        | { rollout_path?: string | null }
        | undefined;
      if (typeof row?.rollout_path !== "string") return undefined;
      statSync(row.rollout_path);
      return row.rollout_path;
    } finally { database.close(); }
  } catch { return undefined; }
}

export function defaultCodexRolloutLocator(sessionsDir = codexSessionsDir()): CodexRolloutLocator {
  return {
    byThreadId(threadId) {
      const pointed = stockRolloutPointer(dirname(sessionsDir), threadId);
      if (pointed) return pointed;
      const suffix = `-${threadId}.jsonl`;
      for (const day of dayDirsNewestFirst(sessionsDir, 366)) {
        for (const entry of readdirSync(day)) {
          if (entry.endsWith(suffix)) return join(day, entry);
        }
      }
      return undefined;
    },
    freshMcpSession(notBeforeMs, claimed) {
      const candidates: { path: string; timestampMs: number }[] = [];
      for (const day of dayDirsNewestFirst(sessionsDir, 2)) {
        for (const entry of readdirSync(day)) {
          if (!entry.endsWith(".jsonl")) continue;
          const path = join(day, entry);
          if (claimed.has(path)) continue;
          try {
            if (statSync(path).mtimeMs < notBeforeMs - 5_000) continue;
          } catch { continue; }
          const meta = sessionMeta(path);
          if (meta?.source !== "mcp" && meta?.threadSource !== MCP_THREAD_SOURCE) continue;
          if (meta.timestampMs === undefined || meta.timestampMs < notBeforeMs - 5_000) continue;
          candidates.push({ path, timestampMs: meta.timestampMs });
        }
      }
      return candidates.sort((a, b) => a.timestampMs - b.timestampMs)[0]?.path;
    },
  };
}

type RolloutLine = CodexRolloutEvent | { readonly kind: "turnStarted" } | { readonly kind: "prompt"; readonly text: string };

function rolloutLine(line: string): RolloutLine | undefined {
  let parsed: { type?: string; payload?: { type?: string; message?: unknown; text?: unknown; model?: unknown; effort?: unknown; item?: { type?: string; content?: { text?: string }[]; summary_text?: string[] } } };
  try { parsed = JSON.parse(line) as typeof parsed; } catch { return undefined; }
  if (parsed.type === "turn_context" && typeof parsed.payload?.model === "string") {
    return { kind: "context", model: parsed.payload.model, effort: typeof parsed.payload.effort === "string" ? parsed.payload.effort : null };
  }
  if (parsed.type !== "event_msg") return undefined;
  const payload = parsed.payload;
  if (payload?.type === "task_started") return { kind: "turnStarted" };
  if (payload?.type === "task_complete") return { kind: "turnComplete" };
  if (payload?.type === "agent_message" && typeof payload.message === "string" && payload.message) return { kind: "message", text: payload.message };
  if (payload?.type === "agent_reasoning" && typeof payload.text === "string" && payload.text) return { kind: "reasoning", text: payload.text };
  if (payload?.type !== "item_completed") return undefined;
  // codex ≥ 0.156 journals items instead of agent_message / agent_reasoning events.
  const item = payload.item;
  const text = item?.type === "Reasoning" ? (item.summary_text ?? []).join("\n") : (item?.content ?? []).map((part) => part.text ?? "").join("");
  if (!text) return undefined;
  if (item?.type === "AgentMessage") return { kind: "message", text };
  if (item?.type === "Reasoning") return { kind: "reasoning", text };
  return item?.type === "UserMessage" ? { kind: "prompt", text } : undefined;
}

/** Consumes complete journal lines from `buffer` + `chunk`, returning mapped events and the unparsed tail. */
export function parseRolloutChunk(buffer: string, chunk: string): { rest: string; events: CodexRolloutEvent[] } {
  const combined = buffer + chunk;
  const boundary = combined.lastIndexOf("\n");
  if (boundary === -1) return { rest: combined, events: [] };
  const events = combined.slice(0, boundary).split("\n").map(rolloutLine)
    .filter((event): event is CodexRolloutEvent => event !== undefined && event.kind !== "turnStarted" && event.kind !== "prompt");
  return { rest: combined.slice(boundary + 1), events };
}

/** One codex turn of a journal: its prompt, what it ran with and what codex said. */
interface RolloutTurn {
  prompt?: string;
  context?: CodexTurnContext;
  readonly events: CodexRolloutEvent[];
}

const turnCache = new Map<string, { readonly size: number; readonly turns: RolloutTurn[] }>();

function rolloutTurns(path: string): RolloutTurn[] {
  const size = statSync(path).size;
  const cached = turnCache.get(path);
  if (cached?.size === size) return cached.turns;
  const turns: RolloutTurn[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const event = line ? rolloutLine(line) : undefined;
    if (!event) continue;
    if (event.kind === "turnStarted") turns.push({ events: [] });
    else if (event.kind === "prompt" && turns.length) turns.at(-1)!.prompt ??= event.text;
    else if (event.kind === "context" && turns.length) turns.at(-1)!.context ??= event;
    else if (event.kind !== "prompt" && event.kind !== "context") turns.at(-1)?.events.push(event);
  }
  turnCache.set(path, { size, turns });
  return turns;
}

/** Journals of in-flight `mcp__codex__codex` calls (whose result, carrying the codex thread id, is not in yet). */
const liveRollouts = new Map<string, string>();

/** The item a codex MCP prompt, message or reasoning shows as; ids are shared by the live stream and history. The
 *  prompt names the model and effort codex ran it with, once its journal tells. */
export function codexMcpItem(
  toolUseId: string,
  index: number | "prompt",
  event: { kind: "message" | "reasoning"; text: string } | { kind: "prompt"; text: string; context?: CodexTurnContext | undefined },
): ThreadItem {
  const ran = event.kind === "prompt" && event.context ? [event.context.model, event.context.effort].filter(Boolean).map((part) => ` · ${part}`).join("") : "";
  const label = event.kind === "prompt" ? `${CODEX_MCP_PROMPT_LABEL}${ran}` : event.kind === "reasoning" ? CODEX_MCP_REASONING_LABEL : CODEX_MCP_MESSAGE_LABEL;
  return { type: "agentMessage", id: `${toolUseId}:codex:${index}`, text: `${label}\n\n${event.text}`, phase: "commentary", memoryCitation: null };
}

/**
 * History of one codex MCP call: its prompt and the codex turn it ran, read back from codex's journal. `seen`
 * counts earlier calls with the same thread and prompt in this history (the n-th such call ran the n-th such turn).
 */
export function codexMcpItems(
  toolUseId: string,
  input: Record<string, unknown>,
  result: string | undefined,
  seen: Map<string, number>,
  locator: CodexRolloutLocator = defaultCodexRolloutLocator(),
): ThreadItem[] {
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  let threadId = typeof input.threadId === "string" ? input.threadId : undefined;
  try { threadId ??= (JSON.parse(result ?? "") as { threadId?: string }).threadId; } catch { /* not a codex result */ }
  const path = liveRollouts.get(toolUseId) ?? (threadId ? locator.byThreadId(threadId) : undefined);
  let turn: RolloutTurn | undefined;
  if (path) {
    const key = `${path}\n${prompt}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    try { turn = rolloutTurns(path).filter((candidate) => candidate.prompt === prompt)[nth]; } catch { /* the prompt alone */ }
  }
  const said = (turn?.events ?? []).filter((event): event is Extract<CodexRolloutEvent, { text: string }> => "text" in event);
  return [
    ...(prompt ? [codexMcpItem(toolUseId, "prompt", { kind: "prompt", text: prompt, context: turn?.context })] : []),
    ...said.map((event, index) => codexMcpItem(toolUseId, index, event)),
  ];
}

const claimedRollouts = new Set<string>();

/**
 * Follows the rollout journal codex writes for one `mcp__codex__*` call and reports its messages and
 * reasoning as they are appended. Purely observational: codex's own MCP server is untouched.
 */
export function tailCodexRollout(
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  onEvent: (event: CodexRolloutEvent) => void,
  locator: CodexRolloutLocator = defaultCodexRolloutLocator(),
): () => void {
  const startedAt = Date.now();
  const threadId = typeof input.threadId === "string" ? input.threadId : typeof input.conversationId === "string" ? input.conversationId : undefined;
  let path: string | undefined;
  let offset = 0;
  let rest = "";
  let stopped = false;
  const poll = () => {
    if (stopped) return;
    if (!path) {
      path = toolName === "mcp__codex__codex-reply" && threadId
        ? locator.byThreadId(threadId)
        : locator.freshMcpSession(startedAt, claimedRollouts);
      if (!path) return;
      claimedRollouts.add(path);
      liveRollouts.set(toolUseId, path);
      // A reply appends to an existing journal: only what is written from now on belongs to this call.
      if (toolName === "mcp__codex__codex-reply") offset = statSync(path).size;
    }
    const size = statSync(path).size;
    if (size <= offset) return;
    const buffer = Buffer.alloc(size - offset);
    const fd = openSync(path, "r");
    try { readSync(fd, buffer, 0, buffer.length, offset); } finally { closeSync(fd); }
    offset = size;
    const parsed = parseRolloutChunk(rest, buffer.toString("utf8"));
    rest = parsed.rest;
    for (const event of parsed.events) onEvent(event);
  };
  const timer = setInterval(() => {
    try { poll(); } catch { /* the journal may not exist yet */ }
  }, 400);
  return () => {
    if (stopped) return;
    try { poll(); } catch { /* best effort final read */ }
    stopped = true;
    clearInterval(timer);
  };
}
