import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compatibilityManifest, probeHostCompatibility } from "../../src/compatibility/probe.js";
import type { HybridConfig } from "../../src/config/config.js";
import { Logger } from "../../src/observability/logger.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function executable(name: string, version: string): string {
  const root = mkdtempSync(join(tmpdir(), "ccodex-probe-"));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\necho '${version}'\n`, { mode: 0o755 });
  return path;
}

function config(overrides: Partial<HybridConfig>): HybridConfig {
  return {
    realCodex: "codex",
    claudeBinary: "claude",
    dataDir: tmpdir(),
    publicSocket: join(tmpdir(), "unused.sock"),
    modelPrefix: "claude:",
    idleTimeoutSeconds: 1,
    modelCacheSeconds: 1,
    logLevel: "error",
    logPrompts: false,
    debugCapture: false,
    debugLogMaxBytes: 1,
    ...overrides,
  };
}

describe("host compatibility probe", () => {
  const expected = compatibilityManifest();
  const pinnedCodex = () => executable("codex", `codex-cli ${expected.codexCli}`);
  const pinnedClaude = () => executable("claude", `${expected.claudeCode} (Claude Code)`);
  const newerCodex = () => executable("codex", "codex-cli 0.158.0-alpha.2.1");
  const newerClaude = () => executable("claude", "2.1.283 (Claude Code)");

  it("accepts the pinned binaries silently", async () => {
    const logger = new Logger("error");
    const warn = vi.spyOn(logger, "warn");
    await expect(probeHostCompatibility(config({ realCodex: pinnedCodex(), claudeBinary: pinnedClaude() }), logger))
      .resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("still rejects a drifted pinned Codex", async () => {
    await expect(probeHostCompatibility(
      config({ realCodex: newerCodex(), realCodexSource: "pinned", claudeBinary: pinnedClaude() }),
      new Logger("error"),
    )).rejects.toThrow("Unsupported pinned Codex");
  });

  it("still rejects a drifted bundled Claude", async () => {
    await expect(probeHostCompatibility(
      config({ realCodex: pinnedCodex(), claudeBinary: newerClaude(), claudeBinarySource: "pinned" }),
      new Logger("error"),
    )).rejects.toThrow("Unsupported bundled Claude");
  });

  it("accepts an explicitly overridden Codex and Claude with a warning", async () => {
    const logger = new Logger("error");
    const warn = vi.spyOn(logger, "warn");
    await expect(probeHostCompatibility(config({
      realCodex: newerCodex(),
      realCodexSource: "override",
      claudeBinary: newerClaude(),
      claudeBinarySource: "override",
    }), logger)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("compatibility.codex-override", expect.objectContaining({
      codexVersion: "codex-cli 0.158.0-alpha.2.1",
      pinned: expected.codexCli,
    }));
    expect(warn).toHaveBeenCalledWith("compatibility.claude-override", expect.objectContaining({
      claudeVersion: "2.1.283 (Claude Code)",
      pinned: expected.claudeCode,
    }));
  });

  it("does not let an override excuse a missing Codex", async () => {
    await expect(probeHostCompatibility(
      config({ realCodex: join(tmpdir(), "missing-codex"), realCodexSource: "override", claudeBinary: pinnedClaude() }),
      new Logger("error"),
    )).rejects.toThrow("Pinned Codex version probe failed");
  });
});
