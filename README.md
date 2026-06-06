# comux

**A local-first AI orchestrator that runs coding agents visibly inside [cmux](https://cmux.com).**

You type intent in plain language. A small *local* model (the **Orchestrator**, `gemma4:12b`
via [Ollama](https://ollama.com)) turns it into a minimal task spec. Deterministic code then
routes coding work to a capable external **Agent** (Claude Code, Codex, `pi`, …), runs it
**visibly** in a cmux pane so you can watch it work, checkpoints progress in git, and — soon —
falls over to the next available Agent when one is rate-limited.

> comux is the orchestrator *for* cmux: it drives cmux panes to do the work, with a local
> brain deciding what to run and deterministic code deciding who runs it.

## Why

- **Local-first.** The router is a 12B model on your machine — no cloud round-trip to decide
  what to do. Routing quality is on par with a strong cloud model (see `compare:pi`).
- **Nothing is hidden.** Agents run in real, visible cmux panes — you see exactly what each
  one is doing, not a headless black box.
- **Git is the memory.** Every successful step is a checkpoint; handover resumes from the last
  good commit.

## Install

### Homebrew (recommended)

```bash
brew install adulwitkku/tap/comux
```

### From source

```bash
git clone https://github.com/adulwitkku/comux
cd comux
bun install        # dev deps only — comux has no runtime npm dependencies
bun run start
```

## Requirements

comux orchestrates other tools; it needs them present at runtime:

- [Bun](https://bun.sh) ≥ 1.3 (the runtime; Homebrew pulls it in automatically)
- a running [cmux](https://cmux.com) (comux shells out to the `cmux` CLI — see ADR-0007)
- [Ollama](https://ollama.com) serving the Orchestrator model:
  `ollama pull gemma4:12b-mlx`
- an Agent CLI on `PATH` — currently [`pi`](https://pi.dev)

## Usage

```bash
comux                  # workspace defaults to ./workspace under the current dir
comux /path/to/repo    # use a specific repo as the workspace
comux --help
```

In the TUI: **type to chat** · `/` commands · `@` file mentions · ↑↓ select · ⏎ run ·
ctrl+c to exit. Coding requests are dispatched to an Agent in a new pane and git-checkpointed.

| Env | Default | Purpose |
| --- | --- | --- |
| `COMUX_WORKSPACE` | `./workspace` | default workspace directory |
| `COMUX_MODEL` | `gemma4:12b-mlx` | Ollama model for the Orchestrator |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `COMUX_YES` | – | auto-approve dispatches (non-interactive runs) |
| `COMUX_NO_SANDBOX` | – | disable the macOS write-confinement sandbox (ADR-0005) |

## Status

**M1–M3 are implemented and validated**: interactive TUI → local routing → visible Agent run
→ git checkpoint. **M3.5** (autonomous, check-verified PLAN-walk with a single Agent: plan →
approve once → walk, gating each step on a frozen acceptance check) is implemented and
validated end-to-end against a live cmux + Ollama + `pi` (its deterministic core is also
covered by `smoke:m3`). Proving Handover quality with a second Agent, then the Scheduler (M4),
comes next. See [`ROADMAP.md`](./ROADMAP.md).

## Docs

- [`ROADMAP.md`](./ROADMAP.md) — milestones and what's done
- [`CONTEXT.md`](./CONTEXT.md) — glossary (read this first)
- [`docs/adr/`](./docs/adr) — the design decisions and *why*
- [`docs/prd.md`](./docs/prd.md) — original product brief (kept for history)
- [`CONTRIBUTING.md`](./CONTRIBUTING.md)

## Development

```bash
bun run typecheck     # tsc --noEmit (strict)
bun run smoke:m1      # visible agent run + exit code + watchdog + checkpoint
bun run smoke:m2      # Orchestrator routing (chat -> reply, build -> task)
bun run smoke:m3      # PLAN.md parse/tick + acceptance-check runner (offline)
bun run compare:pi    # local Orchestrator vs pi (cloud) as routers
bun run try "msg"     # throw one message at the Orchestrator (add --pi to compare)
```

## License

[MIT](./LICENSE)
