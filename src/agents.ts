// Agent registry. Each Agent knows how to turn a task instruction into a shell command that
// runs it in its working directory. WHICH Agent runs is decided by the Scheduler walking a
// Capability's chain (ADR-0004, src/scheduler.ts); this file only defines the Agents the chains
// can name.
//
// Every Agent launches as its real interactive TUI in a cmux pane (ADR-0001, ADR-0012). The
// English task is seeded via the launch argument; completion is detected out-of-band (exit
// sentinel + watchdog), not from the visible screen.
//
// Every built command is run through `confine` so the Agent can only write inside its workspace
// repo (ADR-0005). Agents that gate tool use behind their own permission prompt are told to
// skip it: the sandbox is the real write boundary here, not the Agent's prompt.

import { confine } from "./sandbox.ts";

/** How Broadcast (ADR-0014) delivers text into an Agent's TUI — TUIs disagree on this. */
export type PasteMode = "bracketed" | "buffer" | "typed";

export interface Agent {
  name: string;
  /**
   * The agent name cmux uses for its hooks / lifecycle file (ADR-0015). Usually equal to `name`;
   * differs where cmux's hook name differs from comux's registry key (e.g. agy → antigravity).
   * The lifecycle lives in `~/.cmuxterm/<hookName>-hook-sessions.json`.
   */
  hookName: string;
  /** Build the shell command that launches the agent against `task` inside `cwd` (confined). */
  buildCommand(task: string, cwd: string): string;
  // --- Broadcast mode (ADR-0014): bare interactive launch + how to type into its TUI. ---
  // These are unused by the orchestrated flow, which only calls buildCommand.
  /** Bare interactive launch: no task seed, no exit sentinel, no `confine`. */
  openCommand: string;
  /** How Broadcast pushes text into this Agent's running TUI. */
  pasteMode: PasteMode;
  /** Key that submits a message in this TUI (after the text is delivered). */
  submitKey: string;
  /** Key that inserts a newline without submitting (only used by pasteMode "typed"). */
  newlineKey: string;
}

/** Per-Agent overrides for the Broadcast launch/send profile (sensible defaults otherwise). */
interface BroadcastProfile {
  openCommand?: string;
  pasteMode?: PasteMode;
  submitKey?: string;
  newlineKey?: string;
  /** cmux hook/lifecycle name when it differs from the registry key (ADR-0015). */
  hookName?: string;
}

/** Single-quote a string for safe use inside a shell command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Build an Agent from a launch-command template (everything is confined to `cwd`). */
function agent(name: string, launch: (taskq: string) => string, b: BroadcastProfile = {}): Agent {
  return {
    name,
    hookName: b.hookName ?? name,
    buildCommand: (task, cwd) => confine(`cd ${shq(cwd)} && ${launch(shq(task))}`, cwd),
    openCommand: b.openCommand ?? name,
    pasteMode: b.pasteMode ?? "bracketed",
    submitKey: b.submitKey ?? "enter",
    newlineKey: b.newlineKey ?? "shift+enter",
  };
}

// pi — runs the task non-interactively with its tools, then exits. Its TUI takes text typed
// line-by-line (Enter submits, Shift+Enter is a newline), so Broadcast types rather than pastes.
export const pi = agent("pi", (t) => `pi -p --no-session ${t}`, { pasteMode: "typed" });

// Claude Code — interactive by default; skip its permission gate (sandbox is the boundary).
export const claudeCode = agent("claude", (t) => `claude ${t} --dangerously-skip-permissions`);

// agy — runs the task non-interactively with its tools, then exits. cmux tracks it under its
// full name "antigravity" (agy is an alias), so its lifecycle file is antigravity-hook-sessions.
export const agy = agent("agy", (t) => `agy -p ${t} --dangerously-skip-permissions`, {
  hookName: "antigravity",
});

// Codex — interactive CLI; bypass flag is for externally-sandboxed environments (our confinement).
export const codex = agent("codex", (t) => `codex ${t} --dangerously-bypass-approvals-and-sandbox`);

// Cursor CLI — interactive with --force (yolo) so the sandbox is the real gate. Its TUI needs a
// buffer paste (set-buffer + paste-buffer) rather than bracketed input. The CLI ships as two
// symlinks to the same binary: `cursor-agent` and the shorter `agent` (the `cursor` command is the
// GUI, not the CLI). We register both names so a chain can use whichever the user has on PATH.
export const cursor = agent("cursor", (t) => `cursor-agent --force ${t}`, {
  openCommand: "cursor-agent",
  pasteMode: "buffer",
});

// `agent` — same Cursor CLI, invoked by its short symlink name (some installs only expose this).
export const cursorAgent = agent("agent", (t) => `agent --force ${t}`, {
  hookName: "cursor",
  openCommand: "agent",
  pasteMode: "buffer",
});

// opencode — interactive TUI with an initial --prompt.
export const opencode = agent("opencode", (t) => `opencode --prompt ${t}`);

/** Every Agent the chains may reference, keyed by the name used in config. */
export const REGISTRY: Record<string, Agent> = {
  pi,
  claude: claudeCode,
  agy,
  codex,
  cursor,
  agent: cursorAgent,
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
  agent: "agent",
  opencode: "opencode",
};
