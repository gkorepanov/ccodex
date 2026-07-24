import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexCliPathAgentPath,
  codexCliPathPlist,
  CODEX_CLI_PATH_LABEL,
  getCodexCliPathEnv,
  installCliPathAgent,
  launchAgentLoaded,
  setCodexCliPathEnv,
  type LaunchctlRuntime,
  uninstallCliPathAgent,
} from "../../src/desktop/launchAgent.js";

const roots: string[] = [];
const savedHome = process.env.HOME;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ccodex-agent-"));
  roots.push(root);
  process.env.HOME = root;
  return join(root, ".ccodex", "bin", "codex");
}

function launchctl(initial?: string): {
  runtime: LaunchctlRuntime;
  calls: string[][];
  environment: Map<string, string>;
  loaded: Set<string>;
} {
  const calls: string[][] = [];
  const environment = new Map<string, string>();
  if (initial) environment.set("CODEX_CLI_PATH", initial);
  const loaded = new Set<string>();
  return {
    calls,
    environment,
    loaded,
    runtime: {
      run: (args) => {
        calls.push([...args]);
        if (args[0] === "setenv") environment.set(args[1]!, args[2]!);
        if (args[0] === "unsetenv") environment.delete(args[1]!);
        if (args[0] === "getenv") {
          const value = environment.get(args[1]!);
          return { status: value === undefined ? 1 : 0, stdout: value ?? "", stderr: "" };
        }
        if (args[0] === "bootstrap" || args[0] === "load") loaded.add(CODEX_CLI_PATH_LABEL);
        if (args[0] === "bootout") loaded.delete(CODEX_CLI_PATH_LABEL);
        if (args[0] === "print") {
          return { status: loaded.has(CODEX_CLI_PATH_LABEL) ? 0 : 1, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  };
}

describe("CODEX_CLI_PATH login hook", () => {
  it("contains only the stable managed shim and no gateway process", () => {
    const entry = fixture();
    const plist = codexCliPathPlist(entry);
    expect(plist).toContain(`<string>${entry}</string>`);
    expect(plist).toContain(`<string>${CODEX_CLI_PATH_LABEL}</string>`);
    expect(plist).not.toContain("KeepAlive");
    expect(plist).not.toContain("app-server");
  });

  it("installs idempotently and restores the previous GUI value on uninstall", () => {
    const entry = fixture();
    const state = launchctl("/stock/codex");
    const first = installCliPathAgent(entry, undefined, state.runtime);
    const second = installCliPathAgent(entry, first, state.runtime);
    expect(second.previousValue).toBe("/stock/codex");
    expect(getCodexCliPathEnv(state.runtime)).toBe(entry);
    expect(launchAgentLoaded(state.runtime)).toBe(true);
    expect(uninstallCliPathAgent(second, state.runtime)).toBe(true);
    expect(getCodexCliPathEnv(state.runtime)).toBe("/stock/codex");
    expect(existsSync(codexCliPathAgentPath())).toBe(false);
  });

  it("preserves a modified plist and an independently changed GUI value", () => {
    const entry = fixture();
    const state = launchctl();
    const record = installCliPathAgent(entry, undefined, state.runtime);
    writeFileSync(record.path, `${readFileSync(record.path, "utf8")}<!-- user -->`);
    setCodexCliPathEnv("/user/codex", state.runtime);
    expect(uninstallCliPathAgent(record, state.runtime)).toBe(false);
    expect(getCodexCliPathEnv(state.runtime)).toBe("/user/codex");
    expect(existsSync(record.path)).toBe(true);
  });
});
