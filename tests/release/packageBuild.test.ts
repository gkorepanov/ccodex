import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTINUATION_TEMPLATE } from "../../src/claude/goalTools.js";

const root = resolve(import.meta.dirname, "../..");

describe("release package build", () => {
  it("removes stale compiler output before rebuilding the publishable dist tree", () => {
    const stale = resolve(root, "dist/claude/core/removed-lifecycle.js");
    mkdirSync(resolve(stale, ".."), { recursive: true });
    writeFileSync(stale, "stale");

    execFileSync("npm", ["run", "build:ts"], { cwd: root, stdio: "pipe", timeout: 30_000 });

    expect(existsSync(stale)).toBe(false);
  }, 60_000);

  it("ships the byte-exact Codex prompt and separate CCodex extension in npm pack", () => {
    const cache = mkdtempSync(join(tmpdir(), "ccodex-npm-pack-"));
    try {
      const packed = JSON.parse(execFileSync(
        "npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--silent"],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, npm_config_cache: cache },
        },
      )) as Array<{ files: Array<{ path: string }> }>;
      const files = packed[0]!.files.map((file) => file.path);
      expect(files).toContain("vendor/codex/continuation.md");
      expect(files).toContain("assets/ccodex/goals/continuation.md");
      expect(files).toContain("config/compatibility.json");
      expect(files).toContain("examples/config.toml");
      expect(files).toContain("scripts/install.sh");
      expect(files).toContain("scripts/uninstall.sh");
      expect(files).toContain("scripts/postinstall.mjs");
      expect(files).toContain("legal/LICENSES.md");
      expect(files).toContain("legal/THIRD_PARTY_NOTICES.md");
      expect(files).not.toContain("compatibility.json");
      expect(files).not.toContain("config.example.toml");
      expect(files).not.toContain("install.sh");
      expect(files).not.toContain("uninstall.sh");
      const expected = [
        readFileSync(resolve(root, "vendor/codex/continuation.md"), "utf8").trim(),
        readFileSync(resolve(root, "assets/ccodex/goals/continuation.md"), "utf8").trim(),
      ].filter(Boolean).join("\n\n");
      expect(CONTINUATION_TEMPLATE).toBe(expected);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});
