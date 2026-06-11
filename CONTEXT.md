# cmux-Native AI Orchestrator Harness

A local-first system that runs inside cmux. A small local model parses user intent
into structured task specs; deterministic code then routes those tasks to capable
external coding agents and renders their artifacts in a cmux browser surface.

## Language

**Harness**:
The whole local-first system: the deterministic plumbing plus the local model plus
the artifacts view. The thing the user runs.

**Orchestrator**:
The small local model (gemma4:12b-mlx via Ollama). Its sole job is to turn natural-language
user input into a structured task spec. It does NOT make routing, fallback, or
compaction decisions — those are deterministic code. It is an **optional front-door
classifier** (chat vs job), not the conductor: the autonomous run is driven by deterministic
local code (the Harness), so the Orchestrator can be swapped for a heuristic and Ollama made
an optional dependency.
_Avoid_: Brain (overstates its role — it does not plan autonomously); Conductor (the
deterministic Harness loop is the conductor, not the model)

**Agent**:
An external, more-capable coding CLI that does the actual work. The "hands" of the system.
Two Agents are wired in — `pi` and Claude Code (`claude`) — and were used together to validate
Handover; Codex, Cursor, and Antigravity remain roadmap targets. The Scheduler that picks
between them per Step is still M4. Every Agent runs as its **real interactive TUI** in a cmux
pane (ADR-0001) — not a headless `-p` invocation.
_Avoid_: Worker, CLI

**Task spec**:
The minimal structured output of the Orchestrator: one JSON object `{task, capability}`. There
is no direct-reply branch — **every** user message becomes a dispatched `task` (a natural-language
instruction tagged with a Capability), even a greeting; the Orchestrator only classifies, it never
answers the user itself. The answer always comes back as an Agent-authored markdown artifact the
Harness opens (see Capability). It names WHAT to do, never WHO does it — config + the Scheduler pick the Agent. Dispatched `task`
strings are always in **English** — a clear instruction rephrased from the user's intent, not a
literal word-for-word translation — even when the user wrote in another language. For `web_search`,
when a `topic` is present the `task` also names the optional Thai artifact (`search_<topic>.md`). The only artifact the Orchestrator is responsible
for producing. A dispatched `web_search` or `image` task may optionally carry a **`topic`** slug
(e.g. `neighborsoft`); when present, the optional Thai markdown artifact is named
`search_<topic>.md` or `image_<topic>.md` respectively.

**Capability**:
The kind of work a dispatched task is — `web_search`, `image`, `coding`, or `chat`. Every message
is classified into a Capability (there is no longer a no-Capability chat reply — see Task spec); the
Orchestrator classifies, and deterministic config maps each Capability to its own Agent chain. The
`chat` Capability (greetings, small talk, direct questions) is handled by the **local Orchestrator
model itself** writing a short markdown reply — no cloud Agent is spun up for "hi" — while the other
Capabilities dispatch to Agent chains. When the classifier is **not confident** which Capability a
message is, the choice is surfaced as a Grilling decision (its recommended option is the model's top
guess) rather than silently defaulting to `coding`.
Whatever the Capability, the Agent's answer is written to a markdown artifact and the Harness opens
it in cmux's markdown viewer when the Agent goes idle — markdown is the universal answer surface,
no longer an optional extra. Driving a real browser (to test a built web app or gather data) is a
**tool an Agent may use mid-run**, not its own Capability. It is a classification of the work, never an Agent name
(ADR-0011). `web_search` and `image` are **single dispatches** (not PLAN-walks): the user watches
the Agent work in its visible pane; an optional Thai markdown summary in the workspace may be
written as a readable artifact (opened via cmux when present), but absence of that file is not a
failure. The same optional-artifact rules apply to both `web_search` and `image`.
Single dispatches run without a human confirm gate. A coding job's plan approval is one of
the Agent's **Grilling** decisions (the "plan is ready" decision), answered by **Bypass mode**
by default rather than a guaranteed human gate.

**Handover**:
The transfer of an in-progress job from a failed/exhausted Agent to the next Agent in
the chain. Resumes the failed Step from the last Git checkpoint; the incoming Agent reads
the repo and PLAN.md and must satisfy that Step's frozen Acceptance check, rather than being
briefed from the Orchestrator's memory.

**Checkpoint**:
A Git commit made by the Harness after a successful step. The unit of safe resume and
revert.

**PLAN.md**:
The shared plan and progress for the current job, kept as a checklist of Steps. The
human-readable source of "what's done / what remains" that any Agent can read.

**Step**:
The unit of work — and the unit of Handover. One PLAN.md checklist item paired with its
Acceptance check. A job is an ordered list of Steps; the Harness walks them one at a time,
dispatching each to an Agent. A Step's size is "as small as you can write a check for".

**Acceptance check**:
A deterministic, machine-runnable test attached to a Step (e.g. `bun run typecheck`, a unit
test, a `grep`). A Step is "done" only when its check passes — not when the Agent's process
exits 0 and not on the Agent's own say-so. It is authored at plan time and **frozen** before
implementation (so the implementing Agent cannot grade its own homework), and it is
Agent-independent, which is what makes Handover safe: the incoming Agent must satisfy the
same frozen check.

**Plan dispatch**:
The first dispatch of a job, where a capable Agent decomposes the request into Steps — each
with its frozen Acceptance check — and writes PLAN.md. Distinct from the implementation
dispatches that follow. Authoring the plan is the Agent's job, never the Orchestrator's
(it names work, not plans — see Task spec).

**Agent chain**:
The ordered preference of Agents for one Capability (best-preferred first), e.g. coding is
`cursor → codex → claude → agy → opencode → pi`. There is one chain **per Capability**, kept in
the user's config and editable by hand. It is a preference ranking for the Scheduler, NOT a
one-way descent (ADR-0011).

**Scheduler**:
The deterministic logic that, for a given Capability's chain, runs the most-preferred Agent that
is still available and falls to the next when one is unavailable. The intended end state bounces
back up to a stronger Agent when its Cooldown resets; today a fallen-over Agent is skipped for the
rest of the job (timed Cooldown is the open M4 work).

**Cooldown**:
A temporary "unavailable" mark on an Agent that hit a quota/rate-limit, with a reset window
after which it becomes selectable again.

**Broadcast**:
A manual fan-out mode (`comux all`) that opens each **enabled** slot in the user's **Broadcast
roster** as its bare interactive TUI in its own pane (with that slot's chosen model), in the
**same** workspace as the caller, and sends the same text to all of them at once, for the human to
drive and compare. The caller's own terminal becomes the top-left cell of the grid, so the layout
is an **Equal grid** of (agents + 1) equal-sized cells — up to ten, i.e. nine agents plus the
caller. Slots whose CLI binary is not installed are skipped with a warning. It deliberately
bypasses the orchestration core — no
Orchestrator intent parse, no Capability/chain/Scheduler, no PLAN/Step/Acceptance check, no
Checkpoint — and runs the Agents **unconfined in a shared cwd** (the sandbox of ADR-0005 does not
apply). It is an advisory/compare playground, not autonomous orchestration; collisions between
Agents writing the same files are the human's responsibility. The roster is edited via `/broadcast`
in the TUI; when the roster changes, the next `comux all` rebuilds the grid automatically. CLI
surface uses subcommands (pi-style): `comux all` opens or **reuses** a live grid without sending
text; `comux all send "<text>"` broadcasts; `comux all new` forces a fresh grid; `comux all close`
tears down the live grid by hard-closing every agent pane tracked in the broadcast state file (not
the caller pane or untracked padding cells), then deletes that state file; `comux all update` runs
**Broadcast update**. All agent panes share the caller's workspace (`$COMUX_WORKSPACE` or the
current directory) — there is no per-invocation cwd override. Distinct from `comux update`, which
refreshes the Harness itself.
_Avoid_: Dispatch (a Dispatch is a single routed task through a chain; a Broadcast is the
opposite — unrouted, to everyone at once); bare broadcast text on `comux all` (text requires
`send`)

**Broadcast update**:
The `update` subcommand on `comux all`. Deterministic code walks the **enabled Broadcast roster**,
dedupes by CLI **binary** (four opencode slots → one update), skips binaries not on PATH, and runs
each slot's mapped package-manager command from a hardcoded registry (brew-first; npm where the
Agent is commonly installed that way). Failures on one binary do not stop the rest; a summary is
printed and the command exits non-zero if any update failed. It does not send anything into agent
TUIs and does not refresh comux itself.

**Equal grid**:
The Broadcast layout rule. The caller's terminal is counted as one cell, so for `a` agents there
are `n = a + 1` cells (max 10: nine agents + caller). They are arranged in a `cols × rows` grid
chosen to minimise `|cols − rows| + 2·(cols·rows − n)` (landscape-biased on ties), with the caller
as the top-left cell, then resized so **every cell is the same size**. Because cmux only splits a
pane in half, the grid is built with `new-split` and then equalised with `resize-pane` (boundaries
nudged outermost-in by computed pixel amounts). Counts that don't tile evenly (e.g. 4 agents → 5
cells) pad the grid with a trailing empty pane rather than letting any pane differ in size.

**Broadcast roster**:
The ordered list of Broadcast slots kept in the user's config (`broadcast.roster` in
`~/.config/comux/config.json`). Each slot names one bare Agent launch — a display label, the CLI
binary, an optional model, and an `enabled` flag — not a registry Agent name. The default roster
has nine slots (pi, claude, codex, cursor-agent, agy, and four opencode variants on different
models), the cap for one Equal grid. `/broadcast` toggles slots on/off, reorders them, and edits
display names; capability chains are unaffected.

**Broadcast slot**:
One entry in the Broadcast roster: a human-chosen **display name**, a CLI **binary**, an optional
**model** (passed as that CLI's `--model` / `-m` flag on launch), and **`enabled`**. Multiple
slots may share the same binary (e.g. four opencode slots on different models); the slot's
internal id keys the per-workspace state file (slot → cmux surface), not the binary name alone.

**Grilling**:
The interaction model in which a running Agent surfaces its decisions as it works — a
permission request, a "plan is ready" decision, or a multiple-choice question — instead of
running silently after a single up-front approval. Each surfaced decision is answered either
by the Harness (Bypass mode) or by the human. Grilling generalises the older "approve the
plan once, then autonomous" gate into a continuous stream of answerable decisions; the Agent's
write-confinement to its repo is unchanged and remains the hard safety boundary. Grilling only
resolves *choices* — what "done" means is still the frozen Acceptance check, never the Agent's
say-so.
_Avoid_: Chat (Grilling is structured decisions with options, not free-form conversation);
Plan approval (that is now just one Grilling decision, not a special gate)

**Bypass mode**:
A Harness setting, **default ON**, that auto-answers every Grilling decision so a job runs
end-to-end with zero human gates — a permission request is allowed, a "plan is ready" decision
proceeds, and a question takes its recommended option. With Bypass mode OFF the Harness still
auto-answers any decision that carries a recommended option, and escalates **only** a decision
with no recommendation to the human.

