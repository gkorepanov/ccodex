# CCodex: technical details

Back to the [README](../README.md).

## Features in detail

- **Claude models in the model picker**, next to `gpt-*` (ids `claude:…`), with Claude's
  effort levels and Fast mode. Codex's `ultra` effort runs Claude at `max` and has it
  delegate to sub-agents proactively, as stock does for GPT.
- **Switch providers mid-chat.** Pick a GPT model in a Claude chat (or the other way
  round) and the conversation is compacted into a summary that the other provider
  continues from. The App keeps showing one chat with one history; edits and forks across
  the switch work.
- **Codex App features on Claude chats**: approvals, Plan mode, `/goal`, `/compact`, fork,
  message edits, steering and queued messages, Stop, side chats (`/side`, served by
  Claude's `/btw`), images, Claude's questions as the App's question prompts, its task
  list as the turn's to-do list, and thinking as reasoning summaries.
- **Sub-agents and background commands like stock's**: Claude sub-agents open as their
  own threads, background shell commands show as background terminals, and messages
  between Claude chats show as the App's messages between tasks.
- **Claude skills in the `$` picker**, beside Codex skills, in Claude and GPT chats.
- **Search**: the sidebar search and find-in-chat cover Claude chats too.
- **Phone**: turn on remote control in the Codex App (or
  `codex app-server daemon enable-remote-control` on the host) and pair the ChatGPT
  mobile app as usual; it drives Claude chats like GPT ones.
- **Your `claude` CLI sessions show up** in the App, and chats from the App resume in
  `claude --resume <id>` (a Claude chat's id is its Claude session id). While another live
  Claude process has a chat open, the App can't start a turn in it.
- **Claude can delegate to Codex** through the `codex-wrapper` agent that setup installs;
  what Codex does streams into the Claude chat.
- **`/cc` status card** (also `/ccstatus`, `/ccodex`, `/ccstate`, with or without the
  slash, or *CCodex status* in the `/` menu): the chat's model, effort, permission mode,
  context use, session state, and Claude and Codex plan limits. Sent while a turn runs,
  it answers at once and never reaches the model.
- **Emoji thread titles** from a small GPT model and an editable prompt; Claude chats get
  a ` ✳️` suffix.

## App controls in Claude chats

Claude chats follow the App's own controls:

| Codex App | Claude Code |
|---|---|
| *Full Access* / *Ask for approval* / *Approve for me* | permission mode `bypassPermissions` / `default` / `auto` |
| Plan mode | permission mode `plan` |
| Reasoning effort | effort (`ultra` = `max` + proactive sub-agents) |
| Fast | Claude fast mode |

## How it works

CCodex is a thin gateway in front of your installed `codex app-server`: the App starts
CCodex's `codex`, one stock app-server serves every GPT chat unchanged, and `claude:*`
chats run on the Claude Agent SDK with Claude's transcripts in `~/.claude/projects` as
their only source of truth. The only state CCodex adds is an optional
`~/.ccodex/state/meta.json` (provider-switch history, archive flags and sections of Claude
chats). Plain `codex …` commands (TUI, `exec`, `login`) run your installed Codex; `codex
mcp-server`, removed from Codex in `0.154`, is served by CCodex on top of `codex exec`.

## What setup changes

- Installs the version under `~/.ccodex/versions/` and the `codex` / `ccodex` shims in
  `~/.ccodex/bin`, which a managed block (`# >>> ccodex >>>`) puts first on `PATH` in your
  Bash, Zsh and Fish startup files.
- Links `~/.local/bin/codex` to the shim; a `codex` found there moves to
  `~/.ccodex/backups/remote-codex` and stays the Codex CCodex runs.
- macOS: sets `CODEX_CLI_PATH` for the local App (`launchctl setenv` plus a login
  LaunchAgent `dev.ccodex.codex-cli-path`), so the App starts CCodex instead of its bundled
  `codex`. The signed `.app` is never touched, so its auto-updates keep working.
- Claude Code: sets `cleanupPeriodDays: 36500` in `~/.claude/settings.json` when unset
  (Claude deletes transcripts older than 30 days by default, and with them your Claude
  chats), and installs the `codex-wrapper` agent and the `codex` MCP server (user scope).
- Never restarts a running gateway: a new version takes over after
  `codex app-server daemon restart`.

## Uninstall

Uninstall stops CCodex's gateway and undoes the `PATH`, `~/.local/bin/codex` and
`CODEX_CLI_PATH` changes; what setup added to `~/.claude` stays. If `ccodex` is gone from
`PATH`, use the release's `uninstall.sh` (`… | sh -s -- --purge` to purge):
`curl -fsSL https://github.com/gkorepanov/ccodex/releases/latest/download/uninstall.sh | sh`

## Upgrading from 0.4

Run `ccodex update` (or reinstall), then `codex app-server daemon restart`.
0.5 keeps no databases of its own; setup migrates 0.4's state once before it activates
0.5 (a failed migration activates nothing). Provider-switch history, archive flags,
sections and names carry over. Claude chats get their Claude session ids (links to 0.4
thread ids stop working), 0.4's side chats are archived, and chats whose transcripts
Claude's 30-day cleanup deleted come back as text. The 0.4 databases move to
`~/.ccodex.0.4-backup`.

## Config file

`~/.ccodex/config.toml` (every key optional; all of them are in
[`examples/config.toml`](../examples/config.toml)):

- `rename_prompt` — the title prompt; remove it for stock Codex titles (manual names
  always win). `title_model` — the model that writes them.
- `improve_models_formatting_for_codex_app` (default `true`) — adds
  [`instructions/ccodex_extra_common_instructions.md`](../instructions/ccodex_extra_common_instructions.md)
  (formulas and plots the App renders) to the App's instructions for Codex models and to
  Claude's; Claude also gets
  [`instructions/ccodex_extra_claude_instructions.md`](../instructions/ccodex_extra_claude_instructions.md)
  (what the App shows beyond a terminal).
- `log_level` — `debug`, `info` (default), `warn`, `error`.
- `codex_binary`, `delegate_codex`, `claude_binary` — use a specific `codex` or `claude`.

## Troubleshooting

- `ccodex doctor` checks Node, Codex and Claude and their logins, the prebuilt native
  relay (`@gkorepanov/ccodex-relay-*`), the gateway and the install, and says what to run.
- The gateway's log is `~/.codex/app-server-daemon/app-server.stderr.log`, rewritten at
  each gateway start; set `log_level = "debug"` for more.
- For a bug report, `rpc_capture = true` records every App message to
  `~/.ccodex/state/rpc.jsonl` (mode `0600`, capped at 1 GiB, prompts and outputs
  included). Off by default; it never leaves your disk.
- The App's built-in `/status` differs by client (Desktop may show only its OpenAI account);
  `/cc` shows the same in every client.
- A gateway restart (`codex app-server daemon restart`, an update) stops running chats; the
  App reconnects and reopens its chats, as with a stock app-server restart.
- On a Mac, the App's browser works only for processes the running App launched, so the App
  replaces a gateway started from a terminal (or by an earlier, now closed App launch) with
  its own; chats running in the old one stop.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test                  # unit and black-box gateway tests, relay tests
scripts/e2e/run.sh        # rootless podman, real models, copies of your credentials
```

## License

MIT — see [`LICENSE`](../LICENSE). Third-party licenses and notices:
[`legal/LICENSES.md`](../legal/LICENSES.md), [`legal/THIRD_PARTY_NOTICES.md`](../legal/THIRD_PARTY_NOTICES.md).
