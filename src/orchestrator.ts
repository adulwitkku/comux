// The Orchestrator: turn natural-language input into a minimal task spec (ADR-0006).
// It is a thin intent-parser, NOT a planner (ADR-0003): it decides only "reply vs
// dispatch" and the one-line instruction — never which Agent runs it (that is the
// Scheduler's job, ADR-0004).
//
// Stateless per turn (ADR-0003): each call is `system prompt (role + PLAN.md + recent git
// log) + the new user message`. No chat history is accumulated.

import { chat, extractJson, type ChatMessage } from "./llm.ts";

/** Exactly one of `reply` / `task` is non-null after normalisation. */
export interface TaskSpec {
  /** Text answer shown to the user (Orchestrator handles it itself). */
  reply: string | null;
  /** One-line natural-language instruction to dispatch to an Agent. */
  task: string | null;
  /** Optional reasoning, for logging only. */
  thought?: string | null;
}

export interface IntentContext {
  /** Current PLAN.md contents (the Orchestrator's only memory). */
  planMd: string;
  /** Recent `git log` lines, for "what's been done" context. */
  gitLog: string;
  model?: string;
  baseUrl?: string;
}

// Best-effort hint to Ollama. The MLX backend does not strictly enforce it, so the
// real guarantee comes from defensive parsing + normalisation below.
const TASK_SPEC_SCHEMA = {
  type: "object",
  properties: {
    thought: { type: "string" },
    reply: { type: ["string", "null"] },
    task: { type: ["string", "null"] },
  },
  required: ["reply", "task"],
} as const;

export function buildSystemPrompt(ctx: IntentContext): string {
  return [
    "You are the Orchestrator of a coding harness. You do NOT write code or plan work.",
    "You only classify the user's message into ONE of two actions and reply with a single JSON object:",
    '  - { "reply": "<text>", "task": null }   when you can answer directly or the user is just chatting',
    '  - { "reply": null, "task": "<one-line instruction>" }   when coding work must be handed to an agent',
    "Exactly one of reply/task is non-null. Never choose which agent runs it. Output JSON only.",
    "",
    "Current PLAN.md (the source of truth for what is being built and what remains):",
    ctx.planMd.trim() || "(empty)",
    "",
    "Recent commits:",
    ctx.gitLog.trim() || "(none)",
  ].join("\n");
}

function normalise(raw: TaskSpec): TaskSpec {
  const task = typeof raw.task === "string" && raw.task.trim() ? raw.task.trim() : null;
  const reply = typeof raw.reply === "string" && raw.reply.trim() ? raw.reply.trim() : null;
  // Enforce "exactly one": a concrete task wins; otherwise fall back to reply.
  if (task) return { reply: null, task, thought: raw.thought ?? null };
  if (reply) return { reply, task: null, thought: raw.thought ?? null };
  return {
    reply: "ขอโทษครับ ผมไม่แน่ใจว่าต้องทำอะไร ช่วยบอกใหม่อีกครั้งได้ไหม",
    task: null,
    thought: raw.thought ?? null,
  };
}

export async function parseIntent(userInput: string, ctx: IntentContext): Promise<TaskSpec> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(ctx) },
    { role: "user", content: userInput },
  ];
  const content = await chat(messages, {
    model: ctx.model,
    baseUrl: ctx.baseUrl,
    format: TASK_SPEC_SCHEMA,
    think: false,
  });
  return normalise(extractJson<TaskSpec>(content));
}
