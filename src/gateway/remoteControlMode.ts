import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DISABLED_ENV = "CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED";

export function remoteControlEnabled(args: readonly string[]): boolean {
  if (process.env[DISABLED_ENV] === "1") return false;
  if (args.includes("--remote-control")) return true;
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const settingsPath = join(codexHome, "app-server-daemon", "settings.json");
  if (!existsSync(settingsPath)) return false;
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { remoteControlEnabled?: unknown };
  if (typeof settings.remoteControlEnabled !== "boolean") {
    throw new Error(`failed to parse daemon settings ${settingsPath}`);
  }
  return settings.remoteControlEnabled;
}
