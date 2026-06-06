// `/setup`: detect which Agent CLIs are installed and write the default per-capability chains to
// ~/.config/comux/config.json. The user then edits the chains by hand (reordering Agent names).
// Re-running /setup rewrites the defaults; it does not merge over hand edits.

import { AGENT_BINARIES } from "./agents.ts";
import { DEFAULT_CHAINS, saveConfig, type Config } from "./config.ts";

export interface AgentStatus {
  name: string;
  binary: string;
  installed: boolean;
  path: string | null;
}

/** Probe PATH for every known Agent CLI. */
export function detectAgents(): AgentStatus[] {
  return Object.entries(AGENT_BINARIES).map(([name, binary]) => {
    const path = Bun.which(binary);
    return { name, binary, installed: path != null, path };
  });
}

export interface SetupResult {
  path: string;
  agents: AgentStatus[];
  /** Agent names referenced by a chain whose CLI is not installed. */
  missingInChains: string[];
  config: Config;
}

export async function runSetup(): Promise<SetupResult> {
  const agents = detectAgents();
  const installed = new Set(agents.filter((a) => a.installed).map((a) => a.name));

  const config: Config = { chains: structuredClone(DEFAULT_CHAINS) };

  const missing = new Set<string>();
  for (const names of Object.values(config.chains)) {
    for (const n of names) if (!installed.has(n)) missing.add(n);
  }

  const path = await saveConfig(config);
  return { path, agents, missingInChains: [...missing], config };
}
