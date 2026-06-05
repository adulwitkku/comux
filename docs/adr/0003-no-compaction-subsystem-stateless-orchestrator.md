# No context-compaction subsystem; the Orchestrator is stateless per turn

The "infinite workflow" requirement (20+ steps without hitting context limits) is met
structurally rather than with a dedicated compaction system. We deliberately do NOT build
a token counter, auto-summariser, STATE.json, or context-reset loop.

The Orchestrator (gemma4:12b, 256K context) holds no growing chat history. Each turn is
`system prompt (role + current PLAN.md + recent git log) + the new user message`, so its
context is bounded by construction. The Agents manage their own context internally, and a
Handover already acts as the real "context reset" (a fresh Agent reads the repo + PLAN.md).
A separate STATE.json would duplicate PLAN.md + git, so it is not created.

A future reader expecting a compaction subsystem (implied by the "infinite workflow"
objective) should find none here — that is intentional.
