import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Sub-agent chats a server started and has not archived yet, with its pid. A server killed mid-call cannot archive its
 * chat; the next server archives the chats whose owner is no longer running.
 */
type Entries = Record<string, { pid: number; at: number }>;

const file = (dataDir: string) => join(dataDir, "subagent-chats.json");

function read(dataDir: string): Entries {
  try { return JSON.parse(readFileSync(file(dataDir), "utf8")) as Entries; } catch { return {}; }
}

function write(dataDir: string, entries: Entries): void {
  try {
    mkdirSync(dirname(file(dataDir)), { recursive: true });
    const temporary = `${file(dataDir)}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(entries));
    renameSync(temporary, file(dataDir));
  } catch { /* the registry is a safety net; a call must not fail for it */ }
}

export function recordSubagentChat(dataDir: string, threadId: string): void {
  write(dataDir, { ...read(dataDir), [threadId]: { pid: process.pid, at: Date.now() } });
}

export function forgetSubagentChat(dataDir: string, threadId: string): void {
  const entries = read(dataDir);
  if (threadId in entries) { delete entries[threadId]; write(dataDir, entries); }
}

const running = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/** Chat ids whose owning server is gone; they are dropped from the registry so only one server archives each. */
export function claimOrphanedSubagentChats(dataDir: string): string[] {
  if (!existsSync(file(dataDir))) return [];
  const entries = read(dataDir);
  const orphaned = Object.keys(entries).filter((id) => entries[id]!.pid !== process.pid && !running(entries[id]!.pid));
  if (orphaned.length) { for (const id of orphaned) delete entries[id]; write(dataDir, entries); }
  return orphaned;
}
