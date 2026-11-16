import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { autoCompactWindow, loadConfig } from "../../src/config.js";
import { baseOptions, claudeSettings } from "../../src/claude/sdk.js";
import { testConfig } from "../fixtures/config.js";

describe("claude_auto_compact_window", () => {
  let root: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function configured(toml: string) {
    root = mkdtempSync(join(tmpdir(), "ccodex-config-"));
    writeFileSync(join(root, "config.toml"), toml);
    vi.stubEnv("CCODEX_HOME", root);
    vi.stubEnv("CCODEX_CONFIG", join(root, "config.toml"));
    vi.stubEnv("CCODEX_CODEX", "/usr/bin/codex");
    return loadConfig();
  }

  it("is a whole number of tokens within Claude's range, and none for a value that is no window", () => {
    expect(autoCompactWindow(300_000)).toBe(300_000);
    expect(autoCompactWindow(250_000.4)).toBe(250_000);
    expect(autoCompactWindow(50_000)).toBe(100_000);
    expect(autoCompactWindow(5_000_000)).toBe(1_000_000);
    for (const value of [undefined, null, 0, -1, Number.NaN, "300000", true]) expect(autoCompactWindow(value)).toBeUndefined();
  });

  it("is read from config.toml and left out when unset", () => {
    expect(configured("claude_auto_compact_window = 300000\n").claudeAutoCompactWindow).toBe(300_000);
    expect("claudeAutoCompactWindow" in configured("")).toBe(false);
  });

  it("goes to every Claude process as its autoCompactWindow setting, the models probe's too", () => {
    expect(baseOptions(testConfig({ claudeAutoCompactWindow: 300_000 })).settings).toEqual({ autoCompactWindow: 300_000 });
    expect("settings" in baseOptions(testConfig())).toBe(false);
  });

  it("stays with a Fast chat's settings", () => {
    expect(claudeSettings(testConfig({ claudeAutoCompactWindow: 300_000 }), true)).toEqual({ autoCompactWindow: 300_000, fastMode: true });
    expect(claudeSettings(testConfig(), true)).toEqual({ fastMode: true });
    expect(claudeSettings(testConfig())).toBeUndefined();
  });
});
