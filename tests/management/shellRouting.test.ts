import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installLayout } from "../../src/management/layout.js";
import {
  fishManagedBlock, MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END, posixManagedBlock,
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
    const block = posixManagedBlock(install);
    expect(block.startsWith(`${MANAGED_BLOCK_BEGIN}\n`)).toBe(true);
    expect(block.trimEnd().endsWith(MANAGED_BLOCK_END)).toBe(true);
    expect(block).toContain(`export PATH="${install.bin}:$PATH"`);
  });

  it("exports CODEX_CLI_PATH to the desktop entry only on macOS", () => {
    const install = layout();
    const expected = `export CODEX_CLI_PATH="${join(install.bin, "codex-desktop")}"`;
    if (onDarwin) expect(posixManagedBlock(install)).toContain(expected);
    else expect(posixManagedBlock(install)).not.toContain("CODEX_CLI_PATH");
  });

  it("uses fish syntax for the CODEX_CLI_PATH export on macOS", () => {
    const install = layout();
    const expected = `set -gx CODEX_CLI_PATH "${join(install.bin, "codex-desktop")}"`;
    if (onDarwin) expect(fishManagedBlock(install)).toContain(expected);
    else expect(fishManagedBlock(install)).not.toContain("CODEX_CLI_PATH");
  });
});
