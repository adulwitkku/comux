# Broadcast mode (`comux all`) runs agents unconfined, outside the orchestration core

`comux all` is a manual fan-out (the **Broadcast** in CONTEXT.md): it opens every **installed**
registry Agent as its bare interactive TUI side-by-side and sends the same text to all of them
at once, for the human to drive and compare. It deliberately bypasses the entire orchestration
core — no Orchestrator intent parse, no Capability/chain/Scheduler, no PLAN/Step/Acceptance
check, no Checkpoint — and runs the Agents **unconfined in a shared cwd** (the shell's `$PWD`,
your real project), so the `sandbox-exec` confinement of ADR-0005 does **not** apply.

This directly tensions with ADR-0005, which calls the sandbox "the real write boundary" and
confines every Agent to `./workspace`. Broadcast opts out by design: it is an advisory/compare
playground (ask all Agents the same question, read their answers), not autonomous orchestration.
When Agents are pointed at a write task they may clobber each other's files in the shared cwd —
that is the human's responsibility, the price of a zero-ceremony "ask everyone" mode.

## Considered Options

- **Fold into the orchestrator** (a new Capability or routing target) — rejected: strains the
  "one Capability → one chain → one Agent" model (ADR-0011); Broadcast is the opposite of routing.
- **Confine each Agent to a shared `./workspace`** (keep ADR-0005) — rejected for this cut: the
  sandbox blocks the advisory use of running against your actual project, and 6 Agents still stomp
  each other inside the one repo, so it adds friction without solving collisions.
- **Per-Agent git worktree** (isolate parallel implementation attempts) — rejected as scope: real
  isolation for "let all 6 implement it, pick the best" needs worktree management, artifact
  collection, and a comparison story. Worth revisiting if Broadcast grows from advisory to
  parallel-implementation.
- **Keep it in `ai.py`** — rejected: the user wants this under the `comux` entrypoint; porting it
  in lets it reuse the Agent registry and `/setup` install detection.

## Consequences / open

- A second product surface with a different safety posture lives next to the confined autonomous
  flow. Keep the boundary obvious in code and docs so the two are not confused.
- Broadcast needs registry additions orthogonal to `buildCommand`: a **bare interactive launch**
  per Agent (no task seed, no exit sentinel, no `confine`) plus per-Agent paste mode
  (bracketed / buffer / typed) and submit/newline keys, ported from `ai.py`.
- It persists a per-cmux-workspace state file mapping Agent → surface so a later `comux all "text"`
  can find the panes opened by an earlier `comux all`.
- `all` becomes a reserved first-arg token in the `comux` entrypoint (intercepted before the
  "non-flag arg = workspace, launch TUI" path); a workspace literally named `all` needs a path form.
- Layout is a rough grid built from repeated `newSplit` (columns → rows) to stay within the thin
  `cmux.ts` wrapper — not the pixel-precise `rpc workspace.create` grid `ai.py` builds.
