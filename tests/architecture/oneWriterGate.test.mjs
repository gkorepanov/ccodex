import { describe, expect, it } from "vitest";
import { compareDebt, debtEntries, scanSource } from "../../scripts/lib/one-writer-gate.mjs";

describe("one-writer architecture AST gate", () => {
  it("detects direct writers without matching comments or string literals", () => {
    const violations = scanSource("src/claude/example.ts", `
      const decoy = "this.store.updateThread(record)";
      // this.hub.emit(threadId, "turn/started", {});
      class Example {
        run() {
          this.store.updateThread(record);
          this.hub.emit(threadId, "turn/started", {});
          runtime.synchronizeRecord(record);
        }
      }
    `);
    expect(violations.map(({ rule, owner, symbol }) => ({ rule, owner, symbol }))).toEqual([
      { rule: "direct-store-product-mutation", owner: "Example.run", symbol: "updateThread" },
      { rule: "direct-hub-product-output", owner: "Example.run", symbol: "hub.emit" },
      { rule: "runtime-record-synchronization", owner: "Example.run", symbol: "synchronizeRecord" },
    ]);
  });

  it("defaults every HybridStore call to mutation except explicit reads and infrastructure", () => {
    const violations = scanSource("src/claude/example.ts", `
      import type { HybridStore } from "../store/HybridStore.js";
      class Example {
        constructor(private store: HybridStore) {}
        run() {
          this.store.getThreadRecord("thread-1");
          this.store.listPendingThreadRemovals();
          this.store.close();
          this.store.beginThreadRemoval(removal);
          this.store.cancelThreadRemoval("thread-1");
          this.store.commitThreadRemoval("thread-1", []);
          this.store.futureMutation("thread-1");
        }
      }
    `);
    expect(violations.map(({ rule, symbol }) => ({ rule, symbol }))).toEqual([
      { rule: "direct-store-product-mutation", symbol: "beginThreadRemoval" },
      { rule: "direct-store-product-mutation", symbol: "cancelThreadRemoval" },
      { rule: "direct-store-product-mutation", symbol: "commitThreadRemoval" },
      { rule: "direct-store-product-mutation", symbol: "futureMutation" },
    ]);
  });

  it("detects every product-output SubscriptionHub path outside the output adapter", () => {
    const source = `
      import type { SubscriptionHub } from "../gateway/subscriptions.js";
      class Example {
        constructor(private hub: SubscriptionHub) {}
        run() {
          this.hub.emit("thread-1", "turn/started", {});
          this.hub.request("thread-1", "request-1", "item/commandExecution/requestApproval", {});
          this.hub.suppress("thread-1");
          this.hub.unsuppress("thread-1");
          this.hub.threadDeleted("thread-1");
          this.hub.isSuppressed("thread-1");
        }
      }
    `;
    expect(scanSource("src/claude/example.ts", source).map(({ rule, symbol }) => ({ rule, symbol })))
      .toEqual([
        { rule: "direct-hub-product-output", symbol: "hub.emit" },
        { rule: "direct-hub-product-output", symbol: "hub.request" },
        { rule: "direct-hub-product-output", symbol: "hub.suppress" },
        { rule: "direct-hub-product-output", symbol: "hub.unsuppress" },
        { rule: "direct-hub-product-output", symbol: "hub.threadDeleted" },
      ]);
    expect(scanSource("src/claude/session/outputAdapter.ts", source)).toEqual([]);
  });

  it("allows the named repository and output adapters only", () => {
    expect(scanSource("src/claude/session/repository.ts", `
      this.store.createThread(record);
      this.store.beginThreadRemoval(removal);
      this.store.updateTurn(threadId, turn);
    `)).toEqual([]);
    expect(scanSource("src/claude/session/outputAdapter.ts", `
      this.hub.emit(threadId, method, params);
      this.hub.request(threadId, requestId, method, params);
      this.hub.suppress(threadId);
      this.hub.unsuppress(threadId);
      this.hub.threadDeleted(threadId);
    `)).toEqual([]);
  });

  it("follows explicitly typed store and hub aliases", () => {
    const violations = scanSource("src/claude/example.ts", `
      import type { HybridStore as Persistence } from "../store/HybridStore.js";
      import type { SubscriptionHub as Output } from "../gateway/subscriptions.js";
      class Example {
        constructor(private persistence: Persistence, private output: Output) {}
        run() {
          this.persistence.appendProviderEvent(event);
          this.output.emit(threadId, method, params);
        }
      }
    `);
    expect(violations.map(({ rule, symbol }) => ({ rule, symbol }))).toEqual([
      { rule: "direct-store-product-mutation", symbol: "appendProviderEvent" },
      { rule: "direct-hub-product-output", symbol: "hub.emit" },
    ]);
  });

  it("records legacy imports and duplicated active, compaction, and quiescence owners structurally", () => {
    const source = `
      import { ClaudeSessionRuntime } from "./sessionRuntime.js";
      class CompatibilityRuntime {
        private active: ActiveTurn | undefined;
        private stagedTurnIds = new Set<string>();
        private compactionEffect: CompactionEffect | undefined;
        private lifecycleQuiescent = false;
        public get activeTurnId(): string | undefined { return this.active?.turnId; }
        public get isLifecycleQuiescent(): boolean { return this.lifecycleQuiescent; }
        public acceptSessionLifecycle(): void {}
      }
    `;
    expect(scanSource("src/claude/example.ts", source).map(({ rule, symbol }) => ({ rule, symbol })))
      .toEqual([
        { rule: "legacy-lifecycle-import", symbol: "sessionRuntime" },
        { rule: "duplicate-lifecycle-owner", symbol: "active-turn-state" },
        { rule: "duplicate-lifecycle-owner", symbol: "active-turn-state" },
        { rule: "duplicate-lifecycle-owner", symbol: "compaction-state" },
        { rule: "duplicate-lifecycle-owner", symbol: "quiescence-state" },
        { rule: "duplicate-lifecycle-owner", symbol: "active-turn-state" },
        { rule: "duplicate-lifecycle-owner", symbol: "quiescence-state" },
        { rule: "duplicate-lifecycle-owner", symbol: "lifecycle-sync" },
      ]);
    expect(scanSource("src/claude/session/session.ts", source)
      .filter(({ rule }) => rule === "duplicate-lifecycle-owner")).toEqual([]);
  });

  it("tracks forbidden legacy runtime imports, types, and state access", () => {
    const violations = scanSource("src/claude/sessionRuntime.ts", `
      import type { HybridStore, ClaudeThreadRecord as Record } from "../store/HybridStore.js";
      import type { SubscriptionHub } from "../gateway/subscriptions.js";
      class Runtime {
        constructor(private store: HybridStore, private hub: SubscriptionHub) {}
        read(): Record { return this.store.getThreadRecord("id"); }
      }
    `);
    expect(violations.filter(({ rule }) => rule === "runtime-forbidden-import")
      .map(({ symbol }) => symbol)).toEqual(["HybridStore", "ClaudeThreadRecord", "SubscriptionHub"]);
    expect(violations.filter(({ rule }) => rule === "runtime-store-hub-access")).toHaveLength(1);
  });

  it("rejects a renamed legacy runtime that still owns product workflow", () => {
    const violations = scanSource("src/claude/session/providerRuntime.ts", `
      import type { TurnStartParams } from "../../codex/generated/v2/TurnStartParams.js";
      import { ClaudeRuntime } from "./runtime.js";
      import type { ClaudeSessionCommand } from "./commands.js";
      class ProviderRuntime {
        private transportSettings = {};
        private appliedGeneration = 0;
        private settingsApplication = Promise.resolve();
        private sessionApprovedTools = new Set();
        private ephemeralPreludeBatches = [];
        private noQueryOperations = [];
        private suppressedGoalBlocks = new Set();
        private providerError;
        private usageSnapshotGeneration = 0;
        private goalCommandTokensObserved = 0;
      }
    `);
    expect(violations.map(({ rule, symbol }) => ({ rule, symbol }))).toEqual([
      {
        rule: "runtime-codex-protocol-import",
        symbol: "../../codex/generated/v2/TurnStartParams.js",
      },
      { rule: "runtime-lifecycle-command-channel", symbol: "ClaudeSessionCommand" },
      { rule: "runtime-product-state-owner", symbol: "applied-settings" },
      { rule: "runtime-product-state-owner", symbol: "applied-settings" },
      { rule: "runtime-product-state-owner", symbol: "applied-settings" },
      { rule: "runtime-product-state-owner", symbol: "session-approvals" },
      { rule: "runtime-product-state-owner", symbol: "ephemeral-replay" },
      { rule: "runtime-product-state-owner", symbol: "no-query-lifecycle" },
      { rule: "runtime-product-state-owner", symbol: "goal-projection" },
      { rule: "runtime-product-state-owner", symbol: "terminal-classification" },
      { rule: "runtime-product-state-owner", symbol: "usage-lifecycle" },
      { rule: "runtime-product-state-owner", symbol: "goal-usage" },
    ]);
  });

  it("rejects the provider projector alias as a runtime adapter boundary", () => {
    const violations = scanSource("src/claude/session/providerProjector.ts", `
      import type { TurnStartParams } from "../../codex/generated/v2/TurnStartParams.js";
      import type { ClaudeSessionCommand } from "./commands.js";
      class SessionProviderProjector {
        private providerError;
      }
    `);
    expect(violations.map(({ rule, symbol }) => ({ rule, symbol }))).toEqual([
      {
        rule: "runtime-codex-protocol-import",
        symbol: "../../codex/generated/v2/TurnStartParams.js",
      },
      { rule: "runtime-lifecycle-command-channel", symbol: "ClaudeSessionCommand" },
      { rule: "runtime-product-state-owner", symbol: "terminal-classification" },
    ]);
  });

  it("keeps the provider runtime factory inside the runtime adapter boundary", () => {
    const violations = scanSource("src/claude/session/providerRuntimeFactory.ts", `
      import type { TurnStartParams } from "../../codex/generated/v2/TurnStartParams.js";
      import type { ClaudeSessionCommand } from "./commands.js";
      class ProviderRuntimeFactory {
        private providerError;
      }
    `);
    expect(violations.map(({ rule, symbol }) => ({ rule, symbol }))).toEqual([
      {
        rule: "runtime-codex-protocol-import",
        symbol: "../../codex/generated/v2/TurnStartParams.js",
      },
      { rule: "runtime-lifecycle-command-channel", symbol: "ClaudeSessionCommand" },
      { rule: "runtime-product-state-owner", symbol: "terminal-classification" },
    ]);
  });

  it("allows a thin runtime adapter with transport-local state and normalized fact output", () => {
    expect(scanSource("src/claude/session/providerRuntime.ts", `
      import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
      import { ClaudeRuntime } from "./runtime.js";
      import type { ClaudeProviderFact } from "./providerFacts.js";
      class ProviderRuntime {
        private stopped = false;
        private providerSequence = 0;
        private readonly ownedMessageIds = new Set<string>();
        constructor(
          private readonly runtime: ClaudeRuntime,
          private readonly submitFact: (fact: ClaudeProviderFact) => Promise<void>,
        ) {}
        onMessage(message: SDKMessage) {
          return this.submitFact({ type: "providerMessage", message });
        }
      }
    `)).toEqual([]);
  });

  it("uses stable owner/count fingerprints instead of source positions", () => {
    const first = debtEntries(scanSource("src/claude/example.ts", `
      class Example { run() { this.store.updateThread(record); } }
    `));
    const shifted = debtEntries(scanSource("src/claude/example.ts", `


      class Example { run() { this.store.updateThread(record); } }
    `));
    expect(compareDebt(first, shifted)).toEqual({ added: [], removed: [] });

    const increased = debtEntries(scanSource("src/claude/example.ts", `
      class Example { run() {
        this.store.updateThread(record);
        this.store.updateThread(record);
      } }
    `));
    expect(compareDebt(increased, first).added[0]?.count).toBe(2);
  });
});
