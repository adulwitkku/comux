# Broadcast uses a configurable roster with per-slot models

`comux all` no longer fans out to every **installed** registry Agent. It opens each **enabled**
slot in the user's **Broadcast roster** — a ten-slot default with per-slot models — and skips
slots whose CLI binary is not on PATH (with a warning). The roster lives in
`broadcast.roster` inside `~/.config/comux/config.json` and is edited via `/broadcast` in the
TUI (`enabled` toggle + `displayName` edit). Capability chains are unaffected.

## Considered Options

- **Keep "every installed Agent" discovery** — rejected: cannot express five opencode slots on
  different models, and the compare playground needs a stable, human-chosen lineup.
- **Hardcode the ten slots in source only** — rejected: the user wants to toggle slots on/off
  without editing JSON by hand.
- **Fold roster into capability chains** — rejected: Broadcast deliberately bypasses routing
  (ADR-0014); chains name Agents for autonomous dispatch, not bare TUI compare panes.

## Consequences

- Broadcast state files key **slot id → surface** (not registry agent name) and store a
  **roster hash** so the grid rebuilds automatically when the roster changes.
- Multiple slots may share one binary (five `opencode` entries); paste/submit profiles are looked
  up by binary from the existing Agent registry.
- `/setup` resets capability chains but **preserves** the broadcast roster.
