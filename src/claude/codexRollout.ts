import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CODEX_MCP_TOOLS = new Set(["mcp__codex__codex", "mcp__codex__codex-reply"]);
export const CODEX_MCP_PROMPT_LABEL = "◆ CCodex │ Codex MCP prompt";
export const CODEX_MCP_MESSAGE_LABEL = "◆ CCodex │ Codex MCP message";
export const CODEX_MCP_REASONING_LABEL = "◆ CCodex │ Codex MCP reasoning";

export type CodexRolloutEvent =
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
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

function sessionMeta(path: string): { source?: string; timestampMs?: number } | undefined {
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
    const parsed = JSON.parse(line) as { type?: string; payload?: { source?: string; timestamp?: string } };
    if (parsed.type !== "session_meta") return undefined;
    const timestamp = parsed.payload?.timestamp ? Date.parse(parsed.payload.timestamp) : Number.NaN;
    return {
      ...(parsed.payload?.source === undefined ? {} : { source: parsed.payload.source }),
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
          if (meta?.source !== "mcp") continue;
          if (meta.timestampMs === undefined || meta.timestampMs < notBeforeMs - 5_000) continue;
          candidates.push({ path, timestampMs: meta.timestampMs });
        }
      }
      return candidates.sort((a, b) => a.timestampMs - b.timestampMs)[0]?.path;
    },
  };
}

/** Consumes complete journal lines from `buffer` + `chunk`, returning mapped events and the unparsed tail. */
export function parseRolloutChunk(buffer: string, chunk: string): { rest: string; events: CodexRolloutEvent[] } {
  const combined = buffer + chunk;
  const boundary = combined.lastIndexOf("\n");
  if (boundary === -1) return { rest: combined, events: [] };
  const events: CodexRolloutEvent[] = [];
  for (const line of combined.slice(0, boundary).split("\n")) {
    if (!line.trim()) continue;
    let parsed: { type?: string; payload?: { type?: string; message?: unknown; text?: unknown } };
    try { parsed = JSON.parse(line) as typeof parsed; } catch { continue; }
    if (parsed.type !== "event_msg") continue;
    const payload = parsed.payload;
    if (payload?.type === "agent_message" && typeof payload.message === "string" && payload.message) {
      events.push({ kind: "message", text: payload.message });
    } else if (payload?.type === "agent_reasoning" && typeof payload.text === "string" && payload.text) {
      events.push({ kind: "reasoning", text: payload.text });
    } else if (payload?.type === "task_complete") {
      events.push({ kind: "turnComplete" });
    }
  }
  return { rest: combined.slice(boundary + 1), events };
}
