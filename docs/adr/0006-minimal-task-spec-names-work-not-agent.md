# The task spec is minimal and names the work, not the Agent

The Orchestrator's output is a deliberately minimal two-field JSON object —
`{reply, task}` with exactly one field set — in the spirit of pi.dev's "primitives, not
features". `reply` means the Orchestrator answers the user directly; `task` is a
natural-language instruction to dispatch.

We removed the `target_agent` field from the original PRD spec
(`{thought, target_agent, command_string}`) because choosing the Agent is the Scheduler's
job (ADR-0004). If the Orchestrator named an Agent, it would conflict with availability and
cooldown (e.g. it asks for Claude while Claude is cooling down). The Harness attaches the
current PLAN.md step from its own walk, so no `plan_step` field is needed. A `thought`
field is optional and for logging only.

The open sub-question of *how* to force `gemma4:12b` to always emit valid JSON (structured
output / grammar-constrained decoding) is deferred to implementation.
