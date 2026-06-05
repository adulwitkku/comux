# Agent selection is an availability scheduler, not a one-way fallback chain

At each step the Harness selects the most-preferred Agent that is currently available
(not in cooldown), rather than walking a one-way chain that can only descend. This
preserves the "local never-stops" value: when a higher-preference Agent's quota resets,
work bounces back up to it instead of being stuck on a weaker Agent for the rest of the job.

Failure types are handled differently rather than lumped together:

- **Quota / rate-limit** → switch immediately and mark the Agent "cooling down" (eligible
  to return after its reset window).
- **Error / stuck (watchdog)** → retry the same Agent once before switching, since a more
  capable Agent failing once may be a fluke.
- **All Agents exhausted** → the job waits (the local Orchestrator is free and never stops)
  and resumes when the top Agent recovers — it does not terminate.

## Considered Options

- **One-way fallback chain** (original PRD framing) — simpler, rejected: descends only,
  never recovers to a stronger Agent, and conflates quota with task failure.
