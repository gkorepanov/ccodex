import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffFile, snapshotFile } from "../../src/claude/fileSnapshots.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("verified file snapshots", () => {
  it("builds an update diff from actual pre/post contents", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codex-hybrid-diff-"));
    directories.push(cwd);
    const path = join(cwd, "example.txt");
    writeFileSync(path, "before\n");
    const snapshot = await snapshotFile("Edit", { file_path: "example.txt" }, cwd);
    writeFileSync(path, "after\n");
    const change = await diffFile(snapshot!);
    expect(change).toMatchObject({ path, kind: { type: "update", move_path: null } });
    expect(change?.diff).toContain("-before");
    expect(change?.diff).toContain("+after");
  });

  it("classifies creation and ignores an unchanged file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codex-hybrid-diff-"));
    directories.push(cwd);
    const snapshot = await snapshotFile("Write", { file_path: "new.txt" }, cwd);
    writeFileSync(join(cwd, "new.txt"), "created\n");
    expect(await diffFile(snapshot!)).toMatchObject({ kind: { type: "add" } });
    const unchanged = await snapshotFile("Edit", { file_path: "new.txt" }, cwd);
    expect(await diffFile(unchanged!)).toBeUndefined();
  });
});
