import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installLayout } from "../../src/management/layout.js";
import { setup } from "../../src/management/setup.js";

const roots: string[] = [];
const saved = { HOME: process.env.HOME, CCODEX_HOME: process.env.CCODEX_HOME, PATH: process.env.PATH };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function fixture(version: string, exitCode = 0): { root: string; stage: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "ccodex-setup-handoff-"));
  roots.push(root);
  process.env.HOME = root;
  process.env.CCODEX_HOME = join(root, ".ccodex");
  const stage = join(root, "stage");
  const bin = join(stage, "node_modules", ".bin");
  const config = join(stage, "node_modules", "@gkorepanov", "ccodex", "config");
  const log = join(root, "calls");
  mkdirSync(bin, { recursive: true });
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "compatibility.json"), JSON.stringify({ productVersion: version }));
  writeFileSync(join(bin, "ccodex"), `#!/bin/sh\nprintf '%s\\n' "$*" >>${JSON.stringify(log)}\nexit ${exitCode}\n`);
  chmodSync(join(bin, "ccodex"), 0o755);
  return { root, stage, log };
}

describe("cross-version setup handoff", () => {
  it("lets a newer staged CLI own setup", async () => {
    const { stage, log } = fixture("99.0.0");
    expect(await setup(["--staged", stage, "--version", "99.0.0"])).toBe(0);
    expect(readFileSync(log, "utf8").trim()).toBe(`setup --staged ${stage} --version 99.0.0`);
    expect(existsSync(installLayout().current)).toBe(false);
  });

  it("returns a staged setup failure without activating anything", async () => {
    const { stage } = fixture("99.0.0", 7);
    expect(await setup(["--staged", stage, "--version", "99.0.0"])).toBe(7);
    expect(existsSync(installLayout().current)).toBe(false);
  });

  it("keeps downgrades in the newer setup implementation", async () => {
    const { stage, log } = fixture("0.0.1");
    await expect(setup(["--staged", stage, "--version", "0.0.1"]))
      .rejects.toThrow("Staged CCodex doctor failed");
    expect(readFileSync(log, "utf8")).toContain("doctor --json");
    expect(readFileSync(log, "utf8")).not.toContain("setup --staged");
  });

  it("removes an internally-created stage after a failed handoff", async () => {
    const { root, stage } = fixture("99.0.0", 7);
    const tools = join(root, "tools");
    mkdirSync(tools);
    writeFileSync(join(tools, "npm"), `#!/bin/sh\ncp -R ${JSON.stringify(`${stage}/.`)} "$3"\n`);
    chmodSync(join(tools, "npm"), 0o755);
    process.env.PATH = `${tools}${delimiter}${process.env.PATH ?? ""}`;
    expect(await setup(["--version", "99.0.0"])).toBe(7);
    expect(existsSync(join(installLayout().staging, `99.0.0-${process.pid}`))).toBe(false);
  });
});
