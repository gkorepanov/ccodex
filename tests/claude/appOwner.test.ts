import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { foreignOwner, releaseIdleAppOwner } from "../../src/claude/peers.js";

const SESSION = "5bc12a00-0000-4000-8000-0000000000aa";
const roots: string[] = [];
const launchers: ChildProcess[] = [];
afterEach(() => {
  for (const launcher of launchers.splice(0)) launcher.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A process held by a launcher: under a path like the Claude App's, or elsewhere. Resolves to the held process's pid. */
async function held(root: string, app: boolean): Promise<number> {
  const directory = join(root, app ? "Claude.app" : "Terminal", "Contents");
  mkdirSync(directory, { recursive: true });
  const script = join(directory, "launcher.sh");
  writeFileSync(script, "#!/bin/sh\nsleep 300 &\necho $!\nwait\n");
  chmodSync(script, 0o755);
  const launcher = spawn("/bin/sh", [script], { stdio: ["ignore", "pipe", "ignore"] });
  launchers.push(launcher);
  const pid = await new Promise<number>((resolve) => launcher.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
  return pid;
}

function home(records: Array<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), "ccodex-owner-"));
  roots.push(root);
  mkdirSync(join(root, "sessions"));
  for (const record of records) writeFileSync(join(root, "sessions", `${record.pid}.json`), JSON.stringify(record));
  return root;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const idle = (pid: number, extra: Record<string, unknown> = {}) =>
  ({ pid, sessionId: SESSION, entrypoint: "claude-desktop", status: "idle", statusUpdatedAt: Date.now() - 60_000, ...extra });

describe("an idle Claude App process on a chat", () => {
  it("is asked to exit, and the chat is free", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccodex-app-")); roots.push(root);
    const pid = await held(root, true);
    const claude = home([idle(pid)]);
    expect(foreignOwner(claude, SESSION)).toBe(pid);
    expect(await releaseIdleAppOwner(claude, SESSION)).toBe(true);
    expect(alive(pid)).toBe(false);
  });

  it("stays when it is busy, has only just gone idle, or is not the App's", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccodex-app-")); roots.push(root);
    const app = await held(root, true), terminal = await held(root, false);
    expect(await releaseIdleAppOwner(home([idle(app, { status: "busy" })]), SESSION)).toBe(false);
    expect(await releaseIdleAppOwner(home([idle(app, { statusUpdatedAt: Date.now() - 500 })]), SESSION)).toBe(false);
    expect(await releaseIdleAppOwner(home([idle(app, { entrypoint: "cli" })]), SESSION)).toBe(false);
    expect(await releaseIdleAppOwner(home([idle(terminal)]), SESSION)).toBe(false);
    // One of two owners may not go: neither is touched.
    expect(await releaseIdleAppOwner(home([idle(app), idle(terminal)]), SESSION)).toBe(false);
    expect([alive(app), alive(terminal)]).toEqual([true, true]);
  });

  it("is nothing to do when no other process holds the chat", async () => {
    expect(await releaseIdleAppOwner(home([]), SESSION)).toBe(true);
    expect(await releaseIdleAppOwner(home([idle(process.pid, { sessionId: "another" })]), SESSION)).toBe(true);
  });
});
