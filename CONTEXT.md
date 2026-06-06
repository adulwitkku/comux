# cmux-Native AI Orchestrator Harness

A local-first system that runs inside cmux. A small local model parses user intent
into structured task specs; deterministic code then routes those tasks to capable
external coding agents and renders their artifacts in a cmux browser surface.

## Language

**Harness**:
The whole local-first system: the deterministic plumbing plus the local model plus
the artifacts view. The thing the user runs.

**Orchestrator**:
The small local model (gemma4:12b-mlx via Ollama). Its sole job is to turn natural-language
user input into a structured task spec. It does NOT make routing, fallback, or
compaction decisions — those are deterministic code.
_Avoid_: Brain (overstates its role — it does not plan autonomously)

**Agent**:
An external, more-capable coding CLI that does the actual work. The "hands" of the system.
Currently the only implemented Agent is `pi`; Claude Code, Codex, Cursor, and Antigravity
are roadmap targets for the multi-Agent Scheduler (M4), not yet wired in.
_Avoid_: Worker, CLI

**Task spec**:
The minimal structured output of the Orchestrator: one JSON object `{reply, task}` with
exactly one field set — `reply` (the Orchestrator answers the user directly) or `task` (a
natural-language instruction to dispatch). It names WHAT to do, never WHO does it — the
Scheduler picks the Agent. The only artifact the Orchestrator is responsible for producing.

**Handover**:
The transfer of an in-progress job from a failed/exhausted Agent to the next Agent in
the chain. Resumes from the last Git checkpoint; the incoming Agent reads the repo and
PLAN.md rather than being briefed from the Orchestrator's memory.

**Checkpoint**:
A Git commit made by the Harness after a successful step. The unit of safe resume and
revert.

**PLAN.md**:
The shared plan and progress for the current job, kept as a checklist. The human-readable
source of "what's done / what remains" that any Agent can read.

**Agent chain**:
The intended preference order of Agents (Claude Code → Codex → Antigravity → Cursor,
best-preferred first). It is a preference ranking for the Scheduler, NOT a one-way descent.
This is the M4 design target; today the registry holds a single Agent (`pi`).

**Scheduler**:
The deterministic logic that picks, at each step, the most-preferred Agent not currently in
Cooldown. Bounces back up to a stronger Agent when it recovers.

**Cooldown**:
A temporary "unavailable" mark on an Agent that hit a quota/rate-limit, with a reset window
after which it becomes selectable again.

