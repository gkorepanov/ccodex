import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  query, startup, type CanUseTool, type Options, type PermissionMode, type PermissionResult, type Query, type SDKMessage,
  type SDKUserMessage, type WarmQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { JsonObject, QueuedSubmissionLike, ThreadItem, TokenUsageBreakdown, Turn, UserInput } from "../protocol/codex.js";
import { invalidRequest } from "../protocol/codex.js";
import { startedTurn } from "../protocol/turnPagination.js";
import {
  CODEX_MCP_TOOLS, codexMcpItem, tailCodexRollout, type CodexTurnContext,
} from "./codexRollout.js";
import { claudeContent, normalizeUserInput, userMessage } from "./inputMapper.js";
import { completedToolItem } from "./native/projector.js";
import { ANSWER_CHARS, assistantBlockItemId, continuationTurnId } from "./native/ids.js";
import { readTranscriptRecords, type UserRecord } from "./native/records.js";
import { userText } from "./native/summary.js";
import { normalizeClaudeModelIdentifier } from "./modelSelection.js";
import { peerKey, peerMessageItem, peerOrigin, sentMessageItem, subagentFiles, type Peers } from "./peers.js";
import { baseOptions } from "./sdk.js";
import { proposedChanges, startTool, updateToolInput, type ActiveTool } from "./toolMapper.js";
import type { ClaudeThreads } from "./threads.js";

export interface SessionSettings {
  cwd: string;
  /** Claude model value without the picker prefix; null = Claude's default. */
  model: string | null;
  effort: string | null;
  fast: boolean;
  permissionMode: PermissionMode;
  /** The mode plan mode gives back. */
  planFrom?: PermissionMode;
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
}

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
const CONTINUATION_GRACE_MS = 3_000;

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

/**
 * One live Claude session: a single streaming `query()` and one sequential loop that turns SDK messages
 * into Codex notifications. Claude persists everything; this object only holds the running turn.
 */
export class ClaudeSession {
  public turn: ActiveTurn | undefined;
  public state: "idle" | "running" | "requires_action" = "idle";
  public readonly tasks = new Map<string, BackgroundTask>();
  /** Claude's sub-agents running (in the background they keep no turn open: each has a chat of its own). */
  private readonly agents = new Set<string>();
  public queued: QueuedSubmissionLike[] = [];
  public totalUsage: TokenUsageBreakdown = EMPTY_USAGE;
  public lastUsage: TokenUsageBreakdown = EMPTY_USAGE;
  public contextWindow: number | null = null;
  public costUsd = 0;
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
  private continuationTimer?: NodeJS.Timeout;
  private runningTimer?: NodeJS.Timeout;
  private exists: boolean;
  public compactSummary?: (summary: string) => void;
  private readonly codexTails = new Map<string, () => void>();
  /** Claude's task list (TaskCreate/TaskUpdate), sent like stock's plan updates: the client shows it as the turn's to-do list. */
  private readonly plan = new Map<string, { step: string; status: string }>();
  /** Messages from other agents shown (peerKey), whichever of transcript and result told them first. */
  private readonly peerMessages = new Set<string>();
  /** The running turn's result came: Claude answering again means it took another prompt by itself. */
  private afterResult = false;
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
  }

  private resumeAt: string | undefined;

  public get loaded(): boolean { return this.sdk !== undefined; }

  public get busy(): boolean { return this.turn !== undefined; }

  /** Nothing to do for `idleMs` (closing its process loses nothing: the next turn resumes from disk). */
  public quiet(now: number, idleMs: number): boolean {
    return !this.turn && !this.queued.length && !this.injections.size && !this.crons && now - this.activeAt >= idleMs;
  }

  /** The turn has its answer and only waits for background tasks to end. */
  public get waitingOnTasks(): boolean {
    return this.turn?.resultSeen === true && this.state === "idle" && this.tasks.size > 0;
  }

  /** Stops the background tasks as Claude's own stop control does: Claude learns they were stopped, not that they failed. */
  public async stopTasks(): Promise<void> {
    await Promise.all([...this.tasks.keys()].map((taskId) => this.sdk!.stopTask(taskId)));
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
    return {
      ...baseOptions(this.host.config),
      cwd: settings.cwd,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.effort ? { effort: settings.effort as never } : {}),
      ...(settings.fast ? { settings: { fastMode: true } } : {}),
      permissionMode: settings.permissionMode,
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
    const input = normalizeUserInput(params.input ?? []);
    const uuid: string = params.turnId ?? randomUUID();
    await this.applyTurnSettings(params);
    const content = await claudeContent(input, this.settings.cwd);
    // Desktop shows `/goal` messages itself.
    const hidden = typeof content === "string" && /^\/(?:compact|goal)(?:\s|$)/u.test(content);
    // Claude only waits on background tasks: it takes the message as a prompt of its own.
    if (this.waitingOnTasks) this.completeTurn();
    if (this.turn) {
      // Claude folds a message sent mid-turn into the running turn, like a steer.
      this.pendingInputs.set(uuid, { input, clientId: params.clientUserMessageId ?? null, hidden });
      this.ensureQuery();
      this.inbox!.push(userMessage(content, uuid));
      return startedTurn(this.liveTurn()!);
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
    if (this.waitingOnTasks) return (await this.startTurn(params)).id;
    const input = normalizeUserInput(params.input ?? []);
    const uuid = randomUUID();
    this.pendingInputs.set(uuid, { input, clientId: params.clientUserMessageId ?? null, hidden: false });
    this.ensureQuery();
    this.inbox!.push(userMessage(await claudeContent(input, this.settings.cwd), uuid));
    return this.turn.id;
  }

  /** Model-visible context without a model reply (provider switch summary, injected items). */
  public inject(text: string): Promise<void> {
    const uuid = randomUUID();
    this.ensureQuery();
    return new Promise((resolve, reject) => {
      this.injections.set(uuid, { resolve, reject });
      this.inbox!.push(userMessage(`${INJECTED_PREFIX}\n${text}`, uuid, { shouldQuery: false, origin: undefined } as unknown as Partial<SDKUserMessage>));
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
    await Promise.all([sdk.interrupt(), ...[...this.tasks.keys(), ...this.agents].map((id) => sdk.stopTask(id))].map((done) => done.catch(() => undefined)));
    this.tasks.clear();
    this.agents.clear();
    if (this.state === "idle" && this.turn) {
      this.turn.resultSeen = true;
      this.maybeComplete();
    }
  }

  public async stopTask(taskId: string): Promise<void> {
    await this.sdk?.stopTask(taskId);
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

  public async updateSettings(params: JsonObject): Promise<boolean> {
    const next = this.host.settingsFrom(params, this.settings);
    const changed = JSON.stringify(next) !== JSON.stringify(this.settings);
    if (!changed) return false;
    const previous = this.settings;
    this.settings = next;
    if (this.sdk) {
      if (next.model !== previous.model) await this.sdk.setModel(next.model ?? undefined);
      // The CLI settles the mode per model (no auto mode on Haiku falls back to default): a new model re-applies it.
      if (next.permissionMode !== previous.permissionMode || next.model !== previous.model) await this.sdk.setPermissionMode(next.permissionMode);
      if (next.effort !== previous.effort || next.fast !== previous.fast) {
        await this.sdk.applyFlagSettings({ effortLevel: next.effort as never, fastMode: next.fast });
      }
    }
    return true;
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
    this.activeAt = Date.now();
    this.afterResult = false;
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
    if (!this.turn || !this.turn.resultSeen || this.state !== "idle" || this.continuationTimer) return;
    if (!this.tasks.size || this.queued.length) return this.completeTurn();
    // Background tasks run on after the answer: it ends its turn, and a new one keeps the chat working until they end
    // or wake Claude up.
    if (!this.lastBlock) return;
    this.continueTurn();
    this.turn!.resultSeen = true;
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
          clearTimeout(this.continuationTimer);
          this.continuationTimer = undefined;
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
        this.tasks.delete(m.task_id);
        this.agents.delete(m.task_id);
        this.host.subagentFinished(`agent-${m.task_id}`);
        this.awaitWakeup();
        return;
      case "background_tasks_changed": {
        // Claude tells the change before the task's notification: it may wake Claude up still.
        const live = new Set((m.tasks ?? []).map((task: any) => task.task_id));
        const ended = [...this.tasks.keys()].filter((id) => !live.has(id));
        for (const id of ended) this.tasks.delete(id);
        if (ended.length) this.awaitWakeup();
        return;
      }
      case "api_retry":
        this.host.logger.info("claude.api-retry", { threadId: this.threadId, attempt: m.attempt, error: m.error });
        return;
      case "local_command_output":
        this.systemText(String(m.content ?? ""));
        return;
      case "model_refusal_fallback":
      case "notification":
      case "informational":
        if (typeof m.text === "string" || typeof m.message === "string" || typeof m.content === "string") {
          this.systemText(String(m.text ?? m.message ?? m.content));
        }
        return;
      default:
        return undefined;
    }
  }

  /** A task ended while Claude was idle: its notification may wake Claude up, so the turn waits a moment for that. */
  private awaitWakeup(): void {
    if (this.state !== "idle" || !this.turn) return;
    clearTimeout(this.continuationTimer);
    this.continuationTimer = setTimeout(() => {
      this.continuationTimer = undefined;
      this.maybeComplete();
    }, CONTINUATION_GRACE_MS);
  }

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
    this.lastBlock = { id: assistantBlockItemId(response.id, index) };
    if (block.type === "text") {
      const item = { type: "agentMessage" as const, id: assistantBlockItemId(response.id, index), text: "", phase: null, memoryCitation: null };
      response.texts.set(index, item);
      response.blockKinds.set(index, { kind: "text" });
      this.lastBlock.text = item;
      this.streamed.add(item.id);
      this.itemStarted(item);
    } else if (block.type === "thinking" || block.type === "redacted_thinking") {
      if (response.reasoning) {
        response.reasoning.summary.push("");
        const summaryIndex = response.reasoning.summary.length - 1;
        response.blockKinds.set(index, { kind: "thinking", summaryIndex });
        this.emit("item/reasoning/summaryPartAdded", { threadId: this.threadId, turnId: this.turn?.id, itemId: response.reasoning.id, summaryIndex });
      } else {
        const item = { type: "reasoning" as const, id: assistantBlockItemId(response.id, index), summary: [""], content: [] };
        response.reasoning = item;
        response.blockKinds.set(index, { kind: "thinking", summaryIndex: 0 });
        this.streamed.add(item.id);
        this.itemStarted({ ...item, summary: [] });
      }
    } else if (tool) {
      response.hasTool = true;
      response.blockKinds.set(index, { kind: "tool" });
    }
  }

  private blockDelta(index: number, delta: any): void {
    const response = this.response;
    const kind = response?.blockKinds.get(index);
    if (!response || !kind || !this.turn) return;
    if (delta.type === "text_delta" && kind.kind === "text") {
      const item = response.texts.get(index)!;
      item.text += delta.text;
      this.emit("item/agentMessage/delta", { threadId: this.threadId, turnId: this.turn.id, itemId: item.id, delta: delta.text });
    } else if (delta.type === "thinking_delta" && kind.kind === "thinking" && response.reasoning) {
      response.reasoning.summary[kind.summaryIndex!] += delta.thinking;
      this.emit("item/reasoning/summaryTextDelta", {
        threadId: this.threadId, turnId: this.turn.id, itemId: response.reasoning.id, delta: delta.thinking, summaryIndex: kind.summaryIndex,
      });
    }
  }

  private flushResponse(): void {
    const response = this.response;
    if (!response) return;
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
      } else if (block.type === "text" && typeof block.text === "string") {
        const id = assistantBlockItemId(message.id, m.apiBlockIndex ?? position);
        if (this.streamed.has(id) || this.response?.id === message.id) return;
        this.streamed.add(id);
        const item: ThreadItem = { type: "agentMessage", id, text: block.text, phase: "final_answer", memoryCitation: null };
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
      const tool = this.tools.get(block.tool_use_id);
      if (!tool) continue;
      this.tools.delete(block.tool_use_id);
      const result = typeof m.tool_use_result === "object" && m.tool_use_result !== null ? m.tool_use_result : undefined;
      // The result tells where a message went (its msg_id) when the call alone did not.
      const item = completedToolItem({ ...tool, item: sentMessageItem(tool.item, tool.state.input, result, this.peers) }, { record: { toolUseResult: result }, block }, this.settings.cwd);
      if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent" && item.receiverThreadIds.length) {
        this.host.subagentSpawned(this, item, result?.status === "async_launched");
      }
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
    this.afterResult = true;
    // A turn a message from another agent started, unless showPeerMessage read it back already.
    const origin = peerOrigin(m.origin);
    if (origin) this.showPeer(this.turn.id, origin, "");
    this.costUsd += Number(m.total_cost_usd ?? 0);
    for (const [model, usage] of Object.entries<any>(m.modelUsage ?? {})) {
      if (usage?.contextWindow) this.host.contextWindows.set(normalizeClaudeModelIdentifier(model), Number(usage.contextWindow));
    }
    const windows = Object.values(m.modelUsage ?? {}).map((usage: any) => Number(usage?.contextWindow ?? 0)).filter(Boolean);
    if (windows.length) this.contextWindow = Math.max(...windows);
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
      tokenUsage: { total: this.totalUsage, last: this.lastUsage, modelContextWindow: this.contextWindow },
    });
  }

  // ---- approvals and questions ----

  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
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
