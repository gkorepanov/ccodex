#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TARGET=${CCODEX_RELAY_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}

case "$TARGET" in
  aarch64-apple-darwin) PACKAGE=relay-darwin-arm64 ;;
  x86_64-apple-darwin) PACKAGE=relay-darwin-x64 ;;
  aarch64-unknown-linux-gnu) PACKAGE=relay-linux-arm64-gnu ;;
  x86_64-unknown-linux-gnu) PACKAGE=relay-linux-x64-gnu ;;
  *) echo "Unsupported CCodex relay target: $TARGET" >&2; exit 1 ;;
esac

cargo build --manifest-path "$ROOT/relay/Cargo.toml" --release --target "$TARGET"
SOURCE="$ROOT/relay/target/$TARGET/release/codex-hybrid-remote-relay"
PACKAGE_BIN="$ROOT/packages/$PACKAGE/bin"
mkdir -p "$PACKAGE_BIN"
install -m 755 "$SOURCE" "$PACKAGE_BIN/ccodex-relay"
mkdir -p "$ROOT/dist/bin"
install -m 755 "$SOURCE" "$ROOT/dist/bin/ccodex-relay"
printf '%s\n' "Built $TARGET relay into packages/$PACKAGE/bin/ccodex-relay"
