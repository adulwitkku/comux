# Optional Thai markdown artifacts for `web_search` and `image` single dispatches

> **Status:** superseded by ADR-0018 — markdown output is no longer optional or single-dispatch-only;
> every dispatch produces a markdown artifact the Harness opens. The artifact-naming detail here is
> still a useful reference.

`web_search` and `image` are **single dispatches** down their Capability chains (ADR-0011).
The user watches the Agent in its pane; that visible work is the primary experience. Either
dispatch may **also** leave an optional **Thai markdown summary** in the workspace as a
readable artifact — opened with `cmux markdown open` when the file exists. **Absence of the
file is not a failure.**

When the Orchestrator includes an optional **`topic`** slug on the task spec, the artifact
path is deterministic:

- `web_search` → `search_<topic>.md`
- `image` → `image_<topic>.md`

The English `task` string names this optional artifact when `topic` is present (e.g. "save a
Thai summary as `search_neighborsoft.md`"). The Orchestrator still names **what** to do, not
**who** does it (ADR-0006); file naming is part of the dispatched instruction, not Agent
selection.

After a successful single dispatch the Harness:

1. Checkpoints if the workspace changed.
2. If `topic` was set and the expected path exists, runs `cmux markdown open <file>` so the
   user can read the result without hunting the pane scrollback.

Single dispatches do **not** use the coding PLAN-walk or its plan-approval gate. Coding jobs
keep approve-once on PLAN.md via a separate `confirmPlan()` path (ADR-0005).

## Considered Options

- **Pane-only deliverable** — simplest, rejected: users want a stable artifact they can re-read;
  pane scrollback is ephemeral.
- **Mandatory file + Acceptance check** — rejected: turns a lookup into a mini PLAN-walk; too
  heavy for "search the web".
- **Harness appends file instructions** — keeps the Orchestrator thinner, rejected: the English
  `task` already rephrases intent; co-locating the optional-file instruction there keeps one
  prompt the Agent sees.
- **Newest `.md` in workspace** — rejected: non-deterministic; Harness would not know which file
  to open.

## Consequences / open

- `topic` is **optional**; when omitted the Harness does not probe for or open an artifact path.
- `src/cmux.ts` needs a `markdown open` wrapper (validated against the real CLI like other
  cmux calls).
- Task-spec schema gains an optional `topic` field; Orchestrator prompt must document when to
  emit it.
- Image generation may also produce binary assets; the markdown file is a *summary* artifact,
  not a substitute for the image itself.
