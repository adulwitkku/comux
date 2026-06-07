// Run one Agent step in a VISIBLE cmux pane and detect completion/stuck (ADR-0001, ADR-0015).
//
// Completion detection (ADR-0015): an interactive Agent TUI (ADR-0012) does NOT exit when it
// finishes a turn, so the old exit sentinel alone mis-read a finished Agent as "stuck". We key
// completion off cmux's agent lifecycle instead:
//
//  - `idle`       — the Agent finished its turn → step complete (caller runs the Acceptance check;
//                   the check, not the lifecycle, decides whether the work is correct — ADR-0009).
//  - `needsInput` — the Agent is blocked on a decision → NOT completion; Grilling / Bypass mode
//                   answers it out of band (ADR-0016), so we keep waiting (and treat it as
//                   activity so the silence watchdog does not fire).
//  - exit sentinel (`__CMUX_EXIT__=$?`) — still read, as the fallback for headless Agents that DO
//    exit (e.g. `pi -p`, `agy -p`) and to catch a real crash with its exit code.
//
// A stale `idle` from a PRIOR run in the same workspace would be a false positive, so `idle` only
// counts once we have seen the Agent actually become active (running / needsInput) this turn — or,
// when hooks are unavailable, we fall through to the exit sentinel and the silence watchdog.
//
// Detection biases toward false-negatives: better to let a step run slightly too long than kill a
// healthy Agent and force a risky handover.

import {
  newSplit,
  sendLine,
  readScreen,
  closeSurface,
  type SurfaceRef,
} from "./cmux.ts";
import { readAgentLifecycle } from "./lifecycle.ts";

const EXIT_SENTINEL = /__CMUX_EXIT__=(\d+)/;

/** Default silence threshold: a step is "stuck" after this long with no screen change. */
export const DEFAULT_WATCHDOG_MS = 180_000;

export interface StepOptions {
  /** Surface to split off (defaults to the harness's own surface). */
  fromSurface: SurfaceRef;
  /** The command that launches the Agent, seeded with its task. */
  launchCommand: string;
  /** Silence threshold in ms before the step is considered stuck. */
  watchdogMs?: number;
  /** How often to sample the screen / lifecycle, in ms. */
  pollMs?: number;
  /** Close the Agent's surface when the step ends. Default false (stay visible). */
  closeOnEnd?: boolean;
  /** cmux hook name for lifecycle detection (ADR-0015); omit to rely on the exit sentinel only. */
  lifecycleAgent?: string;
  /** Workspace cwd to match the lifecycle session against (paired with `lifecycleAgent`). */
  workspace?: string;
}

export type StepResult =
  | { outcome: "completed"; exitCode: number; surface: SurfaceRef } // exit sentinel (headless/crash)
  | { outcome: "idle"; surface: SurfaceRef } // lifecycle: interactive turn finished
  | { outcome: "stuck"; surface: SurfaceRef }; // silence watchdog backstop

export async function runAgentStep(opts: StepOptions): Promise<StepResult> {
  const watchdogMs = opts.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const pollMs = opts.pollMs ?? 1_000;
  const useLifecycle = Boolean(opts.lifecycleAgent && opts.workspace);

  const surface = await newSplit(opts.fromSurface, "down", false);
  // Seed the task via the launch command; sentinel captures the exit code of agents that exit.
  await sendLine(surface, `${opts.launchCommand}; echo __CMUX_EXIT__=$?`);

  let lastScreen = "";
  let lastChange = Date.now();
  let sawActive = false; // guards against a stale `idle` from a previous run in this workspace

  try {
    for (;;) {
      await Bun.sleep(pollMs);
      const screen = await readScreen(surface);

      const match = screen.match(EXIT_SENTINEL);
      if (match) {
        return { outcome: "completed", exitCode: Number(match[1]), surface };
      }

      if (useLifecycle) {
        const lifecycle = await readAgentLifecycle(opts.lifecycleAgent!, opts.workspace!);
        if (lifecycle === "running" || lifecycle === "needsInput") {
          sawActive = true;
          lastChange = Date.now(); // active (incl. waiting on input) ≠ silent; hold the watchdog
        } else if (lifecycle === "idle" && sawActive) {
          return { outcome: "idle", surface };
        }
      }

      if (screen !== lastScreen) {
        lastScreen = screen;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= watchdogMs) {
        return { outcome: "stuck", surface };
      }
    }
  } finally {
    if (opts.closeOnEnd) await closeSurface(surface);
  }
}
