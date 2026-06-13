# Dashboard agent quota probes (display-only)

The Dashboard Agent tab lists the **Dashboard agent roster** (deduped chain agents). Lifecycle
and PATH refresh automatically every ~5s via cmux hook sessions and `detectAgents()`. Context
window usage and rate-limit windows (5h / 7d) are **not** available from cmux hooks — they come
from per-Agent **quota probes** triggered on demand.

## Decision

Introduce `src/agent-probes.ts`: a registry of headless, **cache-only** probes that read
on-disk snapshots without sending prompts to Agents. Probes exist for **cursor** and **claude**
(statusline tee) and **codex** (session-log parse); the local-model Agents (**pi**, **opencode**,
**agy**) have no cloud quota and intentionally stay at **—**. Other Agents show **—** until a
probe is added.

- **`POST /api/agents/refresh`** — run registered probes in parallel (~15s timeout per Agent),
  merge results into roster rows, return `{ agents, refreshedAt }`.
- **Periodic `agent_status` SSE** — lifecycle + PATH only; quota fields persist from the last
  Refresh until the next one.
- **Display-only** — probes do not mark **Cooldown** or change the **Scheduler**.

## Statusline-tee probes (cursor, claude)

Cursor and Claude Code both pass a JSON **statusline payload** to a user script on stdin
whenever context or rate limits update, but neither persists it to a stable path comux can read.
Each probe reads `~/.config/comux/quota-cache/<agent>.json`, populated by teeing stdin in the
statusline script (one line after `input=$(cat)`):

```bash
mkdir -p ~/.config/comux/quota-cache
printf '%s' "$input" > ~/.config/comux/quota-cache/cursor.json   # or claude.json
```

If the file is missing or empty, the probe succeeds with **`noData: true`** — the UI shows
`(no data yet)`. comux **never** runs the Agent CLI to wake usage counters. Both share one schema
— `context_window.used_percentage`, `rate_limits.five_hour` / `seven_day` with `used_percentage`
and `resets_at` — so a single parser handles both. (The tee captures the raw stdin payload, which
carries `context_window` even when the script's own rendered line does not use it.)

## Codex probe (session-log parse)

Codex has no statusline-tee hook: its `status_line` config drives only Codex's own TUI, and its
notify/hooks events carry notification text, not structured usage. But Codex **already persists**
rate limits — it writes a `token_count` event to its rollout session JSONL every turn:

```json
{"type":"token_count","rate_limits":{
  "primary":  {"used_percent":1.0, "window_minutes":300,   "resets_at":1781159939},
  "secondary":{"used_percent":49.0,"window_minutes":10080, "resets_at":1781147783}}}
```

The probe reads the **most-recently-modified** session under `~/.codex/sessions/**/*.jsonl`,
takes the **last** `token_count.rate_limits` entry, and maps `primary` → 5h, `secondary` → 7d
(`used_percent` → `usedPct`, `resets_at` → `resetIn`). No config tee is required — this works on
an unmodified Codex install.

Because this is a **snapshot from the last turn** (not live like the tee probes), a window's
`used_percent` goes stale once its `resets_at` passes. The probe therefore reports **0%** for any
window whose `resets_at` is in the past — Codex resets on that schedule, so a lapsed window is
empty. Codex exposes no context-window total, so its Context column stays **—**.

## API shape

`AgentStatusRow.quota`:

- `contextPct`, `fiveHour`, `sevenDay` — structured numbers + `resetIn` strings
- `noData` — probe ran, cache empty
- `probeError` — probe failed (invalid JSON, timeout)

## Considered options

- **Parse cmux hook `lastBody`** — rejected for quota %: hooks carry notification text, not
  structured usage; kept only for lifecycle.
- **Headless ping to wake counters** — rejected: side-effectful, costs tokens/API calls.
- **Read running pane via `cmux read-screen`** — rejected: fragile OCR-style parsing; not
  headless.
- **Wire probes into Scheduler Cooldown** — deferred: display-only in v1; Cooldown remains M4.
- **Tee a Codex statusline like cursor/claude** — rejected: Codex has no statusline-tee hook;
  parsing the session log it already writes avoids asking the user to edit any config.

## Consequences

- Users who want Cursor or Claude quota on the Dashboard must add the cache tee to that Agent's
  statusline script. Codex needs no setup — its probe reads the session log it writes anyway.
- The local-model Agents (pi, opencode, agy) have no cloud quota and stay at **—** by design.
- Further Agents extend the probe registry incrementally.
- ADR-0023 Agent tab footnote is superseded for quota columns.
