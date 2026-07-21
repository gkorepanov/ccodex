import { describe, expect, it } from "vitest";
import { appendHookProgress, completeHookRun, startHookRun } from "../../src/claude/hookMapper.js";

describe("Claude hook lifecycle projection", () => {
  it("maps a supported hook and accumulates its output", () => {
    const run = startHookRun({
      hookId: "hook-1", hookName: "scripts/check.sh", hookEvent: "PostToolUse",
    }, "/repo", true, 3)!;
    appendHookProgress(run, {
      stdout: "checking", stderr: "", output: "",
    });
    completeHookRun(run, {
      output: "done", stdout: "", stderr: "", exitCode: 0, outcome: "success",
    });
    expect(run).toMatchObject({
      eventName: "postToolUse", scope: "turn", sourcePath: "/repo/scripts/check.sh", displayOrder: 3,
      status: "completed", statusMessage: "success (exit 0)",
      entries: [{ kind: "feedback", text: "checking" }, { kind: "feedback", text: "done" }],
    });
  });

  it("does not invent unsupported Codex hook event names", () => {
    expect(startHookRun({
      hookId: "hook-2", hookName: "notify", hookEvent: "Notification",
    }, "/repo", false, 0)).toBeUndefined();
  });
});
