import { v7 as uuidv7 } from "uuid";
import type { ThreadItem } from "../codex/generated/v2/ThreadItem.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import type { UserInput } from "../codex/generated/v2/UserInput.js";

export interface TransientNotice {
  readonly response: { turn: Turn };
  readonly notifications: Array<{ method: string; params: unknown }>;
}

export interface ProviderMigrationNotice extends TransientNotice {
  readonly turnId: string;
  readonly compactionItemId: string;
}

export type SystemNoticeKind = "info" | "error";

export function systemNoticeText(text: string, kind: SystemNoticeKind = "info"): string {
  return kind === "error" ? `◆ **CCodex** │ ⚠️ ${text}` : `◆ **CCodex** │ ${text}`;
}

export function transientAgentNotice(threadId: string, text: string, nowMs = Date.now()): TransientNotice {
  const turnId = uuidv7({ msecs: nowMs });
  const itemId = uuidv7({ msecs: nowMs });
  const startedAt = Math.floor(nowMs / 1_000);
  const started: Turn = {
    id: turnId,
    items: [],
    itemsView: "notLoaded",
    status: "inProgress",
    error: null,
    startedAt,
    completedAt: null,
    durationMs: null,
  };
  const emptyItem: ThreadItem = {
    type: "agentMessage",
    id: itemId,
    text: "",
    phase: null,
    memoryCitation: null,
  };
  const item: ThreadItem = { ...emptyItem, text };
  const completed: Turn = {
    ...started,
    items: [item],
    itemsView: "full",
    status: "completed",
    completedAt: startedAt,
    durationMs: 0,
  };
  return {
    response: { turn: started },
    notifications: [
      { method: "turn/started", params: { threadId, turn: started } },
      { method: "item/started", params: { item: emptyItem, threadId, turnId, startedAtMs: nowMs } },
      { method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: text } },
      { method: "item/completed", params: { item, threadId, turnId, completedAtMs: nowMs } },
      { method: "turn/completed", params: { threadId, turn: completed } },
    ],
  };
}

export function transientSystemNotice(
  threadId: string,
  text: string,
  kind: SystemNoticeKind = "info",
  nowMs = Date.now(),
): TransientNotice {
  return transientAgentNotice(threadId, systemNoticeText(text, kind), nowMs);
}

export function transientCommandNotice(
  threadId: string,
  content: UserInput[],
  text: string,
  clientId: string | null = null,
  nowMs = Date.now(),
): TransientNotice {
  const turnId = uuidv7({ msecs: nowMs });
  const user: ThreadItem = {
    type: "userMessage", id: uuidv7({ msecs: nowMs }), clientId, content,
  };
  const agentId = uuidv7({ msecs: nowMs });
  const emptyAgent: ThreadItem = {
    type: "agentMessage", id: agentId, text: "", phase: null, memoryCitation: null,
  };
  const agent: ThreadItem = { ...emptyAgent, text, phase: "final_answer" };
  const startedAt = Math.floor(nowMs / 1_000);
  const started: Turn = {
    id: turnId,
    items: [user],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt,
    completedAt: null,
    durationMs: null,
  };
  const completed: Turn = {
    ...started,
    items: [user, agent],
    status: "completed",
    completedAt: startedAt,
    durationMs: 0,
  };
  return {
    response: { turn: started },
    notifications: [
      { method: "turn/started", params: { threadId, turn: started } },
      { method: "item/started", params: { item: user, threadId, turnId, startedAtMs: nowMs } },
      { method: "item/completed", params: { item: user, threadId, turnId, completedAtMs: nowMs } },
      { method: "item/started", params: { item: emptyAgent, threadId, turnId, startedAtMs: nowMs } },
      { method: "item/agentMessage/delta", params: { threadId, turnId, itemId: agentId, delta: text } },
      { method: "item/completed", params: { item: agent, threadId, turnId, completedAtMs: nowMs } },
      { method: "turn/completed", params: { threadId, turn: completed } },
    ],
  };
}

export function providerMigrationNotice(
  threadId: string,
  nowMs = Date.now(),
): ProviderMigrationNotice {
  const turnId = uuidv7({ msecs: nowMs });
  const compaction: ThreadItem = { type: "contextCompaction", id: uuidv7({ msecs: nowMs }) };
  const startedAt = Math.floor(nowMs / 1_000);
  const turn: Turn = {
    id: turnId,
    items: [compaction],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt,
    completedAt: null,
    durationMs: null,
  };
  return {
    turnId,
    compactionItemId: compaction.id,
    response: { turn },
    notifications: [
      { method: "turn/started", params: { threadId, turn } },
      { method: "item/started", params: { item: compaction, threadId, turnId, startedAtMs: nowMs } },
    ],
  };
}

export function providerMigrationFailed(
  threadId: string,
  migration: ProviderMigrationNotice,
  message: string,
  nowMs = Date.now(),
): Array<{ method: string; params: unknown }> {
  const started = migration.response.turn;
  const compaction = started.items.find((item) => item.id === migration.compactionItemId)!;
  const turn: Turn = {
    ...started,
    status: "failed",
    error: { message, codexErrorInfo: "badRequest", additionalDetails: null },
    completedAt: Math.floor(nowMs / 1_000),
    durationMs: Math.max(0, nowMs - (started.startedAt ?? Math.floor(nowMs / 1_000)) * 1_000),
  };
  return [
    { method: "item/completed", params: { item: compaction, threadId, turnId: turn.id, completedAtMs: nowMs } },
    { method: "turn/completed", params: { threadId, turn } },
  ];
}

export function providerMigrationCompleted(
  threadId: string,
  migration: ProviderMigrationNotice,
  nowMs = Date.now(),
): Array<{ method: string; params: unknown }> {
  const started = migration.response.turn;
  const compaction = started.items.find((item) => item.id === migration.compactionItemId)!;
  const turn: Turn = {
    ...started,
    status: "completed",
    completedAt: Math.floor(nowMs / 1_000),
    durationMs: Math.max(0, nowMs - (started.startedAt ?? Math.floor(nowMs / 1_000)) * 1_000),
  };
  return [
    { method: "item/completed", params: { item: compaction, threadId, turnId: turn.id, completedAtMs: nowMs } },
    { method: "thread/compacted", params: { threadId, turnId: turn.id } },
    { method: "turn/completed", params: { threadId, turn } },
  ];
}
