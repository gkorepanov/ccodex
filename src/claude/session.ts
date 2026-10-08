import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  query, startup, type CanUseTool, type Options, type PermissionMode, type PermissionResult, type Query, type SDKMessage,
  type SDKUserMessage, type WarmQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeInstructions } from "../instructions.js";
import type { JsonObject, QueuedSubmissionLike, ThreadItem, TokenUsageBreakdown, Turn, UserInput } from "../protocol/codex.js";
import { invalidRequest } from "../protocol/codex.js";
import { startedTurn } from "../protocol/turnPagination.js";
import {
  CODEX_MCP_TOOLS, codexMcpItem, tailCodexRollout, type CodexTurnContext,
} from "./codexRollout.js";
import { claudeContent, inputText, normalizeUserInput, userMessage } from "./inputMapper.js";
import { completedToolItem } from "./native/projector.js";
import { ANSWER_CHARS, assistantBlockItemId, continuationTurnId } from "./native/ids.js";
import { isNarration, messageText, readTranscriptRecords, type UserRecord } from "./native/records.js";
import { userText } from "./native/summary.js";
import { claudeEffort, DELEGATION_OFF, DELEGATION_ON, ULTRA } from "./delegation.js";
import { foreignOwner, peerKey, peerMessageItem, peerOrigin, sentMessageItem, subagentFiles, type Peers } from "./peers.js";
import { baseOptions, claudeMode } from "./sdk.js";
import { endedBackground, killedCommand, proposedChanges, startTool, stoppedCommand, updateToolInput, type ActiveTool, type BackgroundEnd } from "./toolMapper.js";
import type { ClaudeThreads } from "./threads.js";

export interface SessionSettings {
  cwd: string;
  /** Claude model value without the picker prefix; null = Claude's default. */
  model: string | null;
  effort: string | null;
  fast: boolean;
  /** The chat's permissions (never Claude's plan mode: that is `plan`). */
  permissionMode: PermissionMode;
  /** Codex plan mode (the collaboration mode). */
  plan: boolean;
}

interface ActiveTurn {
  readonly id: string;
  readonly startedAt: number;
  readonly items: ThreadItem[];
  resultSeen: boolean;
  interrupted: boolean;
  error: string | null;
}

interface Response {
  readonly id: string;
  hasTool: boolean;
  readonly texts: Map<number, ThreadItem & { type: "agentMessage" }>;
  reasoning?: ThreadItem & { type: "reasoning" };
  readonly blockKinds: Map<number, { kind: "text" | "thinking" | "tool"; summaryIndex?: number }>;
  /** The thinking block not shown yet: a narration or thinking, as its signature tells. */
  held?: { readonly index: number; text: string; readonly timer: NodeJS.Timeout };
}

/**
 * How long a thinking block waits for its signature before it shows as thinking: a narration (what Claude tells the
 * user between tool calls) comes whole with its signature at once, thinking streams for seconds before its own.
 */
const NARRATION_WAIT_MS = 500;

interface Tool {
  readonly state: ActiveTool;
  item: ThreadItem;
}

interface BackgroundTask {
  readonly taskId: string;
  readonly toolUseId: string | undefined;
  readonly description: string;
  readonly taskType: string | undefined;
}

/** The complete records Claude wrote from byte `start` on (at most the last 256 KB), and the byte they end at. */
function recordsFrom(path: string, start: number): { records: any[]; end: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(start, size - 262_144);
    const bytes = Buffer.alloc(Math.max(0, size - from));
    readSync(fd, bytes, 0, bytes.length, from);
    const complete = bytes.lastIndexOf(0x0a) + 1;
    const records = bytes.subarray(0, complete).toString("utf8").split("\n").flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    return { records, end: from + complete };
  } finally {
    closeSync(fd);
  }
}

/** The transcript's last prompt record (Claude writes it before it asks the model), not a tool result. */
function lastPrompt(path: string): UserRecord | undefined {
  return recordsFrom(path, 0).records.findLast((record: UserRecord) => record?.type === "user"
    && !(Array.isArray(record.message?.content) && record.message.content.some((block) => block.type === "tool_result")));
}

/** How long a process started ahead of a first prompt waits for it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const WARM_MS = 10 * 60_000;

interface WarmProcess {
  readonly key: string;
  query?: WarmQuery;
  closed: boolean;
}

class Inbox implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;

  public push(message: SDKUserMessage): void {
    this.items.push(message);
    this.wake?.();
  }

  public close(): void {
    this.closed = true;
    this.wake?.();
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

const EMPTY_USAGE: TokenUsageBreakdown = {
  totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
};
const YIELD_BUDGET_MS = 20;
export const INJECTED_PREFIX = "[Injected model-visible history]";

function breakdown(usage: Record<string, any> | undefined): TokenUsageBreakdown {
  const input = Number(usage?.input_tokens ?? 0);
  const cached = Number(usage?.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(usage?.cache_creation_input_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? 0);
  return {
    totalTokens: input + cached + cacheWrite + output,
    inputTokens: input + cached + cacheWrite,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: 0,
  };
}

function addUsage(left: TokenUsageBreakdown, right: TokenUsageBreakdown): TokenUsageBreakdown {
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteInputTokens: left.cacheWriteInputTokens + right.cacheWriteInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
  };
}

const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const PLAN_PROPOSED = "The plan is shown to the user, who answers in their next message (approving it ends plan mode). End your turn now, with no further text.";

/**
 * One live Claude session: a single streaming `query()` and one sequential loop that turns SDK messages
 * into Codex notifications. Claude persists everything; this object only holds the running turn.
 */
export class ClaudeSession {
  public turn: ActiveTurn | undefined;
  /** A turn was started here: before that the chat is Desktop's new-chat draft, which stock lists nowhere. */
  public started = false;
  public state: "idle" | "running" | "requires_action" = "idle";
  public readonly tasks = new Map<string, BackgroundTask>();
  /** Background commands running on past their turn (stock's background terminals), by task id. */
  private readonly background = new Map<string, { item: ThreadItem; turnId: string; startedAtMs: number }>();
  /** Output files of commands Stop killed while Claude waited on them, by their call. */
  private readonly killed = new Map<string, string>();
  /** TaskStop calls: shown on the command they stop, as stock shows a Ctrl-C (by tool use id). */
  private readonly stops = new Map<string, Tool>();
  /** Claude's sub-agents running (in the background they keep no turn open: each has a chat of its own). */
  private readonly agents = new Set<string>();
  public queued: QueuedSubmissionLike[] = [];
  public totalUsage: TokenUsageBreakdown = EMPTY_USAGE;
  public lastUsage: TokenUsageBreakdown = EMPTY_USAGE;
  public liveModel: string | null = null;
  private sdk?: Query;
  /** Last sign of life: a message from Claude, a prompt, a command. */
  public activeAt = Date.now();
  /** Claude's scheduled wakeups (CronCreate, ScheduleWakeup, /loop) as of the last turn's end: the process must stay. */
  private crons = 0;
  /** Settles once the query's process is gone: Claude writes its last transcript records on the way out. */
  private consumed: Promise<void> = Promise.resolve();
  private inbox?: Inbox;
  private response?: Response;
  private readonly tools = new Map<string, Tool>();
  private readonly streamed = new Set<string>();
  /** Usage per model response; streamed assistant messages repeat it and never carry a stop reason. */
  private readonly usageByMessage = new Map<string, TokenUsageBreakdown>();
  private readonly pendingInputs = new Map<string, { input: UserInput[]; clientId: string | null; hidden: boolean }>();
  /** Injected context (`shouldQuery: false`) runs a silent query of its own: no turn is shown for it. */
  private readonly injections = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly turnWaiters = new Map<string, (status: string) => void>();
  private runningTimer?: NodeJS.Timeout;
  private exists: boolean;
  public compactSummary?: (summary: string) => void;
  private readonly codexTails = new Map<string, () => void>();
  /** Claude's task list (TaskCreate/TaskUpdate), sent like stock's plan updates: the client shows it as the turn's to-do list. */
  private readonly plan = new Map<string, { step: string; status: string }>();
  /** Messages from other agents shown (peerKey), whichever of transcript and result told them first. */
  private readonly peerMessages = new Set<string>();
  /** The goal last sent to Claude with `/goal` (null: cleared); undefined until this session sends one. */
  public goalObjective: string | null | undefined;
  /** The running turn's result came: Claude answering again means it took another prompt by itself. */
  private afterResult = false;
  /** Proactive delegation (the `ultra` effort) as last told to Claude (its transcript's, for a chat loaded again). */
  private delegating: boolean;
  /** A task's end came with no turn running: the command Claude runs for it goes on after the last answer. */
  private notified = false;
  /** Claude's last block since a turn began (its item id; the text item while it streams text). */
  private lastBlock?: { id: string; text?: { text: string } };
  private transcript?: string;
  /** Where the transcript ended when the turn began, then as far as it was read for messages queued mid-turn. */
  private transcriptRead = 0;

  public constructor(
    private readonly host: ClaudeThreads,
    public readonly threadId: string,
    public settings: SessionSettings,
    options: { exists: boolean; resumeAt?: string },
  ) {
    this.exists = options.exists;
    this.resumeAt = options.resumeAt;
    this.delegating = host.summary(threadId)?.delegating ?? false;
    this.keepPlan();
  }

  /** Claude's transcript records only its plan mode and the model it plans on: from plan mode on, the chat's own settings
   *  wait in meta.json until a turn out of plan mode records them (turning plan mode off records nothing). */
  private keepPlan(): void {
    const { meta } = this.host.gateway;
    if (this.settings.plan || meta.plan(this.threadId)) {
      meta.setPlan(this.threadId, { permissionMode: this.settings.permissionMode, model: this.settings.model, effort: this.settings.effort, plan: this.settings.plan });
    }
  }

  private resumeAt: string | undefined;

  public get loaded(): boolean { return this.sdk !== undefined; }

  public get busy(): boolean { return this.turn !== undefined; }

  /** Nothing to do for `idleMs` (closing its process loses nothing: the next turn resumes from disk). */
  public quiet(now: number, idleMs: number): boolean {
    return !this.turn && !this.tasks.size && !this.queued.length && !this.injections.size && !this.crons && now - this.activeAt >= idleMs;
  }

  /** No turn runs, only background tasks. */
  /** Tasks running on their own: not a command or sub-agent the turn still waits on (its call open). */
  public get backgroundTasks(): BackgroundTask[] {
    return [...this.tasks.values()].filter((task) => !task.toolUseId || !this.tools.has(task.toolUseId));
  }

  public get waitingOnTasks(): boolean {
    return !this.turn && this.tasks.size > 0;
  }

  /** The item ids of the background commands running (history shows them ended unless they run here). */
  public get runningCommands(): ReadonlySet<string> {
    return new Set([...this.background.values()].map(({ item }) => item.id));
  }

  /** Stops the background tasks as Claude's own stop control does: Claude learns they were stopped, not that they failed. */
  public async stopTasks(): Promise<void> {
    await Promise.all([...this.tasks.keys()].map((taskId) => this.stopTask(taskId)));
  }

  // ---- lifecycle ----

  /** The process started ahead of the first prompt (prewarm), and what it was started with. */
  private warm?: WarmProcess;

  private optionsKey(): string {
    return JSON.stringify([this.settings, this.exists, this.resumeAt ?? null]);
  }

  /** Starts Claude's process before the first prompt, so that prompt does not wait for it; unused, it goes. */
  public prewarm(): void {
    if (this.sdk || this.warm) return;
    const warm: WarmProcess = { key: this.optionsKey(), closed: false };
    this.warm = warm;
    void startup({ options: this.options() }).then(
      (ready) => { if (warm.closed) ready.close(); else warm.query = ready; },
      () => { if (this.warm === warm) this.warm = undefined; },
    );
    setTimeout(() => { if (this.warm === warm) this.discardWarm(); }, WARM_MS).unref();
  }

  public discardWarm(): void {
    if (!this.warm) return;
    this.warm.closed = true;
    this.warm.query?.close();
    this.warm = undefined;
  }

  private ensureQuery(): Query {
    if (this.sdk) return this.sdk;
    this.inbox = new Inbox();
    const ready = this.warm?.key === this.optionsKey() ? this.warm.query : undefined;
    if (ready) this.warm = undefined;
    else this.discardWarm();
    const sdk = ready ? ready.query(this.inbox) : query({ prompt: this.inbox, options: this.options() });
    this.sdk = sdk;
    this.exists = true;
    if (this.resumeAt) this.host.resumedAtLeaf(this.threadId);
    this.resumeAt = undefined;
    this.consumed = this.consume(sdk);
    return sdk;
  }

  private options(): Options {
    const settings = this.settings;
    const effort = claudeEffort(this.host.effort(settings));
    return {
      ...baseOptions(this.host.config),
      cwd: settings.cwd,
      ...(settings.model ? { model: settings.model } : {}),
      ...(effort ? { effort: effort as never } : {}),
      ...(settings.fast ? { settings: { fastMode: true } } : {}),
      permissionMode: claudeMode(settings),
      // Recorded on the chat's first request and reused until compaction, as Claude Code keeps its system prompt.
      systemPrompt: { type: "preset", preset: "claude_code", append: claudeInstructions(this.host.config.improveModelsFormatting) },
      // Claude enters plan mode only as the user sets it (stock's collaboration mode).
      disallowedTools: ["EnterPlanMode"],
      // Claude 5 omits its thinking by default: summarized, it shows as the turn's reasoning summary like stock's.
      extraArgs: { "thinking-display": "summarized" },
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      ...(this.exists ? { resume: this.threadId } : { sessionId: this.threadId }),
      ...(this.resumeAt ? { resumeSessionAt: this.resumeAt } : {}),
      canUseTool: this.canUseTool,
      onElicitation: async (request) => this.elicit(request),
      hooks: {
        Stop: [{ hooks: [async (input: any) => { this.crons = Array.isArray(input.session_crons) ? input.session_crons.length : 0; return {}; }] }],
        PostCompact: [{ hooks: [async (input: any) => { this.compactSummary?.(String(input.compact_summary ?? "")); return {}; }] }],
        PreToolUse: [{ matcher: "mcp__codex__.*", hooks: [async (input: any) => {
          this.codexMcpCall(String(input.tool_name), input.tool_input ?? {}, String(input.tool_use_id), input.agent_id);
          return {};
        }] }],
      },
      stderr: (line) => this.host.logger.debug("claude.stderr", { threadId: this.threadId, line }),
    };
  }

  private async consume(sdk: Query): Promise<void> {
    let slice = Date.now();
    let failure = "";
    try {
      for await (const message of sdk) {
        try {
          this.handle(message);
        } catch (error) {
          this.host.logger.error("claude.message.failed", { threadId: this.threadId, error: String((error as Error).stack ?? error) });
        }
        if (Date.now() - slice > YIELD_BUDGET_MS) {
          await new Promise((resolve) => setImmediate(resolve));
          slice = Date.now();
        }
      }
    } catch (error) {
      this.host.logger.warn("claude.query.ended", { threadId: this.threadId, error: String(error) });
      failure = `: ${error instanceof Error ? error.message : String(error)}`;
      if (this.turn) this.turn.error ??= `Claude stopped${failure}`;
    }
    if (this.sdk !== sdk) return;
    // Claude stopped before it wrote anything (its first turn failed): the next turn starts the session anew.
    if (failure && !this.transcriptPath()) this.exists = false;
    // Context Claude never took (it stopped, or never started) fails whoever waits on it.
    for (const { reject } of this.injections.values()) reject(new Error(`Claude stopped${failure}`));
    this.injections.clear();
    this.sdk = undefined;
    this.inbox = undefined;
    this.state = "idle";
    this.tasks.clear();
    this.agents.clear();
    if (this.turn) {
      this.turn.resultSeen = true;
      this.maybeComplete();
    }
  }

  /** Closes the query; the next turn resumes the session from disk. */
  public unload(): Promise<void> {
    this.discardWarm();
    const sdk = this.sdk;
    this.sdk = undefined;
    this.inbox?.close();
    this.inbox = undefined;
    sdk?.close();
    return this.consumed;
  }

  // ---- inputs ----

  public async startTurn(params: JsonObject): Promise<Turn> {
    // Two processes writing one transcript fork it: whatever the other one writes next is lost to the chat.
    const owner = this.turn ? undefined : foreignOwner(this.host.config.claudeHome, this.threadId);
    if (owner) throw invalidRequest(`This chat is open in another Claude process (pid ${owner}): close it there or wait until it ends.`);
    const input = normalizeUserInput(params.input ?? []);
    const goal = /^\/goal\s+(\S[\s\S]*)/u.exec(inputText(input))?.[1]!.trim();
    if (goal) this.goalObjective = goal === "clear" ? null : goal;
    const uuid: string = params.turnId ?? randomUUID();
    await this.applyTurnSettings(params);
    // Its message records the chat's own mode in the transcript.
    if (!this.settings.plan) this.host.gateway.meta.setPlan(this.threadId, null);
    const content = await claudeContent(input, this.settings.cwd);
    // Desktop shows `/goal` messages itself.
    const hidden = typeof content === "string" && /^\/(?:compact|goal)(?:\s|$)/u.test(content);
    if (this.turn) {
      // Claude folds a message sent mid-turn into the running turn, like a steer.
      this.pendingInputs.set(uuid, { input, clientId: params.clientUserMessageId ?? null, hidden });
      this.ensureQuery();
      this.inbox!.push(userMessage(content, uuid));
      return startedTurn(this.liveTurn()!);
    }
    // Like stock's multi-agent mode message: in the thread once the mode changes.
    if ((this.settings.effort === ULTRA) !== this.delegating) {
      this.delegating = !this.delegating;
      await this.inject(this.delegating ? DELEGATION_ON : DELEGATION_OFF);
    }
    const turn = this.openTurn(uuid, input, params.clientUserMessageId ?? null, hidden, params.turnId !== undefined);
    this.ensureQuery();
    this.inbox!.push(userMessage(content, uuid));
    return startedTurn(turn);
  }

  /** Text-only turn issued by CCodex itself (e.g. `/goal`, `/compact <prompt>`). */
  public async command(text: string): Promise<Turn> {
    return this.startTurn({ input: [{ type: "text", text, text_elements: [] }] });
  }

  public async steer(params: JsonObject): Promise<string> {
    if (!this.turn) throw invalidRequest("no active turn to steer");
    const input = normalizeUserInput(params.input ?? []);
    // The client's id is the message's in the transcript: history gives it back as the message's client id.
    const uuid: string = UUID.test(params.clientUserMessageId ?? "") ? params.clientUserMessageId : randomUUID();
    this.pendingInputs.set(uuid, { input, clientId: params.clientUserMessageId ?? null, hidden: false });
    this.ensureQuery();
    this.inbox!.push(userMessage(await claudeContent(input, this.settings.cwd), uuid));
    // As Claude Code's "send now" (and stock's steer): what the turn waits on moves to the background, so Claude reads
    // the message at that tool result, not after a long command. The message is written first.
    if (this.sdk && [...this.tasks.values()].some((task) => task.toolUseId && this.tools.has(task.toolUseId))) {
      await new Promise((resolve) => setImmediate(resolve));
      await this.sdk.backgroundTasks().catch(() => false);
    }
    return this.turn.id;
  }

  /** Model-visible context without a model reply (provider switch summary, injected items). */
  public inject(text: string): Promise<void> {
    return this.quietly(`${INJECTED_PREFIX}\n${text}`, { shouldQuery: false, origin: undefined } as unknown as Partial<SDKUserMessage>);
  }

  /**
   * Claude's `/goal` (its only goal API). Claude pursues a goal in one turn until it is met and runs a command sent
   * meanwhile only after that: with a goal active, a running turn stops first. Clearing is no turn: Codex clients show
   * goals themselves.
   */
  public async goal(args: string, active: boolean): Promise<void> {
    // Desktop's goal mode sends the goal's message as a turn, then sets the goal: Claude has it already (a second
    // `/goal` would wait behind that turn and set the old goal again once an edit or pause stops it).
    if (args === this.goalObjective && this.turn) return;
    this.goalObjective = args === "clear" ? null : args;
    if (active && this.turn) {
      const done = this.turnDone(this.turn.id);
      await this.interrupt();
      await done;
    }
    if (args === "clear") await this.quietly("/goal clear");
    else await this.command(`/goal ${args}`);
  }

  /** A message that opens no turn; resolves once Claude has taken it. */
  private quietly(content: string, extra?: Partial<SDKUserMessage>): Promise<void> {
    const uuid = randomUUID();
    this.ensureQuery();
    return new Promise((resolve, reject) => {
      this.injections.set(uuid, { resolve, reject });
      this.inbox!.push(userMessage(content, uuid, extra));
    });
  }

  /** Resolves with the final status once the turn completes. */
  public turnDone(turnId: string): Promise<string> {
    return new Promise((resolve) => this.turnWaiters.set(turnId, resolve));
  }

  public async interrupt(): Promise<void> {
    if (!this.turn) return;
    this.turn.interrupted = true;
    if (!this.sdk) {
      this.completeTurn();
      return;
    }
    this.host.gateway.cancelServerRequests(this.threadId);
    // Stop stops all Claude runs: its background tasks and sub-agents too (a message sent meanwhile leaves them running).
    const sdk = this.sdk;
    // A command Claude waits on goes to the background first: only there Claude keeps a killed command's output.
    await Promise.all([...this.tasks.values()].filter((task) => task.taskType === "local_bash" && task.toolUseId && !this.background.has(task.taskId))
      .map((task) => sdk.backgroundTasks(task.toolUseId).catch(() => false)));
    // As stock and Claude Code's own Stop: messages steered in but not yet read are dropped, not run after it.
    const interrupt = (sdk.interrupt as (options: { cancelQueued: boolean }) => Promise<{ cancelled?: string[] } | undefined>)({ cancelQueued: true })
      .then((receipt) => { for (const uuid of receipt?.cancelled ?? []) this.pendingInputs.delete(uuid); });
    await Promise.all([interrupt, ...[...this.tasks.keys(), ...this.agents].map((id) => sdk.stopTask(id))].map((done) => done.catch(() => undefined)));
    for (const taskId of this.tasks.keys()) this.endBackground(taskId, { status: "stopped", summary: "", atMs: Date.now() });
    this.tasks.clear();
    this.agents.clear();
    if (this.state === "idle" && this.turn) {
      this.turn.resultSeen = true;
      this.maybeComplete();
    }
  }

  /** Claude takes the chat's new title itself (`rename_session`, as an IDE renames its session). */
  public async rename(title: string): Promise<void> {
    await (this.sdk as Query & { renameSession(title: string, sessionId: string): Promise<void> }).renameSession(title, this.threadId);
  }

  public async stopTask(taskId: string): Promise<void> {
    await this.sdk?.stopTask(taskId);
    this.endBackground(taskId, { status: "stopped", summary: "", atMs: Date.now() });
  }

  /** A background command ended: its item completes in the turn it started in, as stock's background terminal does. */
  private endBackground(taskId: string, end: BackgroundEnd): void {
    const running = this.background.get(taskId);
    if (!running) return;
    this.background.delete(taskId);
    const { item, turnId } = running;
    const ended = endedBackground(item, end, running.startedAtMs);
    const index = this.turn?.id === turnId ? this.turn.items.findIndex((candidate) => candidate.id === item.id) : -1;
    if (index >= 0) this.turn!.items[index] = ended;
    this.emit("item/completed", { item: ended, threadId: this.threadId, turnId, completedAtMs: end.atMs });
  }

  public async askSideQuestion(question: string): Promise<string> {
    const sdk = this.ensureQuery() as Query & { askSideQuestion(question: string, options?: object): Promise<{ response: string } | null> };
    const answer = await sdk.askSideQuestion(question);
    return answer?.response ?? "";
  }

  // ---- settings ----

  private async applyTurnSettings(params: JsonObject): Promise<void> {
    const update: JsonObject = {};
    for (const key of ["model", "effort", "serviceTier", "approvalPolicy", "approvalsReviewer", "sandboxPolicy", "permissions", "collaborationMode"]) {
      if (params[key] !== undefined && params[key] !== null) update[key] = params[key];
    }
    if (params.cwd) this.settings.cwd = params.cwd;
    if (Object.keys(update).length) await this.updateSettings(update);
  }

  public async updateSettings(params: JsonObject): Promise<void> {
    const next = this.host.settingsFrom(params, this.settings);
    const changed = JSON.stringify(next) !== JSON.stringify(this.settings);
    if (!changed) return;
    const previous = this.settings;
    this.settings = next;
    this.keepPlan();
    // Like stock, every client with the chat open learns the change (Desktop's composer follows it).
    this.emit("thread/settings/updated", { threadId: this.threadId, threadSettings: this.host.threadSettings(next) });
    if (this.sdk) {
      if (next.model !== previous.model) await this.sdk.setModel(next.model ?? undefined);
      // The CLI settles the mode per model (no auto mode on Haiku falls back to default): a new model re-applies it.
      if (claudeMode(next) !== claudeMode(previous) || next.model !== previous.model) await this.sdk.setPermissionMode(claudeMode(next));
      const effort = this.host.effort(next);
      if (effort !== this.host.effort(previous) || next.fast !== previous.fast) {
        await this.sdk.applyFlagSettings({ effortLevel: claudeEffort(effort) as never, fastMode: next.fast });
      }
    }
  }

  // ---- turn bookkeeping ----

  private newTurnObject(id: string): Turn {
    return {
      id, items: [], itemsView: "full", status: "inProgress", error: null,
      startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null,
    };
  }

  /** `announced`: the provider switch already started the turn under this preallocated id. */
  private openTurn(id: string, input: UserInput[], clientId: string | null, hidden: boolean, announced = false): Turn {
    const turn = this.newTurnObject(id);
    this.turn = { id, startedAt: Date.now(), items: turn.items, resultSeen: false, interrupted: false, error: null };
    this.started = true;
    this.activeAt = Date.now();
    this.afterResult = false;
    this.notified = false;
    this.lastBlock = undefined;
    try {
      this.transcriptRead = statSync(this.transcriptPath() ?? "").size;
    } catch {
      this.transcriptRead = 0;
    }
    if (!announced) this.emit("turn/started", { threadId: this.threadId, turn: startedTurn(turn) });
    this.emit("thread/status/changed", { threadId: this.threadId, status: { type: "active", activeFlags: [] } });
    if (!hidden) {
      const item: ThreadItem = { type: "userMessage", id, clientId, content: input };
      this.itemStarted(item);
      this.itemCompleted(item);
    }
    return turn;
  }

  /** In-progress turn as Codex shows it in thread/read and paging. */
  public liveTurn(): Turn | undefined {
    const turn = this.turn;
    if (!turn) return undefined;
    return {
      id: turn.id, items: turn.items, itemsView: "full", status: "inProgress", error: null,
      startedAt: Math.floor(turn.startedAt / 1000), completedAt: null, durationMs: null,
    };
  }

  private maybeComplete(): void {
    // Background commands run on past the turn (stock's background terminals); a task's end that wakes Claude up starts
    // a turn of its own.
    if (!this.turn || !this.turn.resultSeen || this.state !== "idle") return;
    this.completeTurn();
  }

  /** Claude goes on after an answer with no prompt: the answer ends its turn, the work goes on in a new one (history's). */
  private continueTurn(): void {
    const id = continuationTurnId(this.lastBlock!.id);
    this.completeTurn(true);
    this.ensureTurn(id);
  }

  /** `continued`: the work goes on in the next turn (its tools keep running, the chat stays busy). */
  private completeTurn(continued = false): void {
    const turn = this.turn;
    if (!turn) return;
    this.flushResponse();
    if (!continued) {
      for (const tool of this.tools.values()) {
        if ((tool.item as { status?: string }).status === "inProgress") {
          tool.item = { ...tool.item, status: turn.interrupted ? "declined" : "failed" } as ThreadItem;
          this.itemCompleted(tool.item);
        }
      }
      this.tools.clear();
      for (const stop of this.codexTails.values()) stop();
      this.codexTails.clear();
    }
    this.turn = undefined;
    const status = turn.interrupted ? "interrupted" : turn.error ? "failed" : "completed";
    const completedAt = Math.floor(Date.now() / 1000);
    if (turn.error && !turn.interrupted) this.emit("error", { threadId: this.threadId, turnId: turn.id, willRetry: false, error: { message: turn.error, codexErrorInfo: null, additionalDetails: null } });
    this.emit("turn/completed", {
      threadId: this.threadId,
      turn: {
        id: turn.id, items: [], itemsView: "notLoaded", status,
        error: status === "failed" ? { message: turn.error, codexErrorInfo: null, additionalDetails: null } : null,
        startedAt: Math.floor(turn.startedAt / 1000), completedAt, durationMs: Date.now() - turn.startedAt,
      },
    });
    if (!continued) this.emit("thread/status/changed", { threadId: this.threadId, status: { type: "idle" } });
    this.host.turnCompleted(this, turn.id);
    this.turnWaiters.get(turn.id)?.(status);
    this.turnWaiters.delete(turn.id);
    const next = continued ? undefined : this.queued.shift();
    if (next) {
      this.emit("thread/queue/changed", { threadId: this.threadId });
      void this.startTurn({ input: next.input, clientUserMessageId: next.clientUserMessageId }).catch((error: unknown) =>
        this.host.logger.warn("claude.queue.start-failed", { threadId: this.threadId, error: String(error) }));
    }
  }

  // ---- notifications ----

  private emit(method: string, params: unknown): void {
    this.host.gateway.emit(this.threadId, method, params);
  }

  private itemStarted(item: ThreadItem): void {
    if (!this.turn) return;
    this.turn.items.push(item);
    this.emit("item/started", { item, threadId: this.threadId, turnId: this.turn.id, startedAtMs: Date.now() });
  }

  private itemCompleted(item: ThreadItem): void {
    if (!this.turn) return;
    const index = this.turn.items.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) this.turn.items[index] = item;
    else this.turn.items.push(item);
    this.emit("item/completed", { item, threadId: this.threadId, turnId: this.turn.id, completedAtMs: Date.now() });
  }

  // ---- SDK messages ----

  private handle(message: SDKMessage): void {
    const m = message as any;
    this.activeAt = Date.now();
    if (m.parent_tool_use_id) {
      this.host.subagentMessage(this, m);
      return;
    }
    // Claude's own word on `/goal` ("Goal set: …"), streamed as a reply: Codex clients show goals themselves.
    if (m.local_command_run?.command === "goal") return;
    if (this.afterResult && (m.type === "stream_event" || m.type === "assistant")) this.continued();
    switch (m.type) {
      case "stream_event": return this.onStream(m.event);
      case "assistant": return this.onAssistant(m);
      case "user": return this.onUser(m);
      case "result": return this.onResult(m);
      case "rate_limit_event": return this.host.onRateLimit(m.rate_limit_info);
      case "command_lifecycle": return this.onCommand(m);
      case "system": return this.onSystem(m);
      default: return undefined;
    }
  }

  /** With no id, Claude went on by itself: after an answer, in the turn history names after it. */
  private ensureTurn(id = this.lastBlock ? continuationTurnId(this.lastBlock.id) : randomUUID()): void {
    if (this.turn) return;
    const pending = this.pendingInputs.get(id);
    this.pendingInputs.delete(id);
    this.openTurn(id, pending?.input ?? [], pending?.clientId ?? null, pending ? pending.hidden : true);
  }

  /** A pushed message reached the model: mid-turn it joins the running turn, otherwise it opens one. */
  private onCommand(m: any): void {
    const uuid = m.command_uuid as string | undefined;
    if (uuid && m.state === "completed" && this.injections.has(uuid)) {
      this.injections.get(uuid)!.resolve();
      this.injections.delete(uuid);
    }
    const pending = uuid ? this.pendingInputs.get(uuid) : undefined;
    // A command Claude started by itself (a message another agent sent): its turn has the id history gives it.
    if (m.state === "started" && uuid && !pending && !this.injections.has(uuid)) {
      clearTimeout(this.runningTimer);
      if (!this.turn && this.notified) return this.ensureTurn();
      if (!this.turn) this.ensureTurn(uuid);
      void this.showPeerMessage(uuid);
    }
    if (m.state === "completed" && this.turn && this.turn.id === uuid && !this.turn.resultSeen) {
      this.turn.resultSeen = true;
      this.maybeComplete();
    }
    if (m.state !== "started" || !pending) return;
    if (!this.turn) return this.ensureTurn(uuid);
    this.pendingInputs.delete(uuid!);
    if (pending.hidden) return;
    const item: ThreadItem = { type: "userMessage", id: uuid!, clientId: pending.clientId, content: pending.input };
    this.itemStarted(item);
    this.itemCompleted(item);
  }

  private get peers(): Peers {
    return { directory: this.host.catalog, children: subagentFiles(this.transcriptPath()) };
  }

  /**
   * Claude answers again right after a result, without going idle: the transcript tells what it took. A message another
   * agent sent (a sub-agent's has no command uuid, so only the transcript tells) starts a turn, as in history; a
   * finished task's notification goes on after the answer in a turn of its own.
   */
  private continued(): void {
    this.afterResult = false;
    try {
      const path = this.transcriptPath();
      const record = path ? lastPrompt(path) : undefined;
      if (!record || !this.turn || this.turn.id === record.uuid || this.queued.length) return;
      const origin = peerOrigin(record.origin);
      if (!origin) {
        if (record.origin?.kind === "task-notification" && this.lastBlock) this.continueTurn();
        return;
      }
      this.completeTurn();
      this.ensureTurn(record.uuid);
      this.showPeer(record.uuid, origin, userText(record));
    } catch (error) {
      this.host.logger.warn("claude.peer-message.unreadable", { threadId: this.threadId, error: String(error) });
    }
  }

  /** The session's transcript: the catalog's, or (a new session it has not scanned yet) found among Claude's projects. */
  private transcriptPath(): string | undefined {
    const projects = join(this.host.config.claudeHome, "projects");
    return this.transcript ??= this.host.catalog.get(this.threadId)?.path
      ?? readdirSync(projects).map((key) => join(projects, key, `${this.threadId}.jsonl`)).find(existsSync);
  }

  /**
   * Messages other agents sent while Claude worked join the running turn. A sub-agent's comes with no command in the
   * stream: Claude writes it to the transcript before its next request, so it is read back as the next answer starts.
   */
  private showQueuedPeers(): void {
    try {
      const path = this.transcriptPath();
      if (!path) return;
      const { records, end } = recordsFrom(path, this.transcriptRead);
      this.transcriptRead = end;
      for (const record of records) {
        const queued = record?.type === "attachment" && record.attachment?.type === "queued_command" ? record.attachment : undefined;
        const origin = peerOrigin(queued?.origin);
        if (origin) this.showPeer(String(queued.source_uuid ?? record.uuid), origin, String(queued.prompt ?? ""));
      }
    } catch (error) {
      this.host.logger.warn("claude.peer-message.unreadable", { threadId: this.threadId, error: String(error) });
    }
  }

  private showPeer(id: string, origin: Record<string, unknown>, recordText: string): void {
    const key = peerKey(origin, recordText);
    if (!this.turn || this.peerMessages.has(key)) return;
    this.peerMessages.add(key);
    const item = peerMessageItem(id, origin, recordText, this.peers);
    this.itemStarted(item);
    this.itemCompleted(item);
  }

  /**
   * A command Claude started by itself may be a message another agent sent. The stream leaves that message out, so it
   * is read back from the transcript as soon as Claude writes it there (the result of the turn it starts tells it too).
   */
  private async showPeerMessage(uuid: string): Promise<void> {
    try {
      const path = this.transcriptPath();
      for (let attempt = 0; path && attempt < 10; attempt += 1) {
        const { size } = await stat(path);
        for await (const record of readTranscriptRecords(path, { start: Math.max(0, size - 262_144) })) {
          // Idle, Claude takes the message as a prompt of its own; working, as a queued command of the running turn.
          const queued = record.type === "attachment" ? record.attachment as { type?: unknown; source_uuid?: unknown; origin?: unknown; prompt?: unknown } | undefined : undefined;
          const prompt = record.type === "user" && record.uuid === uuid;
          if (!prompt && !(queued?.type === "queued_command" && queued.source_uuid === uuid)) continue;
          const origin = peerOrigin(prompt ? record.origin : queued!.origin);
          if (!origin) return;
          // Taken as a prompt of its own right after a turn's result (no idle between): a turn of its own, as in history.
          if (prompt && this.turn && this.turn.id !== uuid && this.turn.resultSeen && !this.queued.length) {
            this.completeTurn();
            this.ensureTurn(uuid);
          }
          return this.showPeer(uuid, origin, prompt ? userText(record) : String(queued!.prompt ?? ""));
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      this.host.logger.warn("claude.peer-message.unreadable", { threadId: this.threadId, error: String(error) });
    }
  }

  private onSystem(m: any): void {
    switch (m.subtype) {
      case "init":
        this.liveModel = m.model ?? this.liveModel;
        return;
      case "session_state_changed":
        this.state = m.state;
        if (m.state === "running") {
          // Claude started it by itself: the command it runs (announced right after) gives the turn its id.
          if (!this.injections.size && !this.turn) {
            clearTimeout(this.runningTimer);
            this.runningTimer = setTimeout(() => { if (this.state !== "idle") this.ensureTurn(); }, 100);
          }
        }
        if (m.state === "idle") this.maybeComplete();
        return;
      case "compact_boundary": {
        this.ensureTurn();
        const item: ThreadItem = { type: "contextCompaction", id: m.uuid };
        this.itemStarted(item);
        this.itemCompleted(item);
        return;
      }
      case "task_started":
        if (m.skip_transcript || m.ambient) return;
        if (m.task_type === "local_agent") return void this.agents.add(m.task_id);
        this.tasks.set(m.task_id, { taskId: m.task_id, toolUseId: m.tool_use_id, description: m.description ?? "", taskType: m.task_type });
        return;
      case "task_notification":
        if (m.status === "stopped" && m.tool_use_id && m.output_file && !this.background.has(m.task_id)) this.killed.set(m.tool_use_id, m.output_file);
        this.tasks.delete(m.task_id);
        this.agents.delete(m.task_id);
        this.host.subagentFinished(`agent-${m.task_id}`);
        this.notified ||= !this.turn;
        this.endBackground(m.task_id, { status: String(m.status), summary: String(m.summary ?? ""), ...(m.output_file ? { outputFile: m.output_file } : {}), atMs: Date.now() });
        return;
      case "background_tasks_changed": {
        const live = new Set((m.tasks ?? []).map((task: any) => task.task_id));
        for (const id of [...this.tasks.keys()].filter((id) => !live.has(id))) this.tasks.delete(id);
        return;
      }
      case "api_retry":
        this.host.logger.info("claude.api-retry", { threadId: this.threadId, attempt: m.attempt, error: m.error });
        return;
      case "local_command_output":
        this.systemText(String(m.content ?? ""));
        return;
      case "informational":
        // Claude Code shows `info` banners only in its transcript view.
        if (m.level === "info") return;
      // falls through
      case "model_refusal_fallback":
      case "notification":
        if (typeof m.text === "string" || typeof m.message === "string" || typeof m.content === "string") {
          this.systemText(String(m.text ?? m.message ?? m.content));
        }
        return;
      default:
        return undefined;
    }
  }

  /** A task ended while Claude was idle: its notification may wake Claude up, so the turn waits a moment for that. */
  /** Visible CCodex/Claude notice inside the running turn (e.g. `/goal` output). */
  private systemText(text: string): void {
    if (!text.trim() || !this.turn) return;
    const item: ThreadItem = { type: "agentMessage", id: `notice-${randomUUID()}`, text, phase: "commentary", memoryCitation: null };
    this.itemStarted(item);
    this.itemCompleted(item);
  }

  private onStream(event: any): void {
    switch (event.type) {
      case "message_start":
        this.flushResponse();
        this.ensureTurn();
        this.showQueuedPeers();
        this.response = { id: event.message.id, hasTool: false, texts: new Map(), blockKinds: new Map() };
        return;
      case "content_block_start": return this.blockStart(event.index, event.content_block);
      case "content_block_delta": return this.blockDelta(event.index, event.delta);
      case "message_stop": return this.flushResponse();
      default: return undefined;
    }
  }

  private blockStart(index: number, block: any): void {
    if (!this.response) return;
    const tool = block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use";
    if (this.lastBlock?.text && this.lastBlock.text.text.length >= ANSWER_CHARS) {
      // More work after a message of an answer's length: it ends its turn, so Desktop shows it unfolded.
      this.response.hasTool ||= tool;
      const { id, hasTool } = this.response;
      this.continueTurn();
      this.response = { id, hasTool, texts: new Map(), blockKinds: new Map() };
    }
    const response = this.response;
    this.showThinking(response);
    this.lastBlock = { id: assistantBlockItemId(response.id, index) };
    if (block.type === "text") {
      this.textStarted(response, index);
    } else if (block.type === "thinking") {
      response.blockKinds.set(index, { kind: "thinking" });
      response.held = { index, text: "", timer: setTimeout(() => this.showThinking(response), NARRATION_WAIT_MS) };
    } else if (block.type === "redacted_thinking") {
      this.reasoningPart(response, index);
    } else if (tool) {
      response.hasTool = true;
      response.blockKinds.set(index, { kind: "tool" });
    }
  }

  private blockDelta(index: number, delta: any): void {
    const response = this.response;
    const kind = response?.blockKinds.get(index);
    if (!response || !kind || !this.turn) return;
    const held = response.held?.index === index ? response.held : undefined;
    if (delta.type === "text_delta" && kind.kind === "text") {
      this.textDelta(response.texts.get(index)!, delta.text);
    } else if (delta.type === "thinking_delta" && held) {
      held.text += delta.thinking;
    } else if (delta.type === "thinking_delta" && kind.kind === "thinking" && response.reasoning) {
      this.thinkingDelta(response, kind.summaryIndex!, delta.thinking);
    } else if (delta.type === "signature_delta" && held) {
      if (!isNarration(delta.signature)) return this.showThinking(response);
      // Claude Code shows a narration as Claude's message: so does the chat.
      clearTimeout(held.timer);
      response.held = undefined;
      const text = held.text.trimEnd();
      if (text) this.textDelta(this.textStarted(response, index), text);
    }
  }

  private textStarted(response: Response, index: number): ThreadItem & { type: "agentMessage" } {
    const item = { type: "agentMessage" as const, id: assistantBlockItemId(response.id, index), text: "", phase: null, memoryCitation: null };
    response.texts.set(index, item);
    response.blockKinds.set(index, { kind: "text" });
    this.lastBlock = { id: item.id, text: item };
    this.streamed.add(item.id);
    this.itemStarted(item);
    return item;
  }

  private textDelta(item: ThreadItem & { type: "agentMessage" }, delta: string): void {
    item.text += delta;
    this.emit("item/agentMessage/delta", { threadId: this.threadId, turnId: this.turn!.id, itemId: item.id, delta });
  }

  /** A thinking block is a part of its response's one reasoning item. */
  private reasoningPart(response: Response, index: number): number {
    let summaryIndex = 0;
    if (response.reasoning) {
      response.reasoning.summary.push("");
      summaryIndex = response.reasoning.summary.length - 1;
      this.emit("item/reasoning/summaryPartAdded", { threadId: this.threadId, turnId: this.turn?.id, itemId: response.reasoning.id, summaryIndex });
    } else {
      const item = { type: "reasoning" as const, id: assistantBlockItemId(response.id, index), summary: [""], content: [] };
      response.reasoning = item;
      this.streamed.add(item.id);
      this.itemStarted({ ...item, summary: [] });
    }
    response.blockKinds.set(index, { kind: "thinking", summaryIndex });
    return summaryIndex;
  }

  private thinkingDelta(response: Response, summaryIndex: number, delta: string): void {
    response.reasoning!.summary[summaryIndex] += delta;
    this.emit("item/reasoning/summaryTextDelta", {
      threadId: this.threadId, turnId: this.turn!.id, itemId: response.reasoning!.id, delta, summaryIndex,
    });
  }

  /** The held thinking block is no narration (or its signature is late): it shows as thinking, as it came so far. */
  private showThinking(response: Response): void {
    const held = response.held;
    if (!held || response !== this.response) return;
    clearTimeout(held.timer);
    response.held = undefined;
    const summaryIndex = this.reasoningPart(response, held.index);
    if (held.text) this.thinkingDelta(response, summaryIndex, held.text);
  }

  private flushResponse(): void {
    const response = this.response;
    if (!response) return;
    this.showThinking(response);
    this.response = undefined;
    for (const item of response.texts.values()) {
      this.itemCompleted({ ...item, phase: response.hasTool ? "commentary" : "final_answer" });
    }
    if (response.reasoning) this.itemCompleted({ ...response.reasoning, summary: response.reasoning.summary.filter(Boolean) });
  }

  private onAssistant(m: any): void {
    this.ensureTurn();
    const message = m.message;
    if (message.id && message.usage) {
      this.lastUsage = breakdown(message.usage);
      this.usageByMessage.set(message.id, this.lastUsage);
      this.totalUsage = [...this.usageByMessage.values()].reduce(addUsage, EMPTY_USAGE);
      this.emitUsage();
    }
    if (m.error && this.turn) this.turn.error = typeof m.error === "string" ? `Claude error: ${m.error}` : "Claude request failed.";
    const blocks: any[] = Array.isArray(message.content) ? message.content : [];
    blocks.forEach((block, position) => {
      if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
        this.toolStarted(block, position);
      } else {
        const text = messageText(block);
        if (text === undefined) return;
        const id = assistantBlockItemId(message.id, m.apiBlockIndex ?? position);
        if (this.streamed.has(id) || this.response?.id === message.id) return;
        this.streamed.add(id);
        const item: ThreadItem = { type: "agentMessage", id, text, phase: "final_answer", memoryCitation: null };
        this.itemStarted(item);
        this.itemCompleted(item);
      }
    });
  }

  private toolStarted(block: any, index: number): void {
    const existing = this.tools.get(block.id);
    if (existing) {
      existing.item = updateToolInput(existing.item, existing.state, block.input ?? {}, this.settings.cwd);
      this.proposeChanges(block.id, block.name, block.input ?? {});
      return;
    }
    const started = FILE_TOOLS.has(block.name) && block.name === "MultiEdit"
      ? {
          state: { index, providerId: block.id, itemId: block.id, name: block.name, cwd: this.settings.cwd, input: block.input ?? {}, partialInput: "", started: true, startedAtMs: Date.now() },
          item: { type: "fileChange", id: block.id, changes: [], status: "inProgress" } as ThreadItem,
        }
      : startTool(index, block, this.settings.cwd, this.threadId);
    started.item = sentMessageItem(started.item, started.state.input, undefined, this.peers);
    // Stopping a background command shows on the command, as stock's Ctrl-C; what else it stops shows with its result.
    if (block.name === "TaskStop") {
      const taskId = String(block.input?.task_id);
      const running = this.background.get(taskId);
      if (running) this.emit("item/commandExecution/terminalInteraction", { threadId: this.threadId, turnId: running.turnId, itemId: running.item.id, processId: taskId, stdin: "\u0003" });
      return void this.stops.set(block.id, started);
    }
    this.tools.set(block.id, started);
    this.itemStarted(started.item);
  }

  /**
   * Codex MCP calls: the prompt and everything codex says while it works show up in the calling chat (a
   * sub-agent's own thread when a sub-agent calls), with the ids history gives them.
   */
  private codexMcpCall(toolName: string, input: JsonObject, toolUseId: string, agentId: string | undefined): void {
    if (!CODEX_MCP_TOOLS.has(toolName)) return;
    const show = (item: ThreadItem) => {
      if (agentId) this.host.subagentActivity(`agent-${agentId}`);
      else if (this.turn) { this.itemStarted(item); this.itemCompleted(item); }
    };
    // The prompt shows once the journal tells what codex runs it with (or when the call ends without telling).
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    let promptShown = !prompt;
    const showPrompt = (context?: CodexTurnContext) => {
      if (promptShown) return;
      promptShown = true;
      show(codexMcpItem(toolUseId, "prompt", { kind: "prompt", text: prompt, context }));
    };
    let said = 0;
    const stop = tailCodexRollout(toolUseId, toolName, input, (event) => {
      if (event.kind === "context") return showPrompt(event);
      showPrompt();
      if (event.kind === "turnComplete") this.codexTails.get(toolUseId)?.();
      else show(codexMcpItem(toolUseId, said++, event));
    });
    this.codexTails.set(toolUseId, () => {
      stop();
      showPrompt();
    });
  }

  private onUser(m: any): void {
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      this.codexTails.get(block.tool_use_id)?.();
      this.codexTails.delete(block.tool_use_id);
      const result = typeof m.tool_use_result === "object" && m.tool_use_result !== null ? m.tool_use_result : undefined;
      const stop = this.stops.get(block.tool_use_id);
      if (stop) {
        this.stops.delete(block.tool_use_id);
        const stopped = stoppedCommand(result);
        if (stopped) {
          this.endBackground(stopped, { status: "stopped", summary: "", atMs: Date.now() });
          continue;
        }
        this.tools.set(block.tool_use_id, stop);
        this.itemStarted(stop.item);
      }
      const tool = this.tools.get(block.tool_use_id);
      if (!tool) continue;
      this.tools.delete(block.tool_use_id);
      // A command in the background runs on past its turn: its item completes when it ends (stock's background terminal).
      const taskId = tool.state.name === "Bash" && typeof result?.backgroundTaskId === "string" ? result.backgroundTaskId : undefined;
      if (taskId && this.turn) {
        const item = { ...tool.item, processId: taskId } as ThreadItem;
        this.background.set(taskId, { item, turnId: this.turn.id, startedAtMs: tool.state.startedAtMs });
        // Desktop shows a background terminal only for a command with its process (stock's has it from the start).
        const index = this.turn.items.findIndex((candidate) => candidate.id === item.id);
        if (index >= 0) this.turn.items[index] = item;
        this.emit("item/started", { item, threadId: this.threadId, turnId: this.turn.id, startedAtMs: tool.state.startedAtMs });
        continue;
      }
      // The result tells where a message went (its msg_id) when the call alone did not.
      const completed = completedToolItem({ ...tool, item: sentMessageItem(tool.item, tool.state.input, result, this.peers) }, { record: { toolUseResult: result }, block }, this.settings.cwd);
      const killed = this.killed.get(block.tool_use_id);
      this.killed.delete(block.tool_use_id);
      const item = killed ? killedCommand(completed, killed) : completed;
      if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent" && item.receiverThreadIds.length) {
        this.host.subagentSpawned(this, item, result?.status === "async_launched");
      }
      if (typeof result?.resumedAgentId === "string") void this.host.subagentResumed(this, `agent-${result.resumedAgentId}`);
      this.itemCompleted(item);
      if (tool.state.name === "TaskCreate" || tool.state.name === "TaskUpdate") this.updatePlan(tool.state.input, result);
    }
  }

  private updatePlan(input: Record<string, any>, result: any): void {
    const id = String(result?.task?.id ?? input.taskId);
    const current = this.plan.get(id);
    if (input.status === "deleted") this.plan.delete(id);
    else this.plan.set(id, {
      step: String(input.subject ?? current?.step ?? `Task #${id}`),
      status: input.status === "in_progress" ? "inProgress" : input.status ?? current?.status ?? "pending",
    });
    this.emit("turn/plan/updated", { threadId: this.threadId, turnId: this.turn!.id, explanation: null, plan: [...this.plan.values()] });
  }

  private onResult(m: any): void {
    if (!this.turn) return;
    this.turn.resultSeen = true;
    // Fast Claude can't serve (the account's usage credits, the model): Claude answers at standard speed, and the chat shows so.
    if (this.settings.fast && m.fast_mode_state === "off") void this.updateSettings({ serviceTier: null });
    this.afterResult = true;
    // A turn a message from another agent started, unless showPeerMessage read it back already.
    const origin = peerOrigin(m.origin);
    if (origin) this.showPeer(this.turn.id, origin, "");
    if (m.subtype !== "success" && !this.turn.interrupted) {
      const errors = Array.isArray(m.errors) ? m.errors.join("\n") : "";
      if (m.subtype === "error_during_execution" && !errors) this.turn.interrupted = true;
      else this.turn.error = errors || `Claude turn ended: ${m.subtype}`;
    } else if (m.is_error && typeof m.result === "string" && !this.turn.interrupted) {
      this.turn.error = m.result;
    }
    this.emitUsage();
    this.maybeComplete();
  }

  private emitUsage(): void {
    if (!this.turn) return;
    this.emit("thread/tokenUsage/updated", {
      threadId: this.threadId,
      turnId: this.turn.id,
      tokenUsage: { total: this.totalUsage, last: this.lastUsage, modelContextWindow: this.host.contextWindow(this.liveModel ?? this.settings.model) },
    });
  }

  // ---- approvals and questions ----

  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    // Stock plan mode: the turn ends with the proposed plan (its item) and Desktop asks to implement it; accepting
    // switches the collaboration mode back, which gives the chat the mode it had before plan mode.
    if (toolName === "ExitPlanMode" && this.settings.plan) return { behavior: "deny", message: PLAN_PROPOSED };
    const turnId = this.turn?.id ?? "";
    const itemId = options.toolUseID ?? randomUUID();
    const base = { threadId: this.threadId, turnId, itemId, startedAtMs: Date.now() };
    const reason = options.decisionReason ?? options.title ?? options.description ?? null;
    try {
      if (toolName === "AskUserQuestion") return await this.askUser(input, base);
      let decision: unknown;
      if (FILE_TOOLS.has(toolName)) {
        this.proposeChanges(itemId, toolName, input);
        ({ decision } = await this.host.gateway.serverRequest(this.threadId, "item/fileChange/requestApproval", {
          ...base, reason, grantRoot: null,
        }));
      } else {
        const tool = this.tools.get(itemId);
        const command = tool?.item.type === "commandExecution" && tool.item.command
          ? tool.item.command
          : `${toolName} ${JSON.stringify(input)}`;
        ({ decision } = await this.host.gateway.serverRequest(this.threadId, "item/commandExecution/requestApproval", {
          kind: "command", ...base, environmentId: null, reason, command, cwd: this.settings.cwd,
          commandActions: tool?.item.type === "commandExecution" ? tool.item.commandActions : [{ type: "unknown", command }],
          availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
        }));
      }
      return this.decisionResult(decision, input, options.suggestions);
    } catch {
      return { behavior: "deny", message: "The request was cancelled.", interrupt: true };
    }
  };

  /** Desktop shows a file change (and its approval) only with the patch: send it as soon as the input is known. */
  private proposeChanges(itemId: string, name: string, input: Record<string, unknown>): void {
    const item = this.tools.get(itemId)?.item;
    if (item?.type !== "fileChange" || item.changes.length) return;
    const changes = proposedChanges(name, input, this.settings.cwd);
    if (!changes.length) return;
    item.changes = changes;
    this.emit("item/fileChange/patchUpdated", { threadId: this.threadId, turnId: this.turn?.id ?? "", itemId, changes });
  }

  private decisionResult(decision: unknown, input: Record<string, unknown>, suggestions: unknown): PermissionResult {
    if (decision === "accept") return { behavior: "allow", updatedInput: input };
    if (decision === "acceptForSession" || (typeof decision === "object" && decision !== null)) {
      return { behavior: "allow", updatedInput: input, ...(Array.isArray(suggestions) ? { updatedPermissions: suggestions } : {}) };
    }
    if (decision === "cancel") return { behavior: "deny", message: "The user cancelled this action.", interrupt: true };
    return { behavior: "deny", message: "The user declined this action." };
  }

  private async askUser(input: Record<string, any>, base: JsonObject): Promise<PermissionResult> {
    const questions: any[] = Array.isArray(input.questions) ? input.questions : [];
    const response = await this.host.gateway.serverRequest(this.threadId, "item/tool/requestUserInput", {
      threadId: base.threadId, turnId: base.turnId, itemId: base.itemId, isBlocking: true, autoResolutionMs: null,
      questions: questions.map((question, index) => ({
        id: `q${index}`,
        header: String(question.header ?? ""),
        question: String(question.question ?? ""),
        isOther: true,
        isSecret: false,
        options: Array.isArray(question.options)
          ? question.options.map((option: any) => ({ label: String(option.label ?? ""), description: String(option.description ?? "") }))
          : null,
      })),
    });
    const answers: Record<string, string> = {};
    questions.forEach((question, index) => {
      const answer = response?.answers?.[`q${index}`]?.answers ?? [];
      answers[String(question.question ?? "")] = answer.join(", ");
    });
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  private async elicit(request: any): Promise<any> {
    const response = await this.host.gateway.serverRequest(this.threadId, "mcpServer/elicitation/request", request.mode === "url"
      ? {
          threadId: this.threadId, turnId: this.turn?.id ?? null, serverName: request.serverName, mode: "url", _meta: null,
          message: request.message ?? "", url: request.url, elicitationId: request.elicitationId ?? randomUUID(),
        }
      : {
          threadId: this.threadId, turnId: this.turn?.id ?? null, serverName: request.serverName, mode: "form", _meta: null,
          message: request.message ?? "", requestedSchema: request.requestedSchema ?? { type: "object", properties: {} },
        });
    return { action: response?.action ?? "decline", ...(response?.content ? { content: response.content } : {}) };
  }
}
