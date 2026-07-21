import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { delegatedCodexExecutable, findDelegatedCodex, loadConfig } from "../../src/config/config.js";

const roots: string[] = [];
const oldPath = process.env.PATH;
const oldDelegate = process.env.CCODEX_DELEGATE_CODEX;
const oldHome = process.env.CCODEX_HOME;
const oldConfig = process.env.CCODEX_CONFIG;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PATH = oldPath;
  if (oldDelegate === undefined) delete process.env.CCODEX_DELEGATE_CODEX;
  else process.env.CCODEX_DELEGATE_CODEX = oldDelegate;
  if (oldHome === undefined) delete process.env.CCODEX_HOME;
  else process.env.CCODEX_HOME = oldHome;
  if (oldConfig === undefined) delete process.env.CCODEX_CONFIG;
  else process.env.CCODEX_CONFIG = oldConfig;
});

function executable(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return path;
}

function fixture(): { root: string; home: string; appServer: string; shim: string; upstream: string } {
  const root = mkdtempSync(join(tmpdir(), "ccodex-config-"));
  roots.push(root);
  const home = join(root, ".ccodex");
  const appServer = executable(join(root, "pinned", "codex"));
  const shim = executable(join(home, "bin", "codex"));
  const upstream = executable(join(root, "upstream", "codex"));
  return { root, home, appServer, shim, upstream };
}

describe("delegated Codex discovery", () => {
  it("skips every managed shim and selects the external Codex later in PATH", () => {
    const { home, appServer, shim, upstream } = fixture();
    process.env.PATH = [join(home, "bin"), join(upstream, "..")].join(delimiter);
    expect(findDelegatedCodex(appServer, home)).toBe(upstream);
    expect(findDelegatedCodex(appServer, home)).not.toBe(shim);
  });

  it("prefers the absolute upstream captured by setup", () => {
    const { root, home, appServer, upstream } = fixture();
    const other = executable(join(root, "other", "codex"));
    writeFileSync(join(home, "install.json"), JSON.stringify({ delegateCodex: upstream }));
    process.env.PATH = [join(home, "bin"), join(other, "..")].join(delimiter);
    expect(delegatedCodexExecutable(home, appServer)).toBe(upstream);
  });

  it("rejects an explicit delegate anywhere inside the managed tree", () => {
    const { home, appServer, shim } = fixture();
    process.env.CCODEX_DELEGATE_CODEX = shim;
    expect(() => delegatedCodexExecutable(home, appServer)).toThrow("inside managed CCodex home");
  });
});

describe("opinionated feature configuration", () => {
  function configured(contents = ""): ReturnType<typeof loadConfig> {
    const { root, home, appServer, upstream } = fixture();
    const configPath = join(root, "config.toml");
    writeFileSync(configPath, `app_server_codex = "${appServer}"\n${contents}`);
    process.env.CCODEX_HOME = home;
    process.env.CCODEX_CONFIG = configPath;
    process.env.PATH = join(upstream, "..");
    return loadConfig();
  }

  it("enables UX overrides when [features] or individual keys are absent", () => {
    expect(configured().features).toEqual({ statusCommand: true, sideChatPromotion: true });
    expect(configured().renamePrompt).toBeUndefined();
    expect(configured("[features]\nstatus_command = false\n").features)
      .toEqual({ statusCommand: false, sideChatPromotion: true });
  });

  it("uses rename_prompt presence as the title UX switch and ignores the retired feature key", () => {
    expect(configured(`
rename_prompt = """
Use one rare emoji and a vivid title.
"""
[features]
title_generation_ux = true
status_command = true
`)).toMatchObject({
      renamePrompt: "Use one rare emoji and a vivid title.",
      features: { statusCommand: true, sideChatPromotion: true },
    });
    expect(configured(`
[features]
title_generation_ux = false
status_command = false
`)).toMatchObject({
      features: { statusCommand: false, sideChatPromotion: true },
    });
    expect(configured(`
# rename_prompt = "disabled"
`)).not.toHaveProperty("renamePrompt");
  });

  it("rejects invalid feature values with the exact key", () => {
    expect(() => configured("features = \"yes\"\n"))
      .toThrow("[features] must be a TOML table.");
    expect(() => configured("[features]\nstatus_command = 1\n"))
      .toThrow("features.status_command must be a boolean.");
    expect(() => configured("[features]\nside_chat_promotion = 1\n"))
      .toThrow("features.side_chat_promotion must be a boolean.");
    expect(() => configured("rename_prompt = \"\"\n"))
      .toThrow("rename_prompt must be a non-empty string.");
    expect(() => configured("rename_prompt = false\n"))
      .toThrow("rename_prompt must be a non-empty string.");
  });
});
