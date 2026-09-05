import { describe, expect, it } from "vitest";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import { findMatches, searchTurnOccurrences, snippetAround, threadSearchSnippet } from "../../src/protocol/search.js";
import { summaryItems, turnCursor } from "../../src/protocol/turnPagination.js";

const user = (id: string, ...texts: string[]) => ({
  type: "userMessage" as const, id, clientId: null,
  content: texts.map((text) => ({ type: "text" as const, text, text_elements: [] })),
});
const agent = (id: string, text: string, phase: "final_answer" | "commentary" | null) => ({
  type: "agentMessage" as const, id, text, phase, memoryCitation: null, delivery: null, questions: null,
});
const turn = (id: string, items: Turn["items"], status: Turn["status"] = "completed"): Turn => ({
  id, items, itemsView: "full", status, error: null, startedAt: 1, completedAt: 2, durationMs: 1000,
});

describe("search", () => {
  it("finds case-insensitive non-overlapping matches and builds stock-style snippets", () => {
    expect(findMatches("aaa", "aa")).toEqual([{ start: 0, end: 2 }]);
    expect(findMatches("Needle needle", "NEEDLE")).toEqual([{ start: 0, end: 6 }, { start: 7, end: 13 }]);
    const long = `${"x".repeat(60)} needle ${"y".repeat(120)}`;
    const snippet = snippetAround(long, findMatches(long, "needle")[0]!);
    expect(snippet.snippet.startsWith("... ")).toBe(true);
    expect(snippet.snippet.endsWith(" ...")).toBe(true);
    expect(snippet.snippet.slice(snippet.start, snippet.end)).toBe("needle");
    expect(snippet.snippet.length).toBe(4 + 48 + 6 + 96 + 4);
    const astral = "😀😀 needle";
    const range = snippetAround(astral, findMatches(astral, "needle")[0]!);
    expect(range).toEqual({ snippet: astral, start: 5, end: 11 });
    // Case folding that changes length ("İ" lower-cases to two UTF-16 units) still reports original offsets.
    expect(findMatches("İstanbul İ", "i")).toEqual([{ start: 0, end: 1 }, { start: 9, end: 10 }]);
    expect(findMatches("İstanbul", "istanbul")).toEqual([]);
    expect(findMatches("ǅemal", "ǆemal")).toEqual([{ start: 0, end: 5 }]);
  });

  it("indexes user messages and each turn's final agent message, one occurrence per match", () => {
    const turns = [
      turn("t1", [user("u1", "find ", " Needle"), agent("c1", "needle in commentary", "commentary"), agent("a1", "first needle\n\nsecond   needle", "final_answer")]),
      turn("t2", [user("u2", "nothing"), agent("a2", "needle without phase", null)], "inProgress"),
      turn("t3", [user("u3", "nothing"), agent("a3", "needle without phase", null)]),
    ];
    const all = searchTurnOccurrences("thread", turns, { searchTerm: "needle" });
    expect(all.data.map((entry) => [entry.turnId, entry.itemId, entry.snippet, entry.snippetMatchRange])).toEqual([
      ["t1", "u1", "findNeedle", { start: 4, end: 10 }],
      ["t1", "a1", "first needle second needle", { start: 6, end: 12 }],
      ["t1", "a1", "first needle second needle", { start: 20, end: 26 }],
      ["t3", "a3", "needle without phase", { start: 0, end: 6 }],
    ]);
    expect(all.data[0]!.turnCursor).toBe(turnCursor("t1", true));
    expect(all.nextCursor).toBeNull();
    const first = searchTurnOccurrences("thread", turns, { searchTerm: "needle", limit: 3 });
    expect(first.data).toHaveLength(3);
    const second = searchTurnOccurrences("thread", turns, { searchTerm: "needle", limit: 3, cursor: first.nextCursor });
    expect(second.data.map((entry) => entry.itemId)).toEqual(["a3"]);
    expect(second.nextCursor).toBeNull();
    expect(() => searchTurnOccurrences("thread", turns, { searchTerm: "other", cursor: first.nextCursor }))
      .toThrow("invalid cursor");
    expect(() => searchTurnOccurrences("thread", turns, { searchTerm: "  " })).toThrow("non-empty searchTerm");
    expect(threadSearchSnippet(turns, "commentary")).toBe("needle in commentary");
    expect(threadSearchSnippet(turns, "absent")).toBeUndefined();
  });

  it("summarizes a turn as the first user message plus the final answer", () => {
    const items = [user("u1", "a"), user("u2", "b"), agent("c", "c", "commentary"), agent("f", "f", "final_answer"), agent("l", "l", null)];
    expect(summaryItems(turn("t", items)).map((item) => item.id)).toEqual(["u1", "f"]);
    expect(summaryItems(turn("t", [user("u1", "a"), agent("l", "l", null)])).map((item) => item.id)).toEqual(["u1", "l"]);
    const running = [user("u1", "a"), agent("f", "f", "final_answer"), agent("c", "c", "commentary")];
    expect(summaryItems(turn("t", running, "inProgress")).map((item) => item.id)).toEqual(["u1", "c"]);
  });
});
