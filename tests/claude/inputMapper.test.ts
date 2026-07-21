import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mapUserInput } from "../../src/claude/inputMapper.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("mapUserInput", () => {
  it("maps an in-workspace image and rejects lexical and symlink escapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-hybrid-input-"));
    const outside = mkdtempSync(join(tmpdir(), "codex-hybrid-input-outside-"));
    directories.push(root, outside);
    writeFileSync(join(root, "inside.png"), "inside");
    writeFileSync(join(outside, "outside.png"), "outside");
    symlinkSync(outside, join(root, "link"));
    const context = { cwd: root, sandboxPolicy: { type: "workspaceWrite", writableRoots: [root] } };

    const mapped = await mapUserInput([{ type: "localImage", path: "inside.png" }], "uuid", context);
    expect((mapped.message.content as Array<{ source?: { data?: string } }>)[0]?.source?.data).toBe(Buffer.from("inside").toString("base64"));
    await expect(mapUserInput([{ type: "localImage", path: join(outside, "outside.png") }], "uuid", context)).rejects.toThrow("outside");
    await expect(mapUserInput([{ type: "localImage", path: join(root, "link", "outside.png") }], "uuid", context)).rejects.toThrow("outside");
  });

  it("accepts only HTTP(S) remote images", async () => {
    await expect(mapUserInput([{ type: "image", url: "file:///etc/passwd" }], "uuid")).rejects.toThrow("file:");
    const mapped = await mapUserInput([{ type: "image", url: "https://example.com/image.png" }], "uuid");
    expect((mapped.message.content as Array<{ source?: { url?: string } }>)[0]?.source?.url).toBe("https://example.com/image.png");
  });

  it("stamps only App-authored input as human", async () => {
    const human = await mapUserInput(
      [{ type: "text", text: "hello", text_elements: [] }],
      "human",
      { cwd: process.cwd(), sandboxPolicy: { type: "readOnly" }, origin: "human" },
    );
    const synthetic = await mapUserInput([{ type: "text", text: "hidden", text_elements: [] }], "synthetic");
    expect(human.origin).toEqual({ kind: "human" });
    expect(synthetic.origin).toBeUndefined();
  });
});
