import { isAbsolute, resolve } from "node:path";

const eventNames = {
  PreToolUse: "preToolUse",
  PermissionRequest: "permissionRequest",
  PostToolUse: "postToolUse",
  PreCompact: "preCompact",
  PostCompact: "postCompact",
  SessionStart: "sessionStart",
  UserPromptSubmit: "userPromptSubmit",
  SubagentStart: "subagentStart",
  SubagentStop: "subagentStop",
  Stop: "stop",
} as const;

export interface ClaudeHookRun {
  readonly id: string;
  readonly eventName: (typeof eventNames)[keyof typeof eventNames];
  readonly handlerType: "command";
  readonly executionMode: "sync";
  readonly scope: "thread" | "turn";
  readonly sourcePath: string;
  readonly source: "unknown";
  readonly displayOrder: number;
  status: "running" | "completed" | "failed" | "stopped";
  statusMessage: string | null;
  readonly startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  entries: Array<{ kind: "feedback" | "error"; text: string }>;
}

export function startHookRun(
  message: { hookId: string; hookName: string; hookEvent: string },
  cwd: string,
  activeTurn: boolean,
  displayOrder: number,
): ClaudeHookRun | undefined {
  const eventName = eventNames[message.hookEvent as keyof typeof eventNames];
  if (!eventName) return undefined;
  return {
    id: message.hookId,
    eventName,
    handlerType: "command",
    executionMode: "sync",
    scope: activeTurn ? "turn" : "thread",
    sourcePath: isAbsolute(message.hookName) ? message.hookName : resolve(cwd, message.hookName),
    source: "unknown",
    displayOrder,
    status: "running",
    statusMessage: message.hookName,
    startedAt: Date.now(),
    completedAt: null,
    durationMs: null,
    entries: [],
  };
}

function appendOutput(
  run: ClaudeHookRun,
  message: { output: string; stdout: string; stderr: string },
): void {
  const output = [message.output, message.stdout].filter(Boolean).join("\n");
  if (output) run.entries.push({ kind: "feedback", text: output });
  if (message.stderr) run.entries.push({ kind: "error", text: message.stderr });
}

export function appendHookProgress(
  run: ClaudeHookRun,
  message: { output: string; stdout: string; stderr: string },
): void {
  appendOutput(run, message);
}

export function completeHookRun(
  run: ClaudeHookRun,
  message: {
    output: string;
    stdout: string;
    stderr: string;
    outcome: "success" | "error" | "cancelled";
    exitCode?: number;
  },
): ClaudeHookRun {
  appendOutput(run, message);
  const completedAt = Date.now();
  run.status = message.outcome === "success" ? "completed" : message.outcome === "cancelled" ? "stopped" : "failed";
  run.statusMessage = message.exitCode === undefined
    ? message.outcome
    : `${message.outcome} (exit ${message.exitCode})`;
  run.completedAt = completedAt;
  run.durationMs = completedAt - run.startedAt;
  return run;
}
