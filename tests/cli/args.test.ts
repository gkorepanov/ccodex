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
      ignored: [],
    });
    expect(classifyInvocation(["app-server", "daemon", "bootstrap", "--remote-control"], config)).toEqual({
      kind: "daemon",
      command: "bootstrap",
      remoteControl: true,
      ignored: [],
    });
    expect(classifyInvocation(["app-server", "daemon", "--help"], config)).toEqual({ kind: "delegate" });
  });

  it("hands stock's daemon commands CCodex doesn't run to stock, runs its own with options it doesn't know ignored", () => {
    expect(classifyInvocation(["app-server", "daemon", "update"], config)).toEqual({ kind: "delegate" });
    // Never stock's start: its daemon would take the socket from CCodex's.
    expect(classifyInvocation(["app-server", "daemon", "start", "-c", "a=1", "--enable", "x", "--remote-control"], config))
      .toEqual({ kind: "daemon", command: "start", remoteControl: false, ignored: ["-c", "a=1", "--enable", "x", "--remote-control"] });
  });

  it("delegates Desktop's startup config check (it prints stock's requirements, no server starts)", () => {
    expect(classifyInvocation(["app-server", "--print-startup-config", "--startup-client-info", "{\"name\":\"codex_desktop\"}"], config))
      .toEqual({ kind: "delegate" });
  });

  it("delegates what only prints and exits: help, schema generation, any --print- option", () => {
    for (const args of [["generate-ts", "--out", "schemas"], ["generate-json-schema"], ["help"], ["--help"], ["-h"], ["--print-something-new"]]) {
      expect(classifyInvocation(["app-server", ...args], config)).toEqual({ kind: "delegate" });
    }
  });

  it("routes bare and explicit stdio app-server launches through the existing gateway", () => {
    // Launch options the frontend doesn't take are only noted.
    expect(classifyInvocation(["app-server", "--analytics-default-enabled", "--strict-config"], config))
      .toEqual({ kind: "stdioFrontend", socketPath: config.publicSocket, configOverrides: [], ignored: ["--analytics-default-enabled", "--strict-config"] });
    expect(classifyInvocation(["app-server", "--stdio"], config))
      .toEqual({ kind: "stdioFrontend", socketPath: config.publicSocket, configOverrides: [], ignored: [] });
    expect(classifyInvocation(["app-server", "--listen", "stdio://", "-c", "a=1"], config))
      .toEqual({ kind: "stdioFrontend", socketPath: config.publicSocket, configOverrides: ["a=1"], ignored: [] });
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
      ignored: [],
    });
  });
});
