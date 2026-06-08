// User configuration: per-capability Agent chains. The Orchestrator classifies a message into
// a Capability (what kind of work); deterministic code then walks that Capability's chain — the
// ordered preference of Agents — picking the first available one and falling to the next when
// one is unavailable (ADR-0004). This keeps "names work, not who" intact: the model picks the
// Capability, config picks the chain, the Scheduler picks the Agent.
//
// Config lives at ~/.config/comux/config.json (XDG). `/setup` writes a default; the user edits
// the chains by hand (reordering Agent names).

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

/** A chain is keyed by the kind of work. `planning` is internal to the coding flow. */
export type ChainKey = "web_search" | "image" | "planning" | "coding" | "chat";

/** What the Orchestrator routes a dispatched message to (ADR-0018: every message dispatches). */
export type Capability = "web_search" | "image" | "coding" | "chat";

export interface Config {
  /** Ordered Agent names (most-preferred first) per kind of work. */
  chains: Record<ChainKey, string[]>;
  /**
   * Bypass mode (ADR-0016), default ON: auto-answer every Grilling decision (permission,
   * plan-is-ready, question) so a job runs end-to-end with zero human gates. When OFF, the
   * Harness still auto-picks any recommended option and escalates only the no-recommendation
   * case to the human.
   */
  bypass: boolean;
}

/**
 * The default chains. Agent names must exist in the registry. `chat` (ADR-0019) is handled by
 * the local Orchestrator model itself, not an Agent chain, so its chain is empty — it is listed
 * only to keep the config shape uniform across Capabilities.
 */
export const DEFAULT_CHAINS: Record<ChainKey, string[]> = {
  web_search: ["pi", "agy"],
  planning: ["claude", "codex", "pi"],
  image: ["codex", "agy"],
  coding: ["cursor", "codex", "claude", "agy", "opencode", "pi"],
  chat: [],
};

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "comux");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function configExists(): boolean {
  return existsSync(configPath());
}

/** Load config from disk, or fall back to the defaults when absent/unreadable. */
export async function loadConfig(): Promise<Config> {
  try {
    const raw = JSON.parse(await readFile(configPath(), "utf8")) as Partial<Config>;
    return {
      chains: { ...DEFAULT_CHAINS, ...(raw.chains ?? {}) },
      bypass: raw.bypass ?? true, // ADR-0016: Bypass mode is default ON
    };
  } catch {
    return { chains: { ...DEFAULT_CHAINS }, bypass: true };
  }
}

/** Write `config` to disk (creating ~/.config/comux), returning the path written. */
export async function saveConfig(config: Config): Promise<string> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2) + "\n");
  return configPath();
}
