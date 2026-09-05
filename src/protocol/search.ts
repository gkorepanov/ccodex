import type { ThreadItem } from "../codex/generated/v2/ThreadItem.js";
import type { ThreadSearchOccurrencesParams } from "../codex/generated/v2/ThreadSearchOccurrencesParams.js";
import type { ThreadSearchOccurrencesResponse } from "../codex/generated/v2/ThreadSearchOccurrencesResponse.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import { invalidRequest } from "./errors.js";
import { finalAgentItem, turnCursor } from "./turnPagination.js";

// Stock snippet window: 48 characters before the match and 96 after (Unicode scalar values).
const CONTEXT_BEFORE = 48;
const CONTEXT_AFTER = 96;

const collapseWhitespace = (text: string) => text.split(/\s+/u).filter(Boolean).join(" ");

/** Text stock indexes for an item: user text fragments, or an agent message body. */
export function searchableText(item: ThreadItem): string | undefined {
  if (item.type === "userMessage") {
    return collapseWhitespace(item.content.flatMap((part) => part.type === "text" ? [part.text.trim()] : []).join(""));
  }
  return item.type === "agentMessage" ? collapseWhitespace(item.text) : undefined;
}

interface Match { readonly start: number; readonly end: number }

/** Non-overlapping, case-insensitive literal matches (UTF-16 offsets into `text`). */
export function findMatches(text: string, searchTerm: string): Match[] {
  const needle = searchTerm.toLowerCase();
  if (!needle) return [];
  // Lower-case per code point so offsets map back to `text` even where case folding changes length (e.g. "İ").
  let haystack = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index)!;
    const next = index + (codePoint > 0xffff ? 2 : 1);
    const lowered = String.fromCodePoint(codePoint).toLowerCase();
    for (let unit = 0; unit < lowered.length; unit += 1) {
      starts.push(index);
      ends.push(next);
    }
    haystack += lowered;
    index = next;
  }
  const matches: Match[] = [];
  for (let start = haystack.indexOf(needle); start >= 0; start = haystack.indexOf(needle, start + needle.length)) {
    matches.push({ start: starts[start]!, end: ends[start + needle.length - 1]! });
  }
  return matches;
}

export interface Snippet { readonly snippet: string; readonly start: number; readonly end: number }

/** Snippet around one match with stock's `... ` / ` ...` truncation markers; range is in UTF-16 units of the snippet. */
export function snippetAround(text: string, match: Match): Snippet {
  const before = Array.from(text.slice(0, match.start));
  const after = Array.from(text.slice(match.end));
  const truncatedStart = before.length > CONTEXT_BEFORE;
  const truncatedEnd = after.length > CONTEXT_AFTER;
  let prefix = before.slice(truncatedStart ? before.length - CONTEXT_BEFORE : 0).join("");
  let suffix = after.slice(0, CONTEXT_AFTER).join("");
  if (truncatedStart) prefix = `... ${prefix.trimStart()}`;
  if (truncatedEnd) suffix = `${suffix.trimEnd()} ...`;
  const matched = text.slice(match.start, match.end);
  return { snippet: `${prefix}${matched}${suffix}`, start: prefix.length, end: prefix.length + matched.length };
}

/** `thread/search` snippet: the first match across user and agent messages in chronological order. */
export function threadSearchSnippet(turns: readonly Turn[], searchTerm: string): string | undefined {
  for (const turn of turns) {
    for (const item of turn.items) {
      const text = searchableText(item);
      if (!text) continue;
      const [match] = findMatches(text, searchTerm);
      if (match) return snippetAround(text, match).snippet;
    }
  }
  return undefined;
}

interface OccurrenceCursor { readonly threadId: string; readonly searchTerm: string; readonly next: number }

/** `thread/searchOccurrences` over user messages and each turn's final agent message, one entry per match. */
export function searchTurnOccurrences(
  threadId: string,
  turns: readonly Turn[],
  params: Omit<ThreadSearchOccurrencesParams, "threadId">,
): ThreadSearchOccurrencesResponse {
  const searchTerm = params.searchTerm;
  if (!searchTerm.trim()) throw invalidRequest("thread/searchOccurrences requires a non-empty searchTerm");
  let next = 0;
  if (params.cursor != null) {
    let parsed: Partial<OccurrenceCursor> | undefined;
    try { parsed = JSON.parse(params.cursor) as Partial<OccurrenceCursor>; } catch { /* reported below */ }
    if (parsed?.threadId !== threadId || parsed.searchTerm !== searchTerm
      || !Number.isInteger(parsed.next) || parsed.next! < 0) throw invalidRequest(`invalid cursor: ${params.cursor}`);
    next = parsed.next!;
  }
  const occurrences = turns.flatMap((turn) => {
    const final = finalAgentItem(turn);
    return turn.items.flatMap((item) => {
      if (item.type !== "userMessage" && item !== final) return [];
      const text = searchableText(item);
      if (!text) return [];
      return findMatches(text, searchTerm).map((match) => {
        const { snippet, start, end } = snippetAround(text, match);
        return { turnId: turn.id, itemId: item.id, snippet, snippetMatchRange: { start, end }, turnCursor: turnCursor(turn.id, true) };
      });
    });
  });
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const data = occurrences.slice(next, next + limit);
  const cursor: OccurrenceCursor = { threadId, searchTerm, next: next + data.length };
  return { data, nextCursor: cursor.next < occurrences.length ? JSON.stringify(cursor) : null };
}
