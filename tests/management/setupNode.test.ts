import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
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
  const running = process.execPath;
  const select = runtime.setupNode;
  // What Desktop may start a launcher with: nothing beside any Node.
  const minimalPath = "/usr/bin:/bin";
  let root: string;
  let product: string;
  let target: string;
  let desktopNode: string;
  let platform: NodeJS.Platform;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccodex-setup-node-"));
    const home = join(root, "owner's home");
    const app = join(home, "Applications", "ChatGPT.app");
    product = join(home, ".ccodex");
    target = join(product, "versions", packageVersion(), "node_modules", "@gkorepanov", "ccodex");
    desktopNode = executable(join(app, "Contents", "Resources", "cua_node", "bin", "node"),
      'if [ "$1" = "-p" ]; then echo "22.13.0"; else echo "desktop-node"; fi');
    const bin = join(root, "bin");
    executable(join(bin, "codex"), 'echo "codex-cli 0.164.0"');
    executable(join(target, "scripts", "install-claude-stack.sh"), "exit 0");
    vi.stubEnv("HOME", home);
    vi.stubEnv("CCODEX_HOME", product);
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
    vi.stubEnv("CODEX_INSTALL_DIR", join(home, ".local", "bin"));
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    platform = "darwin";
    // Run the real lookup against a fixture app, never the machine's /Applications.
    vi.spyOn(runtime, "setupNode").mockImplementation(() => select(platform, [app]));
  });
  afterEach(() => {
    process.execPath = running;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const manifest = () => JSON.parse(readFileSync(join(product, "install.json"), "utf8"));
  const launch = (name: string, path = process.env.PATH) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: path };
    delete env.CCODEX_SHIM_ACTIVE;
    return execFileSync(join(product, "bin", name), ["--version"], { env, encoding: "utf8" }).trim();
  };
  const entrypoint = (script: string) => {
    mkdirSync(join(target, "dist", "cli"), { recursive: true });
    writeFileSync(join(target, "dist", "cli", "main.js"), script);
  };

  it("records and runs Desktop's Node even when setup runs under another Node", async () => {
    expect(await setup([])).toBe(0);
    expect(manifest().nodeExecutable).toBe(desktopNode);
    for (const name of ["codex", "ccodex"]) expect(launch(name)).toBe("desktop-node");
  });

  it("keeps what `npm i -g` put beside setup's Node reachable, which Desktop's Node doesn't", async () => {
    executable(desktopNode, 'if [ "$1" = "-p" ]; then echo "22.13.0"; else printf "%s" "$PATH"; fi');
    process.execPath = join(root, "owner's node", "bin", "node");
    await setup([]);
    for (const name of ["codex", "ccodex"]) expect(launch(name, minimalPath)).toBe(`${minimalPath}:${join(root, "owner's node", "bin")}`);
  });

  it("runs setup's Node once the app has none, with no node on PATH", async () => {
    entrypoint('console.log("setup-node");');
    await setup([]);
    rmSync(desktopNode);
    for (const name of ["codex", "ccodex"]) expect(launch(name, minimalPath)).toBe("setup-node");
  });

  it("remembers the Node outside the app through a setup a launcher runs on Desktop's Node", async () => {
    const outside = executable(join(root, "owner's node", "bin", "node"), 'echo "outside-node"');
    process.execPath = outside;
    await setup([]);
    process.execPath = desktopNode;
    await setup([]);
    rmSync(desktopNode);
    for (const name of ["codex", "ccodex"]) expect(launch(name, minimalPath)).toBe("outside-node");
  });

  it("changes nothing on Linux, even with a matching app", async () => {
    platform = "linux";
    entrypoint("console.log(process.env.PATH);");
    await setup([]);
    expect(manifest().nodeExecutable).toBe(running);
    expect(manifest()).not.toHaveProperty("fallbackNode");
    for (const name of ["codex", "ccodex"]) expect(launch(name, minimalPath)).toBe(minimalPath);
  });
});

describe("no codex on PATH", () => {
  const realPlatform = process.platform;
  const onPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { value });

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "ccodex-no-codex-"));
    executable(join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex"), 'echo "codex-cli 0.164.0"');
    vi.stubEnv("HOME", home);
    vi.stubEnv("CCODEX_HOME", join(home, ".ccodex"));
    vi.stubEnv("CCODEX_CONFIG", join(home, "none.toml"));
    vi.stubEnv("CCODEX_CODEX", undefined);
    vi.stubEnv("CODEX_INSTALL_DIR", join(home, ".local", "bin"));
    vi.stubEnv("PATH", "/usr/bin:/bin");
  });
  afterEach(() => {
    onPlatform(realPlatform);
    vi.unstubAllEnvs();
  });

  it("on macOS leaves Desktop's CLI, what a Desktop launch runs anyway, instead of stopping CCodex", () => {
    onPlatform("darwin");
    expect(loadConfig().codex).toMatch(/\/ChatGPT\.app\/Contents\/Resources\/codex-cli\/bin\/codex$/u);
  });

  it("stays an error on Linux", () => {
    onPlatform("linux");
    expect(() => loadConfig()).toThrow("No `codex` found on PATH");
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
