import { describe, expect, it } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import { ThreadCatalog, mergedThreadList } from "../../src/gateway/threadList.js";
import { CursorCodec } from "../../src/protocol/cursor.js";
import { filterSortThreads } from "../../src/store/threadFilter.js";

function thread(id: string, createdAt: number, parentThreadId: string | null = null): Thread {
  return {
    id, extra: null, sessionId: id, forkedFromId: null, parentThreadId,
    canAcceptDirectInput: parentThreadId === null, preview: id, ephemeral: false, section: null, sectionEnteredAt: null, projectId: null,
    historyMode: "legacy", modelProvider: "claude", model: null, reasoningEffort: null, createdAt, updatedAt: createdAt, recencyAt: createdAt,
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

  it("treats legacy threads without source as unknown", () => {
    const legacy = thread("legacy", 1);
    Reflect.deleteProperty(legacy, "source");
    expect(filterSortThreads([legacy], { sourceKinds: ["unknown"] })).toEqual([legacy]);
    expect(filterSortThreads([legacy], { sourceKinds: ["subAgentThreadSpawn"] })).toEqual([]);
  });

  it("filters sections tri-state and canonicalizes cwd aliases", () => {
    const pinned = { ...thread("pinned", 2), section: { id: "01984de2-8f74-7c91-a3b2-5c5e937cf318", name: "Pinned", appearance: null }, sectionEnteredAt: 2 };
    const regular = thread("regular", 1);
    expect(filterSortThreads([regular, pinned], { sectionId: "01984de2-8f74-7c91-a3b2-5c5e937cf318" })).toEqual([pinned]);
    expect(filterSortThreads([regular, pinned], { sectionId: null })).toEqual([regular]);
    expect(filterSortThreads([regular, pinned], {}).length).toBe(2);
    expect(filterSortThreads([regular, pinned], { cwd: "/repo/../repo" }).map((item) => item.id))
      .toEqual(["pinned", "regular"]);
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

  it("merges stock and Claude search results onto public threads with snippets", async () => {
    const stockThreads = [thread("stock-4", 4), thread("backend-2", 2)];
    const stock = {
      request: async (method: string) => method === "thread/search"
        ? { data: stockThreads.map((entry) => ({ thread: entry, snippet: `stock ${entry.id}` })), nextCursor: null, backwardsCursor: null }
        : { data: [], nextCursor: null, backwardsCursor: null },
    };
    const claude = { searchThreads: () => [{ thread: thread("claude-3", 3), snippet: "claude hit" }] };
    const logical = {
      projectThreadCatalog: (stockList: Thread[], claudeList: Thread[]) => [
        ...stockList.filter((entry) => entry.id !== "backend-2"), ...claudeList, { ...thread("public-2", 2), id: "public-2" },
      ],
      projectLoadedThreadIds: () => [],
      currentBackendId: (publicId: string) => publicId === "public-2" ? "backend-2" : undefined,
    };
    const catalog = new ThreadCatalog(stock as never, claude as never, new CursorCodec(Buffer.alloc(32, 9)), logical);
    const first = await catalog.search({ searchTerm: " hit ", limit: 2 });
    expect(first.data.map((entry) => [entry.thread.id, entry.snippet])).toEqual([["stock-4", "stock stock-4"], ["claude-3", "claude hit"]]);
    const second = await catalog.search({ searchTerm: " hit ", limit: 2, cursor: first.nextCursor });
    expect(second.data.map((entry) => [entry.thread.id, entry.snippet])).toEqual([["public-2", "stock backend-2"]]);
    expect(second.nextCursor).toBeNull();
    // The App polls for newer results by flipping direction on the backwards cursor.
    const newer = await catalog.search({ searchTerm: " hit ", cursor: first.backwardsCursor, sortDirection: "asc" });
    expect(newer.data).toEqual([]);
    await expect(catalog.search({ searchTerm: "  " })).rejects.toThrow("thread/search requires a non-empty searchTerm");
  });
});
