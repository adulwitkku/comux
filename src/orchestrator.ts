// The Orchestrator: turn natural-language input into a minimal task spec (ADR-0006).
// It is a thin intent-parser, NOT a planner (ADR-0003): it decides only "reply vs
// dispatch" and the one-line instruction — never which Agent runs it (that is the
// Scheduler's job, ADR-0004).
//
// Stateless per turn (ADR-0003): each call is `system prompt (role + PLAN.md + recent git
// log) + the new user message`. No chat history is accumulated.

import { chat, extractJson, type ChatMessage } from "./llm.ts";
import type { Capability } from "./config.ts";

/** Exactly one of `reply` / `task` is non-null after normalisation. */
export interface TaskSpec {
  /** Text answer shown to the user (Orchestrator handles it itself). */
  reply: string | null;
  /** One-line natural-language instruction to dispatch to an Agent. */
  task: string | null;
  /** The kind of work — picks which chain runs (non-null iff `task` is). Names WHAT, not WHO. */
  capability: Capability | null;
  /** Optional reasoning, for logging only. */
  thought?: string | null;
}

const CAPABILITIES: Capability[] = ["web_search", "image", "coding"];

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
    capability: { type: ["string", "null"], enum: ["web_search", "image", "coding", null] },
  },
  required: ["reply", "task"],
} as const;

export function buildSystemPrompt(ctx: IntentContext): string {
  return [
    "You are the Orchestrator of an agent harness. You do NOT write code, search, or plan work.",
    "You only classify the user's message and reply with a single JSON object:",
    '  - { "reply": "<text>", "task": null, "capability": null }   answer directly or just chatting',
    '  - { "reply": null, "task": "<one-line instruction>", "capability": "<kind>" }   hand work to an agent',
    "where <kind> is exactly one of:",
    '    "coding"      — write or modify code/files, build or fix something',
    '    "web_search"  — look something up on the web or fetch current information',
    '    "image"       — generate or edit an image',
    "Exactly one of reply/task is non-null; capability is non-null iff task is. Never name which",
    "agent runs it (that is chosen by config). Output JSON only.",
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
  if (task) {
    // Default an unknown/missing capability to coding — the most common dispatched work.
    const capability = CAPABILITIES.includes(raw.capability as Capability)
      ? (raw.capability as Capability)
      : "coding";
    return { reply: null, task, capability, thought: raw.thought ?? null };
  }
  if (reply) return { reply, task: null, capability: null, thought: raw.thought ?? null };
  return {
    reply: "ขอโทษครับ ผมไม่แน่ใจว่าต้องทำอะไร ช่วยบอกใหม่อีกครั้งได้ไหม",
    task: null,
    capability: null,
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
