import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicSymlink, type InstallLayout } from "./layout.js";

export interface RemoteCodexShim {
  readonly path: string;
  readonly target: string;
  readonly backupPath?: string;
}

function isOwned(record: RemoteCodexShim): boolean {
  return existsSync(record.path) && lstatSync(record.path).isSymbolicLink() &&
    resolve(dirname(record.path), readlinkSync(record.path)) === resolve(record.target);
}

export function installRemoteCodexShim(
  layout: InstallLayout,
  previous?: RemoteCodexShim,
): RemoteCodexShim | undefined {
  const path = join(resolve(process.env.CODEX_INSTALL_DIR ?? join(homedir(), ".local", "bin")), "codex");
  const target = join(layout.bin, "codex");
  if (path === target) return undefined;
  if (previous && previous.path !== path) {
    throw new Error(`CODEX_INSTALL_DIR changed from '${dirname(previous.path)}' to '${dirname(path)}'. Uninstall CCodex before changing it.`);
  }
  if (previous && !isOwned(previous)) throw new Error(`Refusing to overwrite modified managed shim ${previous.path}`);

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let backupPath = previous?.backupPath;
  let backedUp = false;
  try {
    if (!previous && existsSync(path)) {
      const candidate = { path, target };
      if (!isOwned(candidate)) {
        backupPath = join(layout.home, "backups", "remote-codex");
        if (existsSync(backupPath)) throw new Error(`Remote Codex backup already exists: ${backupPath}`);
        mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
        renameSync(path, backupPath);
        backedUp = true;
      }
    }
    atomicSymlink(target, path);
  } catch (error) {
    if (backedUp && backupPath && !existsSync(path)) renameSync(backupPath, path);
    throw error;
  }
  return { path, target, ...(backupPath ? { backupPath } : {}) };
}

export function relocatedDelegate(record: RemoteCodexShim | undefined, delegate: string | undefined): string | undefined {
  return record?.backupPath && delegate && resolve(delegate) === resolve(record.path) ? record.backupPath : delegate;
}

export function restoreRemoteCodexShim(current: RemoteCodexShim | undefined, previous?: RemoteCodexShim): void {
  if (!current || !isOwned(current)) return;
  if (previous) {
    atomicSymlink(previous.target, previous.path);
    return;
  }
  rmSync(current.path);
  if (current.backupPath && existsSync(current.backupPath)) renameSync(current.backupPath, current.path);
}

export function uninstallRemoteCodexShim(record: RemoteCodexShim): boolean {
  if (!isOwned(record)) return false;
  rmSync(record.path);
  if (record.backupPath && existsSync(record.backupPath)) renameSync(record.backupPath, record.path);
  return true;
}
