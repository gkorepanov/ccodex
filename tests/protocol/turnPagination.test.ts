import { describe, expect, it } from "vitest";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import { historyCursors, itemCursor, paginateItems, paginateTurns, turnCursor } from "../../src/protocol/turnPagination.js";

function turn(id: string, itemIds: readonly string[]): Turn {
  return {
    id, itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000,
    items: itemIds.map((itemId) => ({
      type: "agentMessage", id: itemId, text: itemId, phase: null, memoryCitation: null, delivery: null, questions: null,
    })),
  };
}

const turns = [turn("t1", ["i1", "i2"]), turn("t2", []), turn("t3", ["i3", "i4", "i5"])];

describe("anchor pagination", () => {
  it("pages items chronologically by default and reverses from the same anchor", () => {
    const first = paginateItems(turns, { limit: 2 });
    expect(first.data.map((entry) => entry.item.id)).toEqual(["i1", "i2"]);
    expect(first).toMatchObject({ nextCursor: itemCursor("i2", false), backwardsCursor: itemCursor("i1", true) });
    const second = paginateItems(turns, { limit: 2, cursor: first.nextCursor });
    expect(second.data.map((entry) => ({ turn: entry.turnId, item: entry.item.id })))
      .toEqual([{ turn: "t3", item: "i3" }, { turn: "t3", item: "i4" }]);
    const newest = paginateItems(turns, { limit: 2, sortDirection: "desc" });
    expect(newest.data.map((entry) => entry.item.id)).toEqual(["i5", "i4"]);
    expect(newest.backwardsCursor).toBe(itemCursor("i5", true));
    // The App flips direction on the backwards cursor to poll for newer entries; the anchor stays inclusive.
    expect(paginateItems(turns, { cursor: newest.backwardsCursor, sortDirection: "asc" }).data.map((entry) => entry.item.id))
      .toEqual(["i5"]);
    expect(paginateItems(turns, { turnId: "t3", sortDirection: "desc", limit: 10 }).data.map((entry) => entry.item.id))
      .toEqual(["i5", "i4", "i3"]);
    expect(paginateItems(turns, { cursor: "hyb-item:4" }, ["hyb-item:"]).data.map((entry) => entry.item.id)).toEqual(["i5"]);
    expect(() => paginateItems(turns, { cursor: "hyb-item:4" })).toThrow("invalid cursor: hyb-item:4");
    expect(() => paginateItems(turns, { cursor: itemCursor("gone", true) })).toThrow("anchor is no longer present");
  });

  it("resolves item anchors across the whole thread so one tail cursor loads every turn, like stock ordinals", () => {
    const tail = historyCursors(turns).itemsBackwardsCursor;
    const perTurn = (turnId: string, sortDirection: "asc" | "desc") =>
      paginateItems(turns, { turnId, cursor: tail, limit: 100, sortDirection }).data.map((entry) => entry.item.id);
    expect(perTurn("t3", "desc")).toEqual(["i5", "i4", "i3"]);
    expect(perTurn("t1", "desc")).toEqual(["i2", "i1"]);
    expect(perTurn("t2", "desc")).toEqual([]);
    expect(perTurn("t1", "asc")).toEqual([]);
    expect(paginateItems(turns, { turnId: "t3", cursor: itemCursor("i2", false) }).data.map((entry) => entry.item.id))
      .toEqual(["i3", "i4", "i5"]);
    expect(paginateItems(turns, { turnId: "t1", cursor: "hyb-item:1" }, ["hyb-item:"]).data.map((entry) => entry.item.id))
      .toEqual(["i2"]);
  });

  it("pages turns newest-first by default and reports inclusive top-level cursors", () => {
    const page = paginateTurns(turns, { limit: 2 });
    expect(page.data.map((entry) => entry.id)).toEqual(["t3", "t2"]);
    expect(page.nextCursor).toBe(turnCursor("t2", false));
    expect(paginateTurns(turns, { cursor: page.nextCursor }).data.map((entry) => entry.id)).toEqual(["t1"]);
    expect(historyCursors(turns)).toEqual({ turnsBackwardsCursor: turnCursor("t3", true), itemsBackwardsCursor: itemCursor("i5", true) });
    expect(historyCursors([turn("t9", [])])).toEqual({ turnsBackwardsCursor: turnCursor("t9", true), itemsBackwardsCursor: null });
    expect(historyCursors([])).toEqual({ turnsBackwardsCursor: null, itemsBackwardsCursor: null });
  });
});
