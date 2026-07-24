import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installLayout } from "../../src/management/layout.js";
import {
  fishManagedBlock,
  legacyPosixManagedBlock,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  migrateDesktopShellBlocks,
  posixManagedBlock,
  restoreShellBlockChanges,
} from "../../src/management/shellRouting.js";

const roots: string[] = [];
const savedHome = process.env.CCODEX_HOME;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.CCODEX_HOME;
  else process.env.CCODEX_HOME = savedHome;
});

function layout(): ReturnType<typeof installLayout> {
  const root = mkdtempSync(join(tmpdir(), "ccodex-shellrouting-"));
  roots.push(root);
  process.env.CCODEX_HOME = join(root, ".ccodex");
  return installLayout();
}

const onDarwin = process.platform === "darwin";

describe("managed shell routing block", () => {
  it("always prepends the managed bin to PATH inside the ccodex markers", () => {
    const install = layout();
    mkdirSync(install.home, { recursive: true });
    const block = posixManagedBlock(install);
    expect(block.startsWith(`${MANAGED_BLOCK_BEGIN}\n`)).toBe(true);
    expect(block.trimEnd().endsWith(MANAGED_BLOCK_END)).toBe(true);
    expect(block).toContain(`export PATH="${install.bin}:$PATH"`);
  });

  it("exports CODEX_CLI_PATH to the desktop entry only on macOS", () => {
    const install = layout();
    mkdirSync(install.home, { recursive: true });
    const expected = `export CODEX_CLI_PATH="${join(install.bin, "codex")}"`;
    if (onDarwin) expect(posixManagedBlock(install)).toContain(expected);
    else expect(posixManagedBlock(install)).not.toContain("CODEX_CLI_PATH");
  });

  it("uses fish syntax for the CODEX_CLI_PATH export on macOS", () => {
    const install = layout();
    const expected = `set -gx CODEX_CLI_PATH "${join(install.bin, "codex")}"`;
    if (onDarwin) expect(fishManagedBlock(install)).toContain(expected);
    else expect(fishManagedBlock(install)).not.toContain("CODEX_CLI_PATH");
  });

  it("migrates the exact legacy block and can transactionally restore it", () => {
    const install = layout();
    mkdirSync(install.home, { recursive: true });
    const path = join(install.home, "fixture.zshrc");
    const legacy = legacyPosixManagedBlock(install);
    writeFileSync(path, `user\n${legacy}`);
    const changes = migrateDesktopShellBlocks(install, [path], true);
    if (onDarwin) {
      expect(readFileSync(path, "utf8")).toContain(`CODEX_CLI_PATH="${join(install.bin, "codex")}"`);
      restoreShellBlockChanges(changes);
      expect(readFileSync(path, "utf8")).toBe(`user\n${legacy}`);
    } else {
      expect(changes).toEqual([]);
    }
  });

  it("refuses to rewrite a user-modified managed block", () => {
    const install = layout();
    mkdirSync(install.home, { recursive: true });
    const path = join(install.home, "modified.zshrc");
    writeFileSync(path, `${MANAGED_BLOCK_BEGIN}\nuser edit\n${MANAGED_BLOCK_END}\n`);
    if (onDarwin) {
      expect(() => migrateDesktopShellBlocks(install, [path], true)).toThrow("modified CCodex block");
    }
  });
});
