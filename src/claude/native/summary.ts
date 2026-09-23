/** Owns the constant-memory reduction of native transcript records into thread header fields. */
import { isChainRecord, type TranscriptRecord, type UserRecord } from "./records.js";

export interface TranscriptHeader {
  readonly cwd: string;
  readonly gitBranch: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly preview: string;
  readonly customTitle: string | null;
  readonly aiTitle: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly serviceTier: string | null;
  readonly permissionMode: string | null;
  readonly cliVersion: string | null;
  /** Claude's `/goal`: set by the command, updated by `goal_status` attachments, cleared by `/goal clear`. */
  readonly goal: NativeGoal | null;
}

export interface NativeGoal {
  readonly objective: string;
  readonly met: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TranscriptSummaryState extends TranscriptHeader {
  readonly hasCreatedAt: boolean;
  readonly hasFirstPrompt: boolean;
  /** Any conversation record: Claude may rewrite a closed session's metadata (title, cost) into a deleted file. */
  readonly hasConversation: boolean;
}

export function timestampSeconds(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const milliseconds = Date.parse(timestamp);
  return Number.isNaN(milliseconds) ? null : Math.floor(milliseconds / 1_000);
}

export function userText(record: UserRecord): string {
  if (typeof record.message.content === "string") return record.message.content;
  return record.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

function hasToolResult(record: UserRecord): boolean {
  return Array.isArray(record.message.content)
    && record.message.content.some((block) => block.type === "tool_result");
}

/** `/name args` for a user-typed slash command record (`<command-name>/goal</command-name>...`). */
export function slashCommand(text: string): string | undefined {
  const name = /^<command-name>(\/[^<]+)<\/command-name>/u.exec(text)?.[1];
  if (!name) return undefined;
  const args = /<command-args>([\s\S]*?)<\/command-args>/u.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

export function startsTurn(record: UserRecord, subagentPromptUuid?: string): boolean {
  if (record.uuid === subagentPromptUuid) return true;
  if (record.isMeta === true || record.isCompactSummary === true || hasToolResult(record)) return false;
  if (record.origin?.kind === "human") return true;
  if (record.origin !== undefined || !userText(record)) return false;
  const text = userText(record);
  const command = slashCommand(text);
  // The SDK's setModel records a model switch as `/model <name>`: a setting, not a turn.
  if (command) return !/^\/model(?:\s|$)/u.test(command);
  return !/<command-name>|<command-message>|<command-args>|<local-command-[^>]*>|<task-notification>/u.test(text)
    && !text.startsWith("[Injected model-visible history]")
    && !/^\[Request interrupted by user(?: for tool use)?\]$/u.test(text);
}

const EMPTY_STATE: TranscriptSummaryState = {
  cwd: "/",
  gitBranch: null,
  createdAt: 0,
  updatedAt: 0,
  preview: "",
  customTitle: null,
  aiTitle: null,
  model: null,
  reasoningEffort: null,
  serviceTier: null,
  permissionMode: null,
  cliVersion: null,
  goal: null,
  hasCreatedAt: false,
  hasFirstPrompt: false,
  hasConversation: false,
};

function serviceTier(record: TranscriptRecord): string | null {
  if (record.type !== "assistant" || record.message.stop_reason === null
    || record.message.stop_reason === undefined) return null;
  return record.message.usage?.service_tier === "priority" ? "fast" : null;
}

type MutableSummaryState = { -readonly [Key in keyof TranscriptSummaryState]: TranscriptSummaryState[Key] };

export class TranscriptSummarizer {
  private state: MutableSummaryState;

  public constructor(
    state: TranscriptSummaryState = EMPTY_STATE,
    private readonly subagentPromptUuid?: string,
  ) {
    this.state = { ...state };
  }

  public accept(record: TranscriptRecord): void {
    const timestamp = "timestamp" in record ? timestampSeconds(record.timestamp) : null;
    if (!this.state.hasCreatedAt && timestamp !== null) {
      this.state.createdAt = timestamp;
      this.state.hasCreatedAt = true;
    }
    if (timestamp !== null) this.state.updatedAt = timestamp;

    if (isChainRecord(record)) {
      this.state.hasConversation = true;
      if (record.cwd !== undefined) this.state.cwd = record.cwd;
      if (record.gitBranch !== undefined) this.state.gitBranch = record.gitBranch;
      if (record.version !== undefined) this.state.cliVersion = record.version;
    }
    if (record.type === "user") {
      if (!this.state.hasFirstPrompt && startsTurn(record, this.subagentPromptUuid)) {
        const text = userText(record);
        this.state.preview = (slashCommand(text) ?? text).trim();
        this.state.hasFirstPrompt = true;
      }
      if (record.permissionMode !== undefined) this.state.permissionMode = record.permissionMode;
    } else if (record.type === "assistant") {
      if (record.message.model !== undefined) this.state.model = record.message.model;
      if (record.effort !== undefined) this.state.reasoningEffort = record.effort;
      if (record.message.stop_reason !== null && record.message.stop_reason !== undefined) {
        this.state.serviceTier = serviceTier(record);
      }
    } else if (record.type === "system" && record.subtype === "local_command") {
      const run = record.commandRun;
      if (run?.command === "goal") this.goalCommand(String(run.args ?? "").trim(), String(record.content ?? ""), timestamp ?? 0);
    } else if (record.type === "attachment") {
      const attachment = record.attachment as { type?: string; met?: boolean; condition?: string } | undefined;
      if (attachment?.type === "goal_status" && attachment.condition) {
        const createdAt = this.state.goal?.objective === attachment.condition ? this.state.goal.createdAt : timestamp ?? 0;
        this.state.goal = { objective: attachment.condition, met: attachment.met === true, createdAt, updatedAt: timestamp ?? 0 };
      }
    } else if (record.type === "custom-title") {
      this.state.customTitle = record.customTitle ?? null;
    } else if (record.type === "ai-title") {
      this.state.aiTitle = record.aiTitle ?? null;
    } else if (record.type === "permission-mode" && typeof record.permissionMode === "string") {
      this.state.permissionMode = record.permissionMode;
    }
  }

  private goalCommand(args: string, output: string, timestamp: number): void {
    if (!args || /^(?:clear|stop|off|reset|none|cancel)$/iu.test(args)) this.state.goal = null;
    else if (/Goal set/u.test(output)) this.state.goal = { objective: args, met: false, createdAt: timestamp, updatedAt: timestamp };
  }

  public snapshot(): TranscriptSummaryState {
    return { ...this.state };
  }

  public header(updatedAt = this.state.updatedAt): TranscriptHeader {
    return {
      cwd: this.state.cwd,
      gitBranch: this.state.gitBranch,
      createdAt: this.state.createdAt,
      updatedAt,
      preview: this.state.preview,
      customTitle: this.state.customTitle,
      aiTitle: this.state.aiTitle,
      model: this.state.model,
      reasoningEffort: this.state.reasoningEffort,
      serviceTier: this.state.serviceTier,
      permissionMode: this.state.permissionMode,
      cliVersion: this.state.cliVersion,
      goal: this.state.goal,
    };
  }
}

export function summarizeTranscript(
  records: readonly TranscriptRecord[],
  subagentPromptUuid?: string,
): TranscriptHeader {
  const summarizer = new TranscriptSummarizer(undefined, subagentPromptUuid);
  for (const record of records) summarizer.accept(record);
  return summarizer.header();
}
