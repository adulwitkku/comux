// One turn of the harness: parse the user's message into a Capability, then route it.
//
//   chat        → show a REPLY (the Orchestrator answered it).
//   web_search  → a single dispatch down the web_search chain.
//   image       → a single dispatch down the image chain.
//   coding      → the autonomous PLAN-walk: a plan dispatch (planning chain) authors PLAN.md,
//                 the human approves it once (ADR-0005), then each Step is implemented down the
//                 coding chain and gated on its frozen Acceptance check (ADR-0009).
//
// Every dispatch runs through the Scheduler (`runWithChain`): the most-preferred Agent that is
// still available runs; if it crashes or goes silent it is marked down and the next Agent in the
// chain takes over (ADR-0004). Timed Cooldown / quota-vs-error detection is the open M4 fork.

import { parseIntent } from "./orchestrator.ts";
import { DEFAULT_WATCHDOG_MS } from "./agent-runner.ts";
import { runWithChain } from "./scheduler.ts";
import { checkpoint, hasChanges } from "./git.ts";
import { readPlan, recentGitLog } from "./workspace.ts";
import { readSteps, tickStep, planPrompt, stepPrompt, type Step } from "./plan.ts";
import { setStatus, log, type SurfaceRef } from "./cmux.ts";
import { ui, c } from "./ui.ts";
import type { Config, Capability } from "./config.ts";

export interface TurnDeps {
  workspace: string;
  selfSurface: SurfaceRef;
  /** Per-capability Agent chains. */
  config: Config;
  /** Human gate: approve a coding plan, or a single-shot dispatch, before it runs (ADR-0005). */
  confirm: (summary: string) => Promise<boolean>;
  /** Emit a line to the user. */
  say: (msg: string) => void;
  watchdogMs?: number;
}

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
  const capability = spec.capability ?? "coding";
  deps.say(ui.dispatch(`${c.gray(`[${capability}]`)} ${goal}`));

  if (capability === "coding") {
    await codingJob(goal, deps);
  } else {
    await singleDispatch(capability, goal, deps);
  }
}

/** A one-shot capability (web_search / image): run the goal down that capability's chain. */
async function singleDispatch(capability: Capability, goal: string, deps: TurnDeps): Promise<void> {
  const chain = deps.config.chains[capability];
  if (!(await deps.confirm(goal))) {
    await setStatus("harness", "idle");
    deps.say(ui.warn("cancelled."));
    return;
  }
  await setStatus("harness", `running ${capability}`);
  await log(`${capability}: ${goal}`);

  const outcome = await runWithChain({
    chain,
    prompt: goal,
    workspace: deps.workspace,
    fromSurface: deps.selfSurface,
    watchdogMs: deps.watchdogMs ?? DEFAULT_WATCHDOG_MS,
    down: new Set(),
    say: deps.say,
    label: capability,
  });

  await setStatus("harness", "idle");
  if (!outcome.ok) {
    deps.say(ui.warn(`every agent in the ${capability} chain was exhausted.`));
    return;
  }
  // web_search answers in the pane; image (and any file writes) get checkpointed.
  const hash = (await hasChanges(deps.workspace))
    ? await checkpoint(deps.workspace, `${outcome.agent} (${capability}): ${goal}`)
    : null;
  deps.say(ui.ok(`done via ${outcome.agent}${hash ? ` — checkpoint ${hash}` : ""}`));
}

/** A coding job: plan (planning chain) → approve once → walk Steps (coding chain). */
async function codingJob(goal: string, deps: TurnDeps): Promise<void> {
  const watchdogMs = deps.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const down = new Set<string>(); // agents that fall over stay down for the rest of the job

  // 1. Plan dispatch — author PLAN.md down the planning chain (a confined write; nothing built).
  await setStatus("harness", "planning");
  await log(`plan dispatch: ${goal}`);
  const planned = await runWithChain({
    chain: deps.config.chains.planning,
    prompt: planPrompt(goal),
    workspace: deps.workspace,
    fromSurface: deps.selfSurface,
    watchdogMs,
    down,
    say: deps.say,
    label: "planning",
  });
  if (!planned.ok) {
    await setStatus("harness", "idle");
    deps.say(ui.warn("every agent in the planning chain was exhausted. aborting."));
    return;
  }

  const steps = await readSteps(deps.workspace);
  if (steps.length === 0) {
    await setStatus("harness", "idle");
    deps.say(ui.warn("no verifiable steps in PLAN.md (each step needs a `check:`). aborting."));
    return;
  }
  await checkpoint(deps.workspace, `plan: ${goal}`);

  // 2. Approve once — gate the whole autonomous walk on a single confirm.
  deps.say(ui.banner("  PLAN"));
  steps.forEach((s, i) =>
    deps.say(`  ${c.bold(String(i + 1))}. ${s.description}  ${c.gray(`· check: ${s.check}`)}`),
  );
  if (!(await deps.confirm(goal))) {
    await setStatus("harness", "idle");
    deps.say(ui.warn("cancelled."));
    return;
  }

  // 3. Walk — implement each Step down the coding chain, gated on its Acceptance check.
  await walkPlan(steps, deps, down, watchdogMs);
}

async function walkPlan(steps: Step[], deps: TurnDeps, down: Set<string>, watchdogMs: number): Promise<void> {
  const total = steps.length;

  for (const [idx, step] of steps.entries()) {
    const n = idx + 1;
    if (step.done) {
      deps.say(ui.ok(`step ${n}/${total} already done — skipping`));
      continue;
    }

    await setStatus("harness", `step ${n}/${total}`);
    await log(`step ${n}/${total}: ${step.description}`);
    const outcome = await runWithChain({
      chain: deps.config.chains.coding,
      prompt: stepPrompt(step),
      workspace: deps.workspace,
      fromSurface: deps.selfSurface,
      watchdogMs,
      down,
      check: step.check,
      say: deps.say,
      label: `step ${n}/${total}`,
    });

    if (!outcome.ok) {
      await setStatus("harness", "idle");
      deps.say(ui.warn(`stopped at step ${n}/${total}: coding chain exhausted. left at last checkpoint. [resume via M5 handover]`));
      return;
    }

    await tickStep(deps.workspace, step);
    const hash = await checkpoint(deps.workspace, `${outcome.agent}: ${step.description}`);
    deps.say(ui.ok(`step ${n}/${total} done via ${outcome.agent}${hash ? ` — checkpoint ${hash}` : ""}`));
  }

  await setStatus("harness", "idle");
  deps.say(ui.ok(`all ${total} steps done.`));
}
