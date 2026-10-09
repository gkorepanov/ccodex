import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { claudeHome } from "../config.js";
import type { JsonValue, ThreadItem } from "../protocol/codex.js";
import { bashCommandActions } from "./commandActions.js";

export interface ActiveTool {
  readonly index: number;
  readonly providerId: string;
  readonly itemId: string;
  readonly name: string;
  readonly cwd: string;
  input: Record<string, unknown>;
  partialInput: string;
  started: boolean;
  readonly startedAtMs: number;
}

/** How a background command ended: Claude's task notification (its status and summary), or a stop. */
export interface BackgroundEnd {
  readonly status: string;
  readonly summary: string;
  readonly outputFile?: string;
  readonly atMs: number;
  /** The task, when the end is found by its call (a command Stop killed while Claude waited on it). */
  readonly taskId?: string;
}

const BACKGROUND_OUTPUT_BYTES = 256 << 10;

/** The end of a command's output file (Claude writes a background command's output there). */
function outputTail(path: string): string | null {
  try {
    const bytes = readFileSync(path);
    return bytes.subarray(Math.max(0, bytes.length - BACKGROUND_OUTPUT_BYTES)).toString("utf8");
  } catch {
    return null;
  }
}

/** Like stock's background terminal: the command's item completes when the command ends, with its output. */
export function endedBackground(item: ThreadItem, end: BackgroundEnd, startedAtMs: number): ThreadItem {
  if (item.type !== "commandExecution") return item;
  const exit = /\(exit code (-?\d+)\)/u.exec(end.summary);
  return {
    ...item, status: end.status === "completed" ? "completed" : "failed", exitCode: exit ? Number(exit[1]) : null,
    aggregatedOutput: end.outputFile ? outputTail(end.outputFile) : null, durationMs: Math.max(0, end.atMs - startedAtMs),
  };
}

/** Claude's file of a command's output (the notification of a command Stop killed does not name it). */
export function taskOutputFile(cwd: string, sessionId: string, taskId: string): string {
  return join(tmpdir(), `claude-${process.getuid?.() ?? 0}`, cwd.replace(/[^a-zA-Z0-9]/gu, "-"), sessionId, "tasks", `${taskId}.output`);
}

/** A command Stop killed while Claude waited on it: its output so far, as stock's, not Claude's refusal of the call. */
export function killedCommand(item: ThreadItem, outputFile: string): ThreadItem {
  return item.type === "commandExecution" ? { ...item, status: "failed", exitCode: null, aggregatedOutput: outputTail(outputFile) } : item;
}

/** The background command a TaskStop result stopped (its task id). */
export function stoppedCommand(result: Record<string, unknown> | undefined): string | undefined {
  return result?.task_type === "local_bash" && typeof result.task_id === "string" && typeof result.message === "string"
    && result.message.startsWith("Successfully stopped task") ? result.task_id : undefined;
}

/** A task notification Claude takes as a prompt: `<task-id>`, `<status>`, `<summary>`, `<output-file>`. */
export function taskNotification(text: string, atMs: number): { taskId: string; toolUseId?: string; end: BackgroundEnd } | undefined {
  const field = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "u").exec(text)?.[1];
  const taskId = field("task-id");
  const status = field("status");
  if (!taskId || !status) return undefined;
  const outputFile = field("output-file");
  const toolUseId = field("tool-use-id");
  return { taskId, ...(toolUseId ? { toolUseId } : {}), end: { status, summary: field("summary") ?? "", ...(outputFile ? { outputFile } : {}), atMs } };
}

const fileTools = new Set(["Edit", "Write", "NotebookEdit"]);
const commandTools = new Set(["Bash"]);
const collabTools = new Set(["Agent", "Task", "SendMessage"]);
const imageExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const declinedToolKinds = new Set([
  "user-rejected", "permission-rule", "automode-blocked", "automode-unavailable", "automode-parsing-error",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function absolutePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function imagePath(name: string, input: Record<string, unknown>, cwd: string): string | undefined {
  if (name !== "Read") return undefined;
  const path = text(input.file_path) || text(input.path);
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return undefined;
  return imageExtensions.has(extname(path).toLocaleLowerCase()) ? absolutePath(path, cwd) : undefined;
}

/** Claude's own file of a skill or command (the user's before the project's, as Claude picks), if it has one. */
export function claudeSkillFile(name: string, cwd: string, home = claudeHome()): string | undefined {
  const command = `${name.split(":").join("/")}.md`;
  return [home, join(cwd, ".claude")].flatMap((root) => [join(root, "skills", name, "SKILL.md"), join(root, "commands", command)])
    .find((file) => existsSync(file));
}

function nativeCommand(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): { command: string; actions: Extract<ThreadItem, { type: "commandExecution" }>["commandActions"] } | undefined {
  if (name === "Bash") {
    const command = text(input.command);
    return { command, actions: bashCommandActions(command, cwd) };
  }
  if (name === "Read") {
    const path = text(input.file_path) || text(input.path);
    if (!path) return { command: "", actions: [] };
    const command = `Read ${path}`;
    const resolved = absolutePath(path, cwd);
    return { command, actions: [{ type: "read", command, name: basename(resolved) || resolved, path: resolved }] };
  }
  if (name === "Glob") {
    const pattern = text(input.pattern) || text(input.glob);
    if (!pattern) return { command: "", actions: [] };
    const path = text(input.path) || cwd;
    const command = `Glob ${pattern} in ${path}`;
    return { command, actions: [{ type: "listFiles", command, path }] };
  }
  if (name === "Grep") {
    const query = text(input.pattern) || text(input.query);
    if (!query) return { command: "", actions: [] };
    const path = text(input.path) || null;
    const command = `Grep ${query}${path ? ` in ${path}` : ""}`;
    return { command, actions: [{ type: "search", command, query, path }] };
  }
  if (name === "Skill") {
    // Stock has no skill tool: its model reads the skill's SKILL.md, which Desktop shows as "Read <name> skill".
    const skill = text(input.skill);
    if (!skill) return { command: "", actions: [] };
    const command = `Skill ${skill}`;
    return { command, actions: [{ type: "read", command, name: `${skill} skill`, path: claudeSkillFile(skill, cwd) ?? "" }] };
  }
  if (name === "ToolSearch") {
    const query = text(input.query);
    if (!query) return { command: "", actions: [] };
    const command = `ToolSearch ${query}`;
    return { command, actions: [{ type: "search", command, query, path: null }] };
  }
  if (name === "TaskOutput") {
    const taskId = text(input.task_id) || text(input.taskId);
    if (!taskId) return { command: "", actions: [] };
    const wait = input.block === true ? " (wait)" : "";
    const command = `TaskOutput ${taskId}${wait}`;
    return { command, actions: [{ type: "unknown", command }] };
  }
  return undefined;
}

function commandItem(
  state: ActiveTool,
  command: string,
  actions: Extract<ThreadItem, { type: "commandExecution" }>["commandActions"],
  cwd: string,
): ThreadItem {
  return {
    type: "commandExecution", id: state.itemId, pluginId: null, scriptPath: null, command, cwd,
    processId: null, source: "agent", status: "inProgress", commandActions: actions,
    aggregatedOutput: null, exitCode: null, durationMs: null,
  };
}

function mcpName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const [, server = "unknown", ...parts] = name.split("__");
  return { server, tool: parts.join("__") || name };
}

export function startTool(
  index: number,
  block: Record<string, unknown>,
  cwd: string,
  threadId: string,
): { state: ActiveTool; item: ThreadItem } {
  const name = text(block.name) || "unknown";
  const providerId = text(block.id) || `claude-tool-${index}`;
  const input = block.input && typeof block.input === "object" ? block.input as Record<string, unknown> : {};
  const state: ActiveTool = { index, providerId, itemId: providerId, name, cwd, input, partialInput: "", started: false, startedAtMs: Date.now() };

  if (commandTools.has(name)) {
    const native = nativeCommand(name, input, cwd)!;
    return { state, item: commandItem(state, native.command, native.actions, cwd) };
  }
  if (fileTools.has(name)) return { state, item: { type: "fileChange", id: state.itemId, changes: [], status: "inProgress" } };
  // The plan Claude proposes to leave plan mode with: stock's proposed plan.
  if (name === "ExitPlanMode") return { state, item: { type: "plan", id: state.itemId, text: text(input.plan) } };
  const mcp = mcpName(name);
  if (mcp || block.type === "mcp_tool_use") {
    return { state, item: {
      type: "mcpToolCall", id: state.itemId, server: mcp?.server ?? (text(block.server_name) || "unknown"),
      tool: mcp?.tool ?? name, status: "inProgress", arguments: input as JsonValue, appContext: null,
      pluginId: null, result: null, error: null, durationMs: null, readOnlyHint: null,
    } };
  }
  if (name === "WebSearch" || name === "web_search") {
    const query = text(input.query);
    return { state, item: { type: "webSearch", id: state.itemId, query, results: null, action: { type: "search", query: query || null, queries: null } } };
  }
  if (name === "WebFetch" || name === "web_fetch") {
    const url = text(input.url);
    return { state, item: { type: "webSearch", id: state.itemId, query: url, results: null, action: { type: "openPage", url: url || null } } };
  }
  const native = nativeCommand(name, input, cwd);
  if (native) return { state, item: commandItem(state, native.command, native.actions, cwd) };
  if (collabTools.has(name)) {
    const sendInput = name === "SendMessage";
    return { state, item: {
      type: "collabAgentToolCall", id: state.itemId, tool: sendInput ? "sendInput" : "spawnAgent", status: "inProgress",
      senderThreadId: threadId, receiverThreadIds: [],
      prompt: text(input.message) || text(input.content) || text(input.prompt) || text(input.description) || null,
      model: text(input.model) || null, reasoningEffort: null, agentsStates: {},
    } };
  }
  return { state, item: {
    type: "dynamicToolCall", id: state.itemId, namespace: "claude", tool: name,
    arguments: input as JsonValue, status: "inProgress", contentItems: null, success: null, durationMs: null,
  } };
}

export function updateToolInput(
  item: ThreadItem,
  state: ActiveTool,
  input: Record<string, unknown>,
  cwd: string,
): ThreadItem {
  state.input = input;
  if (item.type === "commandExecution") {
    const native = nativeCommand(state.name, input, item.cwd);
    item.command = native?.command ?? text(input.command);
    item.commandActions = native?.actions ?? (item.command ? [{ type: "unknown", command: item.command }] : []);
  }
  else if (item.type === "dynamicToolCall" || item.type === "mcpToolCall") item.arguments = input as JsonValue;
  else if (item.type === "collabAgentToolCall" && item.tool === "sendInput") {
    item.prompt = text(input.message) || text(input.content) || item.prompt;
  }
  return item;
}

/** Unified hunk replacing `before` (starting at line `start`) with `after`. */
function hunk(before: string, after: string, start: number): string {
  const lines = (value: string) => value === "" ? [] : value.replace(/\n$/u, "").split("\n");
  const removed = lines(before);
  const added = lines(after);
  return [`@@ -${start},${removed.length} +${start},${added.length} @@`, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n");
}

/** What a Write/Edit/MultiEdit is about to change, from its input: stock shows the patch before it is applied. */
export function proposedChanges(name: string, input: Record<string, unknown>, cwd: string): Array<{ path: string; kind: { type: "add" } | { type: "update"; move_path: null }; diff: string }> {
  const file = text(input.file_path);
  if (!file || name === "NotebookEdit") return [];
  const path = isAbsolute(file) ? file : resolve(cwd, file);
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (name === "Write") {
    const content = text(input.content);
    return [current === undefined ? { path, kind: { type: "add" }, diff: content } : { path, kind: { type: "update", move_path: null }, diff: hunk(current, content, 1) }];
  }
  const edits = name === "MultiEdit" && Array.isArray(input.edits) ? input.edits as Array<Record<string, unknown>> : [input];
  const diff = edits.map((change) => {
    const before = text(change.old_string);
    const at = current?.indexOf(before) ?? -1;
    return hunk(before, text(change.new_string), at < 0 ? 1 : current!.slice(0, at).split("\n").length);
  }).join("\n");
  return [{ path, kind: { type: "update", move_path: null }, diff }];
}

export function isImageRead(state: ActiveTool, cwd: string): boolean {
  return imagePath(state.name, state.input, cwd) !== undefined;
}

export function projectToolCompletion(
  item: ThreadItem,
  state: ActiveTool,
  output: string,
  isError: boolean,
  result: Record<string, unknown> | undefined,
  cwd: string,
  nonExecutionKind?: string,
): { started: ThreadItem; completed: ThreadItem } {
  const path = !isError ? imagePath(state.name, state.input, cwd) : undefined;
  if (path) {
    const image: ThreadItem = { type: "imageView", id: state.itemId, path };
    return { started: image, completed: image };
  }
  return {
    started: item,
    completed: completeTool(item, output, isError, result, state.startedAtMs, nonExecutionKind),
  };
}

export function completeTool(
  item: ThreadItem,
  output: string,
  isError: boolean,
  result: Record<string, unknown> | undefined,
  startedAtMs: number,
  nonExecutionKind?: string,
): ThreadItem {
  const durationMs = typeof result?.duration_ms === "number" ? result.duration_ms : Date.now() - startedAtMs;
  const declined = nonExecutionKind !== undefined && declinedToolKinds.has(nonExecutionKind);
  if (item.type === "commandExecution") return {
    ...item, status: declined ? "declined" : isError ? "failed" : "completed", aggregatedOutput: output,
    exitCode: typeof result?.exit_code === "number" ? result.exit_code : typeof result?.exitCode === "number" ? result.exitCode : isError ? 1 : 0,
    durationMs,
  };
  if (item.type === "mcpToolCall") return {
    ...item, status: isError ? "failed" : "completed", durationMs,
    result: isError ? null : { content: output ? [{ type: "text", text: output } as JsonValue] : [], structuredContent: null, _meta: null },
    error: isError ? { message: output || "Claude MCP tool failed." } : null,
  };
  if (item.type === "dynamicToolCall") return {
    ...item, status: isError ? "failed" : "completed", durationMs, success: !isError,
    contentItems: output ? [{ type: "inputText", text: output }] : [],
  };
  if (item.type === "collabAgentToolCall") {
    const resolvedModel = text(result?.resolvedModel)
      || (Array.isArray(result?.modelsUsed) ? result.modelsUsed.filter((model): model is string => typeof model === "string").at(-1) : "")
      || item.model;
    return { ...item, status: isError ? "failed" : "completed", model: resolvedModel };
  }
  return item;
}
