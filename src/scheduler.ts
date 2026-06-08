// The Scheduler: run a task against a Capability's chain, picking the most-preferred Agent that
// is still available and falling to the next when one is unavailable (ADR-0004).
//
// Failure handling, current cut: crash (non-zero exit) or watchdog silence is treated as the
// Agent being unavailable, so it is marked "down" and skipped for the rest of the job (the chain
// is the fallback). A passing-process-but-failing-check means the work is wrong, not the Agent
// unavailable, so we move to the next Agent for this step only without marking it down.
//
// NOT yet distinguished: a quota/rate-limit exit (which deserves a timed Cooldown + bounce-back)
// from an ordinary error. Until that detection lands (the open M4 fork in ROADMAP), "down" is a
// per-job set with no timed reset.

import { runAgentStep } from "./agent-runner.ts";
import { runCheck } from "./check.ts";
import { agentByName } from "./agents.ts";
import { ui } from "./ui.ts";
import type { SurfaceRef } from "./cmux.ts";

export type AttemptResult = "completed" | "stuck" | "exit" | "check-fail" | "missing";

export interface ChainAttempt {
  agent: string;
  result: AttemptResult;
  exitCode?: number;
}

export interface ChainOutcome {
  ok: boolean;
  /** The Agent that succeeded, or null if the whole chain was exhausted. */
  agent: string | null;
  attempts: ChainAttempt[];
  /** The cmux surface the successful Agent ran in; callers may close it when ready. */
  surface?: SurfaceRef;
}

export interface ChainRunOpts {
  /** Ordered Agent names (most-preferred first). */
  chain: string[];
  /** The prompt seeded into each Agent. */
  prompt: string;
  workspace: string;
  fromSurface: SurfaceRef;
  watchdogMs: number;
  /** Agents marked unavailable earlier in this job; mutated as more fall over. */
  down: Set<string>;
  /** Optional Acceptance check gating success (ADR-0009). */
  check?: string;
  say: (msg: string) => void;
  /** Human-readable label for log lines, e.g. "step 2/3" or "web_search". */
  label: string;
}

export async function runWithChain(opts: ChainRunOpts): Promise<ChainOutcome> {
  const attempts: ChainAttempt[] = [];

  for (const name of opts.chain) {
    const agent = agentByName(name);
    if (!agent) {
      attempts.push({ agent: name, result: "missing" });
      continue;
    }
    if (opts.down.has(name)) continue; // already unavailable this job

    // Tab title: "comux-<label>-<agent>" with label sanitized (e.g. "step 2/3" → "step-2-3").
    const safeLabel = opts.label.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
    const tabTitle = `comux-${safeLabel}-${name}`;

    opts.say(ui.running(`${opts.label}: ${name} in a new pane…`));
    const r = await runAgentStep({
      fromSurface: opts.fromSurface,
      launchCommand: agent.buildCommand(opts.prompt, opts.workspace),
      watchdogMs: opts.watchdogMs,
      closeOnEnd: false,
      // ADR-0015: detect a finished interactive turn via cmux lifecycle (idle), not just the
      // exit sentinel. headless Agents (pi/agy) still resolve via the sentinel below.
      lifecycleAgent: agent.hookName,
      workspace: opts.workspace,
      tabTitle,
    });

    if (r.outcome === "stuck") {
      attempts.push({ agent: name, result: "stuck" });
      opts.down.add(name);
      opts.say(ui.warn(`${name} went silent (watchdog) — trying next in chain`));
      continue;
    }
    if (r.outcome === "completed" && r.exitCode !== 0) {
      attempts.push({ agent: name, result: "exit", exitCode: r.exitCode });
      opts.down.add(name);
      opts.say(ui.warn(`${name} exited ${r.exitCode} — trying next in chain`));
      continue;
    }
    // r.outcome is "completed" with exit 0, or "idle" (interactive turn finished) — a success
    // candidate. The frozen Acceptance check, not the exit/lifecycle, decides "done" (ADR-0009).

    if (opts.check) {
      const c = await runCheck(opts.check, opts.workspace);
      if (!c.ok) {
        attempts.push({ agent: name, result: "check-fail", exitCode: c.exitCode });
        opts.say(ui.warn(`${name}: check failed (exit ${c.exitCode}) — trying next in chain`));
        continue; // work is wrong, not the Agent unavailable; don't mark down
      }
    }

    attempts.push({ agent: name, result: "completed" });
    return { ok: true, agent: name, attempts, surface: r.surface };
  }

  return { ok: false, agent: null, attempts };
}
