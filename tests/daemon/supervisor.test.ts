import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  daemonStateDirectory,
  processMatches,
  processStartTime,
  publishDaemonChildRecord,
  reconcileManagedProcess,
  stopManagedProcess,
  withDaemonLock,
  withGatewayStartupFence,
} from "../../src/daemon/supervisor.js";

// Keep real filesystem operations, with a configurable export for the interleaving test.
vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }));

const temporary: string[] = [];
const originalEnv = { ...process.env };
const spawned: ChildProcess[] = [];
const temp = () => {
  const path = mkdtempSync(join(tmpdir(), "hybrid-supervisor-test-"));
  temporary.push(path);
  return path;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const child of spawned.splice(0)) {
    try { child.kill("SIGKILL"); } catch { /* already stopped */ }
  }
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
    // Stock verifies the record by the Linux native identity it checks first: the boot and the start ticks.
    const startTicks = Number(processStartTime(process.pid)!.slice("linux:".length));
    expect(JSON.parse(readFileSync(pidFile, "utf8"))).toEqual({
      pid: process.pid,
      processStartTime: processStartTime(process.pid),
      processIdentity: { bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), startTicks },
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

  it.runIf(process.platform === "linux")("treats an unreaped zombie-only process group as stopped", async () => {
    const directory = temp();
    const pidFile = join(directory, "app-server.pid");
    const parent = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const child = spawn("/bin/true", [], { detached: true, stdio: "ignore" });
      process.stdout.write(String(child.pid) + "\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    `], { stdio: ["ignore", "pipe", "ignore"] });
    spawned.push(parent);
    const zombiePid = await new Promise<number>((resolve, reject) => {
      let output = "";
      parent.stdout!.setEncoding("utf8");
      parent.stdout!.on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("\n")) resolve(Number(output.trim()));
      });
      parent.once("error", reject);
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const stat = readFileSync(`/proc/${zombiePid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const zombieStat = readFileSync(`/proc/${zombiePid}/stat`, "utf8");
    expect(zombieStat.slice(zombieStat.lastIndexOf(")") + 2)).toMatch(/^Z /u);
    expect(() => process.kill(-zombiePid, 0)).not.toThrow();
    const startTime = processStartTime(zombiePid);
    expect(startTime).toBeDefined();
    writeFileSync(pidFile, JSON.stringify({
      pid: zombiePid,
      processStartTime: startTime,
    }));

    const startedAt = Date.now();
    await stopManagedProcess(pidFile);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(existsSync(pidFile)).toBe(false);
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

  it("recovers a stale lock whose recovery marker lost its process", async () => {
    const directory = temp();
    const lockDirectory = join(directory, "daemon.lock.hybrid");
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({ pid: 999_999_999, processStartTime: "dead", token: "stale" }));
    const recovery = `${lockDirectory}.recovery`;
    mkdirSync(recovery);
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(recovery, longAgo, longAgo);
    await withDaemonLock(directory, async () => undefined);
    expect(readdirSync(directory)).toEqual(["daemon.lock"]);
  }, 2_000);

  it("leaves a fresh recovery marker to the process holding it", async () => {
    const directory = temp();
    const lockDirectory = join(directory, "daemon.lock.hybrid");
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({ pid: 999_999_999, processStartTime: "dead", token: "stale" }));
    const recovery = `${lockDirectory}.recovery`;
    mkdirSync(recovery);
    let entered = false;
    const waiter = withDaemonLock(directory, async () => { entered = true; });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(entered).toBe(false);
    expect(existsSync(recovery)).toBe(true);
    rmSync(recovery, { recursive: true });
    await waiter;
    expect(entered).toBe(true);
  });

  it("does not expire a recovery whose owner is still alive", async () => {
    const directory = temp();
    const lockDirectory = join(directory, "daemon.lock.hybrid");
    mkdirSync(lockDirectory);
    writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({ pid: 999_999_999, processStartTime: "dead", token: "stale" }));
    const recovery = `${lockDirectory}.recovery`;
    mkdirSync(recovery);
    const owner = { pid: process.pid, processStartTime: processStartTime(process.pid)!, token: "live-recovery" };
    writeFileSync(join(recovery, `${owner.token}.json`), JSON.stringify(owner));
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(recovery, longAgo, longAgo);
    let entered = false;
    const waiter = withDaemonLock(directory, async () => { entered = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(entered).toBe(false);
      expect(existsSync(join(recovery, `${owner.token}.json`))).toBe(true);
    } finally {
      rmSync(recovery, { recursive: true, force: true });
      await waiter;
    }
  });

  it("does not delete a recovery that replaced the abandoned marker after stat", async () => {
    const directory = temp();
    const lockDirectory = join(directory, "daemon.lock.hybrid");
    mkdirSync(lockDirectory);
    writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({ pid: 999_999_999, processStartTime: "dead", token: "stale" }));
    const recovery = `${lockDirectory}.recovery`;
    mkdirSync(recovery);
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(recovery, longAgo, longAgo);
    const replacement = { pid: process.pid, processStartTime: processStartTime(process.pid)!, token: "replacement-recovery" };
    const stat = fs.statSync;
    let replaced = false;
    vi.spyOn(fs, "statSync").mockImplementation(((path, options) => {
      const result = stat(path, options);
      if (path === recovery && !replaced) {
        replaced = true;
        rmSync(recovery, { recursive: true });
        mkdirSync(recovery);
        writeFileSync(join(recovery, `${replacement.token}.json`), JSON.stringify(replacement));
      }
      return result;
    }) as typeof fs.statSync);
    let entered = false;
    const waiter = withDaemonLock(directory, async () => { entered = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(replaced).toBe(true);
      expect(entered).toBe(false);
      expect(existsSync(join(recovery, `${replacement.token}.json`))).toBe(true);
    } finally {
      vi.restoreAllMocks();
      rmSync(recovery, { recursive: true, force: true });
      await waiter;
    }
  });

  it("recovers a fresh recovery marker after its recorded owner exits", async () => {
    const directory = temp();
    const lockDirectory = join(directory, "daemon.lock.hybrid");
    mkdirSync(lockDirectory);
    writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({ pid: 999_999_999, processStartTime: "dead", token: "stale" }));
    const recovery = `${lockDirectory}.recovery`;
    mkdirSync(recovery);
    const owner = { pid: 999_999_999, processStartTime: "dead", token: "dead-recovery" };
    writeFileSync(join(recovery, `${owner.token}.json`), JSON.stringify(owner));
    await withDaemonLock(directory, async () => undefined);
    expect(readdirSync(directory)).toEqual(["daemon.lock"]);
  }, 2_000);

  it("does not remove a new recovery while finishing cleanup of a dead owner", async () => {
    const directory = temp();
    const lockDirectory = join(directory, "daemon.lock.hybrid");
    mkdirSync(lockDirectory);
    writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({ pid: 999_999_999, processStartTime: "dead", token: "stale" }));
    const recovery = `${lockDirectory}.recovery`;
    mkdirSync(recovery);
    const dead = { pid: 999_999_999, processStartTime: "dead", token: "dead-recovery" };
    const deadPath = join(recovery, `${dead.token}.json`);
    writeFileSync(deadPath, JSON.stringify(dead));
    const replacement = { pid: process.pid, processStartTime: processStartTime(process.pid)!, token: "replacement-recovery" };
    const remove = fs.rmSync;
    let replaced = false;
    vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
      remove(path, options);
      if (path === deadPath && !replaced) {
        replaced = true;
        remove(recovery, { recursive: true });
        mkdirSync(recovery);
        writeFileSync(join(recovery, `${replacement.token}.json`), JSON.stringify(replacement));
      }
    });
    let entered = false;
    const waiter = withDaemonLock(directory, async () => { entered = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(replaced).toBe(true);
      expect(entered).toBe(false);
      expect(existsSync(join(recovery, `${replacement.token}.json`))).toBe(true);
    } finally {
      vi.restoreAllMocks();
      rmSync(recovery, { recursive: true, force: true });
      await waiter;
    }
  });

  it("yields when another recovery publishes its owner first", async () => {
    const directory = temp();
    const lockDirectory = join(directory, "daemon.lock.hybrid");
    mkdirSync(lockDirectory);
    writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({ pid: 999_999_999, processStartTime: "dead", token: "stale" }));
    const recovery = `${lockDirectory}.recovery`;
    const replacement = { pid: process.pid, processStartTime: processStartTime(process.pid)!, token: "winning-recovery" };
    const rename = fs.renameSync;
    let published = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === recovery && !published) {
        published = true;
        mkdirSync(recovery);
        writeFileSync(join(recovery, `${replacement.token}.json`), JSON.stringify(replacement));
      }
      rename(source, destination);
    });
    let entered = false;
    const waiter = withDaemonLock(directory, async () => { entered = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(published).toBe(true);
      expect(entered).toBe(false);
      expect(readdirSync(recovery)).toEqual([`${replacement.token}.json`]);
      expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      rmSync(recovery, { recursive: true, force: true });
      await waiter;
    }
  });
});
