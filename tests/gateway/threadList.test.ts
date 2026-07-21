import { describe, expect, it } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import { mergedThreadList } from "../../src/gateway/threadList.js";
import { CursorCodec } from "../../src/protocol/cursor.js";
import { filterSortThreads } from "../../src/store/threadFilter.js";

function thread(id: string, createdAt: number, parentThreadId: string | null = null): Thread {
  return {
    id, extra: null, sessionId: id, forkedFromId: null, parentThreadId, preview: id, ephemeral: false,
    historyMode: "legacy", modelProvider: "claude", createdAt, updatedAt: createdAt, recencyAt: createdAt,
    status: { type: "idle" }, path: null, cwd: "/repo", cliVersion: "test", source: "appServer",
    threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: id, turns: [],
  };
}

describe("merged thread listing", () => {
  it("applies source and ancestor filters", () => {
    const threads = [thread("root", 1), thread("child", 2, "root"), thread("grandchild", 3, "child")];
    expect(filterSortThreads(threads, { sourceKinds: ["appServer"], ancestorThreadId: "root", sortDirection: "asc" }).map((item) => item.id))
      .toEqual(["child", "grandchild"]);
    expect(() => filterSortThreads(threads, { parentThreadId: "root", ancestorThreadId: "root" })).toThrow("mutually exclusive");
  });

  it("uses stable signed keyset cursors in both directions", async () => {
    const stockThreads = [thread("stock-4", 4), thread("stock-2", 2)];
    const claudeThreads = [thread("claude-3", 3), thread("claude-1", 1)];
    const stock = { request: async () => ({ data: stockThreads, nextCursor: null, backwardsCursor: null }) };
    const claude = { listThreads: () => claudeThreads };
    const cursors = new CursorCodec(Buffer.alloc(32, 9));
    const first = await mergedThreadList({ limit: 2, sortDirection: "desc" }, stock as never, claude as never, cursors);
    const second = await mergedThreadList({ limit: 2, sortDirection: "desc", cursor: first.nextCursor }, stock as never, claude as never, cursors);
    expect(first.data.map((item) => item.id)).toEqual(["stock-4", "claude-3"]);
    expect(second.data.map((item) => item.id)).toEqual(["stock-2", "claude-1"]);
    const backwards = await mergedThreadList({ limit: 2, sortDirection: "asc", cursor: second.backwardsCursor }, stock as never, claude as never, cursors);
    expect(backwards.data.map((item) => item.id)).toEqual(["claude-3", "stock-4"]);
    await expect(mergedThreadList({ limit: 2, sortDirection: "desc", cursor: `${first.nextCursor}x` }, stock as never, claude as never, cursors)).rejects.toThrow("signature");
  });
});
