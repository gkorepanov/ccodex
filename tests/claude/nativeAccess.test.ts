import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeAccessFrom } from "../../src/claude/nativeAccess.js";
import { Meta } from "../../src/meta.js";

describe("native MCP access", () => {
  it("retains access on ordinary model/plan updates and replaces mutually exclusive policy forms", () => {
    const access = nativeAccessFrom({ sandbox: "read-only", runtimeWorkspaceRoots: ["/work", "/extra"], approvalPolicy: "untrusted" });
    expect(nativeAccessFrom({ model: "claude:sonnet" }, access)).toEqual(access);
    expect(nativeAccessFrom({ permissions: "restricted" }, access)).toEqual({ permissions: "restricted", runtimeWorkspaceRoots: ["/work", "/extra"], approvalPolicy: "untrusted" });
    expect(nativeAccessFrom({ sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/work"] } }, { permissions: "restricted" })).toEqual({ sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/work"] } });
  });

  it("persists the original access for resume and removes it when forgetting a chat", () => {
    const root = mkdtempSync(join(tmpdir(), "native-access-")); const path = join(root, "meta.json");
    try {
      const access = { sandbox: "read-only", runtimeWorkspaceRoots: ["/work", "/extra"] };
      new Meta(path).setNativeMcpAccess("chat", access);
      const resumed = new Meta(path); expect(resumed.nativeMcpAccess("chat")).toEqual(access);
      resumed.forget("chat"); expect(new Meta(path).nativeMcpAccess("chat")).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
