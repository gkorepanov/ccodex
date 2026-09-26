import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TranscriptPages, type PageSource } from "../../../src/claude/native/pages.js";
import { projectTranscript } from "../../../src/claude/native/projector.js";
import { readTranscriptRecords, type TranscriptRecord } from "../../../src/claude/native/records.js";
import { summarizeTranscript } from "../../../src/claude/native/summary.js";
import { NO_PEERS } from "../../../src/claude/peers.js";
import type { Turn } from "../../../src/protocol/codex.js";

const PROJECT = new URL("../../fixtures/nativeClaudeHome/projects/-home-user-project/", import.meta.url).pathname;
const PAGE = 5;

async function load(path: string) {
  const records: TranscriptRecord[] = [];
  for await (const record of readTranscriptRecords(path)) records.push(record);
  const header = summarizeTranscript(records);
  const full = await projectTranscript({ sessionId: "s", path, records, header, peers: NO_PEERS.directory });
  const source: PageSource = { sessionId: "s", path, header, peers: NO_PEERS.directory, peersVersion: "" };
  return { full, source };
}

/** Desktop's scroll back: the newest page, then each page before the oldest turn seen. */
async function scroll(pages: TranscriptPages, source: PageSource): Promise<Turn[]> {
  let window = await pages.newest(source, PAGE);
  let seen = window.turns.slice(-PAGE);
  let older = window.older || window.turns.length > PAGE;
  while (older) {
    const anchor = seen[0]!.id;
    window = await pages.around(source, anchor, PAGE);
    const before = window.turns.slice(0, window.turns.findIndex((turn) => turn.id === anchor));
    seen = [...before.slice(-PAGE), ...seen];
    older = window.older || before.length > PAGE;
  }
  return seen;
}

describe("paged transcript reads", () => {
  const fixtures = readdirSync(PROJECT).filter((name) => name.endsWith(".jsonl"));
  it.each(fixtures.flatMap((name) => [16 << 10, 256 << 10].map((chunk) => [name, chunk] as const)))(
    "pages %s (chunk %i) into the turns, items and boundaries of the whole transcript",
    async (name, chunk) => {
      const { full, source } = await load(join(PROJECT, name));
      const pages = new TranscriptPages(chunk);
      expect(await scroll(pages, source)).toEqual(full.turns);
      // A turn read on its own (`thread/items/list`) and its rollback anchor, from a fresh reader (a cursor after a restart).
      const fresh = new TranscriptPages(chunk);
      for (const [index, turn] of full.turns.entries()) {
        const { turns } = await fresh.around(source, turn.id, 0);
        expect(turns.find((candidate) => candidate.id === turn.id)).toEqual(turn);
        expect(await fresh.boundary(source, turn.id, true)).toBe(full.turnBoundaries[index]!.messageUuid);
      }
    },
    60_000,
  );

  it("keeps each prompt with its answers when 0.4's restored turns share one message id across steers", async () => {
    const record = (uuid: string, parentUuid: string | null, type: "user" | "assistant", text: string, second: number) => type === "user"
      ? { type, uuid, parentUuid, sessionId: "s", timestamp: new Date(second * 1000).toISOString(), message: { role: "user", content: text } }
      : { type, uuid, parentUuid, sessionId: "s", timestamp: new Date(second * 1000).toISOString(),
        message: { id: "msg_shared", role: "assistant", model: "claude-fable-5", content: [{ type: "text", text }], stop_reason: "end_turn" } };
    const lines = [
      record("p1", null, "user", "first", 1), record("a1", "p1", "assistant", "one", 2), record("a2", "a1", "assistant", "two", 3),
      record("p2", "a2", "user", "second", 4), record("a3", "p2", "assistant", "three", 5),
      record("p3", "a3", "user", "third", 6), record("a4", "p3", "assistant", "four", 7), record("a5", "a4", "assistant", "five", 8),
    ];
    const path = join(mkdtempSync(join(tmpdir(), "ccodex-pages-")), "s.jsonl");
    writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    const { full, source } = await load(path);
    expect(full.turns.map((turn) => turn.items.map((item) => item.id))).toEqual([
      ["p1", "a1:0", "a2:0"], ["p2", "a3:0"], ["p3", "a4:0", "a5:0"],
    ]);
    expect(await scroll(new TranscriptPages(128), source)).toEqual(full.turns);
  });
});
