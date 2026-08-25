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
import { cwdIdentity, filterSortThreads } from "../store/threadFilter.js";

export interface ThreadCatalogProjection {
  projectThreadCatalog(stock: Thread[], claude: Thread[], params?: ThreadListParams): Thread[];
  projectLoadedThreadIds(stock: string[], claude: string[]): string[];
  hiddenBackendIds?(provider?: "stock" | "claude"): Set<string>;
  catalogTombstones?(): string[];
}

export interface RemoteCatalogSnapshot {
  readonly active: readonly Thread[];
  readonly archived: readonly Thread[];
  readonly hiddenPhysicalIds: ReadonlySet<string>;
}

export type CatalogNotificationSink = (method: string, params: unknown) => void;

interface ThreadCursor {
  readonly query: string;
  readonly direction: "asc" | "desc";
  readonly key: "createdAt" | "updatedAt" | "recencyAt" | "sectionEnteredAt";
  readonly value: number;
  readonly id: string;
}

interface OffsetCursor {
  readonly query: string;
  readonly version: string;
  readonly offset: number;
}

function threadKey(params: ThreadListParams): ThreadCursor["key"] {
  return params.sortKey === "updated_at" ? "updatedAt"
    : params.sortKey === "recency_at" ? "recencyAt"
    : params.sortKey === "section_position" ? "sectionEnteredAt"
    : "createdAt";
}

function threadQuery(params: ThreadListParams): string {
  const cwd = params.cwd == null
    ? null
    : (Array.isArray(params.cwd) ? params.cwd : [params.cwd]).map(cwdIdentity);
  return queryFingerprint({
    sortKey: params.sortKey ?? "created_at", modelProviders: params.modelProviders ?? null,
    sourceKinds: params.sourceKinds ?? null, archived: params.archived ?? false, cwd,
    // Tri-state filters: omitted and null are distinct queries.
    sectionId: params.sectionId === undefined ? null : [params.sectionId],
    projectId: params.projectId === undefined ? null : [params.projectId],
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

export class ThreadCatalog {
  public constructor(
    private readonly stock: StockRpc,
    private readonly claude: ClaudeService,
    private readonly cursors: CursorCodec,
    private readonly logical?: ThreadCatalogProjection,
    private readonly sideThreads?: Partial<Pick<StockSideThreads, "filterThreads" | "hiddenIds">>,
  ) {}

  private async projected(params: ThreadListParams): Promise<Thread[]> {
    // Provider-side filtering may hide a physical epoch before it can be
    // projected to its public task. Only the archive partition is safe to
    // apply before projection; every public filter is evaluated exactly once
    // on the unified catalog.
    // Never block the catalog on the Claude SDK: listSessions() can stall for
    // minutes while a turn is active, and the app drops the connection after
    // 30s. Refresh native metadata in the background; it applies next poll.
    void this.claude.refreshNativeMetadata?.();
    const providerParams: ThreadListParams = {
      archived: params.archived ?? false,
      cursor: null,
      limit: 100,
    };
    const [stockCatalog, claudeCatalog] = await Promise.all([
      allStockThreads(this.stock, providerParams),
      Promise.resolve(this.claude.listThreads(providerParams)),
    ]);
    const stockThreads = this.sideThreads?.filterThreads?.(stockCatalog) ?? stockCatalog;
    const projected = this.logical
      ? this.logical.projectThreadCatalog(stockThreads, claudeCatalog, providerParams)
      : [...stockThreads, ...claudeCatalog];
    return filterSortThreads(projected, params);
  }

  public async list(params: ThreadListParams): Promise<ThreadListResponse> {
    const key = threadKey(params);
    const direction = params.sortDirection === "asc" ? "asc" : "desc";
    const query = threadQuery(params);
    const cursor = this.cursors.decode<ThreadCursor>("thread", params.cursor);
    if (cursor && (cursor.query !== query || cursor.direction !== direction || cursor.key !== key
      || typeof cursor.value !== "number" || typeof cursor.id !== "string")) {
      throw invalidParams("Thread pagination query changed; restart pagination.");
    }
    const anchor: Thread | undefined = cursor ? { [key]: cursor.value, id: cursor.id } as unknown as Thread : undefined;
    const catalog = (await this.projected(params))
      .filter((thread) => !anchor || compareThreads(thread, anchor, key, direction) > 0);
    const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
    const data = catalog.slice(0, limit);
    const cursorFor = (thread: Thread, cursorDirection: ThreadCursor["direction"]) => this.cursors.encode("thread", {
      query, direction: cursorDirection, key, value: thread[key] ?? 0, id: thread.id,
    });
    return {
      data,
      nextCursor: data.length < catalog.length ? cursorFor(data[data.length - 1]!, direction) : null,
      backwardsCursor: data.length > 0 ? cursorFor(data[0]!, direction === "asc" ? "desc" : "asc") : null,
    };
  }

  public async loaded(params: ThreadLoadedListParams): Promise<ThreadLoadedListResponse> {
    const hidden = this.sideThreads?.hiddenIds
      ? { hiddenIds: this.sideThreads.hiddenIds.bind(this.sideThreads) }
      : undefined;
    return mergedLoadedList(params, this.stock, this.claude, this.cursors, this.logical, hidden);
  }

  public async remoteSnapshot(): Promise<RemoteCatalogSnapshot> {
    const [active, archived, activeStock, archivedStock, activeClaude, archivedClaude] = await Promise.all([
      this.projected({ archived: false }),
      this.projected({ archived: true }),
      allStockThreads(this.stock, { archived: false }),
      allStockThreads(this.stock, { archived: true }),
      Promise.resolve(this.claude.listThreads({ archived: false })),
      Promise.resolve(this.claude.listThreads({ archived: true })),
    ]);
    const hiddenPhysicalIds = new Set(this.logical?.hiddenBackendIds?.() ?? []);
    for (const id of this.logical?.catalogTombstones?.() ?? []) hiddenPhysicalIds.add(id);
    if (this.sideThreads) {
      for (const id of this.sideThreads.hiddenIds?.([...activeStock, ...archivedStock]) ?? []) hiddenPhysicalIds.add(id);
    }
    const durableRoot = (thread: Thread) => !thread.ephemeral && thread.parentThreadId === null;
    const publicIds = new Set([...active, ...archived].map((thread) => thread.id));
    for (const thread of [...activeStock, ...archivedStock, ...activeClaude, ...archivedClaude]) {
      if (!publicIds.has(thread.id)) hiddenPhysicalIds.add(thread.id);
    }
    return {
      active: active.filter(durableRoot),
      archived: archived.filter(durableRoot),
      hiddenPhysicalIds,
    };
  }

  public async reconcileRemote(sink: CatalogNotificationSink): Promise<void> {
    const snapshot = await this.remoteSnapshot();
    for (const threadId of snapshot.hiddenPhysicalIds) {
      sink("thread/deleted", { threadId });
    }
    const publish = (thread: Thread, archived: boolean) => {
      sink("thread/started", { thread: { ...thread, turns: [] } });
      sink("thread/name/updated", {
        threadId: thread.id,
        ...(thread.name === null ? {} : { threadName: thread.name }),
      });
      sink(archived ? "thread/archived" : "thread/unarchived", { threadId: thread.id });
    };
    for (const thread of snapshot.active) publish(thread, false);
    for (const thread of snapshot.archived) publish(thread, true);
  }
}

export async function mergedThreadList(
  params: ThreadListParams,
  stock: StockRpc,
  claude: ClaudeService,
  cursors: CursorCodec,
  logical?: { projectThreadCatalog(stock: Thread[], claude: Thread[], params?: ThreadListParams): Thread[] },
  sideThreads?: Pick<StockSideThreads, "filterThreads">,
): Promise<ThreadListResponse> {
  return new ThreadCatalog(stock, claude, cursors, logical as ThreadCatalogProjection | undefined, sideThreads).list(params);
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
