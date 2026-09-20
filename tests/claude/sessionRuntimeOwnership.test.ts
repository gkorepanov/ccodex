import { describe, expect, it, vi } from "vitest";
import {
  createProviderRuntime,
  providerRuntimeSettings,
  type RuntimeStartup,
} from "../../src/claude/session/providerRuntimeFactory.js";
import type { ClaudeProviderFact } from "../../src/claude/session/providerFacts.js";
import { Logger } from "../../src/observability/logger.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";

const startup: RuntimeStartup = {
  threadId: "thread-1",
  runtimeGeneration: 7,
  providerSessionId: "provider-session",
  resume: false,
  cwd: "/workspace",
  runtimeWorkspaceRoots: ["/workspace"],
  ephemeral: false,
  persistSession: true,
  claudeBinary: "/bin/false",
  model: "sonnet",
  settingsGeneration: 0,
  lastCompletedTurnId: null,
  modelContextWindow: null,
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandboxPolicy: { type: "readOnly", networkAccess: false },
  baseInstructions: null,
  developerInstructions: null,
  personality: null,
  serviceTier: null,
  reasoningEffort: null,
  reasoningSummary: null,
  collaborationMode: null,
  outputSchema: null,
  interactiveQuestions: true,
  ultraEffort: null,
};

describe("Codex ultra effort on Claude runtimes", () => {
  const callbacks = {
    canUseTool: async () => null,
    onElicitation: async () => ({ action: "cancel" as const }),
    beforeToolUse: async () => ({ continue: true }),
    captureFileAfter: async () => ({ continue: true }),
    afterCompact: async () => ({ continue: true }),
  };

  it("starts ultra threads at the configured Claude effort with delegation instructions", async () => {
    const query = new FakeClaudeQuery();
    const runtime = createProviderRuntime(
      { ...startup, reasoningEffort: "ultra", ultraEffort: "high" },
      new Logger("error"), query.factory, async () => {}, callbacks,
    );
    runtime.start();
    await vi.waitFor(() => expect(query.inputs).toHaveLength(1));
    const options = query.inputs[0]!.options;
    expect(options.effort).toBe("high");
    expect(JSON.stringify(options.systemPrompt)).toContain("Proactive multi-agent delegation is active");
    expect(options.settings).not.toHaveProperty("ultracode");
    runtime.beginClose();
    await runtime.close();
  });

  it("leaves other efforts without delegation instructions", async () => {
    const query = new FakeClaudeQuery();
    const runtime = createProviderRuntime(
      { ...startup, reasoningEffort: "max", ultraEffort: "high" },
      new Logger("error"), query.factory, async () => {}, callbacks,
    );
    runtime.start();
    await vi.waitFor(() => expect(query.inputs).toHaveLength(1));
    expect(query.inputs[0]!.options.effort).toBe("max");
    expect(JSON.stringify(query.inputs[0]!.options.systemPrompt)).not.toContain("Proactive multi-agent delegation is active");
    runtime.beginClose();
    await runtime.close();
  });

  it("maps a live switch to ultra onto the configured Claude effort", () => {
    const settings = { ...startup, reasoningEffort: "ultra" };
    expect(providerRuntimeSettings(settings, "high").effort).toBe("high");
    expect(providerRuntimeSettings(settings, null).effort).toBeNull();
  });
});

describe("Claude provider projection boundary", () => {
  it("emits normalized facts without owning Session projection", async () => {
    const query = new FakeClaudeQuery();
    const facts: ClaudeProviderFact[] = [];
    const runtime = createProviderRuntime(
      startup,
      new Logger("error"),
      query.factory,
      async (fact) => { facts.push(fact); },
      {
        canUseTool: async () => null,
        onElicitation: async () => ({ action: "cancel" }),
        beforeToolUse: async () => ({ continue: true }),
        captureFileAfter: async () => ({ continue: true }),
        afterCompact: async () => ({ continue: true }),
      },
    );
    runtime.start();

    await vi.waitFor(() => expect(facts.some((fact) =>
      fact.kind === "message" && fact.providerEventType === "system/init")).toBe(true));

    runtime.beginClose();
    await runtime.close();
    await vi.waitFor(() => expect(facts.at(-1)).toMatchObject({
      kind: "exit",
      runtimeGeneration: startup.runtimeGeneration,
    }));
  });

  it("does not leak the managed-shim recursion marker into Claude", async () => {
    vi.stubEnv("CCODEX_SHIM_ACTIVE", "1");
    const query = new FakeClaudeQuery();
    const runtime = createProviderRuntime(
      startup,
      new Logger("error"),
      query.factory,
      async () => undefined,
      {
        canUseTool: async () => null,
        onElicitation: async () => ({ action: "cancel" }),
        beforeToolUse: async () => ({ continue: true }),
        captureFileAfter: async () => ({ continue: true }),
        afterCompact: async () => ({ continue: true }),
      },
    );
    try {
      runtime.start();
      await vi.waitFor(() => expect(query.inputs).toHaveLength(1));
      expect(query.inputs[0]!.options.env?.CCODEX_SHIM_ACTIVE).toBeUndefined();
    } finally {
      runtime.beginClose();
      await runtime.close();
      vi.unstubAllEnvs();
    }
  });
});
