# Parse the Orchestrator's JSON defensively; do not rely on structured-output enforcement

Ollama supports passing a JSON schema as `format` to constrain output. With the chosen
runtime (`gemma4:12b-mlx`, an MLX-backed thinking model) that enforcement is **not** strict:
in practice the model wraps its JSON in a ```json fence, emits its reasoning in a separate
`thinking` field, and may omit schema-required keys.

So the harness treats `format` as a best-effort hint only. The real guarantees come from the
code: `extractJson` pulls the first `{...}` out of fenced/prose output, and `normalise`
enforces the "exactly one of reply/task" invariant (a concrete task wins; otherwise reply;
otherwise a clarifying fallback). We also pass `think: false` to keep the Orchestrator fast
and its output clean.

A future reader tempted to "just trust Ollama structured outputs" and delete the defensive
parsing should know it was removed deliberately because this model/runtime does not honour
the schema strictly.
