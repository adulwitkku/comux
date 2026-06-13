// Headless, cache-only quota probes for Dashboard agent roster (ADR-0024).
// Probes read on-disk snapshots only — they never send prompts to wake usage counters.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

/** Read Cursor statusline cache written by ~/.cursor/statusline.sh (or comux docs). */
async function probeCursor(): Promise<ProbeResult> {
  const path = quotaCachePath("cursor");
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

type ProbeFn = () => Promise<ProbeResult>;

const PROBES: Partial<Record<string, ProbeFn>> = {
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
