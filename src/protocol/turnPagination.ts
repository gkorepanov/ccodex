import type { ThreadItemsListParams } from "../codex/generated/v2/ThreadItemsListParams.js";
import type { ThreadItemsListResponse } from "../codex/generated/v2/ThreadItemsListResponse.js";
import type { ThreadTurnsListParams } from "../codex/generated/v2/ThreadTurnsListParams.js";
import type { ThreadTurnsListResponse } from "../codex/generated/v2/ThreadTurnsListResponse.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import { invalidRequest } from "./errors.js";

interface AnchorCursor {
  anchor: string;
  includeAnchor: boolean;
}

type CursorKey = "turnId" | "itemId";

function encodeCursor(key: CursorKey, anchor: string, includeAnchor: boolean): string {
  return JSON.stringify({ [key]: anchor, includeAnchor });
}

export function turnCursor(turnId: string, includeAnchor: boolean): string {
  return encodeCursor("turnId", turnId, includeAnchor);
}

export function itemCursor(itemId: string, includeAnchor: boolean): string {
  return encodeCursor("itemId", itemId, includeAnchor);
}

function anchorCursor(key: CursorKey, cursor: string): AnchorCursor | undefined {
  try {
    const parsed = JSON.parse(cursor) as Record<string, unknown>;
    if (typeof parsed[key] === "string" && typeof parsed.includeAnchor === "boolean") {
      return { anchor: parsed[key], includeAnchor: parsed.includeAnchor };
    }
  } catch {
    // Report the same opaque-cursor error as stock Codex below.
  }
  return undefined;
}

function legacyOffset(cursor: string, prefixes: readonly string[]): number | undefined {
  const prefix = prefixes.find((candidate) => cursor.startsWith(candidate));
  if (!prefix) return undefined;
  const offset = Number(cursor.slice(prefix.length));
  return Number.isInteger(offset) && offset >= 0 ? offset : undefined;
}

interface PageParams {
  cursor?: string | null;
  limit?: number | null;
  sortDirection?: "asc" | "desc" | null;
}
type SortDirection = "asc" | "desc";

/** Stock-style anchor pagination over a chronological list: cursors name an entry and whether it is included. */
function paginate<T>(
  entries: readonly T[],
  key: CursorKey,
  idOf: (entry: T) => string,
  params: PageParams,
  legacyPrefixes: readonly string[],
  defaultDirection: SortDirection,
): { data: T[]; nextCursor: string | null; backwardsCursor: string | null } {
  if (entries.length === 0) return { data: [], nextCursor: null, backwardsCursor: null };
  const direction = params.sortDirection ?? defaultDirection;
  let keyed = entries.map((entry, index) => ({ entry, index }));
  if (direction === "desc") keyed.reverse();
  if (params.cursor !== undefined && params.cursor !== null) {
    const anchor = anchorCursor(key, params.cursor);
    if (anchor) {
      const anchorIndex = entries.findIndex((entry) => idOf(entry) === anchor.anchor);
      if (anchorIndex < 0) throw invalidRequest("invalid cursor: anchor is no longer present");
      keyed = keyed.filter(({ index }) => direction === "asc"
        ? anchor.includeAnchor ? index >= anchorIndex : index > anchorIndex
        : anchor.includeAnchor ? index <= anchorIndex : index < anchorIndex);
    } else {
      const offset = legacyOffset(params.cursor, legacyPrefixes);
      if (offset === undefined) throw invalidRequest(`invalid cursor: ${params.cursor}`);
      keyed = keyed.slice(offset);
    }
  }
  const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
  const page = keyed.slice(0, limit).map(({ entry }) => entry);
  return {
    data: page,
    nextCursor: keyed.length > limit ? encodeCursor(key, idOf(page.at(-1)!), false) : null,
    backwardsCursor: page.length ? encodeCursor(key, idOf(page[0]!), true) : null,
  };
}

export function paginateTurns(
  turns: readonly Turn[],
  params: Omit<ThreadTurnsListParams, "threadId">,
  legacyPrefixes: readonly string[] = [],
): ThreadTurnsListResponse {
  const page = paginate(turns, "turnId", (turn) => turn.id, params, legacyPrefixes, "desc");
  const itemsView = params.itemsView ?? "summary";
  return {
    ...page,
    data: page.data.map((turn) => ({ ...turn, itemsView, ...(itemsView === "notLoaded" ? { items: [] } : {}) })),
  };
}

export function paginateItems(
  turns: readonly Turn[],
  params: Omit<ThreadItemsListParams, "threadId">,
  legacyPrefixes: readonly string[] = [],
): ThreadItemsListResponse {
  const entries = turns.flatMap((turn) => params.turnId && turn.id !== params.turnId
    ? []
    : turn.items.map((item) => ({ turnId: turn.id, item })));
  return paginate(entries, "itemId", (entry) => entry.item.id, params, legacyPrefixes, "asc");
}

/** Top-level resume/read/revert cursors: point inclusively at the newest turn and item, like stock paginated threads. */
export function historyCursors(turns: readonly Turn[]): {
  turnsBackwardsCursor: string | null;
  itemsBackwardsCursor: string | null;
} {
  const lastItem = turns.findLast((turn) => turn.items.length)?.items.at(-1);
  return {
    turnsBackwardsCursor: turns.length ? turnCursor(turns.at(-1)!.id, true) : null,
    itemsBackwardsCursor: lastItem ? itemCursor(lastItem.id, true) : null,
  };
}
