#!/bin/sh
set -eu

home=${CCODEX_HOME:-"$HOME/.ccodex"}
purge=
[ "${1:-}" != '--purge' ] || purge='--purge --yes'

if [ -x "$home/bin/ccodex" ] && "$home/bin/ccodex" uninstall $purge; then
  exit 0
fi
command -v npx >/dev/null 2>&1 || {
  printf 'CCodex uninstall needs Node/npm. Install Node.js 22 or 24 LTS, then rerun this command.\n' >&2
  exit 1
}
npx --yes --package @gkorepanov/ccodex ccodex uninstall $purge
