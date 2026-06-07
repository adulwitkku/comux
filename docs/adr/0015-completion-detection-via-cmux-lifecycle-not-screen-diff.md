# Completion is detected from cmux's agent lifecycle, not screen-diff + exit sentinel

The M1 completion signal (`<cmd>; echo __CMUX_EXIT__=$?` read back via `read-screen`, plus a
silence watchdog — ADR-0007) only works for Agents that **exit** when their work is done. But
ADR-0012 requires every Agent to run as its **real interactive TUI**, and an interactive TUI
does not exit when it finishes a turn — it sits at its prompt. So the sentinel never prints, the
screen goes quiet, the watchdog fires on silence, and a healthy Agent that just finished is
mis-reported as "stuck" and handed over. This is the main cause of comux feeling like it "can't
tell when a job is done." ADR-0007 and ADR-0012 are in direct conflict on this point.

We resolve it by reading completion from the signal cmux already maintains. `cmux hooks setup`
installs per-Agent lifecycle hooks; cmux then tracks each Agent's `agentLifecycle` as one of
`running` / `idle` / `needsInput` (stored per session/surface, also published on the
`cmux events` Feed/agent stream). The Harness keys off that:

- **`idle`** — the Agent finished its turn (the hard case the sentinel missed). The Harness then
  runs the Step's frozen **Acceptance check** (ADR-0009): green ⇒ Step done; red ⇒ the Agent
  stopped without satisfying the Step.
- **`needsInput`** — the Agent is blocked on a decision; handled by Grilling / Bypass mode
  (ADR-0016), **not** treated as completion.
- **process exit / sentinel** — a real crash or a headless Agent finishing; kept as the
  fallback signal.

Lifecycle tells us the Agent *stopped working*; the Acceptance check tells us the work is
*actually correct*. This keeps "deterministic code decides done, not the model" (ADR-0009) while
honouring both visibility (ADR-0012) and out-of-band detection (ADR-0001).

## Considered Options

- **Keep sentinel; make Agents headless (`-p`)** — restores a clean exit but contradicts ADR-0012
  and re-hides live progress (the very drift ADR-0012 reverted).
- **Idle-prompt regex via `read-screen`** — detect each Agent returning to its prompt. Rejected:
  per-Agent fragile pattern maintenance, exactly the screen-diff brittleness ADR-0007 flagged.
- **Acceptance-check polling as the sole signal** — poll the check, ignore lifecycle. Rejected as
  *sole* signal: plan dispatch / `web_search` / `image` have no check, and it gives no way to
  distinguish `idle` (done) from `needsInput` (blocked).

## Consequences

- **`cmux hooks` becomes a runtime requirement.** `/setup` runs `cmux hooks setup` for each
  installed Agent; Agents whose binary supports no hook fall back to the sentinel/headless path.
- Feed-bearing detail differs by Agent (see ADR-0016 / cmux's Feed matrix): `claude` is
  wrapper-injected, several Agents bridge permissions, `pi`/`omp`/`rovo` report lifecycle only.
- The silence watchdog stays, but as a backstop against a truly hung Agent that never reaches
  `idle` and never makes the check pass — not as the primary completion signal.
- Supersedes the screen-diff/sentinel completion path of ADR-0007 (which itself listed
  `cmux hooks` as deferred hardening); the sentinel survives only as fallback.
