#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TARGET=${1:?Usage: build-linux-relay.sh <rust-target> <package-directory>}
PACKAGE=${2:?Usage: build-linux-relay.sh <rust-target> <package-directory>}
OUTPUT=${TMPDIR:-/tmp}/ccodex-relay-$TARGET-$$
trap 'rm -rf "$OUTPUT"' EXIT INT TERM

case "$TARGET:$PACKAGE" in
  aarch64-unknown-linux-gnu:relay-linux-arm64-gnu) PLATFORM=linux/arm64 ;;
  x86_64-unknown-linux-gnu:relay-linux-x64-gnu) PLATFORM=linux/amd64 ;;
  *) echo "Unsupported Linux relay target/package pair: $TARGET / $PACKAGE" >&2; exit 1 ;;
esac

docker buildx build \
  --platform "$PLATFORM" \
  --build-arg "TARGET=$TARGET" \
  --file "$ROOT/release/Dockerfile.relay" \
  --output "type=local,dest=$OUTPUT" \
  "$ROOT"
mkdir -p "$ROOT/packages/$PACKAGE/bin"
install -m 755 "$OUTPUT/ccodex-relay" "$ROOT/packages/$PACKAGE/bin/ccodex-relay"
printf '%s\n' "Built $TARGET relay into packages/$PACKAGE/bin/ccodex-relay"
