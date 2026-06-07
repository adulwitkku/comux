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
more **Agent CLIs** on PATH (`pi`, `claude`, `agy`, `codex`, `cursor-agent`/`agent`, `opencode`) — run
`/setup` to detect them, run `cmux hooks setup` (completion detection — ADR-0015), and write the
default per-capability chains to `~/.config/comux/config.json`.
Env: `COMUX_WORKSPACE`, `COMUX_MODEL`, `OLLAMA_HOST`, `XDG_CONFIG_HOME` (config location),
`COMUX_YES` (auto-approve the plan gate when Bypass mode is off). Bypass mode (default on,
ADR-0016) auto-answers agent Grilling prompts; Agents run **unconfined** (ADR-0017).

## Architecture

The flow per turn (`src/harness.ts:runTurn`): read PLAN.md + recent git log → `parseIntent`
classifies the message into a **Capability** (ADR-0011/0018) — **every** message dispatches, there
is no direct reply. `chat` is answered by the local model writing markdown (ADR-0019); `web_search`
/ `image` are a single dispatch down that Capability's chain; `coding` runs the autonomous
**PLAN-walk**: a **plan dispatch** (planning chain) asks an Agent to author PLAN.md (Steps, each
with a frozen Acceptance check) → the plan-is-ready decision is answered by Bypass mode (or the
human when bypass is off, ADR-0016) → `walkPlan` runs each Step down the coding chain in a visible
cmux pane, runs its Acceptance check, and `checkpoint`s only when the check passes (ADR-0009). Every
dispatch goes through the Scheduler (`runWithChain`): the most-preferred installed Agent runs and the
next in the chain takes over when one falls over. Completion is read from cmux's agent lifecycle
(ADR-0015) and the Agent's answer comes back as a markdown artifact the Harness opens (ADR-0018); a
background **Feed watcher** (`src/feed.ts`) auto-answers agent Grilling prompts under Bypass mode.

- **`src/orchestrator.ts` + `src/llm.ts`** — the Orchestrator. `parseIntent` builds a
  stateless system prompt (role + current PLAN.md + recent git log) and the new user
  message — **no chat history** (ADR-0003). `llm.ts` talks to Ollama over HTTP and extracts
  JSON **defensively**: the MLX backend ignores the `format` hint, so output is parsed and
  normalised rather than trusted (ADR-0008). The result is a `{task, capability}` spec plus a
  `confident` flag + ranked `alternatives` (ADR-0018/0019); it names WHAT to do, never WHO does it
  (ADR-0006). `chatReply` handles the `chat` Capability with the local model itself.
- **`src/agent-runner.ts` + `src/lifecycle.ts`** — `runAgentStep` runs an Agent as its real process
  in a cmux terminal surface (visible, not headless — ADR-0001). Completion is read from cmux's
  agent **lifecycle** (`idle` ⇒ turn finished; `needsInput` ⇒ blocked, handled by Grilling) via
  `lifecycle.ts` reading `~/.cmuxterm/<hookName>-hook-sessions.json` (ADR-0015); the exit sentinel
  (`<cmd>; echo __CMUX_EXIT__=$?`) survives as the fallback for headless Agents and crashes. A
  **silence watchdog** (`DEFAULT_WATCHDOG_MS`, 180s) is now only a backstop for a truly hung Agent.
  Detection biases toward false-negatives.
- **`src/cmux.ts`** — thin wrapper over the `cmux` CLI (split panes, send lines, read
  screen, set status). Every call shape was validated against the real CLI. This is the
  ONLY way agents are driven — no node-pty / keystroke injection (ADR-0007).
- **`src/agents.ts` + `src/sandbox.ts`** — the Agent registry (`pi`, `claude`, `agy`, `codex`,
  `cursor`/`agent`, `opencode`; `cursor` and `agent` are the two symlink names of the same Cursor
  CLI), keyed by the name chains reference (each also carries a `hookName` for
  cmux lifecycle, ADR-0015). Each Agent turns a task into a shell launch command. Confinement has
  been **dropped** (ADR-0017): `confine` in `sandbox.ts` is now an identity function — Agents run
  unconfined, like Broadcast. The safety story is trusted Agents + the frozen Acceptance check +
  Git checkpoints.
- **`src/config.ts` + `src/setup.ts` + `src/scheduler.ts` + `src/feed.ts`** — per-Capability Agent
  chains (ADR-0011) + Bypass mode (ADR-0016). `config.ts` owns the chains (incl. `chat`), the
  `bypass` flag, and `~/.config/comux/config.json`; `/setup` (`setup.ts`) detects installed CLIs,
  runs `cmux hooks setup` (ADR-0015), and writes the defaults; `scheduler.ts` (`runWithChain`) walks
  a chain, marking an Agent down and moving to the next on crash/silence; `feed.ts` subscribes to
  cmux's Feed and auto-answers agent decisions under Bypass mode. Timed Cooldown is still M4.
- **`src/plan.ts` + `src/check.ts`** — PLAN.md is the job: an ordered list of Steps, each a
  checklist item paired with a frozen Acceptance check (ADR-0009). `plan.ts` owns the on-disk
  format (parse / tick), the plan/step prompts, and the markdown-output + browser-tool instructions
  appended to dispatches (ADR-0018); `check.ts` runs a Step's check and a Step is "done" only when
  it exits 0 — not on exit-0 of the Agent or its self-report.
- **`src/git.ts` + `src/workspace.ts`** — git is the source of truth for handover (ADR-0002) and,
  with confinement dropped (ADR-0017), the primary undo for an unconfined, un-gated run. Agents work
  in their own workspace repo (`./workspace`).
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
