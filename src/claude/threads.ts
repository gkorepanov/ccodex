import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { deleteSession, forkSession, renameSession, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { v7 as uuidv7 } from "uuid";
import type { Config } from "../config.js";
import type { Connection } from "../gateway/connection.js";
import type { Gateway } from "../gateway/server.js";
import type { Logger } from "../log.js";
import { invalidParams, invalidRequest, requestedModel, type JsonObject, type Thread, type Turn } from "../protocol/codex.js";
import { historyCursors, paginateItems, paginateTurns, startedTurn } from "../protocol/turnPagination.js";
import { normalizeUserInput } from "./inputMapper.js";
import { claudeModelLabel, modelCatalogValue, normalizeClaudeModelIdentifier } from "./modelSelection.js";
import { NativeSessionCatalog, type SessionSummary } from "./native/catalog.js";
import { nativeThread, type TranscriptProjection } from "./native/projector.js";
import { projectSubagents, type ProjectedSubagent } from "./native/subagents.js";
import { readTranscriptRecords } from "./native/records.js";
import { summarizeTranscript, userText, type TranscriptHeader } from "./native/summary.js";
import { codexPermissions, mapClaudeModel, mapSkill, permissionModeFrom, withProbeQuery } from "./sdk.js";
import { ClaudeSession, type SessionSettings } from "./session.js";

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
const WINDOW_MINUTES: Record<string, number> = { five_hour: 300, seven_day: 10_080, seven_day_opus: 10_080, seven_day_sonnet: 10_080 };

/** The Claude side of the gateway: catalog of native sessions, live sessions, side chats, models, skills. */
export class ClaudeThreads {
  public readonly catalog: NativeSessionCatalog;
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly sides = new Map<string, SideThread>();
  /** `agent-<id>` sub-agent thread → the native session whose transcript directory holds it. */
  private readonly subagentRoots = new Map<string, string>();
  /** Sub-agents spawned live, shown until Claude has written their transcript. */
  private readonly spawnedSubagents = new Map<string, Thread>();
  /** Context window of each Claude model, as its sessions report it. */
  public readonly contextWindows = new Map<string, number>();
  /** Running sub-agents: their thread follows the transcript Claude writes (what was shown: item id → item). */
  private readonly liveSubagents = new Map<string, { turnId?: string; shown: Map<string, string>; size: number; poll: NodeJS.Timeout; refresh?: Promise<void> }>();
  private models_?: Promise<JsonObject[]>;
  private defaultModel: string | null = null;
  private readonly rateLimitWindows = new Map<string, RateLimitWindow & { status: string }>();
  private stopWatching?: () => void;
  public onTurnCompleted?: (threadId: string, turnId: string) => void;

  public constructor(
    public readonly config: Config,
    public readonly gateway: Gateway,
    public readonly logger: Logger,
  ) {
    this.catalog = new NativeSessionCatalog(join(config.claudeHome, "projects"));
  }

  public async start(): Promise<void> {
    // The model list maps transcripts' resolved model ids to picker values (see pickerModel).
    void this.models().catch(() => undefined);
    await this.catalog.refresh();
    this.gateway.meta.prune((segment) => segment.provider === "codex" || this.catalog.get(segment.threadId) !== undefined);
    const known = new Map(this.catalog.sessions().map((summary) => [summary.sessionId, summary.customTitle ?? summary.aiTitle]));
    // Sessions and titles changed outside CCodex (the claude CLI, /rename) show up without a reload.
    this.stopWatching = this.catalog.watch(() => {
      for (const summary of this.catalog.sessions()) {
        const name = summary.customTitle ?? summary.aiTitle;
        const id = summary.sessionId;
        if (!known.has(id) && !this.sessions.has(id) && !this.gateway.meta.hidden(id)) {
          this.gateway.broadcast("thread/started", { thread: this.decorate(nativeThread(id, this.headerOf(summary, undefined), { status: this.status(id) })) });
        } else if (known.has(id) && known.get(id) !== name && name) {
          this.gateway.emit(id, "thread/name/updated", { threadId: id, threadName: name });
        }
        known.set(id, name);
      }
    });
    void this.models().catch((error: unknown) => this.logger.warn("claude.models.unavailable", { error: String(error) }));
  }

  public async close(): Promise<void> {
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

  public loadedIds(): string[] {
    return [...this.sessions.values()].filter((session) => session.loaded).map((session) => session.threadId);
  }

  // ---- list rows ----

  private status(threadId: string): Thread["status"] {
    const session = this.sessions.get(threadId);
    if (session?.busy) return { type: "active", activeFlags: [] };
    return session ? { type: "idle" } : { type: "notLoaded" };
  }

  private headerOf(summary: TranscriptHeader, session: ClaudeSession | undefined): TranscriptHeader {
    return {
      ...summary,
      model: session?.settings.model ?? (summary.model && this.pickerModel(summary.model)),
      reasoningEffort: session?.settings.effort ?? summary.reasoningEffort,
    };
  }

  /** Transcripts name the resolved model (`claude-haiku-4-5-…`); the picker (and a live session) its value (`haiku`). */
  private pickerModel(model: string): string {
    const id = normalizeClaudeModelIdentifier(model);
    return this.pickerValues.get(id) ?? id;
  }

  /** Every native session as a list row (sub-agents excluded; they are listed through their parent). */
  public threads(): Thread[] {
    const rows = this.catalog.sessions().map((summary) =>
      this.decorate(nativeThread(summary.sessionId, this.headerOf(summary, this.sessions.get(summary.sessionId)), { status: this.status(summary.sessionId) })));
    for (const session of this.sessions.values()) {
      if (!this.catalog.get(session.threadId)) rows.push(this.decorate(this.freshThread(session)));
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
      serviceTier: session.settings.fast ? "fast" : null, permissionMode: session.settings.permissionMode, cliVersion: null, goal: null,
    }, { status: this.status(session.threadId) });
  }

  // ---- reads ----

  private async projection(threadId: string): Promise<TranscriptProjection | undefined> {
    if (!this.catalog.get(threadId)) await this.catalog.refresh();
    if (!this.catalog.get(threadId)) return undefined;
    return this.catalog.projection(threadId, this.gateway.meta.leaf(threadId));
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
    const header = { ...summarizeTranscript([]), cwd: session.settings.cwd, preview: item.prompt ?? "", model: item.model, createdAt: now, updatedAt: now };
    const thread = nativeThread(childId, header, {
      status: { type: "active", activeFlags: [] },
      subagent: { parentThreadId: session.threadId, depth: 1, nickname: `${item.agentsStates[childId].message} [${claudeModelLabel(item.model ?? "Claude")}]` },
    });
    this.subagentRoots.set(childId, session.threadId);
    this.spawnedSubagents.set(childId, thread);
    this.gateway.broadcast("thread/started", { thread });
    if (!running) return void this.subagentFinished(childId);
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
    let turns = [...projection.turns];
    const live = session?.liveTurn();
    if (live) {
      const index = turns.findIndex((turn) => turn.id === live.id);
      if (index >= 0) turns = [...turns.slice(0, index), { ...turns[index]!, status: "inProgress", completedAt: null }];
      else turns.push(live);
    }
    const summary = this.catalog.get(threadId);
    const header = summary ? this.headerOf(summary, session) : undefined;
    const thread = header
      ? nativeThread(threadId, header, { status: this.status(threadId) })
      : { ...projection.thread, turns: [] };
    return { thread: this.decorate(thread), turns, usage: projection.tokenUsage };
  }

  public settings(threadId: string): SessionSettings {
    const session = this.sessions.get(threadId);
    if (session) return session.settings;
    const summary = this.catalog.get(threadId);
    return {
      cwd: summary?.cwd ?? process.cwd(),
      model: summary?.model ? this.pickerModel(summary.model) : this.defaultModel,
      effort: summary?.reasoningEffort ?? null,
      fast: summary?.serviceTier === "fast",
      permissionMode: (summary?.permissionMode ?? "default") as PermissionMode,
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
        mode: settings.permissionMode === "plan" ? "plan" : "default",
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
      permissionMode: permissionModeFrom(params) ?? current.permissionMode,
    };
  }

  // ---- sessions ----

  public session(threadId: string): ClaudeSession {
    let session = this.sessions.get(threadId);
    if (session) return session;
    if (!this.catalog.get(threadId)) throw invalidParams(`thread not found: ${threadId}`);
    const leaf = this.gateway.meta.leaf(threadId);
    session = new ClaudeSession(this, threadId, this.settings(threadId), { exists: true, ...(leaf ? { resumeAt: leaf } : {}) });
    this.sessions.set(threadId, session);
    return session;
  }

  /** The session continued from the rollback leaf: its new records end the history from now on. */
  public resumedAtLeaf(threadId: string): void {
    this.gateway.meta.setLeaf(threadId, null);
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
      if (goal) this.gateway.emit(threadId, "thread/goal/updated", { threadId, turnId, goal });
      else this.gateway.emit(threadId, "thread/goal/cleared", { threadId });
    });
    this.onTurnCompleted?.(threadId, turnId);
  }

  /** Claude's native `/goal` as a Codex ThreadGoal (Claude tracks no budget or time). */
  public goal(threadId: string): JsonObject | null {
    const goal = this.catalog.get(threadId)?.goal;
    if (!goal) return null;
    return {
      threadId, objective: goal.objective, status: goal.met ? "complete" : "active", tokenBudget: null, tokensUsed: 0,
      timeUsedSeconds: Math.max(0, goal.updatedAt - goal.createdAt), createdAt: goal.createdAt, updatedAt: goal.updatedAt,
    };
  }

  public subagentMessage(_session: ClaudeSession, _message: JsonObject): void {
    // Sub-agent activity is shown by the parent's collabAgentToolCall item; child history is read from disk.
  }

  public onRateLimit(info: JsonObject | undefined): void {
    if (!info?.rateLimitType) return;
    this.rateLimitWindows.set(info.rateLimitType, {
      status: info.status,
      usedPercent: Math.round(Number(info.utilization ?? (info.status === "rejected" ? 1 : 0)) * 100),
      windowDurationMins: WINDOW_MINUTES[info.rateLimitType] ?? null,
      resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : null,
    });
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

  public async rateLimits(): Promise<JsonObject> {
    const snapshot = this.rateLimitSnapshot();
    return { rateLimits: snapshot, rateLimitsByLimitId: { claude: snapshot } };
  }

  public rateLimitWindowsText(): string[] {
    return [...this.rateLimitWindows.entries()].map(([key, value]) =>
      `${key}: ${value.usedPercent}% used${value.resetsAt ? `, resets ${new Date(value.resetsAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""} (${value.status})`);
  }

  // ---- models and skills ----

  public models(): Promise<JsonObject[]> {
    this.models_ ??= withProbeQuery(this.config, undefined, (probe) => probe.supportedModels()).then((models) => {
      const resolved = models.find((model) => model.value === "default")?.resolvedModel;
      this.defaultModel = resolved ? normalizeClaudeModelIdentifier(resolved) : null;
      for (const model of models) {
        if (model.value !== "default" && model.resolvedModel) this.pickerValues.set(normalizeClaudeModelIdentifier(model.resolvedModel), modelCatalogValue(model));
      }
      return models.filter((model) => model.value !== "default").map((model) => mapClaudeModel(model, this.config.modelPrefix));
    }).catch((error: unknown) => {
      this.models_ = undefined;
      throw error;
    });
    return this.models_;
  }

  public modelLabel(model: string | null): string {
    return model ? claudeModelLabel(model) : "Claude (default)";
  }

  private readonly pendingNames = new Map<string, string>();
  private readonly pickerValues = new Map<string, string>();
  private readonly skillCache = new Map<string, { at: number; skills: Promise<JsonObject[]> }>();

  public async skills(cwds: readonly string[]): Promise<Map<string, JsonObject[]>> {
    const entries = await Promise.all(cwds.map(async (cwd) => {
      const cached = this.skillCache.get(cwd);
      if (!cached || Date.now() - cached.at > 5 * 60_000) {
        const skills = withProbeQuery(this.config, cwd, (probe) => probe.supportedCommands())
          .then((commands) => Promise.all(commands.map((command) => mapSkill(this.config, cwd, command))))
          .catch(() => []);
        this.skillCache.set(cwd, { at: Date.now(), skills });
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
    const question = input.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
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
      case "thread/read": {
        const { thread, turns } = await this.read(threadId);
        return { thread: { ...thread, turns: params.includeTurns ? turns : [] } };
      }
      case "thread/turns/list": return paginateTurns((await this.read(threadId)).turns, params);
      case "thread/items/list": return paginateItems((await this.read(threadId)).turns, params);
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
        return archived ? {} : { thread: (await this.read(threadId)).thread };
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
        const session = this.session(threadId);
        if (await session.updateSettings(params)) {
          this.gateway.emit(threadId, "thread/settings/updated", { threadId, threadSettings: this.threadSettings(session.settings) });
        }
        return {};
      }
      case "thread/metadata/update": return { thread: (await this.read(threadId)).thread };
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
        const now = Math.floor(Date.now() / 1000);
        const current = this.goal(threadId);
        if (params.objective) {
          const session = this.session(threadId);
          const goal = {
            threadId, objective: params.objective, status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0,
            createdAt: now, updatedAt: now,
          };
          // Like stock, the goal's turn starts after the answer: Desktop shows the goal message itself on the answer.
          setImmediate(() => {
            this.gateway.emit(threadId, "thread/goal/updated", { threadId, turnId: null, goal });
            session.command(`/goal ${params.objective}`)
              .catch((error: unknown) => this.logger.warn("claude.goal.start-failed", { threadId, error: String(error) }));
          });
          return { goal };
        }
        if (params.status && params.status !== "active" && current?.status === "active") await this.session(threadId).command("/goal clear");
        return { goal: current ? { ...current, status: params.status ?? current.status, updatedAt: now } : null };
      }
      case "thread/goal/clear": {
        const goal = this.goal(threadId);
        if (goal?.status === "active") await this.session(threadId).command("/goal clear");
        this.gateway.emit(threadId, "thread/goal/cleared", { threadId });
        return { cleared: goal !== null };
      }
      case "thread/queue/list": return { data: this.sessions.get(threadId)?.queued ?? [], nextCursor: null };
      case "thread/queue/add": {
        const session = this.session(threadId);
        const queuedSubmission = { id: randomUUID(), input: normalizeUserInput(params.input ?? []), clientUserMessageId: params.clientUserMessageId };
        if (session.busy) session.queued.push(queuedSubmission);
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
          data: [...session?.tasks.values() ?? []].filter((task) => task.taskType === "local_bash").map((task) => ({
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
      cwd: params.cwd ?? process.cwd(), model: this.defaultModel, effort: null, fast: false, permissionMode: "default",
    });
    const session = this.create(settings);
    const threadId = session.threadId;
    this.gateway.subscribe(threadId, connection);
    const thread = this.decorate(this.freshThread(session));
    this.gateway.emit(threadId, "thread/started", { thread });
    this.gateway.titles.track(threadId);
    return { thread, ...this.settingsResponse(settings) };
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
    const { thread, turns, usage } = await this.read(threadId);
    // Like stock, the context meter follows a resume (Desktop's /status reads it).
    if (usage?.last) {
      const modelContextWindow = this.contextWindows.get((thread.model ?? "").slice(this.config.modelPrefix.length)) ?? DEFAULT_CONTEXT_WINDOW;
      setImmediate(() => this.gateway.emit(threadId, "thread/tokenUsage/updated", { threadId, turnId: turns.at(-1)?.id ?? null, tokenUsage: { ...usage, modelContextWindow } }));
    }
    // A sub-agent has no session of its own: it shows the model and directory it runs with.
    const settings = thread.parentThreadId && thread.model
      ? { ...this.settings(threadId), cwd: thread.cwd, model: this.pickerModel(thread.model.slice(this.config.modelPrefix.length)) }
      : this.settings(threadId);
    const response: JsonObject = {
      thread: { ...thread, turns: params.excludeTurns ? [] : turns },
      ...this.settingsResponse(settings),
      collaborationMode: null,
      initialTurnsPage: params.initialTurnsPage ? paginateTurns(turns, params.initialTurnsPage) : null,
      ...historyCursors(turns),
    };
    return response;
  }

  public async rename(threadId: string, name: string): Promise<JsonObject> {
    if (!this.catalog.get(threadId)) await this.catalog.refresh();
    const summary = this.catalog.get(threadId);
    // A brand-new session has no transcript until its first message is written; its name waits for that turn.
    if (summary) {
      await renameSession(threadId, name, { dir: summary.cwd });
      this.pendingNames.delete(threadId);
    } else this.pendingNames.set(threadId, name);
    await this.catalog.refresh();
    this.gateway.emit(threadId, "thread/name/updated", { threadId, threadName: name });
    return {};
  }

  /** Removes a session with its transcript (also what a failed switch to Claude leaves behind). */
  public async discard(threadId: string): Promise<void> {
    await this.sessions.get(threadId)?.unload();
    this.sessions.delete(threadId);
    await this.catalog.refresh();
    if (this.catalog.get(threadId)) await deleteSession(threadId);
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
    const projection = await this.projection(threadId);
    if (!projection) throw invalidParams(`thread not found: ${threadId}`);
    const index = projection.turns.findIndex((turn) => turn.id === turnId);
    if (index < 0) throw invalidParams(`turn not found: ${turnId}`);
    const kept = projection.turns[inclusive ? index : index - 1];
    return kept ? projection.turnBoundaries.find((boundary) => boundary.turnId === kept.id)?.messageUuid ?? null : null;
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
        : this.gateway.meta.leaf(sourceId) ?? null;
    const summary = this.catalog.get(sourceId);
    if (!summary) throw invalidParams(`thread not found: ${sourceId}`);
    const { sessionId } = await forkSession(sourceId, { ...(upTo ? { upToMessageId: upTo } : {}) });
    await this.catalog.refresh();
    this.gateway.subscribe(sessionId, connection);
    const { thread, turns } = await this.read(sessionId);
    const forked = { ...thread, forkedFromId: sourceId };
    this.gateway.emit(sessionId, "thread/started", { thread: forked });
    const settings = this.settingsFrom(params, this.settings(sourceId));
    this.sessions.set(sessionId, new ClaudeSession(this, sessionId, settings, { exists: true }));
    return { thread: { ...forked, turns: params.excludeTurns ? [] : turns }, ...this.settingsResponse(settings) };
  }

  private async truncate(threadId: string, leaf: string | null): Promise<void> {
    const session = this.sessions.get(threadId);
    if (session?.busy) throw invalidRequest("Cannot roll back while a turn is running.");
    const settings = this.settings(threadId);
    await session?.unload();
    this.sessions.delete(threadId);
    if (leaf) {
      this.gateway.meta.setLeaf(threadId, leaf);
      return;
    }
    // Everything rolled back: Claude neither resumes nor starts anew a transcript without messages, so the session
    // starts over under its id with its settings, and its name comes back with its first turn.
    const name = this.catalog.get(threadId)!.customTitle;
    await deleteSession(threadId);
    this.gateway.meta.setLeaf(threadId, null);
    await this.catalog.refresh();
    this.sessions.set(threadId, new ClaudeSession(this, threadId, settings, { exists: false }));
    if (name) this.pendingNames.set(threadId, name);
  }

  private async rollback(threadId: string, numTurns: number): Promise<JsonObject> {
    const projection = await this.projection(threadId);
    if (!projection) throw invalidParams(`thread not found: ${threadId}`);
    const keep = projection.turns.length - numTurns;
    const leaf = keep > 0 ? projection.turnBoundaries.find((boundary) => boundary.turnId === projection.turns[keep - 1]!.id)?.messageUuid ?? null : null;
    await this.truncate(threadId, leaf);
    const { thread, turns } = await this.read(threadId);
    return { thread: { ...thread, turns } };
  }

  private async revert(threadId: string, beforeTurnId: string): Promise<JsonObject> {
    await this.truncate(threadId, await this.boundaryBefore(threadId, beforeTurnId, false));
    const { thread, turns } = await this.read(threadId);
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
      loaded: session?.loaded ?? false,
      running: session?.busy ?? false,
      usage: session?.totalUsage,
      contextWindow: session?.contextWindow ?? null,
      lastUsage: session?.lastUsage,
      costUsd: session?.costUsd ?? 0,
      backgroundTasks: session?.tasks.size ?? 0,
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
