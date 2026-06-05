# Agents run as visible interactive panes; failure detection is out-of-band

Agents run as their real interactive TUI inside a cmux pane so the user can watch
work happen live. We deliberately reject headless invocation even though it would
give cleaner machine-readable output, because direct visibility into the agent's
progress is a primary product requirement.

Because the visible TUI text stream is not a reliable control signal, failure/quota
detection is kept separate from what the user sees. Detection relies, in priority
order, on: (1) process exit code, (2) a watchdog timeout (no new output for N seconds),
and (3) a small, per-agent, tested set of sentinel strings for known quota/limit
messages. We explicitly reject loose regex matching on words like `Error`/`Limit`,
because killing a healthy agent mid-task is more expensive (it forces a risky handover)
than letting it run slightly too long. Detection therefore biases toward false-negatives.

The first task is fed via the agent's launch argument (e.g. `claude "task..."`), not
keystroke injection, to avoid fragile TUI timing while still showing the real TUI.

## Considered Options

- **Headless + stream-json** — most robust control, rejected: hides live progress from the user.
- **PTY keystroke injection + regex scan** (original PRD) — rejected: fragile input and false-positive kills.
