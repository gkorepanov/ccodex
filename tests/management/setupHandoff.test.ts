import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compatibilityManifest } from "../../src/compatibility/probe.js";
import { update } from "../../src/management/lifecycle.js";
import { installLayout } from "../../src/management/layout.js";
import { setup, type InstallManifest } from "../../src/management/setup.js";

// Every case here must return or throw before setup() activates: activation calls
// installCliPathAgent(), which drives the developer's real launchctl and LaunchAgent.

const roots: string[] = [];
const saved = {
  HOME: process.env.HOME,
  CCODEX_HOME: process.env.CCODEX_HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  PATH: process.env.PATH,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete process.env.CCODEX_SETUP_HANDOFF;
});

function fakeCli(log: string, marker: string, exit: number): string {
  return `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + " " + process.env.CCODEX_HOME + "\\n");
if (process.argv[2] === "doctor") process.stdout.write('{"ok":false,"checks":[]}');
if (process.argv[2] === "setup") writeFileSync(${JSON.stringify(marker)}, "post-activation step\\n");
process.exit(${exit});
`;
}

function plantStage(stage: string, version: string, log: string, marker: string, exit: number): string {
  const bin = join(stage, "node_modules", ".bin");
  const config = join(stage, "node_modules", "@gkorepanov", "ccodex", "config");
  mkdirSync(bin, { recursive: true });
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "compatibility.json"), JSON.stringify({ productVersion: version, relayPackages: {} }));
  writeFileSync(join(bin, "ccodex"), fakeCli(log, marker, exit));
  chmodSync(join(bin, "ccodex"), 0o755);
  return stage;
}

function fixture(version: string, exit = 0): {
  root: string;
  staged: string;
  log: string;
  marker: string;
  layout: ReturnType<typeof installLayout>;
} {
  const root = mkdtempSync(join(tmpdir(), "ccodex-handoff-"));
  roots.push(root);
  process.env.HOME = root;
  process.env.CCODEX_HOME = join(root, ".ccodex");
  process.env.CODEX_HOME = join(root, ".codex");
  const log = join(root, "calls");
  const marker = join(root, "post-activation");
  const staged = plantStage(join(root, "stage"), version, log, marker, exit);
  return { root, staged, log, marker, layout: installLayout() };
}

function installed(root: string, layout: ReturnType<typeof installLayout>, active: string): string {
  for (const path of [layout.bin, layout.versions, layout.staging, layout.state]) mkdirSync(path, { recursive: true });
  for (const version of ["0.2.9", active]) mkdirSync(join(layout.versions, version), { recursive: true });
  symlinkSync(join("versions", active), layout.current);
  symlinkSync(join("versions", "0.2.9"), layout.previous);
  const manifest: InstallManifest = {
    schemaVersion: 1,
    method: "npm",
    package: "@gkorepanov/ccodex",
    activeVersion: active,
    previousVersion: "0.2.9",
    managedShellFiles: [join(root, ".zshrc")],
    shimHashes: {},
    platformPackage: "fixture",
    compatibility: compatibilityManifest(),
    doctor: { ok: true, checkedAt: new Date(0).toISOString() },
    installedAt: new Date(0).toISOString(),
  };
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(layout.manifest, content);
  return content;
}

function fakeNpm(root: string, template: string, log: string): void {
  const bin = join(root, "npm-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npm"), `#!/bin/sh
echo "$1" >>"${log}"
if [ "$1" = view ]; then printf '"99.0.0"\\n'; exit 0; fi
if [ "$1" = install ] && [ "$2" = --prefix ]; then
  mkdir -p "$3" && cp -R "${template}/." "$3" && chmod 755 "$3/node_modules/.bin/ccodex" && exit 0
fi
exit 1
`);
  chmodSync(join(bin, "npm"), 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
}

describe("cross-version setup handoff", () => {
  it("hands off before it can activate anything", () => {
    const source = readFileSync(new URL("../../src/management/setup.ts", import.meta.url), "utf8");
    expect(source).toContain("return await handOffSetup(staged, requestedVersion, layout);");
    expect(source.indexOf("return await handOffSetup(staged, requestedVersion, layout);"))
      .toBeLessThan(source.indexOf("activate(layout, requestedVersion)"));
  });

  it("lets the version being installed run its own post-activation step", async () => {
    const { staged, log, marker, layout } = fixture("99.0.0");
    expect(await setup(["--staged", staged, "--version", "99.0.0"])).toBe(0);
    expect(readFileSync(log, "utf8").trim())
      .toBe(`setup --staged ${staged} --version 99.0.0 ${layout.home}`);
    expect(readFileSync(marker, "utf8")).toBe("post-activation step\n");
    expect(existsSync(layout.current)).toBe(false);
    expect(existsSync(layout.previous)).toBe(false);
    expect(existsSync(layout.manifest)).toBe(false);
    expect(existsSync(staged)).toBe(true);
  });

  it("activates nothing when the handoff fails", async () => {
    const { staged, marker, layout } = fixture("99.0.0", 7);
    expect(await setup(["--staged", staged, "--version", "99.0.0"])).toBe(7);
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(layout.current)).toBe(false);
    expect(existsSync(layout.previous)).toBe(false);
    expect(existsSync(layout.manifest)).toBe(false);
  });

  it("never hands off to its own version", async () => {
    const version = compatibilityManifest().productVersion;
    const { staged, log } = fixture(version, 1);
    await expect(setup(["--staged", staged, "--version", version])).rejects.toThrow("Staged CCodex doctor failed");
    expect(readFileSync(log, "utf8")).toContain("doctor --json");
    expect(readFileSync(log, "utf8")).not.toContain("setup --staged");
  });

  it("keeps a downgrade in the newer code that still tracks the desktop hook", async () => {
    const { staged, log } = fixture("0.0.1", 1);
    await expect(setup(["--staged", staged, "--version", "0.0.1"])).rejects.toThrow("Staged CCodex doctor failed");
    expect(readFileSync(log, "utf8")).not.toContain("setup --staged");
  });

  it("cannot recurse into a further handoff", async () => {
    process.env.CCODEX_SETUP_HANDOFF = "1";
    const { staged, log } = fixture("99.0.0", 1);
    await expect(setup(["--staged", staged, "--version", "99.0.0"])).rejects.toThrow("Staged CCodex doctor failed");
    expect(readFileSync(log, "utf8")).not.toContain("setup --staged");
  });

  it("refuses to hand off to a stage that is not the requested version", async () => {
    const { staged, log } = fixture("99.0.0");
    await expect(setup(["--staged", staged, "--version", "99.0.1"])).rejects.toThrow("Staged package is 99.0.0");
    expect(existsSync(log)).toBe(false);
  });

  it("refuses to hand off to a stage it cannot read", async () => {
    const { staged, log } = fixture("99.0.0");
    rmSync(join(staged, "node_modules", "@gkorepanov", "ccodex", "config", "compatibility.json"));
    await expect(setup(["--staged", staged, "--version", "99.0.0"])).rejects.toThrow("is unreadable");
    expect(existsSync(log)).toBe(false);
  });
});

describe("update through the handoff", () => {
  it("still delegates to setup", () => {
    const source = readFileSync(new URL("../../src/management/lifecycle.ts", import.meta.url), "utf8");
    expect(source).toContain("return setup([\"--version\", latest]);");
  });

  it("stages once and leaves activation to the staged version", async () => {
    const { root, log, marker, layout } = fixture("99.0.0");
    const manifest = installed(root, layout, "0.4.6");
    fakeNpm(root, join(root, "stage"), join(root, "npm-calls"));
    expect(await update([])).toBe(0);
    const staged = join(layout.staging, `99.0.0-${process.pid}`);
    expect(readFileSync(join(root, "npm-calls"), "utf8")).toBe("view\ninstall\n");
    expect(readFileSync(log, "utf8").trim())
      .toBe(`setup --staged ${staged} --version 99.0.0 ${layout.home}`);
    expect(readFileSync(marker, "utf8")).toBe("post-activation step\n");
    expect(readlinkSync(layout.current)).toBe(join("versions", "0.4.6"));
    expect(readlinkSync(layout.previous)).toBe(join("versions", "0.2.9"));
    expect(readFileSync(layout.manifest, "utf8")).toBe(manifest);
  });

  it("removes the staging tree when the handoff fails", async () => {
    const { root, layout } = fixture("99.0.0", 7);
    installed(root, layout, "0.4.6");
    fakeNpm(root, join(root, "stage"), join(root, "npm-calls"));
    expect(await update([])).toBe(7);
    expect(existsSync(join(layout.staging, `99.0.0-${process.pid}`))).toBe(false);
  });

  it("short-circuits --check before staging anything", async () => {
    const { root, log, layout } = fixture("99.0.0");
    installed(root, layout, "0.4.6");
    fakeNpm(root, join(root, "stage"), join(root, "npm-calls"));
    expect(await update(["--check"])).toBe(0);
    expect(readFileSync(join(root, "npm-calls"), "utf8")).toBe("view\n");
    expect(existsSync(log)).toBe(false);
  });

  it("does nothing when the resolved version is already active", async () => {
    const { root, log, layout } = fixture("99.0.0");
    installed(root, layout, "99.0.0");
    fakeNpm(root, join(root, "stage"), join(root, "npm-calls"));
    expect(await update([])).toBe(0);
    expect(readFileSync(join(root, "npm-calls"), "utf8")).toBe("view\n");
    expect(existsSync(log)).toBe(false);
  });
});
