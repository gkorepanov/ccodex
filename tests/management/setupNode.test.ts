import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { packageVersion, setup } from "../../src/management/commands.js";
import * as runtime from "../../src/management/node.js";

// Setup's files are real; launchctl must never change the user's active Desktop.
vi.mock("../../src/desktop/launchAgent.js", () => ({
  installCliPathAgent: () => undefined,
  uninstallCliPathAgent: () => undefined,
}));

const executable = (path: string, script: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return path;
};

describe("the Node recorded by setup", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ccodex-setup-node-")); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("records and runs Desktop's Node even when setup runs under another Node", async () => {
    const home = join(root, "owner's home");
    const product = join(home, ".ccodex");
    const node = executable(join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "cua_node", "bin", "node"),
      'if [ "$1" = "-p" ]; then echo "22.13.0"; else echo "desktop-node"; fi');
    const bin = join(root, "bin");
    executable(join(bin, "codex"), 'echo "codex-cli 0.164.0"');
    const target = join(product, "versions", packageVersion(), "node_modules", "@gkorepanov", "ccodex");
    executable(join(target, "scripts", "install-claude-stack.sh"), "exit 0");
    vi.stubEnv("HOME", home);
    vi.stubEnv("CCODEX_HOME", product);
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
    vi.stubEnv("CODEX_INSTALL_DIR", join(home, ".local", "bin"));
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    const select = runtime.setupNode;
    // Run the real lookup against a fixture app, never the machine's /Applications.
    vi.spyOn(runtime, "setupNode").mockImplementationOnce(() => select("darwin", [join(home, "Applications", "ChatGPT.app")]));

    expect(await setup([])).toBe(0);
    const manifest = JSON.parse(readFileSync(join(product, "install.json"), "utf8"));
    expect(manifest.nodeExecutable).toBe(node);
    for (const name of ["codex", "ccodex"]) {
      const env = { ...process.env };
      delete env.CCODEX_SHIM_ACTIVE;
      expect(execFileSync(join(product, "bin", name), ["--version"], { env, encoding: "utf8" }).trim()).toBe("desktop-node");
    }
  });
});

describe("choosing setup's Node", () => {
  let app: string;
  let candidate: string;
  beforeEach(() => {
    app = join(mkdtempSync(join(tmpdir(), "ccodex-node-")), "ChatGPT.app");
    candidate = join(app, "Contents", "Resources", "cua_node", "bin", "node");
  });

  it.each(["22.13.0", "24.0.0", "26.7.0"])("prefers Desktop's supported Node %s", async (version) => {
    executable(candidate, `echo "${version}"`);
    expect(await runtime.setupNode("darwin", [app])).toBe(candidate);
  });

  it.each(["22.12.0", "21.0.0", "27.0.0", "invalid"])("keeps setup's Node when Desktop's version is %s", async (version) => {
    executable(candidate, `echo "${version}"`);
    expect(await runtime.setupNode("darwin", [app])).toBe(process.execPath);
  });

  it("keeps setup's Node when the app is missing or its Node cannot execute", async () => {
    expect(await runtime.setupNode("darwin", [app])).toBe(process.execPath);
    executable(candidate, 'echo "24.0.0"');
    chmodSync(candidate, 0o644);
    expect(await runtime.setupNode("darwin", [app])).toBe(process.execPath);
  });

  it("tries the user app when the system app's Node fails", async () => {
    executable(candidate, "exit 1");
    const userApp = join(dirname(app), "Applications", "ChatGPT.app");
    const userNode = executable(join(userApp, "Contents", "Resources", "cua_node", "bin", "node"), 'echo "24.0.0"');
    expect(await runtime.setupNode("darwin", [app, userApp])).toBe(userNode);
  });

  it("keeps setup's Node on Linux even if a matching app path exists", async () => {
    executable(candidate, 'echo "24.0.0"');
    expect(await runtime.setupNode("linux", [app])).toBe(process.execPath);
  });
});
