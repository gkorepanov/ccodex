#!/bin/sh
# Install the Claude -> Codex delegation stack into Claude Code:
# codex-wrapper agent, skills (workforce, ...), and the codex MCP server.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CLAUDE_DIR=${CLAUDE_DIR:-"$HOME/.claude"}

mkdir -p "$CLAUDE_DIR/agents" "$CLAUDE_DIR/skills"

cp "$ROOT/agents/codex-wrapper.md" "$CLAUDE_DIR/agents/codex-wrapper.md"
echo "installed agent: codex-wrapper -> $CLAUDE_DIR/agents/codex-wrapper.md"

for skill in "$ROOT"/skills/*/; do
  name=$(basename "$skill")
  rm -rf "$CLAUDE_DIR/skills/$name"
  cp -R "$skill" "$CLAUDE_DIR/skills/$name"
  echo "installed skill: $name -> $CLAUDE_DIR/skills/$name"
done

# User-scope MCP server, as `claude mcp add-json --scope user` writes it (no claude CLI needed: CCodex runs Claude through
# its SDK). Inherited tools take precedence over the agent's inline server declaration.
node --input-type=module <<'NODE'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const configDir = process.env.CLAUDE_CONFIG_DIR;
const legacyPath = join(configDir || join(homedir(), ".claude"), ".config.json");
const configPath = existsSync(legacyPath) ? legacyPath : join(configDir || homedir(), ".claude.json");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const server = config.mcpServers?.codex;
const timeout = Math.max(server?.timeout ?? 0, 86_400_000);
if (server?.timeout !== timeout) {
  config.mcpServers = { ...config.mcpServers, codex: server ? { ...server, timeout } : { type: "stdio", command: "codex", args: ["mcp-server"], env: {}, timeout } };
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: existsSync(configPath) ? statSync(configPath).mode & 0o777 : 0o600 });
  renameSync(temporaryPath, configPath);
}
console.log("codex MCP server: configured (user scope, timeout at least 24 hours)");
NODE
