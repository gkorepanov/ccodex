#!/bin/sh
set -eu

PREFIX=${1:-"$HOME/.local"}
REAL_CODEX_RECORD="$PREFIX/bin/.codex-hybrid-real-codex"
rm -f "$PREFIX/bin/codex"
npm uninstall --global --prefix "$PREFIX" codex-claude-hybrid-app-server >/dev/null 2>&1 || true
rm -f "$PREFIX/bin/codex-hybrid"
if [ -f "$REAL_CODEX_RECORD" ]; then
  REAL_CODEX=$(sed -n '1p' "$REAL_CODEX_RECORD")
  if [ -x "$REAL_CODEX" ]; then
    ln -s "$REAL_CODEX" "$PREFIX/bin/codex"
  fi
  rm -f "$REAL_CODEX_RECORD"
fi
printf '%s\n' "Removed codex-hybrid from $PREFIX and restored the previous codex target when available. Existing state/config was preserved."
