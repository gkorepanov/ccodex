import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, type InstallLayout } from "./layout.js";

export const MANAGED_BLOCK_BEGIN = "# >>> ccodex >>>";
export const MANAGED_BLOCK_END = "# <<< ccodex <<<";

function codexCliPathExport(layout: InstallLayout, shell: "posix" | "fish"): string {
  // The local Codex App ignores PATH; on macOS point it at the managed desktop entry so
  // terminal-launched App instances match the GUI. No-op elsewhere (no local App exists).
  if (process.platform !== "darwin") return "";
  const entry = join(layout.bin, "codex");
  return shell === "fish"
    ? `set -gx CODEX_CLI_PATH "${entry}"\n`
    : `export CODEX_CLI_PATH="${entry}"\n`;
}

export function posixManagedBlock(layout: InstallLayout): string {
  return `${MANAGED_BLOCK_BEGIN}\nexport PATH="${layout.bin}:$PATH"\n${codexCliPathExport(layout, "posix")}${MANAGED_BLOCK_END}\n`;
}

export function fishManagedBlock(layout: InstallLayout): string {
  return `${MANAGED_BLOCK_BEGIN}\nfish_add_path --move --prepend "${layout.bin}"\n${codexCliPathExport(layout, "fish")}${MANAGED_BLOCK_END}\n`;
}

export function legacyPosixManagedBlock(layout: InstallLayout): string {
  return `${MANAGED_BLOCK_BEGIN}\nexport PATH="${layout.bin}:$PATH"\n${MANAGED_BLOCK_END}\n`;
}

export function legacyFishManagedBlock(layout: InstallLayout): string {
  return `${MANAGED_BLOCK_BEGIN}\nfish_add_path --move --prepend "${layout.bin}"\n${MANAGED_BLOCK_END}\n`;
}

export interface ShellBlockChange {
  readonly path: string;
  readonly before: string;
  readonly mode: number;
}

export function migrateDesktopShellBlocks(
  layout: InstallLayout,
  files: readonly string[],
  enabled: boolean,
): ShellBlockChange[] {
  const candidates = files
    .filter((path) => !path.endsWith("ccodex.fish"))
    .map((path) => {
      const fish = path.endsWith("config.fish");
      const desktop = fish ? fishManagedBlock(layout) : posixManagedBlock(layout);
      const legacy = fish ? legacyFishManagedBlock(layout) : legacyPosixManagedBlock(layout);
      return { path, from: enabled ? legacy : desktop, to: enabled ? desktop : legacy };
    });
  for (const { path, from, to } of candidates) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    if (content.includes(to) || content.includes(from)) continue;
    if (content.includes(MANAGED_BLOCK_BEGIN)) {
      throw new Error(`Refusing to migrate a modified CCodex block in ${path}`);
    }
  }
  const changes: ShellBlockChange[] = [];
  for (const { path, from, to } of candidates) {
    if (!existsSync(path)) continue;
    const before = readFileSync(path, "utf8");
    if (!before.includes(from) || before.includes(to)) continue;
    const mode = statSync(path).mode & 0o777;
    atomicWrite(path, before.replace(from, to), mode);
    changes.push({ path, before, mode });
  }
  return changes;
}

export function restoreShellBlockChanges(changes: readonly ShellBlockChange[]): void {
  for (const change of [...changes].reverse()) atomicWrite(change.path, change.before, change.mode);
}
