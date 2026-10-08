// Scripted stand-in for the Claude Agent SDK `query()`: answers each pushed message, streams like the real CLI and
// persists the same transcript records under $CLAUDE_CONFIG_DIR/projects, so the native catalog/projector read it.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type Message = Record<string, any>;

export interface FakeClaudeLog {
  readonly prompts: Array<{ sessionId: string; uuid: string; text: string; shouldQuery: boolean }>;
  readonly options: Message[];
  readonly calls: Array<{ method: string; args: unknown[] }>;
}

export const fakeClaude: FakeClaudeLog & { reset(): void; reply: (text: string) => string; spawnError: string | null; compactError: string | null; hold: Promise<void> | null; goalHold: Promise<void> | null; backgroundMs: number; modelsHold: Promise<void> | null; refusedModel: string | null; usageDown: boolean; fastOff: boolean } = {
  prompts: [],
  options: [],
  calls: [],
  reply: (text) => `claude: ${text}`,
  /** Set: the CLI process fails to start (like `spawn … EAGAIN` when the machine is out of processes). */
  spawnError: null,
  /** Set: `/compact` fails, as Claude reports it (`Error during compaction: …`). */
  compactError: null,
  /** Set: an injection (no model reply) is confirmed only once it settles, its record already on disk. */
  hold: null,
  /** Set: Claude takes a `/goal` (and records it) only once it settles. */
  goalHold: null,
  /** How long a background command runs after Claude's answer. */
  backgroundMs: 500,
  /** Set: the models probe answers only once it settles. */
  modelsHold: null,
  /** Set: Claude lists this model but refuses to switch to it (the account or organization may not use it). */
  refusedModel: null,
  /** Set: claude.ai's usage endpoint fails, Claude's `/usage` data has no windows. */
  usageDown: false,
  /** Set: fast mode is off for the account (no usage credits). */
  fastOff: false,
  reset() {
    this.prompts.length = 0;
    this.options.length = 0;
    this.calls.length = 0;
    this.reply = (text) => `claude: ${text}`;
    this.spawnError = null;
    this.compactError = null;
    this.hold = null;
    this.goalHold = null;
    this.backgroundMs = 500;
    this.modelsHold = null;
    this.refusedModel = null;
    this.usageDown = false;
    this.fastOff = false;
    stopEarly = false;
  },
};

const MODELS = [
  { value: "default", displayName: "Default (recommended)", description: "Opus", resolvedModel: "claude-opus-5-5" },
  { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "Opus", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsFastMode: true },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Haiku" },
];

const textOf = (content: unknown) => typeof content === "string"
  ? content
  : (content as Message[]).flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");

class Transcript {
  public last: string | null = null;
  public readonly path: string;
  /** The chat's title as this process holds it: read when it starts, then only from the transcript's final 64 KB. */
  public title?: string;
  private sinceMetadata = 0;

  public constructor(private readonly sessionId: string, public cwd: string, path?: string) {
    const directory = join(process.env.CLAUDE_CONFIG_DIR!, "projects", cwd.replace(/[^a-zA-Z0-9]/gu, "-"));
    mkdirSync(directory, { recursive: true });
    this.path = path ?? join(directory, `${sessionId}.jsonl`);
    // A resumed session continues the chain.
    if (!existsSync(this.path)) return;
    const records = readFileSync(this.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    this.last = records.findLast((record) => record.uuid)?.uuid;
    this.title = records.findLast((record) => record.type === "custom-title")?.customTitle;
  }

  public write(record: Message, chain = true): string {
    const uuid = record.uuid ?? randomUUID();
    const line = `${JSON.stringify({
      parentUuid: chain ? this.last : null, isSidechain: false, sessionId: this.sessionId, cwd: this.cwd,
      version: "2.1.280", gitBranch: "main", timestamp: new Date().toISOString(), ...record, uuid,
    })}\n`;
    appendFileSync(this.path, line);
    this.last = uuid;
    this.sinceMetadata += line.length;
    if (this.sinceMetadata >= 32_768) this.writeMetadata();
    return uuid;
  }

  public rename(title: string): void {
    this.title = title;
    appendFileSync(this.path, `${JSON.stringify({ type: "custom-title", customTitle: title, sessionId: this.sessionId })}\n`);
  }

  /** Like Claude every 32 KB of records: its title again, the last one in the transcript's final 64 KB if there is one. */
  private writeMetadata(): void {
    this.sinceMetadata = 0;
    const file = readFileSync(this.path);
    const lines = file.subarray(-65_536).toString("utf8").split("\n");
    if (file.length > 65_536) lines.shift();
    const named = lines.findLast((line) => line.includes("\"type\":\"custom-title\""));
    if (named) this.title = JSON.parse(named).customTitle;
    if (this.title) this.rename(this.title);
  }

  /** Claude compacts only a session with a message of the user's since its last compaction. */
  public humanSinceCompaction(): boolean {
    if (!existsSync(this.path)) return false;
    const records = readFileSync(this.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    return records.slice(records.findLastIndex((record) => record.isCompactSummary) + 1).some((record) => record.origin?.kind === "human");
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Ends the command Claude waits on (an interrupt does); `backgrounded`: sent to the background (Ctrl+B) first. */
let stopCommand: (() => void) | undefined;
let backgrounded = false;
/** Ends the goal Claude is pursuing (an interrupt does). */
let stopGoal: (() => void) | undefined;
/** An interrupt that came before the goal it stops started (Claude drops the command it had yet to run). */
let stopEarly = false;

/** Codex answering an MCP call: it journals the turn under $CODEX_HOME/sessions like `codex mcp-server`. */
function codexJournal(prompt: string): string {
  const threadId = randomUUID();
  const directory = join(process.env.CODEX_HOME!, "sessions", "2026", "09", "23");
  mkdirSync(directory, { recursive: true });
  const event = (payload: Message) => `${JSON.stringify({ type: "event_msg", payload })}\n`;
  writeFileSync(join(directory, `rollout-2026-09-23T00-00-00-${threadId}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { id: threadId, timestamp: new Date().toISOString(), source: "mcp" } })}\n`
    + event({ type: "task_started" })
    + `${JSON.stringify({ type: "turn_context", payload: { cwd: "/work", model: "gpt-6-sol", effort: "high", summary: "none" } })}\n`
    + event({ type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: prompt }] } })
    + event({ type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: `codex says: ${prompt}` }] } })
    + event({ type: "task_complete" }));
  return threadId;
}

/** A `mcp__codex__codex` call as Claude makes it: tool use, the PreToolUse hook, codex working, the result. */
async function* codexCall(transcript: Transcript, sessionId: string, options: Message, prompt: string, agentId?: string): AsyncGenerator<Message> {
  const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
  const input = { prompt };
  const call = { type: "assistant", message: { id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: toolUseId, name: "mcp__codex__codex", input }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 1 } } };
  transcript.write({ ...call, apiBlockIndex: 0, ...(agentId ? { isSidechain: true, agentId } : {}) });
  if (!agentId) yield base(sessionId, call);
  for (const hook of options.hooks?.PreToolUse ?? []) {
    for (const run of hook.hooks) await run({ tool_name: "mcp__codex__codex", tool_input: input, tool_use_id: toolUseId, ...(agentId ? { agent_id: agentId } : {}) });
  }
  const threadId = codexJournal(prompt);
  await sleep(1_200);
  const content = [{ type: "tool_result", tool_use_id: toolUseId, content: JSON.stringify({ threadId, content: `codex says: ${prompt}` }) }];
  transcript.write({ type: "user", message: { role: "user", content }, ...(agentId ? { isSidechain: true, agentId } : {}) });
  if (!agentId) yield base(sessionId, { type: "user", message: { role: "user", content } });
}

function base(sessionId: string, extra: Message): Message {
  return { session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null, ...extra };
}

async function* answer(prompt: Message, options: Message, transcript: Transcript, sessionId: string): AsyncGenerator<Message> {
  const text = textOf(prompt.message.content);
  const uuid: string = prompt.uuid;
  fakeClaude.prompts.push({ sessionId, uuid, text, shouldQuery: prompt.shouldQuery !== false });
  yield base(sessionId, { type: "system", subtype: "session_state_changed", state: "running" });
  yield base(sessionId, { type: "command_lifecycle", state: "started", command_uuid: uuid });
  const finish = function* (result: string, subtype = "success"): Generator<Message> {
    // Like the CLI's after each API answer: no `utilization`, the plan windows in `unifiedWindows`.
    yield base(sessionId, { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1790539800, rateLimitType: "five_hour", isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1790539800 }, seven_day: { utilization: 0.06, resetsAt: 1791082800 } } } });
    // Like the CLI on an account without usage credits: fast asked for, answered at standard speed.
    const fast = options.settings?.fastMode ? { fast_mode_state: fakeClaude.fastOff ? "off" : "on", ...(fakeClaude.fastOff ? { fast_mode_disabled_reason: "extra_usage_disabled" } : {}) } : {};
    yield base(sessionId, { type: "result", subtype, is_error: false, result, total_cost_usd: 0.01, user_message_uuids: [uuid], modelUsage: { "claude-opus-5-5": { contextWindow: 200_000 } }, ...fast });
    yield base(sessionId, { type: "command_lifecycle", state: "completed", command_uuid: uuid });
    yield base(sessionId, { type: "system", subtype: "session_state_changed", state: "idle" });
  };
  if (prompt.shouldQuery === false) {
    transcript.write({ type: "user", uuid, message: { role: "user", content: text } });
    await fakeClaude.hold;
    yield* finish("");
    return;
  }
  // Like a `cd` Claude's Bash runs: the session's later records carry the new cwd.
  const cd = /^cd (\S+)$/u.exec(text);
  if (cd) transcript.cwd = cd[1]!;
  const command = /^\/(\w+)\s*([\s\S]*)$/u.exec(text);
  if (command?.[1] === "compact" && (!transcript.humanSinceCompaction() || fakeClaude.compactError)) {
    const output = fakeClaude.compactError ?? "Not enough messages to compact.";
    transcript.write({ type: "user", uuid, message: { role: "user", content: `<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>${command[2]}</command-args>` } });
    transcript.write({ type: "system", subtype: "local_command", content: `<local-command-stdout>${output}</local-command-stdout>` });
    yield base(sessionId, { type: "system", subtype: "local_command_output", content: output });
    yield* finish("");
    return;
  }
  if (command?.[1] === "compact") {
    const summary = `SUMMARY(${command[2] || "default"})`;
    const logical = transcript.last;
    const boundary = transcript.write({ type: "system", subtype: "compact_boundary", content: "Conversation compacted", logicalParentUuid: logical, compactMetadata: { trigger: "manual" } }, false);
    transcript.write({ type: "user", isCompactSummary: true, message: { role: "user", content: `This session is being continued... ${summary}` } });
    transcript.write({ type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" } });
    transcript.write({ type: "user", uuid, message: { role: "user", content: `<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>${command[2]}</command-args>` } });
    transcript.write({ type: "user", message: { role: "user", content: "<local-command-stdout>Compacted</local-command-stdout>" } });
    for (const hook of options.hooks?.PostCompact ?? []) for (const run of hook.hooks) await run({ compact_summary: summary });
    yield base(sessionId, { type: "system", subtype: "compact_boundary", uuid: boundary, compact_metadata: { trigger: "manual" } });
    yield* finish("");
    return;
  }
  if (command?.[1] === "goal") {
    // Like Claude: it pursues a goal in the same turn until it is met (these: until interrupted, from the start on; the
    // second is met just as the stop comes).
    const objective = command[2]!.trim();
    const pursued = objective === "keep going" || objective === "met when stopped";
    const stopped = new Promise<void>((resolve) => { stopGoal = resolve; });
    if (stopEarly) stopGoal!();
    stopEarly = false;
    await fakeClaude.goalHold;
    transcript.write({ type: "user", uuid, message: { role: "user", content: `<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>${command[2]}</command-args>` } });
    // Like Claude, a goal set is recorded a moment after the command (clearing is at once); stopped before, it is not set.
    if (objective !== "clear" && await Promise.race([sleep(100).then(() => false), stopped.then(() => true)])) {
      transcript.write({ type: "user", message: { role: "user", content: "[Request interrupted by user]" } });
      yield* finish("", "error_during_execution");
      return;
    }
    const output = command[2] === "clear" ? "Goal cleared" : `Goal set: ${command[2]}`;
    transcript.write({ type: "system", subtype: "local_command", content: `<local-command-stdout>${output}</local-command-stdout>`, commandRun: { command: "goal", args: command[2] } });
    // Like Claude, its word on the command comes as a reply of its own.
    yield base(sessionId, {
      type: "assistant", message: { id: randomUUID(), role: "assistant", model: "<synthetic>", content: [{ type: "text", text: output }] },
      parent_tool_use_id: null, local_command_run: { command: "goal", args: command[2] },
    });
    if (!pursued) stopGoal = undefined;
    if (pursued) {
      await stopped;
      transcript.write(objective === "keep going" ? { type: "user", message: { role: "user", content: "[Request interrupted by user]" } }
        : { type: "attachment", attachment: { type: "goal_status", met: true, condition: objective } });
      yield* finish("", "error_during_execution");
      return;
    }
    yield* finish("");
    return;
  }
  transcript.write({ type: "user", uuid, origin: { kind: "human" }, promptId: randomUUID(), permissionMode: options.permissionMode, message: { role: "user", content: prompt.message.content } });
  let reply = fakeClaude.reply(text);
  // Like the CLI: a turn records the model it ran on, and plan mode runs a Haiku chat on Sonnet ("haiku plan upgrade").
  const model = String(options.model).includes("haiku") ? options.permissionMode === "plan" ? "claude-sonnet-5" : "claude-haiku-4-5-20251001" : "claude-opus-5-5";
  const tool = (messageId: string, index: number, name: string, input: Message): Message => ({ type: "assistant", message: { id: messageId, role: "assistant", model, content: [{ type: "tool_use", id: `toolu_${randomUUID().slice(0, 8)}`, name, input }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 1 } }, apiBlockIndex: index });
  const toolResult = function* (call: Message, output: string, result: Message = { stdout: output, stderr: "" }): Generator<Message> {
    const content = [{ type: "tool_result", tool_use_id: call.message.content[0].id, content: output }];
    transcript.write({ type: "user", message: { role: "user", content }, toolUseResult: result });
    yield base(sessionId, { type: "user", message: { role: "user", content }, tool_use_result: result });
  };
  // Like Claude: a long message, then more work in the same response.
  const report = /^report at length: (.+)$/u.exec(text);
  if (report) {
    const messageId = `msg_${randomUUID().slice(0, 8)}`;
    const long = `${report[1]}: ${"all checks passed. ".repeat(50)}`;
    yield base(sessionId, { type: "stream_event", event: { type: "message_start", message: { id: messageId } } });
    yield base(sessionId, { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    yield base(sessionId, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: long } } });
    const said = { type: "assistant", message: { id: messageId, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: long }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 3 } }, apiBlockIndex: 0 };
    transcript.write(said);
    yield base(sessionId, said);
    const call = tool(messageId, 1, "Bash", { command: "true" });
    yield base(sessionId, { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: call.message.content[0].id, name: "Bash", input: {} } } });
    transcript.write(call);
    yield base(sessionId, call);
    yield base(sessionId, { type: "stream_event", event: { type: "message_stop" } });
    yield* toolResult(call, "");
    reply = "checked";
  }
  // Like Claude: a command in the background, whose end wakes Claude up after its answer (`fakeClaude.backgroundMs` later),
  // or which Claude stops itself (TaskStop).
  const background = /^watch in background: (.+)$/u.exec(text) ?? /^stop in background: (.+)$/u.exec(text);
  if (background) {
    const call = tool(`msg_${randomUUID().slice(0, 8)}`, 0, "Bash", { command: background[1], run_in_background: true });
    transcript.write(call);
    yield base(sessionId, call);
    yield base(sessionId, { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: call.message.content[0].id, description: background[1], task_type: "local_bash" });
    yield* toolResult(call, "Command running in background with ID: bg1", { stdout: "", stderr: "", backgroundTaskId: "bg1" });
    reply = "watching";
  }
  const stopped = background && text.startsWith("stop in background:");
  if (stopped) {
    const call = tool(`msg_${randomUUID().slice(0, 8)}`, 0, "TaskStop", { task_id: "bg1" });
    transcript.write(call);
    yield base(sessionId, call);
    yield base(sessionId, { type: "system", subtype: "background_tasks_changed", tasks: [] });
    const message = `Successfully stopped task: bg1 (${background[1]})`;
    yield* toolResult(call, JSON.stringify({ message }), { message, task_id: "bg1", task_type: "local_bash", command: background[1] });
    reply = "stopped";
  }
  // Like Claude: a command it waits on, with output in its task's file. Stop kills it: Claude refuses the call and
  // queues (never sends) a notification naming no file; only a command sent to the background first keeps its file.
  const waited = /^run until stopped: (.+)$/u.exec(text);
  if (waited) {
    const call = tool(`msg_${randomUUID().slice(0, 8)}`, 0, "Bash", { command: waited[1], timeout: 600000 });
    const toolUseId = call.message.content[0].id;
    transcript.write(call);
    yield base(sessionId, call);
    yield base(sessionId, { type: "system", subtype: "task_started", task_id: "fg1", tool_use_id: toolUseId, description: waited[1], task_type: "local_bash", is_backgrounded: false });
    const file = join(tmpdir(), `claude-${process.getuid!()}`, (options.cwd ?? process.cwd()).replace(/[^a-zA-Z0-9]/gu, "-"), sessionId, "tasks", "fg1.output");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "tick 1\ntick 2\n");
    backgrounded = false;
    await new Promise<void>((resolve) => { stopCommand = resolve; });
    stopCommand = undefined;
    yield base(sessionId, { type: "system", subtype: "task_notification", task_id: "fg1", tool_use_id: toolUseId, status: "stopped", output_file: backgrounded ? file : "", summary: waited[1] });
    appendFileSync(transcript.path, `${JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), sessionId,
      content: `<task-notification>\n<task-id>fg1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>killed</status>\n<summary>Task "${waited[1]}" was stopped by the user</summary>\n</task-notification>` })}\n`);
    if (!backgrounded) rmSync(file);
    const content = [{ type: "tool_result", tool_use_id: toolUseId, content: "The user doesn't want to proceed with this tool use. The tool use was rejected.", is_error: true }];
    transcript.write({ type: "user", message: { role: "user", content }, toolUseResult: "User rejected tool use" });
    yield base(sessionId, { type: "user", message: { role: "user", content }, tool_use_result: "User rejected tool use" });
    transcript.write({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
    yield* finish("", "error_during_execution");
    return;
  }
  // Like Claude Code (0.3.283+): banners raised during a turn, at their render level.
  if (text === "banners") {
    for (const [level, content] of [["info", "transcript-only detail"], ["warning", "a warning"]]) yield base(sessionId, { type: "system", subtype: "informational", level, content });
  }
  const fileTool = text.includes("needs file approval");
  if (text.includes("needs approval") || fileTool) {
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
    const [name, input] = fileTool ? ["Write", { file_path: "notes.txt", content: "fruit=kiwi\n" }] : ["Bash", { command: "touch /tmp/approved" }];
    const messageId = `msg_${randomUUID().slice(0, 8)}`;
    const tool = { type: "assistant", message: { id: messageId, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: toolUseId, name, input }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 1 } } };
    transcript.write({ ...tool, apiBlockIndex: 0 });
    yield base(sessionId, tool);
    // Like the CLI: auto mode and bypass decide without asking.
    const decision = ["auto", "bypassPermissions"].includes(options.permissionMode) ? { behavior: "allow" }
      : await options.canUseTool(name, input, { toolUseID: toolUseId, signal: new AbortController().signal, suggestions: [] });
    const result = decision.behavior === "allow" ? "done" : `denied: ${decision.message}`;
    transcript.write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: result }] }, toolUseResult: { stdout: result, stderr: "" } });
    yield base(sessionId, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: result }] }, tool_use_result: { stdout: result, stderr: "" } });
    reply = `approval ${decision.behavior}`;
  }
  const question = /^ask me: (.+\?) (.+)$/u.exec(text);
  if (question) {
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
    const input = { questions: [{ question: question[1]!, header: "Pick", options: question[2]!.split("|").map((label) => ({ label, description: `${label} option` })), multiSelect: false }] };
    const tool = { type: "assistant", message: { id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 1 } } };
    transcript.write({ ...tool, apiBlockIndex: 0 });
    yield base(sessionId, tool);
    const decision = await options.canUseTool("AskUserQuestion", input, { toolUseID: toolUseId, signal: new AbortController().signal, suggestions: [] });
    const answer = decision.updatedInput.answers[question[1]!];
    const content = [{ type: "tool_result", tool_use_id: toolUseId, content: `User has answered your questions: "${question[1]}"="${answer}".` }];
    transcript.write({ type: "user", message: { role: "user", content }, toolUseResult: { questions: input.questions, answers: decision.updatedInput.answers } });
    yield base(sessionId, { type: "user", message: { role: "user", content } });
    reply = `you picked ${answer}`;
  }
  const proposed = /^propose a plan: (.+)$/u.exec(text);
  if (proposed) {
    // Like the CLI: leaving plan mode asks for permission; allowed, the chat goes back to the mode it had before.
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
    const input = { plan: proposed[1]!, planFilePath: "/home/fake/.claude/plans/plan.md" };
    const tool = { type: "assistant", message: { id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", model, content: [{ type: "tool_use", id: toolUseId, name: "ExitPlanMode", input }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 1 } } };
    transcript.write({ ...tool, apiBlockIndex: 0 });
    yield base(sessionId, tool);
    const decision = await options.canUseTool("ExitPlanMode", input, { toolUseID: toolUseId, signal: new AbortController().signal, suggestions: [] });
    const allowed = decision.behavior === "allow";
    if (allowed) options.permissionMode = "default";
    const output = allowed ? "User has approved your plan. You can now start coding." : decision.message;
    const content = [{ type: "tool_result", tool_use_id: toolUseId, content: output, ...(allowed ? {} : { is_error: true }) }];
    transcript.write({ type: "user", message: { role: "user", content }, toolUseResult: allowed ? { plan: input.plan, isAgent: false } : `Error: ${output}` });
    yield base(sessionId, { type: "user", message: { role: "user", content } });
    reply = "Plan is ready for your review.";
  }
  const tracked = /^track tasks: (.+)$/u.exec(text);
  if (tracked) {
    const call = async function* (name: string, input: Message, result: Message, output: string): AsyncGenerator<Message> {
      const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
      const tool = { type: "assistant", message: { id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: toolUseId, name, input }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 1 } } };
      transcript.write({ ...tool, apiBlockIndex: 0 });
      yield base(sessionId, tool);
      const content = [{ type: "tool_result", tool_use_id: toolUseId, content: output }];
      transcript.write({ type: "user", message: { role: "user", content }, toolUseResult: result });
      yield base(sessionId, { type: "user", message: { role: "user", content }, tool_use_result: result });
    };
    // Like Claude Code's task tools: TaskCreate hands out ids, TaskUpdate changes a task by id.
    const subjects = tracked[1]!.split("|");
    for (const [index, subject] of subjects.entries()) {
      yield* call("TaskCreate", { subject, description: subject }, { task: { id: String(index + 1), subject } }, `Task #${index + 1} created successfully: ${subject}`);
    }
    yield* call("TaskUpdate", { taskId: "1", status: "in_progress" }, { success: true, taskId: "1" }, "Updated task #1 status");
    yield* call("TaskUpdate", { taskId: "1", status: "completed", subject: `${subjects[0]} (done)` }, { success: true, taskId: "1" }, "Updated task #1 status");
    yield* call("TaskUpdate", { taskId: "2", status: "deleted" }, { success: true, taskId: "2" }, "Updated task #2 status");
  }
  const asked = /^ask codex: (.+)$/u.exec(text);
  if (asked) yield* codexCall(transcript, sessionId, options, asked[1]!);
  const delegated = /^ask a codex sub-agent: (.+)$/u.exec(text);
  if (delegated) {
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
    const agentId = "c0d3c0d3";
    const spawn = { type: "assistant", message: { id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: { description: "Codex helper", prompt: delegated[1], subagent_type: "codex-wrapper" } }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 1 } } };
    transcript.write({ ...spawn, apiBlockIndex: 0 });
    yield base(sessionId, spawn);
    const launched = { isAsync: true, status: "async_launched", agentId, description: "Codex helper", resolvedModel: "claude-sonnet-5", prompt: delegated[1] };
    const content = [{ type: "tool_result", tool_use_id: toolUseId, content: "Async agent launched" }];
    transcript.write({ type: "user", message: { role: "user", content }, toolUseResult: launched });
    yield base(sessionId, { type: "user", message: { role: "user", content }, tool_use_result: launched });
    await sleep(300);
    const directory = transcript.path.replace(/\.jsonl$/u, "/subagents");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "codex-wrapper", description: "Codex helper", toolUseId, spawnDepth: 1 }));
    const child = new Transcript(sessionId, options.cwd ?? process.cwd(), join(directory, `agent-${agentId}.jsonl`));
    child.write({ type: "user", isSidechain: true, agentId, message: { role: "user", content: delegated[1] } });
    yield* codexCall(child, sessionId, options, delegated[1]!, agentId);
    // Claude writes the sub-agent's last records a moment after its task settles.
    yield base(sessionId, { type: "system", subtype: "task_notification", task_id: agentId, tool_use_id: toolUseId, status: "completed", output_file: "", summary: "Codex helper" });
    await sleep(500);
    child.write({ type: "assistant", isSidechain: true, agentId, apiBlockIndex: 0, message: { id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "Codex is done" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } } });
  }
  if (text.includes("spawn a sub-agent")) {
    // Claude writes the child's transcript only after the spawn's result: here it never does.
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
    const input = { description: "Helper", prompt: "Reply SUB-OK", subagent_type: "general-purpose" };
    const spawn = { type: "assistant", message: { id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: toolUseId, name: "Agent", input }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 1 } } };
    transcript.write({ ...spawn, apiBlockIndex: 0 });
    yield base(sessionId, spawn);
    const launched = { isAsync: true, status: "async_launched", agentId: "a1b2c3", description: "Helper", resolvedModel: "claude-haiku-4-5-20251001", prompt: "Reply SUB-OK" };
    const content = [{ type: "tool_result", tool_use_id: toolUseId, content: "Async agent launched" }];
    transcript.write({ type: "user", message: { role: "user", content }, toolUseResult: launched });
    yield base(sessionId, { type: "user", message: { role: "user", content }, tool_use_result: launched });
    yield base(sessionId, { type: "system", subtype: "task_notification", task_id: "a1b2c3", tool_use_id: toolUseId, status: "completed", output_file: "", summary: "Helper" });
  }
  if (text.includes("run a foreground sub-agent")) {
    // A foreground sub-agent runs to its end inside the spawn: its result comes after its task settled.
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
    const agentId = "f0f0f0";
    const input = { description: "Echo", prompt: "Reply SUB-OK", subagent_type: "general-purpose" };
    const spawn = { type: "assistant", message: { id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: toolUseId, name: "Agent", input }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 1 } } };
    transcript.write({ ...spawn, apiBlockIndex: 0 });
    yield base(sessionId, spawn);
    const directory = transcript.path.replace(/\.jsonl$/u, "/subagents");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", description: "Echo", toolUseId, spawnDepth: 1 }));
    const child = new Transcript(sessionId, options.cwd ?? process.cwd(), join(directory, `agent-${agentId}.jsonl`));
    child.write({ type: "user", isSidechain: true, agentId, message: { role: "user", content: "Reply SUB-OK" } });
    // Claude writes the sub-agent's last records a moment after its task settles.
    setTimeout(() => child.write({ type: "assistant", isSidechain: true, agentId, apiBlockIndex: 0, effort: "high", message: { id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "SUB-OK" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } } }), 300);
    yield base(sessionId, { type: "system", subtype: "task_notification", task_id: agentId, tool_use_id: toolUseId, status: "completed", output_file: "", summary: "Echo" });
    const finished = { status: "completed", agentId, agentType: "general-purpose", description: "Echo", resolvedModel: "claude-opus-5-5", prompt: "Reply SUB-OK", content: [{ type: "text", text: "SUB-OK" }] };
    const content = [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: "SUB-OK" }] }];
    transcript.write({ type: "user", message: { role: "user", content }, toolUseResult: finished });
    yield base(sessionId, { type: "user", message: { role: "user", content }, tool_use_result: finished });
  }
  if (text.includes("message the finished sub-agent")) {
    // The message resumes the foreground sub-agent's work: Claude runs it again as the same task.
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
    const agentId = "f0f0f0";
    const call = { type: "assistant", message: { id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: toolUseId, name: "SendMessage", input: { to: agentId, message: "Now reply AGAIN-OK" } }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 1 } } };
    transcript.write({ ...call, apiBlockIndex: 0 });
    yield base(sessionId, call);
    const child = new Transcript(sessionId, options.cwd ?? process.cwd(), transcript.path.replace(/\.jsonl$/u, `/subagents/agent-${agentId}.jsonl`));
    const message = "The coordinator sent a message while you were working:\nNow reply AGAIN-OK\n\nAddress this before completing your current task.";
    child.write({ type: "user", isSidechain: true, agentId, isMeta: true, origin: { kind: "coordinator" }, promptId: randomUUID(), message: { role: "user", content: message } });
    yield base(sessionId, { type: "system", subtype: "task_started", task_id: agentId, tool_use_id: toolUseId, task_type: "local_agent", description: "Echo" });
    const resumed = { success: true, message: `Resuming agent ${agentId}`, resumedAgentId: agentId, pin: { id: agentId, name: agentId, ref: "e70713" } };
    const content = [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: JSON.stringify(resumed) }] }];
    transcript.write({ type: "user", message: { role: "user", content }, toolUseResult: resumed });
    yield base(sessionId, { type: "user", message: { role: "user", content }, tool_use_result: resumed });
    setTimeout(() => child.write({ type: "assistant", isSidechain: true, agentId, apiBlockIndex: 0, effort: "high", message: { id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "AGAIN-OK" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } } }), 1500);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    yield base(sessionId, { type: "system", subtype: "task_notification", task_id: agentId, tool_use_id: toolUseId, status: "completed", output_file: "", summary: "Echo" });
  }
  const messageId = `msg_${randomUUID().slice(0, 8)}`;
  yield base(sessionId, { type: "stream_event", event: { type: "message_start", message: { id: messageId } } });
  // Like the CLI: Claude 5 thinking comes back empty unless the session asks for summarized thinking.
  const thought = text.startsWith("think: ") ? options.extraArgs?.["thinking-display"] === "summarized" ? `pondering ${text.slice(7)}` : "" : undefined;
  const textIndex = thought === undefined ? 0 : 1;
  if (thought !== undefined) {
    yield base(sessionId, { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
    if (thought) yield base(sessionId, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thought } } });
    const thinking = { type: "assistant", message: { id: messageId, role: "assistant", model, content: [{ type: "thinking", thinking: thought, signature: "sig" }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 3 } } };
    transcript.write({ ...thinking, apiBlockIndex: 0 });
    yield base(sessionId, thinking);
  }
  yield base(sessionId, { type: "stream_event", event: { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } } });
  yield base(sessionId, { type: "stream_event", event: { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: reply } } });
  yield base(sessionId, { type: "stream_event", event: { type: "message_stop" } });
  const assistant = { type: "assistant", message: { id: messageId, role: "assistant", model, content: [{ type: "text", text: reply }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 3 } } };
  // Like the CLI: the record names the effort the model ran at (unset: its own default; Haiku has none).
  const effort = options.effort ?? (model.includes("haiku") ? undefined : "medium");
  transcript.write({ ...assistant, apiBlockIndex: textIndex, ...(effort ? { effort } : {}) });
  const met = /meets the goal: (.+)/u.exec(text);
  if (met) transcript.write({ type: "attachment", attachment: { type: "goal_status", met: true, condition: met[1] } });
  // Streamed assistant messages never carry the stop reason (only the transcript does).
  yield base(sessionId, { ...assistant, message: { ...assistant.message, stop_reason: null } });
  yield* finish(reply);
  if (!background || stopped) return;
  await sleep(fakeClaude.backgroundMs);
  const outputFile = join(mkdtempSync(join(tmpdir(), "fake-task-")), "bg1.output");
  writeFileSync(outputFile, "BG-OUT\n");
  const summary = `Background command "${background[1]}" completed (exit code 0)`;
  yield base(sessionId, { type: "system", subtype: "background_tasks_changed", tasks: [] });
  yield base(sessionId, { type: "system", subtype: "task_notification", task_id: "bg1", status: "completed", output_file: outputFile, summary });
  yield base(sessionId, { type: "system", subtype: "session_state_changed", state: "running" });
  transcript.write({ type: "user", origin: { kind: "task-notification" }, promptId: randomUUID(), message: { role: "user", content: `<task-notification>\n<task-id>bg1</task-id>\n<output-file>${outputFile}</output-file>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>` } });
  const woken = `msg_${randomUUID().slice(0, 8)}`;
  yield base(sessionId, { type: "stream_event", event: { type: "message_start", message: { id: woken } } });
  yield base(sessionId, { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  yield base(sessionId, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the task finished" } } });
  yield base(sessionId, { type: "stream_event", event: { type: "message_stop" } });
  const done = { type: "assistant", message: { id: woken, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "the task finished" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 3 } } };
  transcript.write({ ...done, apiBlockIndex: 0 });
  yield base(sessionId, done);
  yield base(sessionId, { type: "result", subtype: "success", is_error: false, result: "the task finished", total_cost_usd: 0.01 });
  yield base(sessionId, { type: "system", subtype: "session_state_changed", state: "idle" });
}

/** The SDK's prewarm: the process it starts runs the fake once it gets its prompt. */
export async function fakeStartup({ options }: { options: Message }): Promise<any> {
  fakeClaude.calls.push({ method: "startup", args: [options.resume ?? options.sessionId] });
  // Like the CLI: a resumed session's transcript is read as the process starts, not when the prompt comes.
  const transcript = options.resume ? new Transcript(options.resume, options.cwd ?? process.cwd()) : undefined;
  return { query: (prompt: AsyncIterable<Message>) => fakeQuery({ prompt, options }, transcript), close: () => undefined };
}

export function fakeQuery({ prompt, options }: { prompt: AsyncIterable<Message>; options: Message }, started?: Transcript): any {
  fakeClaude.options.push(options);
  // Like the CLI: auto mode is unavailable on Haiku and falls back to default (and stays there after a model switch).
  const settle = (mode: string) => mode === "auto" && String(options.model).includes("haiku") ? "default" : mode;
  options.permissionMode = settle(options.permissionMode);
  const sessionId: string = options.sessionId ?? options.resume ?? randomUUID();
  const transcript = started ?? new Transcript(sessionId, options.cwd ?? process.cwd());
  if (options.resumeSessionAt) transcript.last = options.resumeSessionAt;
  let closed = false;
  const record = (method: string) => (...args: unknown[]) => {
    fakeClaude.calls.push({ method, args });
    return Promise.resolve(undefined);
  };
  async function* run(): AsyncGenerator<Message> {
    if (fakeClaude.spawnError) throw new Error(`Failed to spawn Claude Code process: ${fakeClaude.spawnError}`);
    if (options.resume && !existsSync(transcript.path)) throw new Error(`No conversation found with session ID: ${options.resume}`);
    yield base(sessionId, { type: "system", subtype: "init", model: options.model ?? "claude-opus-5-5" });
    for await (const message of prompt) {
      if (closed) return;
      yield* answer(message, options, transcript, sessionId);
    }
  }
  const iterator = run();
  return Object.assign(iterator, {
    initializationResult: () => Promise.resolve({}),
    supportedModels: () => (fakeClaude.modelsHold ?? Promise.resolve()).then(() => MODELS),
    supportedCommands: () => Promise.resolve([{ name: "review-pr", description: "Review a PR", argumentHint: "<n>" }]),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.resolve({
      rate_limits_available: true,
      rate_limits: fakeClaude.usageDown ? null : { five_hour: { utilization: 5, resets_at: null }, seven_day: { utilization: 3, resets_at: null }, seven_day_opus: null, model_scoped: [{ display_name: "Fable", utilization: 40, resets_at: null }] },
    }),
    // Asked for JSON, Claude's side question still wraps it in prose.
    askSideQuestion: (question: string) => Promise.resolve({ response: question.includes("JSON Schema")
      ? `Here it is:\n\`\`\`json\n${JSON.stringify({ description: `side: ${question.split("\n")[0]}` })}\n\`\`\`` : `side: ${question}` }),
    // Like Claude: `cancelQueued` drops the messages sent meanwhile it has yet to read; otherwise it runs them after.
    interrupt: (...args: unknown[]) => {
      const cancelled = (args[0] as Message | undefined)?.cancelQueued ? (prompt as unknown as { items: Message[] }).items.splice(0).map((message) => message.uuid) : [];
      if (stopCommand) stopCommand();
      else if (stopGoal) stopGoal();
      else stopEarly = true;
      stopGoal = undefined;
      fakeClaude.calls.push({ method: "interrupt", args });
      return Promise.resolve({ still_queued: [], cancelled });
    },
    backgroundTasks: (toolUseId?: string) => {
      backgrounded = stopCommand !== undefined;
      return record("backgroundTasks")(toolUseId).then(() => backgrounded);
    },
    // Like Claude with CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000: Haiku's own window is smaller.
    getContextUsage: () => Promise.resolve({ maxTokens: String(options.model).includes("haiku") ? 200_000 : 400_000 }),
    setModel: (model: string) => {
      if (model === fakeClaude.refusedModel) return Promise.reject(new Error(`Model '${model}' is restricted by your organization's settings.`));
      options.model = model;
      if (options.persistSession === false) return record("setModel")(model);
      // Like the CLI: the switch lands in the transcript as a local `/model` command.
      transcript.write({ type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" } });
      transcript.write({ type: "user", message: { role: "user", content: `<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>${model}</command-args>` } });
      transcript.write({ type: "user", message: { role: "user", content: `<local-command-stdout>Set model to ${model}</local-command-stdout>` } });
      return record("setModel")(model);
    },
    setPermissionMode: (mode: string) => { options.permissionMode = settle(mode); return record("setPermissionMode")(mode); },
    applyFlagSettings: (settings: Message) => {
      if ("effortLevel" in settings) options.effort = settings.effortLevel ?? undefined;
      if ("fastMode" in settings) options.settings = { ...options.settings, fastMode: settings.fastMode };
      return record("applyFlagSettings")(settings);
    },
    stopTask: record("stopTask"),
    renameSession: (title: string, id: string) => { transcript.rename(title); return record("renameSession")(title, id); },
    close: () => { closed = true; fakeClaude.calls.push({ method: "close", args: [sessionId] }); void iterator.return(undefined); },
  });
}
