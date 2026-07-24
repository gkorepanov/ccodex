import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DaemonCommand } from "../cli/args.js";
import type { HybridConfig } from "../config/config.js";
import { probeAppServer, type ProbeInfo } from "../daemon/probe.js";
import { loadDaemonSettings, saveDaemonSettings } from "../daemon/settings.js";
import {
  daemonStateDirectory,
  killManagedProcess,
  reconcileManagedProcess,
  stopManagedProcess,
  withDaemonLock,
} from "../daemon/supervisor.js";
import { socketOwnerPids } from "../daemon/ownership.js";
import { atomicWrite, installLayout } from "../management/layout.js";
import type { DesktopAppInstall } from "./install.js";
import {
  bootoutLaunchAgent,
  bootstrapLaunchAgent,
  installLaunchAgent,
  launchAgentLoaded,
  systemLaunchctl,
  type LaunchctlRuntime,
} from "./launchAgent.js";

const execute = promisify(execFile);
const READY_TIMEOUT_MS = 20_000;
const POLL_MS = 50;

interface DaemonInvocation {
  readonly command: DaemonCommand;
  readonly remoteControl: boolean;
}

type JsonOutput = Record<string, string | number | boolean | undefined>;

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function stockVersion(realCodex: string): Promise<string> {
  const { stdout } = await execute(realCodex, ["--version"], {
    env: { ...process.env, CODEX_CLI_PATH: undefined },
  });
  const version = stdout.trim().split(/\s+/u)[1];
  if (!version) throw new Error(`Codex version output was malformed: ${stdout.trim()}`);
  return version;
}

type Probe = (socket: string) => Promise<ProbeInfo>;

async function probeMaybe(probe: Probe, socket: string): Promise<ProbeInfo | undefined> {
  return probe(socket).catch(() => undefined);
}

async function waitReady(probe: Probe, socket: string): Promise<ProbeInfo> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      return await probe(socket);
    } catch (error) {
      failure = error;
      await sleep(POLL_MS);
    }
  }
  throw new Error(`launchd gateway did not become ready on ${socket}`, { cause: failure });
}

function desktopRecord(): {
  readonly manifest: Record<string, unknown>;
  readonly desktop: DesktopAppInstall;
  readonly path: string;
} {
  const layout = installLayout();
  if (!existsSync(layout.manifest)) throw new Error("CCodex install manifest is missing.");
  const manifest = JSON.parse(readFileSync(layout.manifest, "utf8")) as Record<string, unknown>;
  const desktop = manifest.desktopApp as DesktopAppInstall | undefined;
  if (!desktop?.gatewayAgent) throw new Error("CCodex desktop LaunchAgent is not registered.");
  return { manifest, desktop, path: layout.manifest };
}

function updateRemoteSetting(enabled: boolean): DesktopAppInstall {
  const layout = installLayout();
  const { manifest, desktop, path } = desktopRecord();
  const gatewayAgent = installLaunchAgent(
    layout,
    desktop.gatewayAgent.socket,
    desktop.gatewayAgent.nodeExecutable,
    enabled,
    desktop.gatewayAgent,
  );
  const next = { ...desktop, gatewayAgent };
  atomicWrite(path, `${JSON.stringify({ ...manifest, desktopApp: next }, null, 2)}\n`, 0o600);
  return next;
}

async function retireRecordedPidOwner(socketPath: string): Promise<void> {
  const pidFile = join(daemonStateDirectory(), "app-server.pid");
  const managed = reconcileManagedProcess(pidFile);
  if (!managed) return;
  const owners = socketOwnerPids(socketPath);
  if (owners.length === 1 && owners[0] === managed.pid) {
    await stopManagedProcess(pidFile, managed);
  } else {
    await killManagedProcess(pidFile, managed);
  }
}

class LaunchdDaemon {
  private readonly settingsFile = join(daemonStateDirectory(), "settings.json");
  private version?: Promise<string>;

  public constructor(
    private readonly config: HybridConfig,
    private readonly wrapperPath: string,
    private readonly deps: Required<LaunchdSupervisorDeps>,
  ) {}

  public async run(invocation: DaemonInvocation): Promise<JsonOutput> {
    if (invocation.command === "version") return this.versionOutput();
    return withDaemonLock(daemonStateDirectory(), () => this.runLocked(invocation));
  }

  private async runLocked(invocation: DaemonInvocation): Promise<JsonOutput> {
    switch (invocation.command) {
      case "bootstrap":
        return this.bootstrap(invocation.remoteControl);
      case "start":
        return this.start();
      case "restart":
        return this.restart();
      case "stop":
        return this.stop();
      case "version":
        throw new Error("unreachable");
      case "enable-remote-control":
        return this.setRemoteControl(true);
      case "disable-remote-control":
        return this.setRemoteControl(false);
    }
  }

  private getVersion(): Promise<string> {
    return this.version ??= this.deps.version();
  }

  private async lifecycle(status: string, info?: ProbeInfo): Promise<JsonOutput> {
    const version = await this.getVersion();
    return {
      status,
      backend: "launchd",
      managedCodexPath: this.wrapperPath,
      managedCodexVersion: version,
      socketPath: this.config.publicSocket,
      cliVersion: version,
      appServerVersion: info?.appServerVersion,
    };
  }

  private async remote(status: string, enabled: boolean, info?: ProbeInfo): Promise<JsonOutput> {
    return {
      status,
      backend: "launchd",
      remoteControlEnabled: enabled,
      socketPath: this.config.publicSocket,
      cliVersion: await this.getVersion(),
      appServerVersion: info?.appServerVersion,
    };
  }

  private async retirePidOwner(): Promise<void> {
    await this.deps.retirePid();
  }

  private async changeRemoteSetting<T>(
    enabled: boolean,
    restoreRunning: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    const { desktop, path: manifestPath } = desktopRecord();
    const manifest = readFileSync(manifestPath, "utf8");
    const plist = readFileSync(desktop.gatewayAgent.path, "utf8");
    const settings = existsSync(this.settingsFile) ? readFileSync(this.settingsFile, "utf8") : undefined;
    try {
      saveDaemonSettings(this.settingsFile, { remoteControlEnabled: enabled });
      updateRemoteSetting(enabled);
      return await operation();
    } catch (error) {
      atomicWrite(desktop.gatewayAgent.path, plist, 0o644);
      atomicWrite(manifestPath, manifest, 0o600);
      if (settings === undefined) rmSync(this.settingsFile, { force: true });
      else atomicWrite(this.settingsFile, settings, 0o600);
      if (restoreRunning) {
        bootoutLaunchAgent(desktop.gatewayAgent, this.deps.runtime);
        await this.retirePidOwner().catch(() => undefined);
        bootstrapLaunchAgent(desktop.gatewayAgent, this.deps.runtime);
        await waitReady(this.deps.probe, this.config.publicSocket).catch(() => undefined);
      }
      throw error;
    }
  }

  private async start(): Promise<JsonOutput> {
    const { desktop } = desktopRecord();
    await this.retirePidOwner();
    const serving = await probeMaybe(this.deps.probe, this.config.publicSocket);
    if (launchAgentLoaded(desktop.gatewayAgent.label, this.deps.runtime) && serving) {
      return this.lifecycle("alreadyRunning", serving);
    }
    bootoutLaunchAgent(desktop.gatewayAgent, this.deps.runtime);
    bootstrapLaunchAgent(desktop.gatewayAgent, this.deps.runtime);
    return this.lifecycle("started", await waitReady(this.deps.probe, this.config.publicSocket));
  }

  private async restart(): Promise<JsonOutput> {
    const { desktop } = desktopRecord();
    bootoutLaunchAgent(desktop.gatewayAgent, this.deps.runtime);
    await this.retirePidOwner();
    bootstrapLaunchAgent(desktop.gatewayAgent, this.deps.runtime);
    return this.lifecycle("restarted", await waitReady(this.deps.probe, this.config.publicSocket));
  }

  private async stop(): Promise<JsonOutput> {
    const { desktop } = desktopRecord();
    const loaded = launchAgentLoaded(desktop.gatewayAgent.label, this.deps.runtime);
    bootoutLaunchAgent(desktop.gatewayAgent, this.deps.runtime);
    await this.retirePidOwner();
    return this.lifecycle(loaded ? "stopped" : "notRunning");
  }

  private async versionOutput(): Promise<JsonOutput> {
    const info = await this.deps.probe(this.config.publicSocket);
    return this.lifecycle("running", info);
  }

  private async bootstrap(remoteControlEnabled: boolean): Promise<JsonOutput> {
    await this.changeRemoteSetting(remoteControlEnabled, true, () => this.restart());
    const info = await this.deps.probe(this.config.publicSocket);
    return {
      ...await this.remote("bootstrapped", remoteControlEnabled, info),
      autoUpdateEnabled: false,
    };
  }

  private async setRemoteControl(enabled: boolean): Promise<JsonOutput> {
    const previous = loadDaemonSettings(this.settingsFile);
    if (previous.remoteControlEnabled === enabled) {
      return this.remote(
        enabled ? "alreadyEnabled" : "alreadyDisabled",
        enabled,
        await probeMaybe(this.deps.probe, this.config.publicSocket),
      );
    }
    const { desktop } = desktopRecord();
    const running = launchAgentLoaded(desktop.gatewayAgent.label, this.deps.runtime)
      || Boolean(await probeMaybe(this.deps.probe, this.config.publicSocket));
    const info = await this.changeRemoteSetting(enabled, running, async () =>
      running ? this.restart().then(() => this.deps.probe(this.config.publicSocket)) : undefined);
    return this.remote(enabled ? "enabled" : "disabled", enabled, info);
  }
}

export interface LaunchdSupervisorDeps {
  readonly runtime?: LaunchctlRuntime;
  readonly probe?: Probe;
  readonly retirePid?: () => Promise<void>;
  readonly version?: () => Promise<string>;
}

export function runLaunchdDaemonCommand(
  config: HybridConfig,
  invocation: DaemonInvocation,
  wrapperPath: string,
  deps: LaunchdSupervisorDeps = {},
): Promise<JsonOutput> {
  return new LaunchdDaemon(config, wrapperPath, {
    runtime: deps.runtime ?? systemLaunchctl,
    probe: deps.probe ?? probeAppServer,
    retirePid: deps.retirePid ?? (() => retireRecordedPidOwner(config.publicSocket)),
    version: deps.version ?? (() => stockVersion(config.realCodex)),
  }).run(invocation);
}
