import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toolPolicy } from "../../src/claude/permissionPolicy.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("restrictive Claude tool policy", () => {
  it("forces shell approval for on-request and denies read-only mutation", () => {
    expect(toolPolicy("Bash", { command: "pwd" }, "/repo", "on-request", { type: "workspaceWrite", writableRoots: ["/repo"] })).toMatchObject({ decision: "ask" });
    expect(toolPolicy("Edit", { file_path: "/repo/a" }, "/repo", "never", { type: "readOnly" })).toMatchObject({ decision: "deny" });
  });

  it("denies lexical and symlink escapes from writable roots", () => {
    const base = mkdtempSync(join(tmpdir(), "codex-hybrid-policy-"));
    directories.push(base);
    const root = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, join(root, "link"));
    const sandbox = { type: "workspaceWrite", writableRoots: [root] };
    expect(toolPolicy("Write", { file_path: join(root, "ok.txt") }, root, "never", sandbox)).toEqual({ decision: "defer" });
    expect(toolPolicy("Write", { file_path: join(root, "..", "outside.txt") }, root, "never", sandbox)).toMatchObject({ decision: "deny" });
    expect(toolPolicy("Write", { file_path: join(root, "link", "escape.txt") }, root, "never", sandbox)).toMatchObject({ decision: "deny" });
  });
});
