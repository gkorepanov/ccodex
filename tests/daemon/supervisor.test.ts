import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  daemonStateDirectory,
  processMatches,
  processStartTime,
  publishDaemonChildRecord,
  reconcileManagedProcess,
  withDaemonLock,
  withGatewayStartupFence,
} from "../../src/daemon/supervisor.js";

const temporary: string[] = [];
const originalEnv = { ...process.env };
const temp = () => {
  const path = mkdtempSync(join(tmpdir(), "hybrid-supervisor-test-"));
  temporary.push(path);
  return path;
};

afterEach(() => {
  process.env = { ...originalEnv };
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("daemon supervisor", () => {
  it("publishes readiness atomically and removes only its own PID record", async () => {
    const directory = temp();
    const pidFile = join(directory, "app-server.pid");
    const token = "ready-token";
    writeFileSync(pidFile, JSON.stringify({ pid: 0, processStartTime: `starting:${token}` }));
    process.env.CODEX_HYBRID_DAEMON_PID_FILE = pidFile;
    process.env.CODEX_HYBRID_DAEMON_TOKEN = token;

    const release = await publishDaemonChildRecord();
    expect(JSON.parse(readFileSync(pidFile, "utf8"))).toEqual({
      pid: process.pid,
      processStartTime: processStartTime(process.pid),
    });
    release();
    expect(existsSync(pidFile)).toBe(false);

    writeFileSync(pidFile, JSON.stringify({ pid: 123, processStartTime: "replacement" }));
    release();
    expect(JSON.parse(readFileSync(pidFile, "utf8"))).toEqual({ pid: 123, processStartTime: "replacement" });
  });

  it("uses process start identity so a recycled PID is never killed", () => {
    const directory = temp();
    const pidFile = join(directory, "app-server.pid");
    writeFileSync(pidFile, JSON.stringify({ pid: process.pid, processStartTime: "wrong" }));
    expect(reconcileManagedProcess(pidFile)).toBeUndefined();
    expect(processMatches({ pid: process.pid, processStartTime: processStartTime(process.pid)! })).toBe(true);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it("preserves a corrupt PID artifact and recovers the active path", () => {
    const directory = temp();
    const pidFile = join(directory, "app-server.pid");
    writeFileSync(pidFile, "not-json");
    expect(reconcileManagedProcess(pidFile)).toBeUndefined();
    expect(readdirSync(directory)).toEqual([expect.stringMatching(/^app-server\.pid\.corrupt-/u)]);
  });

  it("serializes concurrent operations and leaves the stock-compatible lock file", async () => {
    const directory = temp();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = withDaemonLock(directory, async () => {
      order.push("first-enter");
      await held;
      order.push("first-exit");
    });
    while (order.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = withDaemonLock(directory, async () => { order.push("second-enter"); });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["first-enter"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
    expect(readFileSync(join(directory, "daemon.lock"), "utf8")).toBe("");
  });

  it("fences an App-launched direct gateway while the daemon child takes ownership", async () => {
    const home = temp();
    process.env.CODEX_HOME = home;
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lifecycle = withDaemonLock(daemonStateDirectory(), async () => {
      order.push("daemon-enter");
      await held;
      order.push("daemon-exit");
    });
    while (order.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    const direct = withGatewayStartupFence(async () => { order.push("direct"); });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["daemon-enter"]);

    process.env.CODEX_HYBRID_DAEMON_PID_FILE = join(home, "app-server.pid");
    process.env.CODEX_HYBRID_DAEMON_TOKEN = "managed-child";
    await withGatewayStartupFence(async () => { order.push("managed-child"); });
    expect(order).toEqual(["daemon-enter", "managed-child"]);

    release();
    await Promise.all([lifecycle, direct]);
    expect(order).toEqual(["daemon-enter", "managed-child", "daemon-exit", "direct"]);
  });

  it("recovers a stale lock owner", async () => {
    const directory = temp();
    const lockDirectory = join(directory, "daemon.lock.hybrid");
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({ pid: 999_999_999, processStartTime: "dead", token: "stale" }));
    await withDaemonLock(directory, async () => undefined);
    expect(readdirSync(directory)).toEqual(["daemon.lock"]);
  });
});
