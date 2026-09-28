import { existsSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";

/** Upgrade header the stdio frontend uses to announce the App's app-tools socket. */
export const APP_TOOLS_PIPE_HEADER = "x-ccodex-app-tools-pipe";

/**
 * The Codex App tells the app-server it launches where its app-tools socket
 * lives through CODEX_APP_TOOLS_PIPE_PATH. Under CCodex that process is only the
 * stdio frontend; the gateway and the stock app-server behind it are long-lived
 * and may have been started from a terminal, so they never see the variable and
 * every thread's `codex_app` MCP server fails to start. The stock app-server is
 * therefore always given one stable symlink, and each frontend connection
 * repoints that symlink at the socket its App instance announced. connect(2)
 * follows the symlink, so a retarget takes effect on the next MCP startup.
 */
export function retargetAppToolsLink(linkPath: string, target: string): boolean {
  if (target.length === 0) return false;
  try {
    if (readlinkSync(linkPath) === target) return false;
  } catch {
    // Missing or not a symlink: fall through and replace it.
  }
  const staged = `${linkPath}.${process.pid}.tmp`;
  try { unlinkSync(staged); } catch { /* nothing staged */ }
  symlinkSync(target, staged);
  try {
    renameSync(staged, linkPath);
  } catch (error) {
    try { unlinkSync(staged); } catch { /* best effort */ }
    throw error;
  }
  return true;
}

export function appToolsLinkTarget(linkPath: string): string | undefined {
  try {
    const target = readlinkSync(linkPath);
    return existsSync(target) ? target : undefined;
  } catch {
    return undefined;
  }
}
