import type { ThreadTurnsListParams } from "../codex/generated/v2/ThreadTurnsListParams.js";
import type { ThreadTurnsListResponse } from "../codex/generated/v2/ThreadTurnsListResponse.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import { invalidRequest } from "./errors.js";

interface TurnCursor {
  turnId: string;
  includeAnchor: boolean;
}

export function turnCursor(turnId: string, includeAnchor: boolean): string {
  return JSON.stringify({ turnId, includeAnchor } satisfies TurnCursor);
}

function anchorCursor(cursor: string): TurnCursor | undefined {
  try {
    const parsed = JSON.parse(cursor) as Partial<TurnCursor>;
    if (typeof parsed.turnId === "string" && typeof parsed.includeAnchor === "boolean") {
      return { turnId: parsed.turnId, includeAnchor: parsed.includeAnchor };
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

export function paginateTurns(
  turns: readonly Turn[],
  params: Omit<ThreadTurnsListParams, "threadId">,
  legacyPrefixes: readonly string[] = [],
): ThreadTurnsListResponse {
  if (turns.length === 0) return { data: [], nextCursor: null, backwardsCursor: null };

  const direction = params.sortDirection ?? "desc";
  let keyed = turns.map((turn, index) => ({ turn, index }));
  if (direction === "desc") keyed.reverse();

  if (params.cursor !== undefined && params.cursor !== null) {
    const anchor = anchorCursor(params.cursor);
    if (anchor) {
      const anchorIndex = turns.findIndex((turn) => turn.id === anchor.turnId);
      if (anchorIndex < 0) throw invalidRequest("invalid cursor: anchor turn is no longer present");
      keyed = keyed.filter(({ index }) => direction === "asc"
        ? anchor.includeAnchor ? index >= anchorIndex : index > anchorIndex
        : anchor.includeAnchor ? index <= anchorIndex : index < anchorIndex);
    } else {
      const offset = legacyOffset(params.cursor, legacyPrefixes);
      if (offset === undefined) throw invalidRequest(`invalid cursor: ${params.cursor}`);
      keyed = keyed.slice(offset);
    }
  }

  const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
  const hasMore = keyed.length > limit;
  const page = keyed.slice(0, limit);
  const itemsView = params.itemsView ?? "summary";
  const data = page.map(({ turn }) => ({
    ...turn,
    itemsView,
    ...(itemsView === "notLoaded" ? { items: [] } : {}),
  }));
  return {
    data,
    nextCursor: hasMore ? turnCursor(page.at(-1)!.turn.id, false) : null,
    backwardsCursor: page.length ? turnCursor(page[0]!.turn.id, true) : null,
  };
}
