import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HybridConfig } from "../../src/config/config.js";
import {
  installLaunchAgent,
  LAUNCH_AGENT_LABEL,
  type LaunchctlRuntime,
} from "../../src/desktop/launchAgent.js";
import { runLaunchdDaemonCommand } from "../../src/desktop/launchdSupervisor.js";
import { installLayout } from "../../src/management/layout.js";

const roots: string[] = [];
const saved = { HOME: process.env.HOME, CCODEX_HOME: process.env.CCODEX_HOME, CODEX_HOME: process.env.CODEX_HOME };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixture(): {
  config: HybridConfig;
  layout: ReturnType<typeof installLayout>;
  runtime: LaunchctlRuntime;
  actions: string[];
  serving: () => boolean;
  failNextBootstrap: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "ccodex-launchd-supervisor-"));
  roots.push(root);
  process.env.HOME = root;
  process.env.CCODEX_HOME = join(root, ".ccodex");
  process.env.CODEX_HOME = join(root, ".codex");
  const layout = installLayout();
  mkdirSync(layout.bin, { recursive: true });
  const socket = join(root, ".codex", "app-server-control", "app-server-control.sock");
  const gatewayAgent = installLaunchAgent(layout, socket, "/toolchains/node", false);
  writeFileSync(layout.manifest, JSON.stringify({
    desktopApp: {
      entryShimPath: join(layout.bin, "codex"),
      gatewayAgent,
      cliPathAgent: {
        path: join(root, "Library", "LaunchAgents", "dev.ccodex.codex-cli-path.plist"),
        label: "dev.ccodex.codex-cli-path",
        entryShimPath: join(layout.bin, "codex"),
        contentHash: "fixture",
      },
    },
  }));
  let loaded = false;
  let ready = false;
  let rejectBootstrap = false;
  const actions: string[] = [];
  const runtime: LaunchctlRuntime = {
    run: (args) => {
      const command = args[0]!;
      if (command === "print") {
        return { status: loaded ? 0 : 1, stdout: "", stderr: "" };
      }
      actions.push(command);
      if (command === "bootstrap" && rejectBootstrap) {
        rejectBootstrap = false;
        throw new Error("fixture bootstrap failure");
      }
      if (command === "bootout" || command === "unload") {
        loaded = false;
        ready = false;
      }
      if (command === "bootstrap" || command === "load") loaded = true;
      if (command === "kickstart") ready = true;
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return {
    layout,
    runtime,
    actions,
    serving: () => ready,
    failNextBootstrap: () => { rejectBootstrap = true; },
    config: {
      realCodex: "/stock/codex",
      claudeBinary: "/claude",
      dataDir: join(root, ".ccodex", "state"),
      publicSocket: socket,
      modelPrefix: "claude:",
      idleTimeoutSeconds: 900,
      modelCacheSeconds: 300,
      logLevel: "warn",
      logPrompts: false,
      debugCapture: false,
      debugLogMaxBytes: 1_048_576,
    },
  };
}

function deps(value: ReturnType<typeof fixture>) {
  return {
    runtime: value.runtime,
    probe: async () => {
      if (!value.serving()) throw new Error("not ready");
      return { appServerVersion: "0.144.4", cliVersion: "0.144.4" };
    },
    retirePid: async () => {
      value.actions.push("pid-stop");
    },
    version: async () => "0.144.4",
  };
}

describe("launchd gateway supervisor", () => {
  it("retires the PID owner before starting launchd", async () => {
    const value = fixture();
    const result = await runLaunchdDaemonCommand(
      value.config,
      { command: "restart", remoteControl: false },
      "/managed/ccodex",
      deps(value),
    );
    expect(result).toMatchObject({ status: "restarted", backend: "launchd" });
    expect(value.actions).toEqual(["bootout", "pid-stop", "bootstrap", "kickstart"]);
  });

  it("stop stays stopped and start uses the same launchd backend", async () => {
    const value = fixture();
    await runLaunchdDaemonCommand(
      value.config,
      { command: "start", remoteControl: false },
      "/managed/ccodex",
      deps(value),
    );
    value.actions.length = 0;
    const stopped = await runLaunchdDaemonCommand(
      value.config,
      { command: "stop", remoteControl: false },
      "/managed/ccodex",
      deps(value),
    );
    expect(stopped).toMatchObject({ status: "stopped", backend: "launchd" });
    expect(value.actions).toEqual(["bootout", "pid-stop"]);
    expect(value.serving()).toBe(false);
  });

  it("reaps a stale recorded PID even when launchd is already serving", async () => {
    const value = fixture();
    await runLaunchdDaemonCommand(
      value.config,
      { command: "start", remoteControl: false },
      "/managed/ccodex",
      deps(value),
    );
    value.actions.length = 0;
    const result = await runLaunchdDaemonCommand(
      value.config,
      { command: "start", remoteControl: false },
      "/managed/ccodex",
      deps(value),
    );
    expect(result).toMatchObject({ status: "alreadyRunning", backend: "launchd" });
    expect(value.actions).toEqual(["pid-stop"]);
  });

  it("persists remote-control settings in the plist before one restart", async () => {
    const value = fixture();
    await runLaunchdDaemonCommand(
      value.config,
      { command: "start", remoteControl: false },
      "/managed/ccodex",
      deps(value),
    );
    value.actions.length = 0;
    const result = await runLaunchdDaemonCommand(
      value.config,
      { command: "enable-remote-control", remoteControl: false },
      "/managed/ccodex",
      deps(value),
    );
    expect(result).toMatchObject({
      status: "enabled",
      backend: "launchd",
      remoteControlEnabled: true,
    });
    const manifest = JSON.parse(readFileSync(value.layout.manifest, "utf8"));
    expect(manifest.desktopApp.gatewayAgent.remoteControlEnabled).toBe(true);
    expect(readFileSync(manifest.desktopApp.gatewayAgent.path, "utf8"))
      .toContain("<string>--remote-control</string>");
    expect(value.actions).toEqual(["bootout", "pid-stop", "bootstrap", "kickstart"]);
  });

  it("does not restart when the requested remote-control state is unchanged", async () => {
    const value = fixture();
    const result = await runLaunchdDaemonCommand(
      value.config,
      { command: "disable-remote-control", remoteControl: false },
      "/managed/ccodex",
      deps(value),
    );
    expect(result).toMatchObject({ status: "alreadyDisabled", remoteControlEnabled: false });
    expect(value.actions).toEqual([]);
  });

  it("restores settings, manifest, and the previous agent after a failed change", async () => {
    const value = fixture();
    await runLaunchdDaemonCommand(
      value.config,
      { command: "start", remoteControl: false },
      "/managed/ccodex",
      deps(value),
    );
    value.actions.length = 0;
    value.failNextBootstrap();

    await expect(runLaunchdDaemonCommand(
      value.config,
      { command: "enable-remote-control", remoteControl: false },
      "/managed/ccodex",
      deps(value),
    )).rejects.toThrow("fixture bootstrap failure");

    const manifest = JSON.parse(readFileSync(value.layout.manifest, "utf8"));
    expect(manifest.desktopApp.gatewayAgent.remoteControlEnabled).toBe(false);
    expect(readFileSync(manifest.desktopApp.gatewayAgent.path, "utf8"))
      .not.toContain("<string>--remote-control</string>");
    expect(value.serving()).toBe(true);
  });
});
