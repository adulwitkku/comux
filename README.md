# cmux-orchestrator-harness

A local-first AI orchestrator harness that runs inside [cmux](https://cmux.com). A small
local model (the Orchestrator, `gemma4:12b` via Ollama) turns natural-language intent into a
minimal task spec; deterministic code routes that task to a capable external coding Agent
(Claude Code, Codex, …), runs it **visibly** in a cmux pane, checkpoints progress in git, and
falls over to the next available Agent when one is rate-limited.

## Docs

- [`ROADMAP.md`](./ROADMAP.md) — milestones and what's done
- [`CONTEXT.md`](./CONTEXT.md) — glossary (read this first)
- [`docs/adr/`](./docs/adr) — the design decisions and why
- [`prd.md`](./prd.md) — original product brief (kept for history)

## Status

**M1 (the make-or-break spike) is implemented and validated.** The harness can launch an
Agent in a visible cmux pane, detect completion + exit code, run a silence watchdog, and
git-checkpoint the result — all proven against the real cmux.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- a running cmux (the harness shells out to the `cmux` CLI; see ADR-0007)

## Run the M1 smoke test

```bash
bun install
bun run smoke:m1
```

It spins up a fake Agent (a plain shell command) in a cmux pane inside a throwaway git repo,
and checks completion/exit-code capture, git checkpointing, and stuck-detection.
