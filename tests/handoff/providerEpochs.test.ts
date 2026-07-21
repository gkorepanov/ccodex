import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import { ProviderEpochs } from "../../src/handoff/providerEpochs.js";
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
  afterEach(() => stores.splice(0).forEach((store) => store.close()));

  it("seeds one physical thread and composes sealed history with current backend turns", () => {
    const store = new HandoffStore(join(mkdtempSync(join(tmpdir(), "ccodex-epochs-")), "handoffs.sqlite"));
    stores.push(store);
    const epochs = new ProviderEpochs(store);
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
});
