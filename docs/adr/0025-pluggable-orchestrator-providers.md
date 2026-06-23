# Orchestrator runs on a pluggable Provider, not Ollama only

The **Orchestrator** (ADR-0006) was synonymous with "the local Ollama model": `llm.ts` was
hardwired to Ollama's `/api/chat` shape (`think`, `options.temperature`, `format`) and discovered
models via `/api/tags`. We split the **role** (Orchestrator: classify + write the `chat` reply)
from the **backend** (**Provider**). Config now carries a `provider` field naming the one active
Provider and a `providers[]` list of **OpenAI-compatible cloud Providers**, each with a
`baseUrl`, an `apiKeyEnv`, and a default `model`. Ollama remains the native, default backend on
its own path; Groq (`https://api.groq.com/openai/v1`, `GROQ_API_KEY`, default `qwen/qwen3.6-27b`)
ships **pre-seeded** but inactive. `/model` lists Ollama models and each cloud Provider's models
(live-fetched from its `/models` when its key is present, else just the configured default).

A Provider serves **only** the Orchestrator's chat completions. It is **not** an **Agent**: it has
no tools and can never satisfy a `coding` / `web_search` / `image` Capability. A Groq-hosted model
can still be used for coding *indirectly*, as a model behind the `opencode` Agent CLI — for that we
add a Broadcast slot only (`opencode --model groq/...`), leaving the capability chains untouched.

## Considered Options

- **Groq as an Agent** — rejected: Agents launch as interactive TUIs with file-editing tools in a
  cmux pane (ADR-0001); a raw HTTP chat endpoint has neither. The only role Groq's API physically
  fits is the Orchestrator backend. (Coding *through* Groq is delegated to `opencode`.)
- **A Groq-specific branch in `llm.ts`** — rejected: contradicts the stated goal of *being able to
  add providers*; the 4th provider would need another branch. The generic OpenAI-compatible list
  makes adding Together/OpenRouter/etc. a config edit, not a code change.
- **Single prefixed model string** (`groq/qwen/qwen3.6-27b`) — rejected: Groq model names already
  contain `/`, so a combined string is ambiguous to parse. A separate `provider` field + per-
  Provider `model` is unambiguous.
- **Silent fallback to Ollama when the cloud key is missing** — rejected: the Orchestrator runs on
  every message; silently swapping the backend the user explicitly chose hides a real
  misconfiguration. A missing/invalid key is a hard, named error directing the user to `/model`.

## Consequences

- `llm.ts` gains a thin per-Provider adapter (Ollama `/api/chat` vs OpenAI `/v1/chat/completions`,
  `Authorization: Bearer`, `choices[0].message.content`). `setDefaultModel` is joined by Provider
  selection; `COMUX_PROVIDER` overrides `config.provider` as `COMUX_MODEL` overrides the model.
- Cloud Providers do not expose Ollama's `think`/`format`; JSON output stays defended by
  `extractJson` (ADR-0008), with `response_format: {type:"json_object"}` sent best-effort.
- `CONTEXT.md` gains the **Provider** term; **Orchestrator** is reworded from "the local model" to
  "the role, served by a Provider".
- Open implementation item: opencode's exact Groq model string must be confirmed against a live
  `opencode models` before the Broadcast slot ships.
