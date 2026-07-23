import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installLayout } from "../../src/management/layout.js";
import {
  codexCliPathAgentPath, codexCliPathPlist, CODEX_CLI_PATH_LABEL, desktopPlist,
  installCliPathAgent, installLaunchAgent, launchAgentPath, LAUNCH_AGENT_LABEL,
  type LaunchctlRuntime, setCodexCliPathEnv, uninstallCliPathAgent, uninstallLaunchAgent,
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

function fixture(): { layout: ReturnType<typeof installLayout>; socket: string; plist: string } {
  const root = mkdtempSync(join(tmpdir(), "ccodex-agent-"));
  roots.push(root);
  process.env.HOME = root;
  process.env.CCODEX_HOME = join(root, ".ccodex");
  process.env.CODEX_HOME = join(root, ".codex");
  const layout = installLayout();
  mkdirSync(layout.bin, { recursive: true });
  return { layout, socket: join(root, ".codex", "app-server-control", "app-server-control.sock"), plist: launchAgentPath() };
}

function recordingLaunchctl(): { runtime: LaunchctlRuntime; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runtime: { run: (args) => { calls.push([...args]); return { status: 0, stdout: "", stderr: "" }; } },
  };
}

describe("desktop LaunchAgent", () => {
  it("targets the per-user LaunchAgents directory", () => {
    const { plist } = fixture();
    expect(plist).toBe(join(process.env.HOME!, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`));
  });

  it("renders a KeepAlive plist that runs the managed ccodex remote-control gateway", () => {
    const { layout, socket } = fixture();
    const plist = desktopPlist(layout, socket);
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain(`<string>${join(layout.bin, "ccodex")}</string>`);
    expect(plist).toContain("<string>--remote-control</string>");
    expect(plist).toContain(`<string>unix://${socket}</string>`);
    expect(plist).toContain(`<key>CCODEX_HOME</key>\n    <string>${layout.home}</string>`);
    expect(plist).toContain(`<key>CODEX_HOME</key>\n    <string>${process.env.CODEX_HOME}</string>`);
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
  });

  it("writes a 0644 plist and registers it via launchctl bootout + bootstrap", () => {
    const { layout, socket, plist } = fixture();
    const { runtime, calls } = recordingLaunchctl();
    const record = installLaunchAgent(layout, socket, undefined, runtime);
    expect(record).toEqual({ path: plist, label: LAUNCH_AGENT_LABEL, socket });
    expect(existsSync(plist)).toBe(true);
    expect(statSync(plist).mode & 0o777).toBe(0o644);
    expect(calls.map((call) => call[0])).toEqual(["bootout", "bootstrap", "kickstart"]);
    expect(calls[1]).toContain(plist);
  });

  it("refuses to overwrite a user-modified managed plist", () => {
    const { layout, socket, plist } = fixture();
    const { runtime } = recordingLaunchctl();
    installLaunchAgent(layout, socket, undefined, runtime);
    writeFileSync(plist, "<plist>hand edited, no marker</plist>\n");
    expect(() => installLaunchAgent(layout, socket, { path: plist, label: LAUNCH_AGENT_LABEL, socket }, runtime))
      .toThrow("Refusing to overwrite modified managed LaunchAgent");
  });

  it("refuses to overwrite an unmanaged plist squatting the label path", () => {
    const { layout, socket, plist } = fixture();
    mkdirSync(join(plist, ".."), { recursive: true });
    writeFileSync(plist, "<plist>someone else</plist>\n");
    const { runtime } = recordingLaunchctl();
    expect(() => installLaunchAgent(layout, socket, undefined, runtime))
      .toThrow("Refusing to overwrite unmanaged LaunchAgent");
  });

  it("removes an owned plist but preserves a user-modified one", () => {
    const { layout, socket, plist } = fixture();
    const { runtime, calls } = recordingLaunchctl();
    const record = installLaunchAgent(layout, socket, undefined, runtime);
    calls.length = 0;

    writeFileSync(plist, "<plist>user owned now</plist>\n");
    expect(uninstallLaunchAgent(record, runtime)).toBe(false);
    expect(existsSync(plist)).toBe(true);
    expect(calls).toEqual([]);

    writeFileSync(plist, desktopPlist(layout, socket));
    expect(uninstallLaunchAgent(record, runtime)).toBe(true);
    expect(existsSync(plist)).toBe(false);
    expect(calls.map((call) => call[0])).toEqual(["bootout"]);
  });

  it("treats an already-absent plist as removed", () => {
    const { socket, plist } = fixture();
    const { runtime, calls } = recordingLaunchctl();
    expect(uninstallLaunchAgent({ path: plist, label: LAUNCH_AGENT_LABEL, socket }, runtime)).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("CODEX_CLI_PATH login agent", () => {
  it("renders a one-shot login agent that publishes CODEX_CLI_PATH", () => {
    const { layout } = fixture();
    const entry = join(layout.bin, "codex-desktop");
    const plist = codexCliPathPlist(entry);
    expect(plist).toContain(`<string>${CODEX_CLI_PATH_LABEL}</string>`);
    expect(plist).toContain("<string>/bin/launchctl</string>");
    expect(plist).toContain("<string>setenv</string>");
    expect(plist).toContain("<string>CODEX_CLI_PATH</string>");
    expect(plist).toContain(`<string>${entry}</string>`);
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <false/>");
    expect(plist).not.toContain("EnvironmentVariables");
  });

  it("installs the login agent (bootout + bootstrap, no kickstart) and removes it when owned", () => {
    const { layout } = fixture();
    const entry = join(layout.bin, "codex-desktop");
    const { runtime, calls } = recordingLaunchctl();
    const path = installCliPathAgent(entry, runtime);
    expect(path).toBe(codexCliPathAgentPath());
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(calls.map((call) => call[0])).toEqual(["bootout", "bootstrap"]);

    calls.length = 0;
    expect(uninstallCliPathAgent(path, runtime)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(calls.map((call) => call[0])).toEqual(["bootout"]);
  });

  it("preserves a user-modified login agent and treats absent as removed", () => {
    const { layout } = fixture();
    const entry = join(layout.bin, "codex-desktop");
    const { runtime } = recordingLaunchctl();
    const path = installCliPathAgent(entry, runtime);
    writeFileSync(path, "<plist>user owned</plist>\n");
    expect(uninstallCliPathAgent(path, runtime)).toBe(false);
    expect(existsSync(path)).toBe(true);

    rmSync(path);
    expect(uninstallCliPathAgent(path, runtime)).toBe(true);
  });

  it("refuses to overwrite an unmanaged login agent plist", () => {
    const { layout } = fixture();
    const entry = join(layout.bin, "codex-desktop");
    const path = codexCliPathAgentPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "<plist>someone else</plist>\n");
    const { runtime } = recordingLaunchctl();
    expect(() => installCliPathAgent(entry, runtime)).toThrow("Refusing to overwrite unmanaged LaunchAgent");
  });

  it("publishes and clears CODEX_CLI_PATH in the GUI launchd session", () => {
    fixture();
    const entry = "/Users/x/.ccodex/bin/codex-desktop";
    const { runtime, calls } = recordingLaunchctl();
    setCodexCliPathEnv(entry, runtime);
    unsetCodexCliPathEnv(runtime);
    expect(calls).toEqual([["setenv", "CODEX_CLI_PATH", entry], ["unsetenv", "CODEX_CLI_PATH"]]);
  });

  it("swallows launchctl failures when there is no GUI session", () => {
    fixture();
    const throwing: LaunchctlRuntime = { run: () => { throw new Error("Could not find domain for uid"); } };
    expect(() => setCodexCliPathEnv("/x", throwing)).not.toThrow();
    expect(() => unsetCodexCliPathEnv(throwing)).not.toThrow();
  });
});
