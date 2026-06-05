# cmux-Native AI Orchestrator Harness — Development Roadmap

This roadmap supersedes the phase plan in [`prd.md`](./prd.md). It reflects the design
decisions recorded in [`CONTEXT.md`](./CONTEXT.md) and [`docs/adr/`](./docs/adr/) after a
design review. The original `prd.md` is kept for history.

## What this is

A local-first system that runs inside **cmux**. A small local model (the **Orchestrator**,
`gemma4:12b` via Ollama) parses user intent into a structured **task spec**. Deterministic
code then routes that task to a capable external coding **Agent** (Claude Code, Codex,
Antigravity, Cursor), runs it visibly in a cmux pane, checkpoints progress in git, and
falls over to the next available Agent when one is rate-limited.

See `CONTEXT.md` for the glossary of every capitalised term below.

## Core principles (the "why")

1. **The Orchestrator is a thin intent-parser, not a brain.** Routing, fallback, and
   compaction are deterministic code — never the 12B model's judgement. (ADR-0003)
2. **Agents run visibly; detection is out-of-band.** The user watches the real Agent TUI
   in a cmux pane. Failure is detected by exit code + watchdog timeout + tested sentinel
   strings — not loose regex on the visible text. (ADR-0001)
3. **Git is the source of truth for handover.** The Harness commits after each successful
   step; a handover resumes from the last good commit. (ADR-0002)
4. **Agent selection is an availability scheduler, not a one-way chain.** Pick the most-
   preferred Agent not in cooldown; bounce back up when it recovers; wait (never quit)
   when all are exhausted. (ADR-0004)
5. **Approve the plan once, then run autonomously, confined to the project repo.** (ADR-0005)

## Explicitly cut from the original PRD

- **Phase 6 (context compaction / STATE.json / token counter)** — dissolved by a stateless
  Orchestrator + PLAN.md. (ADR-0003)
- **Custom web dashboard, file-explorer, WebSocket/SSE (old Phase 1.3/1.4/3.x)** — v1 uses
  `cmux markdown open` for viewing. A rich web view is a later, optional enhancement.
- **PTY keystroke injection** — the first task is seeded via the Agent's launch argument.
- **Loose `Error/Limit/Quota` regex kill** — replaced by exit code + timeout + sentinels.

## Milestones (ordered by "prove the riskiest thing first")

### M1 — Control one real Agent (the make-or-break spike) — ✅ implemented & validated
Run an Agent in a visible cmux pane, seeded with a task through its launch command. Capture
the exit code, apply a silence watchdog, and `git commit` when the step completes.

Built on cmux CLI primitives, not node-pty (ADR-0007): `src/cmux.ts` (cmux wrapper),
`src/agent-runner.ts` (`runAgentStep` + watchdog), `src/git.ts` (`checkpoint`). Proven
end-to-end against the real cmux with `bun run smoke:m1` — completion + exit code capture,
git checkpoint, and stuck-detection all pass.

### M2 — Thin Orchestrator
Connect to local Ollama (`gemma4:12b`). Turn natural-language input into a validated task
spec `{thought, target_agent, command_string}`. Stateless per turn: each turn is
`system prompt (role + current PLAN.md + recent git log) + new user message`.

### M3 — PLAN.md loop + git checkpoints
Approve PLAN.md once up front, then walk it step by step: dispatch Agent → verify →
`git commit` → tick the checklist. User can interject via the TUI between steps.

### M4 — Scheduler + cooldown
Support 2+ Agents. On quota/rate-limit: switch immediately and mark the Agent cooling
down. On error/stuck: retry the same Agent once, then switch. Bounce back to a stronger
Agent when its cooldown resets. When all are exhausted: wait and resume.

### M5 — Handover
On switch, the incoming Agent reads the repo + PLAN.md and resumes from the last commit,
instructed to read files before editing. No Orchestrator-from-memory briefing.

### M6 — Rich web view (optional, later)
If a file-explorer / image-rendering view is still wanted, build a Bun web app and open it
as a cmux browser surface (`cmux browser open http://localhost:<port>`). Port is
configurable, not hardcoded.

## Resolved details

- **Task spec schema** — minimal `{reply, task}`, exactly one field set; names the work,
  not the Agent. (ADR-0006)
- **PLAN.md checklist** — the dispatched **Agent** ticks its own items; git remains the
  source of truth regardless. (ADR-0002)
- **Watchdog timeout** — a silence timer: it resets on every new line of Agent output and
  fires only after N seconds of *no* output (≠ a total job timeout).

## Open sub-questions (deferred to implementation)

- How to force `gemma4:12b` to always emit valid JSON (structured output / grammar-
  constrained decoding).
- The watchdog's `N` (silence threshold) and how to distinguish "thinking" from "stuck".

## Stack

TypeScript · Bun · Ollama (`gemma4:12b`) · cmux · git · (optional) Vanilla web for M6.
