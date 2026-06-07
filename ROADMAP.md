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

### M3.5 — Autonomous verified PLAN-walk (single Agent) — ✅ implemented & validated
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
`bun run smoke:m3`. The full Agent-driven loop is validated end-to-end against a live cmux +
Ollama + `pi` by `bun run scripts/live-m3.ts` — a happy-path 2-step job: gemma routed the
request, `pi` authored PLAN.md with a `grep -q` check per step, and each step was checkpointed
only after its check passed (3 commits: plan + 2 steps). Not yet exercised live: the retry/stuck
paths. Still open: demoting the Orchestrator to an optional front-door (ADR-0010) — `runTurn`
still parses every message through it.

### M5-spike — Prove Handover quality (cheapest risky thing) — ✅ validated; M4 greenlit
Wire a **second** Agent and, by hand, hand a half-finished job from Agent A to Agent B mid-walk:
B reads the repo + PLAN.md and must satisfy a Step's *frozen* Acceptance check. The make-or-break
question is whether a heterogeneous Agent resumes cold-from-git work to an acceptable standard.

**Result (passed).** `bun run spike:m5` runs a hand-authored 2-Step plan where Step 2 depends on
Step 1's artifact: `pi` writes `greet.sh`; then **Claude Code**, a different process with no shared
memory, resumes from git + PLAN.md and writes a `Makefile` whose `run` target invokes `sh greet.sh`
— it read `pi`'s file and wired to it rather than re-implementing. Step 2's check passes *and* Step
1's frozen check still passes afterwards (no clobber). Handover quality is acceptable, so the
Scheduler (M4) is worth building. Claude Code is now a real Agent in the registry (`src/agents.ts`),
confined like `pi` (its `~/.claude` store added to the sandbox). Not yet exercised: same-Step
handover after a genuine mid-Step failure (the spike hands over at a Step boundary).

### M4 — Scheduler + cooldown — 🔨 partially implemented (chains + fallback done; cooldown open)

**Done.** Per-capability Agent chains (ADR-0011): the Orchestrator classifies a message into a
Capability (`web_search` / `image` / `coding`); `~/.config/comux/config.json` maps each to an
ordered chain; the Scheduler (`src/scheduler.ts`, `runWithChain`) runs the most-preferred Agent
and falls to the next when one crashes or goes silent. Six Agents are wired (`pi`, `claude`, `agy`,
`codex`, `cursor`, `opencode`); `/setup` detects which CLIs are installed and writes the defaults
(`smoke:setup` gates the config/registry offline). Coding jobs run the PLAN-walk with the
`planning` chain for the plan dispatch and the `coding` chain per Step.

**Still open** (the original M4 core): a **timed Cooldown** with bounce-back, and **quota-vs-error
detection** so a rate-limit cools the Agent down (and returns when it resets) while an ordinary
failure does not. Until then "down" is a per-job skip with no reset — see the design fork below.

Support 2+ Agents. On quota/rate-limit: switch immediately and mark the Agent cooling
down. On error/stuck: retry the same Agent once, then switch. Bounce back to a stronger
Agent when its cooldown resets. When all are exhausted: wait and resume.

**Open design fork (decide before building).** `runAgentStep` today returns only
`completed(exitCode)` / `stuck` — it cannot yet tell a *quota/rate-limit* exit (→ cooldown +
switch) from an ordinary *error* exit (→ retry same Agent). Resolving this is the first M4 task.
Candidates: (a) **tested per-Agent sentinels** read off the screen (matches ADR-0001's "tested
sentinels, not loose regex", but needs upkeep per Agent CLI); (b) **exit code only** (simplest,
but loses cooldown/bounce-back); (c) **per-Agent exit-code mapping** if `pi`/`claude` use a
distinct code on quota — needs a quick spike to find out. Leaning (a)+(c). Not yet decided.

### M5 — Handover (productionise the spike)
On switch, the incoming Agent reads the repo + PLAN.md and resumes the failed Step from the
last commit, instructed to read files before editing and to satisfy that Step's frozen
Acceptance check. No Orchestrator-from-memory briefing.

### M6 — Rich web view (optional, later)
If a file-explorer / image-rendering view is still wanted, build a Bun web app and open it
as a cmux browser surface (`cmux browser open http://localhost:<port>`). Port is
configurable, not hardcoded.

## Design review round 2 — "it doesn't feel smart" (ADR-0015–0019)

A run-it-for-real review found the felt dumbness was **not** wrong `cmux` calls (`src/cmux.ts`
matches cmux CLI v0.64.14 exactly). The real causes were three, tackled as phases ordered by
impact. All three are designed; none are implemented yet.

### P1 — Completion detection via cmux lifecycle, not sentinel/screen-diff (ADR-0015)
The exit sentinel + `read-screen` silence watchdog only works for Agents that *exit*; an
interactive TUI (ADR-0012) never exits when it finishes a turn, so a healthy Agent reads as
"stuck" and is handed over — the main "can't tell when a job is done" symptom. Switch to cmux's
own agent lifecycle (`running` / `idle` / `needsInput`, surfaced via `cmux hooks` + the
`cmux events` Feed stream): `idle` ⇒ run the frozen Acceptance check (still the done-authority,
ADR-0009); `needsInput` ⇒ a Grilling decision (P-interaction); crash/exit ⇒ sentinel fallback.
`/setup` must now also run `cmux hooks setup` for installed Agents → **`cmux hooks` becomes a
runtime requirement**. Supersedes the detection half of ADR-0007.

### P-interaction — Continuous grilling + Bypass mode; unconfined Agents (ADR-0016, ADR-0017)
Replace ADR-0005's single "approve once" gate with **Grilling**: the Agent surfaces decisions as
it works (permission / plan-is-ready / multiple-choice question) via the cmux Feed, each answered
by the Harness or the human. **Bypass mode (default ON)** auto-answers everything (zero gates);
Bypass OFF auto-picks any recommended option and escalates only the no-recommendation case to the
human. With the gate gone and Agents driving cmux, the write-only sandbox was guarding a side door
— so **confinement is dropped** (ADR-0017): Agents run unconfined like Broadcast. The remaining
guards are the frozen Acceptance check (ADR-0009) and Git checkpoints (ADR-0002), which matter more
now, not less.

### P3 — Universal markdown output + browser as a mid-run tool (ADR-0018)
Every message dispatches and the Agent's answer is a **markdown artifact** the Harness opens in
cmux's viewer (TUI renders images/tables/graphs badly). The Orchestrator's direct-reply branch is
removed; it becomes a pure classifier (Task spec → `{task, capability}`). Of the three requested
skills, only **cmux-browser** is given to Agents (a tool to test built web apps / gather data);
**cmux-markdown** is moot (Agent writes a file, Harness opens it, keeping cmux on the Harness side
per ADR-0007) and **cmux-core** topology is moot (Harness lays out panes). Browser is a tool, not
a Capability, so the Orchestrator stays thin (ADR-0006).

### P2 — Classifier uncertainty grills; a `chat` Capability (ADR-0019)
The 12B local classifier misroutes, and `normalise()` silently defaults the unknown case to
`coding` — the "picks the wrong type" symptom. Fix: emit `confident` + ranked `alternatives`
(defensive parse, ADR-0008); when not confident, surface the capability choice as a Grilling
decision (recommended = the model's top guess) instead of defaulting. Add a fourth Capability
`chat` (greetings / small talk) handled by the **local model itself** writing a short markdown
reply — no cloud Agent spun up for "hi".

### Parked (discovered during the review)
- **Session resume for Handover/M5.** cmux stores each Agent's `sessionId` + native resume command
  (`claude --resume <id>`, `codex resume <id>`, …) in `~/.cmuxterm/<agent>-hook-sessions.json`.
  Resuming the *same* Agent's session is a cheaper alternative to the cold-from-git restart M5
  assumes — worth evaluating when productionising Handover.
- **Agent Hibernation gotcha.** cmux can SIGTERM idle off-screen Agent panes (default off, only
  >12 live Agents). comux opens many panes; note this if enabling hibernation.
- **Open P3 impl details.** The markdown output filename/location convention; how skill-capable
  Agents are given cmux-browser and the chain implications.

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

1. **Approve-once is superseded.** ADR-0016 replaces the single approve-once gate with Continuous
   grilling + Bypass mode (default ON = zero gates). The M3 per-dispatch confirm is now legacy; the
   gate work is the P-interaction phase above, not a return to approve-once.
2. **Workspace confinement is dropped, not cross-platform'd.** ADR-0017 removes the `sandbox-exec`
   write-confinement for the orchestrated flow (Agents run unconfined). The old cross-platform
   sandbox task is therefore moot; the safety story is trusted Agents + frozen Acceptance check +
   Git checkpoints. (`COMUX_NO_SANDBOX` and `src/sandbox.ts` become vestigial.)
3. **`gemma4:12b-mlx` is the one canonical model tag** (was inconsistently `gemma4:12b`).
   Verify the tag exists in Ollama and that the `256k` context shown in the status bar matches
   the model actually pulled.
4. **Single Agent today.** The Agent chain (Claude Code → Codex → …) is the M4 target; the
   registry currently holds only `pi`.

## Open sub-questions

- ~~How to force the model to emit valid JSON.~~ Resolved: the MLX runtime ignores `format`,
  so we parse defensively + normalise rather than trusting structured output (ADR-0008).
- ~~The watchdog's `N` (silence threshold) and how to distinguish "thinking" from "stuck".~~
  Re-resolved by ADR-0015: completion comes from cmux's agent lifecycle (`idle`/`needsInput`),
  not `read-screen` diffing; the silence watchdog drops to a backstop for a truly hung Agent.

## Stack

TypeScript · Bun · Ollama (`gemma4:12b-mlx`) · cmux · git · (optional) Vanilla web for M6.
