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
  /** Optional ASCII slug for optional markdown artifacts on web_search / image (ADR-0013). */
  topic: string | null;
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
    topic: { type: ["string", "null"] },
  },
  required: ["reply", "task"],
} as const;

/** Normalise a topic slug to a safe filename segment. */
export function slugTopic(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Optional artifact path when a single-dispatch capability carries a topic (ADR-0013). */
export function artifactFilename(capability: "web_search" | "image", topic: string): string {
  const prefix = capability === "web_search" ? "search" : "image";
  return `${prefix}_${topic}.md`;
}

/** Parse a topic slug from an English task that names search_<topic>.md / image_<topic>.md. */
export function topicFromTask(task: string, capability: "web_search" | "image"): string | null {
  const prefix = capability === "web_search" ? "search" : "image";
  const match = task.match(new RegExp(`${prefix}_([a-z0-9_-]+)\\.md`, "i"));
  if (!match?.[1]) return null;
  return slugTopic(match[1]) || null;
}

/** Best-effort topic from the user's raw message (Orchestrator may omit the JSON field). */
export function inferTopicFromInput(input: string): string | null {
  const patterns = [
    /(?:ค้นหา(?:เว็บ)?|ค้นหาข้อมูล(?:เกี่ยวกับ)?)\s*(\S+)/i,
    /search(?:\s+(?:the\s+)?web\s+for)?\s+(\S+)/i,
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match?.[1]) {
      const slug = slugTopic(match[1]);
      if (slug) return slug;
    }
  }
  return null;
}

/** Resolve topic from spec fields, task text, or the user's message. */
export function resolveTopic(spec: TaskSpec, userInput?: string): string | null {
  if (spec.capability !== "web_search" && spec.capability !== "image") return null;
  if (spec.topic) return spec.topic;
  if (spec.task) {
    const fromTask = topicFromTask(spec.task, spec.capability);
    if (fromTask) return fromTask;
  }
  if (userInput) {
    const fromInput = inferTopicFromInput(userInput);
    if (fromInput) return fromInput;
  }
  return null;
}

export function buildSystemPrompt(ctx: IntentContext): string {
  return [
    "You are the Orchestrator of an agent harness. You do NOT write code, search, or plan work.",
    "You only classify the user's message and reply with a single JSON object:",
    '  - { "reply": "<text>", "task": null, "capability": null, "topic": null }   answer directly or just chatting',
    '  - { "reply": null, "task": "<English instruction>", "capability": "<kind>", "topic": "<slug or null>" }   hand work to an agent',
    "where <kind> is exactly one of:",
    '    "coding"      — write or modify code/files, build or fix something',
    '    "web_search"  — look something up on the web or fetch current information',
    '    "image"       — generate or edit an image',
    "Rules:",
    "- Exactly one of reply/task is non-null; capability is non-null iff task is.",
    "- Dispatched task strings are always in English: a clear instruction rephrased from the",
    "  user's intent, not a literal word-for-word translation.",
    "- Never name which agent runs it (that is chosen by config).",
    '- Optional "topic": a short ASCII slug (e.g. "neighborsoft") for web_search or image when',
    "  a readable summary file would help. When topic is set, the English task must ask the agent",
    "  to optionally save a Thai markdown summary as search_<topic>.md (web_search) or",
    "  image_<topic>.md (image). Omit topic (null) when no summary file is needed.",
    "- Output JSON only.",
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
  const thought = raw.thought ?? null;
  const topicRaw = typeof raw.topic === "string" && raw.topic.trim() ? raw.topic.trim() : null;
  const topic = topicRaw ? slugTopic(topicRaw) || null : null;

  // Enforce "exactly one": a concrete task wins; otherwise fall back to reply.
  if (task) {
    // Default an unknown/missing capability to coding — the most common dispatched work.
    const capability = CAPABILITIES.includes(raw.capability as Capability)
      ? (raw.capability as Capability)
      : "coding";
    let cappedTopic =
      capability === "web_search" || capability === "image" ? topic : null;
    if (!cappedTopic && (capability === "web_search" || capability === "image")) {
      cappedTopic = topicFromTask(task, capability);
    }
    return { reply: null, task, capability, topic: cappedTopic, thought };
  }
  if (reply) return { reply, task: null, capability: null, topic: null, thought };
  return {
    reply: "ขอโทษครับ ผมไม่แน่ใจว่าต้องทำอะไร ช่วยบอกใหม่อีกครั้งได้ไหม",
    task: null,
    capability: null,
    topic: null,
    thought,
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
