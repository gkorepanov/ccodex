import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * `~/.ccodex/state/trash/<time>_<thread id>/`: whatever CCodex removes of a chat (a deleted or rolled-back-to-nothing
 * Claude transcript with its sub-agents' folder, a GPT backend a revert drops) lands here with the chat's meta.json
 * entries, and stays until the user empties it: CCodex never deletes a chat for good. `moved` leave their place,
 * `copied` stay (their owner deletes them itself).
 */
export function toTrash(dataDir: string, threadId: string, files: { moved?: string[]; copied?: string[] }, meta: unknown): void {
  const directory = join(dataDir, "trash", `${new Date().toISOString().replace(/[:.]/gu, "-")}_${threadId}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "meta.json"), `${JSON.stringify({ threadId, ...files, meta }, null, 2)}\n`, { mode: 0o600 });
  for (const path of files.copied ?? []) if (existsSync(path)) cpSync(path, join(directory, basename(path)), { recursive: true });
  for (const path of files.moved ?? []) {
    if (!existsSync(path)) continue;
    const target = join(directory, basename(path));
    try {
      renameSync(path, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      // Another filesystem (CLAUDE_CONFIG_DIR elsewhere): copied whole before the original goes.
      cpSync(path, target, { recursive: true });
      rmSync(path, { recursive: true, force: true });
    }
  }
}
