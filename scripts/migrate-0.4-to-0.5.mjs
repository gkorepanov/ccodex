#!/usr/bin/env node
// One-off migration of CCodex 0.4 state (state.sqlite + handoffs.sqlite) to 0.5's meta.json. `ccodex setup` runs it
// once, before it activates 0.5 (0.4's state.sqlite is there, meta.json is not). `--dry-run` only prints what it would do.
//
// - Every 0.4 Claude thread keeps its id: meta.lineages[<0.4 id>] = [{ claude, <session id> }].
// - Provider-switch lineages become segment lists; forks whose 0.4 id was no backend move to their current backend.
// - Archive flags, sections and section order of Claude threads carry over; names go into the transcripts.
// - Claude threads whose transcript Claude's cleanup deleted (cleanupPeriodDays, 30 by default) get one back from the
//   0.4 turns: prompts and answers as text, without tool calls, reasoning or compactions. Claude resumes it as such.
// - A lineage is archived when its current backend was (0.4 archived sealed stock backends to hide them); 0.5 reads
//   the flag from the row's backend, so that one is set to match, stock ones through `codex app-server`.
// SQLite files are only read. meta.json is backed up before it is replaced.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { startsTurn } from "../dist/claude/native/summary.js";
import { codexHome, loadConfig } from "../dist/config.js";

const dryRun = process.argv.includes("--dry-run");
const home = process.env.CCODEX_HOME ?? join(homedir(), ".ccodex");
const stateDir = process.env.CCODEX_DATA_DIR ?? join(home, "state");
const claudeProjects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
const metaPath = join(stateDir, "meta.json");
const log = (...args) => console.log(...args);

const state = new DatabaseSync(join(stateDir, "state.sqlite"), { readOnly: true });
const handoffsPath = join(stateDir, "handoffs.sqlite");
const handoffs = existsSync(handoffsPath) ? new DatabaseSync(handoffsPath, { readOnly: true }) : undefined;
const stockDb = readdirSync(codexHome()).filter((file) => /^state_\d+\.sqlite$/.test(file)).sort().at(-1);
const stock = new DatabaseSync(join(codexHome(), stockDb), { readOnly: true });

// Claude transcripts by session id.
const transcripts = new Map();
for (const directory of existsSync(claudeProjects) ? readdirSync(claudeProjects) : []) {
  for (const file of readdirSync(join(claudeProjects, directory))) {
    if (file.endsWith(".jsonl")) transcripts.set(file.slice(0, -6), join(claudeProjects, directory, file));
  }
}
/** Restored transcripts (session id → content), written after the dry-run exit. */
const restored = new Map();
const records = (sessionId) => (restored.get(sessionId)?.content ?? readFileSync(transcripts.get(sessionId), "utf8")).split("\n").flatMap((line) => {
  try { return line ? [JSON.parse(line)] : []; } catch { return []; }
});

const claudeThreads = new Map(state.prepare(`select id, claude_session_id, archived, deletion_pending, updated_at,
  json_extract(thread_json, '$.parentThreadId') parent, json_extract(thread_json, '$.name') name,
  json_extract(thread_json, '$.section') section, json_extract(thread_json, '$.sectionEnteredAt') section_entered_at
  from threads`).all().map((row) => [row.id, row]));

// A turn's last record takes the uuid 0.4 kept for it, so provider-switch segments still end at that turn.
for (const thread of state.prepare(`select id, claude_session_id, cwd, claude_code_version, coalesce(resolved_model, claude_model_value) model
  from threads where claude_session_id is not null and deletion_pending = 0
  and json_extract(thread_json, '$.parentThreadId') is null`).all()) {
  const sessionId = thread.claude_session_id;
  if (transcripts.has(sessionId)) continue;
  const lines = [];
  let parentUuid = null;
  let at = 0;
  const add = (record, seconds) => {
    const uuid = randomUUID();
    at = seconds;
    lines.push({ parentUuid, isSidechain: false, userType: "external", cwd: thread.cwd, sessionId, version: thread.claude_code_version ?? "2.1.209",
      ...record, uuid, timestamp: new Date(seconds * 1_000).toISOString() });
    parentUuid = uuid;
  };
  for (const row of state.prepare("select turn_json, last_claude_message_uuid last from turns where thread_id = ? order by ordinal").all(thread.id)) {
    const turn = JSON.parse(row.turn_json);
    const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
    const start = lines.length;
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        add({ type: "user", message: { role: "user", content: item.content.map((part) => part.text).join("\n") } }, turn.startedAt);
      } else if (item.type === "agentMessage" && item.text) {
        add({ type: "assistant", message: { id: messageId, type: "message", role: "assistant", model: thread.model,
          content: [{ type: "text", text: item.text }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } } }, turn.completedAt ?? turn.startedAt);
      }
    }
    if (row.last && lines.length > start && !lines.some((line) => line.uuid === row.last)) parentUuid = lines.at(-1).uuid = row.last;
  }
  if (!lines.length) continue;
  const path = join(claudeProjects, thread.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  restored.set(sessionId, { content: lines.map((line) => `${JSON.stringify(line)}\n`).join(""), at });
  transcripts.set(sessionId, path);
}

/** 0.4 Claude turn id → 0.5 turn id (the uuid of the prompt that starts the turn in the transcript). */
function claudeTurnId(threadId, turnId) {
  const row = state.prepare("select last_claude_message_uuid uuid from turns where thread_id = ? and id = ?").get(threadId, turnId);
  const sessionId = claudeThreads.get(threadId)?.claude_session_id;
  if (!row?.uuid || !transcripts.has(sessionId)) return null;
  const all = records(sessionId);
  const at = all.findIndex((record) => record.uuid === row.uuid);
  for (let index = at; index >= 0; index -= 1) {
    if (all[index].type === "user" && startsTurn(all[index])) return all[index].uuid;
  }
  return null;
}

const lineages = {};
const lineageBackends = new Set();
let skipped = 0;
if (handoffs) {
  const epochs = new Map(handoffs.prepare("select * from lineage_epochs").all().map((row) => [row.epoch_id, row]));
  for (const task of handoffs.prepare("select * from lineage_tasks").all()) {
    const closed = handoffs.prepare("select epoch_id, end_turn_id from lineage_segments where public_thread_id = ? and kind = 'provider' order by position")
      .all(task.public_thread_id);
    const current = epochs.get(task.current_epoch_id);
    if (current.backend_thread_id.startsWith("ccodex-provisional:")) {
      log(`skip ${task.public_thread_id}: its current segment was never started`);
      skipped += 1;
      continue;
    }
    const parts = [...closed.map((segment) => ({ epoch: epochs.get(segment.epoch_id), end: segment.end_turn_id })), { epoch: current, end: null }]
      .filter(({ epoch }, index, all) => !epoch.backend_thread_id.startsWith("ccodex-provisional:") && all.findIndex((other) => other.epoch === epoch) === index);
    const segments = parts.map(({ epoch, end }, index) => {
      lineageBackends.add(epoch.backend_thread_id);
      const last = index === parts.length - 1;
      if (epoch.provider === "stock") return { provider: "codex", threadId: epoch.backend_thread_id, lastTurnId: last ? null : end };
      return {
        provider: "claude",
        threadId: claudeThreads.get(epoch.backend_thread_id)?.claude_session_id ?? epoch.backend_thread_id,
        lastTurnId: last || !end ? null : claudeTurnId(epoch.backend_thread_id, end),
      };
    });
    // 0.5 names a fork by its current backend; a lineage started from a thread keeps that thread's id.
    // Stock never lists threads without a user message of their own (0.4 made such forks); those take the current id.
    const unlisted = segments[0].provider === "codex"
      && stock.prepare("select first_user_message from threads where id = ?").get(segments[0].threadId)?.first_user_message === "";
    const publicId = parts[0].epoch.backend_thread_id === task.public_thread_id && !unlisted ? task.public_thread_id : segments.at(-1).threadId;
    if (publicId !== task.public_thread_id) log(`${unlisted ? "unlisted" : "fork"} ${task.public_thread_id} is now ${publicId}`);
    if (segments.length === 1 && segments[0].threadId === publicId) continue;
    lineages[publicId] = segments;
  }
}

const archived = new Set();
const sections = {};
const named = [];
for (const thread of claudeThreads.values()) {
  const sessionId = thread.claude_session_id;
  if (thread.deletion_pending || thread.parent || !transcripts.has(sessionId)) continue;
  if (!lineages[thread.id] && !lineageBackends.has(thread.id) && thread.id !== sessionId) {
    lineages[thread.id] = [{ provider: "claude", threadId: sessionId, lastTurnId: null }];
  }
  if (thread.archived) archived.add(sessionId);
  if (thread.section) sections[sessionId] = { sectionId: JSON.parse(thread.section).id, enteredAt: thread.section_entered_at ?? thread.updated_at };
  if (thread.name) {
    const titles = records(sessionId).filter((record) => record.type === "custom-title");
    if (titles.at(-1)?.customTitle !== thread.name) named.push({ sessionId, name: thread.name });
  }
}

// 0.4 hid every stock backend of a lineage; one left out of all 0.5 lineages (a switch never kept) stays out of sight archived.
const stockArchives = [];
for (const { backend_thread_id: id } of handoffs?.prepare("select backend_thread_id from lineage_epochs where provider = 'stock'").all() ?? []) {
  if (lineageBackends.has(id) || lineages[id] || stock.prepare("select archived from threads where id = ?").get(id)?.archived !== 0) continue;
  log(`archive ${id} (a stock backend 0.4 hid, in no lineage)`);
  stockArchives.push(["thread/archive", { threadId: id }]);
}

const archived04 = new Set([...claudeThreads.values()].filter((thread) => thread.archived).map((thread) => thread.claude_session_id));
for (const [publicId, segments] of Object.entries(lineages)) {
  const row = segments.find((segment) => segment.threadId === publicId) ?? segments[0];
  const isArchived = (segment) => segment.provider === "codex"
    ? stock.prepare("select archived from threads where id = ?").get(segment.threadId)?.archived === 1
    : archived04.has(segment.threadId);
  const wanted = isArchived(segments.at(-1));
  if (isArchived(row) === wanted) continue;
  log(`${wanted ? "archive" : "unarchive"} ${publicId} (its current backend is${wanted ? "" : " not"} archived)`);
  if (row.provider === "codex") stockArchives.push([wanted ? "thread/archive" : "thread/unarchive", { threadId: row.threadId }]);
  else if (wanted) archived.add(row.threadId);
  else archived.delete(row.threadId);
}

/** Runs requests on a stdio `codex app-server` of the installed codex. */
async function stockRequests(requests) {
  const child = spawn(loadConfig().codex, ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  let next = 0;
  const request = (method, params) => new Promise((resolve) => {
    next += 1;
    pending.set(next, resolve);
    child.stdin.write(`${JSON.stringify({ id: next, method, params })}\n`);
  });
  await request("initialize", { clientInfo: { name: "ccodex_migration", title: "CCodex migration", version: "0.5.0" } });
  child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  for (const [method, params] of requests) {
    const { error } = await request(method, params);
    if (error) log(`${method} ${params.threadId} failed: ${error.message}`);
  }
  child.kill();
}

/** A 0.4 id as 0.5 lists it (the row's backend). */
function rowId(id) {
  const segments = lineages[id];
  if (segments) return (segments.find((segment) => segment.threadId === id) ?? segments[0]).threadId;
  return claudeThreads.get(id)?.claude_session_id ?? id;
}
const sectionOrder = Object.fromEntries(state.prepare("select section_id, order_json from section_orders").all()
  .map((row) => [row.section_id, JSON.parse(row.order_json).map(rowId)]));

const existing = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
const meta = {
  lineages: { ...lineages, ...existing.lineages },
  archived: [...new Set([...archived, ...(existing.archived ?? [])])],
  sections: { ...sections, ...existing.sections },
  sectionOrder: { ...sectionOrder, ...existing.sectionOrder },
  leaves: existing.leaves ?? {},
};

const aliases = Object.values(lineages).filter((segments) => segments.length === 1).length;
log(`lineages: ${Object.keys(lineages).length} (${aliases} kept 0.4 Claude ids, ${Object.keys(lineages).length - aliases} provider switches), skipped ${skipped}`);
log(`restored transcripts: ${restored.size}`);
log(`archived: ${archived.size}, stock archive changes: ${stockArchives.length}, in sections: ${Object.keys(sections).length}, section orders: ${Object.keys(sectionOrder).length}, names to write: ${named.length}`);
if (dryRun) {
  log("dry run: nothing written");
  process.exit(0);
}
for (const [sessionId, { content }] of restored) {
  mkdirSync(dirname(transcripts.get(sessionId)), { recursive: true });
  writeFileSync(transcripts.get(sessionId), content, { mode: 0o600 });
}
if (existsSync(metaPath)) copyFileSync(metaPath, `${metaPath}.pre-migration-${Date.now()}`);
writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
await stockRequests(stockArchives);
for (const { sessionId, name } of named) {
  appendFileSync(transcripts.get(sessionId), `${JSON.stringify({ type: "custom-title", customTitle: name, sessionId })}\n`);
}
// Claude lists sessions by their file's time: a restored one keeps its place.
for (const [sessionId, { at }] of restored) utimesSync(transcripts.get(sessionId), at, at);
log(`wrote ${metaPath}. Restart the gateway: codex app-server daemon restart`);
