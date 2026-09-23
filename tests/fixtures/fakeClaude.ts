// Scripted stand-in for the Claude Agent SDK `query()`: answers each pushed message, streams like the real CLI and
// persists the same transcript records under $CLAUDE_CONFIG_DIR/projects, so the native catalog/projector read it.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Message = Record<string, any>;

export interface FakeClaudeLog {
  readonly prompts: Array<{ sessionId: string; uuid: string; text: string; shouldQuery: boolean }>;
  readonly options: Message[];
  readonly calls: Array<{ method: string; args: unknown[] }>;
}

export const fakeClaude: FakeClaudeLog & { reset(): void; reply: (text: string) => string } = {
  prompts: [],
  options: [],
  calls: [],
  reply: (text) => `claude: ${text}`,
  reset() {
    this.prompts.length = 0;
    this.options.length = 0;
    this.calls.length = 0;
    this.reply = (text) => `claude: ${text}`;
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

  public constructor(private readonly sessionId: string, private readonly cwd: string, path?: string) {
    const directory = join(process.env.CLAUDE_CONFIG_DIR!, "projects", cwd.replace(/[^a-zA-Z0-9]/gu, "-"));
    mkdirSync(directory, { recursive: true });
    this.path = path ?? join(directory, `${sessionId}.jsonl`);
    // A resumed session continues the chain.
    if (existsSync(this.path)) this.last = JSON.parse(readFileSync(this.path, "utf8").trim().split("\n").at(-1)!).uuid;
  }

  public write(record: Message, chain = true): string {
    const uuid = record.uuid ?? randomUUID();
    appendFileSync(this.path, `${JSON.stringify({
      parentUuid: chain ? this.last : null, isSidechain: false, sessionId: this.sessionId, cwd: this.cwd,
      version: "2.1.280", gitBranch: "main", timestamp: new Date().toISOString(), ...record, uuid,
    })}\n`);
    this.last = uuid;
    return uuid;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Codex answering an MCP call: it journals the turn under $CODEX_HOME/sessions like `codex mcp-server`. */
function codexJournal(prompt: string): string {
  const threadId = randomUUID();
  const directory = join(process.env.CODEX_HOME!, "sessions", "2026", "09", "23");
  mkdirSync(directory, { recursive: true });
  const event = (payload: Message) => `${JSON.stringify({ type: "event_msg", payload })}\n`;
  writeFileSync(join(directory, `rollout-2026-09-23T00-00-00-${threadId}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { id: threadId, timestamp: new Date().toISOString(), source: "mcp" } })}\n`
    + event({ type: "task_started" })
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
  const finish = function* (result: string): Generator<Message> {
    yield base(sessionId, { type: "result", subtype: "success", is_error: false, result, total_cost_usd: 0.01, user_message_uuids: [uuid], modelUsage: { "claude-opus-5-5": { contextWindow: 200_000 } } });
    yield base(sessionId, { type: "command_lifecycle", state: "completed", command_uuid: uuid });
    yield base(sessionId, { type: "system", subtype: "session_state_changed", state: "idle" });
  };
  if (prompt.shouldQuery === false) {
    transcript.write({ type: "user", uuid, message: { role: "user", content: text } });
    yield* finish("");
    return;
  }
  const command = /^\/(\w+)\s*([\s\S]*)$/u.exec(text);
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
    transcript.write({ type: "user", uuid, message: { role: "user", content: `<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>${command[2]}</command-args>` } });
    const output = command[2] === "clear" ? "Goal cleared" : `Goal set: ${command[2]}`;
    transcript.write({ type: "system", subtype: "local_command", content: `<local-command-stdout>${output}</local-command-stdout>`, commandRun: { command: "goal", args: command[2] } });
    yield base(sessionId, { type: "system", subtype: "local_command_output", content: output });
    yield* finish("");
    return;
  }
  transcript.write({ type: "user", uuid, origin: { kind: "human" }, message: { role: "user", content: prompt.message.content } });
  let reply = fakeClaude.reply(text);
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
  const messageId = `msg_${randomUUID().slice(0, 8)}`;
  yield base(sessionId, { type: "stream_event", event: { type: "message_start", message: { id: messageId } } });
  // Like the CLI: Claude 5 thinking comes back empty unless the session asks for summarized thinking.
  const thought = text.startsWith("think: ") ? options.extraArgs?.["thinking-display"] === "summarized" ? `pondering ${text.slice(7)}` : "" : undefined;
  const textIndex = thought === undefined ? 0 : 1;
  if (thought !== undefined) {
    yield base(sessionId, { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
    if (thought) yield base(sessionId, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thought } } });
    const thinking = { type: "assistant", message: { id: messageId, role: "assistant", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: thought, signature: "sig" }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 3 } } };
    transcript.write({ ...thinking, apiBlockIndex: 0 });
    yield base(sessionId, thinking);
  }
  yield base(sessionId, { type: "stream_event", event: { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } } });
  yield base(sessionId, { type: "stream_event", event: { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: reply } } });
  yield base(sessionId, { type: "stream_event", event: { type: "message_stop" } });
  const assistant = { type: "assistant", message: { id: messageId, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: reply }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 3 } } };
  transcript.write({ ...assistant, apiBlockIndex: textIndex });
  const met = /meets the goal: (.+)/u.exec(text);
  if (met) transcript.write({ type: "attachment", attachment: { type: "goal_status", met: true, condition: met[1] } });
  // Streamed assistant messages never carry the stop reason (only the transcript does).
  yield base(sessionId, { ...assistant, message: { ...assistant.message, stop_reason: null } });
  yield* finish(reply);
}

export function fakeQuery({ prompt, options }: { prompt: AsyncIterable<Message>; options: Message }): any {
  fakeClaude.options.push(options);
  // Like the CLI: auto mode is unavailable on Haiku and falls back to default (and stays there after a model switch).
  const settle = (mode: string) => mode === "auto" && String(options.model).includes("haiku") ? "default" : mode;
  options.permissionMode = settle(options.permissionMode);
  const sessionId: string = options.sessionId ?? options.resume ?? randomUUID();
  const transcript = new Transcript(sessionId, options.cwd ?? process.cwd());
  if (options.resumeSessionAt) transcript.last = options.resumeSessionAt;
  let closed = false;
  const record = (method: string) => (...args: unknown[]) => {
    fakeClaude.calls.push({ method, args });
    return Promise.resolve(undefined);
  };
  async function* run(): AsyncGenerator<Message> {
    yield base(sessionId, { type: "system", subtype: "init", model: options.model ?? "claude-opus-5-5" });
    for await (const message of prompt) {
      if (closed) return;
      yield* answer(message, options, transcript, sessionId);
    }
  }
  const iterator = run();
  return Object.assign(iterator, {
    initializationResult: () => Promise.resolve({}),
    supportedModels: () => Promise.resolve(MODELS),
    supportedCommands: () => Promise.resolve([{ name: "review-pr", description: "Review a PR", argumentHint: "<n>" }]),
    askSideQuestion: (question: string) => Promise.resolve({ response: `side: ${question}` }),
    interrupt: record("interrupt"),
    setModel: (model: string) => {
      // Like the CLI: the switch lands in the transcript as a local `/model` command.
      transcript.write({ type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" } });
      transcript.write({ type: "user", message: { role: "user", content: `<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>${model}</command-args>` } });
      transcript.write({ type: "user", message: { role: "user", content: `<local-command-stdout>Set model to ${model}</local-command-stdout>` } });
      options.model = model;
      return record("setModel")(model);
    },
    setPermissionMode: (mode: string) => { options.permissionMode = settle(mode); return record("setPermissionMode")(mode); },
    applyFlagSettings: record("applyFlagSettings"),
    stopTask: record("stopTask"),
    close: () => { closed = true; void iterator.return(undefined); },
  });
}
