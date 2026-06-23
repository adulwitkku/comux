// `/setup`: detect which Agent CLIs are installed and write the default per-capability chains to
// ~/.config/comux/config.json. The user then edits the chains by hand (reordering Agent names).
// Re-running /setup rewrites the defaults; it does not merge over hand edits.

import { AGENT_BINARIES } from "./agents.ts";
import { DEFAULT_BROADCAST_ROSTER, DEFAULT_CHAINS, DEFAULT_PROVIDERS, loadConfig, saveConfig, type Config } from "./config.ts";

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
  /** Whether `cmux hooks setup` ran cleanly (ADR-0015: hooks feed completion detection). */
  hooksInstalled: boolean;
}

/**
 * Install cmux agent hooks (ADR-0015) so cmux tracks each Agent's lifecycle (idle / needsInput)
 * and the Feed publishes its decisions — the signal the Harness keys completion off. Best-effort:
 * cmux skips Agents whose binary is not on PATH and prints its own summary.
 */
export async function installCmuxHooks(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["cmux", "hooks", "setup", "--yes"], { stdout: "pipe", stderr: "pipe" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function runSetup(): Promise<SetupResult> {
  const agents = detectAgents();
  const installed = new Set(agents.filter((a) => a.installed).map((a) => a.name));

  const existing = await loadConfig().catch(() => null);
  const config: Config = {
    chains: structuredClone(DEFAULT_CHAINS),
    bypass: true,
    broadcast: existing?.broadcast ?? { roster: structuredClone(DEFAULT_BROADCAST_ROSTER) },
    // ADR-0025: pre-seed cloud Providers (Groq) but stay on Ollama until /model picks one.
    // Preserve any the user has added/edited.
    providers: existing?.providers ?? structuredClone(DEFAULT_PROVIDERS),
    ...(existing?.provider ? { provider: existing.provider } : {}),
    ...(existing?.model ? { model: existing.model } : {}),
  };

  const missing = new Set<string>();
  for (const names of Object.values(config.chains)) {
    for (const n of names) if (!installed.has(n)) missing.add(n);
  }

  const hooksInstalled = await installCmuxHooks();
  const path = await saveConfig(config);
  return { path, agents, missingInChains: [...missing], config, hooksInstalled };
}
