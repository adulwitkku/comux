# Workspace is the caller's directory — no isolated subdirectory

ADR-0017 dropped the write-confinement sandbox. With confinement gone, the separate `./workspace/`
subdirectory lost its sole justification (it was the confined repo Agents could only write inside).
Forcing Agents into a subdirectory added friction without safety benefit — they already ran
unconfined and wrote wherever they pleased. We adopt `process.cwd()` as the default workspace,
still overridable via `COMUX_WORKSPACE`.

Agent Checkpoint commits now land directly in the project's own git history. Harness session files
(chat responses, report summaries, search artifacts) live in a `.comux/` directory that comux
auto-adds to `.gitignore` so they don't pollute history. PLAN.md stays at the project root — it is
a shared contract between Agents, not internal harness state.

## Considered Options

- **Keep `./workspace/`** — rejected: pointless overhead now that confinement is gone. The old
  isolation was the point; without it the subdirectory just meant Agents worked on a repo the user
  never looked at.

## Consequences

- Checkpoint commits are interleaved with the user's own commits. This is intentional — git is the
  source of truth for Handover (ADR-0002) and the primary undo for an unconfined run (ADR-0017).
- `COMUX_WORKSPACE` becomes "work on this project directory" rather than "work in this subdirectory."
- Projects that used comux before this change will have an unused `./workspace/` directory. Safe to
  delete.
- Git identity (`user.email` / `user.name`) is set as a local fallback only when the repo has none,
  so checkpoint commits use the user's own identity rather than `harness@local`.
