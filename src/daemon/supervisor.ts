import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CHILD_PID_FILE = "CODEX_HYBRID_DAEMON_PID_FILE";
const CHILD_TOKEN = "CODEX_HYBRID_DAEMON_TOKEN";
const REMOTE_CONTROL_DISABLED = "CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED";
const POLL_MS = 50;
const START_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 60_000;
const STOP_TIMEOUT_MS = 70_000;
const LOCK_TIMEOUT_MS = 75_000;

export interface PidRecord {
  readonly pid: number;
  readonly processStartTime: string;
  readonly wrapperPath?: string;
}

interface LockOwner extends PidRecord {
  readonly token: string;
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function daemonStateDirectory(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-daemon");
}

function hasDaemonChildHandshake(): boolean {
  const pidFile = process.env[CHILD_PID_FILE];
  const token = process.env[CHILD_TOKEN];
  if (!pidFile && !token) return false;
  if (!pidFile || !token) throw new Error("incomplete daemon child handshake environment");
  return true;
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function linuxStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
    return fields[19] ? `linux:${fields[19]}` : undefined;
  } catch {
    return undefined;
  }
}

export function processStartTime(pid: number): string | undefined {
  if (!processExists(pid)) return undefined;
  if (process.platform === "linux") return linuxStartTime(pid);
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value ? `ps:${value}` : undefined;
}

export function processMatches(record: PidRecord): boolean {
  return processStartTime(record.pid) === record.processStartTime;
}

function parseRecord(contents: string): PidRecord {
  const value = JSON.parse(contents) as Partial<PidRecord>;
  if (
    !Number.isInteger(value.pid)
    || typeof value.processStartTime !== "string"
    || (value.wrapperPath !== undefined && typeof value.wrapperPath !== "string")
  ) {
    throw new Error("invalid pid record");
  }
  return value as PidRecord;
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function sameRecord(path: string, expected: PidRecord): boolean {
  try {
    return JSON.stringify(parseRecord(readFileSync(path, "utf8"))) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function removeRecord(path: string, expected?: PidRecord): void {
  if (!expected || sameRecord(path, expected)) rmSync(path, { force: true });
}

function groupExists(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(processGroup: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroup, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function preserveCorruptPidFile(path: string): void {
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function reconcileManagedProcess(pidFile: string): PidRecord | undefined {
  if (!existsSync(pidFile)) return undefined;
  let record: PidRecord;
  try {
    record = parseRecord(readFileSync(pidFile, "utf8"));
  } catch {
    preserveCorruptPidFile(pidFile);
    return undefined;
  }
  if (record.pid === 0 && record.processStartTime.startsWith("starting:")) {
    if (Date.now() - statSync(pidFile).mtimeMs >= START_TIMEOUT_MS) removeRecord(pidFile, record);
    return undefined;
  }
  if (record.pid > 0 && processMatches(record)) return record;
  if (record.pid > 0 && !processExists(record.pid)) signalGroup(record.pid, "SIGKILL");
  removeRecord(pidFile, record);
  return undefined;
}

export async function publishDaemonChildRecord(): Promise<() => void> {
  const pidFile = process.env[CHILD_PID_FILE];
  const token = process.env[CHILD_TOKEN];
  if (!pidFile && !token) return () => undefined;
  if (!pidFile || !token) throw new Error("incomplete daemon child handshake environment");
  const reservation = parseRecord(readFileSync(pidFile, "utf8"));
  if (reservation.pid !== 0 || reservation.processStartTime !== `starting:${token}`) {
    throw new Error("daemon child reservation no longer belongs to this process");
  }
  const startTime = processStartTime(process.pid);
  if (!startTime) throw new Error(`failed to record daemon child process ${process.pid} startup`);
  const record = {
    pid: process.pid,
    processStartTime: startTime,
    ...(reservation.wrapperPath ? { wrapperPath: reservation.wrapperPath } : {}),
  };
  atomicWrite(pidFile, record);
  delete process.env[CHILD_PID_FILE];
  delete process.env[CHILD_TOKEN];
  return () => removeRecord(pidFile, record);
}

export async function spawnDetachedGateway(options: {
  readonly wrapperPath: string;
  readonly pidFile: string;
  readonly stderrLog: string;
  readonly remoteControlEnabled: boolean;
}): Promise<number> {
  const token = randomUUID();
  const reservation = {
    pid: 0,
    processStartTime: `starting:${token}`,
    wrapperPath: options.wrapperPath,
  };
  atomicWrite(options.pidFile, reservation);
  mkdirSync(dirname(options.stderrLog), { recursive: true, mode: 0o700 });
  const stderr = openSync(options.stderrLog, "w", 0o600);
  const args = [options.wrapperPath, "app-server"];
  if (options.remoteControlEnabled) args.push("--remote-control");
  args.push("--listen", "unix://");
  const env = {
    ...process.env,
    [CHILD_PID_FILE]: options.pidFile,
    [CHILD_TOKEN]: token,
    ...(options.remoteControlEnabled ? {} : { [REMOTE_CONTROL_DISABLED]: "1" }),
  };
  let child;
  let spawnError: Error | undefined;
  try {
    child = spawn(process.execPath, args, { detached: true, env, stdio: ["ignore", "ignore", stderr] });
  } catch (error) {
    closeSync(stderr);
    removeRecord(options.pidFile, reservation);
    throw error;
  }
  child.once("error", (error) => { spawnError = error; });
  closeSync(stderr);
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const record = reconcileManagedProcess(options.pidFile);
    if (record && record.pid === child.pid) return record.pid;
    if (spawnError || child.exitCode !== null) break;
    await sleep(POLL_MS);
  }
  if (child.pid) {
    try { signalGroup(child.pid, "SIGKILL"); } catch { /* preserve the startup failure below */ }
  }
  removeRecord(options.pidFile);
  const stderrTail = existsSync(options.stderrLog) ? readFileSync(options.stderrLog, "utf8").slice(-4_096).trim() : "";
  const detail = stderrTail ? `\n\nManaged app-server stderr (${options.stderrLog}):\n${stderrTail}` : "";
  throw spawnError ?? new Error(`detached app-server exited before PID publication${detail}`);
}

export async function stopManagedProcess(pidFile: string, expected?: PidRecord): Promise<void> {
  const current = reconcileManagedProcess(pidFile);
  if (expected && current && !sameRecord(pidFile, expected)) return;
  const record = expected && processMatches(expected) ? expected : current;
  if (!record) return;
  signalGroup(record.pid, "SIGTERM");
  const startedAt = Date.now();
  let forced = false;
  while (Date.now() - startedAt < STOP_TIMEOUT_MS) {
    if (!groupExists(record.pid)) {
      removeRecord(pidFile, record);
      return;
    }
    if (!forced && Date.now() - startedAt >= STOP_GRACE_MS) {
      signalGroup(record.pid, "SIGKILL");
      forced = true;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`timed out waiting for pid-managed app server ${record.pid} to stop`);
}

export async function killManagedProcess(pidFile: string, expected: PidRecord): Promise<void> {
  const current = reconcileManagedProcess(pidFile);
  if (!current || current.pid !== expected.pid || current.processStartTime !== expected.processStartTime) return;
  // A stale gateway whose socket pathname was rebound must not run graceful
  // cleanup: its rm(socketPath) would unlink the new owner's live endpoint.
  // PID/start-time still fences this dedicated detached process group.
  signalGroup(expected.pid, "SIGKILL");
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!groupExists(expected.pid)) {
      removeRecord(pidFile, expected);
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`timed out killing stale pid-managed app server ${expected.pid}`);
}

function readLockOwner(path: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    return Number.isInteger(value.pid) && typeof value.processStartTime === "string" && typeof value.token === "string"
      ? value as LockOwner
      : undefined;
  } catch {
    return undefined;
  }
}

function recoverLock(lockDirectory: string): void {
  const recovery = `${lockDirectory}.recovery`;
  try {
    mkdirSync(recovery, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return;
  }
  try {
    const owner = readLockOwner(`${lockDirectory}/owner.json`);
    const age = existsSync(lockDirectory) ? Date.now() - statSync(lockDirectory).mtimeMs : 0;
    if ((!owner && age >= START_TIMEOUT_MS) || (owner && !processMatches(owner))) {
      rmSync(lockDirectory, { recursive: true, force: true });
    }
  } finally {
    rmSync(recovery, { recursive: true, force: true });
  }
}

export async function withDaemonLock<T>(stateDirectory: string, operation: () => Promise<T>): Promise<T> {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const lockFile = `${stateDirectory}/daemon.lock`;
  const descriptor = openSync(lockFile, "a", 0o600);
  closeSync(descriptor);
  chmodSync(lockFile, 0o600);
  const lockDirectory = `${lockFile}.hybrid`;
  const startTime = processStartTime(process.pid);
  if (!startTime) throw new Error("failed to identify daemon operation process");
  const owner: LockOwner = { pid: process.pid, processStartTime: startTime, token: randomUUID() };
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lockDirectory, { mode: 0o700 });
      atomicWrite(`${lockDirectory}/owner.json`, owner);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      recoverLock(lockDirectory);
      if (Date.now() >= deadline) throw new Error(`timed out waiting for daemon operation lock ${lockFile}`);
      await sleep(POLL_MS);
    }
  }
  try {
    return await operation();
  } finally {
    const current = readLockOwner(`${lockDirectory}/owner.json`);
    if (current?.token === owner.token) rmSync(lockDirectory, { recursive: true, force: true });
  }
}

export function withGatewayStartupFence<T>(operation: () => Promise<T>): Promise<T> {
  return hasDaemonChildHandshake()
    ? operation()
    : withDaemonLock(daemonStateDirectory(), operation);
}
