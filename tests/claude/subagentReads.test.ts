import { appendFileSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import type { Gateway } from "../../src/gateway/server.js";
import type { Logger } from "../../src/log.js";
import type { ClaudeSession } from "../../src/claude/session.js";
import { ClaudeThreads } from "../../src/claude/threads.js";

/** Bytes read of each file: in ranges, whole (meta.json), streamed (a whole transcript's records). */
const { reads, count } = vi.hoisted(() => {
  const reads = new Map<string, number>();
  return { reads, count: (path: unknown, bytes: number) => reads.set(String(path), (reads.get(String(path)) ?? 0) + bytes) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const range = args[1] as { start?: number; end?: number } | undefined;
      count(args[0], (range?.end ?? actual.statSync(args[0]).size - 1) + 1 - (range?.start ?? 0));
      return actual.createReadStream(...args);
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle) as (...rest: unknown[]) => Promise<{ bytesRead: number }>;
      return Object.assign(handle, { read: async (...rest: unknown[]) => { const result = await read(...rest); count(args[0], result.bytesRead); return result; } });
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const content = await actual.readFile(...args);
      count(args[0], content.length);
      return content;
    },
  };
});

const OUTPUT = "x".repeat(64 << 10);

function record(agentId: string, uuid: string, parentUuid: string | null, second: number, fields: object) {
  return JSON.stringify({ uuid, parentUuid, timestamp: `2026-10-18T00:00:${String(second).padStart(2, "0")}.000Z`, sessionId: "root", agentId, isSidechain: true, cwd: "/work", ...fields });
}

/** A sub-agent's transcript of one turn: its task, `calls` commands with long output, a call still running. */
function transcript(agentId: string, calls: number): string[] {
  const call = (index: number, parent: string) => record(agentId, `${agentId}-call-${index}`, parent, index + 1, {
    type: "assistant", message: { id: `${agentId}-message-${index}`, role: "assistant", model: "claude-sonnet-5", content: [{ type: "tool_use", id: `${agentId}-tool-${index}`, name: "Bash", input: { command: "true" } }], stop_reason: "tool_use" },
  });
  const result = (index: number) => record(agentId, `${agentId}-result-${index}`, `${agentId}-call-${index}`, index + 1, {
    type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${agentId}-tool-${index}`, content: OUTPUT }] },
  });
  const lines = [record(agentId, `${agentId}-prompt`, null, 0, { type: "user", message: { role: "user", content: "Task" } })];
  for (let index = 0; index < calls; index++) lines.push(call(index, index ? `${agentId}-result-${index - 1}` : `${agentId}-prompt`), result(index));
  lines.push(call(calls, calls ? `${agentId}-result-${calls - 1}` : `${agentId}-prompt`));
  return lines;
}

/** A Claude home with session `root` and its two sub-agents, `worker` (2 MB of transcript) and `sibling`. */
function home() {
  const root = mkdtempSync(join(tmpdir(), "ccodex-subagent-reads-"));
  const project = join(root, "projects", "-work");
  const subagents = join(project, "root", "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(project, "root.jsonl"), `${JSON.stringify({ type: "user", uuid: "root-prompt", parentUuid: null, timestamp: "2026-10-18T00:00:00.000Z", sessionId: "root", cwd: "/work", message: { role: "user", content: "Hello" } })}\n`);
  for (const [agentId, description, calls] of [["worker", "Inspect code", 32], ["sibling", "Inspect tests", 2]] as const) {
    writeFileSync(join(subagents, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "Explore", description, toolUseId: `spawn-${agentId}`, spawnDepth: 1 }));
    writeFileSync(join(subagents, `agent-${agentId}.jsonl`), `${transcript(agentId, calls).join("\n")}\n`);
  }
  const events: { threadId: string; method: string; params: any }[] = [];
  const gateway = {
    meta: { section: () => undefined, isArchived: () => false }, sections: new Map(), broadcast: () => undefined,
    emit: (threadId: string, method: string, params: unknown) => events.push({ threadId, method, params }),
  } as unknown as Gateway;
  // No Claude runs here: a read that asked it for its models would fail.
  const config = { claudeHome: root, dataDir: root, modelPrefix: "claude:", claudeBinary: join(root, "no-claude") } as Config;
  const threads = new ClaudeThreads(config, gateway, { info: () => undefined, warn: () => undefined } as unknown as Logger);
  return { threads, events, worker: join(subagents, "agent-worker"), sibling: join(subagents, "agent-sibling") };
}

describe("Claude sub-agent reads", () => {
  it("lists a session's sub-agents from their meta.json and the two ends of their transcripts", async () => {
    const { threads, worker } = home();
    await threads.catalog.refresh();
    reads.clear();
    const listed = await threads.subagentThreads("root");
    expect(listed.map((thread) => [thread.id, thread.parentThreadId, thread.agentNickname, thread.status.type, thread.preview]))
      .toEqual([["agent-sibling", "root", "Inspect tests [Sonnet 5]", "active", "Task"], ["agent-worker", "root", "Inspect code [Sonnet 5]", "active", "Task"]]);
    expect(reads.get(`${worker}.jsonl`)).toBeLessThan(statSync(`${worker}.jsonl`).size / 8);
  });

  it("reads a sub-agent's pages and follows it live from its own transcript alone, the new part of it only", async () => {
    const { threads, events, worker, sibling } = home();
    await threads.catalog.refresh();
    reads.clear();
    expect(await threads.thread("agent-worker")).toMatchObject({ agentNickname: "Inspect code [Sonnet 5]", status: { type: "active" } });
    const page = await threads.turnsPage("agent-worker", { limit: 5, itemsView: "notLoaded" });
    expect(page.data.map((turn: any) => [turn.id, turn.status])).toEqual([["worker-prompt", "inProgress"]]);
    const items = await threads.itemsPage("agent-worker", { turnId: "worker-prompt", limit: 100, sortDirection: "desc" });
    expect(items.data).toHaveLength(1 + 33);

    const size = statSync(`${worker}.jsonl`).size;
    const before = reads.get(`${worker}.jsonl`)!;
    threads.subagentSpawned({ threadId: "root", settings: { cwd: "/work" } } as unknown as ClaudeSession,
      { receiverThreadIds: ["agent-worker"], prompt: "Task", model: "claude-sonnet-5", agentsStates: { "agent-worker": { message: "Inspect code" } } }, true);
    appendFileSync(`${worker}.jsonl`, `${record("worker", "worker-result-32", "worker-call-32", 40, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "worker-tool-32", content: "ok" }] } })}\n`
      + `${record("worker", "worker-answer", "worker-result-32", 41, { type: "assistant", message: { id: "worker-answer", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" } })}\n`);
    threads.subagentActivity("agent-worker");
    await threads.subagentFinished("agent-worker");
    expect(events.filter((event) => event.method === "item/completed").map((event) => event.params.item.text ?? event.params.item.type).at(-1)).toBe("Done");
    expect(events.find((event) => event.method === "turn/completed")?.params.turn).toMatchObject({ id: "worker-prompt", status: "completed" });
    expect(reads.get(`${worker}.jsonl`)! - before).toBeLessThan(size / 4);
    expect([...reads.keys()].filter((path) => path.startsWith(sibling))).toEqual([]);
  });
});
