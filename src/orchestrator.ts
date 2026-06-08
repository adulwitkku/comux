// The Orchestrator: classify a natural-language message into a Capability (ADR-0006, ADR-0018).
// It is a thin classifier, NOT a planner (ADR-0003), and NOT a replier: every message is
// dispatched (ADR-0018), so there is no "reply vs task" branch any more — only "which Capability".
//
// Stateless per turn (ADR-0003): each call is `system prompt (role + PLAN.md + recent git log) +
// the new user message`. No chat history is accumulated.

import { chat, extractJson, type ChatMessage } from "./llm.ts";
import type { Capability } from "./config.ts";

export interface TaskSpec {
  /** One-line natural-language instruction to dispatch (ADR-0018: always present). */
  task: string;
  /** The kind of work — picks which chain runs. Names WHAT, not WHO (ADR-0006). */
  capability: Capability;
  /** Optional ASCII slug for the markdown artifact on web_search / image. */
  topic: string | null;
  /** ADR-0019: false → the Harness grills the capability choice instead of trusting it. */
  confident: boolean;
  /** ADR-0019: other plausible Capabilities, ranked — the options offered when not confident. */
  alternatives: Capability[];
  /** Optional reasoning, for logging only. */
  thought?: string | null;
}

const CAPABILITIES: Capability[] = ["web_search", "image", "coding", "chat"];

function isCapability(x: unknown): x is Capability {
  return typeof x === "string" && (CAPABILITIES as string[]).includes(x);
}

export interface IntentContext {
  /** Current PLAN.md contents (the Orchestrator's only memory). */
  planMd: string;
  /** Recent `git log` lines, for "what's been done" context. */
  gitLog: string;
  /** CONTEXT.md from the workspace root (project glossary), if present. */
  contextMd?: string | null;
  /** README.md from the workspace root, if present. */
  readmeMd?: string | null;
  model?: string;
  baseUrl?: string;
}

// Best-effort hint to Ollama. The MLX backend does not strictly enforce it, so the
// real guarantee comes from defensive parsing + normalisation below (ADR-0008).
const TASK_SPEC_SCHEMA = {
  type: "object",
  properties: {
    thought: { type: "string" },
    task: { type: "string" },
    capability: { type: "string", enum: ["web_search", "image", "coding", "chat"] },
    topic: { type: ["string", "null"] },
    confident: { type: "boolean" },
    alternatives: { type: "array", items: { type: "string" } },
  },
  required: ["task", "capability"],
} as const;

/** The raw shape we tolerate from the model before normalisation. */
interface RawSpec {
  task?: unknown;
  capability?: unknown;
  topic?: unknown;
  confident?: unknown;
  alternatives?: unknown;
  thought?: unknown;
}

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

/** Optional artifact path when a single-dispatch capability carries a topic. */
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
    "You only CLASSIFY the user's message into a kind of work and reply with a single JSON object:",
    '  { "thought": "<why>", "task": "<English instruction>", "capability": "<kind>",',
    '    "topic": "<slug or null>", "confident": <true|false>, "alternatives": ["<kind>", ...] }',
    "where <kind> is exactly one of:",
    '    "chat"        — the DEFAULT for anything that just wants an answer: greetings, small',
    "                    talk, status questions about this project, explanations, or opinions.",
    "                    Anything that does NOT change files, search the web, or make an image.",
    '    "coding"      — write or modify code/files, build, fix, refactor, or run something',
    '    "web_search"  — look something up on the web or fetch current/external information',
    '    "image"       — generate or edit an image',
    "Examples (message -> capability):",
    '    "สวัสดี" -> chat   ·   "ตอนนี้โปรเจกต์ทำถึงไหนแล้ว" -> chat   ·   "ควรใช้ Postgres ไหม" -> chat',
    '    "เพิ่มปุ่ม dark mode ในหน้า settings" -> coding   ·   "fix the login bug" -> coding',
    '    "ค้นหาราคา iphone ล่าสุด" -> web_search   ·   "วาดโลโก้รูปแมว" -> image',
    "Rules:",
    "- ALWAYS set task and capability (every message is dispatched; there is no direct reply).",
    "- coding requires an explicit request to CREATE or CHANGE something (add, build, fix, write,",
    "  refactor, delete, run). A QUESTION is never coding. Asking 'how far is the project', 'what's",
    "  done', 'what does X do', or 'should we use Y' is a STATUS/opinion question -> chat, even when",
    "  it mentions code or the project. Mentioning the project does NOT make it coding.",
    "- If in doubt between chat and something else, prefer chat unless the user clearly asks to",
    "  build/modify code, search the web, or make an image.",
    "- task is a clear English instruction rephrased from the user's intent, NOT a literal",
    "  word-for-word translation. For chat, task restates what the user wants answered.",
    "- Never name which agent runs it (that is chosen by config).",
    "- confident: set true when the kind is clear (most messages). Only set confident=false when",
    "  the message could genuinely be two different kinds — then list them, best first, in",
    "  alternatives (e.g. [\"coding\",\"chat\"]).",
    '- Optional "topic": a short ASCII slug (e.g. "neighborsoft") for web_search or image when',
    "  a readable summary file would help; otherwise null.",
    "- Output JSON only.",
    "",
    "Current PLAN.md (the source of truth for what is being built and what remains):",
    ctx.planMd.trim() || "(empty)",
    "",
    "Recent commits:",
    ctx.gitLog.trim() || "(none)",
  ].join("\n");
}

function normalise(raw: RawSpec, userInput: string): TaskSpec {
  const task = typeof raw.task === "string" && raw.task.trim() ? raw.task.trim() : userInput.trim();
  const thought = typeof raw.thought === "string" ? raw.thought : null;
  const topicRaw = typeof raw.topic === "string" && raw.topic.trim() ? raw.topic.trim() : null;
  const topic = topicRaw ? slugTopic(topicRaw) || null : null;

  const alternatives = Array.isArray(raw.alternatives)
    ? (raw.alternatives.filter(isCapability) as Capability[])
    : [];

  // ADR-0019: no silent default-to-coding. If the model named a valid capability we use it; if it
  // did not, we DON'T silently route — we mark it not-confident and offer a best guess (the first
  // valid alternative, else coding) for the Harness to grill.
  let capability: Capability;
  let confident: boolean;
  if (isCapability(raw.capability)) {
    capability = raw.capability;
    confident = raw.confident !== false; // default to confident unless the model says otherwise
  } else {
    capability = alternatives[0] ?? "coding";
    confident = false;
  }

  // The chosen capability should not also appear in its own alternatives list.
  const alts = alternatives.filter((c) => c !== capability);
  let cappedTopic = capability === "web_search" || capability === "image" ? topic : null;
  if (!cappedTopic && (capability === "web_search" || capability === "image")) {
    cappedTopic = topicFromTask(task, capability);
  }

  return { task, capability, topic: cappedTopic, confident, alternatives: alts, thought };
}

export async function parseIntent(userInput: string, ctx: IntentContext): Promise<TaskSpec> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(ctx) },
    { role: "user", content: userInput },
  ];
  // NB: we deliberately do NOT pass the JSON `format` schema here. The MLX backend's constrained
  // decoding makes gemma4:12b-mlx emit degenerate specs (everything -> coding, task = the raw input
  // un-rephrased); free-form generation + defensive parse (ADR-0008) classifies far better.
  const content = await chat(messages, { model: ctx.model, baseUrl: ctx.baseUrl, think: false });
  return normalise(extractJson<RawSpec>(content), userInput);
}

/**
 * Handle the `chat` Capability (ADR-0019): the local Orchestrator model itself authors a short
 * markdown reply — no cloud Agent is spun up for "hi". Returns the markdown the Harness writes to
 * the workspace and opens in cmux's viewer.
 */
export async function chatReply(userInput: string, ctx: IntentContext): Promise<string> {
  const docSections: string[] = [];
  if (ctx.contextMd?.trim()) {
    docSections.push("Project glossary (CONTEXT.md):", ctx.contextMd.trim());
  }
  if (ctx.readmeMd?.trim()) {
    docSections.push("", "Project README:", ctx.readmeMd.trim());
  }
  if (!docSections.length) {
    docSections.push("(no project docs found)");
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are the assistant of a local coding harness. Answer the user directly and concisely",
        "as GitHub-flavored Markdown (use headings, lists, tables, code blocks where they help).",
        "Reply in the user's language. Do not invent file changes — this is just conversation.",
        "",
        ...docSections,
        "",
        "Current PLAN.md:",
        ctx.planMd.trim() || "(empty)",
        "",
        "Recent commits:",
        ctx.gitLog.trim() || "(none)",
      ].join("\n"),
    },
    { role: "user", content: userInput },
  ];
  const content = await chat(messages, { model: ctx.model, baseUrl: ctx.baseUrl, think: false });
  return content.trim() || "(no reply)";
}
