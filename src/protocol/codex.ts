// Hand-written subset of the Codex app-server v2 protocol: only the shapes the Claude layer emits.
// No pins: tests validate emitted objects against the JSON schema of the installed codex.

export type JsonValue = unknown;
export type JsonObject = Record<string, any>;
export type RequestId = string | number;

export type UserInput =
  | { type: "text"; text: string; text_elements?: unknown[] }
  | { type: "image"; url: string; detail?: string }
  | { type: "localImage"; path: string; detail?: string }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export type CommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

export type FileUpdateChange = {
  path: string;
  kind: { type: "add" } | { type: "delete" } | { type: "update"; move_path: string | null };
  diff: string;
};

export type ThreadItem =
  | { type: "userMessage"; id: string; clientId: string | null; content: UserInput[] }
  | {
      type: "agentMessage"; id: string; text: string; phase: string | null; memoryCitation: null;
      delivery?: unknown; questions?: unknown;
    }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution"; id: string; command: string; cwd: string; processId: string | null;
      source: string; status: string; commandActions: CommandAction[]; aggregatedOutput: string | null;
      exitCode: number | null; durationMs: number | null; pluginId?: string | null; scriptPath?: string | null;
    }
  | { type: "fileChange"; id: string; changes: FileUpdateChange[]; status: string }
  | {
      type: "mcpToolCall"; id: string; server: string; tool: string; status: string; arguments: JsonValue;
      result: { content: JsonValue[]; structuredContent: JsonValue | null; _meta?: JsonValue | null } | null;
      error: { message: string } | null; durationMs: number | null; [key: string]: unknown;
    }
  | {
      type: "dynamicToolCall"; id: string; namespace: string | null; tool: string; arguments: JsonValue; status: string;
      contentItems: JsonValue[] | null; success: boolean | null; durationMs: number | null;
    }
  | {
      type: "collabAgentToolCall"; id: string; tool: string; status: string; senderThreadId: string;
      receiverThreadIds: string[]; prompt: string | null; model: string | null; reasoningEffort: string | null;
      agentsStates: Record<string, { status: string; message: string | null }>;
    }
  | { type: "webSearch"; id: string; query: string; results?: JsonValue; action?: JsonValue }
  | { type: "imageView"; id: string; path: string }
  | { type: "contextCompaction"; id: string };

export interface QueuedSubmissionLike {
  id: string;
  input: UserInput[];
  clientUserMessageId: string;
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface Turn {
  id: string;
  items: ThreadItem[];
  itemsView?: "notLoaded" | "summary" | "full";
  status: TurnStatus;
  error: { message: string; codexErrorInfo: JsonValue | null; additionalDetails: string | null } | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export type ThreadStatus =
  | { type: "notLoaded" } | { type: "idle" } | { type: "systemError" } | { type: "active"; activeFlags: string[] };

export interface Thread {
  id: string;
  sessionId?: string;
  forkedFromId: string | null;
  parentThreadId?: string | null;
  preview: string;
  ephemeral: boolean;
  modelProvider: string;
  model?: string | null;
  reasoningEffort?: string | null;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number | null;
  status: ThreadStatus;
  path: string | null;
  cwd: string;
  cliVersion: string;
  source: any;
  threadSource?: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  gitInfo: any;
  name: string | null;
  turns: Turn[];
  [key: string]: unknown;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcFailure extends Error {
  public constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
  }
}

/** The model a turn/start or settings update asks for (Desktop sends it in the collaboration mode, with model null). */
export const requestedModel = (params: JsonObject): unknown => params.model ?? params.collaborationMode?.settings?.model;

export const invalidParams = (message: string) => new RpcFailure(-32602, message);
export const invalidRequest = (message: string) => new RpcFailure(-32600, message);
export const internalError = (message: string) => new RpcFailure(-32603, message);

export function rpcError(error: unknown): RpcError {
  if (error instanceof RpcFailure) return { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) };
  return { code: -32603, message: error instanceof Error ? error.message : String(error) };
}
