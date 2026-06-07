# Orchestrated Agents run unconfined — the write-confinement sandbox is dropped

ADR-0005 made each Agent write-confined to its repo via `sandbox-exec` (reads free, writes denied
outside the workspace) and called it a "hard safety boundary." Two later decisions hollowed that
boundary out: ADR-0016 made Bypass mode default-on (zero human gates), and Phase 3 has Agents
drive cmux directly (open browsers, manage their own surfaces) — and the sandbox never covered
cmux anyway (it denies file writes, not process spawning or the cmux Unix socket; an Agent could
already `cmux send` into any surface). With the gate gone and cmux wide open, a write-only sandbox
guards a side door while the front door stands open.

We accept full trust for the orchestrated flow and **drop the confinement**: Agents run unconfined,
exactly as Broadcast mode already does (ADR-0014). comux is a local, single-user tool the user runs
on their own machine against their own repos; the user has chosen end-to-end autonomy (ADR-0016),
and a partial sandbox bought safety theatre, not safety. The one remaining automatic guard on a
job is the frozen **Acceptance check** (ADR-0009), plus Git checkpoints for revert (ADR-0002).

## Considered Options

- **Keep the sandbox, scope a cmux shim** — let Agents drive only browser/markdown through a
  restricted shim, keep write-confinement. Rejected: it re-confines writes while leaving the
  larger cmux/network channels open, and the user opted for full autonomy without per-action gates.
- **Harden the sandbox to also cover cmux/network** — make confinement real. Rejected for this
  cut: heavy, platform-specific, and against the stated direction (unattended, hands-off).
- **Keep ADR-0005 as-is** — rejected: it is already contradicted by ADR-0016 and Phase 3, so
  leaving it on the books misleads future readers about the actual safety posture.

## Consequences

- Reverses the confinement half of ADR-0005 (the approve-once half was already superseded by
  ADR-0016). `confine()` / `sandbox-exec` and `COMUX_NO_SANDBOX` become moot for the orchestrated
  flow; the safety story is now "trusted Agents + frozen Acceptance check + Git checkpoints."
- An Agent can write anywhere the user can and drive the user's whole cmux (other surfaces,
  windows, browsers). This is intended, not a leak — but it raises the stakes on plan/check quality
  (ADR-0009) and on Git being a real source of truth for revert (ADR-0002).
- Git checkpointing matters more, not less: it is now the primary "undo" if an unconfined,
  un-gated run goes wrong.
