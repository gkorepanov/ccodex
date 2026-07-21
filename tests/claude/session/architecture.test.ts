import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const service = readFileSync(new URL("../../../src/claude/service.ts", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../../../src/claude/session/runtime.ts", import.meta.url), "utf8");
const session = readFileSync(new URL("../../../src/claude/session/session.ts", import.meta.url), "utf8");
const shellRunner = readFileSync(new URL("../../../src/claude/session/shellRunner.ts", import.meta.url), "utf8");
const backgroundOutput = readFileSync(new URL("../../../src/claude/session/backgroundOutput.ts", import.meta.url), "utf8");
const runtimeFactory = readFileSync(new URL("../../../src/claude/session/providerRuntimeFactory.ts", import.meta.url), "utf8");
const connection = readFileSync(new URL("../../../src/gateway/clientConnection.ts", import.meta.url), "utf8");

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Missing architecture section marker: ${startIndex < 0 ? start : end}`);
  }
  return source.slice(startIndex, endIndex);
}

function method(name: string, next: string): string {
  return section(service, `public ${name}`, `public ${next}`);
}

describe("Phase 3 ownership boundary", () => {
  it("keeps thread creation and announcement off direct service store/runtime/hub writers", () => {
    const start = method("async startThread", "async announceThread");
    const announce = method("async announceThread", "async resumeThread");
    const turn = method("async prepareTurn", "async prepareStatusTurn");
    for (const source of [start, announce, turn]) {
      expect(source).not.toContain("this.store");
      expect(source).not.toContain("this.hub");
      expect(source).not.toContain("createRuntime");
    }
    for (const source of [start, announce]) expect(source).not.toContain("this.runtimes");
  });

  it("keeps temporary handoff visibility scoped by the output adapter", () => {
    const summarize = method("async summarizeHandoff", "async shellCommand");
    expect(summarize).toContain("this.sessionOutput.withInternalThreadHidden");
    expect(summarize).not.toContain("this.hub");
  });

  it("keeps the SDK runtime transport free of product state and protocol projection", () => {
    for (const forbidden of [
      "ClaudeThreadRecord",
      "HybridStore",
      "SubscriptionHub",
      "codex/generated",
      "ThreadItem",
      "TurnStartParams",
    ]) {
      expect(runtime).not.toContain(forbidden);
    }
    expect(runtimeFactory).not.toContain("type Query,");
    expect(runtimeFactory).not.toContain("new AsyncQueue");
    expect(runtimeFactory).not.toContain("new AbortController");
  });

  it("keeps durable runtime initialization state session-owned", () => {
    const initialization = section(
      session,
      'if (message.type === "system" && message.subtype === "init") {',
      'message.type === "stream_event"',
    );
    expect(initialization).toContain("this.submitProviderProjection");
    expect(initialization).toContain('type: "runtimeInitialized"');
    expect(initialization).not.toContain("this.store.updateThread");
    expect(initialization).not.toContain("resolvedModel:");
  });

  it("keeps main text and reasoning item mutation session-owned", () => {
    expect(session).toContain("this.applyProviderMainStream");
    for (const retiredWriter of [
      "createAgentItem(",
      "createReasoningItem(",
      "appendAgentText(",
      "appendReasoning(",
      "backfillAssistant(",
      "settlePendingAgentMessages(",
      "appendStructuredOutput(",
    ]) {
      expect(runtimeFactory).not.toContain(retiredWriter);
    }
  });

  it("keeps usage and main-turn terminal persistence session-owned", () => {
    expect(runtimeFactory).not.toContain("lastPublishedUsage");
    expect(session).toContain('type: "accountUsage"');
    expect(session).toContain('type: "publishUsage"');
    expect(session).toContain('type: "lifecycle"');
    expect(session).toContain("private maybeFinish");
  });

  it("starts SDK initialization as an effect instead of blocking runtime construction", () => {
    const creation = section(
      session,
      "private async createRuntimeGeneration",
      "private async waitForProviderRuntime",
    );
    expect(creation).toContain("runtime.start()");
    expect(creation).toContain("const ready = this.waitForProviderRuntime(runtime)");
    expect(creation).not.toContain("await runtime.initializationResult()");
    expect(creation).not.toContain("await Promise.race");
  });

  it("keeps main interaction persistence, status, and terminal gating session-owned", () => {
    expect(session).toContain('case "openInteraction"');
    expect(session).toContain('case "announceInteraction"');
    expect(session).toContain("this.syncInteractionStatus");
    expect(session).toContain("this.repository.pendingRequests(this.threadId).length > 0");
    expect(runtimeFactory).not.toContain('activeFlags: ["waitingOnApproval"] } });');
    expect(runtimeFactory).not.toContain('activeFlags: ["waitingOnUserInput"] } });');
  });

  it("routes child approvals through their canonical root session", () => {
    const resolution = method("async resolveServerRequest", "replayPendingRequests");
    expect(resolution).toContain("while (owner.thread.parentThreadId)");
    expect(resolution).toContain("this.sessions.submit(owner.thread.id");
    expect(resolution).not.toContain("this.interactions.resolve");
  });

  it("keeps tool, task, child, and background lifecycle writers session-owned", () => {
    for (const retired of [
      "interface ChildProjection", "interface ProjectedTask", "childProjections",
      "completeMainTool(", "completeChildTool(",
    ]) expect(runtimeFactory).not.toContain(retired);
    expect(session).toContain("private projectToolFact");
    expect(session).toContain("private projectTaskFact");
    expect(session).toContain("private createChildScope");
    expect(runtimeFactory).not.toContain("this.interactions.cancelThread");
    for (const retired of [
      "backgroundOutputTailers", "ensureBackgroundTailer", "drainBackgroundOutput",
      "fileSnapshots", "hookRuns", "hookDisplayOrder",
    ]) expect(runtimeFactory).not.toContain(retired);
    expect(session).toContain('fact: { kind: "taskOutput", taskId, delta }');
    expect(session).toContain("tool.fileSnapshot = snapshot");
    expect(session).toContain("private readonly hookRuns");
    expect(backgroundOutput).toContain("export async function readBackgroundOutput");
    expect(backgroundOutput).not.toContain("ClaudeSession");
  });

  it("keeps desired-settings persistence and publication session-owned", () => {
    const settings = section(service, "private async applySettings", "private async validateModelSettings");
    expect(settings).toContain('type: "updateDesiredSettings"');
    expect(settings).not.toContain("this.store.updateThread");
    expect(settings).not.toContain("this.hub.emit");
    expect(session).toContain('case "updateDesiredSettings"');
    const sessionSettings = section(session, 'case "updateDesiredSettings"', 'case "announceThread"');
    expect(sessionSettings).toContain("this.commitState(updated");
    expect(sessionSettings).not.toContain("this.repository.update(updated)");
    expect(sessionSettings).not.toContain('this.publish(null, "thread/settings/updated"');
    expect(runtimeFactory).toContain("startup: RuntimeStartup");
    expect(runtimeFactory).not.toContain("appliedRecord");
    expect(runtimeFactory).not.toContain("synchronizeRecord");
    expect(runtimeFactory).not.toContain("withSettingsFrom");
    expect(runtimeFactory).not.toContain("permissionMode(this.record)");
    expect(runtimeFactory).not.toContain("this.runtime.setModel");
    expect(session).not.toContain("readTransportSettings");
  });

  it("keeps durable removal transitions and delete publication session-owned", () => {
    for (const writer of [
      "this.store.beginThreadRemoval",
      "this.store.cancelThreadRemoval",
      "this.store.commitThreadRemoval",
      "this.hub.threadDeleted",
    ]) expect(service).not.toContain(writer);
    for (const command of [
      'command.kind === "beginRemoval"',
      'command.kind === "recoverRemoval"',
      'command.kind === "providerSucceeded"',
      'command.kind === "providerFailed"',
    ]) expect(session).toContain(command);
    expect(section(session, "this.repository.commitRemoval", "this.output.threadDeleted"))
      .toContain("this.repository.commitRemoval");
  });

  it("commits single-thread lifecycle state before publishing its durable events", () => {
    const start = section(session, "private startTurn", "private recoverAfterRestart");
    const finish = section(session, "private finishTurn", "private goalContext");
    const interactionStatus = section(session, "private syncInteractionStatus", "private inspectRuntime");
    for (const source of [start, finish, interactionStatus]) {
      expect(source).toContain("this.commitState(");
      expect(source).not.toContain("this.repository.update(");
    }
    expect(start).not.toContain("this.repository.createTurn");
    expect(finish).not.toContain("this.publishTurn(");
    expect(interactionStatus).not.toContain("this.repository.appendEvent");
  });

  it("keeps manual compaction lifecycle session-owned", () => {
    expect(session).toContain('case "startCompact"');
    expect(session).toContain('case "compactBoundary"');
    expect(session).toContain('case "compactTransportCancelled"');
    expect(runtimeFactory).not.toContain("activeCompaction");
    expect(runtimeFactory).not.toContain("completeCompaction");

    const serviceCompact = method("async compactThread", "async updateThreadSettings");
    expect(serviceCompact).not.toContain("this.store");
    expect(serviceCompact).not.toContain("this.hub");

    const sessionCompaction = section(session, "private startCompaction", "private acceptLifecycle");
    expect(sessionCompaction).toContain("setTimeout");
    expect(sessionCompaction).toContain('type: "compactWatchdogFired"');
    expect(sessionCompaction).not.toContain("resolveCompactionBoundary");
    expect(sessionCompaction).not.toContain("interruptOwned");
    expect(sessionCompaction).not.toContain(".send(");
    expect(runtimeFactory).not.toContain("compactionEffect");
    expect(runtimeFactory).not.toContain("compactWatchdogExpired");
  });

  it("keeps shell and generic error product publication session-owned", () => {
    const error = method("async reportError", "async startThread");
    const shell = method("async shellCommand", "async prepareReview");
    for (const source of [error, shell]) {
      expect(source).not.toContain("this.store.");
      expect(source).not.toContain("this.hub.");
      expect(source).not.toContain("this.emit(");
    }
    for (const command of [
      'case "runShell"',
      'case "startShell"',
      'case "admitShellEffect"',
      'case "shellOutput"',
      'case "finishShell"',
      'case "prepareShellCancellation"',
      'case "finalizeShellCancellation"',
      'case "reportError"',
    ]) expect(session).toContain(command);
    for (const retired of [
      "shellEffects",
      "cancelShellEffect",
      "completeShellCancellation",
      "shellCancellation",
    ]) expect(service).not.toContain(retired);
    expect(shell).toContain('{ type: "runShell", command: params.command }');
    expect(shell).not.toContain("spawn(");
    expect(session).toContain("private readonly shellRunner: ShellRunner");
    expect(session).toContain("shell.process.kill()");
    expect(shellRunner).toContain("export class ShellRunner");
    expect(shellRunner).toContain("process.kill(-pid, \"SIGKILL\")");
  });

  it("keeps status, injection, and review product lifecycle session-owned", () => {
    expect(service).not.toContain("statusTurns");
    expect(service).not.toContain("finishStatusTurn");
    expect(session).toContain('synthetic?: "status"');
    expect(session).toContain('case "completeSynthetic"');
    expect(session).toContain('case "stageInjection"');
    expect(section(service, "public async prepareReview", "public listTurns"))
      .not.toContain("applySettings");
    expect(session).toContain("private appendReviewExit");
    expect(service).not.toContain("InteractionBridge");
    const recovery = section(service, "private async reconcileAfterRestart", "private async unloadIdleRuntimes");
    expect(recovery).not.toContain("failedAfterCrash");
    expect(recovery).not.toContain("this.store.updateThread");
    expect(recovery).not.toContain('"turn/completed"');
    // Goal restart publication remains a named Phase 7 writer-deletion gate.
    expect(session).toContain('case "recoverAfterRestart"');
    const review = section(connection, 'message.method === "review/start"', 'message.method === "thread/goal/set"');
    expect(section(review, "announceThread", "sendResult")).toContain("announceThread");
  });
});
