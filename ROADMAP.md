# comux — Development Roadmap

This roadmap supersedes the phase plan in [`prd.md`](./prd.md). It reflects the design
decisions recorded in [`CONTEXT.md`](./CONTEXT.md) and [`docs/adr/`](./docs/adr/) after a
design review. The original `prd.md` is kept for history.

## What this is

A local-first system that runs inside **cmux**. A small local model (the **Orchestrator**,
`gemma4:12b-mlx` via Ollama) parses user intent into a structured **task spec**. Deterministic
code then routes that task to a capable external coding **Agent** (Claude Code, Codex,
Antigravity, Cursor), runs it visibly in a cmux pane, checkpoints progress in git, and
falls over to the next available Agent when one is rate-limited.

See `CONTEXT.md` for the glossary of every capitalised term below.

## Core principles (the "why")

1. **The Orchestrator is a thin intent-parser, not a brain — and now optional.** Routing,
   fallback, and compaction are deterministic code — never the 12B model's judgement
   (ADR-0003). The conductor is the deterministic Harness loop, not the LLM; the Orchestrator
   is an optional front-door classifier and Ollama is an optional dependency (ADR-0010).
2. **Agents run visibly; detection is out-of-band.** The user watches the real Agent TUI
   in a cmux pane. Failure is detected by exit code + watchdog timeout + tested sentinel
   strings — not loose regex on the visible text. (ADR-0001)
3. **Git is the source of truth for handover.** The Harness commits after each successful
   step; a handover resumes from the last good commit. (ADR-0002)
4. **Agent selection is an availability scheduler, not a one-way chain.** Pick the most-
   preferred Agent not in cooldown; bounce back up when it recovers; wait (never quit)
   when all are exhausted. (ADR-0004)
5. **Approve the plan once, then run autonomously, confined to the project repo.** (ADR-0005)
6. **"Done" is a frozen machine check, not the Agent's word.** Each Step carries an Acceptance
   check authored at plan time; a Step completes only when its check passes — not on exit-0
   and not on the Agent's self-report. This is what makes the unattended walk and Handover
   trustworthy. (ADR-0009)

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

### M2 — Thin Orchestrator — ✅ implemented & validated
Connect to local Ollama (`gemma4:12b-mlx`). Turn natural-language input into a validated
minimal task spec `{reply, task}` (ADR-0006). Stateless per turn: each turn is
`system prompt (role + current PLAN.md + recent git log) + new user message` — no chat
history (ADR-0003).

`src/llm.ts` (Ollama client + defensive JSON extraction), `src/orchestrator.ts`
(`parseIntent` + normalisation). Proven with `bun run smoke:m2`: chat → reply, build → task,
and the chat answer is grounded in PLAN.md. The MLX runtime does not enforce `format`
strictly, so parsing is defensive (ADR-0008).

Routing quality is on par with a strong cloud model: `bun run compare:pi` runs the local
Orchestrator and `pi` (cloud) as routers behind the *same* system prompt over 3 cases
(chat / build / advice) — local scored 3/3, matching pi exactly, including correctly NOT
dispatching an advice question. (Local Thai prose is rougher than pi's; routing is identical.)

### M3 — Interactive TUI + dispatch loop — ✅ TUI working; autonomous PLAN-walk deferred
A raw-mode TUI (`bun run start`; `src/tui.ts`, with slash-commands, `@` file mentions and a
status bar) where each message is parsed by the Orchestrator and either answered (REPLY) or
dispatched to an Agent that runs visibly in a new cmux pane, after which the result is
git-checkpointed in a separate **workspace** (Agents confined to their own repo, ADR-0005).
`src/harness.ts` (`runTurn`), `src/workspace.ts`, `src/agents.ts` (pi as the agent;
`selectAgent` is a placeholder until M4), `scripts/harness.ts` (TUI).

Validated end-to-end: "create hello.txt" → DISPATCH → pi writes the file in a visible pane →
checkpoint committed. **Note:** for M3 the human gate is a *per-dispatch* confirm
(`COMUX_YES=1` auto-approves), which is a temporary stand-in — ADR-0005's "approve the plan
once, then run autonomously" lands with the autonomous multi-step PLAN.md walk in M4. Agents
ticking the checklist is deferred to M4 too.

### M3.5 — Autonomous verified PLAN-walk (single Agent) — ✅ implemented; live walk pending
The keystone the original plan skipped: `runTurn` used to be single-shot (one parse → one
dispatch → one checkpoint), and nothing authored a multi-step PLAN.md. M3.5 closes that gap
with a **single** Agent and no Scheduler:

1. **Plan dispatch** — a capable Agent decomposes the request into Steps, each with a frozen
   Acceptance check, and writes PLAN.md (authoring is the Agent's job, not the Orchestrator's).
2. **Walk loop** (deterministic) — for each unchecked Step: dispatch the implementation → run
   the Step's Acceptance check → on pass, tick + `git checkpoint`; on fail, retry once.
3. Approve the plan **once** up front, then run autonomously (lands ADR-0005's approve-once,
   replacing M3's per-dispatch confirm).

This delivers standalone value at N=1 (autonomous, check-verified, git-safe, visible coding —
no second subscription needed) and is the prerequisite for everything below: there is nothing
to hand over or schedule until a multi-Step walk exists.

Implemented in `src/plan.ts` (PLAN.md format + parser + tick + the plan/step prompts),
`src/check.ts` (the Acceptance-check runner, confined per ADR-0005), and `src/harness.ts`
(`runTurn` → `planJob` → `walkPlan`). The deterministic core (parse / tick / check) is gated by
`bun run smoke:m3`; the Agent-driven plan→walk loop still needs an end-to-end run against a live
cmux + Ollama + `pi`. Still open: demoting the Orchestrator to an optional front-door (ADR-0010)
is not done yet — `runTurn` still parses every message through it.

### M5-spike — Prove Handover quality (cheapest risky thing) — ⚠️ gate before M4
Wire a **second** Agent and, by hand, hand a half-finished job from Agent A to Agent B mid-walk:
B reads the repo + PLAN.md and must satisfy the failed Step's *frozen* Acceptance check. The
make-or-break question is whether a heterogeneous Agent resumes cold-from-git work to an
acceptable standard. If it does, build the Scheduler; if not, multi-Agent failover is worthless
and we just saved building M4. (Proving "the riskiest thing first" — same principle as M1.)

### M4 — Scheduler + cooldown (only if the M5-spike passes)
Support 2+ Agents. On quota/rate-limit: switch immediately and mark the Agent cooling
down. On error/stuck: retry the same Agent once, then switch. Bounce back to a stronger
Agent when its cooldown resets. When all are exhausted: wait and resume.

### M5 — Handover (productionise the spike)
On switch, the incoming Agent reads the repo + PLAN.md and resumes the failed Step from the
last commit, instructed to read files before editing and to satisfy that Step's frozen
Acceptance check. No Orchestrator-from-memory briefing.

### M6 — Rich web view (optional, later)
If a file-explorer / image-rendering view is still wanted, build a Bun web app and open it
as a cmux browser surface (`cmux browser open http://localhost:<port>`). Port is
configurable, not hardcoded.

## Resolved details

- **Task spec schema** — minimal `{reply, task}`, exactly one field set; names the work,
  not the Agent. (ADR-0006)
- **PLAN.md checklist** — each item is a **Step** paired with a frozen **Acceptance check**;
  the Harness ticks the item only when the check passes (not the Agent's say-so, ADR-0009).
  Git remains the source of truth regardless. (ADR-0002)
- **Who the harness is for** — one product: a *local conductor that runs cloud Agents* on long,
  unattended, check-verified, git-safe jobs you can watch. Value at N=1 Agent (autonomous
  verified walk); multi-Agent failover is the moat for those who hit rate-limits (N≥2).
- **Watchdog timeout** — a silence timer: it resets on every new line of Agent output and
  fires only after `DEFAULT_WATCHDOG_MS` (180s) of *no* output (≠ a total job timeout).

## Pre-open-source cleanup

Tracked gaps where the docs/ADRs once described a settled state that the code has not yet
reached. Ordered by impact:

1. **Approve-once vs per-step confirm.** ADR-0005 decides "approve the plan once, then run
   autonomously", but M3 ships a per-dispatch confirm. Land approve-once together with the
   M4 autonomous PLAN-walk; until then ADR-0005 carries a status note.
2. **Workspace confinement is enforced on macOS only.** `src/sandbox.ts` wraps each Agent
   in `sandbox-exec` so it can only write inside the workspace (ADR-0005). On Linux/Windows
   there is no enforcement yet — add a per-platform sandbox (e.g. bubblewrap/landlock) before
   claiming the boundary cross-platform. Opt out with `COMUX_NO_SANDBOX=1`.
3. **`gemma4:12b-mlx` is the one canonical model tag** (was inconsistently `gemma4:12b`).
   Verify the tag exists in Ollama and that the `256k` context shown in the status bar matches
   the model actually pulled.
4. **Single Agent today.** The Agent chain (Claude Code → Codex → …) is the M4 target; the
   registry currently holds only `pi`.

## Open sub-questions

- ~~How to force the model to emit valid JSON.~~ Resolved: the MLX runtime ignores `format`,
  so we parse defensively + normalise rather than trusting structured output (ADR-0008).
- The watchdog's `N` (silence threshold) and how to distinguish "thinking" from "stuck"
  (deferred; `read-screen` diffing is also sensitive to animated prompts — see ADR-0007).

## Stack

TypeScript · Bun · Ollama (`gemma4:12b-mlx`) · cmux · git · (optional) Vanilla web for M6.
