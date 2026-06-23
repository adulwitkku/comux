// Local secret store for cloud Provider API keys (ADR-0025). Keys entered via `/key` are kept
// out of the main config.json — they live in their own 0600 file, keyed by the env-var name the
// Provider reads (`apiKeyEnv`, e.g. GROQ_API_KEY). At startup the file is applied to process.env so
// a saved key just works without `export`; a key already in the real environment wins (so an
// `export` or CI secret still overrides the on-disk copy).

import { join } from "node:path";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { configDir } from "./config.ts";

export function secretsPath(): string {
  return join(configDir(), "secrets.json");
}

/** Read the on-disk secrets map ({ ENV_VAR_NAME: value }); empty on any error. */
export async function loadSecrets(): Promise<Record<string, string>> {
  try {
    if (!existsSync(secretsPath())) return {};
    const raw = JSON.parse(await readFile(secretsPath(), "utf8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Persist one secret (creating ~/.config/comux), writing the file 0600. Returns its path. */
export async function setSecret(name: string, value: string): Promise<string> {
  await mkdir(configDir(), { recursive: true });
  const all = await loadSecrets();
  all[name] = value;
  const path = secretsPath();
  await writeFile(path, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600); // enforce perms even if the file pre-existed with looser bits
  return path;
}

/** Apply saved secrets to process.env, without clobbering values already set in the environment. */
export async function applySecretsToEnv(): Promise<void> {
  const all = await loadSecrets();
  for (const [name, value] of Object.entries(all)) {
    if (process.env[name] == null) process.env[name] = value;
  }
}
