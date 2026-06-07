# The Harness drives Agents through the cmux CLI, not node-pty

> **Status:** the *completion-detection* mechanism below (exit sentinel + `read-screen` silence
> watchdog) is superseded by ADR-0015 (detection via cmux agent lifecycle); the sentinel survives
> only as a fallback. Driving Agents through the cmux CLI (the rest of this ADR) still stands.

The original PRD (and ADR-0001) anticipated a PTY library (`node-pty`) to launch Agents and
read their streams. In practice the running cmux already exposes every primitive M1 needs,
so the Harness shells out to the `cmux` CLI and takes **no** dependency on node-pty:

- `cmux new-split <dir> --surface <s>` — opens a visible terminal pane and returns its
  `surface_ref`.
- `cmux send` / `send-key enter` — seeds the Agent's launch command into that pane.
- `cmux read-screen --surface <s>` — samples the visible screen for the watchdog and the
  exit sentinel.
- `cmux close-surface`, and `set-status` / `log` / `notify` for surfacing Harness state in
  the cmux UI.

Completion and exit code are captured with a shell sentinel appended to the launch command
(`<cmd>; echo __CMUX_EXIT__=$?`) read back via `read-screen`. The watchdog fires on screen
*silence* (no change for N ms), not a total timeout.

Validated end-to-end against the real cmux by `bun run smoke:m1`
(`src/cmux.ts`, `src/agent-runner.ts`, `src/git.ts`).

## Deferred hardening

- `cmux pipe-pane` to stream raw output to a file (avoids the visible-screen truncation and
  prompt-animation sensitivity of `read-screen` diffing).
- `cmux hooks <agent>` for first-class Agent lifecycle events (e.g. Claude's Stop event) as a
  cleaner completion signal than a shell sentinel for long-lived interactive TUIs.
