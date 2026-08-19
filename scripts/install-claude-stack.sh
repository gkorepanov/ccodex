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

if ! command -v claude >/dev/null 2>&1; then
  echo "codex MCP server: skipped (claude CLI not found)" >&2
elif claude mcp get codex >/dev/null 2>&1; then
  echo "codex MCP server: already registered"
else
  claude mcp add --scope user codex -- codex mcp-server
  echo "codex MCP server: registered (user scope)"
fi
