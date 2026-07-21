import { describe, expect, it, vi } from "vitest";
import { printDoctor, type DoctorCheck } from "../../src/management/doctor.js";

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
