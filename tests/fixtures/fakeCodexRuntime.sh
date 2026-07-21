#!/bin/sh
[ -z "${FAKE_CODEX_LOG:-}" ] || printf '%s\n' "$*" >> "$FAKE_CODEX_LOG"
case "${1:-}" in
  --version) echo 'codex-cli 0.144.6' ;;
  login)
    [ "${2:-}" = status ] && echo 'Logged in using ChatGPT' || exit 2
    ;;
  app-server)
    if [ "${2:-}" = proxy ]; then
      :
    elif [ -n "${FAKE_CODEX_APP_SERVER:-}" ]; then
      exec "$FAKE_CODEX_APP_SERVER" "$@"
    else
      exit 2
    fi
    ;;
  *) exit 2 ;;
esac
