import { closeSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_TIMEOUT_MS = 10_000;
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireSocketStartupLock(path: string): Promise<() => void> {
  const lockPath = `${path}.startup.lock`;
  const token = randomUUID();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      closeSync(fd);
      return () => {
        try {
          const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: string };
          if (owner.token === token) unlinkSync(lockPath);
        } catch {
          // The lock was already removed or replaced by stale recovery.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
        if (typeof owner.pid !== "number" || !processExists(owner.pid)) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        rmSync(lockPath, { force: true });
        continue;
      }
      await sleep(25);
    }
  }
  throw new Error(`Timed out acquiring app-server startup lock '${lockPath}'.`);
}

function canConnect(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const finish = (connected: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function prepareUnixSocket(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (await canConnect(path)) throw new Error(`Socket '${path}' is already serving a process.`);
  rmSync(path, { force: true });
}
