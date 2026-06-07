# The local Orchestrator is an optional front-door classifier, not the core

> **Status:** sharpened by ADR-0018 — the "chat vs job" branch is gone; the Orchestrator is now a
> pure capability classifier (every message dispatches). The "optional, not the core" thesis holds
> more strongly than before.

The conductor of a job is **deterministic local code** (the Harness loop that walks PLAN.md,
runs each Step's Acceptance check, and checkpoints) — not the local LLM. Once the autonomous
PLAN-walk exists, the Orchestrator's only remaining job is a front-door classification of the
*first* message: chat-vs-job. That is a thin enough task that it can be served by a heuristic,
making **Ollama + the 12B model an optional dependency rather than a hard requirement**.

This **supersedes the framing of ADR-0003**, which placed the stateless local Orchestrator at
the centre of the design. The substance of ADR-0003 still holds (no compaction subsystem;
state lives in PLAN.md + git); what changes is that "local-first" no longer depends on a local
LLM. The value of "local" was never the 12B model — it is that the orchestration loop is free
local code that can babysit a 20+ step overnight run without burning tokens or quota.

The trade-off: keeping the 12B model as a hard requirement bought a "local-first brain"
identity at the cost of the single heaviest install barrier (install Ollama, pull a 12B model,
have the RAM/GPU to run it) — paid for what is now a one-line classifier. We chose lower
adoption friction and a deterministic conductor over the local-LLM-as-brain identity.

## Considered Options

- **Keep the 12B model as a hard requirement** (original framing) — rejected: large install
  barrier for an open-source project, in exchange for a classification a heuristic can do.
- **Cut the model entirely / always-dispatch** — rejected for now: the local classifier is a
  genuinely nice default and preserves the option of a richer local front-door later; making
  it *optional* keeps that door open without taxing every install.
