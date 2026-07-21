#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

function identifiers(value: string | undefined): Array<number | string> {
  return value?.split(".").map((part) => /^\d+$/u.test(part) ? Number(part) : part) ?? [];
}

export function compareSemver(left: string, right: string): number {
  const pattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
  const a = pattern.exec(left);
  const b = pattern.exec(right);
  if (!a || !b) throw new Error(`Invalid semantic version comparison: '${left}' and '${right}'.`);
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(a[index]) - Number(b[index]);
    if (delta !== 0) return Math.sign(delta);
  }
  const aPre = identifiers(a[4]);
  const bPre = identifiers(b[4]);
  if (aPre.length === 0 || bPre.length === 0) return aPre.length === bPre.length ? 0 : aPre.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(aPre.length, bPre.length); index += 1) {
    const x = aPre[index];
    const y = bPre[index];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "string") return -1;
    if (typeof x === "string" && typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function packageIsNewer(candidateManifest: string | URL, currentManifest: string): boolean {
  if (!existsSync(currentManifest)) return true;
  const version = (path: string | URL) => (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
  return compareSemver(version(candidateManifest), version(currentManifest)) > 0;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const current = process.argv[2];
  if (!current) process.exitCode = 2;
  else process.exitCode = packageIsNewer(new URL("../../package.json", import.meta.url), current) ? 0 : 1;
}
