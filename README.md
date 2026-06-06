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

**M1–M3 are implemented and validated.** The harness has an interactive TUI: you type, a local
model routes the message, and coding tasks are dispatched to an Agent that runs visibly in a
cmux pane, with the result git-checkpointed. See [`ROADMAP.md`](./ROADMAP.md) for details.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- a running cmux (the harness shells out to the `cmux` CLI; see ADR-0007)
- [Ollama](https://ollama.com) serving `gemma4:12b-mlx` (the Orchestrator)
- an Agent CLI on PATH — currently [`pi`](https://pi.dev)

## Run the TUI

```bash
bun install
bun run start                 # workspace defaults to ./workspace
bun run start /path/to/repo   # or point it at a specific repo
```

Type a message. `/help` lists commands. Set `HARNESS_YES=1` to auto-approve dispatches.

## Smoke tests

```bash
bun run smoke:m1      # visible agent run + exit code + watchdog + checkpoint
bun run smoke:m2      # Orchestrator routing (chat -> reply, build -> task)
bun run compare:pi    # local Orchestrator vs pi (cloud) as routers
bun run try "msg"     # throw one message at the Orchestrator (add --pi to compare)
```
