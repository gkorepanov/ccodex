#!/bin/sh
# Install ccodex skills into Claude Code by copying skills/* to ~/.claude/skills/.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEST=${CLAUDE_SKILLS_DIR:-"$HOME/.claude/skills"}

mkdir -p "$DEST"
for skill in "$ROOT"/skills/*/; do
  name=$(basename "$skill")
  rm -rf "$DEST/$name"
  cp -R "$skill" "$DEST/$name"
  echo "installed skill: $name -> $DEST/$name"
done
