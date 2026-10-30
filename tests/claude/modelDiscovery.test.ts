import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, fakeQuery, fakeStartup } from "../fixtures/fakeClaude.js";
import { ClaudeThreads } from "../../src/claude/threads.js";
import { Gateway } from "../../src/gateway/server.js";
import { Logger } from "../../src/log.js";
import { packageVersion } from "../../src/management/commands.js";
import { testConfig } from "../fixtures/config.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async original => ({ ...await original<object>(), query: fakeQuery, startup: fakeStartup }));

let root: string;
let threads: ClaudeThreads;
let releaseDetails: () => void;
const originalClaudeHome = process.env.CLAUDE_CONFIG_DIR;
const cache = () => JSON.parse(readFileSync(join(root, "claude-models.json"), "utf8"));

beforeEach(() => {
  fakeClaude.reset();
  root = mkdtempSync(join(tmpdir(), "cc-models-"));
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  const config = testConfig({ dataDir: root, claudeHome: join(root, "claude") });
  const logger = new Logger("error");
  threads = new ClaudeThreads(config, new Gateway(config, join(root, "gateway.sock"), logger), logger);
  fakeClaude.contextHold = new Promise(resolve => { releaseDetails = resolve; });
});
afterEach(async () => {
  releaseDetails();
  await vi.waitFor(() => expect(cache().models.every((m: any) => m.contextWindow)).toBe(true));
  await threads.close();
  vi.useRealTimers();
  if (originalClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeHome;
  rmSync(root, { recursive: true, force: true });
});

async function startedDetails(): Promise<void> {
  await vi.waitFor(() => expect(fakeClaude.calls.some(c => c.method === "getContextUsage")).toBe(true));
}

describe("Claude model availability before context details", () => {
  it("returns and caches the real model list while context details are still pending", async () => {
    const listed = threads.models();
    await startedDetails();
    const result = await Promise.race([listed, Promise.resolve(null)]);
    expect(result).not.toBeNull();
    expect(result!.map(m => m.id)).toContain("claude:claude-opus-5-5");
    await vi.waitFor(() => expect(cache().models.map((m: any) => m.value)).toContain("claude-opus-5-5"));
    expect(threads.contextWindow("claude-opus-5-5")).toBe(200_000);
  });

  it("fills context details and the cache after the background work completes", async () => {
    const listed = threads.models();
    await startedDetails();
    expect(await Promise.race([listed, Promise.resolve(null)])).not.toBeNull();
    releaseDetails();
    await vi.waitFor(() => expect(threads.contextWindow("claude-opus-5-5")).toBe(400_000));
    await vi.waitFor(() => expect(cache().models.find((m: any) => m.value === "claude-opus-5-5").contextWindow).toBe(400_000));
  });

  it("keeps published models and the base cache when detail discovery times out", async () => {
    vi.useFakeTimers();
    const listed = threads.models();
    await startedDetails();
    expect(await Promise.race([listed, Promise.resolve(null)])).not.toBeNull();
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await threads.models()).map(m => m.id)).toContain("claude:claude-opus-5-5");
    await vi.waitFor(() => expect(cache().models.map((m: any) => m.value)).toContain("claude-opus-5-5"));
  });

  it("preserves known context details in the cache while refreshing them", async () => {
    writeFileSync(join(root, "claude-models.json"), JSON.stringify({ version: packageVersion(), models: [
      { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "Opus", contextWindow: 600_000 },
    ] }));
    await threads.start();
    await startedDetails();
    await vi.waitFor(() => expect(cache().models).toHaveLength(3));
    expect(cache().models.find((m: any) => m.value === "claude-opus-5-5").contextWindow).toBe(600_000);
    expect(threads.contextWindow("claude-opus-5-5")).toBe(600_000);
  });

  it("retries when the required catalog request itself fails", async () => {
    fakeClaude.modelsHold = Promise.reject(new Error("catalog unavailable"));
    await expect(threads.models()).rejects.toThrow("catalog unavailable");
    fakeClaude.modelsHold = null;
    releaseDetails();
    expect((await threads.models()).map(m => m.id)).toContain("claude:claude-opus-5-5");
  });
});
