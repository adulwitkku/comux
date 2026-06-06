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
  model: process.env.HARNESS_MODEL ?? "gemma4:12b-mlx",
};

/** One non-streaming chat completion; returns the assistant message content. */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const baseUrl = opts.baseUrl ?? DEFAULTS.baseUrl;
  const model = opts.model ?? DEFAULTS.model;
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
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

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
  return JSON.parse(body.slice(start, end + 1)) as T;
}
