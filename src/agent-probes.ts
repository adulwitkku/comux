// Headless, cache-only quota probes for Dashboard agent roster (ADR-0024).
// Probes read on-disk snapshots only — they never send prompts to wake usage counters.

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir } from "./config.ts";

export interface QuotaWindowSnapshot {
  usedPct: number | null;
  /** Human-readable time until reset, e.g. "2h 15m". */
  resetIn: string | null;
}

export interface QuotaSnapshot {
  contextPct: number | null;
  fiveHour: QuotaWindowSnapshot | null;
  sevenDay: QuotaWindowSnapshot | null;
  /** True when a probe ran but found no cached payload yet (Cursor before first API call). */
  noData?: boolean;
}

export type ProbeResult =
  | { ok: true; snapshot: QuotaSnapshot }
  | { ok: false; error: string };

/** Cursor statusline stdin payload (subset). */
interface CursorStatuslinePayload {
  context_window?: {
    used_percentage?: number | null;
  };
  rate_limits?: {
    five_hour?: { used_percentage?: number | null; resets_at?: number | string | null };
    seven_day?: { used_percentage?: number | null; resets_at?: number | string | null };
  };
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

function quotaCachePath(agent: string): string {
  return join(configDir(), "quota-cache", `${agent}.json`);
}

function roundPct(raw: number | null | undefined): number | null {
  if (raw == null || Number.isNaN(raw)) return null;
  return Math.round(raw);
}

/** Format Unix epoch (seconds or ms) → relative reset string. */
export function formatResetIn(resetsAt: number | string | null | undefined): string | null {
  if (resetsAt == null || resetsAt === "") return null;
  const epoch =
    typeof resetsAt === "string"
      ? Number.parseFloat(resetsAt)
      : resetsAt > 1e12
        ? resetsAt / 1000
        : resetsAt;
  if (!Number.isFinite(epoch)) return null;
  const diffSec = Math.floor(epoch - Date.now() / 1000);
  if (diffSec <= 0) return "now";
  const h = Math.floor(diffSec / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function windowFrom(
  raw: { used_percentage?: number | null; resets_at?: number | string | null } | undefined,
): QuotaWindowSnapshot | null {
  if (!raw) return null;
  const usedPct = roundPct(raw.used_percentage ?? null);
  const resetIn = formatResetIn(raw.resets_at ?? null);
  if (usedPct == null && resetIn == null) return null;
  return { usedPct, resetIn };
}

function parseCursorPayload(raw: string): QuotaSnapshot {
  let data: CursorStatuslinePayload;
  try {
    data = JSON.parse(raw) as CursorStatuslinePayload;
  } catch {
    throw new Error("invalid cursor quota cache JSON");
  }

  const contextPct = roundPct(data.context_window?.used_percentage ?? null);
  const fiveHour = windowFrom(data.rate_limits?.five_hour);
  const sevenDay = windowFrom(data.rate_limits?.seven_day);
  const hasAny = contextPct != null || fiveHour != null || sevenDay != null;

  return {
    contextPct,
    fiveHour,
    sevenDay,
    ...(hasAny ? {} : { noData: true }),
  };
}

async function readQuotaCache(agent: string): Promise<ProbeResult> {
  const path = quotaCachePath(agent);
  if (!existsSync(path)) {
    return {
      ok: true,
      snapshot: { contextPct: null, fiveHour: null, sevenDay: null, noData: true },
    };
  }
  try {
    const raw = (await readFile(path, "utf8")).trim();
    if (!raw) {
      return {
        ok: true,
        snapshot: { contextPct: null, fiveHour: null, sevenDay: null, noData: true },
      };
    }
    return { ok: true, snapshot: parseCursorPayload(raw) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Read Cursor statusline cache written by ~/.cursor/statusline.sh (or comux docs). */
const probeCursor = () => readQuotaCache("cursor");

/** Read Claude statusline cache written by ~/.claude/statusline-command.sh. */
const probeClaude = () => readQuotaCache("claude");

// --- Codex probe: parse the session log Codex already writes (ADR-0024) ---------------------
// Unlike cursor/claude, Codex has no statusline-tee hook. It writes a `token_count` event with
// `rate_limits` to its rollout session JSONL every turn, so we read the most-recent session and
// take the last such entry. This works on an unmodified Codex install (no config tee needed).

/** A Codex rate-limit window: `primary` = 5h, `secondary` = 7d. */
interface CodexRateWindow {
  used_percent?: number | null;
  window_minutes?: number | null;
  resets_at?: number | string | null;
}

interface CodexTokenCountPayload {
  type?: string;
  info?: {
    total_token_usage?: {
      total_tokens?: number | null;
    } | null;
    last_token_usage?: {
      input_tokens?: number | null;
    } | null;
    model_context_window?: number | null;
  } | null;
  rate_limits?: {
    primary?: CodexRateWindow | null;
    secondary?: CodexRateWindow | null;
  } | null;
}

const codexSessionsDir = () => join(homedir(), ".codex", "sessions");

/** Recursively collect `*.jsonl` session files under Codex's sessions dir. */
async function listCodexSessions(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listCodexSessions(full)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/** Codex session files newest-first by mtime. */
async function codexSessionsByMtime(): Promise<string[]> {
  const files = await listCodexSessions(codexSessionsDir());
  const stamped: { path: string; mtimeMs: number }[] = [];
  for (const path of files) {
    try {
      stamped.push({ path, mtimeMs: (await stat(path)).mtimeMs });
    } catch {
      // file vanished between listing and stat — skip it.
    }
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stamped.map((s) => s.path);
}

/**
 * How many recent sessions to scan back for a rate-limit entry. The newest session by mtime is
 * often one comux just opened for lifecycle (no turn yet, so no `token_count`); we walk back to
 * the most recent session that actually carries usage. Capped so a long history stays cheap.
 */
const CODEX_SESSION_SCAN_LIMIT = 20;

/**
 * A window reported in a past turn goes stale once its reset passes: Codex resets on that
 * schedule, so a lapsed window is empty (0%), not still-full at the old percentage.
 */
function codexWindow(raw: CodexRateWindow | null | undefined): QuotaWindowSnapshot | null {
  if (!raw) return null;
  const resetIn = formatResetIn(raw.resets_at ?? null);
  const lapsed = resetIn === "now";
  const usedPct = lapsed ? 0 : roundPct(raw.used_percent ?? null);
  if (usedPct == null && resetIn == null) return null;
  return { usedPct, resetIn: lapsed ? null : resetIn };
}

function codexContextPct(info: CodexTokenCountPayload["info"]): number | null {
  const inputTokens = info?.last_token_usage?.input_tokens;
  const contextWindow = info?.model_context_window;
  if (
    inputTokens == null ||
    contextWindow == null ||
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round((inputTokens / contextWindow) * 100)));
}

/** Extract the last `token_count.rate_limits` entry from a session's JSONL lines. */
function parseCodexSession(raw: string): QuotaSnapshot {
  let latest: CodexTokenCountPayload | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("token_count")) continue;
    try {
      const evt = JSON.parse(trimmed) as { payload?: CodexTokenCountPayload };
      const p = evt.payload;
      if (p?.type === "token_count" && (p.rate_limits || p.info)) latest = p;
    } catch {
      // tolerate a truncated/partial final line.
    }
  }

  const contextPct = codexContextPct(latest?.info ?? null);
  const fiveHour = codexWindow(latest?.rate_limits?.primary);
  const sevenDay = codexWindow(latest?.rate_limits?.secondary);
  const hasAny = contextPct != null || fiveHour != null || sevenDay != null;
  return {
    contextPct,
    fiveHour,
    sevenDay,
    ...(hasAny ? {} : { noData: true }),
  };
}

const NO_DATA: QuotaSnapshot = { contextPct: null, fiveHour: null, sevenDay: null, noData: true };

async function probeCodex(): Promise<ProbeResult> {
  try {
    const sessions = await codexSessionsByMtime();
    for (const path of sessions.slice(0, CODEX_SESSION_SCAN_LIMIT)) {
      const raw = (await readFile(path, "utf8")).trim();
      if (!raw) continue;
      const snapshot = parseCodexSession(raw);
      // Walk back past freshly-opened sessions that have no rate-limit entry yet.
      if (!snapshot.noData) return { ok: true, snapshot };
    }
    return { ok: true, snapshot: NO_DATA };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

type ProbeFn = () => Promise<ProbeResult>;

const PROBES: Partial<Record<string, ProbeFn>> = {
  claude: probeClaude,
  codex: probeCodex,
  cursor: probeCursor,
};

export function hasQuotaProbe(agentName: string): boolean {
  return agentName in PROBES;
}

export async function runQuotaProbe(
  agentName: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const fn = PROBES[agentName];
  if (!fn) {
    return {
      ok: true,
      snapshot: { contextPct: null, fiveHour: null, sevenDay: null },
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<ProbeResult>((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timeout")), timeoutMs);
      }),
    ]);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run probes for the given agent names in parallel. */
export async function runQuotaProbes(
  agentNames: string[],
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<Map<string, ProbeResult>> {
  const unique = [...new Set(agentNames.filter(hasQuotaProbe))];
  const entries = await Promise.all(
    unique.map(async (name) => [name, await runQuotaProbe(name, timeoutMs)] as const),
  );
  return new Map(entries);
}
