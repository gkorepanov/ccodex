import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCodexRolloutLocator, parseRolloutChunk } from "../../../src/claude/session/codexRollout.js";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

const meta = (source: string, timestamp: string) => line({
  timestamp, type: "session_meta", payload: {
    session_id: "s", id: "s", timestamp, cwd: "/", source,
    // Real journals embed the full codex system prompt here, pushing the first
    // line to tens of kilobytes — keep the fixture realistically long.
    base_instructions: { text: "You are Codex. ".repeat(1_500) },
  },
});

describe("parseRolloutChunk", () => {
  it("maps agent messages, reasoning, and turn completion, ignoring other events", () => {
    const chunk = line({ type: "event_msg", payload: { type: "agent_message", message: "hi", phase: "commentary" } })
      + line({ type: "event_msg", payload: { type: "agent_reasoning", text: "thinking" } })
      + line({ type: "event_msg", payload: { type: "user_message", message: "prompt" } })
      + line({ type: "response_item", payload: { type: "message", role: "assistant" } })
      + line({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "hi" } });
    const { rest, events } = parseRolloutChunk("", chunk);
    expect(rest).toBe("");
    expect(events).toEqual([
      { kind: "message", text: "hi" },
      { kind: "reasoning", text: "thinking" },
      { kind: "turnComplete" },
    ]);
  });

  it("buffers partial lines across chunks and survives malformed lines", () => {
    const full = line({ type: "event_msg", payload: { type: "agent_message", message: "split" } });
    const first = parseRolloutChunk("", `not json\n${full.slice(0, 25)}`);
    expect(first.events).toEqual([]);
    expect(first.rest).toBe(full.slice(0, 25));
    const second = parseRolloutChunk(first.rest, full.slice(25));
    expect(second.events).toEqual([{ kind: "message", text: "split" }]);
    expect(second.rest).toBe("");
  });
});

describe("defaultCodexRolloutLocator", () => {
  const makeSessionsDir = (name: string) => {
    const root = join(tmpdir(), `ccodex-rollout-${name}-${process.pid}`);
    const day = join(root, "2026", "08", "19");
    mkdirSync(day, { recursive: true });
    return { root, day };
  };

  it("finds a journal by codex thread id", () => {
    const { root, day } = makeSessionsDir("by-thread");
    const path = join(day, "rollout-2026-08-19T10-00-00-thread-1.jsonl");
    writeFileSync(path, meta("mcp", "2026-08-19T08:00:00.000Z"));
    const locator = defaultCodexRolloutLocator(root);
    expect(locator.byThreadId("thread-1")).toBe(path);
    expect(locator.byThreadId("missing")).toBeUndefined();
  });

  it("picks the earliest unclaimed fresh mcp session, skipping stale and non-mcp journals", () => {
    const { root, day } = makeSessionsDir("fresh");
    const notBefore = Date.parse("2026-08-19T12:00:00.000Z");
    const stale = join(day, "rollout-2026-08-19T09-00-00-old.jsonl");
    const cli = join(day, "rollout-2026-08-19T12-00-01-cli.jsonl");
    const early = join(day, "rollout-2026-08-19T12-00-02-a.jsonl");
    const late = join(day, "rollout-2026-08-19T12-00-05-b.jsonl");
    writeFileSync(stale, meta("mcp", "2026-08-19T09:00:00.000Z"));
    writeFileSync(cli, meta("cli", "2026-08-19T12:00:01.000Z"));
    writeFileSync(early, meta("mcp", "2026-08-19T12:00:02.000Z"));
    writeFileSync(late, meta("mcp", "2026-08-19T12:00:05.000Z"));
    const locator = defaultCodexRolloutLocator(root);
    expect(locator.freshMcpSession(notBefore, new Set())).toBe(early);
    expect(locator.freshMcpSession(notBefore, new Set([early]))).toBe(late);
    expect(locator.freshMcpSession(notBefore, new Set([early, late]))).toBeUndefined();
  });
});
