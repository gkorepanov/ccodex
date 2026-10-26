import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findInstalledCodex, loadConfig, stockCodex } from "../../src/config.js";

const env = { ...process.env };
let root: string;
const executable = (path: string, version?: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${version ? `echo "codex-cli ${version}"\n` : ""}`);
  chmodSync(path, 0o755);
  return path;
};

describe("the stock codex CCodex runs", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccodex-discovery-"));
    process.env.CCODEX_HOME = join(root, "ccodex");
    process.env.CODEX_INSTALL_DIR = join(root, "local-bin");
    executable(join(root, "ccodex", "bin", "codex"));
    mkdirSync(join(root, "local-bin"));
    symlinkSync(join(root, "ccodex", "bin", "codex"), join(root, "local-bin", "codex"));
  });
  afterEach(() => { process.env = { ...env }; });

  it("is the first codex on PATH that is not CCodex", () => {
    const npm = executable(join(root, "npm", "codex"));
    process.env.PATH = [join(root, "ccodex", "bin"), join(root, "local-bin"), join(root, "npm")].join(":");
    expect(findInstalledCodex()).toBe(npm);
  });

  it("at ~/.local/bin, where CCodex took the installer's link, is the codex the installer put there", () => {
    const standalone = executable(join(root, "codex-home", "packages", "standalone", "current", "bin", "codex"));
    mkdirSync(join(root, "ccodex", "backups"));
    symlinkSync(standalone, join(root, "ccodex", "backups", "remote-codex"));
    executable(join(root, "npm", "codex"));
    process.env.PATH = [join(root, "local-bin"), join(root, "ccodex", "bin"), join(root, "npm")].join(":");
    expect(findInstalledCodex()).toBe(join(root, "ccodex", "backups", "remote-codex"));
  });

  it("for the gateway: codex_binary if set; for a local Desktop launch, Desktop's own CLI; else the newest one", async () => {
    const npm = executable(join(root, "npm", "codex"), "0.159.2");
    const brew = executable(join(root, "brew", "codex"), "0.164.0");
    const desktop = executable(join(root, "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex"), "0.164.0-alpha.11.1");
    process.env.PATH = [join(root, "ccodex", "bin"), join(root, "npm"), join(root, "brew")].join(":");
    delete process.env.CCODEX_CODEX;
    process.env.CCODEX_CONFIG = join(root, "none.toml");
    // Over SSH (or from a terminal): the newest, a stable release above Desktop's alpha of it.
    expect(await stockCodex(loadConfig(), false, desktop)).toBe(brew);
    // Started by the App on this machine: what the App runs without CCodex; one that doesn't answer is passed over.
    expect(await stockCodex(loadConfig(), true, desktop)).toBe(desktop);
    expect(await stockCodex(loadConfig(), true, undefined)).toBe(brew);
    expect(await stockCodex(loadConfig(), true, executable(join(root, "broken", "codex")))).toBe(brew);
    process.env.CCODEX_CODEX = npm;
    expect(await stockCodex(loadConfig(), true, desktop)).toBe(npm);
  });
});
