import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shim } from "../../src/management/commands.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Runs a shim with nodes that print which of them ran and the PATH they got. */
function run(name: "codex" | "ccodex", platform: NodeJS.Platform, withApp: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "ccodex-shim-"));
  roots.push(root);
  const node = (path: string, label: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `#!/bin/sh\necho "${label} $PATH"\n`, { mode: 0o755 });
    return path;
  };
  const setupNode = node(join(root, "setup node", "bin", "node"), "setup");
  if (withApp) node(join(root, "home", "Applications", "ChatGPT.app", "Contents", "Resources", "cua_node", "bin", "node"), "app");
  writeFileSync(join(root, "shim"), shim(name, setupNode, platform), { mode: 0o755 });
  return execFileSync(join(root, "shim"), ["--version"], { encoding: "utf8", env: { HOME: join(root, "home"), PATH: "/usr/bin:/bin" } }).trim();
}

describe("CCodex shims", () => {
  it("run the codex the macOS App starts on the App's own Node, setup's Node still on PATH", () => {
    expect(run("codex", "darwin", true)).toMatch(/^app \/usr\/bin:\/bin:.*\/setup node\/bin$/u);
  });

  it("keep setup's Node without the App, on Linux, and for management commands", () => {
    expect(run("codex", "darwin", false)).toBe("setup /usr/bin:/bin");
    expect(run("codex", "linux", true)).toBe("setup /usr/bin:/bin");
    expect(run("ccodex", "darwin", true)).toBe("setup /usr/bin:/bin");
  });
});
