// Thin wrapper over the `cmux` CLI. Every shape here was validated against the
// real CLI in this environment before being written (see ROADMAP M1).

import { existsSync } from "node:fs";

export type SurfaceRef = `surface:${number}`;
export type PaneRef = `pane:${number}`;
export type Direction = "left" | "right" | "up" | "down";

/** A pane's geometry + the surfaces it hosts, as reported by `list-panes`. */
export interface PaneInfo {
  ref: PaneRef;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  surfaceRefs: SurfaceRef[];
}

function cmuxBin(): string {
  if (process.env.CMUX_BIN) return process.env.CMUX_BIN;
  const onPath = Bun.which("cmux");
  if (onPath) return onPath;
  const bundled = "/Applications/cmux.app/Contents/Resources/bin/cmux";
  if (existsSync(bundled)) return bundled;
  return "cmux";
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([cmuxBin(), ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

async function runJSON<T>(args: string[]): Promise<T> {
  const { stdout, stderr, code } = await run(["--json", ...args]);
  if (code !== 0) throw new Error(`cmux ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  return JSON.parse(stdout) as T;
}

/** The surface this harness is itself running in. */
export async function identifySelf(): Promise<SurfaceRef> {
  const t = await runJSON<{ caller: { surface_ref: SurfaceRef } }>(["identify"]);
  return t.caller.surface_ref;
}

/** The caller's surface and the cmux workspace it lives in (Broadcast keys its state by the latter). */
export async function identifyContext(): Promise<{ surface: SurfaceRef; workspace: string }> {
  const t = await runJSON<{ caller: { surface_ref: SurfaceRef; workspace_ref: string } }>([
    "identify",
  ]);
  return { surface: t.caller.surface_ref, workspace: t.caller.workspace_ref };
}

/** Split off `fromSurface` and return the new (empty) terminal surface. */
export async function newSplit(
  fromSurface: SurfaceRef,
  direction: Direction,
  focus = false,
): Promise<SurfaceRef> {
  const r = await runJSON<{ surface_ref: SurfaceRef }>([
    "new-split",
    direction,
    "--surface",
    fromSurface,
    "--focus",
    String(focus),
  ]);
  return r.surface_ref;
}

/** Type text into a surface's terminal (does NOT press Enter). */
export async function send(surface: SurfaceRef, text: string): Promise<void> {
  const { code, stderr } = await run(["send", "--surface", surface, text]);
  if (code !== 0) throw new Error(`cmux send failed: ${stderr.trim()}`);
}

/** Press a named key (e.g. "enter") in a surface. */
export async function sendKey(surface: SurfaceRef, key: string): Promise<void> {
  const { code, stderr } = await run(["send-key", "--surface", surface, key]);
  if (code !== 0) throw new Error(`cmux send-key failed: ${stderr.trim()}`);
}

/** Send a command line and execute it. */
export async function sendLine(surface: SurfaceRef, line: string): Promise<void> {
  await send(surface, line);
  await sendKey(surface, "enter");
}

/** Read the currently visible screen of a surface. */
export async function readScreen(surface: SurfaceRef, lines = 50): Promise<string> {
  const { stdout, code, stderr } = await run([
    "read-screen",
    "--surface",
    surface,
    "--lines",
    String(lines),
  ]);
  if (code !== 0) throw new Error(`cmux read-screen failed: ${stderr.trim()}`);
  return stdout;
}

export async function closeSurface(surface: SurfaceRef): Promise<void> {
  await run(["close-surface", "--surface", surface]);
}

// --- Pane geometry + resize (Broadcast Equal grid, ADR-0014) ---
// cmux only ever splits a pane in half, so a 3+ pane row comes out 1/2, 1/4, 1/4. We read the
// resulting pixel frames and nudge the internal boundaries with `resize-pane` (tmux-compat;
// --amount is in pixels) until every pane is the same size.

/** List the panes of a workspace with their pixel frames and hosted surfaces. */
export async function listPanes(workspace?: string): Promise<PaneInfo[]> {
  const args = ["list-panes"];
  if (workspace) args.push("--workspace", workspace);
  const r = await runJSON<{
    panes?: Array<{
      ref: PaneRef;
      index: number;
      pixel_frame: { x: number; y: number; width: number; height: number };
      surface_refs?: SurfaceRef[];
    }>;
  }>(args);
  return (r.panes ?? []).map((p) => ({
    ref: p.ref,
    index: p.index,
    x: p.pixel_frame.x,
    y: p.pixel_frame.y,
    width: p.pixel_frame.width,
    height: p.pixel_frame.height,
    surfaceRefs: p.surface_refs ?? [],
  }));
}

/** Move one of a pane's borders by `amount` pixels (tmux-compatible resize). */
export async function resizePane(
  pane: PaneRef,
  dir: "L" | "R" | "U" | "D",
  amount: number,
  workspace?: string,
): Promise<void> {
  if (amount <= 0) return;
  const args = ["resize-pane", "--pane", pane, `-${dir}`, "--amount", String(Math.round(amount))];
  if (workspace) args.push("--workspace", workspace);
  const { code, stderr } = await run(args);
  if (code !== 0) throw new Error(`cmux resize-pane failed: ${stderr.trim()}`);
}

// --- Buffer paste (Broadcast, ADR-0014) ---
// Some TUIs (cursor) drop bracketed/typed input but accept a named-buffer paste. `set-buffer`
// stows the text globally; `paste-buffer` drops it into a surface. Shapes mirror the calls
// validated in ai.py, adapted to comux's surface-addressed style (no explicit --workspace).

/** Store `text` in a named cmux buffer (global; not bound to a surface). */
export async function setBuffer(name: string, text: string): Promise<void> {
  const { code, stderr } = await run(["set-buffer", "--name", name, "--", text]);
  if (code !== 0) throw new Error(`cmux set-buffer failed: ${stderr.trim()}`);
}

/** Paste a named buffer's contents into a surface (does NOT submit). */
export async function pasteBuffer(name: string, surface: SurfaceRef): Promise<void> {
  const { code, stderr } = await run(["paste-buffer", "--name", name, "--surface", surface]);
  if (code !== 0) throw new Error(`cmux paste-buffer failed: ${stderr.trim()}`);
}

// --- Orchestrator status surfaced into the cmux UI (the PRD "top log") ---

export async function setStatus(key: string, value: string): Promise<void> {
  await run(["set-status", key, value]);
}

export async function log(message: string): Promise<void> {
  await run(["log", "--source", "harness", message]);
}

/** Open any file (image, PDF, etc.) in cmux's preview panel. Returns the surface ref. */
export async function openFile(
  filePath: string,
  opts?: { surface?: SurfaceRef },
): Promise<SurfaceRef | null> {
  const args = ["open", filePath, "--focus", "false"];
  if (opts?.surface) args.push("--surface", opts.surface);
  const { code, stdout, stderr } = await run(["--json", ...args]);
  if (code !== 0) throw new Error(`cmux open failed: ${stderr.trim() || stdout.trim()}`);
  try {
    const r = JSON.parse(stdout) as { opened?: Array<{ payload?: { surface_ref?: SurfaceRef } }> };
    return r.opened?.[0]?.payload?.surface_ref ?? null;
  } catch {
    return null;
  }
}

/** Rename the tab that contains `surface` so it can later be found by title. */
export async function renameTab(surface: SurfaceRef, title: string): Promise<void> {
  await run(["rename-tab", "--surface", surface, title]);
}

/** Find the surface whose tab is titled exactly "comux-result"; null if none. */
export async function findResultSurface(): Promise<SurfaceRef | null> {
  const { code, stdout } = await run(["--json", "list-panels"]);
  if (code !== 0) return null;
  try {
    const r = JSON.parse(stdout) as { surfaces?: Array<{ title?: string; ref?: SurfaceRef }> };
    return r.surfaces?.find((s) => s.title === "comux-result")?.ref ?? null;
  } catch {
    return null;
  }
}

/**
 * Close all open agent surfaces (tabs titled "comux-*" but not "comux-result").
 * Called before opening a new agent pane so stale agent tabs don't accumulate.
 */
export async function closeAgentSurfaces(): Promise<void> {
  const { code, stdout } = await run(["--json", "list-panels"]);
  if (code !== 0) return;
  try {
    const r = JSON.parse(stdout) as { surfaces?: Array<{ title?: string; ref?: SurfaceRef }> };
    const stale = (r.surfaces ?? []).filter(
      (s) => s.ref && s.title?.startsWith("comux-") && s.title !== "comux-result",
    );
    await Promise.all(stale.map((s) => closeSurface(s.ref!).catch(() => {})));
  } catch {
    /* best-effort */
  }
}

/** Open a markdown file in cmux's viewer panel (live-reloads on disk changes).
 *  Returns the surface ref of the viewer, or null if unavailable. */
export async function openMarkdown(
  filePath: string,
  opts?: { surface?: SurfaceRef; noFocus?: boolean },
): Promise<SurfaceRef | null> {
  const noFocus = opts?.noFocus ?? true;
  const focusVal = noFocus ? "false" : "true";
  const attempts: string[][] = [];
  if (opts?.surface) {
    attempts.push(["markdown", "open", filePath, "--surface", opts.surface, "--focus", focusVal]);
  }
  attempts.push(["markdown", "open", filePath, "--focus", focusVal]);

  let lastErr = "";
  for (const args of attempts) {
    const { code, stderr, stdout } = await run(["--json", ...args]);
    if (code === 0) {
      try {
        const parsed = JSON.parse(stdout) as { surface_ref?: SurfaceRef };
        return parsed.surface_ref ?? null;
      } catch {
        return null;
      }
    }
    lastErr = stderr.trim() || stdout.trim();
  }
  throw new Error(`cmux markdown open failed: ${lastErr}`);
}
