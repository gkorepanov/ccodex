import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function atomicWrite(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

export function atomicSymlink(target: string, path: string): void {
  const temporary = `${path}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, path);
}
