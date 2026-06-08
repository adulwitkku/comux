// Read an Agent's lifecycle from cmux's hook session store (ADR-0015).
//
// `cmux hooks setup` makes each Agent report its lifecycle to cmux, which records it in
// ~/.cmuxterm/<hookName>-hook-sessions.json. We read that file and match the session by its
// working directory (the workspace we launched the Agent in), returning its lifecycle:
//
//   running     — the Agent is working
//   idle        — the Agent finished its turn (the completion signal a non-exiting TUI never
//                 gave us via the exit sentinel — see agent-runner.ts)
//   needsInput  — the Agent is blocked on a decision (handled by Grilling / Bypass — ADR-0016)
//
// Best-effort and defensive: the file shape is cmux's, may be absent (hooks not installed → we
// fall back to the exit sentinel), and is parsed tolerantly. NOT yet validated against a live
// run for every Agent — the shape below mirrors an observed claude-hook-sessions.json.

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";

export type Lifecycle = "running" | "idle" | "needsInput" | "unknown";

interface SessionEntry {
  agentLifecycle?: string;
  cwd?: string;
  startedAt?: number;
  launchCommand?: { capturedAt?: number };
}

interface HookSessionsFile {
  activeSessionsByWorkspace?: Record<string, { sessionId?: string; updatedAt?: number }>;
  sessions?: Record<string, SessionEntry>;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function normaliseLifecycle(raw: string | undefined): Lifecycle {
  switch (raw) {
    case "running":
    case "idle":
    case "needsInput":
      return raw;
    default:
      return "unknown";
  }
}

/**
 * The lifecycle of `hookName`'s most-recently-updated session whose cwd is `workspace`, or null
 * when the file is absent/unreadable or no session matches (caller falls back to the sentinel).
 *
 * `launchedAtMs` (milliseconds): when provided and no cwd match is found, fall back to the
 * most-recently-updated session whose `startedAt` is after the launch time. This handles agents
 * like cursor-agent that always report a fixed cwd (~/.cursor) regardless of the workspace they
 * were launched in.
 */
export async function readAgentLifecycle(
  hookName: string,
  workspace: string,
  launchedAtMs?: number,
): Promise<Lifecycle | null> {
  const path = join(homedir(), ".cmuxterm", `${hookName}-hook-sessions.json`);
  let data: HookSessionsFile;
  try {
    data = JSON.parse(await readFile(path, "utf8")) as HookSessionsFile;
  } catch {
    return null;
  }

  const sessions = data.sessions ?? {};
  // sessionId -> updatedAt, so we can pick the freshest session for this workspace.
  const updatedAt = new Map<string, number>();
  for (const w of Object.values(data.activeSessionsByWorkspace ?? {})) {
    if (w?.sessionId) updatedAt.set(w.sessionId, w.updatedAt ?? 0);
  }

  const target = real(workspace);
  let best: { lifecycle: Lifecycle; at: number } | null = null;
  for (const [sessionId, entry] of Object.entries(sessions)) {
    if (!entry?.cwd || real(entry.cwd) !== target) continue;
    const at = updatedAt.get(sessionId) ?? entry.launchCommand?.capturedAt ?? 0;
    if (!best || at >= best.at) {
      best = { lifecycle: normaliseLifecycle(entry.agentLifecycle), at };
    }
  }

  // Fallback for agents that always report a fixed cwd (cursor → ~/.cursor): find the
  // most-recently-updated session whose startedAt is after we launched the agent.
  if (!best && launchedAtMs !== undefined) {
    const sinceSec = launchedAtMs / 1000;
    for (const [sessionId, entry] of Object.entries(sessions)) {
      const startedAt = entry.startedAt ?? entry.launchCommand?.capturedAt ?? 0;
      if (startedAt < sinceSec) continue;
      const at = updatedAt.get(sessionId) ?? startedAt;
      if (!best || at >= best.at) {
        best = { lifecycle: normaliseLifecycle(entry.agentLifecycle), at };
      }
    }
  }

  return best?.lifecycle ?? null;
}
