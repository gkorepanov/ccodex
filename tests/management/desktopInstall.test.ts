import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installLayout } from "../../src/management/layout.js";
import {
  codexCliPathAgentPath, launchAgentPath, LAUNCH_AGENT_LABEL, type LaunchctlRuntime,
} from "../../src/desktop/launchAgent.js";
import {
  installDesktopApp, restoreDesktopApp, uninstallDesktopApp,
} from "../../src/desktop/install.js";

const roots: string[] = [];
const saved = { HOME: process.env.HOME, CCODEX_HOME: process.env.CCODEX_HOME, CODEX_HOME: process.env.CODEX_HOME };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function recordingLaunchctl(): { runtime: LaunchctlRuntime; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runtime: { run: (args) => { calls.push([...args]); return { status: 0, stdout: "", stderr: "" }; } },
  };
}

function fixture(): {
  layout: ReturnType<typeof installLayout>; socket: string; plist: string; cliPlist: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ccodex-desktop-"));
  roots.push(root);
  process.env.HOME = root;
  process.env.CCODEX_HOME = join(root, ".ccodex");
  process.env.CODEX_HOME = join(root, ".codex");
  const layout = installLayout();
  mkdirSync(layout.bin, { recursive: true });
  return {
    layout,
    socket: join(root, ".codex", "app-server-control", "app-server-control.sock"),
    plist: launchAgentPath(),
    cliPlist: codexCliPathAgentPath(),
  };
}

describe("desktop app install orchestration", () => {
  it("installs both agents, publishes CODEX_CLI_PATH, and reports the managed record", () => {
    const { layout, socket, plist, cliPlist } = fixture();
    const { runtime, calls } = recordingLaunchctl();
    const record = installDesktopApp(layout, socket, undefined, runtime);
    expect(record).toEqual({
      launchAgentPath: plist,
      label: LAUNCH_AGENT_LABEL,
      controlSocket: socket,
      entryShimPath: join(layout.bin, "codex-desktop"),
      cliPathAgentPath: cliPlist,
    });
    expect(existsSync(plist)).toBe(true);
    expect(existsSync(cliPlist)).toBe(true);
    expect(calls.map((call) => call[0])).toEqual([
      "bootout", "bootstrap", "kickstart", // gateway agent
      "bootout", "bootstrap", // login agent (no kickstart)
      "setenv", // immediate GUI publish
    ]);
    expect(calls.at(-1)).toEqual(["setenv", "CODEX_CLI_PATH", join(layout.bin, "codex-desktop")]);
  });

  it("uninstalls both agents and clears the GUI env", () => {
    const { layout, socket, plist, cliPlist } = fixture();
    const { runtime, calls } = recordingLaunchctl();
    const record = installDesktopApp(layout, socket, undefined, runtime);
    calls.length = 0;
    expect(uninstallDesktopApp(record, runtime)).toEqual([]);
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(cliPlist)).toBe(false);
    expect(calls.map((call) => call[0])).toEqual(["unsetenv", "bootout", "bootout"]);
  });

  it("preserves user-modified plists and still clears the GUI env", () => {
    const { layout, socket, plist, cliPlist } = fixture();
    const { runtime } = recordingLaunchctl();
    const record = installDesktopApp(layout, socket, undefined, runtime);
    writeFileSync(plist, "<plist>user gateway</plist>\n");
    writeFileSync(cliPlist, "<plist>user cli-path</plist>\n");
    expect(uninstallDesktopApp(record, runtime).sort()).toEqual([cliPlist, plist].sort());
    expect(existsSync(plist)).toBe(true);
    expect(existsSync(cliPlist)).toBe(true);
  });

  it("removes freshly-added agents on rollback with no previous", () => {
    const { layout, socket, plist, cliPlist } = fixture();
    const { runtime } = recordingLaunchctl();
    const record = installDesktopApp(layout, socket, undefined, runtime);
    restoreDesktopApp(record, undefined, runtime);
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(cliPlist)).toBe(false);
  });

  it("reloads the previous gateway agent on rollback across versions", () => {
    const { layout, socket, plist } = fixture();
    const { runtime, calls } = recordingLaunchctl();
    const record = installDesktopApp(layout, socket, undefined, runtime);
    calls.length = 0;
    restoreDesktopApp(record, record, runtime);
    expect(existsSync(plist)).toBe(true);
    expect(calls.map((call) => call[0])).toEqual(["bootout", "bootstrap", "kickstart"]);
  });
});
