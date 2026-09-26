import { randomUUID } from "node:crypto";
import { codexPermissions } from "../claude/sdk.js";
import type { Provider, Segment } from "../meta.js";
import { invalidRequest, requestedModel, type JsonObject, type Thread, type Turn } from "../protocol/codex.js";
import { historyCursors, paginateItems, paginateTurns, startedTurn, turnCursor, turnView } from "../protocol/turnPagination.js";
import type { Connection } from "./connection.js";
import type { Gateway } from "./server.js";

/** Codex's own `templates/compact/prompt.md` and `summary_prefix.md`. */
export const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.
Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue
Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;
export const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

const HISTORY_METHODS = new Set(["thread/read", "thread/resume", "thread/turns/list", "thread/items/list"]);
/** Stock methods that work on a thread that is not loaded on this connection. */
const NO_RESUME = new Set([
  "thread/read", "thread/resume", "thread/turns/list", "thread/items/list", "thread/fork", "thread/unsubscribe",
  "thread/name/set", "thread/archive", "thread/unarchive", "thread/delete", "thread/metadata/update",
]);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;

/**
 * The marker turn a Claude segment starts with: the summary of the previous segment was injected there. Its id
 * has no dashes, so it never reads as a backend id to rewrite.
 */
function switchTurn(threadId: string, at: number | null): Turn {
  const id = `switch:${threadId.replaceAll("-", "")}`;
  return {
    id, items: [{ type: "contextCompaction", id: `${id}:compaction` }], itemsView: "full",
    status: "completed", error: null, startedAt: at, completedAt: at, durationMs: 0,
  };
}

/** Where a stitched page goes on: a segment and its backend's cursor; `marker`: the segment's switch marker is next. */
interface PagePosition {
  readonly segment: number;
  readonly cursor: string | null;
  /** Its backend's turns before this one are newer than the page (a stock cursor can't name a turn). */
  readonly skipTo?: { readonly turnId: string; readonly include: boolean };
  readonly marker?: number | null;
}

/** A lineage's cursor names the segment of its anchor (a turn or an item there); segments page with their own. */
function withSegment(cursor: string, segment: number): string {
  return JSON.stringify({ ...JSON.parse(cursor), segment });
}

/** The cursor as the segment's backend wrote it. */
function ownCursor(cursor: string): string {
  try {
    const { segment: _, ...own } = JSON.parse(cursor) as Record<string, unknown>;
    return JSON.stringify(own);
  } catch {
    return cursor;
  }
}

function cursorSegment(cursor: string): number | undefined {
  try {
    const segment = (JSON.parse(cursor) as { segment?: unknown }).segment;
    return typeof segment === "number" ? segment : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Threads that switched provider. Each segment lives natively in its provider; meta.json keeps only the segment
 * list. History is stitched, everything else goes to the current segment's backend.
 */
export class Lineages {
  /** Model of the other provider chosen through `thread/settings/update`; the switch runs on the next turn. */
  private readonly pending = new Map<string, JsonObject>();
  private readonly resumed = new WeakMap<Connection, Set<string>>();
  /** Stock backends being created by switches, their held announcements, and the backends (both providers) created so far. */
  private creatingBackends = 0;
  private readonly heldAnnouncements: Array<{ connection: Connection; threadId: string; text: string }> = [];
  private readonly newBackends = new Set<string>();
  /** Where a stitched page found each turn: items pages of a turn go to its segment's backend. */
  private readonly turnSegments = new Map<string, string>();

  public constructor(private readonly gateway: Gateway) {}

  private segments(threadId: string): Segment[] {
    return [...this.gateway.meta.lineage(threadId)
      ?? [{ provider: this.gateway.claude.owns(threadId) ? "claude" : "codex", threadId, lastTurnId: null }]];
  }

  private providerOf(model: unknown): Provider | undefined {
    if (typeof model !== "string" || !model) return undefined;
    return this.gateway.claude.isClaudeModel(model) ? "claude" : "codex";
  }

  public switchRequested(method: string, params: JsonObject): boolean {
    if (method !== "turn/start" && method !== "thread/settings/update") return false;
    if (this.pending.has(params.threadId)) return true;
    const target = this.providerOf(requestedModel(params));
    return target !== undefined && target !== this.segments(params.threadId).at(-1)!.provider;
  }

  public rewrite(text: string): string {
    const rewrites = this.gateway.meta.rewrites;
    return rewrites.size ? text.replace(UUID, (id) => rewrites.get(id) ?? id) : text;
  }

  /** A backend of a switched thread: never a thread of its own for clients. */
  public isBackend(threadId: string): boolean {
    return this.isHidden(threadId) || this.gateway.meta.rewrites.has(threadId);
  }

  /** Not listed: a backend that is no lineage's row (a row backend lists as its public thread). */
  public isHidden(threadId: string): boolean {
    return this.newBackends.has(threadId) || this.gateway.meta.hidden(threadId);
  }

  /** Holds a new thread's announcement while a switch creates a stock backend; false = deliver it now. */
  public holdAnnouncement(connection: Connection, threadId: string, text: string): boolean {
    if (!this.creatingBackends) return false;
    this.heldAnnouncements.push({ connection, threadId, text });
    return true;
  }

  /** Stock announces a new thread to every connection before its creator learns the id: a backend's announcement
   *  is held until then and dropped, or Desktop keeps it as a row that can never open. */
  private async startBackend(connection: Connection, params: JsonObject): Promise<string> {
    this.creatingBackends += 1;
    try {
      const started: JsonObject = await connection.upstream.request("thread/start", params);
      this.newBackends.add(started.thread.id);
      return started.thread.id;
    } finally {
      this.creatingBackends -= 1;
      if (!this.creatingBackends) {
        for (const held of this.heldAnnouncements.splice(0)) if (!this.isBackend(held.threadId)) held.connection.send(held.text);
      }
    }
  }

  // ---- routing ----

  public async handle(connection: Connection, method: string, params: JsonObject): Promise<unknown> {
    const publicId: string = params.threadId;
    const segments = this.segments(publicId);
    const current = segments.at(-1)!;
    if (method === "thread/settings/update" || method === "turn/start") {
      const target = this.providerOf(requestedModel(params));
      if (target && target !== current.provider) {
        if (method === "thread/settings/update") {
          this.pending.set(publicId, params);
          return {};
        }
        this.pending.delete(publicId);
        return this.switchProvider(connection, publicId, segments, params);
      }
      const pending = this.pending.get(publicId);
      this.pending.delete(publicId);
      if (!target && pending && method === "turn/start") {
        return this.switchProvider(connection, publicId, segments, { ...pending, ...params, model: requestedModel(pending) });
      }
    }
    if (segments.length === 1) return this.forward(connection, current, method, params);
    if (HISTORY_METHODS.has(method)) return this.history(connection, publicId, segments, method, params);
    switch (method) {
      case "thread/fork": return params.ephemeral ? this.forward(connection, current, method, params) : this.fork(connection, segments, params);
      case "thread/revert": return this.revert(connection, publicId, segments, String(params.beforeTurnId), false);
      case "thread/rollback": {
        const turns = await this.stitchedTurns(segments);
        const first = turns[Math.max(0, turns.length - Number(params.numTurns ?? 1))];
        if (!first) throw invalidRequest("nothing to roll back");
        return this.revert(connection, publicId, segments, first.id, true);
      }
      case "thread/name/set":
      case "thread/archive":
      case "thread/unarchive": {
        const row = this.gateway.meta.row(publicId);
        const result = await this.forward(connection, row, method, params);
        if (method === "thread/name/set" && row !== current) await this.forward(connection, current, method, params);
        return result;
      }
      case "thread/delete": {
        for (const segment of segments) {
          const shared = Object.entries(this.gateway.meta.lineages).some(([id, other]) =>
            id !== publicId && other.some((entry) => entry.threadId === segment.threadId));
          if (!shared) await this.forward(connection, segment, method, params).catch(() => undefined);
        }
        this.gateway.meta.deleteLineage(publicId);
        return {};
      }
      default:
        return this.forward(connection, current, method, params);
    }
  }

  /** The request on one segment's own backend (thread id replaced). */
  private async forward(connection: Connection, segment: Segment, method: string, params: JsonObject): Promise<any> {
    const backendParams = { ...params, threadId: segment.threadId };
    if (segment.provider === "claude") {
      connection.provider = "claude";
      return this.gateway.claude.handle(connection, method, backendParams);
    }
    connection.provider = "codex";
    const resumed = this.resumed.get(connection) ?? new Set();
    this.resumed.set(connection, resumed);
    if (!NO_RESUME.has(method) && !resumed.has(segment.threadId)) {
      await connection.upstream.request("thread/resume", { threadId: segment.threadId, excludeTurns: true });
    }
    if (method === "thread/resume" || !NO_RESUME.has(method)) resumed.add(segment.threadId);
    return connection.upstream.request(method, backendParams);
  }

  // ---- history ----

  private async segmentTurns(segment: Segment): Promise<Turn[]> {
    if (segment.provider === "claude") return (await this.gateway.claude.read(segment.threadId)).turns;
    const turns: Turn[] = [];
    let cursor: string | null = null;
    do {
      const page: JsonObject = await this.gateway.stock.request("thread/turns/list", {
        threadId: segment.threadId, cursor, limit: 100, sortDirection: "asc", itemsView: "full",
      });
      turns.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return turns;
  }

  /** Turns of each segment, cut at its last turn; a Claude segment after a switch starts with the marker turn. */
  private async perSegment(segments: readonly Segment[]): Promise<Turn[][]> {
    return Promise.all(segments.map(async (segment, index) => {
      let turns = await this.segmentTurns(segment);
      const end = segment.lastTurnId ? turns.findIndex((turn) => turn.id === segment.lastTurnId) : -1;
      if (end >= 0) turns = turns.slice(0, end + 1);
      return index > 0 && segment.provider === "claude" ? [switchTurn(segment.threadId, turns[0]?.startedAt ?? null), ...turns] : turns;
    }));
  }

  private async stitchedTurns(segments: readonly Segment[]): Promise<Turn[]> {
    return (await this.perSegment(segments)).flat();
  }

  private async thread(segment: Segment): Promise<Thread> {
    return segment.provider === "claude"
      ? await this.gateway.claude.thread(segment.threadId)
      : (await this.gateway.stock.request("thread/read", { threadId: segment.threadId })).thread;
  }

  /** The public row (preview, creation) with the current backend's live state and name (✳️ while on Claude). */
  private merge(row: Thread, current: Thread, publicId: string): Thread {
    return {
      ...row, id: publicId, name: current.name ?? row.name, status: current.status, model: current.model, modelProvider: current.modelProvider,
      reasoningEffort: current.reasoningEffort, updatedAt: current.updatedAt, recencyAt: current.recencyAt, cwd: current.cwd,
    };
  }

  /** List row of a lineage's public thread. */
  public async projectRow(row: Thread): Promise<Thread> {
    const publicId = this.gateway.meta.rewrites.get(row.id) ?? row.id;
    const current = this.gateway.meta.current(publicId);
    if (!current || current.threadId === row.id) return row;
    return this.merge(row, await this.thread(current).catch(() => row), publicId);
  }

  private async history(connection: Connection, publicId: string, segments: Segment[], method: string, params: JsonObject): Promise<unknown> {
    const descending = (params.sortDirection ?? "desc") === "desc";
    if (method === "thread/turns/list") return descending ? this.stitchedPage(segments, params) : paginateTurns(await this.stitchedTurns(segments), params);
    if (method === "thread/items/list") return params.turnId ? this.stitchedItems(segments, params) : paginateItems(await this.stitchedTurns(segments), params);
    const current = segments.at(-1)!;
    const row = await this.thread(this.gateway.meta.row(publicId));
    if (method === "thread/read") {
      const { thread } = await this.forward(connection, current, method, { ...params, includeTurns: false });
      return { thread: { ...this.merge(row, thread, publicId), turns: params.includeTurns ? await this.stitchedTurns(segments) : [] } };
    }
    // A client resumes with the row's rollout path; the current backend has its own.
    const response = await this.forward(connection, current, method, { ...params, path: null, excludeTurns: true, initialTurnsPage: null });
    const newest = await this.stitchedPage(segments, { limit: 25, itemsView: "full" });
    const turns = [...newest.data].reverse();
    const cursors = historyCursors(turns);
    const segment = newest.segments[0];
    // The thread's last item is the current backend's: its items page by that backend's own cursor (stock's is opaque).
    const itemsCursor: string | null = current.provider === "claude" ? cursors.itemsBackwardsCursor : response.itemsBackwardsCursor ?? null;
    return {
      ...response,
      thread: { ...this.merge(row, response.thread, publicId), turns: params.excludeTurns ? [] : turns },
      initialTurnsPage: params.initialTurnsPage ? await this.stitchedPage(segments, params.initialTurnsPage) : null,
      turnsBackwardsCursor: cursors.turnsBackwardsCursor && withSegment(cursors.turnsBackwardsCursor, segment!),
      itemsBackwardsCursor: itemsCursor && withSegment(itemsCursor, segments.length - 1),
    };
  }

  /** One backend's turns page (a segment's own ids and cursors). */
  private segmentPage(segment: Segment, params: JsonObject): Promise<JsonObject> {
    const request = { ...params, threadId: segment.threadId };
    return segment.provider === "claude" ? this.gateway.claude.turnsPage(segment.threadId, request) : this.gateway.stock.request("thread/turns/list", request);
  }

  /**
   * A page of the stitched turns, newest first: each segment pages on its own backend from where the previous page
   * stopped (the cursor names the segment), a Claude segment after a switch ending with its marker turn.
   */
  private async stitchedPage(segments: readonly Segment[], params: JsonObject): Promise<{ data: Turn[]; nextCursor: string | null; backwardsCursor: string | null; segments: number[] }> {
    const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
    let at = params.cursor ? await this.pagePosition(segments, params.cursor) : this.segmentStart(segments, segments.length - 1);
    const found: Array<{ turn: Turn; segment: number }> = [];
    while (at.segment >= 0 && found.length < limit) {
      const segment = segments[at.segment]!;
      if (at.marker !== undefined) {
        found.push({ turn: turnView(switchTurn(segment.threadId, at.marker), params.itemsView), segment: at.segment });
        at = this.segmentStart(segments, at.segment - 1);
        continue;
      }
      const page = await this.segmentPage(segment, { limit: limit - found.length, cursor: at.cursor, sortDirection: "desc", itemsView: params.itemsView ?? null });
      let skipTo = at.skipTo;
      for (const turn of page.data as Turn[]) {
        this.turnSegments.set(turn.id, segment.threadId);
        if (skipTo) {
          if (turn.id !== skipTo.turnId) continue;
          skipTo = undefined;
          if (!at.skipTo!.include) continue;
        }
        found.push({ turn, segment: at.segment });
      }
      const oldest = found.at(-1)?.segment === at.segment ? found.at(-1)!.turn.startedAt : null;
      at = page.nextCursor ? { segment: at.segment, cursor: page.nextCursor, ...(skipTo ? { skipTo: at.skipTo } : {}) }
        : at.segment > 0 && segment.provider === "claude" ? { segment: at.segment, cursor: null, marker: oldest }
        : this.segmentStart(segments, at.segment - 1);
    }
    return {
      data: found.map(({ turn }) => turn),
      nextCursor: at.segment >= 0 && found.length ? JSON.stringify(at) : null,
      backwardsCursor: found.length ? withSegment(turnCursor(found[0]!.turn.id, true), found[0]!.segment) : null,
      segments: found.map(({ segment }) => segment),
    };
  }

  /**
   * Where a segment's turns start, newest first. Stock pages by its own cursors (paginated history: rollout ordinals), so a
   * stock segment ending before its backend does is paged from the backend's newest turn, skipping to its last one.
   */
  private segmentStart(segments: readonly Segment[], index: number): PagePosition {
    const segment = segments[index];
    if (!segment?.lastTurnId) return { segment: index, cursor: null };
    return segment.provider === "claude" ? { segment: index, cursor: turnCursor(segment.lastTurnId, true) }
      : { segment: index, cursor: null, skipTo: { turnId: segment.lastTurnId, include: true } };
  }

  /** A client's cursor: a page's position, or a turn anchor (`turnsBackwardsCursor`, `backwardsCursor`). */
  private async pagePosition(segments: readonly Segment[], cursor: string): Promise<PagePosition> {
    const parsed = JSON.parse(cursor) as PagePosition & { turnId?: string; includeAnchor?: boolean };
    if (parsed.turnId === undefined) return parsed;
    const anchor = { turnId: parsed.turnId, include: parsed.includeAnchor === true };
    const segment = parsed.segment ?? await this.segmentOf(segments, anchor.turnId);
    if (anchor.turnId.startsWith("switch:")) return anchor.include ? { segment, cursor: null, marker: null } : this.segmentStart(segments, segment - 1);
    return segments[segment]!.provider === "claude" ? { segment, cursor: turnCursor(anchor.turnId, anchor.include) }
      : { segment, cursor: null, skipTo: anchor };
  }

  /** The segment holding a turn: where a page found it, else paging back until one does. */
  private async segmentOf(segments: readonly Segment[], turnId: string): Promise<number> {
    const locate = () => segments.findIndex((segment) => turnId === `switch:${segment.threadId.replaceAll("-", "")}` || this.turnSegments.get(turnId) === segment.threadId);
    let cursor: string | null = null;
    while (locate() < 0) {
      const page: { nextCursor: string | null } = await this.stitchedPage(segments, { limit: 100, cursor, itemsView: "notLoaded" });
      if (!page.nextCursor) throw invalidRequest(`turn not found: ${turnId}`);
      cursor = page.nextCursor;
    }
    return locate();
  }

  /** A turn's items page from its segment's backend; an anchor in another segment only says which side the turn is on. */
  private async stitchedItems(segments: readonly Segment[], params: JsonObject): Promise<unknown> {
    const index = await this.segmentOf(segments, params.turnId);
    const segment = segments[index]!;
    if (params.turnId.startsWith("switch:")) return paginateItems([switchTurn(segment.threadId, null)], params);
    const anchorSegment = params.cursor ? cursorSegment(params.cursor) : undefined;
    let cursor = params.cursor ? ownCursor(params.cursor) : null;
    if (anchorSegment !== undefined && anchorSegment !== index) {
      if (anchorSegment > index !== ((params.sortDirection ?? "asc") === "desc")) return { data: [], nextCursor: null, backwardsCursor: null };
      cursor = null;
    }
    const request = { ...params, threadId: segment.threadId, cursor };
    return segment.provider === "claude" ? this.gateway.claude.itemsPage(segment.threadId, request) : this.gateway.stock.request("thread/items/list", request);
  }

  // ---- fork and rollback across segments ----

  /** Segment index holding `turnId`, and the turn's index inside that segment's (cut) turns. */
  private locate(perSegment: Turn[][], turnId: string): { segment: number; turn: number } {
    for (const [segment, turns] of perSegment.entries()) {
      const turn = turns.findIndex((candidate) => candidate.id === turnId);
      if (turn >= 0) return { segment, turn };
    }
    throw invalidRequest(`turn not found: ${turnId}`);
  }

  private async fork(connection: Connection, segments: Segment[], params: JsonObject): Promise<unknown> {
    const perSegment = await this.perSegment(segments);
    let index = segments.length - 1;
    let backendParams: JsonObject = { lastTurnId: null, beforeTurnId: null };
    const turnId: string | undefined = params.lastTurnId ?? params.beforeTurnId ?? undefined;
    if (turnId) {
      const at = this.locate(perSegment, turnId);
      const real = perSegment[at.segment]!.filter((turn) => !turn.id.startsWith("switch:"));
      const firstReal = real[0]?.id;
      const beforeSegment = at.segment > 0 && (turnId.startsWith("switch:")
        ? params.beforeTurnId || !firstReal
        : params.beforeTurnId === firstReal);
      if (beforeSegment) {
        index = at.segment - 1;
        backendParams = { lastTurnId: segments[index]!.lastTurnId, beforeTurnId: null };
      } else {
        index = at.segment;
        backendParams = turnId.startsWith("switch:")
          ? { lastTurnId: null, beforeTurnId: firstReal }
          : { lastTurnId: params.lastTurnId ?? null, beforeTurnId: params.beforeTurnId ?? null };
      }
    }
    const segment = segments[index]!;
    const response = await this.forward(connection, segment, "thread/fork", { ...params, ...backendParams, excludeTurns: true });
    const forkedId: string = response.thread.id;
    let turns: Turn[];
    if (index > 0) {
      const forked = [...segments.slice(0, index), { provider: segment.provider, threadId: forkedId, lastTurnId: null }];
      this.gateway.meta.setLineage(forkedId, forked);
      turns = await this.stitchedTurns(forked);
    } else {
      turns = await this.segmentTurns({ ...segment, threadId: forkedId });
    }
    return { ...response, thread: { ...response.thread, turns: params.excludeTurns ? [] : turns } };
  }

  private async revert(connection: Connection, publicId: string, segments: Segment[], beforeTurnId: string, rollback: boolean): Promise<unknown> {
    const perSegment = await this.perSegment(segments);
    const at = this.locate(perSegment, beforeTurnId);
    const firstReal = perSegment[at.segment]!.find((turn) => !turn.id.startsWith("switch:"))?.id;
    const dropSegment = at.segment > 0 && (beforeTurnId.startsWith("switch:") || beforeTurnId === firstReal);
    const keep = dropSegment ? at.segment : at.segment + 1;
    const dropped = segments.slice(keep);
    const rowSegment = this.gateway.meta.row(publicId);
    if (dropped.includes(rowSegment)) {
      throw invalidRequest("This fork cannot be rolled back past the provider switch it was forked from.");
    }
    if (!dropSegment) await this.forward(connection, segments[at.segment]!, "thread/revert", { threadId: publicId, beforeTurnId });
    const kept = segments.slice(0, keep).map((segment, index) => index === keep - 1 ? { ...segment, lastTurnId: null } : segment);
    // A lineage back to its own single thread is dropped, unless forks still list that thread as a segment.
    const shared = Object.entries(this.gateway.meta.lineages).some(([id, other]) => id !== publicId && other.some((segment) => segment.threadId === publicId));
    if (kept.length === 1 && kept[0]!.threadId === publicId && !shared) this.gateway.meta.deleteLineage(publicId);
    else this.gateway.meta.setLineage(publicId, kept);
    // Rolled-back backends are gone like rolled-back turns (kept while a fork's lineage still holds them): listed
    // anywhere, even as archived, Desktop shows them as threads of their own. They leave the lineage first, or
    // stock's news of them would read as the public thread's for every client.
    for (const segment of dropped) {
      if (Object.values(this.gateway.meta.lineages).some((other) => other.some((entry) => entry.threadId === segment.threadId))) continue;
      if (segment.provider === "claude") await this.gateway.claude.discard(segment.threadId);
      else await this.gateway.stock.request("thread/delete", { threadId: segment.threadId }).catch(() => undefined);
    }
    const turns = await this.stitchedTurns(kept);
    const row = await this.thread(rowSegment);
    const thread = this.merge(row, await this.thread(kept.at(-1)!), publicId);
    if (dropSegment) connection.notify("thread/reverted", { threadId: publicId });
    return rollback ? { thread: { ...thread, turns } } : { thread, ...historyCursors(turns) };
  }

  // ---- provider switch ----

  /**
   * `turn/start` with the other provider's model: summarize the current segment, start a native thread on the
   * other provider with the summary injected, then run the user's turn there. Desktop gives its optimistic message
   * to the first turn that starts, so live the compaction shows only inside the user's turn: under its preallocated
   * id towards Claude, after stock started it towards codex. On failure the user's turn fails.
   */
  private async switchProvider(connection: Connection, publicId: string, segments: Segment[], params: JsonObject): Promise<unknown> {
    const source = segments.at(-1)!;
    const now = Math.floor(Date.now() / 1000);
    const failed = (turn: Turn, error: unknown) => {
      const message = `Switching provider failed: ${error instanceof Error ? error.message : String(error)}`;
      this.gateway.logger.warn("lineage.switch.failed", { publicId, error: message });
      const turnError = { message, codexErrorInfo: null, additionalDetails: null };
      connection.notify("error", { threadId: publicId, turnId: turn.id, willRetry: false, error: turnError });
      connection.notify("turn/completed", {
        threadId: publicId,
        turn: { ...turn, items: [], status: "failed", completedAt: Math.floor(Date.now() / 1000), durationMs: Date.now() - now * 1000, error: turnError },
      });
      return { turn: startedTurn(turn) };
    };
    if (source.provider === "claude") {
      const session = this.gateway.claude.session(source.threadId);
      this.gateway.unsubscribe(source.threadId, connection);
      let summary = "";
      session.compactSummary = (text) => { summary = text; };
      const turn = await session.command(`/compact ${COMPACT_PROMPT}`);
      try {
        const status = await session.turnDone(turn.id);
        session.compactSummary = undefined;
        if (status !== "completed") throw new Error(`compaction ${status}`);
        let lastTurnId = turn.id;
        if (!summary) {
          // Nothing said since the last compaction (switching again after an edit undid a switch): Claude compacts
          // nothing, the session still continues from that compaction's summary, and the no-op leaves the history.
          const { turns } = await this.gateway.claude.read(source.threadId);
          summary = await this.gateway.claude.compactedSummary(source.threadId);
          if (!summary) {
            const output = turns.at(-1)!.items.flatMap((item) => item.type === "agentMessage" ? [item.text] : []).join("\n");
            throw new Error(output || "Claude wrote no summary");
          }
          lastTurnId = turns.at(-2)!.id;
        }
        return await this.toCodex(connection, publicId, segments, { ...source, lastTurnId }, summary, params);
      } catch (error) {
        // Desktop only settles its pending message on a turn it saw start.
        connection.notify("turn/started", { threadId: publicId, turn: startedTurn(turn) });
        return failed(turn, error);
      }
    }
    // codex → claude: stock compaction is encrypted, so an ephemeral fork writes a summary with the same model.
    const cwd = (await this.thread(source)).cwd;
    const session = this.gateway.claude.create(this.gateway.claude.settingsFrom(params, { cwd, model: null, effort: null, fast: false, permissionMode: "default" }));
    // A backend from its first record on: its transcript is on disk before the lineage lists it.
    this.newBackends.add(session.threadId);
    const turnId = randomUUID();
    const turn: Turn = { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: now, completedAt: null, durationMs: null };
    const item = { type: "contextCompaction", id: `${turnId}:compaction` };
    connection.notify("turn/started", { threadId: publicId, turn });
    connection.notify("item/started", { item, threadId: publicId, turnId, startedAtMs: Date.now() });
    try {
      const summary = await this.gptSummary(source.threadId);
      const last: JsonObject = await this.gateway.stock.request("thread/turns/list", { threadId: source.threadId, limit: 1, sortDirection: "desc" });
      await session.inject(`${SUMMARY_PREFIX}\n${summary}`);
      this.gateway.meta.setLineage(publicId, [
        ...segments.slice(0, -1), { ...source, lastTurnId: last.data[0]?.id ?? null },
        { provider: "claude", threadId: session.threadId, lastTurnId: null },
      ]);
      // Renamed as the lineage's backend: the name reaches clients under the public id.
      const name = (await this.thread(source)).name;
      if (name) await this.gateway.claude.rename(session.threadId, `${name} ✳️`);
      connection.notify("item/completed", { item, threadId: publicId, turnId, completedAtMs: Date.now() });
      connection.provider = "claude";
      return await this.gateway.claude.handle(connection, "turn/start", { ...params, threadId: session.threadId, turnId });
    } catch (error) {
      await this.gateway.claude.discard(session.threadId);
      return failed(turn, error);
    }
  }

  private async gptSummary(threadId: string): Promise<string> {
    const fork: JsonObject = await this.gateway.stock.request("thread/fork", { threadId, ephemeral: true, excludeTurns: true });
    try {
      return await this.gateway.internalTurn(fork.thread.id, COMPACT_PROMPT);
    } finally {
      void this.gateway.stock.request("thread/unsubscribe", { threadId: fork.thread.id }).catch(() => undefined);
    }
  }

  private async toCodex(connection: Connection, publicId: string, segments: Segment[], source: Segment, summary: string, params: JsonObject): Promise<unknown> {
    const settings = this.gateway.claude.settings(source.threadId);
    const permissions = codexPermissions(settings.permissionMode, settings.cwd);
    const threadId = await this.startBackend(connection, {
      model: requestedModel(params), cwd: settings.cwd,
      approvalPolicy: params.approvalPolicy ?? permissions.approvalPolicy,
      approvalsReviewer: params.approvalsReviewer ?? permissions.approvalsReviewer,
      ...(params.permissions || params.sandboxPolicy ? {} : { permissions: permissions.activePermissionProfile.id }),
    });
    await connection.upstream.request("thread/inject_items", {
      threadId,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] }],
    });
    this.gateway.meta.setLineage(publicId, [...segments.slice(0, -1), source, { provider: "codex", threadId, lastTurnId: null }]);
    const resumed = this.resumed.get(connection) ?? new Set();
    resumed.add(threadId);
    this.resumed.set(connection, resumed);
    connection.provider = "codex";
    const name = (await this.thread(this.gateway.meta.row(publicId))).name;
    if (name) await connection.upstream.request("thread/name/set", { threadId, name: name.replace(/\s*✳️$/u, "") }).catch(() => undefined);
    const answer: JsonObject = await connection.upstream.request("turn/start", { ...params, threadId });
    const turnId: string = answer.turn.id;
    const item = { type: "contextCompaction", id: `${turnId}:compaction` };
    connection.notify("item/started", { item, threadId: publicId, turnId, startedAtMs: Date.now() });
    connection.notify("item/completed", { item, threadId: publicId, turnId, completedAtMs: Date.now() });
    return answer;
  }
}
