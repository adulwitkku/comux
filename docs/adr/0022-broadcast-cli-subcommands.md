# Broadcast CLI uses pi-style subcommands

`comux all` used positional text and action flags (`--new`, `--update`, `--close`). Any bare word
after `all` was broadcast text — so `comux all update` sent the string "update" to every agent
instead of running **Broadcast update**. We switched to subcommand-first syntax (like `pi update`):
`comux all` opens or reuses the grid without sending text; `comux all send "<text>"` broadcasts;
`comux all new`, `comux all update`, and `comux all close` are separate subcommands. Old flag and
positional syntax is rejected with hints (hard break). The `--cwd` override is removed — all agent
panes share `$COMUX_WORKSPACE` or the caller's current directory. TUI slash commands are unchanged;
`/help` and `comux --help` cross-reference each other, with nested `comux all --help` for subcommand
detail.

## Considered Options

- **Keep flags + positional text** — rejected: the footgun is inherent; only `--update` is safe.
- **Smart redirect** (treat unknown positional as `send`) — rejected: still ambiguous for words
  that look like subcommands.
- **Deprecation period for old syntax** — rejected: pre-1.0 and the old form is actively harmful.
- **TUI slash commands for broadcast** (`/all send`) — deferred: help cross-reference only for
  now; broadcast from the TUI is a different mode from Orchestrator chat and can be added later.

## Consequences

- `parseBroadcastArgs` becomes subcommand dispatch; smoke-broadcast tests rewrite accordingly.
- `BroadcastArgs.cwd` and `--cwd` parsing are removed from the broadcast CLI surface.
- `comux update` (Harness self-update) stays distinct from `comux all update` (agent CLIs).
