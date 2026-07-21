import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HybridConfig } from "../../src/config/config.js";
import { runDaemonCommand } from "../../src/daemon/daemon.js";
import { socketOwnerPids } from "../../src/daemon/ownership.js";
import { probeAppServer } from "../../src/daemon/probe.js";
import { stopManagedProcess, withGatewayStartupFence } from "../../src/daemon/supervisor.js";
import { prepareUnixSocket } from "../../src/gateway/socket.js";

const fixture = resolve("tests/fixtures/fakeDaemonGateway.mjs");
const unmanagedFixture = resolve("tests/fixtures/fakeUnmanagedGateway.mjs");
const unrelatedFixture = resolve("tests/fixtures/fakeUnrelatedSocket.mjs");
const temporary: string[] = [];
const external: number[] = [];
const originalEnv = { ...process.env };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

function harness(): { config: HybridConfig; home: string; record: string } {
  const root = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "hdt-"));
  temporary.push(root);
  const realCodex = join(root, "codex-real");
  writeFileSync(realCodex, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.144.6'\n", { mode: 0o700 });
  chmodSync(realCodex, 0o700);
  const home = join(root, "codex-home");
  const socket = join(home, "app-server-control", "app-server-control.sock");
  const record = join(root, "children.jsonl");
  process.env.CODEX_HOME = home;
  process.env.CODEX_HYBRID_SOCKET = socket;
  process.env.FAKE_DAEMON_RECORD = record;
  return {
    home,
    record,
    config: {
      realCodex,
      claudeBinary: "/fake/claude",
      dataDir: join(root, "hybrid"),
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

afterEach(async () => {
  for (const path of temporary) {
    await stopManagedProcess(join(path, "codex-home", "app-server-daemon", "app-server.pid")).catch(() => undefined);
  }
  for (const pid of external.splice(0)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
  }
  process.env = { ...originalEnv };
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function waitFor(path: string): Promise<void> {
  for (let index = 0; index < 200 && !existsSync(path); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(existsSync(path)).toBe(true);
}

async function startUnmanaged(config: HybridConfig, home: string, exitAfterProbe = false): Promise<number> {
  const ready = join(home, "unmanaged-ready");
  const gate = join(home, "unmanaged-gate");
  mkdirSync(dirname(config.publicSocket), { recursive: true });
  const child = spawn(process.execPath, [unmanagedFixture], {
    env: {
      ...process.env,
      CODEX_HYBRID_SOCKET: config.publicSocket,
      FAKE_UNMANAGED_READY: ready,
      FAKE_UNMANAGED_GATE: gate,
      FAKE_UNMANAGED_EXIT_AFTER_PROBE: exitAfterProbe ? "1" : "0",
    },
    stdio: "ignore",
  });
  external.push(child.pid!);
  await waitFor(ready);
  writeFileSync(gate, "go\n", { mode: 0o600 });
  return child.pid!;
}

describe("npm-backed hybrid daemon lifecycle", () => {
  it("matches Codex 0.144.6 wire shapes and cleans the detached process group", async () => {
    const { config, home, record } = harness();
    const run = (command: Parameters<typeof runDaemonCommand>[1]["command"], remoteControl = false) =>
      runDaemonCommand(config, { command, remoteControl }, fixture);

    const started = wire(await run("start"));
    expect(started).toMatchObject({
      status: "started",
      backend: "pid",
      managedCodexPath: fixture,
      managedCodexVersion: "0.144.6",
      socketPath: config.publicSocket,
      cliVersion: "0.144.6",
      appServerVersion: "0.144.6",
    });
    expect(typeof started.pid).toBe("number");
    expect(wire(await run("start"))).toEqual({ ...started, status: "alreadyRunning", pid: undefined });
    expect(wire(await run("version"))).toEqual({ ...started, status: "running", pid: undefined });
    expect(wire(await run("enable-remote-control"))).toMatchObject({
      status: "enabled", backend: "pid", remoteControlEnabled: true, cliVersion: "0.144.6", appServerVersion: "0.144.6",
    });
    expect(wire(await run("enable-remote-control"))).toMatchObject({ status: "alreadyEnabled", remoteControlEnabled: true });
    expect(wire(await run("disable-remote-control"))).toMatchObject({ status: "disabled", remoteControlEnabled: false });
    expect(wire(await run("restart"))).toMatchObject({ status: "restarted", backend: "pid", appServerVersion: "0.144.6" });
    expect(wire(await run("stop"))).toMatchObject({ status: "stopped", backend: "pid" });
    expect(wire(await run("stop"))).toMatchObject({ status: "notRunning" });

    const bootstrapped = wire(await run("bootstrap", true));
    expect(bootstrapped).toMatchObject({
      status: "bootstrapped",
      backend: "pid",
      autoUpdateEnabled: false,
      remoteControlEnabled: true,
      managedCodexVersion: "0.144.6",
      appServerVersion: "0.144.6",
    });
    await run("stop");

    expect(statSync(join(home, "app-server-daemon")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "app-server-daemon", "settings.json")).mode & 0o777).toBe(0o600);
    const children = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { pid: number; childPid: number });
    expect(children.length).toBeGreaterThanOrEqual(5);
    expect(children.every(({ pid, childPid }) => !alive(pid) && !alive(childPid))).toBe(true);
  }, 20_000);

  it("kills an orphaned child group during stale PID recovery", async () => {
    const { config, record } = harness();
    const run = (command: Parameters<typeof runDaemonCommand>[1]["command"]) =>
      runDaemonCommand(config, { command, remoteControl: false }, fixture);
    const started = wire(await run("start"));
    const first = JSON.parse(readFileSync(record, "utf8").trim()) as { pid: number; childPid: number };
    process.kill(started.pid as number, "SIGKILL");
    for (let index = 0; index < 100 && alive(first.pid); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(alive(first.childPid)).toBe(true);
    await run("start");
    expect(alive(first.childPid)).toBe(false);
    await run("stop");
  }, 20_000);

  it("replaces an unmanaged gateway that wins the readiness race", async () => {
    const { config, home, record } = harness();
    process.env.FAKE_DAEMON_HANDOFF = "1";
    const result = wire(await runDaemonCommand(config, { command: "start", remoteControl: false }, fixture));
    const records = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      pid: number; handoffPid?: number; childPid?: number;
    });
    const handoff = records.find((entry) => entry.handoffPid)!;
    expect(result).toMatchObject({ status: "started", backend: "pid", appServerVersion: "0.144.6" });
    expect(typeof result.pid).toBe("number");
    expect(alive(handoff.pid)).toBe(false);
    expect(alive(handoff.handoffPid!)).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "app-server-daemon", "app-server.pid"), "utf8"))).toMatchObject({ pid: result.pid });
    await runDaemonCommand(config, { command: "stop", remoteControl: false }, fixture);
  }, 20_000);

  it("takes managed ownership from a pre-existing stock app-server", async () => {
    const { config, home } = harness();
    const stockPid = await startUnmanaged(config, home);
    const result = wire(await runDaemonCommand(config, { command: "start", remoteControl: false }, fixture));
    expect(result).toMatchObject({ status: "started", backend: "pid", appServerVersion: "0.144.6" });
    expect(alive(stockPid)).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "app-server-daemon", "app-server.pid"), "utf8"))).toMatchObject({ pid: result.pid });
    await runDaemonCommand(config, { command: "stop", remoteControl: false }, fixture);
  }, 20_000);

  it("starts managed ownership when the observed app-server exits before takeover identification", async () => {
    const { config, home } = harness();
    const stockPid = await startUnmanaged(config, home, true);
    const result = wire(await runDaemonCommand(config, { command: "start", remoteControl: false }, fixture));
    expect(result).toMatchObject({ status: "started", backend: "pid", appServerVersion: "0.144.6" });
    expect(alive(stockPid)).toBe(false);
    expect(socketOwnerPids(config.publicSocket)).toEqual([result.pid]);
    await runDaemonCommand(config, { command: "stop", remoteControl: false }, fixture);
  }, 20_000);

  it("keeps an App direct start behind restart until the managed child owns the socket", async () => {
    const { config } = harness();
    const run = (command: Parameters<typeof runDaemonCommand>[1]["command"]) =>
      runDaemonCommand(config, { command, remoteControl: false }, fixture);
    await run("start");
    let restarted = false;
    const restart = run("restart").then((result) => {
      restarted = true;
      return wire(result);
    });
    const direct = withGatewayStartupFence(async () => {
      expect(restarted).toBe(true);
      const error = await prepareUnixSocket(config.publicSocket).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      return { error, owners: socketOwnerPids(config.publicSocket) };
    });

    const [result, contender] = await Promise.all([restart, direct]);
    expect(result).toMatchObject({ status: "restarted", backend: "pid" });
    expect(contender.error).toBeInstanceOf(Error);
    expect((contender.error as Error).message).toContain("already serving a process");
    expect(contender.owners).toEqual([result.pid]);
    await run("stop");
  }, 20_000);

  it("does not trust a live managed PID after the socket path is rebound", async () => {
    const { config, home, record } = harness();
    const run = (command: Parameters<typeof runDaemonCommand>[1]["command"]) =>
      runDaemonCommand(config, { command, remoteControl: false }, fixture);
    const first = wire(await run("start"));
    const oldGroup = JSON.parse(readFileSync(record, "utf8").trim()) as { pid: number; childPid: number };
    rmSync(config.publicSocket, { force: true });
    const replacementPid = await startUnmanaged(config, home);

    expect(wire(await run("stop"))).toMatchObject({ status: "notManaged" });
    expect(alive(oldGroup.pid)).toBe(false);
    expect(alive(oldGroup.childPid)).toBe(false);
    expect(alive(replacementPid)).toBe(true);
    await expect(probeAppServer(config.publicSocket)).resolves.toMatchObject({ appServerVersion: "0.144.6" });
    expect(first.pid).toBe(oldGroup.pid);

    const restarted = wire(await run("start"));
    expect(restarted).toMatchObject({ status: "started", backend: "pid" });
    expect(restarted.pid).not.toBe(first.pid);
    expect(alive(replacementPid)).toBe(false);
    await run("stop");
  }, 20_000);

  it("hard-fails without signaling an unrelated process on the public socket", async () => {
    const { config, home } = harness();
    const ready = join(home, "unrelated-ready");
    mkdirSync(dirname(config.publicSocket), { recursive: true });
    const child = spawn(process.execPath, [unrelatedFixture], {
      env: { ...process.env, FAKE_UNRELATED_SOCKET: config.publicSocket, FAKE_UNRELATED_READY: ready },
      stdio: "ignore",
    });
    external.push(child.pid!);
    await waitFor(ready);
    await expect(runDaemonCommand(config, { command: "start", remoteControl: false }, fixture)).rejects.toThrow();
    expect(alive(child.pid!)).toBe(true);
    expect(existsSync(join(home, "app-server-daemon", "app-server.pid"))).toBe(false);
  }, 20_000);
});
