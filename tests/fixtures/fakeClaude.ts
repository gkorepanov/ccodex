// Scripted stand-in for the Claude Agent SDK `query()`: answers each pushed message, streams like the real CLI and
// persists the same transcript records under $CLAUDE_CONFIG_DIR/projects, so the native catalog/projector read it.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
  private readonly path: string;

  public constructor(private readonly sessionId: string, private readonly cwd: string) {
    const directory = join(process.env.CLAUDE_CONFIG_DIR!, "projects", cwd.replace(/[^a-zA-Z0-9]/gu, "-"));
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, `${sessionId}.jsonl`);
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
    const decision = await options.canUseTool(name, input, { toolUseID: toolUseId, signal: new AbortController().signal, suggestions: [] });
    const result = decision.behavior === "allow" ? "done" : `denied: ${decision.message}`;
    transcript.write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: result }] }, toolUseResult: { stdout: result, stderr: "" } });
    yield base(sessionId, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: result }] }, tool_use_result: { stdout: result, stderr: "" } });
    reply = `approval ${decision.behavior}`;
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
  }
  const messageId = `msg_${randomUUID().slice(0, 8)}`;
  yield base(sessionId, { type: "stream_event", event: { type: "message_start", message: { id: messageId } } });
  yield base(sessionId, { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  yield base(sessionId, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } } });
  yield base(sessionId, { type: "stream_event", event: { type: "message_stop" } });
  const assistant = { type: "assistant", message: { id: messageId, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: reply }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 3 } } };
  transcript.write({ ...assistant, apiBlockIndex: 0 });
  const met = /meets the goal: (.+)/u.exec(text);
  if (met) transcript.write({ type: "attachment", attachment: { type: "goal_status", met: true, condition: met[1] } });
  // Streamed assistant messages never carry the stop reason (only the transcript does).
  yield base(sessionId, { ...assistant, message: { ...assistant.message, stop_reason: null } });
  yield* finish(reply);
}

export function fakeQuery({ prompt, options }: { prompt: AsyncIterable<Message>; options: Message }): any {
  fakeClaude.options.push(options);
  const sessionId: string = options.sessionId ?? options.resume ?? randomUUID();
  const transcript = new Transcript(sessionId, options.cwd ?? process.cwd());
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
    setModel: record("setModel"),
    setPermissionMode: record("setPermissionMode"),
    applyFlagSettings: record("applyFlagSettings"),
    stopTask: record("stopTask"),
    close: () => { closed = true; void iterator.return(undefined); },
  });
}
