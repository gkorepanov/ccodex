import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HybridConfig } from "../config/config.js";
import type { DaemonCommand } from "../cli/args.js";
import { probeAppServer, type ProbeInfo } from "./probe.js";
import {
  type PidRecord,
  daemonStateDirectory,
  killManagedProcess,
  reconcileManagedProcess,
  spawnDetachedGateway,
  stopManagedProcess,
  withDaemonLock,
} from "./supervisor.js";
import {
  identifySocketOwner,
  reconcileOwnedGateway,
  socketOwnerPids,
  stopSocketOwner,
} from "./ownership.js";

const execFileAsync = promisify(execFile);
const START_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

interface DaemonInvocation {
  readonly command: DaemonCommand;
  readonly remoteControl: boolean;
}

interface DaemonSettings {
  readonly remoteControlEnabled: boolean;
}

interface DaemonPaths {
  readonly stateDirectory: string;
  readonly settingsFile: string;
  readonly pidFile: string;
  readonly stderrLog: string;
  readonly socketPath: string;
  readonly wrapperPath: string;
}

type JsonOutput = Record<string, string | number | boolean | undefined>;

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function paths(config: HybridConfig, wrapperPath: string): DaemonPaths {
  const stateDirectory = daemonStateDirectory();
  return {
    stateDirectory,
    settingsFile: join(stateDirectory, "settings.json"),
    pidFile: join(stateDirectory, "app-server.pid"),
    stderrLog: join(stateDirectory, "app-server.stderr.log"),
    socketPath: config.publicSocket,
    wrapperPath: realpathSync(resolve(wrapperPath)),
  };
}

function loadSettings(path: string): DaemonSettings {
  if (!existsSync(path)) return { remoteControlEnabled: false };
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonSettings>;
  if (typeof value.remoteControlEnabled !== "boolean") throw new Error(`failed to parse daemon settings ${path}`);
  return { remoteControlEnabled: value.remoteControlEnabled };
}

function saveSettings(path: string, settings: DaemonSettings): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

async function stockVersion(realCodex: string): Promise<string> {
  const { stdout } = await execFileAsync(realCodex, ["--version"], {
    env: { ...process.env, CODEX_CLI_PATH: undefined },
  });
  const version = stdout.trim().split(/\s+/u)[1];
  if (!version) throw new Error(`Codex version output was malformed: ${stdout.trim()}`);
  return version;
}

async function probeMaybe(socketPath: string): Promise<ProbeInfo | undefined> {
  try {
    return await probeAppServer(socketPath);
  } catch {
    return undefined;
  }
}

async function waitUntilReady(socketPath: string): Promise<ProbeInfo> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await probeAppServer(socketPath);
    } catch (error) {
      lastError = error;
      await sleep(POLL_MS);
    }
  }
  throw new Error(`app server did not become ready on ${socketPath}`, { cause: lastError });
}

class HybridDaemon {
  private readonly paths: DaemonPaths;
  private version?: Promise<string>;

  public constructor(private readonly config: HybridConfig, wrapperPath: string) {
    this.paths = paths(config, wrapperPath);
  }

  private getVersion(): Promise<string> {
    return this.version ??= stockVersion(this.config.realCodex);
  }

  public run(invocation: DaemonInvocation): Promise<JsonOutput> {
    if (invocation.command === "version") return this.versionOutput();
    return withDaemonLock(this.paths.stateDirectory, async () => {
      switch (invocation.command) {
        case "bootstrap": return this.bootstrap(invocation.remoteControl);
        case "start": return this.start("started");
        case "restart": return this.restart();
        case "stop": return this.stop();
        case "enable-remote-control": return this.setRemoteControl(true);
        case "disable-remote-control": return this.setRemoteControl(false);
        case "version": throw new Error("unreachable");
      }
    });
  }

  private async lifecycleOutput(
    status: string,
    backend?: "pid",
    pid?: number,
    appServerVersion?: string,
  ): Promise<JsonOutput> {
    const version = await this.getVersion();
    return {
      status,
      backend,
      pid,
      managedCodexPath: this.paths.wrapperPath,
      managedCodexVersion: version,
      socketPath: this.paths.socketPath,
      cliVersion: version,
      appServerVersion,
    };
  }

  private async remoteControlOutput(
    status: string,
    enabled: boolean,
    backend?: "pid",
    appServerVersion?: string,
  ): Promise<JsonOutput> {
    return {
      status,
      backend,
      remoteControlEnabled: enabled,
      socketPath: this.paths.socketPath,
      cliVersion: await this.getVersion(),
      appServerVersion,
    };
  }

  private async spawn(settings: DaemonSettings): Promise<PidRecord> {
    const pid = await spawnDetachedGateway({
      wrapperPath: this.paths.wrapperPath,
      pidFile: this.paths.pidFile,
      stderrLog: this.paths.stderrLog,
      remoteControlEnabled: settings.remoteControlEnabled,
    });
    const record = reconcileManagedProcess(this.paths.pidFile);
    if (!record || record.pid !== pid) throw new Error(`managed app server ${pid} lost daemon ownership during startup`);
    return record;
  }

  private async spawnReady(settings: DaemonSettings): Promise<{ pid: number; info: ProbeInfo }> {
    const expected = await this.spawn(settings);
    try {
      const info = await waitUntilReady(this.paths.socketPath);
      const current = reconcileManagedProcess(this.paths.pidFile);
      if (!current || current.pid !== expected.pid || current.processStartTime !== expected.processStartTime) {
        throw new Error(`managed app server ${expected.pid} lost daemon ownership during readiness`);
      }
      if (!this.ownsSocket(current)) {
        throw new Error(`managed app server ${expected.pid} does not own ${this.paths.socketPath}`);
      }
      return { pid: expected.pid, info };
    } catch (error) {
      const current = reconcileManagedProcess(this.paths.pidFile);
      if (current && current.pid === expected.pid && current.processStartTime === expected.processStartTime) {
        const stop = this.ownsSocket(current) ? stopManagedProcess : killManagedProcess;
        await stop(this.paths.pidFile, current).catch(() => undefined);
      }
      throw error;
    }
  }

  private async replaceEndpoint(settings: DaemonSettings): Promise<{ pid: number; info: ProbeInfo }> {
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const managed = reconcileManagedProcess(this.paths.pidFile);
      if (managed) {
        if (this.ownsSocket(managed)) await stopManagedProcess(this.paths.pidFile, managed);
        else await killManagedProcess(this.paths.pidFile, managed);
      }
      const owner = identifySocketOwner(this.paths.socketPath);
      if (owner) {
        const confirmed = await probeMaybe(this.paths.socketPath);
        const afterProbe = identifySocketOwner(this.paths.socketPath, owner);
        // Vacancy is safe under the startup lock; every present owner remains
        // fenced by PID/start-time before it can receive a signal.
        if (afterProbe) {
          if (!confirmed) {
            throw new Error("refusing app-server takeover: owner did not answer app-server identity probe");
          }
          await stopSocketOwner(this.paths.socketPath, afterProbe);
        }
      }
      try {
        return await this.spawnReady(settings);
      } catch (error) {
        failure = error;
        // Codex App may have launched once more between handoff and bind. The
        // managed remote shim makes this bounded; only another probed app-server
        // on the exact socket is eligible for the next takeover attempt.
        if (!await probeMaybe(this.paths.socketPath)) throw error;
      }
    }
    throw new Error("app-server ownership did not stabilize after three takeover attempts", { cause: failure });
  }

  private ownsSocket(record: PidRecord): boolean {
    const owners = socketOwnerPids(this.paths.socketPath);
    return owners.length === 1 && owners[0] === record.pid;
  }

  private async start(status: "started" | "restarted"): Promise<JsonOutput> {
    const settings = loadSettings(this.paths.settingsFile);
    const info = await probeMaybe(this.paths.socketPath);
    const managed = reconcileManagedProcess(this.paths.pidFile);
    const managedOwnsSocket = managed ? this.ownsSocket(managed) : false;
    const currentVersion = managed?.wrapperPath === this.paths.wrapperPath;
    if (info && managed && managedOwnsSocket && currentVersion) {
      return this.lifecycleOutput("alreadyRunning", "pid", undefined, info.appServerVersion);
    }
    if (managed && managedOwnsSocket && currentVersion) {
      const ready = await waitUntilReady(this.paths.socketPath);
      return this.lifecycleOutput("alreadyRunning", "pid", undefined, ready.appServerVersion);
    }
    const { pid, info: ready } = info || managed
      ? await this.replaceEndpoint(settings)
      : await this.spawnReady(settings).catch(async (error: unknown) => {
        if (!await probeMaybe(this.paths.socketPath)) throw error;
        return this.replaceEndpoint(settings);
      });
    return this.lifecycleOutput(status, "pid", pid, ready.appServerVersion);
  }

  private async restart(): Promise<JsonOutput> {
    const settings = loadSettings(this.paths.settingsFile);
    const { pid, info: ready } = await this.replaceEndpoint(settings);
    return this.lifecycleOutput("restarted", "pid", pid, ready.appServerVersion);
  }

  private async stop(): Promise<JsonOutput> {
    const managed = reconcileManagedProcess(this.paths.pidFile);
    if (managed && this.ownsSocket(managed)) {
      await stopManagedProcess(this.paths.pidFile);
      return this.lifecycleOutput("stopped", "pid");
    }
    // The recorded group is still ours by PID/start-time, but an unlink/rebind
    // may have handed the pathname to another process. Reap only our stale group
    // and then classify the current endpoint independently.
    if (managed) await killManagedProcess(this.paths.pidFile, managed);
    const owned = reconcileOwnedGateway(this.paths.socketPath);
    if (owned) {
      await stopSocketOwner(this.paths.socketPath, owned);
      return this.lifecycleOutput("stopped", "pid");
    }
    if (await probeMaybe(this.paths.socketPath)) {
      return this.lifecycleOutput("notManaged");
    }
    return this.lifecycleOutput(managed ? "stopped" : "notRunning", managed ? "pid" : undefined);
  }

  private async versionOutput(): Promise<JsonOutput> {
    const info = await probeAppServer(this.paths.socketPath);
    const managed = reconcileManagedProcess(this.paths.pidFile);
    return this.lifecycleOutput(
      "running",
      managed && this.ownsSocket(managed) ? "pid" : undefined,
      undefined,
      info.appServerVersion,
    );
  }

  private async bootstrap(remoteControlEnabled: boolean): Promise<JsonOutput> {
    const settings = { remoteControlEnabled };
    saveSettings(this.paths.settingsFile, settings);
    const { info: ready } = await this.replaceEndpoint(settings);
    const version = await this.getVersion();
    return {
      status: "bootstrapped",
      backend: "pid",
      autoUpdateEnabled: false,
      remoteControlEnabled,
      managedCodexPath: this.paths.wrapperPath,
      managedCodexVersion: version,
      socketPath: this.paths.socketPath,
      cliVersion: version,
      appServerVersion: ready.appServerVersion,
    };
  }

  private async setRemoteControl(enabled: boolean): Promise<JsonOutput> {
    const previous = loadSettings(this.paths.settingsFile);
    const managed = reconcileManagedProcess(this.paths.pidFile);
    const managedOwnsSocket = managed ? this.ownsSocket(managed) : false;
    if (previous.remoteControlEnabled === enabled) {
      const serving = await probeMaybe(this.paths.socketPath);
      const info = managed && managedOwnsSocket
        ? await waitUntilReady(this.paths.socketPath)
        : serving || managed ? (await this.replaceEndpoint(previous)).info : undefined;
      return this.remoteControlOutput(
        enabled ? "alreadyEnabled" : "alreadyDisabled",
        enabled,
        managedOwnsSocket || info ? "pid" : undefined,
        info?.appServerVersion,
      );
    }
    const settings = { remoteControlEnabled: enabled };
    saveSettings(this.paths.settingsFile, settings);
    let info: ProbeInfo | undefined;
    if (managed) {
      ({ info } = await this.replaceEndpoint(settings));
    } else if (await probeMaybe(this.paths.socketPath)) {
      ({ info } = await this.replaceEndpoint(settings));
    }
    return this.remoteControlOutput(enabled ? "enabled" : "disabled", enabled, info ? "pid" : undefined, info?.appServerVersion);
  }
}

export function runDaemonCommand(
  config: HybridConfig,
  invocation: DaemonInvocation,
  wrapperPath: string,
): Promise<JsonOutput> {
  if (process.platform === "win32") {
    throw new Error("codex app-server daemon lifecycle is only supported on Unix platforms");
  }
  return new HybridDaemon(config, wrapperPath).run(invocation);
}
