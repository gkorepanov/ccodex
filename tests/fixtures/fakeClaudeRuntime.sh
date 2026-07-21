#!/bin/sh
case "${1:-}" in
  --version) echo '2.1.215 (Claude Code)' ;;
  auth)
    [ "${2:-}" = status ] && printf '{"loggedIn":%s}\n' "${FAKE_CLAUDE_LOGGED_IN:-true}" || exit 2
    ;;
  *) exit 2 ;;
esac
