// Offline gate for the multi-agent config layer: the per-capability chains, the Agent registry,
// and /setup detection. No cmux/Ollama/Agents needed, so it runs in CI.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point XDG at a temp dir BEFORE the config module resolves any paths.
const xdg = mkdtempSync(join(tmpdir(), "comux-cfg-"));
process.env.XDG_CONFIG_HOME = xdg;

const { DEFAULT_CHAINS, loadConfig, saveConfig, configExists, configPath } = await import("../src/config.ts");
const { REGISTRY, agentByName, AGENT_BINARIES, pi } = await import("../src/agents.ts");
const { detectAgents } = await import("../src/setup.ts");

function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
}

try {
  // --- every chain references a real Agent (drift guard between config and the registry) ---
  const referenced = new Set(Object.values(DEFAULT_CHAINS).flat());
  const unknown = [...referenced].filter((n) => !agentByName(n));
  ok("every agent in DEFAULT_CHAINS exists in the registry", unknown.length === 0, unknown.join(",") || undefined);
  ok("registry and binary map cover the same agents", Object.keys(REGISTRY).sort().join() === Object.keys(AGENT_BINARIES).sort().join());

  // --- the four capability chains are present ---
  const keys = Object.keys(DEFAULT_CHAINS).sort().join();
  ok("chains cover web_search/image/planning/coding", keys === "coding,image,planning,web_search", keys);

  // --- buildCommand embeds the binary and the (quoted) task ---
  const cmd = pi.buildCommand("make a thing", "/tmp/ws-x");
  ok("buildCommand includes the CLI and the task", cmd.includes("pi -p --no-session") && cmd.includes("make a thing"));

  // --- detection returns a status for each known agent ---
  const detected = detectAgents();
  ok("detectAgents reports every known agent", detected.length === Object.keys(AGENT_BINARIES).length);

  // --- config save → load roundtrip in the temp XDG dir ---
  ok("no config before setup", !configExists());
  const custom = { chains: { ...DEFAULT_CHAINS, coding: ["pi", "claude"] } };
  const path = await saveConfig(custom);
  ok("saveConfig writes under XDG_CONFIG_HOME", path.startsWith(xdg) && configExists(), path);
  const loaded = await loadConfig();
  ok("loadConfig roundtrips the edited coding chain", loaded.chains.coding.join() === "pi,claude");
  ok("loadConfig keeps defaults for untouched chains", loaded.chains.planning.join() === DEFAULT_CHAINS.planning.join());

  // --- a bad name resolves to nothing (caller skips it) ---
  ok("agentByName('nope') is undefined", agentByName("nope") === undefined);
  void configPath;
} finally {
  rmSync(xdg, { recursive: true, force: true });
}
