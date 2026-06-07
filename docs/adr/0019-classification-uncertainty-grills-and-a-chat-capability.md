# Classifier uncertainty becomes a Grilling decision; a `chat` Capability handled by the local model

With ADR-0018 the Orchestrator is a pure classifier — but it is a small local model
(`gemma4:12b-mlx`, temp 0, stateless), and it does misclassify. Today `normalise()` papers over
that by **silently defaulting an unknown/garbled capability to `coding`**, which is the reported
"Orchestrator picks the wrong type" symptom: a `web_search`, `image`, or greeting gets dropped into
the coding chain. Two changes fix this without pretending a 12B model can be made infallible.

**Uncertainty grills instead of guessing.** The classifier emits its top `capability` plus a
`confident` flag and ranked `alternatives` (added to the existing JSON, read with the defensive
parse of ADR-0008). When it is not confident, the Harness surfaces the capability choice as a
Grilling decision (ADR-0016) whose **recommended** option is the model's top guess: Bypass ON takes
that guess (so autonomy is preserved, but the route is the model's actual best pick, not a blanket
`coding`); Bypass OFF lets the human choose. The silent default-to-`coding` is removed.

**A `chat` Capability, run by the local model.** Greetings, small talk, and direct questions need a
home now that there is no reply branch (ADR-0018). Rather than spin up a cloud Agent to answer "hi",
`chat` is handled by the **local Orchestrator model itself**, which writes a short markdown reply the
Harness opens like any other artifact. The local model thus wears two hats — classifier and the
`chat` handler — keeping trivial conversation cheap and local-first while every other Capability
dispatches to an Agent chain.

## Considered Options

- **Keep default-to-`coding`, just improve the prompt / add few-shot** — cheapest, and worth doing
  anyway, but a 12B classifier will still misroute; a silent wrong default is the worst failure
  because the user only finds out once a coder is running on a search request.
- **Deterministic keyword heuristics as the tiebreaker** — fragile across languages (the UI is
  Thai+English) and an endless rule list; kept at most as a minor nudge, not the mechanism.
- **A bigger / cloud classifier** — rejected: breaks the local-first, low-cost stance (ADR-0010);
  the grill makes a modest local model good enough by asking when unsure.
- **Route `chat` to a real Agent (uniform with ADR-0018)** — consistent but heavy: every "hi" would
  launch an Agent pane. Rejected in favour of the local model handling `chat` directly.

## Consequences

- Refines ADR-0018: the local model is not purely a classifier — it also authors the `chat`
  Capability's markdown reply. "Every message dispatches and the answer is markdown" still holds;
  for `chat` the handler happens to be the local model rather than a cloud Agent.
- `buildSystemPrompt` / `normalise` (`src/orchestrator.ts`) need rework: drop the obsolete reply
  branch, add the fourth Capability, emit `confident` / `alternatives`, and remove the
  default-to-`coding` fallback.
- `chat` needs a chain entry in config like the other Capabilities, even though its "Agent" is the
  local model — so the config shape stays uniform.
