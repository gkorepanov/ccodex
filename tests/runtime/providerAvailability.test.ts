import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProviderAvailabilityService,
  probeClaudeAvailability,
  probeCodexAvailability,
  providerUnavailableMessage,
} from "../../src/runtime/providerAvailability.js";
import { probeHostCompatibility } from "../../src/compatibility/probe.js";
import { Logger } from "../../src/observability/logger.js";

const directories: string[] = [];

function executable(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "ccodex-provider-"));
  directories.push(directory);
  const path = join(directory, "provider");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("provider availability", () => {
  it("distinguishes ready, unauthenticated, and missing Claude CLI", async () => {
    await expect(probeClaudeAvailability(executable("printf '%s\\n' '{\"loggedIn\":true}'"))).resolves.toMatchObject({
      provider: "claude", state: "ready",
    });
    const unauthenticated = await probeClaudeAvailability(executable(
      "printf '%s\\n' '{\"loggedIn\":false}'; exit 1",
    ));
    expect(unauthenticated).toMatchObject({
      provider: "claude", state: "notAuthenticated", action: "claude auth login",
    });
    expect(providerUnavailableMessage(unauthenticated)).toBe(
      "Claude is not authenticated\n  ↳ `claude auth login`",
    );
    const missing = await probeClaudeAvailability(join(tmpdir(), "ccodex-definitely-missing-claude"));
    expect(missing).toMatchObject({
      provider: "claude",
      state: "notInstalled",
      action: "npm i -g @anthropic-ai/claude-code",
    });
  });

  it("probes Codex authentication independently from an external delegate", async () => {
    await expect(probeCodexAvailability(executable("printf '%s\\n' 'Logged in using ChatGPT'"))).resolves.toMatchObject({
      provider: "codex", state: "ready",
    });
    await expect(probeCodexAvailability(executable("printf '%s\\n' 'Not logged in'"))).resolves.toMatchObject({
      provider: "codex", state: "notAuthenticated", action: "codex login",
    });
  });

  it("shares cached provider probes without loading a Claude runtime", async () => {
    const claude = executable("printf '%s\\n' '{\"loggedIn\":true}'");
    const codex = executable("printf '%s\\n' 'Logged in'");
    const service = new ProviderAvailabilityService({ claudeBinary: claude, realCodex: codex });
    await expect(service.all()).resolves.toMatchObject({
      claude: { state: "ready" },
      codex: { state: "ready" },
    });
    rmSync(claude);
    await expect(service.read("claude")).resolves.toMatchObject({ state: "ready" });
    await expect(service.refresh("claude")).resolves.toMatchObject({ state: "notInstalled" });
  });

  it("keeps pinned Codex structural but treats a missing Claude CLI as optional", async () => {
    const codex = executable("printf '%s\\n' 'codex-cli 0.144.6'");
    await expect(probeHostCompatibility({
      realCodex: codex,
      claudeBinary: join(tmpdir(), "ccodex-definitely-missing-claude"),
      dataDir: tmpdir(),
      publicSocket: join(tmpdir(), "ccodex-test.sock"),
      modelPrefix: "claude:",
      idleTimeoutSeconds: 900,
      modelCacheSeconds: 300,
      logLevel: "error",
      logPrompts: false,
      debugCapture: false,
      debugLogMaxBytes: 1_048_576,
    }, new Logger("error"))).resolves.toBeUndefined();
  });
});
