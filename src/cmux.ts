// Thin wrapper over the `cmux` CLI. Every shape here was validated against the
// real CLI in this environment before being written (see ROADMAP M1).

export type SurfaceRef = `surface:${number}`;
export type Direction = "left" | "right" | "up" | "down";

async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["cmux", ...args], { stdout: "pipe", stderr: "pipe" });
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

// --- Orchestrator status surfaced into the cmux UI (the PRD "top log") ---

export async function setStatus(key: string, value: string): Promise<void> {
  await run(["set-status", key, value]);
}

export async function log(message: string): Promise<void> {
  await run(["log", "--source", "harness", message]);
}
