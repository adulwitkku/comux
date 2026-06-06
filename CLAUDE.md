# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

comux is a local-first AI orchestrator that runs coding agents **visibly** inside [cmux](https://cmux.com).
A small local model (the **Orchestrator**, `gemma4:12b-mlx` via Ollama) turns a user's
natural-language message into a minimal task spec; deterministic code then routes coding
work to an external **Agent** CLI (currently `pi`), runs it in a real cmux pane, and
git-checkpoints the result in a confined workspace.

Read [`CONTEXT.md`](./CONTEXT.md) first — it is the glossary for every capitalised term
(Orchestrator, Agent, Task spec, Scheduler, Cooldown, Handover, Checkpoint, PLAN.md).
The "why" behind the design lives in [`docs/adr/`](./docs/adr); [`ROADMAP.md`](./ROADMAP.md)
tracks milestones (M1–M3 implemented, M4 scheduler/fallback next).

## Commands

```bash
bun install           # dev deps only — comux has NO runtime npm dependencies
bun run start         # launch the TUI against ./workspace
bun run typecheck     # tsc --noEmit (strict) — must pass; this is the only "test gate"
bun run build         # compile a standalone binary to dist/comux

bun run smoke:m1      # M1 end-to-end: visible agent run + exit code + watchdog + checkpoint
bun run smoke:m2      # M2: Orchestrator routing (chat -> reply, build -> task)
bun run smoke:m3      # M3.5: PLAN.md parse/tick + acceptance-check runner (offline)
bun run smoke:setup   # M4: per-capability chains + registry + /setup detection (offline)
bun run compare:pi    # local Orchestrator vs pi (cloud) as routers over 3 cases
bun run try "msg"     # throw one message at the Orchestrator (add --pi to compare)
```

There is no unit-test framework or linter. Verification is `bun run typecheck` plus the
smoke scripts, which require a running cmux + Ollama + the `pi` CLI on PATH.

### Runtime requirements

comux orchestrates other tools and shells out to them at runtime: Bun ≥ 1.3, a running
**cmux** (it calls the `cmux` CLI — ADR-0007), **Ollama** serving `gemma4:12b-mlx`, and one or
more **Agent CLIs** on PATH (`pi`, `claude`, `agy`, `codex`, `cursor-agent`, `opencode`) — run
`/setup` to detect them and write the default per-capability chains to `~/.config/comux/config.json`.
Env: `COMUX_WORKSPACE`, `COMUX_MODEL`, `OLLAMA_HOST`, `XDG_CONFIG_HOME` (config location),
`COMUX_YES` (auto-approve), `COMUX_NO_SANDBOX` (disable macOS write-confinement).

## Architecture

The flow per turn (`src/harness.ts:runTurn`): read PLAN.md + recent git log → `parseIntent`
→ either show a REPLY, or dispatch by **Capability** (ADR-0011). `web_search` / `image` are a
single dispatch down that Capability's chain; `coding` runs the autonomous **PLAN-walk**: a
**plan dispatch** (planning chain) asks an Agent to author PLAN.md (Steps, each with a frozen
Acceptance check) → the human approves the plan **once** → `walkPlan` runs each Step down the
coding chain in a visible cmux pane, runs its Acceptance check, and `checkpoint`s only when the
check passes (ADR-0009). Every dispatch goes through the Scheduler (`runWithChain`): the most-
preferred installed Agent runs and the next in the chain takes over when one falls over.

- **`src/orchestrator.ts` + `src/llm.ts`** — the Orchestrator. `parseIntent` builds a
  stateless system prompt (role + current PLAN.md + recent git log) and the new user
  message — **no chat history** (ADR-0003). `llm.ts` talks to Ollama over HTTP and extracts
  JSON **defensively**: the MLX backend ignores the `format` hint, so output is parsed and
  normalised rather than trusted (ADR-0008). The result is a `{reply, task}` spec with
  exactly one field set; it names WHAT to do, never WHO does it (ADR-0006).
- **`src/agent-runner.ts`** — `runAgentStep` runs an Agent as its real process in a cmux
  terminal surface (visible, not headless — ADR-0001). Completion + exit code come from a
  shell sentinel appended to the launch command (`<cmd>; echo __CMUX_EXIT__=$?`) read back
  via `read-screen`. A **silence watchdog** (`DEFAULT_WATCHDOG_MS`, 180s) treats a screen
  that stops changing as stuck — this is NOT a total job timeout; an Agent may run for hours
  while it keeps producing output. Detection biases toward false-negatives.
- **`src/cmux.ts`** — thin wrapper over the `cmux` CLI (split panes, send lines, read
  screen, set status). Every call shape was validated against the real CLI. This is the
  ONLY way agents are driven — no node-pty / keystroke injection (ADR-0007).
- **`src/agents.ts` + `src/sandbox.ts`** — the Agent registry (`pi`, `claude`, `agy`, `codex`,
  `cursor`, `opencode`), keyed by the name chains reference. Each Agent turns a task into a shell
  launch command, wrapped by `confine` so the Agent can only **write** inside its workspace
  (ADR-0005; enforced via `sandbox-exec` on macOS only, opt out with `COMUX_NO_SANDBOX`). Agents
  with their own permission prompt are told to skip it — the sandbox is the real boundary.
- **`src/config.ts` + `src/setup.ts` + `src/scheduler.ts`** — per-Capability Agent chains
  (ADR-0011). `config.ts` owns the chains and `~/.config/comux/config.json`; `/setup` (`setup.ts`)
  detects installed CLIs and writes the defaults; `scheduler.ts` (`runWithChain`) walks a chain,
  marking an Agent down and moving to the next on crash/silence. Timed Cooldown is still M4.
- **`src/plan.ts` + `src/check.ts`** — PLAN.md is the job: an ordered list of Steps, each a
  checklist item paired with a frozen Acceptance check (ADR-0009). `plan.ts` owns the on-disk
  format (parse / tick) and the plan/step prompts; `check.ts` runs a Step's check (confined)
  and a Step is "done" only when it exits 0 — not on exit-0 of the Agent or its self-report.
- **`src/git.ts` + `src/workspace.ts`** — git is the source of truth for handover (ADR-0002).
  Agents are confined to their own workspace repo (`./workspace`), approved once then
  autonomous within that repo (ADR-0005).
- **`scripts/harness.ts` + `src/tui.ts` + `src/ui.ts`** — the CLI entrypoint (`bin: comux`),
  raw-mode TUI (slash commands, `@` file mentions, status bar), and styling helpers.

## Conventions

- **Keep it dependency-free at runtime.** Shell out to `cmux`, `git`, and Agent CLIs; talk
  to Ollama over HTTP. New runtime npm deps need strong justification.
- **The Orchestrator is a thin intent-parser, not a planner** (ADR-0006/0003). Routing,
  fallback, and checkpointing are deterministic code — never the model's judgement. Do not
  push planning or agent-selection logic into the prompt.
- Strict TypeScript, small single-purpose modules, `.ts` extensions in imports (Bun).
  Comments explain *why*. Open a discussion before contradicting an ADR.
