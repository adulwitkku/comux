#!/usr/bin/env bun
// comux — a local-first AI orchestrator that runs coding agents visibly inside cmux.
//
// A small local model (the Orchestrator, gemma4:12b via Ollama) turns your message into a
// minimal task spec; deterministic code routes coding work to an Agent that runs visibly in a
// new cmux pane, then git-checkpoints the result in the workspace.
//
//   comux                  # workspace = $COMUX_WORKSPACE or ./workspace (under the current dir)
//   comux all [text]       # Broadcast: open the configured roster; send text to all
//   comux --version | --help
//
// In the TUI:  type to chat · "/" commands · "@" file mentions · ⏎ run · ctrl+c exit

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { identifySelf, identifyContext, closeSurface, findResultSurface, openMarkdown, openFile, renameTab, type SurfaceRef } from "../src/cmux.ts";
import { runBroadcast, parseBroadcastArgs } from "../src/broadcast.ts";
import { runUpdate } from "../src/update.ts";
import { runWorkspaceCommand } from "../src/workspace-save.ts";
import { ensureWorkspace, readPlan, currentBranch, listFiles, clearChatFiles, listComuxFiles } from "../src/workspace.ts";
import { runTurn } from "../src/harness.ts";
import { startFeedWatcher } from "../src/feed.ts";
import { Tui, type Item } from "../src/tui.ts";
import { lastStats } from "../src/llm.ts";
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
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      `comux ${VERSION} — local-first AI orchestrator for cmux`,
      "",
      "Usage:",
      "  comux               launch the TUI (workspace: $COMUX_WORKSPACE or current directory)",
      "  comux all [text]    Broadcast: open the configured roster; send text to all",
      "  comux update [--dev]  brew upgrade (or sync latest master with --dev)",
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

// `comux all [--cwd DIR] [text...]` — Broadcast mode (ADR-0014/0021): open each enabled roster
// slot side-by-side (with its model) and send the same text to all. Manual, unconfined fan-out
// that bypasses the orchestrator entirely, so it is handled here before the TUI path.
if (args[0] === "all") {
  const rest = args.slice(1);
  const { cwd: cwdFlag } = parseBroadcastArgs(rest);
  const cwd = cwdFlag ?? process.env.COMUX_WORKSPACE ?? process.cwd();
  const { surface, workspace } = await identifyContext();
  await runBroadcast(rest, { origin: surface, workspace, cwd });
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
  { name: "/new", desc: "clear chat history and start a new session" },
  { name: "/open", desc: "open a file from .comux/ (replaces viewer tab)" },
  { name: "/open-new", desc: "open a file from .comux/ in a new tab" },
  { name: "/setup", desc: "detect agents & write default chains" },
  { name: "/settings", desc: "edit agent chains per capability" },
  { name: "/broadcast", desc: "edit broadcast roster (comux all)" },
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

const tui = new Tui({
  commands,
  status: statusBar,
  listFiles: () => listFiles(workspace),
  listOpenFiles: () => listComuxFiles(workspace),
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

loop: for (;;) {
  const line = (await tui.readLine())?.trim();
  if (line == null) break; // ctrl+c / ctrl+d
  if (!line) continue;

  switch (line) {
    case "/exit":
    case "/quit":
      break loop;
    case "/help":
      say(c.gray("  /new  new session  ·  /setup  reset chains  ·  /settings  edit chains  ·  /broadcast  edit roster  ·  /agents  view chains  ·  /plan  PLAN.md  ·  /ws  ·  /exit"));
      say(c.gray("  keys: ↑↓ choose command · ⏎ run · ⇥ complete · esc clear · ctrl+c exit"));
      continue;
    case "/setup": {
      const r = await runSetup();
      config = r.config;
      say(c.green("  ✓ wrote default agent chains:"));
      showAgents();
      say(
        r.hooksInstalled
          ? c.gray("  ✓ installed cmux agent hooks (completion detection)")
          : c.red("  ⚠ `cmux hooks setup` did not run cleanly — completion falls back to the exit sentinel"),
      );
      continue;
    }
    case "/settings": {
      const editableChains: ChainKey[] = ["web_search", "image", "coding", "planning"];
      say(c.gray("  Edit agent chains (comma-separated names). Press ⏎ to keep current."));
      say(c.gray(`  Available agents: ${Object.keys(detectAgents().reduce((m, a) => { if (a.installed) m[a.name] = 1; return m; }, {} as Record<string,number>)).join(", ") || "none detected"}`));
      let changed = false;
      for (const key of editableChains) {
        const current = config.chains[key].join(", ") || "(empty)";
        say(c.cyan(`  ${key.padEnd(11)}`) + c.gray(`[${current}]: `));
        const input = (await tui.readLine())?.trim();
        if (!input) continue;
        const names = input.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        if (names.length) { config.chains[key] = names; changed = true; }
      }
      if (changed) {
        await saveConfig(config);
        say(c.green("  ✓ saved"));
        showAgents();
      } else {
        say(c.gray("  no changes"));
      }
      continue;
    }
    case "/agents":
      showAgents();
      continue;
    case "/broadcast": {
      const roster = config.broadcast?.roster ?? DEFAULT_BROADCAST_ROSTER;
      say(c.gray("  Broadcast roster (comux all) — slot number toggles enabled, or enter to skip:"));
      for (let i = 0; i < roster.length; i++) {
        const s = roster[i]!;
        const mark = s.enabled ? c.green("on ") : c.red("off");
        const model = s.model ? c.gray(`  ${s.model}`) : "";
        say(`  ${c.cyan(String(i + 1).padStart(2))}  ${mark}  ${s.displayName}${model}  ${c.gray(s.binary)}`);
      }
      let changed = false;
      const toggleInput = (await tui.readLine())?.trim();
      if (toggleInput && /^\d+$/.test(toggleInput)) {
        const idx = Number(toggleInput) - 1;
        if (idx >= 0 && idx < roster.length) {
          roster[idx]!.enabled = !roster[idx]!.enabled;
          changed = true;
          say(c.gray(`  ${roster[idx]!.displayName}: ${roster[idx]!.enabled ? "on" : "off"}`));
        }
      }
      say(c.gray("  Edit display name — slot number, or enter to skip:"));
      const editSlot = (await tui.readLine())?.trim();
      if (editSlot && /^\d+$/.test(editSlot)) {
        const idx = Number(editSlot) - 1;
        if (idx >= 0 && idx < roster.length) {
          say(c.gray(`  New name for "${roster[idx]!.displayName}" (enter to keep): `));
          const newName = (await tui.readLine())?.trim();
          if (newName) {
            roster[idx]!.displayName = newName;
            changed = true;
          }
        }
      }
      if (changed) {
        config.broadcast = { roster };
        await saveConfig(config);
        say(c.green("  ✓ saved broadcast roster"));
      } else {
        say(c.gray("  no changes"));
      }
      continue;
    }
    case "/open":
      say(c.gray("  พิมพ์ /open <ชื่อไฟล์> เพื่อเปิด — เว้นวรรคแล้วพิมพ์เพื่อ search"));
      continue;
    case "/open-new":
      say(c.gray("  พิมพ์ /open-new <ชื่อไฟล์> เพื่อเปิด tab ใหม่ — เว้นวรรคแล้วพิมพ์เพื่อ search"));
      continue;
    case "/ws":
      say(c.blue(`  ${workspace}`));
      continue;
    case "/plan":
      say(c.gray(await readPlan(workspace)));
      continue;
    case "/new": {
      const resultSurface = await findResultSurface().catch(() => null);
      if (resultSurface) await closeSurface(resultSurface).catch(() => {});
      const n = await clearChatFiles(workspace);
      say(c.green(`  ✓ new session${n > 0 ? ` — cleared ${n} chat file${n !== 1 ? "s" : ""}` : ""}`));
      continue;
    }
  }

  if (line.startsWith("/open ")) {
    await openComuxFile(line.slice("/open ".length).trim(), "comux-result", true);
    continue;
  }

  if (line.startsWith("/open-new ")) {
    const filename = line.slice("/open-new ".length).trim();
    await openComuxFile(filename, basename(filename), false);
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
