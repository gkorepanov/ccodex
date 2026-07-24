import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installLayout } from "../../src/management/layout.js";
import {
  codexCliPathAgentPath, launchAgentPath, type LaunchctlRuntime,
} from "../../src/desktop/launchAgent.js";
import {
  desktopAppFilesIntact, installDesktopApp, restoreDesktopApp, uninstallDesktopApp,
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
  layout: ReturnType<typeof installLayout>;
  socket: string;
  node: string;
  plist: string;
  cliPlist: string;
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
    node: join(root, "node-toolchain", "bin", "node"),
    plist: launchAgentPath(),
    cliPlist: codexCliPathAgentPath(),
  };
}

describe("desktop app install orchestration", () => {
  it("installs both managed files and points CODEX_CLI_PATH at the existing codex shim", () => {
    const { layout, socket, node, plist, cliPlist } = fixture();
    const { runtime, calls } = recordingLaunchctl();
    const record = installDesktopApp(layout, socket, node, false, undefined, runtime);
    expect(record.entryShimPath).toBe(join(layout.bin, "codex"));
    expect(record.gatewayAgent).toMatchObject({
      path: plist,
      socket,
      nodeExecutable: node,
      remoteControlEnabled: false,
    });
    expect(record.cliPathAgent.path).toBe(cliPlist);
    expect(desktopAppFilesIntact(record)).toBe(true);
    expect(calls.map((call) => call[0])).toEqual(["print", "bootout", "bootstrap", "setenv"]);
    expect(calls.at(-1)).toEqual(["setenv", "CODEX_CLI_PATH", join(layout.bin, "codex")]);
  });

  it("uninstalls both agents and clears the GUI environment", () => {
    const { layout, socket, node, plist, cliPlist } = fixture();
    const { runtime, calls } = recordingLaunchctl();
    const record = installDesktopApp(layout, socket, node, false, undefined, runtime);
    calls.length = 0;
    expect(uninstallDesktopApp(record, runtime)).toEqual([]);
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(cliPlist)).toBe(false);
    expect(calls.map((call) => call[0])).toEqual(["unsetenv", "bootout", "bootout"]);
  });

  it("preserves modified plists instead of trusting only a marker", () => {
    const { layout, socket, node, plist, cliPlist } = fixture();
    const { runtime } = recordingLaunchctl();
    const record = installDesktopApp(layout, socket, node, false, undefined, runtime);
    writeFileSync(plist, "<plist><!-- Managed by CCodex — run 'ccodex uninstall' to remove. --><user/></plist>");
    writeFileSync(cliPlist, "<plist><!-- Managed by CCodex — run 'ccodex uninstall' to remove. --><user/></plist>");
    expect(desktopAppFilesIntact(record)).toBe(false);
    expect(uninstallDesktopApp(record, runtime).sort()).toEqual([cliPlist, plist].sort());
  });

  it("removes a partial first install during transactional rollback", () => {
    const { layout, socket, node, plist, cliPlist } = fixture();
    const { runtime } = recordingLaunchctl();
    const record = installDesktopApp(layout, socket, node, false, undefined, runtime);
    restoreDesktopApp(layout, record, undefined, runtime);
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(cliPlist)).toBe(false);
  });

  it("restores the previous absolute Node path and plist hashes", () => {
    const { layout, socket, node } = fixture();
    const { runtime } = recordingLaunchctl();
    const previous = installDesktopApp(layout, socket, node, false, undefined, runtime);
    const current = installDesktopApp(layout, socket, "/new/node", true, previous, runtime);
    restoreDesktopApp(layout, current, previous, runtime);
    const restored = installDesktopApp(layout, socket, node, false, previous, runtime);
    expect(restored.gatewayAgent.nodeExecutable).toBe(node);
    expect(restored.gatewayAgent.remoteControlEnabled).toBe(false);
  });

  it("removes both partial plists when launchctl setup fails", () => {
    const { layout, socket, node, plist, cliPlist } = fixture();
    const runtime: LaunchctlRuntime = {
      run: (args) => {
        if (args[0] === "print") return { status: 1, stdout: "", stderr: "" };
        if (args[0] === "bootstrap") throw new Error("fixture launchctl failure");
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(() => installDesktopApp(layout, socket, node, false, undefined, runtime))
      .toThrow("fixture launchctl failure");
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(cliPlist)).toBe(false);
  });
});
