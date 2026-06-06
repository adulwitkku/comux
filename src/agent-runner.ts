// M1: run one Agent step in a VISIBLE cmux pane and detect completion/stuck.
//
// Design (see ADR-0001):
//  - The Agent runs as its real process in a cmux terminal surface, so the user
//    watches it work. We do NOT run it headless.
//  - Completion + exit code come from a shell sentinel appended after the launch
//    command (`<cmd>; echo __CMUX_EXIT__=$?`), read back via `read-screen`.
//  - A watchdog watches for screen *silence*: if the visible screen stops changing
//    for `watchdogMs`, the step is treated as stuck (≠ a total timeout — an Agent may
//    run for hours as long as it keeps producing output).
//
// Detection biases toward false-negatives: we would rather let a step run slightly
// too long than kill a healthy Agent and force a risky handover.

import {
  newSplit,
  sendLine,
  readScreen,
  closeSurface,
  type SurfaceRef,
} from "./cmux.ts";

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
  /** How often to sample the screen, in ms. */
  pollMs?: number;
  /** Close the Agent's surface when the step ends. Default false (stay visible). */
  closeOnEnd?: boolean;
}

export type StepResult =
  | { outcome: "completed"; exitCode: number; surface: SurfaceRef }
  | { outcome: "stuck"; surface: SurfaceRef };

export async function runAgentStep(opts: StepOptions): Promise<StepResult> {
  const watchdogMs = opts.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const pollMs = opts.pollMs ?? 1_000;

  const surface = await newSplit(opts.fromSurface, "down", false);
  // Seed the task via the launch command; sentinel captures the exit code.
  await sendLine(surface, `${opts.launchCommand}; echo __CMUX_EXIT__=$?`);

  let lastScreen = "";
  let lastChange = Date.now();

  try {
    for (;;) {
      await Bun.sleep(pollMs);
      const screen = await readScreen(surface);

      const match = screen.match(EXIT_SENTINEL);
      if (match) {
        return { outcome: "completed", exitCode: Number(match[1]), surface };
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
