import { describe, expect, it } from "vitest";
import { classifyInvocation, withProxySocket } from "../../src/cli/args.js";
import { testConfig } from "../fixtures/config.js";

const config = testConfig();

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
      socketPath: config.publicSocket,
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
      socketPath: config.publicSocket,
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

  it("routes bare and explicit stdio app-server launches through the existing gateway", () => {
    expect(classifyInvocation(["app-server", "--analytics-default-enabled"], config))
      .toEqual({ kind: "stdioFrontend", socketPath: config.publicSocket, configOverrides: [] });
    expect(classifyInvocation(["app-server", "--stdio"], config))
      .toEqual({ kind: "stdioFrontend", socketPath: config.publicSocket, configOverrides: [] });
    expect(classifyInvocation(["app-server", "--listen", "unix://"], config))
      .toMatchObject({ kind: "gateway", socketPath: config.publicSocket });
  });

  it("preserves Codex App launch config for the stdio connection", () => {
    expect(classifyInvocation([
      "-c", "features.code_mode_host=true",
      "--config=mcp_servers.codex_app={ command=\"app-tools\" }",
      "app-server",
    ], config)).toEqual({
      kind: "stdioFrontend",
      socketPath: config.publicSocket,
      configOverrides: [
        "features.code_mode_host=true",
        "mcp_servers.codex_app={ command=\"app-tools\" }",
      ],
    });
  });
});
