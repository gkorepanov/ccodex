import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StreamingFileChangePreview } from "../../src/claude/streamingFilePreview.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("streaming Claude file previews", () => {
  it("streams a partial Write and flushes the final snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-write-preview-"));
    directories.push(directory);
    const path = join(directory, "report.md");
    writeFileSync(path, "before\n");
    let now = 1_000;
    const preview = new StreamingFileChangePreview("Write", directory, () => now);
    const input = JSON.stringify({ file_path: path, content: "first line\nsecond line\n" });
    const split = input.indexOf("second line");

    const partial = await preview.push(input.slice(0, split));
    expect(partial).toMatchObject({ path, kind: { type: "update" } });
    expect(partial?.diff).toContain("+first line");

    now += 100;
    expect(await preview.push(input.slice(split))).toBeUndefined();
    const completed = await preview.finish();
    expect(completed?.diff).toContain("+second line");
  });

  it("decodes split escapes and streams an Edit against the original file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-edit-preview-"));
    directories.push(directory);
    const path = join(directory, "notes.txt");
    writeFileSync(path, "old value\nold value\n");
    const preview = new StreamingFileChangePreview("Edit", directory);
    const input = JSON.stringify({
      file_path: path, old_string: "old value", new_string: "new\n\"value\"", replace_all: true,
    });
    const escape = input.indexOf("\\n") + 1;

    await preview.push(input.slice(0, escape));
    await preview.push(input.slice(escape));
    const completed = await preview.finish();
    expect(completed).toMatchObject({ path, kind: { type: "update" } });
    expect(completed?.diff.match(/\+new/g)).toHaveLength(2);
    expect(completed?.diff).toContain('"value"');
  });
});
