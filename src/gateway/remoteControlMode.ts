import { loadDaemonSettings } from "../daemon/settings.js";

const DISABLED_ENV = "CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED";

export function remoteControlEnabled(args: readonly string[]): boolean {
  if (process.env[DISABLED_ENV] === "1") return false;
  if (args.includes("--remote-control")) return true;
  return loadDaemonSettings().remoteControlEnabled;
}
