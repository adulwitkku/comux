// Broadcast mode (`comux all`) — a manual fan-out that opens each enabled Broadcast-roster slot
// as its bare interactive TUI side-by-side (with that slot's model) and sends the same text to
// all at once, for the human to drive and compare (ADR-0014, ADR-0021). It deliberately bypasses
// the orchestration core — no Orchestrator, no Capability/chain/Scheduler, no PLAN/Step/
// Acceptance check, no Checkpoint — and runs the Agents UNCONFINED in a shared cwd.
//
// This is the opposite of a Dispatch: unrouted, to everyone, no sentinel/watchdog (a human
// watches). The orchestrated flow never imports this module.

import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { REGISTRY, type Agent, type PasteMode } from "./agents.ts";
import { loadConfig, rosterHash, type BroadcastSlot } from "./config.ts";
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

/** Registry key for a Broadcast slot's CLI binary (paste profile lookup). */
const BINARY_TO_REGISTRY: Record<string, string> = {
  pi: "pi",
  claude: "claude",
  codex: "codex",
  "cursor-agent": "cursor",
  agent: "agent",
  agy: "agy",
  opencode: "opencode",
};

/** A resolved roster slot ready to open or send into. */
export interface BroadcastTarget {
  id: string;
  displayName: string;
  openCommand: string;
  pasteMode: PasteMode;
  submitKey: string;
  newlineKey: string;
}

/** Build the bare interactive launch command for a roster slot. */
export function buildOpenCommand(slot: BroadcastSlot): string {
  const parts = [slot.binary];
  if (slot.model) {
    const flag = slot.binary === "codex" || slot.binary === "opencode" ? "-m" : "--model";
    parts.push(flag, shq(slot.model));
  }
  if (slot.openArgs?.length) parts.push(...slot.openArgs);
  return parts.join(" ");
}

function sendProfile(binary: string): Pick<Agent, "pasteMode" | "submitKey" | "newlineKey"> {
  const reg = BINARY_TO_REGISTRY[binary];
  const agent = reg ? REGISTRY[reg] : undefined;
  return {
    pasteMode: agent?.pasteMode ?? "bracketed",
    submitKey: agent?.submitKey ?? "enter",
    newlineKey: agent?.newlineKey ?? "shift+enter",
  };
}

/** Turn enabled roster slots into launch targets (does not check PATH). */
export function resolveBroadcastTargets(roster: BroadcastSlot[]): BroadcastTarget[] {
  return roster
    .filter((s) => s.enabled)
    .map((slot) => {
      const profile = sendProfile(slot.binary);
      return {
        id: slot.id,
        displayName: slot.displayName,
        openCommand: buildOpenCommand(slot),
        ...profile,
      };
    });
}

/** Enabled roster slots whose CLI binary is on PATH. */
export function activeBroadcastTargets(
  roster: BroadcastSlot[],
  log?: (msg: string) => void,
): BroadcastTarget[] {
  const out: BroadcastTarget[] = [];
  for (const t of resolveBroadcastTargets(roster)) {
    const slot = roster.find((s) => s.id === t.id);
    if (!slot || !Bun.which(slot.binary)) {
      log?.(`skipped: ${t.displayName} (${slot?.binary ?? "?"} not installed)`);
      continue;
    }
    out.push(t);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// state file (per cmux workspace)                                             //
// --------------------------------------------------------------------------- //

export interface BroadcastState {
  /** The cmux workspace the grid lives in (the key). */
  workspace: string;
  /** Directory the Agents were opened in. */
  cwd: string;
  /** Fingerprint of the roster when the grid was built — rebuild when it changes. */
  rosterHash: string;
  /** Slot id → the surface its TUI runs in. */
  slots: Record<string, SurfaceRef>;
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
    const raw = JSON.parse(await readFile(path, "utf8")) as BroadcastState & { agents?: Record<string, SurfaceRef> };
    // Migrate pre-ADR-0021 state that keyed by agent name.
    if (!raw.slots && raw.agents) raw.slots = raw.agents;
    return raw;
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

/** Open each slot's bare interactive TUI in its own pane; return the slot-id→surface map. */
async function openGrid(
  origin: SurfaceRef,
  targets: BroadcastTarget[],
  cwd: string,
): Promise<Record<string, SurfaceRef>> {
  const surfaces = await buildGrid(origin, targets.length);
  const map: Record<string, SurfaceRef> = {};
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const surface = surfaces[i]!;
    await sendLine(surface, `cd ${shq(cwd)} && ${t.openCommand}`);
    map[t.id] = surface;
  }
  return map;
}

// --------------------------------------------------------------------------- //
// send dispatch (per-Agent paste mode, ported from ai.py)                     //
// --------------------------------------------------------------------------- //

/** Paste/submit profile for dispatching text into a running TUI. */
export interface SendProfile {
  pasteMode: PasteMode;
  submitKey: string;
  newlineKey: string;
}

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
  profile: SendProfile,
  surface: SurfaceRef,
  text: string,
): Promise<void> {
  if (profile.pasteMode === "buffer") {
    const buf = `comux-${process.pid}-${Date.now()}`;
    await ops.setBuffer(buf, text);
    await ops.pasteBuffer(buf, surface);
  } else if (profile.pasteMode === "typed") {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line) await ops.send(surface, line);
      if (i < lines.length - 1) await ops.sendKey(surface, profile.newlineKey);
    }
  } else {
    // bracketed: wrap in OSC 200/201 so the TUI treats it as a paste, not keystrokes.
    await ops.send(surface, `\x1b[200~${text}\x1b[201~`);
  }
  await ops.sendKey(surface, profile.submitKey);
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
  const config = await loadConfig();
  const hash = rosterHash(config.broadcast.roster);

  const targets = activeBroadcastTargets(config.broadcast.roster, log);
  if (targets.length === 0) {
    log("no broadcast slots available — enable slots in /broadcast or install Agent CLIs.");
    return;
  }

  const saved = await loadState(ctx.workspace);
  let map = saved?.slots ?? null;
  if (!map || saved?.rosterHash !== hash || !(await gridIsLive(map))) {
    log(`opening ${targets.length} agent panes in ${ctx.cwd} …`);
    map = await openGrid(ctx.origin, targets, ctx.cwd);
    await saveState({ workspace: ctx.workspace, cwd: ctx.cwd, rosterHash: hash, slots: map });
    log(`grid: ${targets.map((t) => t.displayName).join(" · ")}`);
  } else {
    log(`reusing existing grid (${Object.keys(map).length} panes).`);
  }

  if (!text) return;

  for (const t of targets) {
    const surface = map[t.id];
    if (!surface) {
      log(`warn: skipping ${t.displayName} (no pane)`);
      continue;
    }
    try {
      await dispatchSend(realOps, t, surface, text);
      log(`sent → ${t.displayName}`);
    } catch (e) {
      log(`warn: ${t.displayName} send failed (${(e as Error).message}) — skipping`);
    }
  }
}
