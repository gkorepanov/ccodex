#!/bin/sh
set -eu

PREFIX=${1:-"$HOME/.local"}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PACKAGE_DIR=${TMPDIR:-/tmp}/codex-hybrid-package-$$
REAL_CODEX_RECORD="$PREFIX/bin/.codex-hybrid-real-codex"
UPDATE_SHIM="$PREFIX/bin/.codex-hybrid-update-shim"
UPDATE_MARKER="$PREFIX/bin/.codex-hybrid-update-in-progress"
UPDATE_ACTIVE=0
mkdir -p "$PACKAGE_DIR"

cleanup() {
  if [ "$UPDATE_ACTIVE" -eq 1 ]; then
    if [ -x "$PREFIX/bin/codex-hybrid" ]; then
      ln -sfn codex-hybrid "$PREFIX/bin/codex"
    elif [ -f "$REAL_CODEX_RECORD" ]; then
      REAL_CODEX=$(sed -n '1p' "$REAL_CODEX_RECORD")
      [ ! -x "$REAL_CODEX" ] || ln -sfn "$REAL_CODEX" "$PREFIX/bin/codex"
    fi
    rm -f "$UPDATE_MARKER" "$UPDATE_SHIM"
  fi
  rm -rf "$PACKAGE_DIR"
}
trap cleanup EXIT

if [ ! -f "$REAL_CODEX_RECORD" ]; then
  if [ -e "$PREFIX/bin/codex" ] || [ -L "$PREFIX/bin/codex" ]; then
    mkdir -p "$PREFIX/bin"
    realpath "$PREFIX/bin/codex" > "$REAL_CODEX_RECORD"
    chmod 600 "$REAL_CODEX_RECORD"
  elif [ -n "${CODEX_HYBRID_REAL_CODEX:-}" ]; then
    mkdir -p "$PREFIX/bin"
    realpath "$CODEX_HYBRID_REAL_CODEX" > "$REAL_CODEX_RECORD"
    chmod 600 "$REAL_CODEX_RECORD"
  fi
fi

cd "$ROOT"
npm ci
npm run build

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) RELAY_PACKAGE=relay-darwin-arm64 ;;
  Linux:aarch64|Linux:arm64) RELAY_PACKAGE=relay-linux-arm64-gnu ;;
  Linux:x86_64) RELAY_PACKAGE=relay-linux-x64-gnu ;;
  *) echo "Unsupported CCodex relay host: $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

if [ -x "$PREFIX/bin/codex-hybrid" ]; then
  install -m 700 "$ROOT/scripts/update-shim.sh" "$UPDATE_SHIM"
  : > "$UPDATE_MARKER"
  chmod 600 "$UPDATE_MARKER"
  ln -sfn .codex-hybrid-update-shim "$PREFIX/bin/codex"
  UPDATE_ACTIVE=1
fi

TARBALL=$(npm pack --pack-destination "$PACKAGE_DIR" --silent | tail -n 1)
RELAY_TARBALL=$(npm pack "$ROOT/packages/$RELAY_PACKAGE" --pack-destination "$PACKAGE_DIR" --silent | tail -n 1)
npm install --global --prefix "$PREFIX" "$PACKAGE_DIR/$TARBALL" "$PACKAGE_DIR/$RELAY_TARBALL"
ln -sfn codex-hybrid "$PREFIX/bin/codex"
rm -f "$UPDATE_MARKER" "$UPDATE_SHIM"
UPDATE_ACTIVE=0

printf '%s\n' "Installed: $PREFIX/bin/codex-hybrid" "Drop-in alias: $PREFIX/bin/codex"
