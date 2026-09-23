import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findInstalledCodex } from "../../src/config.js";

const env = { ...process.env };
let root: string;
const executable = (path: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "#!/bin/sh\n"); chmodSync(path, 0o755); return path; };

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
});
