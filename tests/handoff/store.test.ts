import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import { HandoffStore } from "../../src/handoff/store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("HandoffStore", () => {
  it("persists staged switches and stock display overlays", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-handoff-store-"));
    directories.push(directory);
    const path = join(directory, "handoffs.sqlite");
    const first = new HandoffStore(path);
    first.setPending({
      threadId: "source", sourceProvider: "claude", targetProvider: "stock", targetModel: "gpt-5.6-sol",
      settings: { threadId: "source", model: "gpt-5.6-sol", effort: "high" },
    });
    const firstRevision = first.getPending("source")!.revision!;
    first.setPending({
      threadId: "source", sourceProvider: "claude", targetProvider: "stock", targetModel: "gpt-5.6-sol",
      settings: { threadId: "source", model: "gpt-5.6-sol", effort: "medium" },
    });
    expect(first.clearPending("source", firstRevision)).toBe(false);
    expect(first.getPending("source")).toMatchObject({ revision: firstRevision + 1, settings: { effort: "medium" } });
    const sourceThread = {
      id: "source", forkedFromId: null, turns: [], name: "source name", preview: "hello",
    } as unknown as Thread;
    first.setOverlay({
      threadId: "target", sourceThreadId: "source", sourceThread,
      inheritedTurns: [{ id: "turn-1", items: [], status: "completed" } as never],
    });
    first.close();

    const second = new HandoffStore(path);
    expect(second.getPending("source")).toMatchObject({ targetModel: "gpt-5.6-sol", settings: { effort: "medium" } });
    expect(second.getOverlay("target")).toMatchObject({
      sourceThreadId: "source", sourceThread: { name: "source name" }, inheritedTurns: [{ id: "turn-1" }],
    });
    second.clearPending("source");
    second.clearOverlay("target");
    expect(second.getPending("source")).toBeUndefined();
    expect(second.getOverlay("target")).toBeUndefined();
    second.close();
  });

  it("recovers queued and interrupted daemon-owned handoff jobs", () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-handoff-jobs-"));
    directories.push(directory);
    const path = join(directory, "handoffs.sqlite");
    const first = new HandoffStore(path);
    first.createJob({
      id: "queued",
      sourceThreadId: "source",
      params: { threadId: "source", model: "gpt-5.6-sol", lastTurnId: "turn-1" },
    });
    first.createJob({
      id: "running",
      sourceThreadId: "source",
      params: { threadId: "source", model: "gpt-5.6-sol", lastTurnId: "turn-1" },
    });
    first.markJobRunning("running");
    first.close();

    const second = new HandoffStore(path);
    expect(second.recoverableJobs().map((job) => [job.id, job.status])).toEqual([
      ["queued", "queued"],
      ["running", "queued"],
    ]);
    second.failJob("queued", "provider unavailable");
    expect(second.claimFailedJob("source")).toBe("provider unavailable");
    expect(second.claimFailedJob("source")).toBeUndefined();
    second.close();
  });
});
