import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import {
  HandoffStore,
  type NewLogicalTurn,
  type NewProviderSwitchJob,
  type PendingProviderSwitch,
} from "../../src/handoff/store.js";

const directories: string[] = [];

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), "ccodex-provider-epochs-"));
  directories.push(directory);
  return join(directory, "handoffs.sqlite");
}

function thread(id: string): Thread {
  return {
    id, extra: null, sessionId: id, forkedFromId: null, parentThreadId: null, preview: "hello",
    ephemeral: false, historyMode: "legacy", modelProvider: "openai", createdAt: 1, updatedAt: 1,
    recencyAt: 1, status: { type: "idle" }, path: null, cwd: "/tmp", cliVersion: "0.144.6",
    source: "appServer", threadSource: null, agentNickname: null, agentRole: null, gitInfo: null,
    name: "logical", turns: [],
  };
}

function turn(id: string): Turn {
  return {
    id, items: [{ type: "agentMessage", id: `${id}-item`, text: id, phase: "final_answer", memoryCitation: null }],
    itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1_000,
  };
}

function providerTurn(id: string, epochId: string): NewLogicalTurn {
  return { publicTurnId: id, epochId, providerTurnId: id, turn: turn(id), kind: "provider" };
}

function pending(threadId: string, model = "claude:sonnet"): PendingProviderSwitch {
  return {
    threadId, sourceProvider: "stock", targetProvider: "claude", targetModel: model,
    settings: { threadId, model, effort: "high" },
  };
}

function job(id: string, revision: number): NewProviderSwitchJob {
  return {
    id, publicThreadId: "public", expectedEpochId: "epoch-stock", pendingRevision: revision,
    targetProvider: "claude", targetModel: "claude:sonnet",
    settings: { threadId: "public", model: "claude:sonnet", effort: "high" },
    turnParams: {
      threadId: "public", clientUserMessageId: "client-message",
      input: [{ type: "text", text: "continue", text_elements: [] }],
    },
    compactionTurn: turn("migration-compact"),
    createdAt: 20,
  };
}

function seed(store: HandoffStore, publicThreadId = "public", epochId = "epoch-stock"): void {
  store.createLogicalThread({
    thread: thread(publicThreadId),
    epoch: {
      id: epochId, provider: "stock", backendThreadId: `backend-${publicThreadId}`,
      model: "gpt-5.6-sol", settings: { effort: "medium" }, createdAt: 10,
    },
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("HandoffStore provider epochs", () => {
  it("persists logical metadata, turn lineage, and both backend lookup directions", () => {
    const database = path();
    const store = new HandoffStore(database);
    seed(store);
    expect(store.replaceLogicalTurns("public", 1, [
      providerTurn("turn-1", "epoch-stock"),
      {
        publicTurnId: "compact-1", turn: turn("compact-1"), kind: "migrationCompact",
      },
    ])).toBe(true);
    expect(store.replaceLogicalTurns("public", 1, [providerTurn("stale", "epoch-stock")])).toBe(false);
    store.close();

    const reopened = new HandoffStore(database);
    expect(reopened.getLogicalThread("public")).toMatchObject({
      publicThreadId: "public", currentEpochId: "epoch-stock", revision: 2,
      thread: { id: "public", turns: [] },
    });
    expect(reopened.findEpochByBackend("stock", "backend-public")).toMatchObject({
      id: "epoch-stock", publicThreadId: "public", ordinal: 0, state: "current",
    });
    expect(reopened.listBackendMappings()).toEqual([{
      publicThreadId: "public", epochId: "epoch-stock", provider: "stock",
      backendThreadId: "backend-public", state: "current",
    }]);
    expect(reopened.listLogicalTurns("public")).toMatchObject([
      { position: 0, publicTurnId: "turn-1", epochId: "epoch-stock", providerTurnId: "turn-1", kind: "provider" },
      { position: 1, publicTurnId: "compact-1", kind: "migrationCompact" },
    ]);
    expect(reopened.findLogicalTurn("public", "turn-1")?.turn.id).toBe("turn-1");
    reopened.close();
  });

  it("atomically stages, checkpoints, and commits a provider switch", () => {
    const database = path();
    let store = new HandoffStore(database);
    seed(store);
    expect(store.stageProviderSwitch({ pending: pending("public"), expectedEpochId: "stale-epoch" }))
      .toBeUndefined();
    expect(store.getPending("public")).toBeUndefined();
    const staged = store.stageProviderSwitch({ pending: pending("public"), expectedEpochId: "epoch-stock" })!;
    expect(staged).toMatchObject({ revision: 1, expectedEpochId: "epoch-stock" });
    expect(store.createProviderSwitchJob(job("switch-1", staged.revision!))).toMatchObject({
      status: "queued", expectedThreadRevision: 1,
    });
    expect(store.createProviderSwitchJob(job("switch-2", staged.revision!))).toBeUndefined();
    expect(store.claimProviderSwitchJob("switch-1")?.status).toBe("running");
    expect(store.checkpointProviderSwitchTarget("switch-1", {
      backendThreadId: "claude-backend", summary: "portable", providerTurnId: "claude-turn",
    })).toBe(true);
    expect(store.checkpointProviderSwitchTarget("switch-1", { backendThreadId: "other-backend" })).toBe(false);
    store.close();
    store = new HandoffStore(database);
    expect(store.recoverableProviderSwitchJobs()).toMatchObject([{
      id: "switch-1", status: "targetCreated", targetBackendThreadId: "claude-backend",
      summary: "portable", targetProviderTurnId: "claude-turn",
    }]);
    expect(store.hiddenProviderSwitchTargetIds()).toEqual(["claude-backend"]);
    const logical = store.getLogicalThread("public")!;
    expect(store.updateLogicalThread("public", logical.revision, {
      ...logical.thread,
      name: "Renamed while compacting",
    })).toMatchObject({ revision: logical.revision, thread: { name: "Renamed while compacting" } });

    const committed = store.commitProviderSwitch({
      jobId: "switch-1",
      targetEpoch: {
        id: "epoch-claude", provider: "claude", backendThreadId: "claude-backend",
        model: "claude:sonnet", settings: { effort: "high" }, createdAt: 30,
      },
      sourceTurns: [providerTurn("turn-1", "epoch-stock")],
      thread: { ...thread("public"), modelProvider: "claude", updatedAt: 30 },
      committedAt: 30,
    });

    expect(committed).toMatchObject({ currentEpochId: "epoch-claude", revision: 2 });
    expect(store.listEpochs("public")).toMatchObject([
      { id: "epoch-stock", ordinal: 0, state: "sealed", sealedAt: 30 },
      { id: "epoch-claude", ordinal: 1, state: "current", backendThreadId: "claude-backend" },
    ]);
    expect(store.getPending("public")).toBeUndefined();
    expect(store.getProviderSwitchJob("switch-1")).toMatchObject({
      status: "committed", summary: "portable", targetProviderTurnId: "claude-turn",
    });
    expect(store.recoverableProviderSwitchJobs()).toEqual([]);
    expect(store.hiddenProviderSwitchTargetIds()).toEqual([]);
    expect(store.listBackendMappings()).toHaveLength(2);
    store.close();
  });

  it("rejects a stale commit without partially sealing or inserting an epoch", () => {
    const store = new HandoffStore(path());
    seed(store);
    const staged = store.stageProviderSwitch({ pending: pending("public"), expectedEpochId: "epoch-stock" })!;
    store.createProviderSwitchJob(job("switch-1", staged.revision!));
    store.claimProviderSwitchJob("switch-1");
    store.checkpointProviderSwitchTarget("switch-1", { backendThreadId: "claude-backend" });
    expect(store.replaceLogicalTurns("public", 1, [providerTurn("late-turn", "epoch-stock")])).toBe(true);

    expect(store.commitProviderSwitch({
      jobId: "switch-1",
      targetEpoch: {
        id: "epoch-claude", provider: "claude", backendThreadId: "claude-backend",
        model: "claude:sonnet", settings: {},
      },
      sourceTurns: [providerTurn("turn-1", "epoch-stock")],
      thread: thread("public"),
    })).toBeUndefined();
    expect(store.getLogicalThread("public")).toMatchObject({ currentEpochId: "epoch-stock", revision: 2 });
    expect(store.listEpochs("public")).toMatchObject([{ id: "epoch-stock", state: "current" }]);
    expect(store.listLogicalTurns("public").map((value) => value.publicTurnId)).toEqual(["late-turn"]);
    expect(store.getProviderSwitchJob("switch-1")?.status).toBe("targetCreated");
    store.close();
  });

  it("fails a job without clearing a newer staged revision", () => {
    const store = new HandoffStore(path());
    seed(store);
    const first = store.stageProviderSwitch({ pending: pending("public"), expectedEpochId: "epoch-stock" })!;
    store.createProviderSwitchJob(job("switch-1", first.revision!));
    const newer = store.stageProviderSwitch({
      pending: pending("public", "claude:opus"), expectedEpochId: "epoch-stock",
    })!;

    expect(store.failProviderSwitch("switch-1", "target failed")).toBe(true);
    expect(store.failProviderSwitch("switch-1", "duplicate")).toBe(false);
    expect(store.getProviderSwitchJob("switch-1")).toMatchObject({ status: "failed", error: "target failed" });
    expect(store.getPending("public")).toMatchObject({ revision: newer.revision, targetModel: "claude:opus" });
    store.close();
  });

  it("finalizes fork selection only for the expected provisional and source epoch", () => {
    const store = new HandoffStore(path());
    seed(store, "source", "source-epoch");
    seed(store, "target", "target-epoch");
    expect(store.createForkSelection({
      targetPublicThreadId: "target", sourcePublicThreadId: "source",
      provisionalEpochId: "target-epoch", createdAt: 10,
    })).toBe(true);
    expect(store.createForkSelection({
      targetPublicThreadId: "target", sourcePublicThreadId: "source", provisionalEpochId: "target-epoch",
    })).toBe(false);
    expect(store.finalizeForkSelection("target", "wrong", "source-epoch")).toBe(false);
    expect(store.finalizeForkSelection("target", "target-epoch", "target-epoch")).toBe(false);
    expect(store.finalizeForkSelection("target", "target-epoch", "source-epoch")).toBe(true);
    expect(store.getForkSelection("target")).toMatchObject({
      status: "finalized", selectedEpochId: "source-epoch",
    });
    expect(store.finalizeForkSelection("target", "target-epoch", "source-epoch")).toBe(false);
    store.close();
  });

  it("atomically retargets a provisional fork to a native fork of the selected source epoch", () => {
    const store = new HandoffStore(path());
    seed(store, "source", "source-epoch");
    seed(store, "target", "target-provisional");
    store.createForkSelection({
      targetPublicThreadId: "target", sourcePublicThreadId: "source",
      provisionalEpochId: "target-provisional", createdAt: 10,
    });

    const committed = store.commitForkSelection({
      targetPublicThreadId: "target",
      expectedProvisionalEpochId: "target-provisional",
      selectedSourceEpochId: "source-epoch",
      targetEpoch: {
        id: "target-selected", provider: "stock", backendThreadId: "selected-native-fork",
        model: "gpt-5.6-sol", settings: { effort: "medium" }, createdAt: 20,
      },
      turns: [providerTurn("source-turn", "source-epoch")],
      thread: { ...thread("target"), forkedFromId: "source", updatedAt: 20 },
      committedAt: 20,
    });

    expect(committed).toMatchObject({ currentEpochId: "target-selected", revision: 2 });
    expect(store.listEpochs("target")).toMatchObject([
      { id: "target-provisional", state: "sealed", sealedAt: 20 },
      { id: "target-selected", state: "current", backendThreadId: "selected-native-fork" },
    ]);
    expect(store.findLogicalTurn("target", "source-turn")).toMatchObject({
      epochId: "source-epoch", providerTurnId: "source-turn",
    });
    expect(store.getForkSelection("target")).toMatchObject({
      status: "finalized", selectedEpochId: "source-epoch",
    });
    expect(store.commitForkSelection({
      targetPublicThreadId: "target", expectedProvisionalEpochId: "target-provisional",
      selectedSourceEpochId: "source-epoch",
      targetEpoch: {
        id: "duplicate", provider: "stock", backendThreadId: "duplicate",
        model: "gpt-5.6-sol", settings: {},
      },
      turns: [], thread: thread("target"),
    })).toBeUndefined();
    store.close();
  });

  it("migrates a legacy pending table without changing old read semantics", () => {
    const databasePath = path();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE pending_provider_switches (
        thread_id TEXT PRIMARY KEY,
        source_provider TEXT NOT NULL,
        target_provider TEXT NOT NULL,
        target_model TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    database.prepare(`
      INSERT INTO pending_provider_switches (
        thread_id, source_provider, target_provider, target_model, settings_json, updated_at
      ) VALUES (?, 'stock', 'claude', 'claude:sonnet', ?, 1)
    `).run("legacy", JSON.stringify({ threadId: "legacy", model: "claude:sonnet" }));
    database.close();

    const store = new HandoffStore(databasePath);
    expect(store.getPending("legacy")).toEqual({
      threadId: "legacy", sourceProvider: "stock", targetProvider: "claude",
      targetModel: "claude:sonnet", settings: { threadId: "legacy", model: "claude:sonnet" }, revision: 1,
    });
    expect(store.listBackendMappings()).toEqual([]);
    store.close();
  });
});
