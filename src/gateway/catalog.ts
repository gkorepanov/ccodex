import { invalidParams, invalidRequest, type JsonObject, type Thread } from "../protocol/codex.js";
import type { Connection } from "./connection.js";
import type { Gateway } from "./server.js";

type SortKey = "createdAt" | "updatedAt" | "recencyAt";

interface StockCache {
  readonly key: string;
  readonly at: number;
  readonly threads: Thread[];
  next: string | null;
  done: boolean;
}

const CACHE_MS = 10_000;

function sortKey(params: JsonObject): SortKey {
  return params.sortKey === "updated_at" ? "updatedAt" : params.sortKey === "recency_at" ? "recencyAt" : "createdAt";
}

function encodeCursor(value: { key: string; offset: number }): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(cursor: string | null | undefined, key: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { key: string; offset: number };
    if (value.key === key) return value.offset;
  } catch {
    // fall through
  }
  throw invalidParams("Thread pagination query changed; restart pagination.");
}

function sourceKind(thread: Thread): string {
  const source = thread.source as unknown;
  if (typeof source === "string") return source;
  if (source && typeof source === "object" && "subAgent" in source) {
    const sub = (source as { subAgent: unknown }).subAgent;
    if (sub && typeof sub === "object" && "thread_spawn" in sub) return "subAgentThreadSpawn";
    return "subAgentOther";
  }
  return "unknown";
}

/**
 * `thread/list` & co: stock's pages (same filters) merged with Claude sessions filtered the same way.
 * Lineage backends other than the public one are hidden; lineage rows show the current backend's state.
 */
export class Catalog {
  private stockCache?: StockCache;

  public constructor(private readonly gateway: Gateway) {}

  private claudeMatches(thread: Thread, params: JsonObject): boolean {
    const meta = this.gateway.meta;
    if ((params.archived ?? false) !== meta.isArchived(thread.id)) return false;
    if (params.modelProviders?.length && !params.modelProviders.includes("claude")) return false;
    const kinds: string[] | undefined = params.sourceKinds?.length ? params.sourceKinds : undefined;
    if (kinds ? !kinds.includes(sourceKind(thread)) : thread.parentThreadId) return false;
    if (params.cwd) {
      const cwds: string[] = Array.isArray(params.cwd) ? params.cwd : [params.cwd];
      if (!cwds.includes(thread.cwd)) return false;
    }
    if (params.sectionId !== undefined) {
      const section = meta.section(thread.id)?.sectionId ?? null;
      if (section !== params.sectionId) return false;
    }
    if (params.projectId) return false;
    if (params.parentThreadId && thread.parentThreadId !== meta.rowId(params.parentThreadId)) return false;
    if (params.searchTerm) {
      const term = String(params.searchTerm).toLowerCase();
      if (!`${thread.name ?? ""}\n${thread.preview}`.toLowerCase().includes(term)) return false;
    }
    return true;
  }

  private async claudeThreads(params: JsonObject): Promise<Thread[]> {
    const publicAncestor: string | undefined = params.ancestorThreadId ?? params.parentThreadId ?? undefined;
    const ancestor = publicAncestor && this.gateway.meta.rowId(publicAncestor);
    const claude = this.gateway.claude;
    let threads = claude.threads();
    if (ancestor && claude.owns(ancestor)) threads = await claude.subagentThreads(ancestor);
    else if (ancestor) threads = [];
    return threads.filter((thread) => this.claudeMatches(thread, params));
  }

  /**
   * Stock threads for one filter set, fetched only as far as needed, in pages of the client's size: stock's
   * paging depends on the page size, so this walks exactly the pages the client would get from stock itself.
   */
  private async stockThreads(connection: Connection, params: JsonObject, needed: number, fresh: boolean): Promise<Thread[]> {
    const { cursor: _cursor, ...filters } = params;
    const key = JSON.stringify(filters);
    if (fresh || !this.stockCache || this.stockCache.key !== key || Date.now() - this.stockCache.at > CACHE_MS) {
      this.stockCache = { key, at: Date.now(), threads: [], next: null, done: false };
    }
    const cache = this.stockCache;
    while (!cache.done && cache.threads.length < needed) {
      const page = await connection.upstream.request("thread/list", { ...filters, cursor: cache.next });
      cache.threads.push(...page.data);
      cache.next = page.nextCursor;
      cache.done = !page.nextCursor;
    }
    return cache.threads;
  }

  /** Lineage backends are hidden; a lineage's public row carries its current backend's live state. */
  private async project(threads: Thread[]): Promise<Thread[]> {
    return Promise.all(threads.filter((thread) => !this.gateway.meta.hidden(thread.id)).map((thread) => this.gateway.lineages.projectRow(thread)));
  }

  /** Position of a row in the requested order: negative sorts first. */
  private order(params: JsonObject): (thread: Thread) => number {
    const key = sortKey(params);
    const direction = params.sortDirection === "asc" ? 1 : -1;
    return (thread) => direction * Number(thread[key] ?? thread.updatedAt ?? 0);
  }

  private merge(stock: Thread[], claude: Thread[], params: JsonObject): Thread[] {
    const order = this.order(params);
    if (params.sortKey === "section_position") return this.sectionOrdered(params.sectionId, stock, claude);
    const claudeSorted = [...claude].sort((left, right) => order(left) - order(right) || left.id.localeCompare(right.id));
    const merged: Thread[] = [];
    let s = 0;
    let c = 0;
    while (s < stock.length || c < claudeSorted.length) {
      const takeStock = c >= claudeSorted.length
        || (s < stock.length && order(stock[s]!) <= order(claudeSorted[c]!));
      merged.push(takeStock ? stock[s++]! : claudeSorted[c++]!);
    }
    return merged;
  }

  /**
   * A section's manual order over stock and Claude threads (recorded once a Claude thread is in it); threads that
   * entered later keep stock's order, then Claude's by entry time, at the end.
   */
  private sectionOrdered(sectionId: string | null | undefined, stock: Thread[], claude: Thread[]): Thread[] {
    const order = sectionId ? this.gateway.meta.sectionOrder(sectionId) : [];
    const rank = (thread: Thread) => {
      const index = order.indexOf(thread.id);
      return index >= 0 ? index : order.length;
    };
    const entered = [...claude].sort((left, right) => Number(left.sectionEnteredAt ?? 0) - Number(right.sectionEnteredAt ?? 0));
    return [...stock, ...entered].sort((left, right) => rank(left) - rank(right));
  }

  public async list(connection: Connection, params: JsonObject): Promise<JsonObject> {
    const limit = Math.max(1, Math.min(Number(params.limit ?? 50), 200));
    const { cursor: _cursor, limit: _limit, ...filters } = params;
    const key = JSON.stringify(filters);
    const offset = decodeCursor(params.cursor, key);
    if (!params.cursor) {
      await Promise.all([this.gateway.claude.catalog.refresh(), this.refreshSections(), this.gateway.claude.models().catch(() => undefined)]);
    }
    const claude = await this.project(await this.claudeThreads(params));
    const stock = await this.stockThreads(connection, { ...params, limit }, offset + limit, !params.cursor);
    const complete = this.stockCache!.done;
    const shown = await this.project(stock);
    let merged = this.merge(shown, claude, params);
    // Without all stock rows, only the part of the merge that no unseen stock row can precede is final (the last
    // stock row read may itself be hidden or projected: its sort value is the boundary).
    if (!complete && stock.length) {
      const order = this.order(params);
      const boundary = order(stock.at(-1)!);
      const seen = new Set(shown);
      merged = merged.filter((thread) => seen.has(thread) || order(thread) <= boundary);
    }
    const data = merged.slice(offset, offset + limit);
    const more = offset + limit < merged.length || !complete;
    return {
      data,
      nextCursor: more && data.length ? encodeCursor({ key, offset: offset + data.length }) : null,
      backwardsCursor: null,
    };
  }

  private async refreshSections(): Promise<void> {
    const { data } = await this.gateway.stock.request("threadSection/list", { limit: 100 });
    this.gateway.sections.clear();
    for (const section of data) this.gateway.sections.set(section.id, section);
  }

  public async search(connection: Connection, params: JsonObject): Promise<JsonObject> {
    const searchTerm = String(params.searchTerm ?? "").trim();
    if (!searchTerm) throw invalidRequest("thread/search requires a non-empty searchTerm");
    const key = sortKey(params);
    const direction = params.sortDirection === "asc" ? 1 : -1;
    const limit = Math.max(1, Math.min(Number(params.limit ?? 25), 100));
    const queryKey = JSON.stringify({ searchTerm, archived: params.archived, sourceKinds: params.sourceKinds, key, direction });
    const offset = decodeCursor(params.cursor, queryKey);
    // Only as many stock results as this page needs (a full stock search takes seconds), in the client's pages.
    const stockResults: JsonObject[] = [];
    let cursor: string | null = null;
    do {
      const page: JsonObject = await connection.upstream.request("thread/search", { ...params, searchTerm, cursor, limit });
      stockResults.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor && stockResults.length < offset + limit);
    const claude = (await this.project(await this.claudeThreads({ archived: params.archived, sourceKinds: params.sourceKinds, searchTerm })))
      .map((thread) => ({ thread, snippet: thread.name ?? thread.preview.slice(0, 120) }));
    const visible = stockResults.filter((result) => !this.gateway.meta.hidden(result.thread.id));
    let all = [...visible, ...claude].sort((left, right) =>
      direction * (Number(left.thread[key] ?? 0) - Number(right.thread[key] ?? 0)));
    // Without all stock results, only the part no unseen stock result can precede is final.
    if (cursor && visible.length) all = all.slice(0, all.indexOf(visible.at(-1)!) + 1);
    const data = all.slice(offset, offset + limit);
    return {
      data,
      nextCursor: offset + limit < all.length || (cursor && data.length) ? encodeCursor({ key: queryKey, offset: offset + data.length }) : null,
      backwardsCursor: null,
    };
  }

  public async loaded(connection: Connection, params: JsonObject): Promise<JsonObject> {
    const stock: string[] = [];
    let cursor: string | null = null;
    do {
      const page: JsonObject = await connection.upstream.request("thread/loaded/list", { cursor, limit: 100 });
      stock.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const rewrites = this.gateway.meta.rewrites;
    const ids = [...stock, ...this.gateway.claude.loadedIds()].map((id) => rewrites.get(id) ?? id)
      .filter((id) => !this.gateway.meta.hidden(id));
    const unique = [...new Set(ids)];
    const limit = Math.max(1, Math.min(Number(params.limit ?? 100), 100));
    const offset = decodeCursor(params.cursor, "loaded");
    const data = unique.slice(offset, offset + limit);
    return { data, nextCursor: offset + limit < unique.length ? encodeCursor({ key: "loaded", offset: offset + limit }) : null };
  }

  /**
   * `thread/section/move`: stock orders its own threads, Claude threads live in meta. Once a section holds a
   * Claude thread its merged manual order is recorded, and a stock thread is placed before the next stock one.
   */
  public async moveInSection(connection: Connection, params: JsonObject): Promise<JsonObject> {
    const { threadId, sectionId, beforeThreadId } = params as { threadId: string; sectionId: string | null; beforeThreadId?: string | null };
    const meta = this.gateway.meta;
    const isClaude = (id: string) => this.gateway.claude.owns(meta.rowId(id));
    const members = sectionId === null ? [] : (await this.list(connection, { sectionId, sortKey: "section_position", limit: 200, archived: false })).data as Thread[];
    const order = members.map((thread) => thread.id).filter((id) => id !== threadId);
    if (!isClaude(threadId) && !order.some(isClaude)) return connection.upstream.request("thread/section/move", { ...params, threadId: meta.rowId(threadId) });
    const at = beforeThreadId ? order.indexOf(beforeThreadId) : -1;
    order.splice(at < 0 ? order.length : at, 0, threadId);
    if (isClaude(threadId)) {
      meta.setSection(meta.rowId(threadId), sectionId);
    } else {
      const next = order.slice(order.indexOf(threadId) + 1).find((id) => !isClaude(id));
      await connection.upstream.request("thread/section/move", { threadId: meta.rowId(threadId), sectionId, beforeThreadId: next ? meta.rowId(next) : null });
    }
    if (sectionId) meta.setSectionOrder(sectionId, order);
    return {};
  }

  /** Mobile (codex-backend) learns about threads from notifications: announce every Claude thread once. */
  public async announce(connection: Connection): Promise<void> {
    for (const thread of this.gateway.claude.threads()) {
      if (thread.parentThreadId) continue;
      connection.notify("thread/started", { thread: { ...thread, turns: [] } });
      if (thread.name) connection.notify("thread/name/updated", { threadId: thread.id, threadName: thread.name });
      connection.notify(this.gateway.meta.isArchived(thread.id) ? "thread/archived" : "thread/unarchived", { threadId: thread.id });
    }
    for (const segments of Object.values(this.gateway.meta.lineages)) {
      for (const { threadId } of segments) {
        if (this.gateway.meta.hidden(threadId)) connection.send(JSON.stringify({ method: "thread/deleted", params: { threadId } }), true);
      }
    }
  }
}
