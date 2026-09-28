import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let directory;
let configPath;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ccodex-claude-install-"));
  configPath = join(directory, ".claude.json");
  writeFileSync(join(directory, "claude"), `#!${process.execPath}
const fs = require("node:fs");
const assert = require("node:assert/strict");
assert.deepEqual(process.argv.slice(2, 7), ["mcp", "add-json", "--scope", "user", "codex"]);
const path = process.env.CLAUDE_CONFIG_DIR + "/.claude.json";
const config = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
config.mcpServers = { ...config.mcpServers, codex: JSON.parse(process.argv[7]) };
fs.writeFileSync(path, JSON.stringify(config));
`, { mode: 0o755 });
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

// A codex whose help lists `mcp-server`, like the pinned 0.153.3. Codex 0.154 removed it.
function fakeCodex(subcommands) {
  writeFileSync(join(directory, "codex"), `#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.0.0-test" ;;
  --help) printf 'Commands:\n%s' '${subcommands}' ;;
esac
`, { mode: 0o755 });
}

function install() {
  if (!existsSync(join(directory, "codex"))) fakeCodex("  exec  Run\n  mcp-server  Start Codex as an MCP server (stdio)\n");
  execFileSync("sh", [resolve("scripts/install-claude-stack.sh")], {
    env: {
      ...process.env,
      CLAUDE_DIR: join(directory, "agents-and-skills"),
      CLAUDE_CONFIG_DIR: directory,
      PATH: `${directory}:${process.env.PATH}`,
    },
  });
  return JSON.parse(readFileSync(configPath, "utf8"));
}

it("registers the user server and installs the agent with a 24-hour timeout", () => {
  expect(install().mcpServers.codex).toEqual({
    type: "stdio", command: "codex", args: ["mcp-server"], timeout: 86_400_000,
  });
  expect(readFileSync(join(directory, "agents-and-skills/agents/codex-wrapper.md"), "utf8"))
    .toContain("      timeout: 86400000\n");
});

it("updates only the existing server timeout and preserves file permissions", () => {
  const config = {
    unrelated: { setting: true },
    mcpServers: {
      other: { command: "other" },
      codex: { command: "custom-codex", args: ["custom"], env: { CUSTOM: "retained" }, extra: true, timeout: 1000 },
    },
  };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  expect(install()).toEqual({ ...config, mcpServers: {
    ...config.mcpServers, codex: { ...config.mcpServers.codex, timeout: 86_400_000 },
  } });
  expect(statSync(configPath).mode & 0o777).toBe(0o600);
});

it("keeps a longer timeout and leaves repeat installs unchanged", () => {
  const config = { mcpServers: { codex: { type: "http", url: "https://example.test/mcp", timeout: 172_800_000 } } };
  const original = JSON.stringify(config);
  writeFileSync(configPath, original);
  expect(install()).toEqual(config);
  expect(install()).toEqual(config);
  expect(readFileSync(configPath, "utf8")).toBe(original);
});

it("updates Claude's legacy config path when present", () => {
  configPath = join(directory, ".config.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: { codex: { command: "codex" } } }));
  expect(install().mcpServers.codex.timeout).toBe(86_400_000);
});

it("installs nothing when the codex on PATH has no mcp-server subcommand", () => {
  fakeCodex("  exec  Run\n  mcp  Manage external MCP servers for Codex\n");
  const result = execFileSync("sh", [resolve("scripts/install-claude-stack.sh")], {
    env: { ...process.env, CLAUDE_DIR: join(directory, "agents-and-skills"), CLAUDE_CONFIG_DIR: directory, PATH: `${directory}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(String(result)).toBe("");
  expect(existsSync(configPath)).toBe(false);
  expect(existsSync(join(directory, "agents-and-skills/agents/codex-wrapper.md"))).toBe(false);
});
