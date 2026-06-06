# One plan approval up front, then autonomous; Agents confined to the project repo

The user approves PLAN.md once at the start, then the Harness runs the job autonomously
— stepping and committing without asking per step — to satisfy the "never-stops / 20+
step" goal. Per-step approval is rejected because it would defeat unattended long runs.
The user can interject at any time via the TUI; an interjection is applied after the
current step finishes rather than killing an Agent mid-step.

Because Agents run unattended and write files automatically, every Agent is confined to
the project git repo (its working directory is the repo and it may not write outside it).
This is a hard safety boundary, not a convenience.

## Status

- **Approve-once is not yet implemented.** M3 ships a *per-dispatch* confirm
  (`src/harness.ts`) as a temporary stand-in; the approve-once-then-autonomous behaviour
  lands with the M4 autonomous PLAN-walk. The decision above stands; only the timing differs.
- **Confinement enforcement is macOS-only today.** `src/sandbox.ts` wraps each Agent launch
  in `sandbox-exec`: reads are unrestricted, but writes are denied everywhere except the
  workspace (plus temp, `/dev`, and per-user cache/config). Setting the working directory is
  *not* the boundary on its own — the sandbox is. On non-macOS platforms there is no
  enforcement yet (only the working directory), so the "hard boundary" claim currently holds
  on darwin only; cross-platform sandboxing is tracked in ROADMAP. Opt out with
  `COMUX_NO_SANDBOX=1`.
