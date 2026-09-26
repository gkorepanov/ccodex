/** Owns current-branch selection from Claude's non-linear transcript graph. */
import {
  isChainRecord,
  isCompactBoundary,
  type AssistantRecord,
  type TranscriptChainRecord,
  type TranscriptRecord,
  type UserRecord,
} from "./records.js";

export interface SelectedHistory {
  readonly records: readonly TranscriptChainRecord[];
  readonly compactionBoundaries: ReadonlySet<string>;
  readonly leafUuid: string | null;
  /** The walk stopped at a parent the records lack (a window of the transcript, not all of it). */
  readonly truncated: boolean;
  /** A selected compaction keeps messages the records lack (they precede it in the file): their order is unknown. */
  readonly partialCompaction: boolean;
  /** The compaction past which the walk followed the file's own order (older records read as written). */
  readonly physicalFrom: string | null;
}

function apiMessageId(record: TranscriptChainRecord): string | undefined {
  return record.type === "assistant" ? record.message.id : undefined;
}

function isToolResult(record: TranscriptChainRecord): record is UserRecord & { readonly parentUuid: string } {
  return record.type === "user" && record.parentUuid !== null && Array.isArray(record.message.content)
    && record.message.content.some((block) => block.type === "tool_result");
}

function relinkCompactions(records: ReadonlyMap<string, TranscriptChainRecord>, partial: Set<string>): Map<string, TranscriptChainRecord> {
  const linked = new Map(records);
  for (const record of linked.values()) {
    if (!isCompactBoundary(record)) continue;
    const messages = record.compactMetadata?.preservedMessages;
    const segment = record.compactMetadata?.preservedSegment;
    // Its anchor follows it: without the anchor, nothing links (the file lacks the kept messages too).
    if (messages && linked.has(messages.anchorUuid) && messages.uuids.some((uuid) => !linked.has(uuid))
      || segment && linked.has(segment.anchorUuid) && (!linked.has(segment.headUuid) || !linked.has(segment.tailUuid))) partial.add(record.uuid);
    if (messages) {
      if (messages.uuids.length === 0 || messages.uuids.some((uuid) => !linked.has(uuid))) continue;
      let parentUuid: string | null = messages.anchorUuid;
      for (const uuid of messages.uuids) {
        linked.set(uuid, { ...linked.get(uuid)!, parentUuid });
        parentUuid = uuid;
      }
      const first = messages.uuids[0]!;
      const last = messages.uuids.at(-1)!;
      for (const [uuid, candidate] of linked) {
        if (candidate.parentUuid === messages.anchorUuid && uuid !== first) {
          linked.set(uuid, { ...candidate, parentUuid: last });
        }
      }
    } else if (segment) {
      const head = linked.get(segment.headUuid);
      if (head) linked.set(segment.headUuid, { ...head, parentUuid: segment.anchorUuid });
      for (const [uuid, candidate] of linked) {
        if (candidate.parentUuid === segment.anchorUuid && uuid !== segment.headUuid) {
          linked.set(uuid, { ...candidate, parentUuid: segment.tailUuid });
        }
      }
    }
  }
  return linked;
}

function siblingBlocks(
  records: ReadonlyMap<string, TranscriptChainRecord>,
  selected: readonly TranscriptChainRecord[],
): TranscriptChainRecord[] {
  const selectedAssistants = selected.filter((record): record is AssistantRecord => record.type === "assistant");
  if (selectedAssistants.length === 0) return [...selected];

  // An API message's records, as written: one message never spans a prompt (0.4's restored turns share one id).
  const responseOf = new Map<string, string>();
  const assistantsByMessage = new Map<string, TranscriptChainRecord[]>();
  const resultsByParent = new Map<string, TranscriptChainRecord[]>();
  const fileOrder = new Map<string, number>();
  let prompts = 0;
  for (const [index, record] of [...records.values()].entries()) {
    fileOrder.set(record.uuid, index);
    const messageId = apiMessageId(record);
    if (messageId) {
      const response = `${prompts}:${messageId}`;
      responseOf.set(record.uuid, response);
      const values = assistantsByMessage.get(response) ?? [];
      values.push(record);
      assistantsByMessage.set(response, values);
    } else if (record.type === "user" && record.isMeta !== true && !isToolResult(record)) {
      prompts += 1;
    } else if (isToolResult(record)) {
      const values = resultsByParent.get(record.parentUuid) ?? [];
      values.push(record);
      resultsByParent.set(record.parentUuid, values);
    }
  }

  const byResponseOrder = (left: TranscriptChainRecord, right: TranscriptChainRecord) => {
    if (left.type === "assistant" && right.type === "assistant"
      && left.apiBlockIndex !== undefined && right.apiBlockIndex !== undefined) {
      return left.apiBlockIndex - right.apiBlockIndex;
    }
    return fileOrder.get(left.uuid)! - fileOrder.get(right.uuid)!;
  };
  const expandedMessages = new Set<string>();
  const expandedUuids = new Set<string>();
  const expanded: TranscriptChainRecord[] = [];
  for (const record of selected) {
    if (expandedUuids.has(record.uuid)) continue;
    const response = responseOf.get(record.uuid);
    if (!response) {
      expandedUuids.add(record.uuid);
      expanded.push(record);
      continue;
    }
    if (expandedMessages.has(response)) continue;
    expandedMessages.add(response);
    const responseRecords = [...assistantsByMessage.get(response)!].sort(byResponseOrder);
    const toolResults: TranscriptChainRecord[] = [];
    for (const responseRecord of responseRecords) {
      for (const result of resultsByParent.get(responseRecord.uuid) ?? []) {
        toolResults.push(result);
      }
    }
    toolResults.sort((left, right) => fileOrder.get(left.uuid)! - fileOrder.get(right.uuid)!);
    for (const value of [...responseRecords, ...toolResults]) {
      if (expandedUuids.has(value.uuid)) continue;
      expandedUuids.add(value.uuid);
      expanded.push(value);
    }
  }
  return expanded;
}

/** A message another agent sent: a meta record Claude answers like a prompt, or (while it works) a queued command. */
function peerMessage(record: TranscriptChainRecord): boolean {
  if (record.type === "user") return record.origin?.kind === "peer";
  const attachment = record.type === "attachment" ? record.attachment as { type?: unknown; origin?: { kind?: unknown } } | undefined : undefined;
  return attachment?.type === "queued_command" && attachment.origin?.kind === "peer";
}

function visible(record: TranscriptChainRecord): boolean {
  const peer = peerMessage(record);
  if (record.type !== "user" && record.type !== "assistant" && record.type !== "system" && !peer) return false;
  return (record.isMeta !== true || peer) && record.isSidechain !== true && !record.teamName;
}

/** `physical`: the leaf lies past a later compaction (a window of older history), where the walk reads records as written. */
export function selectHistory(input: readonly TranscriptRecord[], leafUuid?: string, physical = false): SelectedHistory {
  const chain = input.filter(isChainRecord);
  const lastWins = new Map<string, TranscriptChainRecord>();
  for (const record of chain) lastWins.set(record.uuid, record);
  const partial = new Set<string>();
  const records = relinkCompactions(lastWins, partial);
  const positions = new Map<string, number>();
  chain.forEach((record, index) => positions.set(record.uuid, index));
  const occurrences = new Map<string, { readonly index: number; readonly record: TranscriptChainRecord }[]>();
  chain.forEach((record, index) => {
    const values = occurrences.get(record.uuid) ?? [];
    values.push({ index, record });
    occurrences.set(record.uuid, values);
  });
  const before = (uuid: string, limit: number): TranscriptChainRecord | undefined =>
    occurrences.get(uuid)?.findLast((value) => value.index < limit)?.record;

  let leaf: TranscriptChainRecord;
  if (leafUuid) {
    leaf = records.get(leafUuid)!;
  } else {
    const parentUuids = new Set<string>();
    for (const record of records.values()) if (record.parentUuid) parentUuids.add(record.parentUuid);
    const conversationalLeaves: Array<{
      readonly leaf: TranscriptChainRecord;
      readonly conversational: TranscriptChainRecord;
    }> = [];
    for (const candidate of [...records.values()].filter((record) => !parentUuids.has(record.uuid))) {
      let cursor: TranscriptChainRecord | undefined = candidate;
      const seen = new Set<string>();
      while (cursor) {
        if (seen.has(cursor.uuid)) break;
        seen.add(cursor.uuid);
        if (cursor.type === "user" || cursor.type === "assistant") {
          conversationalLeaves.push({ leaf: candidate, conversational: cursor });
          break;
        }
        cursor = cursor.parentUuid ? records.get(cursor.parentUuid) : undefined;
      }
    }
    if (conversationalLeaves.length === 0) {
      return { records: [], compactionBoundaries: new Set(), leafUuid: null, truncated: false, partialCompaction: false, physicalFrom: null };
    }
    const preferred = conversationalLeaves.filter(({ conversational }) =>
      conversational.isSidechain !== true && !conversational.teamName && conversational.isMeta !== true);
    const candidates = preferred.length > 0 ? preferred : conversationalLeaves;
    leaf = candidates.reduce((latest, candidate) =>
      (positions.get(candidate.leaf.uuid) ?? -1) > (positions.get(latest.leaf.uuid) ?? -1) ? candidate : latest).leaf;
  }

  const reversed: TranscriptChainRecord[] = [];
  const selectedUuids = new Set<string>();
  let physicalWalk = physical;
  let snapshotLimit = chain.length;
  let physicalFrom: string | null = null;
  let cursor: TranscriptChainRecord | undefined = physical ? before(leaf.uuid, snapshotLimit) : records.get(leaf.uuid);
  const seenPhysicalRecords = new Set<TranscriptChainRecord>();
  let missing: string | null | undefined;
  while (cursor) {
    if (physicalWalk && selectedUuids.has(cursor.uuid)) {
      if (seenPhysicalRecords.has(cursor)) break;
      seenPhysicalRecords.add(cursor);
      cursor = cursor.parentUuid ? before(cursor.parentUuid, snapshotLimit) : undefined;
      continue;
    }
    if (selectedUuids.has(cursor.uuid)) break;
    selectedUuids.add(cursor.uuid);
    reversed.push(cursor);
    if (isCompactBoundary(cursor) && cursor.logicalParentUuid) {
      if (!physicalWalk) physicalFrom = cursor.uuid;
      physicalWalk = true;
      snapshotLimit = positions.get(cursor.uuid) ?? snapshotLimit;
      missing = cursor.logicalParentUuid;
      cursor = before(missing, snapshotLimit);
    } else {
      missing = cursor.parentUuid;
      cursor = missing
        ? (physicalWalk ? before(missing, snapshotLimit) : records.get(missing))
        : undefined;
    }
  }
  const selected = siblingBlocks(records, reversed.reverse()).filter(visible);
  return {
    records: selected,
    compactionBoundaries: new Set(selected.filter(isCompactBoundary).map((record) => record.uuid)),
    leafUuid: leaf.uuid,
    truncated: Boolean(missing) && !occurrences.has(missing!),
    partialCompaction: reversed.some((record) => partial.has(record.uuid)),
    physicalFrom,
  };
}
