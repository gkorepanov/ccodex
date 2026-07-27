import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { daemonStateDirectory } from "./supervisor.js";

export interface DaemonSettings {
  readonly remoteControlEnabled: boolean;
}

export function daemonSettingsPath(): string {
  return join(daemonStateDirectory(), "settings.json");
}

export function loadDaemonSettings(path = daemonSettingsPath()): DaemonSettings {
  if (!existsSync(path)) return { remoteControlEnabled: false };
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonSettings>;
  if (typeof value.remoteControlEnabled !== "boolean") throw new Error(`failed to parse daemon settings ${path}`);
  return { remoteControlEnabled: value.remoteControlEnabled };
}

export function saveDaemonSettings(settings: DaemonSettings, path = daemonSettingsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
