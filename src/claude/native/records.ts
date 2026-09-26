/** Owns the typed, streaming view of Claude's append-only transcript records. */
import { createReadStream } from "node:fs";

export interface TextBlock { readonly type: "text"; readonly text: string }
export interface ImageBlock { readonly type: "image"; readonly source: unknown }
export interface ToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: unknown;
  readonly is_error?: boolean;
}
export interface ThinkingBlock { readonly type: "thinking"; readonly thinking: string; readonly signature?: string }
export interface ToolUseBlock {
  readonly type: "tool_use" | "server_tool_use" | "mcp_tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly caller?: unknown;
  readonly server_name?: string;
}

export type UserContentBlock = TextBlock | ImageBlock | ToolResultBlock;
export type AssistantContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | Record<string, unknown>;

export interface TranscriptMessage<Block> {
  readonly id?: string;
  readonly model?: string;
  readonly role?: string;
  readonly content: string | readonly Block[];
  readonly stop_reason?: string | null;
  readonly stop_sequence?: string | null;
  readonly stop_details?: unknown;
  readonly usage?: Record<string, unknown>;
}

export interface ChainRecord {
  readonly uuid: string;
  readonly parentUuid: string | null;
  readonly timestamp: string;
  readonly sessionId: string;
  readonly isSidechain?: boolean;
  readonly isMeta?: boolean;
  readonly teamName?: string;
  readonly cwd?: string;
  readonly gitBranch?: string;
  readonly version?: string;
  readonly agentId?: string;
  readonly forkedFrom?: { readonly sessionId?: string; readonly messageUuid?: string };
}

export interface UserRecord extends ChainRecord {
  readonly type: "user";
  readonly message: TranscriptMessage<UserContentBlock>;
  readonly origin?: { readonly kind?: string; readonly [key: string]: unknown };
  /** The prompt a record belongs to: the user's, or a message another agent sent (`origin.kind` "peer"). */
  readonly promptId?: string;
  readonly isCompactSummary?: boolean;
  readonly isVisibleInTranscriptOnly?: boolean;
  readonly interruptedByShutdown?: boolean;
  readonly interruptedMessageId?: string;
  readonly permissionMode?: string;
  readonly sourceToolAssistantUUID?: string;
  readonly sourceToolUseID?: string;
  readonly toolDenialKind?: string;
  readonly toolUseResult?: Record<string, unknown>;
}

export interface AssistantRecord extends ChainRecord {
  readonly type: "assistant";
  readonly message: TranscriptMessage<AssistantContentBlock>;
  readonly apiBlockIndex?: number;
  readonly effort?: string;
  readonly requestId?: string;
  readonly error?: string;
  readonly apiErrorStatus?: number;
  readonly isApiErrorMessage?: boolean;
}

export interface PreservedMessages {
  readonly anchorUuid: string;
  readonly uuids: readonly string[];
  readonly allUuids?: readonly string[];
}

export interface PreservedSegment {
  readonly headUuid: string;
  readonly anchorUuid: string;
  readonly tailUuid: string;
}

export interface SystemRecord extends ChainRecord {
  readonly type: "system";
  readonly subtype?: string;
  readonly logicalParentUuid?: string;
  readonly commandRun?: { readonly command?: string; readonly args?: string };
  readonly compactMetadata?: {
    readonly preservedMessages?: PreservedMessages;
    readonly preservedSegment?: PreservedSegment;
    readonly [key: string]: unknown;
  };
  readonly content?: string;
  /** `api_error`: the request error, e.g. `{ status: 401, formatted: "401 OAuth access token has been revoked." }`. */
  readonly error?: { readonly formatted?: string };
}

export interface AttachmentRecord extends ChainRecord {
  readonly type: "attachment";
  readonly attachment?: unknown;
  readonly rendered?: unknown;
  readonly renderedInHumanTurn?: boolean;
}

export interface QueueOperationRecord {
  readonly type: "queue-operation";
  readonly operation?: string;
  readonly content?: string;
  readonly reason?: string;
  readonly sessionId?: string;
  readonly timestamp?: string;
}

export interface TitleRecord {
  readonly type: "custom-title" | "ai-title" | "summary";
  readonly customTitle?: string;
  readonly aiTitle?: string;
  readonly summary?: string;
  readonly sessionId?: string;
  readonly timestamp?: string;
  readonly uuid?: string;
}

export interface StateRecord {
  readonly type: "last-prompt" | "mode" | "atis-latch" | "bridge-session" | "permission-mode"
    | "file-history-snapshot" | "file-history-delta" | "cost-state" | "fork-context-ref";
  readonly sessionId?: string;
  readonly timestamp?: string;
  readonly permissionMode?: string;
  readonly [key: string]: unknown;
}

export type TranscriptRecord = UserRecord | AssistantRecord | SystemRecord | AttachmentRecord
  | QueueOperationRecord | TitleRecord | StateRecord;
export type TranscriptChainRecord = UserRecord | AssistantRecord | SystemRecord | AttachmentRecord;

const RECORD_TYPES = new Set([
  "user", "assistant", "system", "attachment", "queue-operation", "custom-title", "ai-title", "summary",
  "last-prompt", "mode", "atis-latch", "bridge-session", "permission-mode", "file-history-snapshot",
  "file-history-delta", "cost-state", "fork-context-ref",
]);

function record(value: unknown): value is TranscriptRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === "string"
    && RECORD_TYPES.has((value as { type: string }).type);
}

export class TranscriptRecordReader implements AsyncIterable<TranscriptRecord> {
  public skippedLines = 0;
  public parsedLines = 0;
  public bytesRead = 0;
  public completeBytes = 0;

  public constructor(
    public readonly path: string,
    private readonly options: { readonly start?: number; readonly end?: number } = {},
  ) {}

  public async *[Symbol.asyncIterator](): AsyncIterator<TranscriptRecord> {
    const input = createReadStream(this.path, { ...this.options, highWaterMark: 256 * 1_024 });
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    for await (const value of input) {
      const chunk = value as Buffer;
      this.bytesRead += chunk.length;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(0x0a);
      while (newline !== -1) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        this.completeBytes += newline + 1;
        const parsed = this.parseLine(line);
        if (parsed) yield parsed;
        newline = pending.indexOf(0x0a);
      }
    }
    if (pending.length > 0) {
      const parsed = this.parseLine(pending);
      if (parsed !== undefined) {
        this.completeBytes += pending.length;
        if (parsed) yield parsed;
      }
    }
  }

  private parseLine(bytes: Buffer): TranscriptRecord | null | undefined {
    const parsed = parseTranscriptLine(bytes);
    if (parsed) this.parsedLines += 1;
    else if (parsed !== null || bytes.toString("utf8").trim()) this.skippedLines += 1;
    return parsed;
  }
}

/** A transcript line's record: null for a blank line or another JSON value, undefined for a partial line. */
export function parseTranscriptLine(bytes: Buffer): TranscriptRecord | null | undefined {
  const line = bytes.toString("utf8").replace(/\r$/u, "");
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    return record(value) ? value : null;
  } catch {
    return undefined;
  }
}

export function readTranscriptRecords(
  path: string,
  options?: { readonly start?: number; readonly end?: number },
): TranscriptRecordReader {
  return new TranscriptRecordReader(path, options);
}

export function isChainRecord(record: TranscriptRecord): record is TranscriptChainRecord {
  return record.type === "user" || record.type === "assistant" || record.type === "system"
    || record.type === "attachment";
}

export function isCompactBoundary(record: TranscriptRecord): record is SystemRecord {
  return record.type === "system" && record.subtype === "compact_boundary";
}
