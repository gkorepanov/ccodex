import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { compatibilityManifest } from "../../src/compatibility/probe.js";
import { installLayout } from "../../src/management/layout.js";
import { posixManagedBlock } from "../../src/management/shellRouting.js";
import { rollback, uninstall } from "../../src/management/lifecycle.js";
import type { InstallManifest } from "../../src/management/setup.js";

const roots: string[] = [];
const oldHome = process.env.HOME;
const oldProductHome = process.env.CCODEX_HOME;
const oldCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.HOME = oldHome;
  process.env.CCODEX_HOME = oldProductHome;
  process.env.CODEX_HOME = oldCodexHome;
});

function fixture(): { root: string; layout: ReturnType<typeof installLayout>; manifest: InstallManifest } {
  const root = mkdtempSync(join(tmpdir(), "ccodex-lifecycle-"));
  roots.push(root);
  process.env.HOME = root;
  process.env.CCODEX_HOME = join(root, ".ccodex");
  process.env.CODEX_HOME = join(root, ".codex");
  const layout = installLayout();
  for (const path of [layout.bin, layout.versions, layout.staging, layout.state]) mkdirSync(path, { recursive: true });
  for (const version of ["0.2.9", "0.3.0"]) mkdirSync(join(layout.versions, version), { recursive: true });
  symlinkSync(join("versions", "0.3.0"), layout.current);
  symlinkSync(join("versions", "0.2.9"), layout.previous);
  const shell = join(root, ".zshrc");
  writeFileSync(shell, `user config\n${posixManagedBlock(layout)}`);
  const shimHashes: Record<string, string> = {};
  for (const name of ["ccodex", "codex"]) {
    const path = join(layout.bin, name);
    writeFileSync(path, "owned shim\n");
    shimHashes[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  const remotePath = join(root, ".local", "bin", "codex");
  const backupPath = join(layout.home, "backups", "remote-codex");
  mkdirSync(join(root, ".local", "bin"), { recursive: true });
  mkdirSync(join(layout.home, "backups"), { recursive: true });
  writeFileSync(backupPath, "stock codex\n");
  symlinkSync(join(layout.bin, "codex"), remotePath);
  const manifest: InstallManifest = {
    schemaVersion: 1,
    method: "npm",
    package: "@gkorepanov/ccodex",
    activeVersion: "0.3.0",
    previousVersion: "0.2.9",
    managedShellFiles: [shell],
    shimHashes,
    remoteCodexShim: { path: remotePath, target: join(layout.bin, "codex"), backupPath },
    platformPackage: "fixture",
    compatibility: compatibilityManifest(),
    doctor: { ok: true, checkedAt: new Date(0).toISOString() },
    installedAt: new Date(0).toISOString(),
  };
  writeFileSync(layout.manifest, JSON.stringify(manifest));
  return { root, layout, manifest };
}

describe("public install lifecycle", () => {
  it("atomically swaps active and previous versions on rollback", async () => {
    const { layout } = fixture();
    await rollback([]);
    expect(readlinkSync(layout.current)).toBe(join("versions", "0.2.9"));
    expect(readlinkSync(layout.previous)).toBe(join("versions", "0.3.0"));
    expect(JSON.parse(readFileSync(layout.manifest, "utf8"))).toMatchObject({
      activeVersion: "0.2.9", previousVersion: "0.3.0",
    });
  });

  it("removes owned routing but preserves state by default", async () => {
    const { root, layout } = fixture();
    writeFileSync(join(layout.state, "state.sqlite"), "state");
    await uninstall([]);
    expect(existsSync(layout.current)).toBe(false);
    expect(existsSync(join(layout.state, "state.sqlite"))).toBe(true);
    expect(readFileSync(join(root, ".zshrc"), "utf8")).toBe("user config\n");
    expect(readFileSync(join(root, ".local", "bin", "codex"), "utf8")).toBe("stock codex\n");
  });

  it("preserves a user-modified shim", async () => {
    const { layout } = fixture();
    writeFileSync(join(layout.bin, "codex"), "user modification\n");
    await uninstall(["--purge", "--yes"]);
    expect(readFileSync(join(layout.bin, "codex"), "utf8")).toBe("user modification\n");
    expect(existsSync(layout.state)).toBe(false);
  });
});
