#!/usr/bin/env bun
// comux — a local-first AI orchestrator that runs coding agents visibly inside cmux.
//
// A small local model (the Orchestrator, gemma4:12b via Ollama) turns your message into a
// minimal task spec; deterministic code routes coding work to an Agent that runs visibly in a
// new cmux pane, then git-checkpoints the result in the workspace.
//
//   comux                  # workspace defaults to ./workspace (under the current dir)
//   comux /path/to/repo    # use a specific repo as the workspace
//   comux --version | --help
//
// In the TUI:  type to chat · "/" commands · "@" file mentions · ⏎ run · ctrl+c exit

import { homedir } from "node:os";
import { join } from "node:path";
import { identifySelf } from "../src/cmux.ts";
import { ensureWorkspace, readPlan, currentBranch, listFiles } from "../src/workspace.ts";
import { runTurn } from "../src/harness.ts";
import { Tui, type Item } from "../src/tui.ts";
import { lastStats } from "../src/llm.ts";
import { VERSION } from "../src/version.ts";
import { c } from "../src/ui.ts";
import { loadConfig, configExists, configPath, type Config, type ChainKey } from "../src/config.ts";
import { runSetup, detectAgents, type SetupResult } from "../src/setup.ts";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(`comux ${VERSION}`);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      `comux ${VERSION} — local-first AI orchestrator for cmux`,
      "",
      "Usage:",
      "  comux [workspace]   launch the TUI (workspace defaults to ./workspace)",
      "  comux --version     print version and exit",
      "  comux --help        show this help and exit",
      "",
      "Environment:",
      "  COMUX_WORKSPACE   default workspace directory",
      "  COMUX_MODEL       Ollama model (default: gemma4:12b-mlx)",
      "  OLLAMA_HOST       Ollama server URL (default: http://localhost:11434)",
      "  COMUX_YES         auto-approve dispatches (non-interactive)",
      "  COMUX_NO_SANDBOX  disable the macOS write-confinement sandbox",
      "",
      "Needs a running cmux, Ollama serving the model, and an Agent CLI (pi) on PATH.",
    ].join("\n"),
  );
  process.exit(0);
}

const wsArg = args.find((a) => !a.startsWith("-"));
const workspace = await ensureWorkspace(
  wsArg ?? process.env.COMUX_WORKSPACE ?? join(process.cwd(), "workspace"),
);
const selfSurface = await identifySelf();
const model = process.env.COMUX_MODEL ?? "gemma4:12b-mlx";
const autoYes = !!process.env.COMUX_YES;

// First run writes the default per-capability chains; thereafter load what the user has (and may
// have edited). `firstRun` is reported once the header is up.
const firstRun = !configExists();
const firstSetup: SetupResult | null = firstRun ? await runSetup() : null;
let config: Config = firstSetup?.config ?? (await loadConfig());

/** Pretty-print the chains and which Agent CLIs are present. */
function showAgents(): void {
  const installed = new Map(detectAgents().map((a) => [a.name, a.installed]));
  const mark = (n: string) => (installed.get(n) ? c.green(n) : c.red(`${n}✗`));
  let anyMissing = false;
  say(c.gray(`  config: ${configPath()}`));
  for (const [cap, names] of Object.entries(config.chains) as [ChainKey, string[]][]) {
    if (names.some((n) => !installed.get(n))) anyMissing = true;
    say(`  ${c.cyan(cap.padEnd(11))} ${names.map(mark).join(c.gray(" → "))}`);
  }
  if (anyMissing) {
    say(c.gray(`  (${c.red("✗")} = CLI not on PATH; install it or remove it from the chain)`));
  }
}

const commands: Item[] = [
  { name: "/setup", desc: "detect agents & write default chains" },
  { name: "/agents", desc: "show capability chains" },
  { name: "/plan", desc: "show PLAN.md" },
  { name: "/ws", desc: "show workspace path" },
  { name: "/help", desc: "keybindings & commands" },
  { name: "/exit", desc: "quit" },
];

const tilde = (p: string) => (p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p);

function statusBar(): string {
  const loc = `${c.blue(tilde(workspace))} ${c.gray(`(${currentBranch(workspace)})`)}`;
  const ctx = c.gray(
    lastStats.promptTokens != null ? `${lastStats.promptTokens}/256k` : "0/256k",
  );
  const m = c.gray(`(ollama) `) + c.magenta(model);
  const tps =
    lastStats.tokensPerSec != null
      ? c.yellow("⚡ ") + c.gray(`${lastStats.tokensPerSec.toFixed(1)} tok/s`)
      : c.yellow("⚡ ") + c.gray("TPS: --");
  return `${loc}  ${c.gray("·")}  ${ctx}  ${c.gray("·")}  ${m}  ${c.gray("·")}  ${tps}`;
}

const tui = new Tui({ commands, status: statusBar, listFiles: () => listFiles(workspace) });
const say = (m: string) => tui.print(m);
const confirm = async (_summary: string) =>
  autoYes ? true : tui.confirm("อนุมัติแผนนี้แล้วรันทั้งหมดเลยไหม?");

tui.printHeader();
say(c.gray("  workspace: ") + c.blue(tilde(workspace)));
say("");

if (firstSetup) {
  say(c.green("  ✓ first run — wrote default agent chains:"));
  showAgents();
  say(c.gray("  edit that file to customise the order, or /setup to reset · /agents to view."));
  say("");
}

if (!process.stdin.isTTY) {
  say(c.red("  this TUI needs an interactive terminal (run it directly, not piped)."));
  process.exit(0);
}

loop: for (;;) {
  const line = (await tui.readLine())?.trim();
  if (line == null) break; // ctrl+c / ctrl+d
  if (!line) continue;

  switch (line) {
    case "/exit":
    case "/quit":
      break loop;
    case "/help":
      say(c.gray("  /setup  reset chains  ·  /agents  view chains  ·  /plan  PLAN.md  ·  /ws  ·  /exit"));
      say(c.gray("  keys: ↑↓ choose command · ⏎ run · ⇥ complete · esc clear · ctrl+c exit"));
      continue;
    case "/setup": {
      const r = await runSetup();
      config = r.config;
      say(c.green("  ✓ wrote default agent chains:"));
      showAgents();
      continue;
    }
    case "/agents":
      showAgents();
      continue;
    case "/ws":
      say(c.blue(`  ${workspace}`));
      continue;
    case "/plan":
      say(c.gray(await readPlan(workspace)));
      continue;
  }

  try {
    await runTurn(line, { workspace, selfSurface, config, confirm, say });
  } catch (e) {
    say(c.red(`  ⚠ error: ${(e as Error).message}`));
  }
}

console.log(c.gray("bye."));
