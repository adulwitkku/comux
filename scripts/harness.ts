#!/usr/bin/env bun
// comux — a local-first AI orchestrator that runs coding agents visibly inside cmux.
//
// A small local model (the Orchestrator, gemma4:12b via Ollama) turns your message into a
// minimal task spec; deterministic code routes coding work to an Agent that runs visibly in a
// new cmux pane, then git-checkpoints the result in the workspace.
//
//   comux                  # workspace = $COMUX_WORKSPACE or ./workspace (under the current dir)
//   comux all [send|new|update|close]  # Broadcast: roster grid (see comux all --help)
//   comux --version | --help
//
// In the TUI:  type to chat · "/" commands · "@" file mentions · alt+⏎ newline · ⏎ run · ctrl+c exit

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { identifySelf, identifyContext, closeSurface, findResultSurface, openMarkdown, openFile, renameTab, type SurfaceRef } from "../src/cmux.ts";
import { runBroadcast, parseBroadcastArgs, runBroadcastUpdate, runBroadcastClose, BROADCAST_ALL_HELP } from "../src/broadcast.ts";
import { runUpdate } from "../src/update.ts";
import { runWorkspaceCommand } from "../src/workspace-save.ts";
import { ensureWorkspace, readPlan, currentBranch, listFiles, clearChatFiles, listComuxFiles } from "../src/workspace.ts";
import { runTurn } from "../src/harness.ts";
import { startFeedWatcher } from "../src/feed.ts";
import { Tui, type Item } from "../src/tui.ts";
import { lastStats, listModels, setDefaultModel } from "../src/llm.ts";
import { VERSION } from "../src/version.ts";
import { c, ui } from "../src/ui.ts";
import {
  loadConfig,
  saveConfig,
  configExists,
  configPath,
  DEFAULT_BROADCAST_ROSTER,
  type Config,
  type ChainKey,
  type Capability,
} from "../src/config.ts";
import { runSetup, detectAgents, type SetupResult } from "../src/setup.ts";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(`comux ${VERSION}`);
  process.exit(0);
}

// `comux all [send|new|update|close]` — before global --help so `comux all --help` works (ADR-0022).
if (args[0] === "all") {
  const rest = args.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(BROADCAST_ALL_HELP);
    process.exit(0);
  }

  let parsed: ReturnType<typeof parseBroadcastArgs>;
  try {
    parsed = parseBroadcastArgs(rest);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(2);
  }

  if (parsed.action === "update") {
    process.exit(await runBroadcastUpdate());
  }

  if (parsed.action === "close") {
    const { workspace } = await identifyContext();
    process.exit(await runBroadcastClose(workspace));
  }

  const cwd = process.env.COMUX_WORKSPACE ?? process.cwd();
  const { surface, workspace } = await identifyContext();
  await runBroadcast(parsed, { origin: surface, workspace, cwd });
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      `comux ${VERSION} — local-first AI orchestrator for cmux`,
      "",
      "Usage:",
      "  comux               launch the TUI (workspace: $COMUX_WORKSPACE or current directory)",
      "  comux all              Broadcast: open/reuse agent grid (comux all --help)",
      "  comux update [--dev]  brew upgrade comux (or sync latest master with --dev)",
      "  comux save [name|ref] [-o file]  save current (or named) cmux workspace to disk",
      "  comux load <name> [--name title] [--focus]  restore a saved workspace",
      "  comux list          list saved workspaces",
      "  comux rename <name> [new-name] [--name title]",
      "  comux delete <name>  delete a saved workspace (alias: rm)",
      "  comux --version     print version and exit",
      "  comux --help        show this help and exit",
      "",
      "Environment:",
      "  COMUX_WORKSPACE   default workspace directory",
      "  COMUX_MODEL       Ollama model (default: gemma4:12b-mlx)",
      "  OLLAMA_HOST       Ollama server URL (default: http://localhost:11434)",
      "  COMUX_YES         auto-approve the plan gate when Bypass mode is off (non-interactive)",
      "",
      "In TUI: /broadcast roster · /settings chains · /model · /setup · /help",
      "",
      "Needs a running cmux (with `cmux hooks setup` run — see /setup), Ollama serving the model,",
      "and an Agent CLI on PATH. Bypass mode (default on) auto-answers agent prompts; edit",
      "~/.config/comux/config.json to turn it off.",
    ].join("\n"),
  );
  process.exit(0);
}

// `comux update [--dev]` — refresh the install (brew upgrade, or sync master with --dev). No cmux
// needed, so handle it before anything that touches the workspace or the cmux surface.
if (args[0] === "update") {
  await runUpdate(args.slice(1));
  process.exit(0);
}

// `comux save|load|list|rename|delete|rm` — workspace snapshot commands (no cmux/Ollama setup needed).
const WS_COMMANDS = new Set(["save", "load", "list", "rename", "delete", "rm"]);
if (args[0] && WS_COMMANDS.has(args[0])) {
  await runWorkspaceCommand(args[0], args.slice(1)).catch((e: Error) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
  process.exit(0);
}

// No positional workspace argument: `comux <name>` must NOT create/cd into a folder named after
// the arg — that footgun hijacked subcommands like `all` (typing `comux all` made an `./all` repo).
// The workspace is the default or $COMUX_WORKSPACE; a stray non-flag arg is an unknown command.
const stray = args.find((a) => !a.startsWith("-"));
if (stray) {
  console.error(`comux: unknown command '${stray}' — see \`comux --help\``);
  process.exit(2);
}
const workspace = await ensureWorkspace(
  process.env.COMUX_WORKSPACE ?? process.cwd(),
);
const selfSurface = await identifySelf();
const envModel = process.env.COMUX_MODEL;
let model = envModel ?? "gemma4:12b-mlx"; // refined from config.model below; switched via /model
const autoYes = !!process.env.COMUX_YES;

// First run writes the default per-capability chains; thereafter load what the user has (and may
// have edited). `firstRun` is reported once the header is up.
const firstRun = !configExists();
const firstSetup: SetupResult | null = firstRun ? await runSetup() : null;
let config: Config = firstSetup?.config ?? (await loadConfig());
if (!envModel && config.model) model = config.model;
setDefaultModel(model);

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

/** One slash command: a palette entry + optional argument completion + its handler.
 *  The palette, dispatch, and arg completion all read this one table. */
interface Command {
  name: string;
  desc: string;
  aliases?: string[];
  /** Completion items for the argument part (palette shown after "<name> "). */
  complete?: (query: string) => Item[];
  run: (arg: string) => Promise<void> | void;
}

let quit = false;

const comuxFileItems = (query: string): Item[] => {
  const q = query.toLowerCase();
  return listComuxFiles(workspace)
    .filter((f) => f.toLowerCase().includes(q))
    .slice(0, 200)
    .map((f) => ({ name: f, desc: "" }));
};

const registry: Command[] = [
  { name: "/new", desc: "clear chat history and start a new session", run: runNew },
  {
    name: "/open", desc: "open a file from .comux/ (replaces viewer tab)", complete: comuxFileItems,
    run: async (arg) => {
      if (!arg) { say(c.gray("  พิมพ์ /open <ชื่อไฟล์> เพื่อเปิด — เว้นวรรคแล้วพิมพ์เพื่อ search")); return; }
      await openComuxFile(arg, "comux-result", true);
    },
  },
  {
    name: "/open-new", desc: "open a file from .comux/ in a new tab", complete: comuxFileItems,
    run: async (arg) => {
      if (!arg) { say(c.gray("  พิมพ์ /open-new <ชื่อไฟล์> เพื่อเปิด tab ใหม่ — เว้นวรรคแล้วพิมพ์เพื่อ search")); return; }
      await openComuxFile(arg, basename(arg), false);
    },
  },
  { name: "/model", desc: "pick the Orchestrator model (ollama)", run: runModelPicker },
  { name: "/setup", desc: "detect agents & write default chains", run: runSetupCmd },
  { name: "/settings", desc: "edit agent chains per capability", run: runSettingsPicker },
  { name: "/broadcast", desc: "edit broadcast roster (comux all send)", run: runBroadcastPicker },
  { name: "/agents", desc: "show capability chains", run: () => showAgents() },
  { name: "/plan", desc: "show PLAN.md", run: async () => say(c.gray(await readPlan(workspace))) },
  { name: "/ws", desc: "show workspace path", run: () => say(c.blue(`  ${workspace}`)) },
  { name: "/help", desc: "keybindings & commands", run: runHelp },
  { name: "/exit", desc: "quit", aliases: ["/quit"], run: () => { quit = true; } },
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

const tui = new Tui({
  commands: registry.map(({ name, desc }) => ({ name, desc })),
  status: statusBar,
  listFiles: () => listFiles(workspace),
  completeArg: (cmd, query) => registry.find((x) => x.name === cmd)?.complete?.(query) ?? [],
  historyPath: join(workspace, ".comux", "history"),
});
const say = (m: string) => tui.print(m);

const confirmPlan = async (_summary: string) =>
  autoYes ? true : tui.confirm("อนุมัติแผนนี้แล้วรันทั้งหมดเลยไหม?");

// ADR-0019: when the classifier is unsure and Bypass mode is off, let the human pick the kind.
const chooseCapability = async (top: Capability, alts: Capability[]): Promise<Capability> => {
  const opts = [top, ...alts.filter((c) => c !== top)];
  const i = await tui.choose("งานนี้เป็นแบบไหน?", opts);
  return opts[i] ?? top;
};

// ADR-0016: answer Agent Grilling decisions (permission / plan / question) on the cmux Feed.
const feed = startFeedWatcher({ bypass: config.bypass, say });

tui.printHeader();
say(c.gray("  workspace: ") + c.blue(tilde(workspace)));
say("");

if (firstSetup) {
  say(c.green("  ✓ first run — wrote default agent chains:"));
  showAgents();
  say(
    firstSetup.hooksInstalled
      ? c.gray("  ✓ installed cmux agent hooks (completion detection)")
      : c.red("  ⚠ `cmux hooks setup` did not run cleanly — completion falls back to the exit sentinel"),
  );
  say(c.gray("  edit that file to customise the order, or /setup to reset · /agents to view."));
  say("");
}

if (!process.stdin.isTTY) {
  say(c.red("  this TUI needs an interactive terminal (run it directly, not piped)."));
  process.exit(0);
}

const IMAGE_EXTS_OPEN = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

async function openComuxFile(filename: string, tabName: string, closeExisting: boolean): Promise<void> {
  const filePath = join(workspace, ".comux", filename);
  if (!existsSync(filePath)) { say(c.red(`  ไม่พบ ${filename} ใน .comux/`)); return; }
  if (closeExisting) {
    const existing = await findResultSurface().catch(() => null);
    if (existing) await closeSurface(existing).catch(() => {});
  }
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  try {
    const surface = IMAGE_EXTS_OPEN.has(ext)
      ? await openFile(filePath, { surface: selfSurface })
      : await openMarkdown(filePath, { surface: selfSurface });
    if (surface) {
      await renameTab(surface, tabName).catch(() => {});
      say(ui.ok(`เปิด ${filename} ใน viewer`));
    }
  } catch (e) {
    say(ui.warn(`เปิด ${filename} ไม่ได้: ${(e as Error).message}`));
  }
}

function runHelp(): void {
  say(c.gray("  TUI: /model · /settings · /broadcast · /setup · /agents · /plan · /new · /open · /ws · /exit"));
  say(c.gray("  keys: alt+⏎ newline · ↑↓ palette/cursor/history · ⇥ complete · ctrl+a/e/u/k/w edit · alt+←→ word · esc clear"));
  say("");
  say(c.cyan("  Broadcast (CLI):"));
  for (const line of BROADCAST_ALL_HELP.split("\n")) say(c.gray(`  ${line}`));
}

async function runNew(): Promise<void> {
  const resultSurface = await findResultSurface().catch(() => null);
  if (resultSurface) await closeSurface(resultSurface).catch(() => {});
  const n = await clearChatFiles(workspace);
  say(c.green(`  ✓ new session${n > 0 ? ` — cleared ${n} chat file${n !== 1 ? "s" : ""}` : ""}`));
}

async function runSetupCmd(): Promise<void> {
  const r = await runSetup();
  config = r.config;
  say(c.green("  ✓ wrote default agent chains:"));
  showAgents();
  say(
    r.hooksInstalled
      ? c.gray("  ✓ installed cmux agent hooks (completion detection)")
      : c.red("  ⚠ `cmux hooks setup` did not run cleanly — completion falls back to the exit sentinel"),
  );
}

/** /settings — pick a capability, then toggle/reorder its chain (order = Scheduler preference). */
async function runSettingsPicker(): Promise<void> {
  const editable: ChainKey[] = ["web_search", "image", "coding", "planning"];
  const installed = new Map(detectAgents().map((a) => [a.name, a.installed]));
  let changed = false;
  for (;;) {
    const items: Item[] = [
      ...editable.map((k) => ({ name: k as string, desc: config.chains[k].join(" → ") || "(empty)" })),
      { name: "done", desc: changed ? "save & exit" : "exit" },
    ];
    const i = await tui.pickOne("Edit agent chains — pick a capability", items);
    if (i == null || i >= editable.length) break;
    const key = editable[i]!;
    const chain = config.chains[key];
    const names = [...chain, ...[...installed.keys()].filter((n) => !chain.includes(n))];
    const rows = names.map((n) => ({
      label: n,
      detail: installed.get(n) ? "" : "not installed",
      enabled: chain.includes(n),
      value: n,
    }));
    const res = await tui.pickList(`${key} chain — order = preference`, rows, { toggle: true, reorder: true });
    if (!res) continue;
    config.chains[key] = res.filter((r) => r.enabled).map((r) => r.value);
    changed = true;
  }
  if (changed) {
    await saveConfig(config);
    say(c.green("  ✓ saved"));
    showAgents();
  }
}

/** /broadcast — toggle/reorder/rename roster slots in one picker (ADR-0021). */
async function runBroadcastPicker(): Promise<void> {
  const roster = config.broadcast?.roster ?? structuredClone(DEFAULT_BROADCAST_ROSTER);
  const rows = roster.map((s) => ({
    label: s.displayName,
    detail: s.binary + (s.model ? `  ${s.model}` : ""),
    enabled: s.enabled,
    value: s,
  }));
  const res = await tui.pickList("Broadcast roster (comux all)", rows, {
    toggle: true,
    reorder: true,
    rename: true,
  });
  if (!res) { say(c.gray("  cancelled")); return; }
  config.broadcast = {
    roster: res.map((r) => ({ ...r.value, enabled: r.enabled ?? false, displayName: r.label })),
  };
  await saveConfig(config);
  say(c.green("  ✓ saved broadcast roster"));
}

/** /model — pick the Orchestrator model from the Ollama server and persist it. */
async function runModelPicker(): Promise<void> {
  let models: string[];
  try {
    models = await listModels();
  } catch (e) {
    say(ui.warn(`Ollama ไม่ตอบ: ${(e as Error).message}`));
    return;
  }
  if (!models.length) { say(ui.warn("ไม่พบ model บน Ollama server")); return; }
  const items = models.map((m) => ({ name: m, desc: m === model ? "(current)" : "" }));
  const i = await tui.pickOne("Orchestrator model (ollama)", items, Math.max(0, models.indexOf(model)));
  if (i == null) return;
  config.model = models[i]!;
  await saveConfig(config);
  if (envModel) {
    say(ui.warn(`saved แต่ COMUX_MODEL=${envModel} ใน env ยัง override อยู่ — unset env เพื่อใช้ค่าจาก config`));
  } else {
    model = config.model;
    setDefaultModel(model);
    say(ui.ok(`model → ${model}`));
  }
}

for (;;) {
  const line = (await tui.readLine())?.trim();
  if (line == null) break; // ctrl+c / ctrl+d
  if (!line) continue;

  if (line.startsWith("/")) {
    const sp = line.search(/\s/);
    const name = sp === -1 ? line : line.slice(0, sp);
    const arg = sp === -1 ? "" : line.slice(sp + 1).trim();
    const cmd = registry.find((x) => x.name === name || x.aliases?.includes(name));
    if (!cmd) {
      say(ui.warn(`ไม่รู้จักคำสั่ง ${name} — ดู /help`));
      continue;
    }
    await cmd.run(arg);
    if (quit) break;
    continue;
  }

  try {
    await runTurn(line, { workspace, selfSurface, config, confirmPlan, chooseCapability, say });
  } catch (e) {
    say(c.red(`  ⚠ error: ${(e as Error).message}`));
  }
}

feed.stop();
console.log(c.gray("bye."));
