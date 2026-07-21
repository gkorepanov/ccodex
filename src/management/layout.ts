import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface InstallLayout {
  readonly home: string;
  readonly bin: string;
  readonly versions: string;
  readonly staging: string;
  readonly state: string;
  readonly current: string;
  readonly previous: string;
  readonly manifest: string;
}

export function installLayout(): InstallLayout {
  const home = resolve(process.env.CCODEX_HOME ?? join(homedir(), ".ccodex"));
  return {
    home,
    bin: join(home, "bin"),
    versions: join(home, "versions"),
    staging: join(home, "staging"),
    state: join(home, "state"),
    current: join(home, "current"),
    previous: join(home, "previous"),
    manifest: join(home, "install.json"),
  };
}

export function ensureLayout(layout: InstallLayout): void {
  for (const directory of [layout.home, layout.bin, layout.versions, layout.staging, layout.state]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
}

export function atomicWrite(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

export function atomicSymlink(target: string, path: string): void {
  const temporary = `${path}.tmp-${process.pid}`;
  try { rmSync(temporary, { force: true }); } catch { /* best effort stale cleanup */ }
  symlinkSync(target, temporary);
  renameSync(temporary, path);
}
