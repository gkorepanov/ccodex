import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deleteSession, forkSession, renameSession, type ModelInfo, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { v7 as uuidv7 } from "uuid";
import type { Config } from "../config.js";
import type { Connection } from "../gateway/connection.js";
import type { Gateway } from "../gateway/server.js";
import type { Logger } from "../log.js";
import { packageVersion } from "../management/commands.js";
import { invalidParams, invalidRequest, requestedModel, type JsonObject, type Thread, type ThreadItem, type Turn } from "../protocol/codex.js";
import { anchorCursor, historyCursors, occurrencesPage, paginateItems, paginateTurns, startedTurn, turnOccurrences } from "../protocol/turnPagination.js";
import { claudeEffort, ULTRA } from "./delegation.js";
import { normalizeUserInput } from "./inputMapper.js";
import { claudeModelLabel, modelCatalogValue, normalizeClaudeModelIdentifier } from "./modelSelection.js";
import { NativeSessionCatalog, type SessionSummary } from "./native/catalog.js";
import { firstMatch } from "./native/search.js";
import { nativeThread, type TranscriptProjection } from "./native/projector.js";
import { projectSubagents, type ProjectedSubagent } from "./native/subagents.js";
import { readTranscriptRecords } from "./native/records.js";
import { preview, summarizeTranscript, userText, type TranscriptHeader } from "./native/summary.js";
import { claudeMode, codexPermissions, mapClaudeModel, mapSkill, permissionSettings, withProbeQuery } from "./sdk.js";
import { killProcesses, sessionProcesses, type SessionProcess } from "./processes.js";
import { ClaudeSession, type SessionSettings } from "./session.js";
import type { Meta } from "../meta.js";

interface SideThread {
  readonly id: string;
  readonly sourceId: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly turns: Turn[];
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

/** Claude's standard context window, until a session of the model reports its own. */
const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Claude's model entry plus the context window it reports for the model (kept in the models cache). */
type ClaudeModel = ModelInfo & { contextWindow?: number };
const WINDOW_MINUTES: Record<string, number> = { five_hour: 300, seven_day: 10_080, seven_day_opus: 10_080, seven_day_sonnet: 10_080 };

/**
 * Stock unloads a thread after 30 minutes without subscribers or activity; a Claude chat's process goes the same way,
 * unless a command it runs still works (e2e shortens the wait).
 */
const IDLE_MS = Number(process.env.CCODEX_E2E_IDLE_MS) || 30 * 60_000;
/** How long an earlier chat stays open before its process is started ahead of a prompt (tests shorten it). */
const RESUME_WARM_MS = Number(process.env.CCODEX_E2E_RESUME_WARM_MS) || 10_000;
/** Claude processes kept at most (each holds its session in memory: 250–550 MB); tests lower it. */
const MAX_PROCESSES = Number(process.env.CCODEX_E2E_MAX_PROCESSES) || 10;

/** A chat's permissions and plan mode from the mode its transcript last recorded (in plan mode, meta.json keeps its own). */
function recordedPermissions(threadId: string, recorded: string | null | undefined, meta: Meta): Pick<SessionSettings, "permissionMode" | "plan"> {
  if (recorded !== "plan") return { permissionMode: (recorded ?? "default") as PermissionMode, plan: false };
  const kept = meta.plan(threadId);
  return { permissionMode: (kept?.permissionMode ?? "default") as PermissionMode, plan: kept?.plan ?? true };
}


/** The Claude side of the gateway: catalog of native sessions, live sessions, side chats, models, skills. */
export class ClaudeThreads {
  public readonly catalog: NativeSessionCatalog;
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly sides = new Map<string, SideThread>();
  /** `agent-<id>` sub-agent thread → the native session whose transcript directory holds it. */
  private readonly subagentRoots = new Map<string, string>();
  /** Threads rolled back but not continued yet: their kept history ends at this record. A restart meanwhile shows
   *  the rolled-back messages again. */
  private readonly leaves = new Map<string, string>();
  /** Sub-agents spawned live, shown until Claude has written their transcript. */
  private readonly spawnedSubagents = new Map<string, Thread>();
  /** Context window of each Claude model, as its sessions report it. */
  private readonly contextWindows = new Map<string, number>();
  /** Running sub-agents: their thread follows the transcript Claude writes (what was shown: item id → item). */
  private readonly liveSubagents = new Map<string, { turnId?: string; shown: Map<string, string>; size: number; poll: NodeJS.Timeout; refresh?: Promise<void> }>();
  private models_?: Promise<JsonObject[]>;
  private defaultModel: string | null = null;
  private readonly rateLimitWindows = new Map<string, RateLimitWindow & { status: string }>();
  private usage?: { at: number; done: Promise<void> };
  /** Why Claude's plan limits could not be read, when they could not. */
  public usageError?: string;
  /** Weekly windows of single models (e.g. Fable), from Claude's `/usage` data. */
  public modelLimits: { name: string; window: RateLimitWindow }[] = [];
  private stopWatching?: () => void;
  public onTurnCompleted?: (threadId: string, turnId: string) => void;

  public constructor(
    public readonly config: Config,
    public readonly gateway: Gateway,
    public readonly logger: Logger,
  ) {
    this.catalog = new NativeSessionCatalog(join(config.claudeHome, "projects"), { path: join(config.dataDir, "claude-catalog.json"), key: packageVersion() });
  }

  public async start(): Promise<void> {
    // The model list maps transcripts' resolved model ids to picker values (see pickerModel): the one Claude reported last
    // time at once (a chat opened right after a start waits for no probe), the fresh one once the probe answers.
    const cached = this.cachedModels();
    if (cached) {
      this.models_ = Promise.resolve(this.useModels(cached));
      void this.probeModels().then((models) => { this.models_ = Promise.resolve(models); }, () => undefined);
    } else void this.models().catch(() => undefined);
    await this.catalog.refresh();
    this.gateway.meta.prune((segment) => segment.provider === "codex" || this.catalog.get(segment.threadId) !== undefined);
    const known = new Map(this.catalog.sessions().map((summary) => [summary.sessionId, summary.customTitle ?? summary.aiTitle]));
    // Sessions and titles changed outside CCodex (the claude CLI, /rename) show up without a reload.
    const announce = () => {
      for (const summary of this.catalog.sessions()) {
        const header = this.headerOf(summary, undefined);
        const name = header.customTitle ?? header.aiTitle;
        const id = summary.sessionId;
        if (!known.has(id) && !this.sessions.has(id) && !this.gateway.meta.hidden(id)) {
          this.gateway.broadcast("thread/started", { thread: this.decorate(nativeThread(id, header, { status: this.status(id) })) });
        } else if (known.has(id) && known.get(id) !== name && name && !this.gateway.meta.hidden(id)) {
          this.gateway.emit(id, "thread/name/updated", { threadId: id, threadName: name });
        }
        known.set(id, name);
      }
    };
    this.stopWatching = this.catalog.watch(announce);
    // What was written between the scan and the watch.
    await this.catalog.refresh();
    announce();
    void this.models().catch((error: unknown) => this.logger.warn("claude.models.unavailable", { error: String(error) }));
    this.sweeper = setInterval(() => this.sweep(), Math.min(60_000, IDLE_MS / 4));
    this.sweeper.unref();
  }

  /** CPU seconds each command of a loaded session used, and since when unchanged. */
  private cpuSeen = new Map<number, { cpu: number; at: number }>();
  private sweeper?: NodeJS.Timeout;

  /** What CCodex last did to each chat's process and commands, and why (shown by /cc). */
  private readonly actions = new Map<string, { at: number; text: string }[]>();

  private act(session: ClaudeSession, event: string, text: string, pids: number[] | undefined): void {
    this.logger.info(event, { threadId: session.threadId, pids });
    this.actions.set(session.threadId, [...this.actions.get(session.threadId) ?? [], { at: Date.now(), text }].slice(-3));
  }

  /**
   * A turn that only waits for background commands that hung (no CPU for IDLE_MS) gets their tasks stopped: Claude
   * learns they were stopped and finishes it. A session quiet for IDLE_MS is unloaded if nobody has it open (as stock
   * unloads a thread); if a client has it open (Desktop keeps every chat it showed), only its process is closed, and
   * the next prompt starts it again. Past MAX_PROCESSES, the quiet chats used longest ago lose their processes too.
   * Closing a process ends the idle commands it leaves.
   */
  private sweep(): void {
    const now = Date.now();
    const sessions = [...this.sessions.values()];
    let processes: SessionProcess[] | undefined;
    try {
      processes = sessions.some((session) => session.loaded) ? sessionProcesses() : [];
    } catch (error) {
      // Unknown commands: a quiet session still goes (as stock's would), and nothing is ended, since nothing says it hung.
      this.logger.warn("claude.processes.unreadable", { error: String(error) });
    }
    if (processes) this.cpuSeen = new Map(processes.map((process) => {
      const seen = this.cpuSeen.get(process.pid);
      return [process.pid, seen?.cpu === process.cpu ? seen : { cpu: process.cpu, at: now }];
    }));
    const own = (session: ClaudeSession) => processes?.filter((process) => process.session === session.threadId).map((process) => process.pid);
    const computing = (pids: number[] | undefined) => pids?.some((pid) => now - this.cpuSeen.get(pid)!.at < IDLE_MS) ?? false;
    const idle = IDLE_MS < 60_000 ? `${IDLE_MS / 1000} s` : `${Math.round(IDLE_MS / 60_000)} min`;
    for (const session of sessions) {
      const pids = own(session);
      if (computing(pids)) continue;
      if (session.waitingOnTasks && pids?.length) {
        this.act(session, "claude.tasks.hung", `stopped its background tasks: their commands used no CPU for ${idle}`, pids);
        void session.stopTasks().catch(() => killProcesses(pids));
      } else if (session.quiet(now, IDLE_MS) && !this.gateway.subscribers(session.threadId).size) {
        this.act(session, "claude.unloaded", `unloaded the chat: nobody had it open and it was quiet for ${idle}`, pids);
        this.sessions.delete(session.threadId);
        void session.unload().then(() => killProcesses(pids ?? []));
        this.gateway.emit(session.threadId, "thread/status/changed", { threadId: session.threadId, status: { type: "notLoaded" } });
        this.gateway.emit(session.threadId, "thread/closed", { threadId: session.threadId });
      } else if (session.loaded && session.quiet(now, IDLE_MS)) {
        this.closeProcess(session, pids, `closed its Claude process: quiet for ${idle}; the next prompt starts it again`);
      }
    }
    const running = sessions.filter((session) => session.loaded);
    running.filter((session) => session.quiet(now, 0) && !computing(own(session)))
      .sort((left, right) => left.activeAt - right.activeAt)
      .slice(0, Math.max(0, running.length - MAX_PROCESSES))
      .forEach((session) => this.closeProcess(session, own(session),
        `closed its Claude process: ${running.length} were running (at most ${MAX_PROCESSES}) and this chat was used longest ago; the next prompt starts it again`));
  }

  private closeProcess(session: ClaudeSession, pids: number[] | undefined, text: string): void {
    this.act(session, "claude.process.closed", text, pids);
    void session.unload().then(() => killProcesses(pids ?? []));
  }

  public async close(): Promise<void> {
    clearInterval(this.sweeper);
    clearTimeout(this.warmTimer);
    this.stopWatching?.();
    for (const session of this.sessions.values()) session.unload();
  }

  // ---- ownership ----

  public owns(threadId: string): boolean {
    return this.sessions.has(threadId) || this.sides.has(threadId) || this.catalog.get(threadId) !== undefined
      || threadId.startsWith("agent-");
  }

  public isClaudeModel(model: unknown): boolean {
    return typeof model === "string" && model.startsWith(this.config.modelPrefix);
  }

  public modelValue(model: string): string {
    return normalizeClaudeModelIdentifier(model.slice(this.config.modelPrefix.length));
  }

  /** Loaded as stock's threads are: opened and not unloaded, whether or not a Claude process runs for it now. */
  public loadedIds(): string[] {
    return [...this.sessions.keys()];
  }

  // ---- list rows ----

  private status(threadId: string): Thread["status"] {
    const session = this.sessions.get(threadId);
    if (session?.busy) return { type: "active", activeFlags: [] };
    return session ? { type: "idle" } : { type: "notLoaded" };
  }

  /** Claude's own title of a session stays unseen while CCodex names it (it would show until CCodex's replaces it). */
  private headerOf(summary: SessionSummary, session: ClaudeSession | undefined): TranscriptHeader {
    return {
      ...summary,
      aiTitle: this.gateway.titles.naming(summary.sessionId) ? null : summary.aiTitle,
      model: session?.settings.model ?? this.recordedModel(summary),
      reasoningEffort: session?.settings.effort ?? this.recordedEffort(summary),
    };
  }

  /** A chat's model from its transcript; in plan mode meta.json's (Claude plans a Haiku chat on Sonnet, see Meta.setPlan). */
  private recordedModel(summary: SessionSummary): string | null {
    const planned = summary.permissionMode === "plan" ? this.gateway.meta.plan(summary.sessionId)?.model : undefined;
    return planned ?? (summary.model && this.pickerModel(summary.model));
  }

  /** A chat's effort from its transcript (Claude records `ultra` as the max it runs at, told to delegate); in plan mode meta.json's. */
  private recordedEffort(summary: SessionSummary): string | null {
    if (summary.permissionMode === "plan") return this.gateway.meta.plan(summary.sessionId)?.effort ?? null;
    return summary.delegating && summary.reasoningEffort === claudeEffort(ULTRA) ? ULTRA : summary.reasoningEffort;
  }

  /** Transcripts name the resolved model (`claude-haiku-4-5-…`); the picker (and a live session) its value (`haiku`). */
  private pickerModel(model: string): string {
    const id = normalizeClaudeModelIdentifier(model);
    return this.pickerValues.get(id) ?? id;
  }

  /** Every native session as a list row (sub-agents excluded; they are listed through their parent). */
  public search(term: string): Promise<Map<string, string>> {
    return this.catalog.search(this.config.claudeBinary, term);
  }

  public threads(): Thread[] {
    const rows = this.catalog.sessions().map((summary) =>
      this.decorate(nativeThread(summary.sessionId, this.headerOf(summary, this.sessions.get(summary.sessionId)), { status: this.status(summary.sessionId) })));
    for (const session of this.sessions.values()) {
      if (session.started && !this.catalog.get(session.threadId)) rows.push(this.decorate(this.freshThread(session)));
    }
    return rows;
  }

  private decorate(thread: Thread): Thread {
    const section = this.gateway.meta.section(thread.id);
    return {
      ...thread,
      ...(section ? {
        section: this.gateway.sections.get(section.sectionId) ?? { id: section.sectionId, name: "", appearance: null },
        sectionEnteredAt: section.enteredAt,
      } : {}),
      archived: this.gateway.meta.isArchived(thread.id),
    };
  }

  private freshThread(session: ClaudeSession): Thread {
    const now = Math.floor(Date.now() / 1000);
    return nativeThread(session.threadId, {
      cwd: session.settings.cwd, gitBranch: null, createdAt: now, updatedAt: now, preview: "",
      customTitle: this.pendingNames.get(session.threadId) ?? null, aiTitle: null, model: session.settings.model, reasoningEffort: session.settings.effort,
      serviceTier: session.settings.fast ? "fast" : null, permissionMode: claudeMode(session.settings), cliVersion: null, goal: null,
    }, { status: this.status(session.threadId) });
  }

  // ---- reads ----

  private async projection(threadId: string): Promise<TranscriptProjection | undefined> {
    if (!this.catalog.get(threadId)) await this.catalog.refresh();
    if (!this.catalog.get(threadId)) return undefined;
    return this.catalog.projection(threadId, this.leaves.get(threadId));
  }

  private subagentRoot(threadId: string): string | undefined {
    const known = this.subagentRoots.get(threadId);
    if (known) return known;
    const summary = this.catalog.sessions().find((candidate) =>
      existsSync(join(candidate.path.replace(/\.jsonl$/u, ""), "subagents", `${threadId}.jsonl`)));
    if (summary) this.subagentRoots.set(threadId, summary.sessionId);
    return summary?.sessionId;
  }

  private async subagents(root: string): Promise<ProjectedSubagent[]> {
    if (!this.catalog.get(root)) await this.catalog.refresh();
    const summary = this.catalog.get(root);
    if (!summary) return [];
    const children = await projectSubagents(summary.path.replace(/\.jsonl$/u, ""), root).catch(() => []);
    for (const child of children) this.subagentRoots.set(`agent-${child.agentId}`, root);
    return children;
  }

  private async subagentProjection(threadId: string): Promise<TranscriptProjection | undefined> {
    const root = this.subagentRoot(threadId);
    const children = root ? await this.subagents(root) : [];
    const projection = children.find((child) => `agent-${child.agentId}` === threadId)?.projection;
    if (!projection || this.spawnedSubagents.get(threadId)?.status.type !== "idle" || projection.thread.status.type !== "active") return projection;
    // Settled, though Claude writes a sub-agent's last records a moment after that.
    const turns = projection.turns.map((turn, index) => index < projection.turns.length - 1 ? turn : { ...turn, status: "completed" as const });
    return { ...projection, turns, thread: { ...projection.thread, status: { type: "idle" } } };
  }

  /** Sub-agent threads spawned (directly or not) by a Claude session or sub-agent, parents first. */
  public async subagentThreads(ancestorId: string): Promise<Thread[]> {
    const root = ancestorId.startsWith("agent-") ? this.subagentRoot(ancestorId) : ancestorId;
    if (!root) return [];
    const descendants = new Set([ancestorId]);
    const threads = (await this.subagents(root)).flatMap(({ projection }) => {
      if (!descendants.has(projection.thread.parentThreadId ?? "")) return [];
      descendants.add(projection.thread.id);
      return [{ ...projection.thread, turns: [] }];
    });
    const spawned = [...this.spawnedSubagents.values()].filter((thread) =>
      descendants.has(thread.parentThreadId ?? "") && !threads.some((listed) => listed.id === thread.id));
    return [...threads, ...spawned];
  }

  /** Like stock, a spawned sub-agent is announced before its spawn completes (Desktop opens it right away), even
   *  though Claude writes its transcript a moment later. A foreground sub-agent's spawn completes only once it has
   *  finished (`running` false): it is announced settled. */
  public subagentSpawned(session: ClaudeSession, item: JsonObject, running: boolean): void {
    const childId: string = item.receiverThreadIds[0];
    const now = Math.floor(Date.now() / 1000);
    const header = { ...summarizeTranscript([]), cwd: session.settings.cwd, preview: preview(item.prompt ?? ""), model: item.model, createdAt: now, updatedAt: now };
    const thread = nativeThread(childId, header, {
      status: { type: "active", activeFlags: [] },
      subagent: { parentThreadId: session.threadId, depth: 1, nickname: `${item.agentsStates[childId].message} [${claudeModelLabel(item.model ?? "Claude")}]` },
    });
    this.subagentRoots.set(childId, session.threadId);
    this.spawnedSubagents.set(childId, thread);
    this.gateway.broadcast("thread/started", { thread });
    if (!running) return void this.subagentFinished(childId);
    this.watchSubagent(session, childId);
  }

  /** The coordinator's message resumed a sub-agent whose work had ended: it runs again (Claude's same task). */
  public async subagentResumed(session: ClaudeSession, childId: string): Promise<void> {
    const thread = this.spawnedSubagents.get(childId) ?? (await this.subagentProjection(childId))?.thread;
    if (!thread || this.liveSubagents.has(childId)) return;
    const status: Thread["status"] = { type: "active", activeFlags: [] };
    this.spawnedSubagents.set(childId, { ...thread, turns: [], status });
    this.gateway.emit(childId, "thread/status/changed", { threadId: childId, status });
    this.watchSubagent(session, childId);
  }

  /** Shows what a running sub-agent's transcript gets, as it gets it. */
  private watchSubagent(session: ClaudeSession, childId: string): void {
    const live = { shown: new Map<string, string>(), size: 0, poll: setInterval(() => {
      const summary = this.catalog.get(session.threadId);
      if (!summary) return void this.catalog.refresh();
      const transcript = join(summary.path.replace(/\.jsonl$/u, ""), "subagents", `${childId}.jsonl`);
      const size = existsSync(transcript) ? statSync(transcript).size : 0;
      if (size === live.size) return;
      live.size = size;
      this.subagentActivity(childId);
    }, 1000) };
    this.liveSubagents.set(childId, live);
  }

  /** A live sub-agent's task settled (Claude's task id is its agent id). */
  public async subagentFinished(childId: string): Promise<void> {
    const thread = this.spawnedSubagents.get(childId);
    if (!thread) return;
    const live = this.liveSubagents.get(childId);
    if (live) {
      clearInterval(live.poll);
      await live.refresh;
      // Claude writes the sub-agent's last records a moment after its task settles.
      let turn = await this.refreshSubagent(childId);
      for (let waited = 0; turn?.status === "inProgress" && waited < 10_000; waited += 250) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        turn = await this.refreshSubagent(childId);
      }
      this.liveSubagents.delete(childId);
      if (turn) {
        const status = turn.status === "inProgress" ? "completed" : turn.status;
        this.gateway.emit(childId, "turn/completed", { threadId: childId, turn: { ...turn, status, items: [], itemsView: "notLoaded" } });
      }
    }
    this.spawnedSubagents.set(childId, { ...thread, status: { type: "idle" } });
    this.gateway.emit(childId, "thread/status/changed", { threadId: childId, status: { type: "idle" } });
  }

  /** Something happened in a running sub-agent (a Codex MCP call it made said something): show it now. */
  public subagentActivity(childId: string): void {
    const live = this.liveSubagents.get(childId);
    if (live) live.refresh = (live.refresh ?? Promise.resolve()).then(async () => { await this.refreshSubagent(childId); });
  }

  /** Emits what the sub-agent's transcript (and its Codex calls) holds beyond what its thread already showed. */
  private async refreshSubagent(childId: string): Promise<Turn | undefined> {
    const live = this.liveSubagents.get(childId);
    const turn = live && (await this.subagentProjection(childId).catch(() => undefined))?.turns.at(-1);
    if (!live || !turn) return undefined;
    if (live.turnId !== turn.id) {
      live.turnId = turn.id;
      live.shown.clear();
      this.gateway.emit(childId, "turn/started", { threadId: childId, turn: { ...turn, items: [], itemsView: "notLoaded", status: "inProgress" } });
    }
    for (const item of turn.items) {
      const json = JSON.stringify(item);
      const shown = live.shown.get(item.id);
      if (shown === json) continue;
      if (shown === undefined) this.gateway.emit(childId, "item/started", { threadId: childId, turnId: turn.id, item, startedAtMs: Date.now() });
      this.gateway.emit(childId, "item/completed", { threadId: childId, turnId: turn.id, item, completedAtMs: Date.now() });
      live.shown.set(item.id, json);
    }
    return turn;
  }

  /** Thread with its turns (history + the live turn). */
  public async read(threadId: string): Promise<{ thread: Thread; turns: Turn[]; usage?: TranscriptProjection["tokenUsage"] }> {
    await this.models().catch(() => undefined);
    const side = this.sides.get(threadId);
    if (side) return { thread: this.sideThread(side), turns: side.turns };
    const session = this.sessions.get(threadId);
    const projection = threadId.startsWith("agent-") ? await this.subagentProjection(threadId) : await this.projection(threadId);
    if (!projection) {
      const spawned = this.spawnedSubagents.get(threadId);
      if (spawned) return { thread: spawned, turns: [] };
      if (!session) throw invalidParams(`thread not found: ${threadId}`);
      return { thread: this.decorate(this.freshThread(session)), turns: session.liveTurn() ? [session.liveTurn()!] : [] };
    }
    const turns = this.withLive(threadId, projection.turns);
    const summary = this.catalog.get(threadId);
    const header = summary ? this.headerOf(summary, session) : undefined;
    const thread = header
      ? nativeThread(threadId, header, { status: this.status(threadId) })
      : { ...projection.thread, turns: [] };
    return { thread: this.decorate(thread), turns, usage: projection.tokenUsage };
  }

  /** The thread without its history: the catalog's header, no transcript read. */
  public async thread(threadId: string): Promise<Thread> {
    const side = this.sides.get(threadId);
    if (side) return this.sideThread(side);
    if (!this.catalog.get(threadId)) await this.catalog.refresh();
    if (!this.paged(threadId)) return (await this.read(threadId)).thread;
    await this.models().catch(() => undefined);
    return this.decorate(nativeThread(threadId, this.headerOf(this.catalog.get(threadId)!, this.sessions.get(threadId)), { status: this.status(threadId) }));
  }

  /** A main session with a transcript: its history is read page by page (a sub-agent's, a small file of one turn, whole). */
  private paged(threadId: string): boolean {
    return !threadId.startsWith("agent-") && !this.sides.has(threadId) && this.catalog.has(threadId);
  }

  private pages(threadId: string): ReturnType<NativeSessionCatalog["pages"]> {
    return this.catalog.pages(threadId, this.leaves.get(threadId));
  }

  /** The running turn is the newest one, before Claude writes any of it too (a turn it goes on in after an answer). */
  private running(threadId: string, turnId: string): boolean {
    return this.sessions.get(threadId)?.liveTurn()?.id === turnId;
  }

  /** History turns with the live turn as the session shows it, and the background commands still running as running. */
  private withLive(threadId: string, history: readonly Turn[]): Turn[] {
    const session = this.sessions.get(threadId);
    const running = session?.runningCommands;
    let turns = running?.size ? history.map((turn) => ({
      ...turn,
      items: turn.items.map((item) => running.has(item.id) ? { ...item, status: "inProgress", exitCode: null, aggregatedOutput: null, durationMs: null } as ThreadItem : item),
    })) : [...history];
    const live = session?.liveTurn();
    // Stock's stale turns: one the transcript leaves unfinished with none running here (its Claude died with a daemon
    // restart) was interrupted. A sub-agent runs in its parent's session.
    if (!live) return threadId.startsWith("agent-") ? turns : turns.map((turn) => turn.status === "inProgress" ? { ...turn, status: "interrupted" } : turn);
    const index = turns.findIndex((turn) => turn.id === live.id);
    if (index >= 0) turns = [...turns.slice(0, index), { ...turns[index]!, status: "inProgress", completedAt: null }];
    else turns.push(live);
    return turns;
  }

  /** The newest turns (at least `count` unless history is shorter). */
  private async newestTurns(threadId: string, count: number): Promise<{ turns: Turn[]; usage?: TranscriptProjection["tokenUsage"] }> {
    if (!this.catalog.get(threadId)) await this.catalog.refresh();
    if (!this.paged(threadId)) return this.read(threadId);
    const { pages, source } = this.pages(threadId);
    const window = await pages.newest(source, count);
    return { turns: this.withLive(threadId, window.turns), usage: window.projection.tokenUsage };
  }

  public async turnsPage(threadId: string, params: JsonObject): Promise<JsonObject> {
    if (!this.catalog.get(threadId)) await this.catalog.refresh();
    const anchor = params.cursor ? anchorCursor("turnId", params.cursor) : undefined;
    const descending = (params.sortDirection ?? "desc") === "desc";
    // Oldest first from the start: the one page that needs all of history.
    if (!this.paged(threadId) || !descending && !anchor) return paginateTurns((await this.read(threadId)).turns, params);
    const { pages, source } = this.pages(threadId);
    const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
    const window = !anchor || this.running(threadId, anchor.anchor) ? await pages.newest(source, limit + 1)
      : descending ? await pages.around(source, anchor.anchor, limit + 1)
        : await pages.since(source, anchor.anchor);
    return paginateTurns(this.withLive(threadId, window.turns), params);
  }

  /** Stock's `thread/searchOccurrences`: history is read back only to the first message holding the term (ripgrep finds it). */
  public async searchOccurrences(threadId: string, params: JsonObject): Promise<JsonObject> {
    if (!String(params.searchTerm ?? "").trim()) throw invalidRequest("thread/searchOccurrences requires a non-empty searchTerm");
    if (!this.catalog.get(threadId)) await this.catalog.refresh();
    let turns: Turn[];
    if (this.paged(threadId)) {
      const { pages, source } = this.pages(threadId);
      const at = await firstMatch(this.config.claudeBinary, source.path, params.searchTerm);
      turns = this.withLive(threadId, at === undefined ? [] : (await pages.reaching(source, at)).turns);
    } else turns = (await this.read(threadId)).turns;
    return occurrencesPage(turnOccurrences(turns, params.searchTerm), params);
  }

  public async itemsPage(threadId: string, params: JsonObject): Promise<JsonObject> {
    if (!this.catalog.get(threadId)) await this.catalog.refresh();
    // Desktop always names the turn; items across the whole thread need all of it.
    if (!this.paged(threadId) || !params.turnId) return paginateItems((await this.read(threadId)).turns, params);
    const { pages, source } = this.pages(threadId);
    const window = this.running(threadId, params.turnId) ? await pages.newest(source, 1) : await pages.around(source, params.turnId, 0);
    const turn = this.withLive(threadId, window.turns).find((candidate) => candidate.id === params.turnId)!;
    const anchor = params.cursor ? anchorCursor("itemId", params.cursor)?.anchor : undefined;
    if (!anchor || turn.items.some((item) => item.id === anchor)) return paginateItems([turn], params);
    // Desktop pages an older turn from the thread's last item (the resume's backwards cursor): stock places the anchor
    // in the whole thread, so it stands here in a marker turn on its side of this one.
    const newest = (await this.newestTurns(threadId, 1)).turns;
    const turnAt = newest.findIndex((candidate) => candidate.id === turn.id);
    const anchorAt = newest.findIndex((candidate) => candidate.items.some((item) => item.id === anchor));
    const marker: Turn = { ...turn, id: `${turn.id}:anchor`, items: [{ type: "agentMessage", id: anchor, text: "", phase: null, memoryCitation: null }] };
    return paginateItems((anchorAt >= 0 ? anchorAt > turnAt : turnAt < 0) ? [turn, marker] : [marker, turn], params);
  }

  public settings(threadId: string): SessionSettings {
    const session = this.sessions.get(threadId);
    if (session) return session.settings;
    const summary = this.catalog.get(threadId);
    return {
      cwd: summary?.cwd ?? process.cwd(),
      model: (summary && this.recordedModel(summary)) || this.defaultModel,
      effort: summary ? this.recordedEffort(summary) : null,
      fast: summary?.serviceTier === "fast",
      ...recordedPermissions(threadId, summary?.permissionMode, this.gateway.meta),
    };
  }

  /** Common fields of thread/start|resume|fork responses and thread/settings/updated. */
  public settingsResponse(settings: SessionSettings): JsonObject {
    const permissions = codexPermissions(settings.permissionMode, settings.cwd);
    return {
      model: `${this.config.modelPrefix}${settings.model ?? this.defaultModel ?? "default"}`,
      modelProvider: "claude",
      serviceTier: settings.fast ? "fast" : null,
      disabledPluginIds: [],
      cwd: settings.cwd,
      runtimeWorkspaceRoots: [settings.cwd],
      instructionSources: [],
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandbox: permissions.sandboxPolicy,
      activePermissionProfile: permissions.activePermissionProfile,
      reasoningEffort: settings.effort,
      multiAgentMode: "explicitRequestOnly",
    };
  }

  public threadSettings(settings: SessionSettings): JsonObject {
    const response = this.settingsResponse(settings);
    return {
      disabledPluginIds: [],
      cwd: settings.cwd,
      approvalPolicy: response.approvalPolicy,
      approvalsReviewer: response.approvalsReviewer,
      sandboxPolicy: response.sandbox,
      activePermissionProfile: response.activePermissionProfile,
      model: response.model,
      modelProvider: "claude",
      serviceTier: response.serviceTier,
      effort: settings.effort,
      summary: null,
      collaborationMode: {
        mode: settings.plan ? "plan" : "default",
        settings: { model: response.model, reasoning_effort: settings.effort, developer_instructions: null },
      },
      multiAgentMode: "explicitRequestOnly",
      personality: null,
    };
  }

  public settingsFrom(params: JsonObject, current: SessionSettings): SessionSettings {
    const requested = requestedModel(params);
    const model = typeof requested === "string" && this.isClaudeModel(requested) ? this.modelValue(requested) : current.model;
    const tier = params.serviceTier === undefined ? undefined : params.serviceTier;
    return {
      cwd: params.cwd ?? current.cwd,
      model,
      effort: params.effort ?? params.collaborationMode?.settings?.reasoning_effort ?? current.effort,
      fast: tier === undefined ? current.fast : tier === "fast" || tier === "priority",
      ...permissionSettings(params, current),
    };
  }

  // ---- sessions ----

  public session(threadId: string): ClaudeSession {
    let session = this.sessions.get(threadId);
    if (session) return session;
    if (!this.catalog.get(threadId)) throw invalidParams(`thread not found: ${threadId}`);
    const leaf = this.leaves.get(threadId);
    session = new ClaudeSession(this, threadId, this.settings(threadId), { exists: true, ...(leaf ? { resumeAt: leaf } : {}) });
    this.sessions.set(threadId, session);
    return session;
  }

  /** The session continued from the rollback leaf: its new records end the history from now on. */
  public resumedAtLeaf(threadId: string): void {
    this.leaves.delete(threadId);
  }

  public turnCompleted(session: ClaudeSession, turnId: string): void {
    const threadId = session.threadId;
    const before = JSON.stringify(this.goal(threadId));
    void this.catalog.refresh().then(async () => {
      const name = this.pendingNames.get(threadId);
      this.pendingNames.delete(threadId);
      if (name) await this.rename(threadId, name);
      const goal = this.goal(threadId);
      if (JSON.stringify(goal) === before) return;
      // A goal replaced meanwhile (edited, paused, cleared) is no news: Desktop would clear the new goal for its completion.
      if (goal && session.goalObjective !== undefined && goal.objective !== session.goalObjective) return;
      if (goal) this.gateway.emit(threadId, "thread/goal/updated", { threadId, turnId, goal });
      else this.gateway.emit(threadId, "thread/goal/cleared", { threadId });
    });
    this.onTurnCompleted?.(threadId, turnId);
  }

  /**
   * Claude's native `/goal` as a Codex ThreadGoal (Claude tracks no budget or time); a paused one is kept in meta.json.
   * The goal last sent to Claude is the chat's: Claude records a `/goal` a moment after taking it.
   */
  public goal(threadId: string): JsonObject | null {
    const paused = this.gateway.meta.pausedGoal(threadId);
    const recorded = this.catalog.get(threadId)?.goal;
    const sent = this.sessions.get(threadId)?.goalObjective;
    const now = Math.floor(Date.now() / 1000);
    const goal = paused ? { ...paused, met: false }
      : sent === undefined || sent === recorded?.objective ? recorded
        : sent && { objective: sent, createdAt: now, updatedAt: now, met: false };
    if (!goal) return null;
    return {
      threadId, objective: goal.objective, status: paused ? "paused" : goal.met ? "complete" : "active", tokenBudget: null, tokensUsed: 0,
      timeUsedSeconds: Math.max(0, goal.updatedAt - goal.createdAt), createdAt: goal.createdAt, updatedAt: goal.updatedAt,
    };
  }

  public subagentMessage(_session: ClaudeSession, _message: JsonObject): void {
    // Sub-agent activity is shown by the parent's collabAgentToolCall item; child history is read from disk.
  }

  public onRateLimit(info: JsonObject | undefined): void {
    if (!info) return;
    // A turn's event carries every plan window Claude knows in `unifiedWindows` (utilization as a fraction); `status`,
    // and `utilization` if any, are about the window `rateLimitType` names. A window without one keeps the last known.
    const windows: Record<string, JsonObject> = { ...info.unifiedWindows };
    if (info.rateLimitType) windows[info.rateLimitType] = { resetsAt: info.resetsAt, utilization: info.utilization, ...windows[info.rateLimitType] };
    for (const [type, window] of Object.entries(windows)) {
      const status = type === info.rateLimitType ? info.status : "allowed";
      const usedPercent = typeof window.utilization === "number" ? Math.round(window.utilization * 100)
        : status === "rejected" ? 100 : this.rateLimitWindows.get(type)?.usedPercent;
      if (usedPercent === undefined) continue;
      this.rateLimitWindows.set(type, {
        status,
        usedPercent,
        windowDurationMins: WINDOW_MINUTES[type] ?? null,
        resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : null,
      });
    }
    const snapshot = this.rateLimitSnapshot();
    for (const connection of this.gateway.connections) {
      if (connection.provider === "claude") connection.notify("account/rateLimits/updated", { rateLimits: snapshot });
    }
  }

  private rateLimitSnapshot(): JsonObject {
    const window = (key: string) => {
      const value = this.rateLimitWindows.get(key);
      return value ? { usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins, resetsAt: value.resetsAt } : null;
    };
    return {
      limitId: "claude",
      limitName: "Claude",
      primary: window("five_hour"),
      secondary: window("seven_day") ?? window("seven_day_opus") ?? window("seven_day_sonnet"),
      credits: null,
      planType: null,
      rateLimitReachedType: [...this.rateLimitWindows.values()].some((value) => value.status === "rejected") ? "rate_limit_reached" : null,
    };
  }

  /** Claude's plan limits: read from Claude's `/usage` data at most once a minute, and as turns report them. */
  public async rateLimits(): Promise<JsonObject> {
    if (!this.usage || Date.now() - this.usage.at > 60_000) this.usage = { at: Date.now(), done: this.readUsage() };
    await this.usage.done;
    const snapshot = this.rateLimitSnapshot();
    return { rateLimits: snapshot, rateLimitsByLimitId: { claude: snapshot } };
  }

  private async readUsage(): Promise<void> {
    try {
      const usage = await withProbeQuery(this.config, undefined, (probe) => probe.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
      // No windows at all: claude.ai's usage endpoint failed (e.g. rate-limited) and Claude had nothing recent cached.
      if (usage.rate_limits_available && !usage.rate_limits) throw new Error("claude.ai's usage endpoint did not answer");
      this.usageError = usage.rate_limits_available ? undefined : "no plan limits for this login (API key or cloud provider)";
      // Absent when Claude answers from its cached data: the last known stay.
      if (usage.rate_limits?.model_scoped) this.modelLimits = usage.rate_limits.model_scoped.filter((row) => typeof row.utilization === "number").map((row) => ({
        name: row.display_name,
        window: { usedPercent: Math.round(row.utilization!), windowDurationMins: 10_080, resetsAt: row.resets_at ? Math.floor(Date.parse(row.resets_at) / 1000) : null },
      }));
      for (const type of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const) {
        const window = usage.rate_limits?.[type];
        if (typeof window?.utilization !== "number") continue;
        this.rateLimitWindows.set(type, {
          status: window.utilization >= 100 ? "rejected" : "allowed",
          usedPercent: Math.round(window.utilization),
          windowDurationMins: WINDOW_MINUTES[type]!,
          resetsAt: window.resets_at ? Math.floor(Date.parse(window.resets_at) / 1000) : null,
        });
      }
    } catch (error) {
      this.usageError = `limits unavailable: ${error instanceof Error ? error.message : String(error)}`;
      this.logger.warn("claude.usage.unavailable", { error: this.usageError });
    }
  }

  public rateLimitWindowsText(): string[] {
    return [...this.rateLimitWindows.entries()].map(([key, value]) =>
      `${key}: ${value.usedPercent}% used${value.resetsAt ? `, resets ${new Date(value.resetsAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""} (${value.status})`);
  }

  // ---- models and skills ----

  public models(): Promise<JsonObject[]> {
    this.models_ ??= this.probeModels().catch((error: unknown) => {
      this.models_ = undefined;
      throw error;
    });
    return this.models_;
  }

  private get modelsPath(): string {
    return join(this.config.dataDir, "claude-models.json");
  }

  private cachedModels(): ClaudeModel[] | undefined {
    try {
      const cache = JSON.parse(readFileSync(this.modelsPath, "utf8")) as { version: string; models: ClaudeModel[] };
      // As stock's models cache: one another version wrote (another Claude, another model list) is stale.
      return cache.version === packageVersion() ? cache.models : undefined;
    } catch {
      return undefined;
    }
  }

  /** Asks Claude for its models and keeps them for the next start. */
  private async probeModels(): Promise<JsonObject[]> {
    const models = await withProbeQuery(this.config, undefined, async (probe) => {
      const models: ClaudeModel[] = await probe.supportedModels();
      // Claude's own context budget per model: its window, capped by settings such as CLAUDE_CODE_AUTO_COMPACT_WINDOW.
      // A model Claude lists but does not switch to here (an account or organization restriction, a failed check)
      // stays listed as Claude lists it, with the default window.
      for (const model of models) {
        model.contextWindow = await probe.setModel(model.value)
          .then(() => probe.getContextUsage({ detail: "summary" }))
          .then((usage) => usage.maxTokens, () => undefined);
      }
      return models;
    });
    const temporary = `${this.modelsPath}.${process.pid}.tmp`;
    void writeFile(temporary, JSON.stringify({ version: packageVersion(), models }), { mode: 0o600 }).then(() => rename(temporary, this.modelsPath)).catch(() => undefined);
    return this.useModels(models);
  }

  private useModels(models: ClaudeModel[]): JsonObject[] {
    const resolved = models.find((model) => model.value === "default")?.resolvedModel;
    this.defaultModel = resolved ? normalizeClaudeModelIdentifier(resolved) : null;
    for (const model of models) {
      if (model.value !== "default" && model.resolvedModel) this.pickerValues.set(normalizeClaudeModelIdentifier(model.resolvedModel), modelCatalogValue(model));
      if (!model.contextWindow) continue;
      this.contextWindows.set(modelCatalogValue(model), model.contextWindow);
      if (model.resolvedModel) this.contextWindows.set(normalizeClaudeModelIdentifier(model.resolvedModel), model.contextWindow);
    }
    const mapped = models.filter((model) => model.value !== "default").map((model) => mapClaudeModel(model, this.config.modelPrefix));
    for (const [index, model] of models.filter((model) => model.value !== "default").entries()) {
      if (!model.supportedEffortLevels?.length) continue;
      const effort = mapped[index]!.defaultReasoningEffort as string;
      this.defaultEfforts.set(modelCatalogValue(model), effort);
      if (model.resolvedModel) this.defaultEfforts.set(normalizeClaudeModelIdentifier(model.resolvedModel), effort);
    }
    return mapped;
  }

  /** The effort Claude runs at: the chat's, else its model's default as the picker shows it (Claude's own may differ). */
  public effort(settings: SessionSettings): string | null {
    return settings.effort ?? this.defaultEfforts.get(normalizeClaudeModelIdentifier(settings.model || this.defaultModel || "")) ?? null;
  }

  /** The context window Claude works with for a model (picker value or resolved id; none: the default model). */
  public contextWindow(model: string | null | undefined): number {
    return this.contextWindows.get(normalizeClaudeModelIdentifier(model || this.defaultModel || "")) ?? DEFAULT_CONTEXT_WINDOW;
  }

  public modelLabel(model: string | null): string {
    return model ? claudeModelLabel(model) : "Claude (default)";
  }

  private readonly pendingNames = new Map<string, string>();
  private readonly pickerValues = new Map<string, string>();
  private readonly defaultEfforts = new Map<string, string>();
  private readonly skillCache = new Map<string, { at: number; skills: Promise<JsonObject[]> }>();

  public async skills(cwds: readonly string[]): Promise<Map<string, JsonObject[]>> {
    const entries = await Promise.all(cwds.map(async (cwd) => {
      const cached = this.skillCache.get(cwd);
      if (!cached || Date.now() - cached.at > 5 * 60_000) {
        const skills = withProbeQuery(this.config, cwd, (probe) => probe.supportedCommands())
          .then((commands) => Promise.all(commands.map((command) => mapSkill(this.config, cwd, command))));
        // An outdated list answers at once while the fresh one loads.
        this.skillCache.set(cwd, { at: Date.now(), skills: cached?.skills ?? skills.catch(() => []) });
        if (cached) void skills.then((fresh) => this.skillCache.set(cwd, { at: Date.now(), skills: Promise.resolve(fresh) }), () => undefined);
      }
      return [cwd, await this.skillCache.get(cwd)!.skills] as const;
    }));
    return new Map(entries);
  }

  // ---- side chats (/side → Claude's native /btw) ----

  private sideThread(side: SideThread): Thread {
    const settings = this.settings(side.sourceId);
    return {
      ...nativeThread(side.id, {
        cwd: side.cwd, gitBranch: null, createdAt: side.createdAt, updatedAt: side.createdAt, preview: "",
        customTitle: null, aiTitle: null, model: settings.model, reasoningEffort: settings.effort, serviceTier: null,
        permissionMode: null, cliVersion: null, goal: null,
      }, { status: { type: "idle" } }),
      ephemeral: true,
      forkedFromId: side.sourceId,
    };
  }

  private async sideTurn(side: SideThread, params: JsonObject): Promise<Turn> {
    const input = normalizeUserInput(params.input ?? []);
    // Desktop's description turn (after a rename) wants JSON matching its schema; Claude's side question answers in prose.
    const schema = params.outputSchema;
    const typed = input.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
    const question = schema ? `${typed}\n\nAnswer with only a JSON object matching this JSON Schema, nothing else:\n${JSON.stringify(schema)}` : typed;
    const id = randomUUID();
    const started = Math.floor(Date.now() / 1000);
    const turn: Turn = { id, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: started, completedAt: null, durationMs: null };
    const emit = (method: string, payload: JsonObject) => this.gateway.emit(side.id, method, payload);
    emit("turn/started", { threadId: side.id, turn: startedTurn(turn) });
    const userItem = { type: "userMessage" as const, id: `${id}:user`, clientId: params.clientUserMessageId ?? null, content: input };
    emit("item/started", { item: userItem, threadId: side.id, turnId: id, startedAtMs: Date.now() });
    emit("item/completed", { item: userItem, threadId: side.id, turnId: id, completedAtMs: Date.now() });
    turn.items.push(userItem);
    void (async () => {
      const history = side.turns.flatMap((previous) => previous.items.flatMap((item) =>
        item.type === "userMessage" ? [`Q: ${item.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")}`]
          : item.type === "agentMessage" ? [`A: ${item.text}`] : []));
      let text: string;
      let failed = false;
      try {
        text = await this.session(side.sourceId).askSideQuestion(history.length
          ? `Earlier in this side conversation:\n${history.join("\n")}\n\nNew question: ${question}`
          : question);
        if (schema) text = JSON.stringify(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
      } catch (error) {
        text = `Side question failed: ${error instanceof Error ? error.message : String(error)}`;
        failed = true;
      }
      const answer = { type: "agentMessage" as const, id: `${id}:answer`, text, phase: "final_answer", memoryCitation: null };
      emit("item/started", { item: { ...answer, text: "" }, threadId: side.id, turnId: id, startedAtMs: Date.now() });
      emit("item/agentMessage/delta", { threadId: side.id, turnId: id, itemId: answer.id, delta: text });
      emit("item/completed", { item: answer, threadId: side.id, turnId: id, completedAtMs: Date.now() });
      turn.items.push(answer);
      turn.status = failed ? "failed" : "completed";
      turn.completedAt = Math.floor(Date.now() / 1000);
      emit("turn/completed", { threadId: side.id, turn: { ...turn, items: [], itemsView: "notLoaded", error: failed ? { message: text, codexErrorInfo: null, additionalDetails: null } : null } });
    })();
    side.turns.push(turn);
    return startedTurn(turn);
  }

  // ---- request handling for Claude-owned threads ----

  public async handle(connection: Connection, method: string, params: JsonObject): Promise<unknown> {
    const threadId: string = params.threadId;
    const side = threadId ? this.sides.get(threadId) : undefined;
    if (side) return this.handleSide(connection, side, method, params);
    switch (method) {
      case "thread/start": return this.startThread(connection, params);
      case "thread/resume": return this.resume(connection, params);
      // All turns only when asked for them (deprecated for paginated threads; Desktop pages).
      case "thread/read": return { thread: params.includeTurns ? await this.read(threadId).then(({ thread, turns }) => ({ ...thread, turns })) : await this.thread(threadId) };
      case "thread/turns/list": return this.turnsPage(threadId, params);
      case "thread/items/list": return this.itemsPage(threadId, params);
      case "thread/searchOccurrences": return this.searchOccurrences(threadId, params);
      case "turn/start": {
        this.gateway.subscribe(threadId, connection);
        return { turn: await this.session(threadId).startTurn(params) };
      }
      case "turn/steer": return { turnId: await this.session(threadId).steer(params) };
      case "turn/interrupt": {
        await this.sessions.get(threadId)?.interrupt();
        return {};
      }
      case "thread/unsubscribe": {
        this.gateway.unsubscribe(threadId, connection);
        return { status: "unsubscribed" };
      }
      case "thread/name/set": return this.rename(threadId, String(params.name ?? ""));
      case "thread/archive":
      case "thread/unarchive": {
        const archived = method === "thread/archive";
        this.gateway.meta.setArchived(threadId, archived);
        this.gateway.emit(threadId, archived ? "thread/archived" : "thread/unarchived", { threadId });
        return archived ? {} : { thread: await this.thread(threadId) };
      }
      case "thread/delete": return this.delete(threadId);
      case "thread/fork": return this.fork(connection, params);
      case "thread/rollback": return this.rollback(threadId, Number(params.numTurns ?? 1));
      case "thread/revert": return this.revert(threadId, String(params.beforeTurnId));
      case "thread/compact/start": {
        await this.session(threadId).command("/compact");
        return {};
      }
      case "thread/settings/update": {
        await this.session(threadId).updateSettings(params);
        return {};
      }
      // Claude's settings have no per-turn scope: the running turn's change stays for the chat.
      case "turn/settings/update": {
        const session = this.sessions.get(threadId);
        if (!session?.busy) return { status: "targetUnavailable" };
        await session.updateSettings(params);
        return { status: "applied" };
      }
      case "thread/metadata/update": return { thread: await this.thread(threadId) };
      case "thread/attachment/list": return { data: [], nextCursor: null };
      case "thread/inject_items": {
        await this.session(threadId).inject((params.items ?? []).map((item: JsonObject) => JSON.stringify(item)).join("\n"));
        return {};
      }
      case "thread/goal/get": {
        // Claude drops a goal once it is met; Codex clients clear a completed goal themselves.
        const goal = this.goal(threadId);
        return { goal: goal?.status === "complete" ? null : goal };
      }
      case "thread/goal/set": {
        await this.catalog.refresh();
        const now = Math.floor(Date.now() / 1000);
        const current = this.goal(threadId);
        if (params.objective) {
          this.gateway.meta.setPausedGoal(threadId, null);
          const session = this.session(threadId);
          const goal = {
            threadId, objective: params.objective, status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0,
            createdAt: now, updatedAt: now,
          };
          // Like stock, the goal's turn starts after the answer: Desktop shows the goal message itself on the answer.
          setImmediate(() => {
            this.gateway.emit(threadId, "thread/goal/updated", { threadId, turnId: null, goal });
            session.goal(params.objective, current?.status === "active")
              .catch((error: unknown) => this.logger.warn("claude.goal.start-failed", { threadId, error: String(error) }));
          });
          return { goal };
        }
        // Claude's `/goal` has no pause: pausing clears it there (stopping its turn) and keeps it in meta.json; resuming
        // sets it again.
        const pausing = params.status === "paused" && current?.status === "active";
        const resuming = params.status === "active" && current?.status === "paused";
        if (!pausing && !resuming) return { goal: current };
        const goal: JsonObject = { ...current!, status: params.status, updatedAt: now, timeUsedSeconds: Math.max(0, now - current!.createdAt) };
        this.gateway.meta.setPausedGoal(threadId, pausing ? { objective: goal.objective, createdAt: goal.createdAt, updatedAt: now } : null);
        setImmediate(() => {
          this.gateway.emit(threadId, "thread/goal/updated", { threadId, turnId: null, goal });
          this.session(threadId).goal(pausing ? "clear" : goal.objective, pausing)
            .catch((error: unknown) => this.logger.warn("claude.goal.update-failed", { threadId, error: String(error) }));
        });
        return { goal };
      }
      case "thread/goal/clear": {
        await this.catalog.refresh();
        const goal = this.goal(threadId);
        if (!goal) return { cleared: false };
        this.gateway.meta.setPausedGoal(threadId, null);
        setImmediate(() => {
          this.gateway.emit(threadId, "thread/goal/cleared", { threadId });
          // Claude drops a met goal itself.
          if (goal.status === "active") {
            this.session(threadId).goal("clear", true)
              .catch((error: unknown) => this.logger.warn("claude.goal.clear-failed", { threadId, error: String(error) }));
          }
        });
        return { cleared: true };
      }
      case "thread/queue/list": return { data: this.sessions.get(threadId)?.queued ?? [], nextCursor: null };
      case "thread/queue/add": {
        const session = this.session(threadId);
        const queuedSubmission = { id: randomUUID(), input: normalizeUserInput(params.input ?? []), clientUserMessageId: params.clientUserMessageId };
        if (session.busy && !session.waitingOnTasks) session.queued.push(queuedSubmission);
        else await session.startTurn({ input: queuedSubmission.input, clientUserMessageId: queuedSubmission.clientUserMessageId });
        this.gateway.emit(threadId, "thread/queue/changed", { threadId });
        return { queuedSubmission };
      }
      case "thread/queue/delete":
      case "thread/queue/update":
      case "thread/queue/reorder":
      case "thread/queue/start": return this.queue(threadId, method, params);
      case "thread/backgroundTerminals/list": {
        const session = this.sessions.get(threadId);
        return {
          data: (session?.backgroundTasks ?? []).filter((task) => task.taskType === "local_bash").map((task) => ({
            itemId: task.toolUseId ?? task.taskId, processId: task.taskId, command: task.description, cwd: session!.settings.cwd,
            osPid: null, cpuPercent: null, rssKb: null,
          })),
          nextCursor: null,
        };
      }
      case "thread/backgroundTerminals/terminate": {
        await this.sessions.get(threadId)?.stopTask(String(params.processId));
        return {};
      }
      case "thread/backgroundTerminals/clean": {
        const session = this.sessions.get(threadId);
        for (const task of session?.tasks.values() ?? []) await session!.stopTask(task.taskId);
        return {};
      }
      case "review/start":
      case "thread/shellCommand":
        throw invalidRequest(`${method === "review/start" ? "/review" : "!command"} is not supported in Claude threads.`);
      default:
        throw invalidRequest(`${method} is not supported in Claude threads.`);
    }
  }

  private async handleSide(connection: Connection, side: SideThread, method: string, params: JsonObject): Promise<unknown> {
    switch (method) {
      case "turn/start":
        this.gateway.subscribe(side.id, connection);
        return { turn: await this.sideTurn(side, params) };
      case "thread/read": return { thread: { ...this.sideThread(side), turns: params.includeTurns ? side.turns : [] } };
      case "thread/resume": {
        this.gateway.subscribe(side.id, connection);
        return { thread: { ...this.sideThread(side), turns: side.turns }, ...this.settingsResponse(this.settings(side.sourceId)), initialTurnsPage: null, ...historyCursors(side.turns) };
      }
      case "thread/turns/list": return paginateTurns(side.turns, params);
      case "thread/items/list": return paginateItems(side.turns, params);
      case "thread/searchOccurrences": return occurrencesPage(turnOccurrences(side.turns, params.searchTerm), params);
      case "thread/unsubscribe":
      case "thread/delete":
      case "thread/archive":
        this.gateway.unsubscribe(side.id, connection);
        if (method !== "thread/unsubscribe") this.sides.delete(side.id);
        return method === "thread/unsubscribe" ? { status: "unsubscribed" } : {};
      case "turn/interrupt":
      case "thread/settings/update":
      case "thread/name/set":
      case "thread/metadata/update":
      // Desktop's "side conversation boundary": Claude's side question already treats the thread as reference only.
      case "thread/inject_items":
        return {};
      case "thread/attachment/list":
      case "thread/queue/list":
      case "thread/backgroundTerminals/list":
        return { data: [], nextCursor: null };
      case "thread/goal/get":
        return { goal: null };
      default:
        throw invalidRequest(`${method} is not available in a side chat.`);
    }
  }

  private async startThread(connection: Connection, params: JsonObject): Promise<JsonObject> {
    await this.models().catch(() => undefined);
    const settings = this.settingsFrom(params, {
      cwd: params.cwd ?? process.cwd(), model: this.defaultModel, effort: null, fast: false, permissionMode: "default", plan: false,
    });
    const session = this.create(settings);
    const threadId = session.threadId;
    this.gateway.subscribe(threadId, connection);
    const thread = this.decorate(this.freshThread(session));
    // After the response, as stock: Desktop hides its new-chat draft's `thread/started` only once it knows the id.
    setImmediate(() => this.gateway.emit(threadId, "thread/started", { thread }));
    this.gateway.titles.track(threadId);
    this.prewarm(session);
    return { thread, ...this.settingsResponse(settings) };
  }

  /**
   * The chat last opened gets Claude's process started ahead of its prompt (one such process at a time); an earlier chat
   * only once it stayed open a while, so clicking through chats starts none.
   */
  private warmSession?: ClaudeSession;
  private warmTimer?: NodeJS.Timeout;

  private prewarm(session: ClaudeSession, delayMs = 0): void {
    clearTimeout(this.warmTimer);
    if (this.warmSession !== session) this.warmSession?.discardWarm();
    this.warmSession = session;
    this.warmTimer = setTimeout(() => { if (this.sessions.get(session.threadId) === session) session.prewarm(); }, delayMs);
    this.warmTimer.unref();
  }

  /** A new session, not announced (thread/start announces it; a provider switch keeps it hidden). */
  public create(settings: SessionSettings): ClaudeSession {
    const session = new ClaudeSession(this, uuidv7(), { ...settings, model: settings.model ?? this.defaultModel }, { exists: false });
    this.sessions.set(session.threadId, session);
    return session;
  }

  private async resume(connection: Connection, params: JsonObject): Promise<JsonObject> {
    const threadId: string = params.threadId;
    this.gateway.subscribe(threadId, connection);
    const thread = await this.thread(threadId);
    const { turns, usage } = await this.newestTurns(threadId, 1);
    // Like stock, the context meter follows a resume (Desktop's /status reads it).
    if (usage?.last) {
      const modelContextWindow = this.contextWindow(thread.model?.slice(this.config.modelPrefix.length));
      setImmediate(() => this.gateway.emit(threadId, "thread/tokenUsage/updated", { threadId, turnId: turns.at(-1)?.id ?? null, tokenUsage: { ...usage, modelContextWindow } }));
    }
    // A sub-agent has no session of its own: it shows the model, effort and directory it runs with.
    const settings = thread.parentThreadId && thread.model
      ? { ...this.settings(threadId), cwd: thread.cwd, model: this.pickerModel(thread.model.slice(this.config.modelPrefix.length)), effort: thread.reasoningEffort ?? null }
      : this.settings(threadId);
    if (!thread.parentThreadId && this.catalog.get(threadId)) this.prewarm(this.session(threadId), RESUME_WARM_MS);
    const response: JsonObject = {
      thread: { ...thread, turns: params.excludeTurns ? [] : turns },
      ...this.settingsResponse(settings),
      collaborationMode: this.threadSettings(settings).collaborationMode,
      initialTurnsPage: params.initialTurnsPage ? await this.turnsPage(threadId, { ...params.initialTurnsPage, threadId }) : null,
      ...historyCursors(turns),
    };
    return response;
  }

  public async rename(threadId: string, name: string): Promise<JsonObject> {
    if (!this.catalog.get(threadId)) await this.catalog.refresh();
    const summary = this.catalog.get(threadId);
    // A brand-new session has no transcript until its first message is written; its name waits for that turn.
    if (summary) {
      // Claude holds the title it read and writes it again as its transcript grows, taking a newer one only from the
      // transcript's last 64 KB: a running Claude gets the new title itself, and one started ahead with the old goes.
      const session = this.sessions.get(threadId);
      session?.discardWarm();
      if (session?.loaded) await session.rename(name);
      else await renameSession(threadId, name, { dir: summary.cwd });
      this.pendingNames.delete(threadId);
    } else this.pendingNames.set(threadId, name);
    await this.catalog.refresh();
    this.gateway.emit(threadId, "thread/name/updated", { threadId, threadName: name });
    return {};
  }

  /** The goal of a Claude backend the chat switches away from, out of Claude (a running goal turn stops). */
  public async takeGoal(threadId: string): Promise<JsonObject | null> {
    await this.catalog.refresh();
    const goal = this.goal(threadId);
    if (goal?.status === "active") await this.session(threadId).goal("clear", true);
    this.gateway.meta.setPausedGoal(threadId, null);
    return goal?.status === "complete" ? null : goal;
  }

  /** A goal the chat brings to this Claude backend as it switches (or keeps as a switch fails). */
  public async giveGoal(threadId: string, goal: JsonObject): Promise<void> {
    if (goal.status === "paused") this.gateway.meta.setPausedGoal(threadId, { objective: goal.objective, createdAt: goal.createdAt, updatedAt: goal.updatedAt });
    else await this.session(threadId).goal(goal.objective, false);
  }

  /** A Claude backend the chat switched away from: nothing of it runs on (background tasks, process). */
  public async retire(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.sessions.delete(threadId);
    await session.stopTasks();
    const pids = sessionProcesses().filter((process) => process.session === threadId).map((process) => process.pid);
    await session.unload();
    killProcesses(pids);
  }

  /** Removes a session with its transcript (also what a failed switch to Claude leaves behind). */
  public async discard(threadId: string): Promise<void> {
    await this.sessions.get(threadId)?.unload();
    this.sessions.delete(threadId);
    await this.catalog.refresh();
    if (this.catalog.get(threadId)) await deleteSession(threadId);
    this.catalog.dropPages(threadId);
    this.gateway.meta.forget(threadId);
    await this.catalog.refresh();
  }

  private async delete(threadId: string): Promise<JsonObject> {
    await this.discard(threadId);
    this.gateway.emit(threadId, "thread/deleted", { threadId });
    return {};
  }

  /** Last transcript record of the turn before `turnId` (or of `turnId` itself when `inclusive`). */
  private async boundaryBefore(threadId: string, turnId: string, inclusive: boolean): Promise<string | null> {
    if (!this.catalog.get(threadId)) await this.catalog.refresh();
    if (!this.catalog.get(threadId)) throw invalidParams(`thread not found: ${threadId}`);
    const { pages, source } = this.pages(threadId);
    return pages.boundary(source, turnId, inclusive).catch(() => { throw invalidParams(`turn not found: ${turnId}`); });
  }

  private async fork(connection: Connection, params: JsonObject): Promise<JsonObject> {
    const sourceId: string = params.threadId;
    if (params.ephemeral) {
      const side: SideThread = {
        id: uuidv7(), sourceId, cwd: this.settings(sourceId).cwd, createdAt: Math.floor(Date.now() / 1000), turns: [],
      };
      this.sides.set(side.id, side);
      this.gateway.subscribe(side.id, connection);
      return { thread: this.sideThread(side), ...this.settingsResponse(this.settings(sourceId)) };
    }
    const upTo = params.lastTurnId ? await this.boundaryBefore(sourceId, params.lastTurnId, true)
      : params.beforeTurnId ? await this.boundaryBefore(sourceId, params.beforeTurnId, false)
        : this.leaves.get(sourceId) ?? null;
    const summary = this.catalog.get(sourceId);
    if (!summary) throw invalidParams(`thread not found: ${sourceId}`);
    const { sessionId } = await forkSession(sourceId, { ...(upTo ? { upToMessageId: upTo } : {}) });
    await this.catalog.refresh();
    this.gateway.subscribe(sessionId, connection);
    const thread = await this.thread(sessionId);
    const turns = params.excludeTurns ? [] : (await this.newestTurns(sessionId, 25)).turns;
    const forked = { ...thread, forkedFromId: sourceId };
    setImmediate(() => this.gateway.emit(sessionId, "thread/started", { thread: forked }));
    const settings = this.settingsFrom(params, this.settings(sourceId));
    this.sessions.set(sessionId, new ClaudeSession(this, sessionId, settings, { exists: true }));
    return { thread: { ...forked, turns }, ...this.settingsResponse(settings) };
  }

  private async truncate(threadId: string, leaf: string | null): Promise<void> {
    const session = this.sessions.get(threadId);
    if (session?.busy) throw invalidRequest("Cannot roll back while a turn is running.");
    const settings = this.settings(threadId);
    await session?.unload();
    this.sessions.delete(threadId);
    if (leaf) {
      this.leaves.set(threadId, leaf);
      return;
    }
    // Everything rolled back: Claude neither resumes nor starts anew a transcript without messages, so the session
    // starts over under its id with its settings, and its name comes back with its first turn.
    const name = this.catalog.get(threadId)!.customTitle;
    await deleteSession(threadId);
    this.catalog.dropPages(threadId);
    this.leaves.delete(threadId);
    await this.catalog.refresh();
    this.sessions.set(threadId, new ClaudeSession(this, threadId, settings, { exists: false }));
    if (name) this.pendingNames.set(threadId, name);
  }

  private async rollback(threadId: string, numTurns: number): Promise<JsonObject> {
    if (!this.catalog.get(threadId)) await this.catalog.refresh();
    if (!this.catalog.get(threadId)) throw invalidParams(`thread not found: ${threadId}`);
    const { pages, source } = this.pages(threadId);
    const { turns: history } = await pages.newest(source, numTurns + 1);
    const kept = history.at(-numTurns - 1);
    await this.truncate(threadId, kept ? await pages.boundary(source, kept.id, true) : null);
    return { thread: { ...await this.thread(threadId), turns: (await this.newestTurns(threadId, 25)).turns } };
  }

  private async revert(threadId: string, beforeTurnId: string): Promise<JsonObject> {
    await this.truncate(threadId, await this.boundaryBefore(threadId, beforeTurnId, false));
    const thread = await this.thread(threadId);
    const { turns } = await this.newestTurns(threadId, 1);
    this.gateway.emit(threadId, "thread/reverted", { threadId });
    return { thread, ...historyCursors(turns) };
  }

  private async queue(threadId: string, method: string, params: JsonObject): Promise<JsonObject> {
    const session = this.session(threadId);
    const index = session.queued.findIndex((entry) => entry.id === params.queuedSubmissionId);
    const changed = () => this.gateway.emit(threadId, "thread/queue/changed", { threadId });
    switch (method) {
      case "thread/queue/delete":
        if (index >= 0) session.queued.splice(index, 1);
        changed();
        return { deleted: index >= 0 };
      case "thread/queue/update":
        session.queued[index] = { ...session.queued[index]!, input: normalizeUserInput(params.input ?? []) };
        changed();
        return { queuedSubmission: session.queued[index] };
      case "thread/queue/reorder": {
        const order: string[] = params.queuedSubmissionIds ?? [];
        session.queued.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
        changed();
        return {};
      }
      default: {
        const entry = index >= 0 ? session.queued.splice(index, 1)[0] : session.queued.shift();
        if (!entry) throw invalidRequest("nothing queued");
        changed();
        const turn = { input: entry.input, clientUserMessageId: entry.clientUserMessageId };
        if (!session.busy) return { turn: await session.startTurn(turn) };
        await session.steer(turn);
        return { turn: startedTurn(session.liveTurn()!) };
      }
    }
  }

  /** Summary-less description of a thread for /ccstate. */
  public state(threadId: string): JsonObject {
    const session = this.sessions.get(threadId);
    const settings = this.settings(threadId);
    return {
      model: this.modelLabel(session?.liveModel ?? settings.model),
      effort: settings.effort,
      fast: settings.fast,
      permissionMode: settings.permissionMode,
      plan: settings.plan,
      cwd: settings.cwd,
      loaded: session !== undefined,
      process: session?.loaded ?? false,
      actions: this.actions.get(threadId) ?? [],
      turnId: session?.turn?.id ?? null,
      usage: session?.totalUsage,
      contextWindow: this.contextWindow(session?.liveModel ?? settings.model),
      lastUsage: session?.lastUsage,
      backgroundTasks: session?.backgroundTasks.length ?? 0,
    };
  }

  /** The summary of Claude's latest compaction if nothing was said since ("" otherwise). */
  public async compactedSummary(threadId: string): Promise<string> {
    let summary = "";
    for await (const record of readTranscriptRecords(this.catalog.get(threadId)!.path)) {
      if (record.type === "user" && record.isCompactSummary) summary = userText(record);
      else if (record.type === "assistant" || (record.type === "user" && record.origin?.kind === "human")) summary = "";
    }
    return summary;
  }

  public summary(threadId: string): SessionSummary | undefined {
    return this.catalog.get(threadId);
  }

  public exists(threadId: string): boolean {
    return existsSync(this.catalog.get(threadId)?.path ?? "");
  }

  public liveSession(threadId: string): ClaudeSession | undefined {
    return this.sessions.get(threadId);
  }
}
