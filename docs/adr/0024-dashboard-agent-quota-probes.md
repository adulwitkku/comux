# Dashboard agent quota probes (display-only)

The Dashboard Agent tab lists the **Dashboard agent roster** (deduped chain agents). Lifecycle
and PATH refresh automatically every ~5s via cmux hook sessions and `detectAgents()`. Context
window usage and rate-limit windows (5h / 7d) are **not** available from cmux hooks — they come
from per-Agent **quota probes** triggered on demand.

## Decision

Introduce `src/agent-probes.ts`: a registry of headless, **cache-only** probes that read
on-disk snapshots without sending prompts to Agents. v1 implements **cursor** only; other Agents
show **—** until a probe is added.

- **`POST /api/agents/refresh`** — run registered probes in parallel (~15s timeout per Agent),
  merge results into roster rows, return `{ agents, refreshedAt }`.
- **Periodic `agent_status` SSE** — lifecycle + PATH only; quota fields persist from the last
  Refresh until the next one.
- **Display-only** — probes do not mark **Cooldown** or change the **Scheduler**.

## Cursor probe (v1)

Cursor CLI passes a JSON **statusline payload** to `~/.cursor/statusline.sh` on stdin whenever
context or rate limits update. Cursor does not persist that payload to a stable path comux can
read. The probe therefore reads:

`~/.config/comux/quota-cache/cursor.json`

Populate it by teeing stdin in the statusline script (one line after `input=$(cat)`):

```bash
mkdir -p ~/.config/comux/quota-cache
printf '%s' "$input" > ~/.config/comux/quota-cache/cursor.json
```

If the file is missing or empty, the probe succeeds with **`noData: true`** — the UI shows
`(no data yet)`. comux **never** runs `cursor-agent -p` or similar to wake usage counters.

Schema matches Cursor statusline: `context_window.used_percentage`,
`rate_limits.five_hour` / `seven_day` with `used_percentage` and `resets_at`.

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

## Consequences

- Users who want Cursor quota on the Dashboard must add the cache tee to their statusline script.
- Additional Agents (claude `/usage`, codex cache, etc.) extend the probe registry incrementally.
- ADR-0023 Agent tab footnote is superseded for quota columns.
