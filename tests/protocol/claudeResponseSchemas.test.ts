import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HybridConfig } from "../../src/config/config.js";
import { ClaudeService } from "../../src/claude/service.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";
import { assertValidResponse } from "../fixtures/responseSchemas.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function config(dataDir: string): HybridConfig {
  return {
    realCodex: "/bin/false",
    claudeBinary: "/bin/false",
    dataDir,
    publicSocket: join(dataDir, "gateway.sock"),
    modelPrefix: "claude:",
    idleTimeoutSeconds: 900,
    modelCacheSeconds: 300,
    logLevel: "error",
    logPrompts: false,
    debugCapture: false,
    debugLogMaxBytes: 1_048_576,
  };
}

describe("synthesized Claude responses against pinned 0.149.1 schemas", () => {
  it("validates the thread and turn lifecycle responses CCodex fabricates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-response-schemas-"));
    directories.push(directory);
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), new FakeClaudeQuery().factory,
    );

    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    assertValidResponse("ThreadStartResponse", started);

    const prepared = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "validate me", text_elements: [] }],
    });
    assertValidResponse("TurnStartResponse", prepared.response);
    prepared.announce();
    prepared.start();
    const deadline = Date.now() + 2_000;
    while (service.readThread(started.thread.id, true).thread.turns[0]?.status !== "completed") {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for turn completion.");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    assertValidResponse("ThreadReadResponse", service.readThread(started.thread.id, true));
    assertValidResponse("ThreadResumeResponse", await service.resumeThread(started.thread.id));

    const sectioned = await service.setThreadSection(started.thread.id, {
      id: "01984de2-8f74-7c91-a3b2-5c5e937cf318", name: "Pinned", appearance: null,
    });
    assertValidResponse("Thread", sectioned.thread);
    expect(sectioned.thread.section?.id).toBe("01984de2-8f74-7c91-a3b2-5c5e937cf318");
    // The gateway answers thread/section/move with an empty object.
    assertValidResponse("ThreadSectionMoveResponse", {});

    for (const thread of service.listThreads({})) assertValidResponse("Thread", thread);
    await service.close();
  });
});
