import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { remoteControlEnabled } from "../../src/gateway/remoteControlMode.js";

const originalEnv = { ...process.env };
const roots: string[] = [];

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function settings(enabled: boolean): void {
  const home = mkdtempSync(join(tmpdir(), "remote-mode-"));
  roots.push(home);
  mkdirSync(join(home, "app-server-daemon"));
  writeFileSync(join(home, "app-server-daemon", "settings.json"), JSON.stringify({ remoteControlEnabled: enabled }));
  process.env.CODEX_HOME = home;
}

describe("remote control startup mode", () => {
  it("honors the explicit flag and persisted daemon preference", () => {
    settings(false);
    expect(remoteControlEnabled([])).toBe(false);
    expect(remoteControlEnabled(["--remote-control"])).toBe(true);
    settings(true);
    expect(remoteControlEnabled([])).toBe(true);
  });

  it("gives the daemon disabled marker highest precedence", () => {
    settings(true);
    process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";
    expect(remoteControlEnabled(["--remote-control"])).toBe(false);
  });
});
