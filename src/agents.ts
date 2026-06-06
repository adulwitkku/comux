// Agent registry. Each Agent knows how to turn a task instruction into a shell command
// that runs it non-interactively in its working directory. Picking WHICH agent runs is the
// Scheduler's job (ADR-0004); for M3 there is a single agent and a placeholder selector.

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
    `cd ${shq(cwd)} && pi -p --no-session ${shq(task)}`,
};

export const AGENTS: Agent[] = [pi];

/** Placeholder until M4's availability scheduler exists: always the first agent. */
export function selectAgent(): Agent {
  return AGENTS[0]!;
}
