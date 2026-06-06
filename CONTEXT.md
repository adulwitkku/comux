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
compaction decisions — those are deterministic code. It is an **optional front-door
classifier** (chat vs job), not the conductor: the autonomous run is driven by deterministic
local code (the Harness), so the Orchestrator can be swapped for a heuristic and Ollama made
an optional dependency.
_Avoid_: Brain (overstates its role — it does not plan autonomously); Conductor (the
deterministic Harness loop is the conductor, not the model)

**Agent**:
An external, more-capable coding CLI that does the actual work. The "hands" of the system.
Two Agents are wired in — `pi` and Claude Code (`claude`) — and were used together to validate
Handover; Codex, Cursor, and Antigravity remain roadmap targets. The Scheduler that picks
between them per Step is still M4.
_Avoid_: Worker, CLI

**Task spec**:
The minimal structured output of the Orchestrator: one JSON object `{reply, task, capability}`
where `reply` and `task` are mutually exclusive — `reply` (the Orchestrator answers the user
directly) or `task` (a natural-language instruction to dispatch, tagged with a Capability). It
names WHAT to do, never WHO does it — config + the Scheduler pick the Agent. The only artifact
the Orchestrator is responsible for producing.

**Capability**:
The kind of work a dispatched task is — `web_search`, `image`, or `coding` (a chat reply has
none). The Orchestrator classifies the message into a Capability; deterministic config maps each
Capability to its own Agent chain. It is a classification of the work, never an Agent name
(ADR-0011).

**Handover**:
The transfer of an in-progress job from a failed/exhausted Agent to the next Agent in
the chain. Resumes the failed Step from the last Git checkpoint; the incoming Agent reads
the repo and PLAN.md and must satisfy that Step's frozen Acceptance check, rather than being
briefed from the Orchestrator's memory.

**Checkpoint**:
A Git commit made by the Harness after a successful step. The unit of safe resume and
revert.

**PLAN.md**:
The shared plan and progress for the current job, kept as a checklist of Steps. The
human-readable source of "what's done / what remains" that any Agent can read.

**Step**:
The unit of work — and the unit of Handover. One PLAN.md checklist item paired with its
Acceptance check. A job is an ordered list of Steps; the Harness walks them one at a time,
dispatching each to an Agent. A Step's size is "as small as you can write a check for".

**Acceptance check**:
A deterministic, machine-runnable test attached to a Step (e.g. `bun run typecheck`, a unit
test, a `grep`). A Step is "done" only when its check passes — not when the Agent's process
exits 0 and not on the Agent's own say-so. It is authored at plan time and **frozen** before
implementation (so the implementing Agent cannot grade its own homework), and it is
Agent-independent, which is what makes Handover safe: the incoming Agent must satisfy the
same frozen check.

**Plan dispatch**:
The first dispatch of a job, where a capable Agent decomposes the request into Steps — each
with its frozen Acceptance check — and writes PLAN.md. Distinct from the implementation
dispatches that follow. Authoring the plan is the Agent's job, never the Orchestrator's
(it names work, not plans — see Task spec).

**Agent chain**:
The ordered preference of Agents for one Capability (best-preferred first), e.g. coding is
`cursor → codex → claude → agy → opencode → pi`. There is one chain **per Capability**, kept in
the user's config and editable by hand. It is a preference ranking for the Scheduler, NOT a
one-way descent (ADR-0011).

**Scheduler**:
The deterministic logic that, for a given Capability's chain, runs the most-preferred Agent that
is still available and falls to the next when one is unavailable. The intended end state bounces
back up to a stronger Agent when its Cooldown resets; today a fallen-over Agent is skipped for the
rest of the job (timed Cooldown is the open M4 work).

**Cooldown**:
A temporary "unavailable" mark on an Agent that hit a quota/rate-limit, with a reset window
after which it becomes selectable again.

