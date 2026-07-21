import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RENAME_PROMPT } from "../../src/config/config.js";
import { installLayout } from "../../src/management/layout.js";
import { installInitialConfig } from "../../src/management/setup.js";

const roots: string[] = [];
const oldHome = process.env.CCODEX_HOME;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.CCODEX_HOME;
  else process.env.CCODEX_HOME = oldHome;
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ccodex-setup-config-"));
  roots.push(root);
  process.env.CCODEX_HOME = join(root, ".ccodex");
  const layout = installLayout();
  mkdirSync(layout.home, { recursive: true });
  return { layout, path: join(layout.home, "config.toml") };
}

describe("setup config bootstrap", () => {
  it("resolves runtime config before a supplied stage can move its own package", () => {
    const source = readFileSync(new URL("../../src/management/setup.ts", import.meta.url), "utf8");
    expect(source.indexOf("const publicSocket = loadConfig().publicSocket"))
      .toBeLessThan(source.indexOf("renameSync(staged, versionPath)"));
  });

  it("creates the first config with the editable default rename prompt", () => {
    const { layout, path } = fixture();
    expect(installInitialConfig(layout)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(DEFAULT_RENAME_PROMPT);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("never resurrects a removed or commented rename_prompt", () => {
    const { layout, path } = fixture();
    const existing = "# rename_prompt intentionally disabled\n[features]\nstatus_command = false\n";
    writeFileSync(path, existing, { mode: 0o600 });
    expect(installInitialConfig(layout)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(existing);
  });
});
