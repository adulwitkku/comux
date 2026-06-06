# A Step is "done" when its frozen Acceptance check passes — not on exit-0 or self-report

A job is an ordered list of Steps (PLAN.md checklist items). A Step is marked done — ticked,
checkpointed, and eligible for the next Step — **only when a deterministic, machine-runnable
Acceptance check passes** (e.g. `bun run typecheck`, a unit test, a `grep`). The check is
authored at plan time, by the **Plan dispatch**, and **frozen** before any implementation
dispatch touches the Step.

This exists because the autonomous PLAN-walk needs a notion of "done" that holds up when the
run is unattended and Agents are swapped. The two obvious cheaper signals both fail:

- **Process exit code 0** (the M1 sentinel) proves the Agent's process *finished*, not that
  the work is *correct*. An Agent can exit 0 having done nothing, done it wrong, or done half.
- **The Agent ticks its own checklist item** lets the worker grade its own homework, and a
  Handover would then have the incoming Agent trust the outgoing Agent's unverified claim.

Freezing the check at plan time (before implementation) is the load-bearing part: if the
implementing Agent authored its own check it would write a trivially-passing one (`echo ok`).
A frozen, Agent-independent check is what makes Handover safe — the incoming Agent must
satisfy the *same* check — and it gives "Step size" a natural definition: as small as you can
write a check for. This keeps "deterministic code decides, not the model" (ADR-0003 spirit)
intact for the one judgement that matters most: whether a Step actually succeeded.

## Consequences

- PLAN.md gains a per-Step acceptance check; the Plan dispatch must produce runnable checks,
  not just prose items. Plan quality now includes check quality.
- Steps without a meaningful machine-checkable outcome (pure design/exploration) don't fit
  this model cleanly and need a deliberate escape hatch (e.g. a human-confirmed check).
