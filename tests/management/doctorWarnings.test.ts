import { describe, expect, it, vi } from "vitest";
import { daemonVersionCheck, printDoctor, versionCheck, type DoctorCheck } from "../../src/management/doctor.js";

describe("doctor provider warnings", () => {
  it("does not fail structural setup validation for an unavailable provider", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const checks: DoctorCheck[] = [{
      id: "claude-auth",
      status: "warning",
      detected: "not authenticated",
      expected: "authenticated",
      repair: "claude auth login",
    }];
    expect(printDoctor(checks, true)).toBe(0);
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      checks: [{ status: "warning", repair: "claude auth login" }],
    });
    write.mockRestore();
  });

  it("keeps structural failures fatal", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(printDoctor([{
      id: "relay",
      status: "error",
      detected: "missing",
      expected: "installed",
    }], true)).toBe(1);
    write.mockRestore();
  });
});

describe("doctor version checks", () => {
  it("passes a matching pinned binary", () => {
    expect(versionCheck("codex-version", "codex-cli 0.153.3", "0.153.3", "pinned", "reinstall")).toMatchObject({ status: "ok" });
  });

  it("fails a drifted pinned binary with the reinstall repair", () => {
    expect(versionCheck("codex-version", "codex-cli 0.158.0", "0.153.3", "pinned", "reinstall"))
      .toMatchObject({ status: "error", repair: "reinstall" });
  });

  it("reports an accepted override as a warning with a repair hint naming the config key", () => {
    const codex = versionCheck("codex-version", "codex-cli 0.158.0", "0.153.3", "override", "reinstall");
    expect(codex).toMatchObject({ status: "warning", expected: "0.153.3 (pinned; override accepted)" });
    expect(codex.repair).toContain("app_server_codex");
    const claude = versionCheck("claude-version", "2.1.283 (Claude Code)", "2.1.261", "override", "reinstall");
    expect(claude).toMatchObject({ status: "warning" });
    expect(claude.repair).toContain("claude_binary");
  });
});

describe("daemon version check", () => {
  it("expects the pinned version when no override is configured", () => {
    expect(daemonVersionCheck("0.153.3", "0.153.3", undefined)).toMatchObject({ status: "ok", expected: "0.153.3" });
    expect(daemonVersionCheck("0.158.0-alpha.2.1", "0.153.3", undefined)).toMatchObject({ status: "error" });
  });

  it("expects the overridden binary's version when app_server_codex is set", () => {
    expect(daemonVersionCheck("0.158.0-alpha.2.1", "0.153.3", "codex-cli 0.158.0-alpha.2.1"))
      .toMatchObject({ status: "ok", expected: "0.158.0-alpha.2.1 (app_server_codex override)" });
  });

  it("flags a stale daemon still running the pin after the override changed", () => {
    expect(daemonVersionCheck("0.153.3", "0.153.3", "codex-cli 0.158.0-alpha.2.1"))
      .toMatchObject({ status: "error", repair: "codex app-server daemon restart" });
  });
});
