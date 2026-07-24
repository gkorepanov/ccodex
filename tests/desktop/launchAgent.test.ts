import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installLayout } from "../../src/management/layout.js";
import {
  bootstrapLaunchAgent,
  codexCliPathAgentPath,
  codexCliPathPlist,
  CODEX_CLI_PATH_LABEL,
  desktopPlist,
  getCodexCliPathEnv,
  installCliPathAgent,
  installLaunchAgent,
  launchAgentLoaded,
  launchAgentPath,
  LAUNCH_AGENT_LABEL,
  type LaunchctlRuntime,
  setCodexCliPathEnv,
  uninstallCliPathAgent,
  uninstallLaunchAgent,
  unsetCodexCliPathEnv,
} from "../../src/desktop/launchAgent.js";

const roots: string[] = [];
const saved = { HOME: process.env.HOME, CCODEX_HOME: process.env.CCODEX_HOME, CODEX_HOME: process.env.CODEX_HOME };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixture(): { layout: ReturnType<typeof installLayout>; socket: string; node: string } {
  const root = mkdtempSync(join(tmpdir(), "ccodex-agent-"));
  roots.push(root);
  process.env.HOME = root;
  process.env.CCODEX_HOME = join(root, ".ccodex");
  process.env.CODEX_HOME = join(root, ".codex");
  const layout = installLayout();
  mkdirSync(layout.bin, { recursive: true });
  return {
    layout,
    socket: join(root, ".codex", "app-server-control", "app-server-control.sock"),
    node: join(root, "toolchains", "node", "bin", "node"),
  };
}

function recordingLaunchctl(): {
  runtime: LaunchctlRuntime;
  calls: string[][];
  environment: Map<string, string>;
  loaded: Set<string>;
} {
  const calls: string[][] = [];
  const environment = new Map<string, string>();
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
        if (args[0] === "bootstrap" || args[0] === "load") loaded.add(LAUNCH_AGENT_LABEL);
        if (args[0] === "bootout" || args[0] === "unload") {
          const label = args.at(-1)?.split("/").at(-1);
          if (label) loaded.delete(label);
        }
        if (args[0] === "print") {
          const label = args.at(-1)?.split("/").at(-1);
          return { status: label && loaded.has(label) ? 0 : 1, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  };
}

describe("desktop LaunchAgent", () => {
  it("uses an absolute Node executable and does not force remote control", () => {
    const { layout, socket, node } = fixture();
    const plist = desktopPlist(layout, socket, node, false);
    expect(plist).toContain(`<string>${node}</string>`);
    expect(plist).toContain(`<string>${join(layout.current, "node_modules", "@gkorepanov", "ccodex", "dist", "cli", "main.js")}</string>`);
    expect(plist).not.toContain("<string>--remote-control</string>");
    expect(desktopPlist(layout, socket, node, true)).toContain("<string>--remote-control</string>");
  });

  it("writes but does not start the gateway agent until the unified supervisor does", () => {
    const { layout, socket, node } = fixture();
    const record = installLaunchAgent(layout, socket, node, false);
    expect(record.path).toBe(launchAgentPath());
    expect(statSync(record.path).mode & 0o777).toBe(0o644);
    expect(record.contentHash).toHaveLength(64);

    const { runtime, calls, loaded } = recordingLaunchctl();
    bootstrapLaunchAgent(record, runtime);
    expect(calls.map((call) => call[0])).toEqual(["bootstrap", "kickstart"]);
    expect(loaded.has(LAUNCH_AGENT_LABEL)).toBe(true);
    expect(launchAgentLoaded(LAUNCH_AGENT_LABEL, runtime)).toBe(true);
  });

  it("allows an exact managed rewrite and rejects a modified plist", () => {
    const { layout, socket, node } = fixture();
    const first = installLaunchAgent(layout, socket, node, false);
    const second = installLaunchAgent(layout, socket, node, true, first);
    expect(second.remoteControlEnabled).toBe(true);
    writeFileSync(second.path, `${readFileSync(second.path, "utf8")}<!-- user -->\n`);
    expect(() => installLaunchAgent(layout, socket, node, false, second))
      .toThrow("Refusing to overwrite modified or unmanaged");
  });

  it("removes only a byte-identical owned gateway plist", () => {
    const { layout, socket, node } = fixture();
    const record = installLaunchAgent(layout, socket, node, false);
    const { runtime } = recordingLaunchctl();
    writeFileSync(record.path, `${readFileSync(record.path, "utf8")}<!-- changed -->`);
    expect(uninstallLaunchAgent(record, runtime)).toBe(false);
    expect(existsSync(record.path)).toBe(true);
  });
});

describe("CODEX_CLI_PATH login agent", () => {
  it("publishes the existing managed codex shim, not a desktop-only shim", () => {
    const { layout } = fixture();
    const entry = join(layout.bin, "codex");
    const plist = codexCliPathPlist(entry);
    expect(plist).toContain(`<string>${CODEX_CLI_PATH_LABEL}</string>`);
    expect(plist).toContain(`<string>${entry}</string>`);
    expect(plist).not.toContain("codex-desktop");
  });

  it("installs, hashes, and removes only an unchanged login agent", () => {
    const { layout } = fixture();
    const { runtime } = recordingLaunchctl();
    const record = installCliPathAgent(join(layout.bin, "codex"), undefined, runtime);
    expect(record.path).toBe(codexCliPathAgentPath());
    expect(record.contentHash).toHaveLength(64);
    expect(uninstallCliPathAgent(record, runtime)).toBe(true);
    expect(existsSync(record.path)).toBe(false);
  });

  it("sets, reads, and clears the GUI environment", () => {
    fixture();
    const { runtime } = recordingLaunchctl();
    setCodexCliPathEnv("/managed/codex", runtime);
    expect(getCodexCliPathEnv(runtime)).toBe("/managed/codex");
    unsetCodexCliPathEnv(runtime);
    expect(getCodexCliPathEnv(runtime)).toBeUndefined();
  });
});
