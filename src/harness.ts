// One turn of the harness (M3.5): parse the user's message, then either reply or run an
// autonomous, check-verified PLAN-walk with a single Agent.
//
// Flow for a coding request (ADR-0009 / ADR-0005):
//   1. Plan dispatch  — an Agent authors PLAN.md: Steps, each with a frozen Acceptance check.
//   2. Approve once   — the human approves the whole plan up front (not per step).
//   3. Walk           — for each unchecked Step: dispatch the work, run its Acceptance check,
//                       and only on a passing check tick the box + git-checkpoint.
//
// Multi-Agent handover/scheduling (M4/M5) is not here: a Step whose check keeps failing stops
// the walk rather than switching Agents. A failing Step is left at the last good checkpoint so
// a future Handover can resume it.

import { parseIntent } from "./orchestrator.ts";
import { runAgentStep, DEFAULT_WATCHDOG_MS } from "./agent-runner.ts";
import { selectAgent, type Agent } from "./agents.ts";
import { checkpoint } from "./git.ts";
import { readPlan, recentGitLog } from "./workspace.ts";
import { readSteps, tickStep, planPrompt, stepPrompt, type Step } from "./plan.ts";
import { runCheck } from "./check.ts";
import { setStatus, log, type SurfaceRef } from "./cmux.ts";
import { ui, c } from "./ui.ts";

export interface TurnDeps {
  workspace: string;
  selfSurface: SurfaceRef;
  /** Human gate: approve the whole plan once before the autonomous walk (ADR-0005). */
  confirm: (summary: string) => Promise<boolean>;
  /** Emit a line to the user. */
  say: (msg: string) => void;
  watchdogMs?: number;
}

/** How many times a single Step is attempted before the walk stops (handover is M5). */
const STEP_ATTEMPTS = 2;

export async function runTurn(input: string, deps: TurnDeps): Promise<void> {
  const planMd = await readPlan(deps.workspace);
  const gitLog = await recentGitLog(deps.workspace);

  await setStatus("harness", "thinking");
  const spec = await parseIntent(input, { planMd, gitLog });

  if (spec.task === null) {
    await setStatus("harness", "idle");
    deps.say(ui.reply(spec.reply ?? "(no reply)"));
    return;
  }

  const goal = spec.task;
  const agent = selectAgent();
  const watchdogMs = deps.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  deps.say(ui.dispatch(goal));

  // 1. Plan dispatch — the Agent authors PLAN.md (a confined write); nothing is built yet.
  const steps = await planJob(goal, agent, deps, watchdogMs);
  if (!steps) return;

  // 2. Approve once — show the plan, gate the whole autonomous walk on a single confirm.
  deps.say(ui.banner("  PLAN"));
  steps.forEach((s, i) =>
    deps.say(`  ${c.bold(String(i + 1))}. ${s.description}  ${c.gray(`· check: ${s.check}`)}`),
  );
  if (!(await deps.confirm(goal))) {
    await setStatus("harness", "idle");
    deps.say(ui.warn("cancelled."));
    return;
  }

  // 3. Walk — implement each Step, gate it on its Acceptance check, checkpoint on pass.
  await walkPlan(steps, agent, deps, watchdogMs);
}

/** Run the Plan dispatch and return the parsed Steps, or null if planning failed. */
async function planJob(
  goal: string,
  agent: Agent,
  deps: TurnDeps,
  watchdogMs: number,
): Promise<Step[] | null> {
  await setStatus("harness", `planning with ${agent.name}`);
  await log(`plan dispatch to ${agent.name}: ${goal}`);
  deps.say(ui.running(`planning with ${agent.name} in a new pane…`));

  const result = await runAgentStep({
    fromSurface: deps.selfSurface,
    launchCommand: agent.buildCommand(planPrompt(goal), deps.workspace),
    watchdogMs,
    closeOnEnd: false,
  });

  if (result.outcome !== "completed" || result.exitCode !== 0) {
    await setStatus("harness", "idle");
    const why = result.outcome === "stuck" ? "went silent (watchdog)" : `exited ${result.exitCode}`;
    deps.say(ui.warn(`planning failed — ${agent.name} ${why}.`));
    return null;
  }

  const steps = await readSteps(deps.workspace);
  if (steps.length === 0) {
    await setStatus("harness", "idle");
    deps.say(ui.warn("no verifiable steps found in PLAN.md (each step needs a `check:`). aborting."));
    return null;
  }

  // Checkpoint the plan itself so the walk resumes from a known-good PLAN.md.
  await checkpoint(deps.workspace, `plan: ${goal}`);
  return steps;
}

/** Implement each unchecked Step, gating completion on its Acceptance check. */
async function walkPlan(
  steps: Step[],
  agent: Agent,
  deps: TurnDeps,
  watchdogMs: number,
): Promise<void> {
  const total = steps.length;

  for (const [idx, step] of steps.entries()) {
    const n = idx + 1;
    if (step.done) {
      deps.say(ui.ok(`step ${n}/${total} already done — skipping`));
      continue;
    }

    let passed = false;
    for (let attempt = 1; attempt <= STEP_ATTEMPTS && !passed; attempt++) {
      await setStatus("harness", `step ${n}/${total} (${agent.name}, try ${attempt})`);
      await log(`step ${n}/${total} to ${agent.name}: ${step.description}`);
      deps.say(ui.running(`step ${n}/${total}: ${step.description}${attempt > 1 ? ` (retry ${attempt})` : ""}`));

      const result = await runAgentStep({
        fromSurface: deps.selfSurface,
        launchCommand: agent.buildCommand(stepPrompt(step), deps.workspace),
        watchdogMs,
        closeOnEnd: false,
      });
      if (result.outcome !== "completed") {
        deps.say(ui.warn(`${agent.name} went silent on step ${n} (watchdog).`));
        break; // a stuck Agent will not pass on retry; stop here.
      }

      const check = await runCheck(step.check, deps.workspace);
      if (check.ok) {
        passed = true;
      } else {
        const tail = check.output.split("\n").slice(-1)[0] ?? "";
        deps.say(
          ui.warn(`check failed (exit ${check.exitCode}): ${step.check}${tail ? ` — ${c.gray(tail)}` : ""}`),
        );
      }
    }

    if (!passed) {
      await setStatus("harness", "idle");
      deps.say(ui.warn(`stopped at step ${n}/${total}. left at last checkpoint. [handover comes in M5]`));
      return;
    }

    await tickStep(deps.workspace, step);
    const hash = await checkpoint(deps.workspace, `${agent.name}: ${step.description}`);
    deps.say(ui.ok(`step ${n}/${total} done${hash ? ` — checkpoint ${hash}` : ""}`));
  }

  await setStatus("harness", "idle");
  deps.say(ui.ok(`all ${total} steps done.`));
}
