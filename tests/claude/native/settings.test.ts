import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NativeSessionCatalog } from "../../../src/claude/native/catalog.js";
import { summarizeTranscript } from "../../../src/claude/native/summary.js";
import type { TranscriptRecord } from "../../../src/claude/native/records.js";
import { codexPermissions, permissionModeFrom } from "../../../src/claude/sdk.js";

const fixtureProjects = fileURLToPath(new URL("../../fixtures/nativeClaudeHome/projects/", import.meta.url));
const cwd = "/synthetic";

function record(fields: Record<string, unknown>): TranscriptRecord {
  return fields as unknown as TranscriptRecord;
}


describe("native Claude thread settings", () => {
  it("reduces fixture model, effort, canonical permission, and standard tier", async () => {
    const catalog = new NativeSessionCatalog(fixtureProjects);
    await catalog.refresh();

    for (const summary of catalog.sessions()) {
      expect(summary.model).toMatch(/^claude-/u);
      expect(summary.reasoningEffort).not.toBeNull();
      expect(summary.permissionMode).toBe("bypassPermissions");
      expect(summary.serviceTier).toBeNull();
    }
  });

  it("takes the latest permission across user and state records by file position", () => {
    const stateThenUser = summarizeTranscript([
      record({ type: "permission-mode", permissionMode: "auto" }),
      record({ type: "user", permissionMode: "dontAsk", message: { content: "later" } }),
    ]);
    const userThenState = summarizeTranscript([
      record({ type: "user", permissionMode: "dontAsk", message: { content: "earlier" } }),
      record({ type: "permission-mode", permissionMode: "auto" }),
    ]);

    expect(stateThenUser.permissionMode).toBe("dontAsk");
    expect(userThenState.permissionMode).toBe("auto");
  });

  it("uses only finalized assistant usage and canonicalizes service tier", () => {
    const summary = summarizeTranscript([
      record({
        type: "assistant", effort: "low",
        message: { model: "claude-first", stop_reason: "end_turn", content: [], usage: { service_tier: "priority" } },
      }),
      record({
        type: "assistant", effort: "high",
        message: { model: "claude-second", stop_reason: null, content: [], usage: { service_tier: "standard" } },
      }),
    ]);
    expect(summary).toMatchObject({ model: "claude-second", reasoningEffort: "high", serviceTier: "fast" });

    expect(summarizeTranscript([record({
      type: "assistant",
      message: { model: "claude-second", stop_reason: "end_turn", content: [], usage: { service_tier: "default" } },
    })]).serviceTier).toBeNull();
  });

  it("round-trips Claude permission modes through the Codex settings Desktop sends back", () => {
    for (const mode of ["default", "auto", "dontAsk", "bypassPermissions"] as const) {
      const codex = codexPermissions(mode, cwd);
      expect(permissionModeFrom({ ...codex, permissions: codex.activePermissionProfile.id })).toBe(mode);
    }
    expect(permissionModeFrom({ collaborationMode: { mode: "plan" }, approvalPolicy: "never" })).toBe("plan");
  });

  it("follows native /goal: set, goal_status updates, clear", () => {
    const at = (second: number) => `2026-09-23T00:00:${String(second).padStart(2, "0")}.000Z`;
    const set = [
      record({ type: "system", subtype: "local_command", timestamp: at(1), content: "<local-command-stdout>Goal set: ship it</local-command-stdout>", commandRun: { command: "goal", args: "ship it" } }),
    ];
    expect(summarizeTranscript(set).goal).toEqual({ objective: "ship it", met: false, createdAt: 1790121601, updatedAt: 1790121601 });
    const met = [...set, record({ type: "attachment", timestamp: at(9), attachment: { type: "goal_status", met: true, condition: "ship it" } })];
    expect(summarizeTranscript(met).goal).toMatchObject({ objective: "ship it", met: true, createdAt: 1790121601, updatedAt: 1790121609 });
    const cleared = [...met, record({ type: "system", subtype: "local_command", timestamp: at(12), content: "<local-command-stdout>Goal cleared</local-command-stdout>", commandRun: { command: "goal", args: "clear" } })];
    expect(summarizeTranscript(cleared).goal).toBeNull();
  });
});
