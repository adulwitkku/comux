# Contributing to comux

Thanks for your interest! comux is a small, dependency-free Bun + TypeScript project.

## Setup

```bash
bun install          # dev deps only (types + typescript); comux has no runtime deps
bun run start        # launch the TUI against ./workspace
bun run typecheck    # tsc --noEmit (strict)
```

## Ground rules

- **Read the design first.** [`CONTEXT.md`](./CONTEXT.md) is the glossary; [`docs/adr/`](./docs/adr)
  records the decisions and *why*. Open a discussion before contradicting an ADR.
- **Keep it dependency-free at runtime.** comux shells out to `cmux`, `git`, and Agent CLIs,
  and talks to Ollama over HTTP. New runtime npm dependencies need a strong justification.
- **Match the surrounding style.** Strict TypeScript, small modules, comments that explain
  *why*. `bun run typecheck` must pass.
- **The Orchestrator is a thin intent parser, not a planner** (ADR-0006). Routing, fallback,
  and checkpointing are deterministic code, not the model's job.

## Pull requests

Keep them focused. Describe the change and reference the relevant ADR or roadmap milestone.
If you're adding a milestone behaviour, update [`ROADMAP.md`](./ROADMAP.md).
