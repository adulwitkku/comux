// Agent registry. Each Agent knows how to turn a task instruction into a shell command that
// runs it non-interactively in its working directory. WHICH Agent runs is decided by the
// Scheduler walking a Capability's chain (ADR-0004, src/scheduler.ts); this file only defines
// the Agents the chains can name.
//
// Every built command is run through `confine` so the Agent can only write inside its workspace
// repo (ADR-0005). Agents that gate tool use behind their own permission prompt are told to
// skip it: the sandbox is the real write boundary here, not the Agent's prompt.

import { confine } from "./sandbox.ts";

export interface Agent {
  name: string;
  /** Build the shell command that launches the agent against `task` inside `cwd`. */
  buildCommand(task: string, cwd: string): string;
}

/** Single-quote a string for safe use inside a shell command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Build an Agent from a launch-command template (everything is confined to `cwd`). */
function agent(name: string, launch: (taskq: string) => string): Agent {
  return {
    name,
    buildCommand: (task, cwd) => confine(`cd ${shq(cwd)} && ${launch(shq(task))}`, cwd),
  };
}

// pi runs the task non-interactively with its read/bash/edit/write tools, then exits.
export const pi = agent("pi", (t) => `pi -p --no-session ${t}`);

// Claude Code, headless. --dangerously-skip-permissions is safe because the sandbox is the real
// write boundary (ADR-0005), not Claude's own permission gate.
export const claudeCode = agent("claude", (t) => `claude -p ${t} --dangerously-skip-permissions`);

// agy, headless (same shape as Claude Code).
export const agy = agent("agy", (t) => `agy -p ${t} --dangerously-skip-permissions`);

// Codex, non-interactive. The bypass flag is intended for externally-sandboxed environments —
// which is exactly our `sandbox-exec` confinement.
export const codex = agent("codex", (t) => `codex exec --dangerously-bypass-approvals-and-sandbox ${t}`);

// Cursor CLI, headless. --force (a.k.a. --yolo) auto-approves commands.
export const cursor = agent("cursor", (t) => `cursor-agent -p --force ${t}`);

// opencode, non-interactive run.
export const opencode = agent("opencode", (t) => `opencode run ${t}`);

/** Every Agent the chains may reference, keyed by the name used in config. */
export const REGISTRY: Record<string, Agent> = {
  pi,
  claude: claudeCode,
  agy,
  codex,
  cursor,
  opencode,
};

/** Look up an Agent by the name used in a chain; undefined if unknown. */
export function agentByName(name: string): Agent | undefined {
  return REGISTRY[name];
}

/** The shell command each Agent's CLI is invoked as (for `/setup` availability detection). */
export const AGENT_BINARIES: Record<string, string> = {
  pi: "pi",
  claude: "claude",
  agy: "agy",
  codex: "codex",
  cursor: "cursor-agent",
  opencode: "opencode",
};
