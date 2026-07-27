import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import { ProviderEpochs, stockSwitchThreadSource } from "../../src/handoff/providerEpochs.js";
import { LineageStore } from "../../src/handoff/lineageStore.js";
import { HandoffStore } from "../../src/handoff/store.js";

function turn(id: string): Turn {
  return {
    id, items: [], itemsView: "full", status: "completed", error: null,
    startedAt: 1, completedAt: 2, durationMs: 1_000,
  };
}

function thread(id: string, turns: Turn[]): Thread {
  return {
    id, extra: null, preview: "preview", ephemeral: false, historyMode: "legacy", modelProvider: "openai", createdAt: 1,
    updatedAt: 2, status: { type: "idle" }, cwd: "/tmp", cliVersion: "test",
    source: "cli", agentNickname: null, agentRole: null, name: "Source", turns,
    recencyAt: 2, forkedFromId: null, parentThreadId: null, threadSource: "user",
    sessionId: id, path: null, gitInfo: null,
  };
}

describe("ProviderEpochs", () => {
  const stores: HandoffStore[] = [];
  const lineages: LineageStore[] = [];
  afterEach(() => {
    lineages.splice(0).forEach((store) => store.close());
    stores.splice(0).forEach((store) => store.close());
  });

  it("seeds one physical thread and composes sealed history with current backend turns", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ccodex-epochs-")), "handoffs.sqlite");
    const store = new HandoffStore(path);
    stores.push(store);
    const lineage = new LineageStore(path);
    lineage.finalizeLegacyMigration(new Set());
    lineages.push(lineage);
    const epochs = new ProviderEpochs(lineage, store);
    epochs.seed(thread("public", [turn("old")]), "stock", "gpt-5.6-sol", {});

    expect(epochs.resolve("public")?.epoch).toMatchObject({
      publicThreadId: "public", provider: "stock", backendThreadId: "public",
    });
    expect(epochs.visibleTurns("public", [turn("current")]).map((value) => value.id))
      .toEqual(["current"]);
    expect(epochs.projectThread("public", thread("hidden", [turn("current")]), true)).toMatchObject({
      id: "public", name: "Source", turns: [{ id: "current" }],
    });
    expect(epochs.hiddenBackendIds("stock")).toEqual(new Set(["public"]));
  });

  it("removes the internal stock-switch marker from the public thread source", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ccodex-epochs-")), "handoffs.sqlite");
    const store = new HandoffStore(path);
    stores.push(store);
    const lineage = new LineageStore(path);
    lineage.finalizeLegacyMigration(new Set());
    lineages.push(lineage);
    const epochs = new ProviderEpochs(lineage, store);
    epochs.seed(thread("public", []), "stock", "gpt-5.6-sol", {});

    const tagged = {
      ...thread("physical", []),
      threadSource: stockSwitchThreadSource("job", "subAgent"),
    };
    expect(epochs.projectThread("public", tagged, false).threadSource).toBe("subAgent");
    expect(epochs.projectThread("public", {
      ...tagged,
      threadSource: stockSwitchThreadSource("job", null),
    }, false).threadSource).toBeNull();
  });
});
