# Git checkpoints are the source of truth for handover, not the model's memory

When one agent fails and another takes over, the handover must not depend on the
Orchestrator (gemma4:12b) remembering project state — a small model summarising the
whole project is exactly the operation it is worst at. Instead the on-disk repo is the
source of truth: the harness `git commit`s after each successful step, so a handover
always resumes from the last known-good commit and a botched takeover can be diffed and
reverted.

The shared plan and progress live in `PLAN.md` (a checklist). The handover brief is
assembled from facts (PLAN.md + git log: "continue from step N, read files before
editing"), not from the Orchestrator's recollection. The incoming agent — far more
capable than the Orchestrator — reads the repo and PLAN.md itself.

## Consequences

- The agents' working directory must be a git repo the harness controls.
- Auto-committing per step is deliberate; commit history will be machine-generated and noisy.
