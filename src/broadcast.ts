// Broadcast mode (`comux all`) — a manual fan-out that opens every installed Agent as its bare
// interactive TUI side-by-side and sends the same text to all at once, for the human to drive and
// compare (ADR-0014). It deliberately bypasses the orchestration core — no Orchestrator, no
// Capability/chain/Scheduler, no PLAN/Step/Acceptance check, no Checkpoint — and runs the Agents
// UNCONFINED in a shared cwd (the sandbox of ADR-0005 does not apply here).
//
// This is the opposite of a Dispatch: unrouted, to everyone, no sentinel/watchdog (a human
// watches). The orchestrated flow never imports this module.

import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { REGISTRY, type Agent } from "./agents.ts";
import { detectAgents } from "./setup.ts";
import { configDir } from "./config.ts";
import {
  newSplit,
  sendLine,
  send,
  sendKey,
  setBuffer,
  pasteBuffer,
  readScreen,
  type SurfaceRef,
} from "./cmux.ts";

/** Single-quote a string for safe use inside a shell command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// --------------------------------------------------------------------------- //
// state file (per cmux workspace)                                             //
// --------------------------------------------------------------------------- //

export interface BroadcastState {
  /** The cmux workspace the grid lives in (the key). */
  workspace: string;
  /** Directory the Agents were opened in. */
  cwd: string;
  /** Agent name → the surface its TUI runs in. */
  agents: Record<string, SurfaceRef>;
}

function stateDir(): string {
  return join(configDir(), "broadcast");
}

/** State path for a workspace ref like `workspace:3` → `<config>/broadcast/3.json`. */
export function stateFile(workspace: string): string {
  const id = workspace.split(":").pop() || workspace;
  return join(stateDir(), `${id.replace(/[^\w.-]/g, "_")}.json`);
}

export async function saveState(state: BroadcastState): Promise<string> {
  await mkdir(stateDir(), { recursive: true });
  const path = stateFile(state.workspace);
  await writeFile(path, JSON.stringify(state, null, 2) + "\n");
  return path;
}

export async function loadState(workspace: string): Promise<BroadcastState | null> {
  const path = stateFile(workspace);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as BroadcastState;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- //
// grid layout (rough grid via repeated newSplit — no rpc/workspace.create)    //
// --------------------------------------------------------------------------- //

/** Columns × rows for `n` panes: roughly square, columns-first. */
export function gridDims(n: number): { cols: number; rows: number } {
  if (n <= 0) return { cols: 0, rows: 0 };
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

/** Cells per column for `n` panes across `cols` columns (extras go to the leftmost columns). */
export function cellsPerColumn(n: number, cols: number): number[] {
  const base = Math.floor(n / cols);
  const extra = n % cols;
  return Array.from({ length: cols }, (_, c) => base + (c < extra ? 1 : 0));
}

/**
 * Build `n` agent panes as a rough grid below the caller's terminal, using only `newSplit`.
 * The origin terminal is kept (it stays the controlling pane); the grid is split off beneath it.
 * Returns the new surfaces in fill order (column 0 top→bottom, then column 1, …).
 */
async function buildGrid(origin: SurfaceRef, n: number): Promise<SurfaceRef[]> {
  const { cols } = gridDims(n);
  const counts = cellsPerColumn(n, cols);

  // First column anchor splits off the origin so the terminal is not overwritten.
  const colAnchors: SurfaceRef[] = [await newSplit(origin, "down")];
  for (let c = 1; c < cols; c++) {
    colAnchors.push(await newSplit(colAnchors[c - 1]!, "right"));
  }

  const surfaces: SurfaceRef[] = [];
  for (let c = 0; c < cols; c++) {
    let prev = colAnchors[c]!;
    const count = counts[c]!;
    surfaces.push(prev);
    for (let r = 1; r < count; r++) {
      prev = await newSplit(prev, "down");
      surfaces.push(prev);
    }
  }
  return surfaces;
}

/** Open each Agent's bare interactive TUI in its own pane; return the agent→surface map. */
async function openGrid(
  origin: SurfaceRef,
  agents: Agent[],
  cwd: string,
): Promise<Record<string, SurfaceRef>> {
  const surfaces = await buildGrid(origin, agents.length);
  const map: Record<string, SurfaceRef> = {};
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!;
    const surface = surfaces[i]!;
    // Bare interactive launch in the shared cwd — no task, no sentinel, no confine (ADR-0014).
    await sendLine(surface, `cd ${shq(cwd)} && ${a.openCommand}`);
    map[a.name] = surface;
  }
  return map;
}

// --------------------------------------------------------------------------- //
// send dispatch (per-Agent paste mode, ported from ai.py)                     //
// --------------------------------------------------------------------------- //

/** The cmux operations the send dispatcher needs — injectable so it can be tested offline. */
export interface SendOps {
  send(surface: SurfaceRef, text: string): Promise<void>;
  sendKey(surface: SurfaceRef, key: string): Promise<void>;
  setBuffer(name: string, text: string): Promise<void>;
  pasteBuffer(name: string, surface: SurfaceRef): Promise<void>;
}

const realOps: SendOps = { send, sendKey, setBuffer, pasteBuffer };

/** Deliver `text` into one Agent's TUI per its paste mode, then submit once. */
export async function dispatchSend(
  ops: SendOps,
  agent: Agent,
  surface: SurfaceRef,
  text: string,
): Promise<void> {
  if (agent.pasteMode === "buffer") {
    const buf = `comux-${process.pid}-${Date.now()}`;
    await ops.setBuffer(buf, text);
    await ops.pasteBuffer(buf, surface);
  } else if (agent.pasteMode === "typed") {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line) await ops.send(surface, line);
      if (i < lines.length - 1) await ops.sendKey(surface, agent.newlineKey);
    }
  } else {
    // bracketed: wrap in OSC 200/201 so the TUI treats it as a paste, not keystrokes.
    await ops.send(surface, `\x1b[200~${text}\x1b[201~`);
  }
  await ops.sendKey(surface, agent.submitKey);
}

// --------------------------------------------------------------------------- //
// argv parsing + entrypoint                                                   //
// --------------------------------------------------------------------------- //

export interface BroadcastArgs {
  /** Text to broadcast; empty string means open-only. */
  text: string;
  /** Optional cwd override from `--cwd`. */
  cwd: string | null;
}

/** Parse the args after the `all` subcommand: `[--cwd DIR] [text...]`. */
export function parseBroadcastArgs(argv: string[]): BroadcastArgs {
  let cwd: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--cwd") {
      cwd = argv[++i] ?? null;
    } else {
      rest.push(arg);
    }
  }
  return { text: rest.join(" ").trim(), cwd };
}

/** Installed Agents in registry order (the set Broadcast fans out to). */
export function installedAgents(): Agent[] {
  return detectAgents()
    .filter((a) => a.installed)
    .map((a) => REGISTRY[a.name])
    .filter((a): a is Agent => a != null);
}

/** Is the saved grid still live? Probe one stored surface; a read failure means it is stale. */
async function gridIsLive(map: Record<string, SurfaceRef>): Promise<boolean> {
  const first = Object.values(map)[0];
  if (!first) return false;
  try {
    await readScreen(first, 1);
    return true;
  } catch {
    return false;
  }
}

export interface BroadcastContext {
  origin: SurfaceRef;
  workspace: string;
  cwd: string;
  log?: (msg: string) => void;
}

/** Run `comux all [text]`: ensure the grid is open (build or reuse), then broadcast text if any. */
export async function runBroadcast(argv: string[], ctx: BroadcastContext): Promise<void> {
  const log = ctx.log ?? ((m: string) => console.log(m));
  const { text } = parseBroadcastArgs(argv);

  const agents = installedAgents();
  if (agents.length === 0) {
    log("no agents installed — run /setup or install an Agent CLI first.");
    return;
  }

  const saved = await loadState(ctx.workspace);
  let map = saved?.agents ?? null;
  if (!map || !(await gridIsLive(map))) {
    log(`opening ${agents.length} agent panes in ${ctx.cwd} …`);
    map = await openGrid(ctx.origin, agents, ctx.cwd);
    await saveState({ workspace: ctx.workspace, cwd: ctx.cwd, agents: map });
    log(`grid: ${agents.map((a) => a.name).join(" · ")}`);
  } else {
    log(`reusing existing grid (${Object.keys(map).length} panes).`);
  }

  if (!text) return;

  for (const a of agents) {
    const surface = map[a.name];
    if (!surface) {
      log(`warn: skipping ${a.name} (no pane)`);
      continue;
    }
    try {
      await dispatchSend(realOps, a, surface, text);
      log(`sent → ${a.name}`);
    } catch (e) {
      log(`warn: ${a.name} send failed (${(e as Error).message}) — skipping`);
    }
  }
}
