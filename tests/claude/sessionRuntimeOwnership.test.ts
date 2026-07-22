import { describe, expect, it, vi } from "vitest";
import {
  createProviderRuntime,
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
};

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
