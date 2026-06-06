// Agent registry. Each Agent knows how to turn a task instruction into a shell command
// that runs it non-interactively in its working directory. Picking WHICH agent runs is the
// Scheduler's job (ADR-0004), still a placeholder until M4; the registry holds the Agents the
// Scheduler will choose between (today: pi and Claude Code, used together by the M5 handover).
//
// Every built command is run through `confine` so the Agent can only write inside its
// workspace repo (ADR-0005).

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

// pi runs the task non-interactively with its read/bash/edit/write tools, then exits —
// which trips the exit-code sentinel in runAgentStep. It is visible in the pane meanwhile.
export const pi: Agent = {
  name: "pi",
  buildCommand: (task, cwd) =>
    confine(`cd ${shq(cwd)} && pi -p --no-session ${shq(task)}`, cwd),
};

// Claude Code runs headless with -p. `--dangerously-skip-permissions` is acceptable here
// because the real write boundary is the sandbox (ADR-0005), not Claude's own permission gate;
// confined, it can still only write inside the workspace.
export const claudeCode: Agent = {
  name: "claude",
  buildCommand: (task, cwd) =>
    confine(`cd ${shq(cwd)} && claude -p ${shq(task)} --dangerously-skip-permissions`, cwd),
};

export const AGENTS: Agent[] = [pi, claudeCode];

/** Placeholder until M4's availability scheduler exists: always the first agent. */
export function selectAgent(): Agent {
  return AGENTS[0]!;
}
