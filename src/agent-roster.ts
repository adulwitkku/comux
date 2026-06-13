// Dashboard agent roster: deduped chain agents + lifecycle + install status (ADR-0023/0024).

import type { Config } from "./config.ts";
import { AGENT_BINARIES, REGISTRY } from "./agents.ts";
import { detectAgents } from "./setup.ts";
import { readAgentLifecycle, type Lifecycle } from "./lifecycle.ts";
import {
  hasQuotaProbe,
  runQuotaProbes,
  type QuotaSnapshot,
  type ProbeResult,
} from "./agent-probes.ts";

export interface QuotaWindowSnapshot {
  usedPct: number | null;
  resetIn: string | null;
}

/** Quota fields on a roster row — populated by Refresh (ADR-0024). */
export interface AgentQuotaView {
  contextPct: number | null;
  fiveHour: QuotaWindowSnapshot | null;
  sevenDay: QuotaWindowSnapshot | null;
  /** Probe ran but cache empty (e.g. Cursor before first API call). */
  noData: boolean;
  /** Set when a registered probe fails; absent when no probe or success. */
  probeError: string | null;
}

export interface AgentStatusRow {
  name: string;
  binary: string;
  installed: boolean;
  lifecycle: Lifecycle | "none";
  quota: AgentQuotaView;
}

const EMPTY_QUOTA: AgentQuotaView = {
  contextPct: null,
  fiveHour: null,
  sevenDay: null,
  noData: false,
  probeError: null,
};

function chainAgentNames(config: Config): string[] {
  const names = new Set<string>();
  for (const chain of Object.values(config.chains)) {
    for (const n of chain) names.add(n);
  }
  return [...names].sort();
}

function snapshotToQuotaView(result: ProbeResult): AgentQuotaView {
  if (!result.ok) {
    return { ...EMPTY_QUOTA, probeError: result.error };
  }
  const s = result.snapshot;
  return {
    contextPct: s.contextPct,
    fiveHour: s.fiveHour,
    sevenDay: s.sevenDay,
    noData: s.noData ?? false,
    probeError: null,
  };
}

export function mergeQuotaIntoRows(
  rows: AgentStatusRow[],
  probes: Map<string, ProbeResult>,
): AgentStatusRow[] {
  return rows.map((row) => {
    const result = probes.get(row.name);
    if (!result) return row;
    return { ...row, quota: snapshotToQuotaView(result) };
  });
}

/** Collect lifecycle + PATH rows (no quota probes). */
export async function collectAgentStatus(
  config: Config,
  workspace: string,
  quotaByAgent?: Map<string, AgentQuotaView>,
): Promise<AgentStatusRow[]> {
  const installed = new Map(detectAgents().map((a) => [a.name, a.installed]));
  const rows: AgentStatusRow[] = [];

  for (const name of chainAgentNames(config)) {
    const agent = REGISTRY[name];
    const hookName = agent?.hookName ?? name;
    const lifecycle = agent
      ? ((await readAgentLifecycle(hookName, workspace)) ?? "none")
      : "none";

    rows.push({
      name,
      binary: AGENT_BINARIES[name] ?? name,
      installed: installed.get(name) ?? false,
      lifecycle,
      quota: quotaByAgent?.get(name) ?? { ...EMPTY_QUOTA },
    });
  }

  return rows;
}

/** Run headless quota probes and return refreshed rows + timestamp. */
export async function refreshAgentQuotas(
  config: Config,
  workspace: string,
): Promise<{ agents: AgentStatusRow[]; refreshedAt: number }> {
  const names = chainAgentNames(config);
  const probeTargets = names.filter(hasQuotaProbe);
  const probes = await runQuotaProbes(probeTargets);

  const quotaByAgent = new Map<string, AgentQuotaView>();
  for (const [name, result] of probes) {
    quotaByAgent.set(name, snapshotToQuotaView(result));
  }

  const agents = await collectAgentStatus(config, workspace, quotaByAgent);
  return { agents, refreshedAt: Date.now() };
}

export type { QuotaSnapshot };
