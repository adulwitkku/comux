// Dashboard agent roster: deduped chain agents + lifecycle + install status (ADR-0023).

import type { Config } from "./config.ts";
import { AGENT_BINARIES, REGISTRY } from "./agents.ts";
import { detectAgents } from "./setup.ts";
import { readAgentLifecycle, type Lifecycle } from "./lifecycle.ts";

export interface AgentStatusRow {
  name: string;
  binary: string;
  installed: boolean;
  lifecycle: Lifecycle | "none";
  quota: "unknown";
  contextPct: "unknown";
  quota5h: "unknown";
  quotaWeekly: "unknown";
}

function chainAgentNames(config: Config): string[] {
  const names = new Set<string>();
  for (const chain of Object.values(config.chains)) {
    for (const n of chain) names.add(n);
  }
  return [...names].sort();
}

/** Collect status rows for every agent in the capability chains. */
export async function collectAgentStatus(
  config: Config,
  workspace: string,
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
      quota: "unknown",
      contextPct: "unknown",
      quota5h: "unknown",
      quotaWeekly: "unknown",
    });
  }

  return rows;
}
