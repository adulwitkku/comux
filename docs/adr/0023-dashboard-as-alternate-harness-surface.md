# Dashboard as an alternate Harness surface (Next.js + Elysia)

The roadmap explicitly cut a custom web dashboard in favour of `cmux markdown open` (M6 deferred).
We are bringing a **Dashboard** back as a first-class, optional control surface: `comux dashboard`
runs the same `runTurn` loop as the terminal TUI but renders input and output in a browser on port
62120 (default; overridable via `COMUX_DASHBOARD_PORT`). An optional `--gateway` mode starts a
cloudflared quick tunnel so the Dashboard is reachable remotely, always token-gated.

The Dashboard is **not** a second orchestrator, not a mirror of the terminal, and not a
replacement for the TUI — it is an alternate **Harness surface** with per-workspace exclusivity
(one of TUI or Dashboard at a time; a second launch fails fast with no `--force` steal).

## Stack and packaging

The UI lives in a separate `dashboard/` workspace (own `package.json`: Next.js, shadcn, Elysia
mounted inside Next per the [Elysia + Next integration](https://elysiajs.com/integrations/nextjs.html)).
The comux **core** stays runtime-dependency-free; `comux dashboard` shells into `dashboard/`.
v1 distribution is **dev-repo only** — the compiled `dist/comux` binary does not bundle the
Dashboard; a later release may pre-build a Next standalone artifact.

The dashboard workspace lists `@sinclair/typebox` as a **direct** dependency. Elysia declares
it as a required (non-optional) peer; Bun's hardlink cache layout resolves the import from the
cache realpath, where an auto-installed peer is not visible — providing it from the workspace
manifest is the only reliable fix.

This supersedes the original PRD's "Vanilla CSS + Bun.serve on 62120" and the roadmap's "Bun web
app" sketch for M6. Next.js was chosen for component velocity (shadcn) and a well-trodden
full-stack layout; Elysia keeps the API in TypeScript beside the app without adding a second
server process.

## Chat parity (v1)

| In scope | Out of scope (v1) |
| -------- | ----------------- |
| Message input (multiline) | `@` file mentions |
| Slash-command palette (`/plan`, `/ws`, …) | Interactive pickers (`/model`, `/settings`, `/broadcast`) — edit `config.json` or use the TUI |
| Status bar (workspace, branch, ctx tokens, model, TPS) | Ollama token streaming (`llm.ts` stays `stream: false`) |
| Grilling modals when Bypass mode is off | Raw Agent pane text from cmux |
| SSE stream of **Harness events** (what TUI would `say()`) | |

Real-time transport: **SSE** (`GET /api/events`) for server→client events; **HTTP POST** for
client→server (submit message, answer a Grilling prompt). Event shapes include `log`, `status`,
`grill`, `turn_done`, and periodic `agent_status`.

## Agent tab (v1)

Lists the **Dashboard agent roster** — the deduped set of registry Agents referenced by the user's
capability chains (not the Broadcast roster, which bypasses orchestration). Columns:

- **Lifecycle** — from cmux hook session files (`running` / `idle` / `needsInput`), when present.
- **Reachable** — CLI on PATH (`detectAgents`).
- **Quota / context % / 5h / weekly** — **unknown** until M4 timed Cooldown and per-Agent quota
  probes land; the UI reserves the columns rather than faking numbers.

Agent rows refresh on the **same SSE connection** as chat: the server emits `agent_status` every
~5s after polling lifecycle + install detection.

## Auth and gateway

- **Loopback** (`127.0.0.1`) — no token.
- **Any other origin** (non-loopback bind, LAN, cloudflared URL) — requires the **Dashboard
  token**, persisted in the user's comux config, passed as `?token=` or `Authorization: Bearer`.
- **`comux dashboard --gateway`** — starts the Dashboard **and** a cloudflared quick tunnel
  (`cloudflared tunnel --url http://localhost:<port>`) as a child process; prints the public URL
  with `?token=`; runs foreground until Ctrl+C. **No pm2 in v1**; `cloudflared` must be on PATH.

## Harness integration

Introduce a small **Harness event bus** in core. `runTurn` continues to accept `say`, but `say`
also emits typed Harness events. The TUI subscribes → `tui.print`; the Dashboard subscribes → SSE
queue. Grilling decisions that block on `tui.confirm` / `tui.choose` in the TUI block on a matching
HTTP POST in the Dashboard (promise resolved when the answer arrives).

## Considered options

- **Keep the roadmap cut (markdown viewer only)** — rejected: remote phone/laptop control and a
  readable agent-status panel are worth the packaging cost now that the Harness core is stable.
- **Sidecar / remote viewer of a running TUI** — rejected: IPC complexity, dual-control races, and
  no faithful `say()` stream without coupling to the terminal process.
- **Replace the TUI entirely** — rejected: terminal-first workflow and slash pickers remain the
  power-user surface; the Dashboard is optional.
- **Bun.serve + vanilla HTML (PRD / M6 sketch)** — rejected for v1: slower to reach shadcn-quality
  UX; Elysia + Next is a deliberate trade for velocity.
- **WebSocket for everything** — rejected: SSE is sufficient for log + status + grill push; POST
  answers are simpler than a bidirectional protocol for v1.
- **pm2-managed gateway** — deferred: v1 uses a foreground child process; detached tunnels can add
  `--detach` + pm2 later.
- **`--force` surface-lock steal** — rejected: stale locks after crash are rare; the human can
  remove `<workspace>/.comux/surface.lock` manually.
- **Agent tab includes Broadcast roster** — rejected for v1: Broadcast bypasses orchestration; mixing
  rosters blurs the safety boundary (ADR-0014).
- **REST polling for agent status** — rejected: one SSE connection is simpler for the client.

## Consequences

- New entrypoint: `comux dashboard [--gateway]` in `scripts/harness.ts`, with surface-lock at
  `<workspace>/.comux/surface.lock`.
- New package tree: `dashboard/` with its own install step; CI/typecheck must include it or gate it
  explicitly.
- `src/harness-events.ts` (or equivalent) and refactors to `TurnDeps` grilling hooks so TUI and
  Dashboard share one `runTurn` implementation.
- ROADMAP M6 should be rewritten from "optional Bun web view" to "Dashboard (ADR-0023)" when
  implementation starts.
- Quota/context columns will read **unknown** until ADR-0004/M4 cooldown work ships — the Dashboard
  must not invent rate-limit data.
