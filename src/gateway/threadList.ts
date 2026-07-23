import { createHash } from "node:crypto";
import type { Thread } from "../codex/generated/v2/Thread.js";
import type { ThreadListParams } from "../codex/generated/v2/ThreadListParams.js";
import type { ThreadListResponse } from "../codex/generated/v2/ThreadListResponse.js";
import type { ThreadLoadedListParams } from "../codex/generated/v2/ThreadLoadedListParams.js";
import type { ThreadLoadedListResponse } from "../codex/generated/v2/ThreadLoadedListResponse.js";
import type { ClaudeService } from "../claude/service.js";
import type { StockRpc } from "./stockRpc.js";
import { CursorCodec, queryFingerprint } from "../protocol/cursor.js";
import { invalidParams } from "../protocol/errors.js";
import type { StockSideThreads } from "./stockSideThreads.js";

interface ThreadCursor {
  readonly query: string;
  readonly direction: "asc" | "desc";
  readonly key: "createdAt" | "updatedAt" | "recencyAt";
  readonly value: number;
  readonly id: string;
}

interface OffsetCursor {
  readonly query: string;
  readonly version: string;
  readonly offset: number;
}

function threadKey(params: ThreadListParams): ThreadCursor["key"] {
  return params.sortKey === "updated_at" ? "updatedAt" : params.sortKey === "recency_at" ? "recencyAt" : "createdAt";
}

function threadQuery(params: ThreadListParams): string {
  return queryFingerprint({
    sortKey: params.sortKey ?? "created_at", modelProviders: params.modelProviders ?? null,
    sourceKinds: params.sourceKinds ?? null, archived: params.archived ?? false, cwd: params.cwd ?? null,
    useStateDbOnly: params.useStateDbOnly ?? false, searchTerm: params.searchTerm ?? null,
    parentThreadId: params.parentThreadId ?? null, ancestorThreadId: params.ancestorThreadId ?? null,
  });
}

function compareThreads(left: Thread, right: Thread, key: ThreadCursor["key"], direction: ThreadCursor["direction"]): number {
  const sign = direction === "asc" ? 1 : -1;
  return ((((left[key] ?? 0) - (right[key] ?? 0)) || left.id.localeCompare(right.id)) * sign);
}

async function allStockThreads(stock: StockRpc, params: ThreadListParams): Promise<Thread[]> {
  const threads: Thread[] = [];
  let cursor: string | null = null;
  do {
    const result = await stock.request("thread/list", { ...params, cursor, limit: 100 }) as ThreadListResponse;
    threads.push(...result.data);
    cursor = result.nextCursor;
  } while (cursor);
  return threads;
}

export async function mergedThreadList(
  params: ThreadListParams,
  stock: StockRpc,
  claude: ClaudeService,
  cursors: CursorCodec,
  logical?: { projectThreadCatalog(stock: Thread[], claude: Thread[], params?: ThreadListParams): Thread[] },
  sideThreads?: Pick<StockSideThreads, "filterThreads">,
): Promise<ThreadListResponse> {
  const [stockCatalog, claudeThreads] = await Promise.all([
    allStockThreads(stock, { ...params, cursor: null }),
    Promise.resolve(claude.listThreads({ ...params, cursor: null })),
  ]);
  const stockThreads = sideThreads?.filterThreads(stockCatalog) ?? stockCatalog;
  const key = threadKey(params);
  const direction = params.sortDirection === "asc" ? "asc" : "desc";
  const query = threadQuery(params);
  const cursor = cursors.decode<ThreadCursor>("thread", params.cursor);
  if (cursor && (cursor.query !== query || cursor.direction !== direction || cursor.key !== key || typeof cursor.value !== "number" || typeof cursor.id !== "string")) {
    throw invalidParams("Thread pagination query changed; restart pagination.");
  }
  const anchor: Thread | undefined = cursor ? { [key]: cursor.value, id: cursor.id } as unknown as Thread : undefined;
  const catalog = (logical ? logical.projectThreadCatalog(stockThreads, claudeThreads, params) : [...stockThreads, ...claudeThreads])
    .sort((left, right) => compareThreads(left, right, key, direction))
    .filter((thread) => !anchor || compareThreads(thread, anchor, key, direction) > 0);
  const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
  const data = catalog.slice(0, limit);
  const cursorFor = (thread: Thread, cursorDirection: ThreadCursor["direction"]) => cursors.encode("thread", {
    query, direction: cursorDirection, key, value: thread[key] ?? 0, id: thread.id,
  });
  return {
    data,
    nextCursor: data.length < catalog.length ? cursorFor(data[data.length - 1]!, direction) : null,
    backwardsCursor: data.length > 0 ? cursorFor(data[0]!, direction === "asc" ? "desc" : "asc") : null,
  };
}

async function allStockLoaded(stock: StockRpc): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const result = await stock.request("thread/loaded/list", { cursor, limit: 100 }) as ThreadLoadedListResponse;
    ids.push(...result.data);
    cursor = result.nextCursor;
  } while (cursor);
  return ids;
}

export async function mergedLoadedList(
  params: ThreadLoadedListParams,
  stock: StockRpc,
  claude: ClaudeService,
  cursors: CursorCodec,
  logical?: { projectLoadedThreadIds(stock: string[], claude: string[]): string[] },
  sideThreads?: Pick<StockSideThreads, "hiddenIds">,
): Promise<ThreadLoadedListResponse> {
  const [stockIds, stockThreads] = await Promise.all([
    allStockLoaded(stock),
    sideThreads ? allStockThreads(stock, { cursor: null }) : Promise.resolve([]),
  ]);
  const hidden = sideThreads?.hiddenIds(stockThreads) ?? new Set<string>();
  const visibleStockIds = stockIds.filter((id) => !hidden.has(id));
  const claudeIds = claude.loadedThreadIds();
  const data = logical
    ? logical.projectLoadedThreadIds(visibleStockIds, claudeIds)
    : [...new Set([...visibleStockIds, ...claudeIds])];
  const version = createHash("sha256").update(data.join("\0")).digest("hex").slice(0, 16);
  const query = queryFingerprint({});
  const cursor = cursors.decode<OffsetCursor>("loaded", params.cursor);
  if (cursor && (cursor.query !== query || cursor.version !== version || !Number.isInteger(cursor.offset) || cursor.offset < 0)) {
    throw invalidParams("Loaded-thread catalog changed; restart pagination.");
  }
  const offset = cursor?.offset ?? 0;
  const limit = Math.max(1, params.limit ?? Math.max(data.length, 1));
  const page = data.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return { data: page, nextCursor: nextOffset < data.length ? cursors.encode("loaded", { query, version, offset: nextOffset }) : null };
}
