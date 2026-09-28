import { describe, expect, it, vi } from "vitest";
import { printDoctor, versionCheck, type DoctorCheck } from "../../src/management/doctor.js";

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
