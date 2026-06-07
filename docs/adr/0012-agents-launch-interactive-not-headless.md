# Agents launch as interactive TUIs, not headless `-p` invocations

Every Agent in the registry launches as its **real interactive TUI** inside a cmux pane
(ADR-0001). The M1–M4 registry used headless flags (`-p`, `exec`, `run`) for faster,
cleaner exit-code capture; that drift hid live progress from the user — especially visible
on `web_search`, where a short shell burst and an English one-liner were mistaken for "the
agent never ran."

We restore ADR-0001 in code: drop headless launch flags from `src/agents.ts`. The Harness
still seeds the English `task` via the launch argument and still detects completion
out-of-band (exit sentinel, watchdog, tested quota sentinels) — the visible screen is never
the control signal.

Dispatched `task` strings remain **English** instructions rephrased from the user's intent
(ADR-0006). `web_search` and `image` run **without** a human confirm gate; only a coding
PLAN-walk uses a separate plan-approval step (ADR-0005).

## Considered Options

- **Keep headless `-p` for coding/planning only** — faster, rejected for this cut: one launch
  model for all Agents is simpler to reason about and matches the product promise of watching
  every dispatch.
- **Headless everywhere** — rejected: contradicts ADR-0001 and the observed `web_search`
  confusion (pane shows a blink-and-done shell, not the Agent working).
- **Interactive for `web_search` / `image` only** — reasonable middle ground, rejected here in
  favour of consistency: if visibility matters for search, it matters for coding too.

## Consequences / open

- Interactive TUIs may animate prompts and produce noisier `read-screen` diffs (ADR-0007); the
  watchdog still keys off *any* screen change.
- Per-Agent launch shapes need a quick spike (`agy`, `claude`, `pi`, `cursor-agent`, `codex`,
  `opencode`) to confirm the non-`-p` invocation that accepts an initial task argument.
- Permission-bypass flags (`--dangerously-skip-permissions`, `--force`, sandbox bypass) stay:
  macOS `sandbox-exec` confinement (ADR-0005) is the real write boundary.
