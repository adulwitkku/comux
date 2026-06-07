# Every message dispatches to an Agent whose answer is a markdown artifact; browser is a mid-run tool

Two product observations drive this: TUI panes render images, tables, and charts badly, so the
user wants every answer readable in cmux's markdown viewer; and the user wants Agents to open a
real browser to test the web apps they build. Both reshape how output and tools work.

**Output model.** The Orchestrator's direct-reply branch (ADR-0006's `reply`, ADR-0010's "chat vs
job" front door) is removed. **Every** message — even "hi" — is classified into a Capability and
dispatched to an Agent; the Agent writes its answer to a markdown file in the workspace, and the
Harness opens it in cmux's markdown viewer when the Agent reaches `idle` (ADR-0015). Markdown is
now the **universal answer surface**, not the optional artifact of ADR-0013. The Orchestrator
shrinks to a pure capability classifier, exactly the reducible role ADR-0010 anticipated; the Task
spec collapses from `{reply, task, capability}` to `{task, capability}`.

**Browser.** cmux's browser automation (`cmux browser …`) is exposed to Agents as a **tool used
mid-run**, not a new Capability — so the Orchestrator stays thin (ADR-0006) and the interactive
snapshot→click→re-snapshot loop stays with the Agent that needs it. Of the three skills that
prompted Phase 3, only **cmux-browser** is given to Agents: **cmux-markdown** is unnecessary
(Agents just write a file; the Harness opens it — keeping cmux driving on the Harness side per
ADR-0007), and **cmux-core** topology is unnecessary (the Harness already lays out panes).

## Considered Options

- **Keep the Orchestrator's direct reply; render replies as markdown** — cheaper for "hi", no Agent
  spin-up. Rejected by choice: the user wants one uniform path (classify → dispatch → markdown),
  even at the cost of dispatching trivial chat.
- **Markdown only for tasks, chat stays in the TUI** — rejected: same uniformity reason.
- **Browser as a fourth Capability** — rejected: it is a verification/research tool used during a
  coding or web_search run, not a user intent worth its own routing branch.
- **Give Agents the full cmux/cmux-markdown skills** — rejected as redundant: markdown is a
  file-write + Harness open; only browser genuinely needs Agent→cmux access.

## Consequences

- Amends ADR-0006 (Task spec loses `reply`) and ADR-0010 (no chat-vs-job front door; Orchestrator
  is now purely a classifier). Supersedes ADR-0013's "markdown artifacts are optional": every
  dispatch must produce one.
- A conversational message still needs *a* Capability to route to; classification must cover the
  "just talk back in markdown" case (open: whether that reuses an existing chain or needs a light
  conversational capability).
- Needs a defined output convention (filename/location) so the Harness knows which markdown to open
  per dispatch — left to implementation.
- Browser is Agent-dependent: skill-capable Agents (e.g. `claude`) can use cmux-browser; others may
  not. Graceful degradation, not uniform availability — the browser tool belongs to whichever
  Agents in a chain can load the skill.
