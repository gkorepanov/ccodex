#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REAL_CODEX=${CODEX_HYBRID_REAL_CODEX:?Set CODEX_HYBRID_REAL_CODEX to the absolute npm Codex binary}
CLAUDE_BINARY=${CODEX_HYBRID_CLAUDE_BINARY:?Set CODEX_HYBRID_CLAUDE_BINARY to the absolute Claude CLI binary}
WORK_ROOT="$HOME/.chp"
mkdir -p "$WORK_ROOT"
WORK=$(mktemp -d "$WORK_ROOT/chp.XXXXXX")
PREFIX="$WORK/prefix"
CODEX_HOME="$WORK/codex-home"
CCODEX_HOME="$WORK/ccodex-home"
DATA_DIR="$WORK/hybrid-state"
CLI="$PREFIX/bin/codex"
INSTALLED=0

run_hybrid() {
  env \
    CODEX_HOME="$CODEX_HOME" \
    CCODEX_HOME="$CCODEX_HOME" \
    CODEX_HYBRID_DATA_DIR="$DATA_DIR" \
    CODEX_HYBRID_REAL_CODEX="$REAL_CODEX" \
    CCODEX_DELEGATE_CODEX="$REAL_CODEX" \
    CODEX_HYBRID_CLAUDE_BINARY="$CLAUDE_BINARY" \
    CODEX_HYBRID_RPC_CAPTURE=1 \
    CODEX_HYBRID_RPC_CAPTURE_INCLUDE_CONTENT=1 \
    "$@"
}

cleanup() {
  if [ "$INSTALLED" -eq 1 ]; then
    run_hybrid "$CLI" app-server daemon stop >/dev/null 2>&1 || true
    "$ROOT/scripts/uninstall-local.sh" "$PREFIX" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$CODEX_HOME"
"$ROOT/scripts/install-local.sh" "$PREFIX"
INSTALLED=1

UPDATE_RESULT="$WORK/update-version.txt"
(
  while [ "$(readlink "$CLI")" != ".codex-hybrid-update-shim" ]; do sleep 0.02; done
  run_hybrid "$CLI" --version > "$UPDATE_RESULT"
) &
UPDATE_WAITER=$!
"$ROOT/scripts/install-local.sh" "$PREFIX" >/dev/null
wait "$UPDATE_WAITER"
grep -q '^codex-cli 0\.144\.6$' "$UPDATE_RESULT"

run_hybrid env \
  CODEX_HYBRID_CLI="$CLI" \
  CODEX_HYBRID_EXPECT_CODEX_VERSION="0.144.6" \
  node "$ROOT/scripts/probe-daemon.mjs"

run_hybrid node "$ROOT/scripts/probe-claude-options.mjs"

run_hybrid "$CLI" app-server daemon bootstrap --remote-control >/dev/null
run_hybrid env \
  CODEX_HYBRID_PROXY_COMMAND="$CLI app-server proxy" \
  CODEX_HYBRID_PROBE_CWD="$ROOT" \
  CODEX_HYBRID_TEST_MODEL="claude:claude-fable-5" \
  CODEX_HYBRID_TEST_PERMISSIONS=":danger-full-access" \
  CODEX_HYBRID_TEST_EFFORT="xhigh" \
  node "$ROOT/scripts/probe-proxy.mjs"
run_hybrid env \
  CODEX_HYBRID_PROXY_COMMAND="$CLI app-server proxy" \
  CODEX_HYBRID_PROBE_CWD="$ROOT" \
  CODEX_HYBRID_TEST_MODEL="claude:claude-opus-4-8" \
  CODEX_HYBRID_TEST_SERVICE_TIER="priority" \
  CODEX_HYBRID_TEST_EFFORT="xhigh" \
  node "$ROOT/scripts/probe-proxy.mjs"

run_hybrid "$CLI" app-server daemon stop >/dev/null
grep -q '"direction":"client_to_gateway"' "$DATA_DIR/rpc.jsonl"
grep -q '"direction":"gateway_to_client"' "$DATA_DIR/rpc.jsonl"
test ! -e "$CODEX_HOME/app-server-daemon/app-server.pid"
"$ROOT/scripts/uninstall-local.sh" "$PREFIX" >/dev/null
INSTALLED=0
test ! -e "$PREFIX/bin/codex-hybrid"
test "$(realpath "$PREFIX/bin/codex")" = "$(realpath "$REAL_CODEX")"

printf '%s\n' '{"packageGate":true,"codexVersion":"0.144.6"}'
