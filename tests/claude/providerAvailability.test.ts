import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeService } from "../../src/claude/service.js";
import type { HybridConfig } from "../../src/config/config.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";

const directories: string[] = [];

function config(dataDir: string): HybridConfig {
  return {
    realCodex: "/bin/false", claudeBinary: "/missing/claude", dataDir,
    publicSocket: join(dataDir, "gateway.sock"), modelPrefix: "claude:",
    idleTimeoutSeconds: 900, modelCacheSeconds: 300, logLevel: "error",
    logPrompts: false, debugCapture: false, debugLogMaxBytes: 1_048_576,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Claude provider admission", () => {
  it.each([
    ["notAuthenticated", "Claude is not authenticated\n  ↳ `claude auth login`"],
    ["notInstalled", "Claude CLI is not installed\n  ↳ `npm i -g @anthropic-ai/claude-code`"],
  ] as const)("rejects %s before creating a turn with an actionable message", async (state, message) => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-provider-admission-"));
    directories.push(directory);
    const service = new ClaudeService(
      config(directory),
      new SubscriptionHub(),
      new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")),
      new FakeClaudeQuery().factory,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => ({
        provider: "claude",
        state,
        action: state === "notInstalled"
          ? "npm i -g @anthropic-ai/claude-code"
          : "claude auth login",
      }),
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: directory });
    await expect(service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "hello", text_elements: [] }],
    })).rejects.toThrow(message);
    expect(service.readThread(started.thread.id, true).thread.turns).toEqual([]);
    await service.close();
  });
});
