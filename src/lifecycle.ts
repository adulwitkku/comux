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
  lastBody?: string;
  lastSubtitle?: string;
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

function sessionUpdatedAt(
  sessionId: string,
  entry: SessionEntry,
  updatedAt: Map<string, number>,
): number {
  return (
    updatedAt.get(sessionId) ??
    entry.startedAt ??
    entry.launchCommand?.capturedAt ??
    0
  );
}

function findWorkspaceSession(
  data: HookSessionsFile,
  workspace: string,
  launchedAtMs?: number,
): SessionEntry | null {
  const sessions = data.sessions ?? {};
  const updatedAt = new Map<string, number>();
  for (const w of Object.values(data.activeSessionsByWorkspace ?? {})) {
    if (w?.sessionId) updatedAt.set(w.sessionId, w.updatedAt ?? 0);
  }

  const target = real(workspace);
  let best: { entry: SessionEntry; at: number } | null = null;
  for (const [sessionId, entry] of Object.entries(sessions)) {
    if (!entry?.cwd || real(entry.cwd) !== target) continue;
    const at = sessionUpdatedAt(sessionId, entry, updatedAt);
    if (!best || at >= best.at) best = { entry, at };
  }

  if (!best && launchedAtMs !== undefined) {
    const sinceSec = launchedAtMs / 1000;
    for (const [sessionId, entry] of Object.entries(sessions)) {
      const startedAt = entry.startedAt ?? entry.launchCommand?.capturedAt ?? 0;
      if (startedAt < sinceSec) continue;
      const at = sessionUpdatedAt(sessionId, entry, updatedAt);
      if (!best || at >= best.at) best = { entry, at };
    }
  }

  return best?.entry ?? null;
}

/** Freshest hook session for this agent (any workspace) — quota hints are account-level. */
function findLatestSession(data: HookSessionsFile): SessionEntry | null {
  const sessions = data.sessions ?? {};
  const updatedAt = new Map<string, number>();
  for (const w of Object.values(data.activeSessionsByWorkspace ?? {})) {
    if (w?.sessionId) updatedAt.set(w.sessionId, w.updatedAt ?? 0);
  }

  let best: { entry: SessionEntry; at: number } | null = null;
  for (const [sessionId, entry] of Object.entries(sessions)) {
    const at = sessionUpdatedAt(sessionId, entry, updatedAt);
    if (!best || at >= best.at) best = { entry, at };
  }
  return best?.entry ?? null;
}

async function readHookSessions(hookName: string): Promise<HookSessionsFile | null> {
  const path = join(homedir(), ".cmuxterm", `${hookName}-hook-sessions.json`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as HookSessionsFile;
  } catch {
    return null;
  }
}

export interface AgentHookHints {
  lastBody?: string;
  lastSubtitle?: string;
}

/** Latest notification body/subtitle from cmux hooks (any workspace). */
export async function readAgentHookHints(hookName: string): Promise<AgentHookHints | null> {
  const data = await readHookSessions(hookName);
  if (!data) return null;
  const entry = findLatestSession(data);
  if (!entry) return null;
  return { lastBody: entry.lastBody, lastSubtitle: entry.lastSubtitle };
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
  const data = await readHookSessions(hookName);
  if (!data) return null;
  const entry = findWorkspaceSession(data, workspace, launchedAtMs);
  return entry ? normaliseLifecycle(entry.agentLifecycle) : null;
}
