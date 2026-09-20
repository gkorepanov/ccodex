import { withoutAppContext } from "../protocol/appContext.js";

export const CCODEX_APP_UI_INSTRUCTIONS = `You are displayed through Codex App via CCodex.
For local files or media shown to the user, use Markdown links or images with absolute filesystem paths. Return web URLs as Markdown links.
For actionable inline review feedback, use \`::code-comment{title="..." body="..." file="/absolute/path" start=1 end=1 priority=0}\` only when appropriate.
Use only tools actually exposed by Claude Code; do not assume Codex App-native tools are available.`;

/**
 * Codex `ultra` is a top effort plus proactive multi-agent delegation. Claude has no such tier, so the
 * delegation half is carried as instructions; the rules mirror stock Codex's proactive spawn_agent guidance.
 */
export const CCODEX_ULTRA_INSTRUCTIONS = `The user selected the Ultra effort for this thread. Ultra means automatic task delegation, and selecting it is the user's explicit, standing request for proactive multi-agent work: do not wait to be asked before using sub-agents, and do not use the Workflow tool for this unless the user asks for a workflow. Delegate through the Agent tool, following these rules:
- First form a short high-level plan. Identify the immediate blocking task on the critical path and do that one yourself; identify sidecar tasks that can run in parallel and delegate those. Plan before delegating so you never hand off the blocker and then wait on it.
- Delegate concrete, bounded subtasks that materially advance the work without blocking your next local step. Launch independent agents in one message so they run concurrently.
- Run multiple independent information-seeking subtasks in parallel when the questions can be answered independently.
- Split implementation into disjoint slices with non-overlapping write sets and give each to its own agent; prefer bounded code-change tasks over read-only exploration when the write scope is clear. Have each agent list the files it changed.
- Keep work local when it is tightly coupled, too difficult to brief well, or your very next action depends on it.
- Do not redo delegated work yourself; integrate and review the results, and work on something non-overlapping meanwhile.
- A trivial or single-step request needs no delegation.
The user's own instructions still decide which model each sub-agent runs on and any task they say must not be delegated.`;

export function claudeDeveloperInstructions(value: string | null | undefined): string | null {
  return withoutAppContext(value);
}
