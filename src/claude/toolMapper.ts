import { basename, extname, isAbsolute, resolve } from "node:path";
import type { ThreadItem } from "../codex/generated/v2/ThreadItem.js";
import type { JsonValue } from "../codex/generated/serde_json/JsonValue.js";
import { bashCommandActions } from "./commandActions.js";

export interface ActiveTool {
  readonly index: number;
  readonly providerId: string;
  readonly itemId: string;
  readonly name: string;
  input: Record<string, unknown>;
  partialInput: string;
  started: boolean;
  readonly startedAtMs: number;
  backgroundTaskId?: string;
  outputFile?: string;
  foldedTaskId?: string;
}

const fileTools = new Set(["Edit", "Write", "NotebookEdit"]);
const commandTools = new Set(["Bash"]);
const collabTools = new Set(["Agent", "Task", "SendMessage"]);
const imageExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

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
    type: "commandExecution", id: state.itemId, command, cwd,
    processId: null, source: "agent", status: "inProgress", commandActions: actions,
    aggregatedOutput: null, exitCode: null, durationMs: null,
  };
}

function mcpName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const [, server = "unknown", ...parts] = name.split("__");
  return { server, tool: parts.join("__") || name };
}

function planText(input: Record<string, unknown>): string {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  return todos.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const todo = value as Record<string, unknown>;
    const marker = todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[-]" : "[ ]";
    return [`${marker} ${text(todo.content) || "Task"}`];
  }).join("\n");
}

export function planSteps(input: Record<string, unknown>) {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  return todos.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const todo = value as Record<string, unknown>;
    return [{
      step: text(todo.content) || "Task",
      status: todo.status === "completed" ? "completed" as const : todo.status === "in_progress" ? "inProgress" as const : "pending" as const,
    }];
  });
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
  const state: ActiveTool = { index, providerId, itemId: providerId, name, input, partialInput: "", started: false, startedAtMs: Date.now() };

  if (commandTools.has(name)) {
    const native = nativeCommand(name, input, cwd)!;
    return { state, item: commandItem(state, native.command, native.actions, cwd) };
  }
  if (fileTools.has(name)) return { state, item: { type: "fileChange", id: state.itemId, changes: [], status: "inProgress" } };
  const mcp = mcpName(name);
  if (mcp || block.type === "mcp_tool_use") {
    return { state, item: {
      type: "mcpToolCall", id: state.itemId, server: mcp?.server ?? (text(block.server_name) || "unknown"),
      tool: mcp?.tool ?? name, status: "inProgress", arguments: input as JsonValue, appContext: null,
      pluginId: null, result: null, error: null, durationMs: null,
    } };
  }
  if (name === "WebSearch" || name === "web_search") {
    const query = text(input.query);
    return { state, item: { type: "webSearch", id: state.itemId, query, action: { type: "search", query: query || null, queries: null } } };
  }
  if (name === "WebFetch" || name === "web_fetch") {
    const url = text(input.url);
    return { state, item: { type: "webSearch", id: state.itemId, query: url, action: { type: "openPage", url: url || null } } };
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
  if (name === "TodoWrite") return { state, item: { type: "plan", id: state.itemId, text: planText(input) } };
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
  else if (item.type === "plan") item.text = planText(input);
  return item;
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
): { started: ThreadItem; completed: ThreadItem } {
  const path = !isError ? imagePath(state.name, state.input, cwd) : undefined;
  if (path) {
    const image: ThreadItem = { type: "imageView", id: state.itemId, path };
    return { started: image, completed: image };
  }
  return {
    started: item,
    completed: completeTool(item, output, isError, result, state.startedAtMs),
  };
}

function resultDiff(result: Record<string, unknown> | undefined) {
  const diff = text(result?.diff) || text(result?.patch);
  const path = text(result?.file_path) || text(result?.filePath) || text(result?.path);
  if (!diff || !path) return [];
  const kind = result?.type === "create" ? { type: "add" as const } : result?.type === "delete" ? { type: "delete" as const } : { type: "update" as const, move_path: null };
  return [{ path, kind, diff }];
}

export function completeTool(
  item: ThreadItem,
  output: string,
  isError: boolean,
  result: Record<string, unknown> | undefined,
  startedAtMs: number,
): ThreadItem {
  const durationMs = typeof result?.duration_ms === "number" ? result.duration_ms : Date.now() - startedAtMs;
  if (item.type === "commandExecution") return {
    ...item, status: isError ? "failed" : "completed", aggregatedOutput: output,
    exitCode: typeof result?.exit_code === "number" ? result.exit_code : typeof result?.exitCode === "number" ? result.exitCode : isError ? 1 : 0,
    durationMs,
  };
  if (item.type === "fileChange") {
    const changes = resultDiff(result);
    return { ...item, status: isError ? "failed" : "completed", changes: changes.length > 0 ? changes : item.changes };
  }
  if (item.type === "mcpToolCall") return {
    ...item, status: isError ? "failed" : "completed", durationMs,
    result: isError ? null : { content: output ? [{ type: "text", text: output } as JsonValue] : [], structuredContent: result as JsonValue ?? null, _meta: null },
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
