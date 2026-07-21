import { v7 as uuidv7 } from "uuid";
import type { ThreadItem } from "../../codex/generated/v2/ThreadItem.js";
import type { Turn } from "../../codex/generated/v2/Turn.js";
import type { ClaudeThreadRecord } from "../../store/HybridStore.js";
import type { ActiveTool } from "../toolMapper.js";
import type { FileSnapshot } from "../fileSnapshots.js";
import type { MainStreamFact, MainStreamProjection } from "./commands.js";

export interface MainStreamState {
  readonly ownerThreadId: string;
  readonly turnId: string;
  readonly record: ClaudeThreadRecord;
  readonly blockItems: Map<number, string>;
  readonly reasoningSummaryIndices: Map<number, number>;
  readonly openBlocks: Set<number>;
  readonly suppressedBlocks: Set<number>;
  readonly completedItems: Set<string>;
  readonly pendingAgentItemIds: Set<string>;
  readonly tools: Map<string, SessionTool>;
  readonly review?: string;
}

export interface SessionTool extends ActiveTool {
  fileSnapshot?: FileSnapshot;
}

export interface ScopeTask {
  readonly taskId: string;
  readonly ownerThreadId: string;
  readonly itemId: string;
  readonly providerId: string;
  readonly turnId: string;
  childThreadId: string | undefined;
  outputFile: string | undefined;
  terminal: boolean;
  outputTailer?: {
    readonly runtimeGeneration: number;
    readonly decoder: TextDecoder;
    offset: number;
    timer: NodeJS.Timeout;
    reading?: Promise<void> | undefined;
    stopped: boolean;
  };
}

export function newMainStreamState(
  ownerThreadId: string,
  turnId: string,
  record: ClaudeThreadRecord,
  review?: string,
): MainStreamState {
  return {
    ownerThreadId,
    turnId,
    record,
    blockItems: new Map(),
    reasoningSummaryIndices: new Map(),
    openBlocks: new Set(),
    suppressedBlocks: new Set(),
    completedItems: new Set(),
    pendingAgentItemIds: new Set(),
    tools: new Map(),
    ...(review ? { review } : {}),
  };
}

export function toolAt(state: MainStreamState, index: number): SessionTool | undefined {
  const id = state.blockItems.get(index);
  return id ? [...state.tools.values()].find((tool) => tool.itemId === id) : undefined;
}

export function streamItem(turn: Turn, state: MainStreamState, index: number): ThreadItem | undefined {
  const id = state.blockItems.get(index);
  return id ? turn.items.find((item) => item.id === id) : undefined;
}

export function scopeProjection(turn: Turn, values: {
  itemIds?: readonly (string | null)[]; handled?: boolean; tool?: SessionTool | undefined; taskIds?: readonly string[];
  outputFile?: string | undefined; childThreadId?: string | undefined;
  childThread?: ClaudeThreadRecord["thread"] | null; terminal?: boolean | undefined;
  terminals?: MainStreamProjection["terminals"];
} = {}): MainStreamProjection {
  let tool: ActiveTool | null = null;
  if (values.tool) {
    const { fileSnapshot: _snapshot, ...state } = values.tool;
    tool = { ...state, input: { ...state.input } };
  }
  return {
    turn, itemIds: values.itemIds ?? [], handled: values.handled ?? true,
    tool: tool ?? null,
    taskIds: values.taskIds ?? [], outputFile: values.outputFile ?? null,
    childThreadId: values.childThreadId ?? null, childThread: values.childThread ?? null,
    terminal: values.terminal ?? false, terminals: values.terminals ?? [],
  };
}

export function newChildScope(
  parent: ClaudeThreadRecord,
  parentThreadId: string,
  fact: Extract<MainStreamFact, { kind: "taskStart" }>,
): { record: ClaudeThreadRecord; turn: Turn; item: ThreadItem } {
  const childThreadId = uuidv7();
  const createdAt = Math.floor(Date.now() / 1_000);
  const subAgent = typeof parent.thread.source === "object" && "subAgent" in parent.thread.source
    ? parent.thread.source.subAgent : undefined;
  const depth = typeof subAgent === "object" && "thread_spawn" in subAgent ? subAgent.thread_spawn.depth : 0;
  const text = fact.prompt ?? fact.description;
  const thread = {
    ...parent.thread, id: childThreadId, forkedFromId: parentThreadId, parentThreadId,
    preview: text, createdAt, updatedAt: createdAt, recencyAt: createdAt,
    status: { type: "active" as const, activeFlags: [] }, path: null,
    source: { subAgent: { thread_spawn: {
      parent_thread_id: parentThreadId, depth: depth + 1, agent_path: null,
      agent_nickname: fact.subagentType ?? null, agent_role: null,
    } } } as const,
    threadSource: "subagent", agentNickname: fact.subagentType ?? null,
    agentRole: null, name: null, turns: [],
  };
  const record: ClaudeThreadRecord = {
    ...parent, thread, lastClaudeMessageUuid: null, lastCompletedTurnId: null,
    tokenUsageTotal: {
      totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
    },
    tokenUsageLast: null, modelContextWindow: null, providerCostUsdTotal: 0,
  };
  const item: ThreadItem = {
    type: "userMessage", id: uuidv7(), clientId: null,
    content: [{ type: "text", text, text_elements: [] }],
  };
  const turn: Turn = {
    id: uuidv7(), items: [item], itemsView: "full", status: "inProgress", error: null,
    startedAt: createdAt, completedAt: null, durationMs: null,
  };
  return { record, turn, item };
}
