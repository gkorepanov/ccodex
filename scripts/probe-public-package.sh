#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK=$(mktemp -d "/tmp/ccodex-public-package.XXXXXX")
WORK=$(CDPATH= cd -- "$WORK" && pwd -P)
PREEXISTING_PID=
cleanup() {
  if [ -n "$PREEXISTING_PID" ]; then kill "$PREEXISTING_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT HUP INT TERM

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) relay=relay-darwin-arm64 ;;
  Linux:aarch64|Linux:arm64) relay=relay-linux-arm64-gnu ;;
  Linux:x86_64) relay=relay-linux-x64-gnu ;;
  *) echo 'unsupported package probe host' >&2; exit 1 ;;
esac
test -x "$ROOT/packages/$relay/bin/ccodex-relay" || {
  echo "Build packages/$relay/bin/ccodex-relay before this probe." >&2
  exit 1
}

mkdir -p "$WORK/packs" "$WORK/home/.local/bin" "$WORK/stage" "$WORK/upstream/bin"
mkdir -p "$WORK/home/.config/fish"
printf '%s\n' 'set -gx PATH /usr/bin /bin' > "$WORK/home/.config/fish/config.fish"
cp "$ROOT/tests/fixtures/fakeCodexRuntime.sh" "$WORK/upstream/bin/codex"
chmod +x "$WORK/upstream/bin/codex"
cp "$ROOT/tests/fixtures/fakeCodexRuntime.sh" "$WORK/home/.local/bin/codex"
chmod +x "$WORK/home/.local/bin/codex"
npm pack "$ROOT" --pack-destination "$WORK/packs" >/dev/null 2>&1
npm pack "$ROOT/packages/$relay" --pack-destination "$WORK/packs" >/dev/null 2>&1
version=$(node -p "require('$ROOT/package.json').version")
main=$(find "$WORK/packs" -name "gkorepanov-ccodex-$version.tgz")
platform=$(find "$WORK/packs" -name "gkorepanov-ccodex-$relay-$version.tgz")
if tar -tzf "$main" | grep -Eq '^package/(npm-shrinkwrap|package-lock)\.json$'; then
  echo 'main package unexpectedly contains an install lockfile' >&2
  exit 1
fi
npm install --prefix "$WORK/stage" --include=optional --ignore-scripts --save=false "$main" "$platform" >/dev/null
installed_relays=$(find "$WORK/stage" -type d -name 'ccodex-relay-*' -exec basename {} \; | sort -u)
test "$installed_relays" = "ccodex-$relay" || {
  printf '%s\n' "unexpected installed relay set:" "$installed_relays" >&2
  exit 1
}
installed_kb=$(du -sk "$WORK/stage" | awk '{print $1}')
test "$installed_kb" -lt 1572864 || {
  echo "single-platform install is unexpectedly large: ${installed_kb} KiB" >&2
  exit 1
}

export HOME="$WORK/home"
export CCODEX_HOME="$HOME/.ccodex"
export CODEX_HOME="$HOME/.codex"
export CCODEX_APP_SERVER_CODEX="$ROOT/tests/fixtures/fakeCodexRuntime.sh"
export CCODEX_CLAUDE_BINARY="$ROOT/tests/fixtures/fakeClaudeRuntime.sh"
export FAKE_CODEX_APP_SERVER="$ROOT/node_modules/@openai/codex/bin/codex.js"
export FAKE_CODEX_LOG="$WORK/app-server-codex.log"
mkdir -p "$CODEX_HOME/app-server-daemon"
printf '%s\n' '{"remoteControlEnabled":true}' > "$CODEX_HOME/app-server-daemon/settings.json"
tool_path="$(dirname "$(command -v node)"):$(dirname "$(command -v npm)"):/usr/bin:/bin"
mkdir -p "$WORK/fake-bin"
printf '%s\n' '#!/bin/sh' "printf '%s\\n' /wrong/unused-fish-codex" > "$WORK/fake-bin/fish"
chmod +x "$WORK/fake-bin/fish"
PATH="$HOME/.local/bin:$WORK/upstream/bin:$tool_path" \
  "$HOME/.local/bin/codex" app-server --listen unix:// >"$WORK/pre-existing.stdout" 2>"$WORK/pre-existing.stderr" &
PREEXISTING_PID=$!
socket="$CODEX_HOME/app-server-control/app-server-control.sock"
for _ in $(seq 1 200); do
  [ -S "$socket" ] && break
  kill -0 "$PREEXISTING_PID" 2>/dev/null || {
    cat "$WORK/pre-existing.stderr" >&2
    echo 'pre-existing stock app-server exited before readiness' >&2
    exit 1
  }
  sleep 0.05
done
[ -S "$socket" ] || { echo 'pre-existing stock app-server did not create its socket' >&2; exit 1; }
PATH="$WORK/fake-bin:$HOME/.local/bin:$WORK/upstream/bin:$tool_path" SHELL=/bin/sh "$WORK/stage/node_modules/.bin/ccodex" setup --staged "$WORK/stage" --version "$version" >/dev/null
test -f "$CCODEX_HOME/config.toml"
grep -q '^rename_prompt = """$' "$CCODEX_HOME/config.toml"
grep -q 'rare, expressive, context-relevant emoji' "$CCODEX_HOME/config.toml"
for _ in $(seq 1 200); do
  kill -0 "$PREEXISTING_PID" 2>/dev/null || break
  sleep 0.05
done
if kill -0 "$PREEXISTING_PID" 2>/dev/null; then
  echo 'setup left the pre-existing stock app-server alive' >&2
  exit 1
fi
wait "$PREEXISTING_PID" 2>/dev/null || true
PREEXISTING_PID=
test -f "$CODEX_HOME/app-server-daemon/app-server.pid"
orphans=$(ps -eo args= | grep -F "$WORK/stage/node_modules" | grep -v grep || true)
test -z "$orphans" || {
  printf '%s\n' "setup smoke left orphan processes:" "$orphans" >&2
  exit 1
}
test "$(/bin/sh -c '. "$HOME/.profile"; command -v codex')" = "$CCODEX_HOME/bin/codex"
test "$(tail -n 3 "$HOME/.config/fish/config.fish")" = "# >>> ccodex >>>
fish_add_path --move --prepend \"$CCODEX_HOME/bin\"
# <<< ccodex <<<"
node -e 'const m=require(process.argv[1]);if(m.delegateCodex!==process.argv[2])process.exit(1)' \
  "$CCODEX_HOME/install.json" "$CCODEX_HOME/backups/remote-codex"
remote_version=$(PATH="$WORK/upstream/bin:$tool_path" node -e '
  const {spawnSync}=require("node:child_process");
  const r=spawnSync("/bin/sh",["-c","PATH=\"$HOME/.local/bin:$PATH\"; codex --version"],{env:process.env,encoding:"utf8",timeout:5000});
  if(r.error||r.status!==0){process.stderr.write(r.stderr||String(r.error));process.exit(1)}
  process.stdout.write(r.stdout.trim());
')
test "$remote_version" = 'codex-cli 0.144.6'
PATH="$WORK/upstream/bin:$tool_path" node -e '
  const {spawnSync}=require("node:child_process");
  const r=spawnSync("/bin/sh",["-c","PATH=\"$HOME/.local/bin:$PATH\"; codex app-server proxy"],{env:process.env,encoding:"utf8",timeout:5000});
  if(r.error||r.status!==0){process.stderr.write(r.stderr||String(r.error));process.exit(1)}
'
grep -q 'app-server proxy --sock ' "$FAKE_CODEX_LOG"
"$CCODEX_HOME/bin/ccodex" doctor --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(!JSON.parse(s).ok)process.exit(1)})'
touch "$CCODEX_HOME/state/preserved.sqlite"
"$CCODEX_HOME/bin/ccodex" uninstall >/dev/null
test -f "$CCODEX_HOME/state/preserved.sqlite"
test "$(cat "$HOME/.config/fish/config.fish")" = 'set -gx PATH /usr/bin /bin'
test "$(PATH="$WORK/upstream/bin:$tool_path" /bin/sh -c 'PATH="$HOME/.local/bin:$PATH"; codex --version')" = 'codex-cli 0.144.6'

mkdir -p "$WORK/warn-stage" "$WORK/warn-home"
npm install --prefix "$WORK/warn-stage" --omit=optional --ignore-scripts --save=false "$main" "$platform" >/dev/null
HOME="$WORK/warn-home" CCODEX_HOME="$WORK/warn-home/.ccodex" FAKE_CLAUDE_LOGGED_IN=false \
  "$WORK/warn-stage/node_modules/.bin/ccodex" setup \
  --staged "$WORK/warn-stage" --version "$version" >"$WORK/warn.stdout" 2>"$WORK/warn.stderr"
grep -q 'CCodex setup warning: claude-auth:' "$WORK/warn.stderr"
test -L "$WORK/warn-home/.ccodex/current"
HOME="$WORK/warn-home" CCODEX_HOME="$WORK/warn-home/.ccodex" \
  "$WORK/warn-home/.ccodex/bin/ccodex" uninstall --purge --yes >/dev/null

mkdir -p "$WORK/route-fail-stage" "$WORK/route-fail-home/bin"
npm install --prefix "$WORK/route-fail-stage" --omit=optional --ignore-scripts --save=false "$main" "$platform" >/dev/null
printf '%s\n' '#!/bin/sh' "printf '%s\\n' /wrong/codex" > "$WORK/route-fail-home/bin/zsh"
chmod +x "$WORK/route-fail-home/bin/zsh"
if env HOME="$WORK/route-fail-home" CCODEX_HOME="$WORK/route-fail-home/.ccodex" SHELL="$WORK/route-fail-home/bin/zsh" "$WORK/route-fail-stage/node_modules/.bin/ccodex" setup --staged "$WORK/route-fail-stage" --version "$version" >"$WORK/route-fail.stdout" 2>"$WORK/route-fail.stderr"; then
  echo 'setup activated with broken shell routing' >&2
  exit 1
fi
grep -q 'resolves codex' "$WORK/route-fail.stderr" || {
  sed -n '1,120p' "$WORK/route-fail.stderr" >&2
  exit 1
}
test ! -e "$WORK/route-fail-home/.ccodex/current"
test ! -e "$WORK/route-fail-home/.ccodex/bin/codex"

printf 'Public package probe passed on %s with %s.\n' "$(uname -s)/$(uname -m)" "$relay"
