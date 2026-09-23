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

  /** Stock threads for one filter set, fetched page by page only as far as needed. */
  private async stockThreads(connection: Connection, params: JsonObject, needed: number, fresh: boolean): Promise<Thread[]> {
    const { cursor: _cursor, limit: _limit, ...filters } = params;
    const key = JSON.stringify(filters);
    if (fresh || !this.stockCache || this.stockCache.key !== key || Date.now() - this.stockCache.at > CACHE_MS) {
      this.stockCache = { key, at: Date.now(), threads: [], next: null, done: false };
    }
    const cache = this.stockCache;
    while (!cache.done && cache.threads.length < needed) {
      const page = await connection.upstream.request("thread/list", { ...filters, cursor: cache.next, limit: 100 });
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

  private merge(stock: Thread[], claude: Thread[], params: JsonObject): Thread[] {
    const key = sortKey(params);
    const direction = params.sortDirection === "asc" ? 1 : -1;
    const value = (thread: Thread) => Number(thread[key] ?? thread.updatedAt ?? 0);
    const claudeSorted = [...claude].sort((left, right) => direction * (value(left) - value(right)) || left.id.localeCompare(right.id));
    if (params.sortKey === "section_position") return [...stock, ...this.sectionOrdered(params.sectionId, claudeSorted)];
    const merged: Thread[] = [];
    let s = 0;
    let c = 0;
    while (s < stock.length || c < claudeSorted.length) {
      const takeStock = c >= claudeSorted.length
        || (s < stock.length && direction * (value(stock[s]!) - value(claudeSorted[c]!)) <= 0);
      merged.push(takeStock ? stock[s++]! : claudeSorted[c++]!);
    }
    return merged;
  }

  private sectionOrdered(sectionId: string | null | undefined, threads: Thread[]): Thread[] {
    const order = sectionId ? this.gateway.meta.sectionOrder(sectionId) : [];
    const rank = (thread: Thread) => {
      const index = order.indexOf(thread.id);
      return index >= 0 ? index : order.length + (this.gateway.meta.section(thread.id)?.enteredAt ?? 0);
    };
    return [...threads].sort((left, right) => rank(left) - rank(right));
  }

  public async list(connection: Connection, params: JsonObject): Promise<JsonObject> {
    const limit = Math.max(1, Math.min(Number(params.limit ?? 50), 200));
    const { cursor: _cursor, limit: _limit, ...filters } = params;
    const key = JSON.stringify(filters);
    const offset = decodeCursor(params.cursor, key);
    if (!params.cursor) await Promise.all([this.gateway.claude.catalog.refresh(), this.refreshSections()]);
    const claude = await this.project(await this.claudeThreads(params));
    const stock = await this.stockThreads(connection, params, offset + limit + 1, !params.cursor);
    const complete = this.stockCache!.done;
    let merged = this.merge(await this.project(stock), claude, params);
    // Without all stock rows, only the part of the merge that no unseen stock row can precede is final.
    if (!complete && stock.length) {
      const boundary = stock.at(-1)!;
      const index = merged.indexOf(boundary);
      merged = merged.slice(0, index + 1);
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
    const stockResults: JsonObject[] = [];
    let cursor: string | null = null;
    do {
      const page: JsonObject = await connection.upstream.request("thread/search", { ...params, searchTerm, cursor, limit: 100 });
      stockResults.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const claude = (await this.project(await this.claudeThreads({ archived: params.archived, sourceKinds: params.sourceKinds, searchTerm })))
      .map((thread) => ({ thread, snippet: thread.name ?? thread.preview.slice(0, 120) }));
    const visible = stockResults.filter((result) => !this.gateway.meta.hidden(result.thread.id));
    const key = sortKey(params);
    const direction = params.sortDirection === "asc" ? 1 : -1;
    const all = [...visible, ...claude].sort((left, right) =>
      direction * (Number(left.thread[key] ?? 0) - Number(right.thread[key] ?? 0)));
    const limit = Math.max(1, Math.min(Number(params.limit ?? 25), 100));
    const queryKey = JSON.stringify({ searchTerm, archived: params.archived, sourceKinds: params.sourceKinds, key, direction });
    const offset = decodeCursor(params.cursor, queryKey);
    const data = all.slice(offset, offset + limit);
    return {
      data,
      nextCursor: offset + limit < all.length ? encodeCursor({ key: queryKey, offset: offset + limit }) : null,
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
   * `thread/section/move`: stock moves its own threads; Claude threads live in meta. The merged manual order
   * is recorded so Claude threads keep their place among stock ones.
   */
  public async moveInSection(connection: Connection, params: JsonObject): Promise<JsonObject> {
    const { sectionId } = params as { sectionId: string | null };
    // Claude rows are keyed by their session: a lineage's row backend decides.
    const threadId = this.gateway.meta.rowId(params.threadId);
    const claude = this.gateway.claude.owns(threadId);
    if (!claude) return connection.upstream.request("thread/section/move", params);
    if (sectionId === null) {
      this.gateway.meta.setSection(threadId, null);
      return {};
    }
    const members = (await this.list(connection, { sectionId, sortKey: "section_position", limit: 200, archived: false })).data as Thread[];
    const order = members.map((thread) => thread.id).filter((id) => id !== threadId);
    const at = params.beforeThreadId ? order.indexOf(this.gateway.meta.rowId(params.beforeThreadId)) : order.length;
    order.splice(at < 0 ? order.length : at, 0, threadId);
    this.gateway.meta.setSection(threadId, sectionId);
    this.gateway.meta.setSectionOrder(sectionId, order);
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
