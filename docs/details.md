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
chats). CCodex never deletes a chat for good: a deleted Claude chat, one emptied by an edit of
its first message, and a provider switch a revert undoes go to `~/.ccodex/state/trash/` with
their meta.json entries, until you empty it by hand; meta.json keeps a switched chat whose
transcript is gone (the chat is hidden until it is back). Plain `codex …` commands (TUI, `exec`, `login`) run your installed Codex; `codex
mcp-server`, removed from Codex in `0.154`, is served by CCodex on top of `codex exec`.

## What setup changes

- Installs the version under `~/.ccodex/versions/` and the `codex` / `ccodex` shims in
  `~/.ccodex/bin`, which a managed block (`# >>> ccodex >>>`) puts first on `PATH` in your
  Bash, Zsh and Fish startup files.
- Links `~/.local/bin/codex` to the shim; a `codex` found there moves to
  `~/.ccodex/backups/remote-codex` and stays the Codex CCodex runs.
- macOS: sets `CODEX_CLI_PATH` for the local App (`launchctl setenv` plus a login
  LaunchAgent `dev.ccodex.codex-cli-path`), so the App starts CCodex instead of its bundled
  `codex`. The signed `.app` is never touched, so its auto-updates keep working. That `codex`
  runs on the App's own Node (`Contents/Resources/cua_node`): the App gives its tools (chats'
  `codex_app` tools, Browser Use) only to processes signed as it is.
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
- `claude_visualize` (default `true`) — Claude chats get Codex's bundled Visualize skill (while it is on in Codex) and
  draw interactive visuals in the chat as GPT chats do; `false` leaves Claude's context as it is.
- `claude_idle_compaction_hold_hours` (default `24`) — how long a quiet Claude chat of 200K+ tokens keeps its Claude
  process (other chats: 30 min). About an hour quiet, Claude summarizes such a chat (idle compaction) and keeps the
  summary in the process for the next message, so the chat doesn't send its whole history again once the prompt cache
  is gone. At most 10 Claude processes run; the one quiet longest closes first.
- `rpc_limit_mb` (default `10`) — the most CCodex sends the App in one message or as one command's output (how the
  App shows a remote host's image or video): a bigger answer fails, a bigger notification is dropped, the output stops
  there. One huge message holds up every chat over SSH and can drop the phone's connection. `0` turns it off.
- `claude_app_idle_takeover` (default `false`) — the Claude App keeps a process on every chat it has opened or
  imported, idle for hours, and while it lives the chat goes through the shared-session bridge. With this on, an idle
  App process is asked to exit (SIGTERM) when CCodex is to work on its chat, which then runs here as any other; the
  App starts its process again when the chat is next used there. A busy App process, a terminal's `claude` and any
  other owner are never touched.
- `claude_permission_mode` (unset by default) — every Claude chat runs in this mode (for example
  `"bypassPermissions"`), whatever the client asks or the transcript last recorded; plan mode stays plan mode.
- `log_level` — `debug`, `info` (default), `warn`, `error`.
- `codex_binary`, `delegate_codex`, `claude_binary` — use a specific `codex` or `claude`. Without `codex_binary`, the
  gateway runs Desktop's own Codex CLI when the Desktop on this machine starts it (the one Desktop runs without
  CCodex), otherwise the newest `codex` on the machine; a plain `codex …` in a terminal runs the first one on PATH.

## Local opt-in: share an existing Claude App writer

CCodex can route input for an occupied Claude session to the Claude App process that already owns it. The single-writer guard stays in place. Unoccupied sessions still use the SDK. Retries of an already submitted message use its durable receipt, including after the original owner exits.

The feature is off unless `~/.ccodex/native-peer-bridge.json` contains an explicit configuration:

```json
{
  "enabled": true,
  "python": "/path/to/bridge/python",
  "script": "/path/to/claude-sessions/scripts/bridge.py",
  "stateDir": "/path/to/private/claude-sessions-bridge-state"
}
```

Set up a compatible local helper before enabling this feature. CCodex needs the helper to support native-only submission with an expected owner PID, durable request IDs, private socket authentication and transcript readback. CCodex rejects input before sending if the owner is missing, changed or unsupported. Use the same private helper state directory across senders to serialize submissions while a receipt is active or unresolved.

Shared input preserves real local sender attribution and the original App's receive/permission policy. It is **not invisible**: source markers and prompt content enter the original conversation and may be sent upstream by the App. No OAuth credentials are copied, no cloud inference API is reimplemented, and no model rewrites the reply in the middle.

The existing process receives input with native priority `next`: a correction joins the current task after the current tool batch completes. It does not force work into the background or interrupt a response. Stable client message IDs deduplicate retries; unknown outcomes are never automatically resent. Native history IDs and client bubble IDs are mapped across read, resume and paging. Replies and tool progress follow the original transcript as the App writes it, rather than a separate token stream.

The shared path accepts text, same-chat image uploads, and inline PNG, JPEG, GIF and WebP data up to 20 MiB per message. Inline images are stored as private files and forwarded as same-chat paths for the original Claude App to read. Model, effort, speed, plan and permission modes, workspace, history edits and stop remain with the original App. App refusal and hold policies remain effective. Let active shared work reach a known terminal state before removing live methods. Keep private receipts and ID bindings for retries and history.

For a shared App turn, `turn/steer` and another ordinary `turn/start` add corrections to that turn. Mobile `thread/queue/add` also defaults to soft steering for an externally owned App session, so a mobile client's normal send does not wait for the whole task to end. Set `softSteerDefault: false` in the sidecar to retain that queue endpoint's old behavior. Previously queued messages are not replayed or drained by this change. GPT and unowned SDK sessions retain their existing queue behavior.

Each correction gets its own stable receipt linked to the original shared job. Dispatch waits for earlier inputs to be acknowledged, preserving order even if worker scheduling differs. An unknown receipt, dead worker or changed App owner prevents another send. A turn that ends before dispatch rejects the correction without replaying it; late rejections are surfaced to the client. Native `attachment/queued_command` absorption records are correlated using their source UUIDs, and linked user bubbles stay in the same shared turn across refresh and paging.

### Receipts across automatic compaction

Compaction summaries can carry the current peer prompt ID before the preserved peer record is replayed. They must not consume that ID when projecting turn boundaries: otherwise a completed shared reply gets merged into an older turn.

The helper changes are in [`scripts/native-peer-receipts.patch`](../scripts/native-peer-receipts.patch). They require the matching `bridge.py` and `test_bridge.py` from the initial shared-session helper. The helper baseline is external to this repository. With that baseline, apply the patch in the helper's `scripts` directory and run its tests in the helper's Python environment. Receipt reconciliation follows preserved-message links and the SDK's current branch. It collects all blocks of the first correlated terminal API message and keeps the result unknown if competing input or incomplete evidence prevents attribution.

A fresh turn automatically checks the original history when an earlier native submission has an unknown result. A correlated terminal reply clears the block, including when the reply arrives after the worker deadline. Claude App input absorbed after a tool result with the same native prompt ID can share that terminal reply. The receipt records that the reply covered local input as well. Until the reply is verified, the block remains in place.

Use `bridge.py reconcile '{"job_id":"existing-job-key"}'` to check an already submitted native job and repair its durable receipt from history. Rejected inputs retain their `failed_before_send` receipts. Their original client message IDs continue to return those receipts after the block clears.

The native bridge supports Claude Desktop Code 2.1.325 and 2.1.326. When the registered App version or socket fails the native protocol preflight, CCodex receives a durable `LIVE_PROTOCOL_UNVERIFIED` rejection. Retrying that client message after a compatibility update returns the same rejection.

## Troubleshooting

- `ccodex doctor` checks Node, Codex and Claude and their logins, the prebuilt native
  relay (`@gkorepanov/ccodex-relay-*`), the gateway and the install, and says what to run. It warns when npm has a
  newer Codex: `ccodex update` updates an npm global install of Codex along with CCodex (a Desktop update can need
  a newer Codex on a host the App reaches over SSH).
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
