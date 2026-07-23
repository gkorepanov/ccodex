import { join } from "node:path";
import type { InstallLayout } from "./layout.js";

export const MANAGED_BLOCK_BEGIN = "# >>> ccodex >>>";
export const MANAGED_BLOCK_END = "# <<< ccodex <<<";

function codexCliPathExport(layout: InstallLayout, shell: "posix" | "fish"): string {
  // The local Codex App ignores PATH; on macOS point it at the managed desktop entry so
  // terminal-launched App instances match the GUI. No-op elsewhere (no local App exists).
  if (process.platform !== "darwin") return "";
  const entry = join(layout.bin, "codex-desktop");
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
