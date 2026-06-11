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
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
  listPanes,
  resizePane,
  closeSurface,
  type SurfaceRef,
  type PaneRef,
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

export async function deleteState(workspace: string): Promise<void> {
  const path = stateFile(workspace);
  if (existsSync(path)) await unlink(path);
}

// --------------------------------------------------------------------------- //
// Equal grid (uniform cols × rows via newSplit, then equalised with resize)   //
// --------------------------------------------------------------------------- //

/**
 * Columns × rows for `n` cells, chosen so every cell ends up the same size. Broadcast counts the
 * caller's terminal as one cell, so `n` is (agents + 1) and tops out at 10 (nine agents + caller).
 * We minimise `|cols − rows| + 2·pad` (pad = cols·rows − n) and, on a tie, prefer fewer pad cells
 * and then a wider (landscape) grid. Counts that don't tile evenly keep one trailing cell empty
 * rather than letting any pane differ in size.
 */
export function gridDims(n: number): { cols: number; rows: number } {
  if (n <= 0) return { cols: 0, rows: 0 };
  let best = { cols: n, rows: 1, cost: Infinity, pad: Infinity };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const pad = cols * rows - n;
    const cost = Math.abs(cols - rows) + 2 * pad;
    if (
      cost < best.cost ||
      (cost === best.cost && pad < best.pad) ||
      (cost === best.cost && pad === best.pad && cols > best.cols)
    ) {
      best = { cols, rows, cost, pad };
    }
  }
  return { cols: best.cols, rows: best.rows };
}

/** A built grid: the panes in column-major fill order, grouped by column for equalising. */
interface BuiltGrid {
  /** All cell surfaces in fill order (col 0 top→bottom, then col 1, …); length = cols·rows.
   *  cells[0] is the caller's own terminal (top-left); agents fill cells[1..]. */
  cells: SurfaceRef[];
  /** Surfaces per column, top→bottom — used to equalise row heights within each column. */
  columns: SurfaceRef[][];
}

/**
 * Build a uniform `cols × rows` grid out of the caller's terminal using only `newSplit`. The caller
 * itself becomes the **top-left cell** (cells[0]) — it is counted as one equal-sized cell, not kept
 * as a separate strip — and the rest of the grid is split off around it. Every column gets the full
 * `rows` cells (trailing cells beyond what's needed are padding), so the layout is rectangular and
 * can be equalised. Returns the cells in column-major fill order plus the per-column grouping.
 */
async function buildGrid(origin: SurfaceRef, cols: number, rows: number): Promise<BuiltGrid> {
  // The caller's terminal is column 0's anchor (top-left cell); split right for the other columns.
  const colAnchors: SurfaceRef[] = [origin];
  for (let c = 1; c < cols; c++) {
    colAnchors.push(await newSplit(colAnchors[c - 1]!, "right"));
  }

  const columns: SurfaceRef[][] = [];
  const cells: SurfaceRef[] = [];
  for (let c = 0; c < cols; c++) {
    let prev = colAnchors[c]!;
    const col: SurfaceRef[] = [prev];
    for (let r = 1; r < rows; r++) {
      prev = await newSplit(prev, "down");
      col.push(prev);
    }
    columns.push(col);
    cells.push(...col);
  }
  return { cells, columns };
}

/**
 * Resize a row/column of panes so they are all the same size along one axis. cmux halves on every
 * split, so a freshly built strip is 1/2, 1/4, 1/4, …; we walk the internal boundaries left→right
 * (top→bottom) and, re-reading sizes each step, nudge each pane to the average of what remains. The
 * outermost boundary (with the origin/edge) is never touched.
 */
async function equalizeStrip(
  paneRefs: PaneRef[],
  axis: "h" | "v",
  workspace: string,
): Promise<void> {
  const k = paneRefs.length;
  if (k < 2) return;
  for (let i = 0; i < k - 1; i++) {
    const panes = await listPanes(workspace);
    const sizeOf = (ref: PaneRef) => {
      const p = panes.find((q) => q.ref === ref);
      return p ? (axis === "h" ? p.width : p.height) : 0;
    };
    const remaining = paneRefs.slice(i);
    const total = remaining.reduce((sum, ref) => sum + sizeOf(ref), 0);
    const target = total / remaining.length;
    const delta = target - sizeOf(paneRefs[i]!);
    if (Math.abs(delta) < 1) continue;
    // Move only the boundary between this pane and the next, so already-fixed panes stay put.
    if (delta > 0) {
      await resizePane(paneRefs[i]!, axis === "h" ? "R" : "D", delta, workspace);
    } else {
      await resizePane(paneRefs[i + 1]!, axis === "h" ? "L" : "U", -delta, workspace);
    }
  }
}

/** Make every cell of a freshly built grid the same size (columns first, then rows per column). */
async function equalizeGrid(grid: BuiltGrid, workspace: string): Promise<void> {
  const panes = await listPanes(workspace);
  const paneOf = (surface: SurfaceRef): PaneRef | null =>
    panes.find((p) => p.surfaceRefs.includes(surface))?.ref ?? null;

  // Equalise column widths using each column's top cell as its representative pane.
  const colTops = grid.columns
    .map((col) => paneOf(col[0]!))
    .filter((r): r is PaneRef => r !== null);
  await equalizeStrip(colTops, "h", workspace);

  // Equalise row heights within each column.
  for (const col of grid.columns) {
    if (col.length < 2) continue;
    const cellPanes = col.map(paneOf).filter((r): r is PaneRef => r !== null);
    await equalizeStrip(cellPanes, "v", workspace);
  }
}

/**
 * Open each slot's bare interactive TUI in its own equal-sized pane; return the slot-id→surface
 * map. The caller's terminal is counted as cells[0], so the grid is sized for (agents + 1) cells;
 * trailing cells beyond what's used stay as bare shells — the padding that keeps every pane the
 * same size.
 */
async function openGrid(
  origin: SurfaceRef,
  targets: BroadcastTarget[],
  cwd: string,
  workspace: string,
): Promise<Record<string, SurfaceRef>> {
  const { cols, rows } = gridDims(targets.length + 1);
  const grid = await buildGrid(origin, cols, rows);
  await equalizeGrid(grid, workspace);

  const map: Record<string, SurfaceRef> = {};
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const surface = grid.cells[i + 1]!; // cells[0] is the caller's own terminal — skip it.
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

export type BroadcastAction = "open" | "send" | "new" | "update" | "close";

export interface BroadcastArgs {
  action: BroadcastAction;
  /** Broadcast text (`send` only). */
  text: string;
}

const BROADCAST_SUBCOMMANDS = new Set(["send", "new", "update", "close"]);

/** Help text for `comux all --help` (also mirrored in the TUI `/help`). */
export const BROADCAST_ALL_HELP = [
  "Usage:",
  "  comux all              Open or reuse the broadcast grid (no text)",
  "  comux all send <text>  Broadcast text to all enabled roster slots",
  "  comux all new          Rebuild the grid from scratch",
  "  comux all update       Update agent CLIs (brew/npm)",
  "  comux all close        Tear down the live grid",
  "",
  "Roster: edit in TUI with /broadcast",
  "Workspace: $COMUX_WORKSPACE or current directory",
].join("\n");

/** Parse argv after `comux all` into a subcommand (ADR-0022). */
export function parseBroadcastArgs(argv: string[]): BroadcastArgs {
  if (argv.length === 0) return { action: "open", text: "" };

  const head = argv[0]!;
  if (head.startsWith("-")) return rejectLegacyFlag(head);

  if (!BROADCAST_SUBCOMMANDS.has(head)) {
    throw new Error(
      `comux all: unknown subcommand '${head}' — did you mean \`comux all send "${head}"\`? See \`comux all --help\``,
    );
  }

  const rest = argv.slice(1);
  switch (head) {
    case "send": {
      const text = rest.join(" ").trim();
      if (!text) {
        throw new Error('comux all send: missing text — usage: comux all send "<text>"');
      }
      return { action: "send", text };
    }
    case "new":
      if (rest.length > 0) throw new Error("comux all new: does not accept extra arguments");
      return { action: "new", text: "" };
    case "update":
      if (rest.length > 0) throw new Error("comux all update: does not accept extra arguments");
      return { action: "update", text: "" };
    case "close":
      if (rest.length > 0) throw new Error("comux all close: does not accept extra arguments");
      return { action: "close", text: "" };
    default:
      throw new Error(`comux all: unknown subcommand '${head}' — see \`comux all --help\``);
  }
}

function rejectLegacyFlag(flag: string): never {
  if (flag === "--new" || flag === "-n") {
    throw new Error("comux all: use `comux all new` (not --new)");
  }
  if (flag === "--update") {
    throw new Error("comux all: use `comux all update` (not --update)");
  }
  if (flag === "--close") {
    throw new Error("comux all: use `comux all close` (not --close)");
  }
  if (flag === "--cwd") {
    throw new Error(
      "comux all: --cwd was removed — agents share $COMUX_WORKSPACE or the current directory",
    );
  }
  throw new Error(`comux all: unknown flag '${flag}' — see \`comux all --help\``);
}

/** Unique CLI binaries from enabled roster slots, in roster order. */
export function uniqueEnabledBinaries(roster: BroadcastSlot[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slot of roster) {
    if (!slot.enabled || seen.has(slot.binary)) continue;
    seen.add(slot.binary);
    out.push(slot.binary);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Broadcast update — external package-manager refresh per roster binary         //
// --------------------------------------------------------------------------- //

/** Ordered update attempts per binary (brew-first, npm fallback where common). */
export const BROADCAST_UPDATE_COMMANDS: Record<string, string[][]> = {
  pi: [["brew", "upgrade", "pi"]],
  claude: [["brew", "upgrade", "claude"], ["npm", "update", "-g", "@anthropic-ai/claude-code"]],
  codex: [["brew", "upgrade", "codex"], ["npm", "update", "-g", "@openai/codex"]],
  "cursor-agent": [["brew", "upgrade", "cursor-agent"]],
  agent: [["brew", "upgrade", "cursor-agent"]],
  agy: [["brew", "upgrade", "antigravity"], ["brew", "upgrade", "agy"]],
  opencode: [["brew", "upgrade", "opencode"], ["npm", "update", "-g", "opencode-ai"]],
};

export type UpdateRun = (cmd: string[]) => Promise<number>;

const defaultUpdateRun: UpdateRun = async (cmd) => {
  if (!Bun.which(cmd[0]!)) return -1;
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  return await proc.exited;
};

/** Run mapped package-manager updates for each unique enabled roster binary. */
export async function runBroadcastUpdate(
  log: (msg: string) => void = console.log,
  run: UpdateRun = defaultUpdateRun,
): Promise<number> {
  const config = await loadConfig();
  const binaries = uniqueEnabledBinaries(config.broadcast.roster);
  if (binaries.length === 0) {
    log("no enabled broadcast slots — enable slots in /broadcast.");
    return 0;
  }

  let failed = 0;
  for (const binary of binaries) {
    if (!Bun.which(binary)) {
      log(`skip: ${binary} (not installed)`);
      continue;
    }
    const attempts = BROADCAST_UPDATE_COMMANDS[binary];
    if (!attempts?.length) {
      log(`skip: ${binary} (no update command mapped)`);
      continue;
    }
    log(`updating ${binary} …`);
    let ok = false;
    for (const cmd of attempts) {
      if (!Bun.which(cmd[0]!)) continue;
      const code = await run(cmd);
      if (code === 0) {
        log(`ok: ${binary} (${cmd.join(" ")})`);
        ok = true;
        break;
      }
      log(`warn: ${cmd.join(" ")} exited ${code}`);
    }
    if (!ok) {
      log(`fail: ${binary}`);
      failed++;
    }
  }
  if (failed > 0) log(`${failed} update(s) failed.`);
  return failed > 0 ? 1 : 0;
}

/** Hard-close every agent pane in the live broadcast grid and delete its state file. */
export async function runBroadcastClose(
  workspace: string,
  log: (msg: string) => void = console.log,
): Promise<number> {
  const saved = await loadState(workspace);
  const slots = saved?.slots;
  if (!slots || Object.keys(slots).length === 0) {
    log("no broadcast grid to close.");
    return 0;
  }
  if (!(await gridIsLive(slots))) {
    await deleteState(workspace);
    log("no broadcast grid to close.");
    return 0;
  }
  log(`closing ${Object.keys(slots).length} agent pane(s) …`);
  await Promise.all(Object.values(slots).map((s) => closeSurface(s).catch(() => {})));
  await deleteState(workspace);
  log("broadcast grid closed.");
  return 0;
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

/** Run `comux all` grid open/send/new: ensure the grid is open, then broadcast text on `send`. */
export async function runBroadcast(args: BroadcastArgs, ctx: BroadcastContext): Promise<void> {
  const log = ctx.log ?? ((m: string) => console.log(m));
  if (args.action === "update" || args.action === "close") {
    throw new Error("runBroadcast does not handle update or close");
  }
  const fresh = args.action === "new";
  const text = args.action === "send" ? args.text : "";
  const config = await loadConfig();
  const hash = rosterHash(config.broadcast.roster);

  const targets = activeBroadcastTargets(config.broadcast.roster, log);
  if (targets.length === 0) {
    log("no broadcast slots available — enable slots in /broadcast or install Agent CLIs.");
    return;
  }

  // `new` tears down a still-live grid so a fresh one isn't stacked on top of the old panes.
  if (fresh) {
    const old = await loadState(ctx.workspace);
    if (old?.slots && (await gridIsLive(old.slots))) {
      log("closing existing grid (new) …");
      await Promise.all(Object.values(old.slots).map((s) => closeSurface(s).catch(() => {})));
    }
  }

  const saved = fresh ? null : await loadState(ctx.workspace);
  let map = saved?.slots ?? null;
  if (!map || saved?.rosterHash !== hash || !(await gridIsLive(map))) {
    log(`opening ${targets.length} agent panes in ${ctx.cwd} …`);
    map = await openGrid(ctx.origin, targets, ctx.cwd, ctx.workspace);
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
