import type { Config } from "../../src/config.js";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    codex: "/usr/bin/codex",
    delegateCodex: "/usr/bin/codex",
    claudeBinary: "/usr/bin/claude",
    claudeHome: "/tmp/ccodex-test-claude",
    productHome: "/tmp/ccodex-test-home",
    dataDir: "/tmp/ccodex-test-home/state",
    publicSocket: "/tmp/ccodex-test.sock",
    modelPrefix: "claude:",
    idleTimeoutSeconds: 900,
    logLevel: "warn",
    rpcCapture: false,
    rpcCaptureMaxBytes: 1_048_576,
    ...overrides,
  };
}
