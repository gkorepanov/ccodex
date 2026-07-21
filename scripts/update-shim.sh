#!/bin/sh
set -eu

BIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
attempt=0
while [ -e "$BIN_DIR/.codex-hybrid-update-in-progress" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 1200 ]; then
    echo "codex-hybrid update did not finish within 120 seconds" >&2
    exit 75
  fi
  sleep 0.1
done
exec "$BIN_DIR/codex-hybrid" "$@"
