/** Owns pure projection of selected Claude transcript history into Codex protocol objects. */
import { isAbsolute, resolve } from "node:path";
import type { JsonValue, Thread, ThreadItem, TokenUsageBreakdown, Turn, UserInput } from "../../protocol/codex.js";
import { CODEX_MCP_TOOLS, codexMcpItems } from "../codexRollout.js";
import { normalizeClaudeModelIdentifier } from "../modelSelection.js";
import { NO_PEERS, peerMessageItem, peerOrigin, sentMessageItem, type PeerDirectory, type Peers } from "../peers.js";
import {
  projectToolCompletion,
  startTool,
  type ActiveTool,
} from "../toolMapper.js";
import { selectHistory, type SelectedHistory } from "./history.js";
import { assistantBlockItemId } from "./ids.js";
import {
  isCompactBoundary,
  readTranscriptRecords,
  type AssistantRecord,
  type SystemRecord,
  type ToolResultBlock,
  type ToolUseBlock,
  type TranscriptChainRecord,
  type TranscriptRecord,
  type UserRecord,
} from "./records.js";
import {
  slashCommand,
  startsTurn,
  summarizeTranscript,
  timestampSeconds,
  userText,
  type TranscriptHeader,
} from "./summary.js";

export interface ProjectTranscriptInput {
  readonly sessionId: string;
  readonly path: string;
  readonly leafUuid?: string;
  readonly records?: readonly TranscriptRecord[];
  readonly history?: SelectedHistory;
  readonly header?: TranscriptHeader;
  readonly parentThreadId?: string | null;
  /** Links messages between sessions to their threads. */
  readonly peers?: PeerDirectory;
  readonly subagent?: {
    readonly promptRecordUuid: string;
    readonly nickname: string;
    readonly depth: number;
  };
}

/** Last chain record of a projected turn; the native rollback anchor. */
export interface TurnProviderBoundary {
  readonly turnId: string;
  readonly messageUuid: string;
}

export interface TranscriptProjection {
  readonly thread: Thread;
  readonly turns: readonly Turn[];
  readonly lastAssistantUuid: string | null;
  readonly tokenUsage: { readonly total: TokenUsageBreakdown; readonly last: TokenUsageBreakdown | null };
  readonly skippedLines: number;
  readonly compactionBoundaries: ReadonlySet<string>;
  readonly turnBoundaries: readonly TurnProviderBoundary[];
  readonly selectedLeafUuid: string | null;
  readonly selectedRecordUuids: ReadonlySet<string>;
}

/** Claude's token use over a history, and of its last request (Desktop's context meter). */
function projectedUsage(records: readonly TranscriptChainRecord[]): { total: TokenUsageBreakdown; last: TokenUsageBreakdown | null } {
  const total = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  let last: TokenUsageBreakdown | null = null;
  const messageIds = new Set<string>();
  for (const record of records) {
    if (record.type !== "assistant" || !record.message.usage) continue;
    const messageId = record.message.id;
    if (messageId && messageIds.has(messageId)) continue;
    if (messageId) messageIds.add(messageId);
    const usage = record.message.usage;
    const input = Number(usage.input_tokens ?? 0);
    const cached = Number(usage.cache_read_input_tokens ?? 0);
    const cacheWrite = Number(usage.cache_creation_input_tokens ?? 0);
    const output = Number(usage.output_tokens ?? 0);
    last = {
      totalTokens: input + cached + cacheWrite + output, inputTokens: input + cached + cacheWrite, cachedInputTokens: cached,
      cacheWriteInputTokens: cacheWrite, outputTokens: output, reasoningOutputTokens: 0,
    };
    total.inputTokens += last.inputTokens;
    total.cachedInputTokens += cached;
    total.cacheWriteInputTokens += cacheWrite;
    total.outputTokens += output;
    total.totalTokens += last.totalTokens;
  }
  return { total, last };
}

export interface ToolCompletion {
  readonly record: Pick<UserRecord, "toolUseResult" | "toolDenialKind">;
  readonly block: ToolResultBlock;
}

const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const NON_TERMINAL_STOPS = new Set(["tool_use", "pause_turn"]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function imageInput(source: unknown): UserInput | undefined {
  const fields = object(source);
  if (!fields) return undefined;
  const data = string(fields.data);
  const mediaType = string(fields.media_type) ?? string(fields.mediaType);
  if (fields.type === "base64" && data && mediaType) return { type: "image", url: `data:${mediaType};base64,${data}` };
  const url = string(fields.url);
  return url ? { type: "image", url } : undefined;
}

function userInputs(record: UserRecord): UserInput[] {
  if (typeof record.message.content === "string") {
    const text = slashCommand(record.message.content) ?? record.message.content;
    return [{ type: "text", text, text_elements: [] }];
  }
  return record.message.content.flatMap((block): UserInput[] => {
    if (block.type === "text") return [{ type: "text", text: block.text, text_elements: [] }];
    if (block.type === "image") {
      const image = imageInput(block.source);
      return image ? [image] : [];
    }
    return [];
  });
}

function assistantBlocks(record: AssistantRecord): readonly Record<string, unknown>[] {
  if (!Array.isArray(record.message.content)) return [];
  return record.message.content.filter((block): block is Record<string, unknown> =>
    block !== null && typeof block === "object");
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((block) => {
    const fields = object(block);
    return typeof fields?.text === "string" ? [fields.text] : [];
  }).join("\n");
}

function toolCompletions(records: readonly TranscriptChainRecord[]): ReadonlyMap<string, ToolCompletion> {
  const results = new Map<string, ToolCompletion>();
  for (const record of records) {
    if (record.type !== "user" || !Array.isArray(record.message.content)) continue;
    for (const block of record.message.content) {
      if (block.type === "tool_result") results.set(block.tool_use_id, { record, block });
    }
  }
  return results;
}

function structuredOutput(completion: ToolCompletion): string {
  const blockOutput = outputText(completion.block.content);
  if (blockOutput) return blockOutput;
  const result = completion.record.toolUseResult;
  if (!result) return "";
  const stdout = string(result.stdout) ?? "";
  const stderr = string(result.stderr) ?? "";
  return `${stdout}${stderr}`;
}

function filePath(name: string, input: Record<string, unknown>, result: Record<string, unknown> | undefined): string | undefined {
  return string(result?.filePath) ?? string(result?.file_path)
    ?? string(input[name === "NotebookEdit" ? "notebook_path" : "file_path"])
    ?? string(input.path);
}

function structuredDiff(result: Record<string, unknown> | undefined): string {
  if (!Array.isArray(result?.structuredPatch)) return string(result?.diff) ?? string(result?.patch) ?? "";
  return result.structuredPatch.flatMap((value) => {
    const hunk = object(value);
    if (!hunk || !Array.isArray(hunk.lines)) return [];
    const oldStart = typeof hunk.oldStart === "number" ? hunk.oldStart : 0;
    const oldLines = typeof hunk.oldLines === "number" ? hunk.oldLines : 0;
    const newStart = typeof hunk.newStart === "number" ? hunk.newStart : 0;
    const newLines = typeof hunk.newLines === "number" ? hunk.newLines : 0;
    return [`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@\n${hunk.lines.join("\n")}`];
  }).join("\n");
}

function completeFileItem(
  item: Extract<ThreadItem, { type: "fileChange" }>,
  name: string,
  input: Record<string, unknown>,
  completion: ToolCompletion | undefined,
  cwd: string,
): ThreadItem {
  if (!completion) return item;
  const result = completion.record.toolUseResult;
  const candidate = filePath(name, input, result);
  const path = candidate ? (isAbsolute(candidate) ? candidate : resolve(cwd, candidate)) : undefined;
  const diff = structuredDiff(result);
  const kind = result?.type === "create" ? { type: "add" as const }
    : result?.type === "delete" ? { type: "delete" as const }
      : { type: "update" as const, move_path: null };
  return {
    ...item,
    status: completion.block.is_error === true ? "failed" : completion.record.toolDenialKind ? "declined" : "completed",
    changes: path ? [{ path, kind, diff }] : [],
  };
}

function activeTool(
  index: number,
  block: ToolUseBlock,
  cwd: string,
  threadId: string,
  timestamp: string,
): { state: ActiveTool; item: ThreadItem } {
  if (block.name === "MultiEdit") {
    const input = object(block.input) ?? {};
    return {
      state: {
        index, providerId: block.id, itemId: block.id, name: block.name, cwd, input,
        partialInput: "", started: true, startedAtMs: Date.parse(timestamp),
      },
      item: { type: "fileChange", id: block.id, changes: [], status: "inProgress" },
    };
  }
  return startTool(index, block as unknown as Record<string, unknown>, cwd, threadId);
}

function projectTool(
  block: ToolUseBlock,
  blockIndex: number,
  record: AssistantRecord,
  cwd: string,
  threadId: string,
  completions: ReadonlyMap<string, ToolCompletion>,
  peers: Peers,
): ThreadItem | undefined {
  if (block.name.startsWith("mcp__ccodex_goal__")) return undefined;
  const started = activeTool(blockIndex, block, cwd, threadId, record.timestamp);
  const completion = completions.get(block.id);
  const result = completion?.record.toolUseResult;
  const item = sentMessageItem(started.item, started.state.input, result, peers);
  if (!completion) return item;
  return completedToolItem(
    { state: { ...started.state, startedAtMs: Date.parse(record.timestamp) }, item },
    { ...completion, record: { ...completion.record, toolUseResult: { ...result, duration_ms: typeof result?.duration_ms === "number" ? result.duration_ms : 0 } } },
    cwd,
  );
}

/** A started tool item completed by its tool_result; shared by history projection and the live stream. */
export function completedToolItem(
  started: { readonly state: ActiveTool; readonly item: ThreadItem },
  completion: ToolCompletion,
  cwd: string,
): ThreadItem {
  const { state } = started;
  if (started.item.type === "fileChange" && FILE_TOOLS.has(state.name)) {
    return completeFileItem(started.item, state.name, state.input, completion, cwd);
  }
  const result = completion.record.toolUseResult;
  let item = projectToolCompletion(
    started.item,
    state,
    structuredOutput(completion),
    completion.block.is_error === true,
    result,
    cwd,
    completion.record.toolDenialKind,
  ).completed;
  if (item.type === "collabAgentToolCall") {
    const agentId = string(result?.agentId);
    const childId = agentId ? `agent-${agentId}` : undefined;
    const status = string(result?.status);
    item = {
      ...item,
      // A message (sendInput) keeps the sub-agent it went to.
      receiverThreadIds: childId ? [childId] : item.receiverThreadIds,
      agentsStates: childId ? {
        [childId]: {
          status: status === "stopped" ? "interrupted" : completion.block.is_error ? "errored" : "completed",
          message: string(result?.description) ?? null,
        },
      } : item.agentsStates,
    };
  }
  // Claude reports a message it could not deliver as a result (`success: false` and why), not as an error. Desktop
  // shows a failed tool call with its error only for MCP tools: the send becomes one, of the Claude "server".
  const undelivered = state.name === "SendMessage" && result?.success === false ? string(result.message) ?? "Not delivered." : undefined;
  return undelivered ? {
    type: "mcpToolCall", id: item.id, server: "claude", tool: state.name, status: "failed", arguments: state.input as JsonValue,
    appContext: null, pluginId: null, result: null, error: { message: undelivered }, durationMs: null, readOnlyHint: null,
  } : item;
}

function responseHasTools(records: readonly TranscriptChainRecord[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const record of records) {
    if (record.type !== "assistant" || !record.message.id) continue;
    if (assistantBlocks(record).some((block) => ["tool_use", "server_tool_use", "mcp_tool_use"].includes(String(block.type)))) {
      result.add(record.message.id);
    }
  }
  return result;
}

interface ResponseBlock {
  readonly record: AssistantRecord;
  readonly block: Record<string, unknown>;
  readonly apiBlockIndex: number;
}

function responseBlocks(records: readonly AssistantRecord[]): ResponseBlock[] {
  const ordered = records
    .map((record, order) => ({ record, order }))
    .sort((left, right) =>
      (left.record.apiBlockIndex ?? left.order) - (right.record.apiBlockIndex ?? right.order));
  let fallbackIndex = 0;
  return ordered.flatMap(({ record }) => assistantBlocks(record).map((block, blockIndex) => {
    const apiBlockIndex = record.apiBlockIndex === undefined
      ? fallbackIndex
      : record.apiBlockIndex + blockIndex;
    fallbackIndex = Math.max(fallbackIndex, apiBlockIndex + 1);
    return { record, block, apiBlockIndex };
  }));
}

function assistantItems(
  records: readonly AssistantRecord[],
  cwd: string,
  threadId: string,
  completions: ReadonlyMap<string, ToolCompletion>,
  toolResponses: ReadonlySet<string>,
  codexCalls: Map<string, number>,
  peers: Peers,
): ThreadItem[] {
  let reasoning: Extract<ThreadItem, { type: "reasoning" }> | undefined;
  return responseBlocks(records).flatMap(({ record, block, apiBlockIndex }): ThreadItem[] => {
    const messageId = record.message.id!;
    if (block.type === "text" && typeof block.text === "string") return [{
      type: "agentMessage", id: assistantBlockItemId(messageId, apiBlockIndex), text: block.text,
      phase: record.message.id && toolResponses.has(record.message.id) ? "commentary" : "final_answer",
      memoryCitation: null, delivery: null, questions: null,
    }];
    if (block.type === "thinking" && typeof block.thinking === "string") {
      if (reasoning) {
        reasoning.summary.push(block.thinking);
        return [];
      }
      const item: Extract<ThreadItem, { type: "reasoning" }> = {
        type: "reasoning", id: assistantBlockItemId(messageId, apiBlockIndex), summary: [block.thinking], content: [],
      };
      reasoning = item;
      return [item];
    }
    if (["tool_use", "server_tool_use", "mcp_tool_use"].includes(String(block.type))
      && typeof block.id === "string" && typeof block.name === "string") {
      const item = projectTool(block as unknown as ToolUseBlock, apiBlockIndex, record, cwd, threadId, completions, peers);
      if (!item) return [];
      if (!CODEX_MCP_TOOLS.has(block.name)) return [item];
      const result = completions.get(block.id)?.block.content;
      return [item, ...codexMcpItems(block.id, object(block.input) ?? {}, result === undefined ? undefined : outputText(result), codexCalls)];
    }
    return [];
  });
}

function turnStatus(records: readonly TranscriptChainRecord[], hasFollowingTurn: boolean): Turn["status"] {
  const failed = records.some((record) => record.type === "system" && record.subtype === "api_error"
    || record.type === "assistant" && (record.isApiErrorMessage === true || Boolean(record.error)));
  const interrupted = records.some((record) => record.type === "user" && (record.interruptedByShutdown === true
    || record.toolUseResult?.interrupted === true || /^\[Request interrupted by user(?: for tool use)?\]$/u.test(userText(record))));
  if (interrupted) return "interrupted";
  if (failed) return "failed";
  const lastAssistant = records.findLast((record): record is AssistantRecord => record.type === "assistant");
  const stopReason = lastAssistant?.message.stop_reason;
  // A local command (`/usage`, `/cost`...) ends with its output and no model reply.
  const last = records.at(-1)!;
  const localCommand = last.type === "system" && last.subtype === "local_command";
  const terminal = localCommand || isCompactBoundary(last)
    || stopReason !== null && stopReason !== undefined && !NON_TERMINAL_STOPS.has(stopReason);
  return terminal || hasFollowingTurn ? "completed" : "inProgress";
}

/** What Claude showed for the failure: its synthetic error reply, else the last request error. */
function errorMessage(records: readonly TranscriptChainRecord[]): string {
  const reply = records.findLast((record): record is AssistantRecord =>
    record.type === "assistant" && (record.isApiErrorMessage === true || Boolean(record.error)));
  const content = reply?.message.content ?? [];
  const text = typeof content === "string" ? content : content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
  const request = records.findLast((record): record is SystemRecord => record.type === "system" && record.subtype === "api_error");
  return text || request?.error?.formatted || "Claude turn failed.";
}

/**
 * Prompts Claude took while a turn was running (Desktop's steer): live they fold into that turn, so here too. A prompt
 * sent to an idle session is dequeued right after its `enqueue`; a steer waits in the queue while the turn goes on.
 * A message another agent sent waits there too (its record wraps what was queued) but starts a turn of its own.
 */
function steeredPrompts(records: readonly TranscriptRecord[]): ReadonlySet<string> {
  const steered = new Set<string>();
  const queue: Array<{ content: string; waited: boolean }> = [];
  const taken: string[] = [];
  for (const record of records) {
    if (record.type === "queue-operation") {
      if (record.operation === "enqueue") queue.push({ content: (record.content ?? "").trim(), waited: false });
      else {
        const entry = queue.shift();
        if (entry?.waited) taken.push(entry.content);
      }
      continue;
    }
    if (record.type === "user" && taken.length) {
      const text = userText(record).trim();
      const peer = peerOrigin(record.origin) !== undefined;
      const index = taken.findIndex((content) => peer ? text.includes(content) : text === content);
      if (index >= 0) {
        taken.splice(index, 1);
        // What else waited in the queue (a finished task's notification) is no prompt of the turn.
        if (!peer && startsTurn(record)) steered.add(record.uuid);
        continue;
      }
    }
    if (record.type === "assistant" || record.type === "user") for (const entry of queue) entry.waited = true;
  }
  return steered;
}

/** A message another agent sent starts a turn when Claude took it as a prompt of its own (a new `promptId`). */
function turnStarts(records: readonly TranscriptChainRecord[], subagentPromptUuid: string | undefined, steered: ReadonlySet<string>): number[] {
  let promptId: string | undefined;
  return records.flatMap((record, index) => {
    if (record.type !== "user") return [];
    const previous = promptId;
    promptId = record.promptId ?? promptId;
    if (steered.has(record.uuid)) return [];
    const starts = peerOrigin(record.origin)
      ? record.promptId === undefined || record.promptId !== previous
      : startsTurn(record, subagentPromptUuid);
    return starts ? [index] : [];
  });
}

/** The session's sub-agents, from the results of the calls that started them. */
function subagentIds(completions: ReadonlyMap<string, ToolCompletion>): Set<string> {
  return new Set([...completions.values()].flatMap(({ record }) => string(record.toolUseResult?.agentId) ?? []));
}

function projectTurns(
  records: readonly TranscriptChainRecord[],
  cwd: string,
  threadId: string,
  subagentPromptUuid: string | undefined,
  steered: ReadonlySet<string>,
  directory: PeerDirectory,
): Turn[] {
  const starts = turnStarts(records, subagentPromptUuid, steered);
  const completions = toolCompletions(records);
  const peers: Peers = { directory, children: subagentIds(completions) };
  const toolResponses = responseHasTools(records);
  const codexCalls = new Map<string, number>();
  const turns = starts.map((start, turnIndex) => {
    const end = starts[turnIndex + 1] ?? records.length;
    const prompt = records[start] as UserRecord;
    const turnRecords = records.slice(start, end);
    const input = userInputs(prompt);
    const hiddenCommand = input.length === 1 && input[0]?.type === "text"
      && /^\/(?:compact(?:\s|$)|goal clear$)/u.test(input[0].text);
    const peer = peerOrigin(prompt.origin);
    const items: ThreadItem[] = peer ? [peerMessageItem(prompt.uuid, peer, userText(prompt), peers)]
      : hiddenCommand ? []
      : [{ type: "userMessage", id: prompt.uuid, clientId: null, content: input }];
    const responses = new Map<string, AssistantRecord[]>();
    for (const record of turnRecords) {
      if (record.type !== "assistant") continue;
      const messageId = record.message.id!;
      const response = responses.get(messageId) ?? [];
      response.push(record);
      responses.set(messageId, response);
    }
    const projectedResponses = new Set<string>();
    for (const record of turnRecords.slice(1)) {
      if (record.type === "assistant") {
        const messageId = record.message.id!;
        if (projectedResponses.has(messageId)) continue;
        projectedResponses.add(messageId);
        items.push(...assistantItems(responses.get(messageId)!, cwd, threadId, completions, toolResponses, codexCalls, peers));
      }
      else if (record.type === "user" && peerOrigin(record.origin)) {
        items.push(peerMessageItem(record.uuid, peerOrigin(record.origin)!, userText(record), peers));
      }
      else if (record.type === "user" && steered.has(record.uuid)) {
        items.push({ type: "userMessage", id: record.uuid, clientId: null, content: userInputs(record) });
      } else if (record.type === "system" && record.subtype === "local_command" && typeof record.content === "string") {
        const text = record.content.replace(/<\/?local-command-std(?:out|err)>/gu, "").trim();
        if (text) items.push({ type: "agentMessage", id: record.uuid, text, phase: "commentary", memoryCitation: null });
      } else if (isCompactBoundary(record)) items.push({ type: "contextCompaction", id: record.uuid });
      else if (record.type === "attachment") {
        // A message sent mid-turn: Claude folds it into the running turn.
        const attachment = object(record.attachment);
        const peer = peerOrigin(attachment?.origin);
        if (attachment?.type === "queued_command" && peer) {
          items.push(peerMessageItem(string(attachment.source_uuid) ?? record.uuid, peer, string(attachment.prompt) ?? "", peers));
        } else if (attachment?.type === "queued_command" && attachment.commandMode === "prompt" && typeof attachment.prompt === "string") {
          items.push({
            type: "userMessage", id: string(attachment.source_uuid) ?? record.uuid, clientId: null,
            content: [{ type: "text", text: attachment.prompt, text_elements: [] }],
          });
        }
      }
    }
    const status = turnStatus(turnRecords, turnIndex + 1 < starts.length);
    const startedAt = timestampSeconds(prompt.timestamp);
    // A later local command (a model switch) trails the turn in the transcript without extending it.
    const last = turnRecords.findLast((record) => record.type !== "user" || record === prompt
      || record.isMeta !== true && !/^<(?:command-name|local-command-)/u.test(userText(record)));
    const completedAt = status === "inProgress" ? null : timestampSeconds(last?.timestamp);
    return {
      id: prompt.uuid,
      items,
      itemsView: "full",
      status,
      error: status === "failed"
        ? { message: errorMessage(turnRecords), codexErrorInfo: null, additionalDetails: null }
        : null,
      startedAt,
      completedAt,
      durationMs: startedAt === null || completedAt === null ? null : Math.max(0, (completedAt - startedAt) * 1_000),
    } satisfies Turn;
  });
  // Claude writes a manual `/compact` boundary before the command record; live, it belongs to the `/compact` turn.
  turns.forEach((turn, index) => {
    const previous = turns[index - 1];
    if (!previous || turn.items.length || previous.items.at(-1)?.type !== "contextCompaction") return;
    turn.items.push(previous.items.pop()!);
  });
  return turns;
}

function projectTurnBoundaries(
  records: readonly TranscriptChainRecord[],
  subagentPromptUuid: string | undefined,
  steered: ReadonlySet<string>,
): TurnProviderBoundary[] {
  const starts = turnStarts(records, subagentPromptUuid, steered);
  return starts.flatMap((start, turnIndex) => {
    const prompt = records[start] as UserRecord;
    const range = records.slice(start + 1, starts[turnIndex + 1] ?? records.length);
    // A compaction that ends the turn (the next turn is the `/compact`) is not part of it: forks stay uncompacted.
    const compaction = range.findLastIndex((record) => isCompactBoundary(record));
    const kept = compaction >= 0 && !range.slice(compaction).some((record) => record.type === "assistant") ? range.slice(0, compaction) : range;
    return [{ turnId: prompt.uuid, messageUuid: (kept.at(-1) ?? prompt).uuid }];
  });
}

/** The Codex thread for a native session header (list rows, reads, live responses). */
export function nativeThread(
  id: string,
  header: TranscriptHeader,
  options: {
    readonly status: Thread["status"];
    readonly turns?: Turn[];
    readonly subagent?: { readonly parentThreadId: string; readonly depth: number; readonly nickname: string };
  },
): Thread {
  const subagent = options.subagent;
  return {
    id,
    // Like stock's: Desktop files a remote project's new thread under the project by it.
    environments: header.cwd ? [{ environmentId: "local", cwd: header.cwd, runtimeWorkspaceRoots: [header.cwd] }] : null,
    extra: null,
    sessionId: id,
    forkedFromId: subagent ? subagent.parentThreadId : null,
    parentThreadId: subagent?.parentThreadId ?? null,
    preview: header.preview,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "claude",
    model: header.model ? `claude:${normalizeClaudeModelIdentifier(header.model)}` : null,
    reasoningEffort: header.reasoningEffort,
    createdAt: header.createdAt,
    updatedAt: header.updatedAt,
    recencyAt: header.updatedAt,
    status: options.status,
    path: null,
    cwd: header.cwd,
    cliVersion: header.cliVersion ?? "claude-code",
    originator: null,
    source: subagent ? { subAgent: { thread_spawn: {
      parent_thread_id: subagent.parentThreadId, depth: subagent.depth, agent_path: null,
      agent_nickname: subagent.nickname, agent_role: null,
    } } } : "vscode",
    canAcceptDirectInput: subagent ? false : true,
    threadSource: subagent ? "subagent" : "user",
    agentNickname: subagent?.nickname ?? null,
    agentRole: null,
    gitInfo: { sha: null, branch: header.gitBranch, originUrl: null },
    name: subagent?.nickname ?? header.customTitle ?? header.aiTitle,
    daybreakEnabled: null,
    turns: options.turns ?? [],
  };
}

export async function projectTranscript(input: ProjectTranscriptInput): Promise<TranscriptProjection> {
  let skippedLines = 0;
  let rawRecords: readonly TranscriptRecord[];
  if (input.records) rawRecords = input.records;
  else if (input.history) rawRecords = input.history.records;
  else {
    const reader = readTranscriptRecords(input.path);
    const loaded: TranscriptRecord[] = [];
    for await (const record of reader) loaded.push(record);
    skippedLines = reader.skippedLines;
    rawRecords = loaded;
  }
  const history = input.history ?? selectHistory(rawRecords, input.leafUuid);
  const selected = history.records;
  const header = input.header ?? summarizeTranscript(rawRecords, input.subagent?.promptRecordUuid);
  const steered = steeredPrompts(rawRecords);
  const turns = projectTurns(selected, header.cwd, input.sessionId, input.subagent?.promptRecordUuid, steered, input.peers ?? NO_PEERS.directory);
  const nickname = input.subagent?.nickname ?? null;
  const parentThreadId = input.parentThreadId ?? null;
  const status: Thread["status"] = turns.at(-1)?.status === "inProgress"
    ? { type: "active", activeFlags: [] }
    : { type: "idle" };
  const thread = nativeThread(input.sessionId, header, {
    status,
    turns: [...turns],
    ...(input.subagent ? { subagent: { parentThreadId: parentThreadId!, depth: input.subagent.depth, nickname: nickname! } } : {}),
  });
  const lastAssistant = selected.findLast((record): record is AssistantRecord => record.type === "assistant");
  return {
    thread,
    turns,
    lastAssistantUuid: lastAssistant?.uuid ?? null,
    tokenUsage: projectedUsage(selected),
    skippedLines,
    compactionBoundaries: history.compactionBoundaries,
    turnBoundaries: projectTurnBoundaries(selected, input.subagent?.promptRecordUuid, steered),
    selectedLeafUuid: history.leafUuid,
    selectedRecordUuids: new Set(selected.map((record) => record.uuid)),
  };
}
