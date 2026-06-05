# One plan approval up front, then autonomous; Agents confined to the project repo

The user approves PLAN.md once at the start, then the Harness runs the job autonomously
— stepping and committing without asking per step — to satisfy the "never-stops / 20+
step" goal. Per-step approval is rejected because it would defeat unattended long runs.
The user can interject at any time via the TUI; an interjection is applied after the
current step finishes rather than killing an Agent mid-step.

Because Agents run unattended and write files automatically, every Agent is confined to
the project git repo (its working directory is the repo and it may not write outside it).
This is a hard safety boundary, not a convenience.
