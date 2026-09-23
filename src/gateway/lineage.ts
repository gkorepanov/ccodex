import { randomUUID } from "node:crypto";
import { codexPermissions } from "../claude/sdk.js";
import type { Provider, Segment } from "../meta.js";
import { invalidRequest, requestedModel, type JsonObject, type Thread, type Turn } from "../protocol/codex.js";
import { historyCursors, paginateItems, paginateTurns, startedTurn } from "../protocol/turnPagination.js";
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

/**
 * Threads that switched provider. Each segment lives natively in its provider; meta.json keeps only the segment
 * list. History is stitched, everything else goes to the current segment's backend.
 */
export class Lineages {
  /** Model of the other provider chosen through `thread/settings/update`; the switch runs on the next turn. */
  private readonly pending = new Map<string, JsonObject>();
  private readonly resumed = new WeakMap<Connection, Set<string>>();

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

  public isBackendAnnouncement(text: string): boolean {
    const rewrites = this.gateway.meta.rewrites;
    if (!rewrites.size) return false;
    const id = (JSON.parse(text) as JsonObject).params?.thread?.id;
    return rewrites.has(id) || this.gateway.meta.hidden(id);
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
      ? (await this.gateway.claude.read(segment.threadId)).thread
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
    const turns = await this.stitchedTurns(segments);
    if (method === "thread/turns/list") return paginateTurns(turns, params);
    if (method === "thread/items/list") return paginateItems(turns, params);
    const current = segments.at(-1)!;
    const row = await this.thread(this.gateway.meta.row(publicId));
    if (method === "thread/read") {
      const { thread } = await this.forward(connection, current, method, { ...params, includeTurns: false });
      return { thread: { ...this.merge(row, thread, publicId), turns: params.includeTurns ? turns : [] } };
    }
    // A client resumes with the row's rollout path; the current backend has its own.
    const response = await this.forward(connection, current, method, { ...params, path: null, excludeTurns: true, initialTurnsPage: null });
    return {
      ...response,
      thread: { ...this.merge(row, response.thread, publicId), turns: params.excludeTurns ? [] : turns },
      initialTurnsPage: params.initialTurnsPage ? paginateTurns(turns, params.initialTurnsPage) : null,
      ...historyCursors(turns),
    };
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
    // Rolled-back backends leave the lineage; they stay on disk, archived.
    for (const segment of dropped) {
      if (segment.provider === "claude") this.gateway.meta.setArchived(segment.threadId, true);
      else await this.gateway.stock.request("thread/archive", { threadId: segment.threadId }).catch(() => undefined);
    }
    // A lineage back to its own single thread is dropped, unless forks still list that thread as a segment.
    const shared = Object.entries(this.gateway.meta.lineages).some(([id, other]) => id !== publicId && other.some((segment) => segment.threadId === publicId));
    if (kept.length === 1 && kept[0]!.threadId === publicId && !shared) this.gateway.meta.deleteLineage(publicId);
    else this.gateway.meta.setLineage(publicId, kept);
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
        if (status !== "completed" || !summary) throw new Error(`compaction ${status}`);
        return await this.toCodex(connection, publicId, segments, { ...source, lastTurnId: turn.id }, summary, params);
      } catch (error) {
        return failed(turn, error);
      }
    }
    // codex → claude: stock compaction is encrypted, so an ephemeral fork writes a summary with the same model.
    const cwd = (await this.thread(source)).cwd;
    const session = this.gateway.claude.create(this.gateway.claude.settingsFrom(params, { cwd, model: null, effort: null, fast: false, permissionMode: "default" }));
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
    const started: JsonObject = await connection.upstream.request("thread/start", {
      model: requestedModel(params), cwd: settings.cwd,
      approvalPolicy: params.approvalPolicy ?? permissions.approvalPolicy,
      approvalsReviewer: params.approvalsReviewer ?? permissions.approvalsReviewer,
      ...(params.permissions || params.sandboxPolicy ? {} : { permissions: permissions.activePermissionProfile.id }),
    });
    const threadId: string = started.thread.id;
    await connection.upstream.request("thread/inject_items", {
      threadId,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] }],
    });
    this.gateway.meta.setLineage(publicId, [...segments.slice(0, -1), source, { provider: "codex", threadId, lastTurnId: null }]);
    // Stock announced the new backend as a thread of its own before we knew it; take that row back.
    for (const client of this.gateway.connections) client.send(JSON.stringify({ method: "thread/deleted", params: { threadId } }), true);
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
