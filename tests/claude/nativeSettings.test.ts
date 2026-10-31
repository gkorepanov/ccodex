import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSession, type SessionSettings } from "../../src/claude/session.js";
import { ClaudeThreads } from "../../src/claude/threads.js";
import { Gateway } from "../../src/gateway/server.js";
import { Logger } from "../../src/log.js";
import { testConfig } from "../fixtures/config.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ccodex-native-settings-"));
  roots.push(root);
  const config = testConfig({ nativeMcp: true, dataDir: root, claudeHome: join(root, "claude") });
  const logger = new Logger("error");
  const gateway = new Gateway(config, join(root, "gateway.sock"), logger);
  const settings: SessionSettings = {
    cwd: root, model: "claude-opus-5-5", effort: "high", fast: false,
    permissionMode: "default", plan: false, nativeAccess: { sandbox: "read-only" },
  };
  const session = new ClaudeSession(new ClaudeThreads(config, gateway, logger), "owner", settings, { exists: false });
  const sdk = {
    setModel: async (_model?: string) => {},
    setPermissionMode: async (_mode: string) => {},
    applyFlagSettings: async (_settings: unknown) => {},
  };
  Object.assign(session, { sdk });
  return { gateway, session, sdk };
}

describe("native settings accepted by Claude", () => {
  it.each(["setModel", "setPermissionMode", "applyFlagSettings"] as const)("keeps native authority when %s rejects the update", async (method) => {
    const { gateway, session, sdk } = fixture();
    sdk[method] = async () => { throw new Error("settings rejected"); };
    const params = {
      permissions: ":danger-full-access", approvalPolicy: "never",
      ...(method === "setModel" ? { model: "claude:unavailable" } : {}),
      ...(method === "applyFlagSettings" ? { effort: "low" } : {}),
    };
    await expect(session.updateSettings(params)).rejects.toThrow("settings rejected");
    expect(session.settings.nativeAccess).toEqual({ sandbox: "read-only" });
    expect(gateway.meta.nativeMcpAccess("owner")).toEqual({ sandbox: "read-only" });
    // A failed update must not poison the queue for a later accepted change.
    sdk[method] = async () => {};
    await session.updateSettings({ disabledPluginIds: ["private@personal"] });
    expect(gateway.meta.nativeMcpAccess("owner")).toEqual({ sandbox: "read-only", disabledPluginIds: ["private@personal"] });
  });

  it("keeps committed authority during an update and merges later updates after acceptance", async () => {
    const { gateway, session, sdk } = fixture();
    let accept!: () => void;
    sdk.setModel = () => new Promise<void>((resolve) => { accept = resolve; });
    const first = session.updateSettings({ model: "claude:claude-sonnet-5-0", permissions: ":danger-full-access" });
    // Let the first update enter its SDK request.
    await Promise.resolve();
    const second = session.updateSettings({ disabledPluginIds: ["private@personal"] });
    await Promise.resolve();
    expect(session.settings.nativeAccess).toEqual({ sandbox: "read-only" });
    expect(gateway.meta.nativeMcpAccess("owner")).toEqual({ sandbox: "read-only" });
    accept();
    await Promise.all([first, second]);
    expect(session.settings.nativeAccess).toEqual({ permissions: ":danger-full-access", disabledPluginIds: ["private@personal"] });
    expect(gateway.meta.nativeMcpAccess("owner")).toEqual(session.settings.nativeAccess);
  });
});
