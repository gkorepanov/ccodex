import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { processMatches, processStartTime, type PidRecord } from "./supervisor.js";

const POLL_MS = 50;
const STOP_GRACE_MS = 10_000;
const STOP_TIMEOUT_MS = 15_000;

interface GatewayOwner extends PidRecord {
  readonly schemaVersion: 1;
  readonly token: string;
}

export interface SocketOwnershipRuntime {
  readonly ownerPids: (socketPath: string) => number[];
  readonly processStartTime: (pid: number) => string | undefined;
  readonly processMatches: (record: PidRecord) => boolean;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function gatewayOwnerFile(socketPath: string): string {
  return `${socketPath}.ccodex-owner.json`;
}

function linuxSocketOwners(socketPath: string): number[] {
  const inodes = new Set(
    readFileSync("/proc/net/unix", "utf8")
      .split("\n")
      .slice(1)
      .map((line) => /^\S+:\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)(?:\s+(.*))?$/u.exec(line.trim()))
      .filter((match) => match?.[2] === socketPath)
      .map((match) => match?.[1])
      .filter((inode): inode is string => Boolean(inode)),
  );
  if (inodes.size === 0) return [];
  const owners = new Set<number>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      for (const descriptor of readdirSync(`/proc/${entry}/fd`)) {
        const target = readlinkSync(`/proc/${entry}/fd/${descriptor}`);
        const match = /^socket:\[(\d+)\]$/u.exec(target);
        if (match?.[1] && inodes.has(match[1])) {
          owners.add(Number(entry));
          break;
        }
      }
    } catch {
      // Processes can exit, close descriptors, or be inaccessible during the scan.
    }
  }
  return [...owners].sort((left, right) => left - right);
}

function lsofSocketOwners(socketPath: string): number[] {
  const command = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
  const result = spawnSync(command, ["-n", "-P", "-t", "--", socketPath], { encoding: "utf8" });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw result.error ?? new Error(`lsof failed with status ${result.status}: ${result.stderr.trim()}`);
  }
  return [...new Set(result.stdout.split(/\s+/u).filter(Boolean).map(Number).filter(Number.isInteger))]
    .sort((left, right) => left - right);
}

export function socketOwnerPids(socketPath: string): number[] {
  if (process.platform === "linux") return linuxSocketOwners(socketPath);
  if (process.platform === "darwin") return lsofSocketOwners(socketPath);
  throw new Error(`Unix socket ownership discovery is unsupported on ${process.platform}`);
}

const systemOwnershipRuntime: SocketOwnershipRuntime = {
  ownerPids: socketOwnerPids,
  processStartTime,
  processMatches,
  signal: (pid, signal) => process.kill(pid, signal),
  now: Date.now,
  sleep,
};

function readOwner(path: string): GatewayOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<GatewayOwner>;
    return value.schemaVersion === 1 && Number.isInteger(value.pid) &&
      typeof value.processStartTime === "string" && typeof value.token === "string"
      ? value as GatewayOwner
      : undefined;
  } catch {
    return undefined;
  }
}

function sameOwner(path: string, expected: GatewayOwner): boolean {
  const current = readOwner(path);
  return current?.token === expected.token && current.pid === expected.pid &&
    current.processStartTime === expected.processStartTime;
}

export function publishGatewayOwner(socketPath: string): () => void {
  const path = gatewayOwnerFile(socketPath);
  const startTime = processStartTime(process.pid);
  if (!startTime) throw new Error(`failed to identify gateway process ${process.pid}`);
  const owner: GatewayOwner = {
    schemaVersion: 1,
    pid: process.pid,
    processStartTime: startTime,
    token: randomUUID(),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${owner.token}.tmp`;
  writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return () => {
    if (sameOwner(path, owner)) rmSync(path, { force: true });
  };
}

export function reconcileOwnedGateway(socketPath: string): PidRecord | undefined {
  const path = gatewayOwnerFile(socketPath);
  if (!existsSync(path)) return undefined;
  const owner = readOwner(path);
  if (!owner || !processMatches(owner) || !socketOwnerPids(socketPath).includes(owner.pid)) {
    rmSync(path, { force: true });
    return undefined;
  }
  return { pid: owner.pid, processStartTime: owner.processStartTime };
}

function exactSocketOwnerPresent(
  socketPath: string,
  expected: PidRecord,
  runtime: SocketOwnershipRuntime,
): boolean {
  const owners = runtime.ownerPids(socketPath);
  if (owners.length === 0) return false;
  if (owners.length !== 1 || owners[0] !== expected.pid) {
    throw new Error(`app-server socket owner changed (expected ${expected.pid}, found ${owners.join(", ") || "none"})`);
  }
  if (runtime.processMatches(expected)) return true;
  if (runtime.ownerPids(socketPath).length === 0) return false;
  throw new Error(`app-server owner ${expected.pid} changed identity`);
}

function signalExactSocketOwner(
  socketPath: string,
  expected: PidRecord,
  signal: NodeJS.Signals,
  runtime: SocketOwnershipRuntime,
): boolean {
  if (!exactSocketOwnerPresent(socketPath, expected, runtime)) return false;
  try {
    runtime.signal(expected.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return exactSocketOwnerPresent(socketPath, expected, runtime);
  }
  return true;
}

export function identifySocketOwner(
  socketPath: string,
  expected?: PidRecord,
  runtime: SocketOwnershipRuntime = systemOwnershipRuntime,
): PidRecord | undefined {
  const owners = runtime.ownerPids(socketPath);
  if (owners.length === 0) return undefined;
  if (owners.length !== 1) {
    throw new Error(`refusing app-server takeover: expected one owner for ${socketPath}, found ${owners.join(", ")}`);
  }
  const pid = owners[0]!;
  if (expected && pid !== expected.pid) {
    throw new Error(`refusing app-server takeover: socket owner changed from ${expected.pid} to ${pid}`);
  }
  const startTime = runtime.processStartTime(pid);
  if (!startTime) {
    if (runtime.ownerPids(socketPath).length === 0) return undefined;
    throw new Error(`refusing app-server takeover: owner ${pid} exited during identification`);
  }
  const record = { pid, processStartTime: startTime };
  if (expected && startTime !== expected.processStartTime) {
    throw new Error(`refusing app-server takeover: owner ${pid} changed identity`);
  }
  if (!exactSocketOwnerPresent(socketPath, record, runtime)) return undefined;
  return record;
}

export async function stopSocketOwner(
  socketPath: string,
  expected: PidRecord,
  runtime: SocketOwnershipRuntime = systemOwnershipRuntime,
): Promise<void> {
  if (!signalExactSocketOwner(socketPath, expected, "SIGTERM", runtime)) return;
  const startedAt = runtime.now();
  let forced = false;
  while (runtime.now() - startedAt < STOP_TIMEOUT_MS) {
    if (!exactSocketOwnerPresent(socketPath, expected, runtime)) return;
    if (!forced && runtime.now() - startedAt >= STOP_GRACE_MS) {
      // Fence PID reuse and socket handoff again immediately before escalation.
      if (!signalExactSocketOwner(socketPath, expected, "SIGKILL", runtime)) return;
      forced = true;
    }
    await runtime.sleep(POLL_MS);
  }
  throw new Error(`timed out waiting for app-server socket owner ${expected.pid} to stop`);
}
