// Connector to the local Ollama server (the Orchestrator's runtime).
//
// Notes from probing the real `gemma4:12b-mlx`:
//  - It is a "thinking" model; we pass `think: false` to keep the Orchestrator fast and
//    its output clean.
//  - The MLX backend does NOT strictly enforce the `format` JSON schema — it tends to wrap
//    the JSON in a ```json fence. We send the schema as a best-effort hint but parse
//    defensively (see extractJson).

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  baseUrl?: string;
  model?: string;
  /** Best-effort JSON schema passed to Ollama's `format`. */
  format?: unknown;
  /** Disable the model's thinking phase. Default true. */
  think?: boolean;
  temperature?: number;
  timeoutMs?: number;
}

const DEFAULTS = {
  baseUrl: process.env.OLLAMA_HOST ?? "http://localhost:11434",
};

// The Orchestrator model is resolved at startup (COMUX_MODEL env > config.json > default)
// and can be switched at runtime via /model, hence a setter rather than a constant.
let defaultModel = process.env.COMUX_MODEL ?? "gemma4:12b-mlx";

export function setDefaultModel(model: string): void {
  defaultModel = model;
}

/** Model names available on the Ollama server (for the /model picker). */
export async function listModels(baseUrl = DEFAULTS.baseUrl): Promise<string[]> {
  const res = await fetch(`${baseUrl}/api/tags`);
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { models?: { name?: string }[] };
  return (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
}

/** One non-streaming chat completion; returns the assistant message content. */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const baseUrl = opts.baseUrl ?? DEFAULTS.baseUrl;
  const model = opts.model ?? defaultModel;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 120_000);
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        think: opts.think ?? false,
        ...(opts.format ? { format: opts.format } : {}),
        options: { temperature: opts.temperature ?? 0 },
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      message?: { content?: string };
      eval_count?: number;
      eval_duration?: number;
      prompt_eval_count?: number;
    };
    if (data.eval_count && data.eval_duration) {
      lastStats = {
        tokensPerSec: data.eval_count / (data.eval_duration / 1e9),
        evalTokens: data.eval_count,
        promptTokens: data.prompt_eval_count ?? null,
      };
    }
    return data.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

export interface GenStats {
  tokensPerSec: number | null;
  evalTokens: number | null;
  promptTokens: number | null;
}

/** Stats from the most recent `chat` call, for the TUI status bar. */
export let lastStats: GenStats = { tokensPerSec: null, evalTokens: null, promptTokens: null };

/**
 * Pull a single JSON object out of a model response, tolerant of ```json fences and
 * surrounding prose.
 */
export function extractJson<T = unknown>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON object in model output: ${raw.slice(0, 200)}`);
  }
  const parsed: unknown = JSON.parse(body.slice(start, end + 1));
  // The MLX backend sometimes emits object keys with stray surrounding whitespace
  // (e.g. `" task"`, `" capability"`), which would silently miss every field lookup. Trim the
  // top-level keys so callers see the keys they expect (ADR-0008: normalise, don't trust).
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const trimmed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) trimmed[k.trim()] = v;
    return trimmed as T;
  }
  return parsed as T;
}
