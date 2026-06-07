# Continuous grilling via cmux Feed, with Bypass mode default-on, supersedes the approve-once gate

ADR-0005 gave the user exactly one interaction with a job: approve PLAN.md up front, then the
Agent runs autonomously. In practice that single gate is both too much (it blocks unattended
runs at the start) and too little (it gives the user no say in decisions the Agent hits
*during* the walk). cmux's **Feed** already models the three Agent decisions that need an answer
— a **permission request**, a **plan-is-ready** decision (ExitPlanMode), and a multiple-choice
**question** (AskUserQuestion) — delivering them on the `cmux events` stream and parking the
Agent on a semaphore (~120s) until something replies via `feed.permission.reply` /
`feed.exit_plan.reply` / `feed.question.reply`.

We adopt **Grilling** as the interaction model: an Agent surfaces decisions as it works, and
each decision is answered by the Harness or the human. Plan approval is no longer a special gate
— it is simply the plan-is-ready Feed decision. Answering is governed by **Bypass mode**:

- **Bypass ON (default)** — the Harness auto-answers *every* decision: permission → allow,
  plan-is-ready → proceed, question → its recommended option. A job runs end-to-end with **zero
  human gates**.
- **Bypass OFF** — the Harness still auto-answers any decision that carries a recommended option,
  and escalates **only** a decision with no recommendation to the human (who answers in the pane).

This deliberately trades ADR-0005's "approve once" safety gate for full default autonomy. Two
boundaries hold the line in its place: Agents remain **write-confined to their repo** (the
sandbox half of ADR-0005, now the primary safety boundary), and "done" is still decided by the
**frozen Acceptance check** (ADR-0009), never by an answered question. Grilling resolves
*choices*; it never declares a Step done.

## Considered Options

- **Keep the single approve-once gate; only auto-reply mid-run Feed items** — preserves ADR-0005,
  never tears down the gate. Rejected by choice: the goal is default hands-off autonomy, and a
  mandatory up-front gate defeats unattended runs.
- **Bypass scoped to permission/question only, leaving plan-approval as a human gate** — a softer
  middle ground. Rejected: the user wants zero gates by default; a half-gate is the worst of both
  (still blocks, still surprises).
- **Free-form chat interjection instead of structured Feed** — rejected: contradicts the
  stateless, structured-decision design (ADR-0003) and has no machine-answerable shape.

## Consequences

- Supersedes the "approve once, then autonomous" gate of ADR-0005; the write-confinement half of
  ADR-0005 is unchanged and load-bearing.
- "Recommended option" is a convention of the question payload (recommended option first / tagged
  in its label), so Bypass-OFF auto-pick is a heuristic over that convention, not a guaranteed
  structured field.
- Grilling richness is Agent-dependent: `claude` can emit full multiple-choice questions; several
  Agents surface only permission requests. comux gets graceful degradation, not uniform grilling.
- Default-on Bypass means a misclassified or poorly-specified job can run to completion with no
  human checkpoint; the Acceptance check is the only remaining automatic guard, raising the bar on
  plan/check quality (ADR-0009).
