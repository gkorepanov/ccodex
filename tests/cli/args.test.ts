import { describe, expect, it } from "vitest";
import { classifyInvocation, withProxySocket } from "../../src/cli/args.js";
import type { HybridConfig } from "../../src/config/config.js";

const config: HybridConfig = {
  realCodex: "/usr/bin/codex",
  claudeBinary: "/usr/bin/claude",
  dataDir: "/tmp/hybrid",
  publicSocket: "/tmp/hybrid.sock",
  modelPrefix: "claude:",
  idleTimeoutSeconds: 900,
  modelCacheSeconds: 300,
  logLevel: "info",
  logPrompts: false,
  debugCapture: false,
  debugLogMaxBytes: 1_048_576,
};

describe("classifyInvocation", () => {
  it("delegates normal Codex commands", () => {
    expect(classifyInvocation(["exec", "pwd"], config)).toEqual({ kind: "delegate" });
  });

  it("recognizes the desktop remote app-server launch shape", () => {
    expect(
      classifyInvocation(
        ["-c", "features.code_mode_host=true", "app-server", "--listen", "unix://"],
        config,
      ),
    ).toEqual({
      kind: "gateway",
      socketPath: "/tmp/hybrid.sock",
      stockArgs: ["-c", "features.code_mode_host=true", "app-server"],
    });
  });

  it("preserves an explicit Unix socket", () => {
    expect(
      classifyInvocation(["app-server", "--listen=unix:///tmp/custom.sock"], config),
    ).toMatchObject({ kind: "gateway", socketPath: "/tmp/custom.sock" });
  });

  it("routes proxy to the hybrid socket", () => {
    const invocation = classifyInvocation(["app-server", "proxy"], config);
    expect(invocation).toEqual({
      kind: "proxy",
      socketPath: "/tmp/hybrid.sock",
      proxyArgs: ["app-server", "proxy"],
    });
    expect(withProxySocket(invocation.kind === "proxy" ? invocation.proxyArgs : [], "/x.sock"))
      .toEqual(["app-server", "proxy", "--sock", "/x.sock"]);
  });

  it("routes the npm-compatible daemon lifecycle to the wrapper", () => {
    expect(classifyInvocation(["app-server", "daemon", "start"], config)).toEqual({
      kind: "daemon",
      command: "start",
      remoteControl: false,
    });
    expect(classifyInvocation(["app-server", "daemon", "bootstrap", "--remote-control"], config)).toEqual({
      kind: "daemon",
      command: "bootstrap",
      remoteControl: true,
    });
    expect(classifyInvocation(["app-server", "daemon", "--help"], config)).toEqual({ kind: "delegate" });
  });

  it("rejects unsupported daemon commands and options instead of falling into stock standalone", () => {
    expect(() => classifyInvocation(["app-server", "daemon", "pid-update-loop"], config))
      .toThrow("Unsupported app-server daemon command");
    expect(() => classifyInvocation(["app-server", "daemon", "start", "--remote-control"], config))
      .toThrow("Unexpected options");
  });

  it("delegates schema generation", () => {
    expect(classifyInvocation(["app-server", "generate-ts", "--out", "schemas"], config))
      .toEqual({ kind: "delegate" });
  });
});
