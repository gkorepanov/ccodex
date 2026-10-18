/**
 * Owns discovery of a native session's retained sub-agent transcripts: a sub-agent is what its meta.json and the two
 * ends of its transcript tell, its history is read page by page from its transcript alone (see `TranscriptPages`).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeModelLabel } from "../modelSelection.js";
import { NO_PEERS } from "../peers.js";
import { parseLines, readRange, type PageSource } from "./pages.js";
import { lastTurnRuns } from "./projector.js";
import { asVisibleSidechain, type AssistantRecord, type TranscriptRecord, type UserRecord } from "./records.js";
import { TranscriptSummarizer } from "./summary.js";

export interface SubagentMeta {
  readonly agentType: string;
  readonly description: string;
  readonly toolUseId: string;
  readonly spawnDepth: number;
  readonly model?: string;
  readonly parentAgentId?: string;
  readonly stoppedByUser?: boolean;
}

export interface Subagent {
  readonly agentId: string;
  /** Its own transcript, its thread's header and place in the tree. */
  readonly source: PageSource & { readonly subagent: NonNullable<PageSource["subagent"]> };
  /** Its last turn runs on, as the end of its transcript tells. */
  readonly running: boolean;
}

/** Bytes read at a time from either end of a transcript: its task's prompt and its last reply fit, but on rare long lines. */
const END_BYTES = 64 * 1_024;

function taskPrompt(records: readonly TranscriptRecord[], toolUseId: string): UserRecord | undefined {
  return records.find((record): record is UserRecord => record.type === "user" && record.sourceToolUseID === toolUseId)
    ?? records.find((record): record is UserRecord => record.type === "user" && !record.isCompactSummary
      && (typeof record.message.content === "string"
        ? Boolean(record.message.content)
        : record.message.content.some((block) => block.type === "text")));
}

/** A reply of the model (Claude's own error replies carry the model "<synthetic>"). */
function modelReply(record: TranscriptRecord): record is AssistantRecord {
  return record.type === "assistant" && Boolean(record.message.model) && record.message.model !== "<synthetic>";
}

/** The transcript's whole lines from its start as far as its task's prompt; `end`: where they end. */
async function head(path: string, size: number, toolUseId: string): Promise<{ records: TranscriptRecord[]; end: number; prompt?: UserRecord }> {
  for (let length = END_BYTES; ; length *= 2) {
    const { records, end } = parseLines(await readRange(path, 0, Math.min(length, size)), 0, 0);
    const prompt = taskPrompt(records, toolUseId);
    if (prompt || length >= size) return { records, end, prompt };
  }
}

/** The transcript's whole lines back from its end as far as its last reply of the model, not before `start`. */
async function tail(path: string, start: number, size: number): Promise<TranscriptRecord[]> {
  for (let length = END_BYTES; ; length *= 2) {
    const from = Math.max(start, size - length);
    const bytes = await readRange(path, from, size);
    const first = from === start ? 0 : bytes.indexOf(0x0a) + 1;
    if (first === 0 && from > start) continue;
    const { records } = parseLines(bytes, from, first);
    if (from === start || records.some(modelReply)) return records;
  }
}

/**
 * The session's sub-agent `agentId`. Its thread's header reads as its whole transcript's: what the first records set
 * (its directory, start, prompt) comes from the start, what the last ones do (its model, effort, last change) from the end.
 */
export async function readSubagent(sessionDirectory: string, agentId: string, spawningThreadId: string): Promise<Subagent> {
  const base = join(sessionDirectory, "subagents", `agent-${agentId}`);
  const meta = JSON.parse(await readFile(`${base}.meta.json`, "utf8")) as SubagentMeta;
  const path = `${base}.jsonl`;
  const { size } = await stat(path);
  const start = await head(path, size, meta.toolUseId);
  const records = [...start.records, ...await tail(path, start.end, size)].map(asVisibleSidechain);
  const prompt = start.prompt!.uuid;
  const summarizer = new TranscriptSummarizer(undefined, prompt);
  for (const record of records) summarizer.accept(record);
  const model = records.findLast(modelReply)?.message.model ?? meta.model ?? "Claude";
  const description = meta.description.replace(/\s+/gu, " ").trim();
  return {
    agentId,
    running: lastTurnRuns(records, prompt),
    source: {
      sessionId: `agent-${agentId}`, path, header: summarizer.header(), peers: NO_PEERS.directory, peersVersion: "",
      subagent: {
        parentThreadId: meta.parentAgentId ? `agent-${meta.parentAgentId}` : spawningThreadId,
        promptRecordUuid: prompt, nickname: `${description} [${claudeModelLabel(model)}]`, depth: meta.spawnDepth,
      },
    },
  };
}

/** The session's sub-agents, parents first. */
export async function listSubagents(sessionDirectory: string, spawningThreadId: string): Promise<Subagent[]> {
  const names = await readdir(join(sessionDirectory, "subagents"));
  const subagents = await Promise.all(names.flatMap((name) => /^agent-(.+)\.meta\.json$/u.exec(name)?.[1] ?? [])
    .map((agentId) => readSubagent(sessionDirectory, agentId, spawningThreadId)));
  return subagents.sort((left, right) => left.source.subagent.depth - right.source.subagent.depth || left.agentId.localeCompare(right.agentId));
}
