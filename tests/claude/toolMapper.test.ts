import { describe, expect, it } from "vitest";
import { completeTool, projectToolCompletion, startTool, updateToolInput } from "../../src/claude/toolMapper.js";

describe("Claude tool projection", () => {
  it("maps exact Bash calls to command execution and preserves final output", () => {
    const { state, item } = startTool(0, {
      type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" },
    }, "/tmp/project", "thread-1");
    expect(item).toMatchObject({
      type: "commandExecution", command: "pwd", cwd: "/tmp/project", status: "inProgress",
      commandActions: [{ type: "unknown", command: "pwd" }],
    });
    expect(completeTool(item, "/tmp/project\n", false, { exit_code: 0, duration_ms: 12 }, state.startedAtMs)).toMatchObject({
      type: "commandExecution", status: "completed", aggregatedOutput: "/tmp/project\n", exitCode: 0, durationMs: 12,
    });
  });

  it("fills a streamed Bash command and its mobile command action before announcement", () => {
    const { state, item } = startTool(0, {
      type: "tool_use", id: "tool-streamed", name: "Bash", input: {},
    }, "/tmp/project", "thread-1");
    expect(item).toMatchObject({ type: "commandExecution", command: "", commandActions: [] });
    updateToolInput(item, state, { command: "curl -L example.com" }, "/tmp/project");
    expect(item).toMatchObject({
      type: "commandExecution", command: "curl -L example.com",
      commandActions: [{ type: "unknown", command: "curl -L example.com" }],
    });
  });

  it("maps file and search tools to renderer-native command actions", () => {
    expect(startTool(0, {
      type: "tool_use", id: "read", name: "Read", input: { file_path: "package.json" },
    }, "/tmp/project", "thread-1").item).toMatchObject({
      type: "commandExecution", command: "Read package.json",
      commandActions: [{ type: "read", name: "package.json", path: "/tmp/project/package.json" }],
    });
    expect(startTool(1, {
      type: "tool_use", id: "grep", name: "Grep", input: { pattern: "needle", path: "src" },
    }, "/tmp/project", "thread-1").item).toMatchObject({
      type: "commandExecution", command: "Grep needle in src",
      commandActions: [{ type: "search", query: "needle", path: "src" }],
    });
    expect(startTool(2, {
      type: "tool_use", id: "search", name: "ToolSearch", input: { query: "select:TaskOutput" },
    }, "/tmp/project", "thread-1").item).toMatchObject({
      type: "commandExecution", command: "ToolSearch select:TaskOutput",
      commandActions: [{ type: "search", query: "select:TaskOutput", path: null }],
    });
  });

  it("promotes a successful streamed image Read only when its result succeeds", () => {
    const { state, item } = startTool(0, {
      type: "tool_use", id: "image-streamed", name: "Read", input: {},
    }, "/tmp/project", "thread-1");
    expect(item).toMatchObject({ type: "commandExecution", id: "image-streamed", command: "" });

    const provisional = updateToolInput(item, state, { file_path: "plots/chart.PNG" }, "/tmp/project");
    expect(provisional).toMatchObject({
      type: "commandExecution", id: "image-streamed", command: "Read plots/chart.PNG",
    });
    expect(projectToolCompletion(provisional, state, "image bytes", false, undefined, "/tmp/project")).toEqual({
      started: { type: "imageView", id: "image-streamed", path: "/tmp/project/plots/chart.PNG" },
      completed: { type: "imageView", id: "image-streamed", path: "/tmp/project/plots/chart.PNG" },
    });
  });

  it("keeps a failed image Read as a renderer-native failed command", () => {
    const { state, item } = startTool(0, {
      type: "tool_use", id: "image-failed", name: "Read", input: { file_path: "plots/missing.jpg" },
    }, "/tmp/project", "thread-1");
    const projected = projectToolCompletion(item, state, "ENOENT: no such file", true, undefined, "/tmp/project");
    expect(projected.started).toMatchObject({
      type: "commandExecution", id: "image-failed", command: "Read plots/missing.jpg", status: "inProgress",
      commandActions: [{ type: "read", path: "/tmp/project/plots/missing.jpg" }],
    });
    expect(projected.completed).toMatchObject({
      type: "commandExecution", id: "image-failed", command: "Read plots/missing.jpg", status: "failed",
      aggregatedOutput: "ENOENT: no such file", exitCode: 1,
    });
    expect(projected.completed.type).toBe("commandExecution");
  });

  it("keeps non-image Reads as command actions", () => {
    const { state, item } = startTool(1, {
      type: "tool_use", id: "non-image", name: "Read", input: {},
    }, "/tmp/project", "thread-1");
    expect(updateToolInput(item, state, { file_path: "package.json" }, "/tmp/project")).toMatchObject({
      type: "commandExecution", id: "non-image", command: "Read package.json",
      commandActions: [{ type: "read", path: "/tmp/project/package.json" }],
    });
  });

  it("delays TaskOutput announcement until its streamed task id is known", () => {
    const { state, item } = startTool(0, {
      type: "tool_use", id: "task-output", name: "TaskOutput", input: {},
    }, "/tmp/project", "thread-1");
    expect(item).toMatchObject({ type: "commandExecution", command: "", commandActions: [] });
    updateToolInput(item, state, { task_id: "task-123", block: true, timeout: 120_000 }, "/tmp/project");
    expect(item).toMatchObject({
      type: "commandExecution", command: "TaskOutput task-123 (wait)",
      commandActions: [{ type: "unknown", command: "TaskOutput task-123 (wait)" }],
    });
  });

  it("never promotes unknown names to privileged specialized item types", () => {
    expect(startTool(0, {
      type: "tool_use", id: "tool-2", name: "DefinitelyBashLikeButUnknown", input: {},
    }, "/tmp/project", "thread-1").item).toMatchObject({
      type: "dynamicToolCall", namespace: "claude", tool: "DefinitelyBashLikeButUnknown",
    });
  });

  it("maps structured MCP names without substring guessing", () => {
    expect(startTool(0, {
      type: "tool_use", id: "tool-3", name: "mcp__github__search_code", input: { q: "needle" },
    }, "/tmp/project", "thread-1").item).toMatchObject({
      type: "mcpToolCall", server: "github", tool: "search_code", arguments: { q: "needle" },
    });
  });

  it("uses the provider-resolved final model for completed subagents", () => {
    const { state, item } = startTool(0, {
      type: "tool_use", id: "agent", name: "Agent",
      input: { prompt: "inspect", model: "sonnet" },
    }, "/tmp/project", "thread-1");
    expect(completeTool(item, "done", false, {
      resolvedModel: "claude-opus-4-8",
      modelsUsed: ["claude-sonnet-5", "claude-opus-4-8"],
    }, state.startedAtMs)).toMatchObject({
      type: "collabAgentToolCall", status: "completed", model: "claude-opus-4-8",
    });
  });

  it("maps SendMessage to the native collaboration input item", () => {
    const { state, item } = startTool(0, {
      type: "tool_use", id: "send", name: "SendMessage",
      input: { to: "provider-task", message: "Continue the conversion" },
    }, "/tmp/project", "thread-1");
    expect(item).toMatchObject({
      type: "collabAgentToolCall", tool: "sendInput", status: "inProgress",
      senderThreadId: "thread-1", receiverThreadIds: [], prompt: "Continue the conversion",
    });
    expect(completeTool(item, "delivered", false, undefined, state.startedAtMs)).toMatchObject({
      type: "collabAgentToolCall", tool: "sendInput", status: "completed",
    });
  });
});
