#!/bin/sh
# Usage: scripts/e2e/run.sh [scenario...]   (default: all). Builds the image from a fresh `npm pack`, then runs
# the driver inside with COPIES of the host credentials (refresh tokens stripped). Never touches the host state.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
WORK=${E2E_WORK:-/tmp/ccodex-e2e}
mkdir -p "$WORK/creds"
VERSION=$(node -p "require('$ROOT/package.json').version")
if [ "${E2E_SKIP_BUILD:-0}" != 1 ]; then
  (cd "$ROOT" && npm pack --silent --pack-destination "$WORK" >/dev/null)
  (cd "$ROOT/packages/relay-linux-x64-gnu" && npm pack --silent --pack-destination "$WORK" >/dev/null)
  cp "$WORK/gkorepanov-ccodex-$VERSION.tgz" "$ROOT/scripts/e2e/ccodex.tgz"
  cp "$WORK/gkorepanov-ccodex-relay-linux-x64-gnu-$VERSION.tgz" "$ROOT/scripts/e2e/relay.tgz"
  podman build -q -t ccodex-e2e --build-arg CCODEX_VERSION="$VERSION" -f "$ROOT/scripts/e2e/Containerfile" "$ROOT/scripts/e2e" >/dev/null
  rm -f "$ROOT/scripts/e2e/ccodex.tgz" "$ROOT/scripts/e2e/relay.tgz"
fi
node -e '
const fs = require("fs"); const home = process.env.HOME; const out = process.argv[1];
const claude = JSON.parse(fs.readFileSync(home + "/.claude/.credentials.json", "utf8"));
delete claude.claudeAiOauth.refreshToken; delete claude.mcpOAuth;
fs.writeFileSync(out + "/claude.json", JSON.stringify(claude), { mode: 0o600 });
const codex = JSON.parse(fs.readFileSync(home + "/.codex/auth.json", "utf8"));
codex.tokens.refresh_token = "stripped-for-container"; codex.last_refresh = new Date().toISOString();
fs.writeFileSync(out + "/codex.json", JSON.stringify(codex), { mode: 0o600 });
' "$WORK/creds"
exec podman run --rm --userns=keep-id ${E2E_PODMAN_ARGS:-} \
  -v "$WORK/creds/claude.json:/tmp/creds/claude.json:ro" -v "$WORK/creds/codex.json:/tmp/creds/codex.json:ro" \
  -v "$ROOT/scripts/e2e:/e2e:ro" -v "$WORK:/out" \
  ccodex-e2e sh -c 'cp /tmp/creds/claude.json ~/.claude/.credentials.json && cp /tmp/creds/codex.json ~/.codex/auth.json && node /e2e/driver.mjs "$@"' driver "$@"
