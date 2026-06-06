# Per-capability Agent chains; the Orchestrator classifies the work into a Capability

The Orchestrator now emits a **Capability** alongside the dispatched task — one of `web_search`,
`image`, or `coding` (a chat reply has none). Deterministic config (`~/.config/comux/config.json`)
maps each kind of work to its own ordered **chain** of Agents, and the Scheduler walks that chain:
the most-preferred installed Agent runs, and the next one takes over when it falls over.

This extends two earlier decisions rather than overturning them:

- **ADR-0006 (names work, not who).** Still holds: the model picks the *Capability* (what kind of
  work), never the Agent. The chain (config) and the Scheduler pick *who*. Capability is a coarse
  classification of the work, not an Agent name. The task spec gains a `capability` field,
  non-null iff `task` is.
- **ADR-0004 (availability scheduler).** The preference order is now **per Capability**, not one
  global chain. A coding job runs the PLAN-walk using the `planning` chain for the plan dispatch
  and the `coding` chain for each Step; `web_search` / `image` are single dispatches down their
  own chains.

The reason is that different work suits different tools: image generation, web search, planning,
and coding each have a different best-first ordering of CLIs. A single global chain would force one
ordering on all of them.

## Considered Options

- **One global preference chain** (the original ROADMAP framing) — simpler, rejected: it cannot
  say "use `codex` first for images but `cursor` first for code".
- **Let the Orchestrator name the Agent** — rejected: conflicts with ADR-0006 and with availability
  (it would ask for an Agent that is cooling down). The model names the Capability; config and the
  Scheduler resolve the Agent.

## Consequences / open

- The 12B Orchestrator must now classify into a Capability; it defaults to `coding` when unsure.
- Config is the user's to edit (reorder chains); `/setup` writes the defaults and detects which
  CLIs are installed.
- Fallback is by chain only. A **timed Cooldown** and **quota-vs-error** detection (so a rate-limit
  bounces back when it resets, distinct from an ordinary failure) remain the open M4 work; today a
  fallen-over Agent is simply skipped for the rest of the job.
