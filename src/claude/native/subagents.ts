/** Owns discovery and tree projection of a native session's retained sub-agent transcripts. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeModelLabel } from "../modelSelection.js";
import { selectHistory } from "./history.js";
import { projectTranscript, type TranscriptProjection } from "./projector.js";
import { readTranscriptRecords, type TranscriptRecord, type UserRecord } from "./records.js";

export interface SubagentMeta {
  readonly agentType: string;
  readonly description: string;
  readonly toolUseId: string;
  readonly spawnDepth: number;
  readonly model?: string;
  readonly parentAgentId?: string;
  readonly stoppedByUser?: boolean;
}

export interface ProjectedSubagent {
  readonly agentId: string;
  readonly toolUseId: string;
  readonly parentAgentId: string | null;
  readonly projection: TranscriptProjection;
}

function taskPrompt(records: readonly TranscriptRecord[], toolUseId: string): UserRecord {
  return records.find((record): record is UserRecord => record.type === "user" && record.sourceToolUseID === toolUseId)
    ?? records.find((record): record is UserRecord => record.type === "user" && !record.isCompactSummary
      && (typeof record.message.content === "string"
        ? Boolean(record.message.content)
        : record.message.content.some((block) => block.type === "text")))!;
}

function asVisibleSidechain(record: TranscriptRecord): TranscriptRecord {
  if (record.type !== "user" && record.type !== "assistant" && record.type !== "system" && record.type !== "attachment") {
    return record;
  }
  return { ...record, isSidechain: false };
}

export async function projectSubagents(
  sessionDirectory: string,
  spawningThreadId: string,
): Promise<ProjectedSubagent[]> {
  const directory = join(sessionDirectory, "subagents");
  const names = (await readdir(directory)).filter((name) => /^agent-.+\.meta\.json$/u.test(name)).sort();
  const metas = await Promise.all(names.map(async (name) => {
    const agentId = name.slice("agent-".length, -".meta.json".length);
    const meta = JSON.parse(await readFile(join(directory, name), "utf8")) as SubagentMeta;
    return { agentId, meta };
  }));
  metas.sort((left, right) => left.meta.spawnDepth - right.meta.spawnDepth || left.agentId.localeCompare(right.agentId));

  const projected: ProjectedSubagent[] = [];
  for (const { agentId, meta } of metas) {
    const path = join(directory, `agent-${agentId}.jsonl`);
    const reader = readTranscriptRecords(path);
    const records: TranscriptRecord[] = [];
    for await (const record of reader) records.push(asVisibleSidechain(record));
    const prompt = taskPrompt(records, meta.toolUseId);
    const assistants = records.filter((record) => record.type === "assistant");
    // Claude's own error replies carry the model "<synthetic>".
    const resolvedModel = assistants.flatMap((record) => record.message.model && record.message.model !== "<synthetic>" ? [record.message.model] : []).at(-1)
      ?? meta.model ?? "Claude";
    const description = meta.description.replace(/\s+/gu, " ").trim();
    const nickname = `${description} [${claudeModelLabel(resolvedModel)}]`;
    const parentThreadId = meta.parentAgentId ? `agent-${meta.parentAgentId}` : spawningThreadId;
    const projection = await projectTranscript({
      sessionId: `agent-${agentId}`,
      path,
      records,
      history: selectHistory(records),
      parentThreadId,
      subagent: { promptRecordUuid: prompt.uuid, nickname, depth: meta.spawnDepth },
    });
    projected.push({
      agentId,
      toolUseId: meta.toolUseId,
      parentAgentId: meta.parentAgentId ?? null,
      projection: { ...projection, skippedLines: reader.skippedLines },
    });
  }
  return projected;
}
