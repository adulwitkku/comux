// One turn of the harness: parse the user's message, then either reply or dispatch the
// task to an Agent running visibly in a cmux pane and checkpoint the result.
//
// This wires together M1 (agent-runner) and M2 (orchestrator). The Scheduler/fallback
// (M4) and autonomous multi-step PLAN walk are not here yet: each dispatch is a single
// step gated by the user (a simplified stand-in for ADR-0005's approve-once).

import { parseIntent } from "./orchestrator.ts";
import { runAgentStep } from "./agent-runner.ts";
import { selectAgent } from "./agents.ts";
import { checkpoint } from "./git.ts";
import { readPlan, recentGitLog } from "./workspace.ts";
import { setStatus, log, type SurfaceRef } from "./cmux.ts";
import { ui } from "./ui.ts";

export interface TurnDeps {
  workspace: string;
  selfSurface: SurfaceRef;
  /** Human gate before an Agent runs (it writes files). */
  confirm: (task: string) => Promise<boolean>;
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

  const task = spec.task;
  deps.say(ui.dispatch(task));
  if (!(await deps.confirm(task))) {
    await setStatus("harness", "idle");
    deps.say(ui.warn("cancelled."));
    return;
  }

  const agent = selectAgent();
  await setStatus("harness", `running ${agent.name}`);
  await log(`dispatch to ${agent.name}: ${task}`);
  deps.say(ui.running(`running ${agent.name} in a new pane…`));

  const result = await runAgentStep({
    fromSurface: deps.selfSurface,
    launchCommand: agent.buildCommand(task, deps.workspace),
    watchdogMs: deps.watchdogMs ?? 180_000,
    closeOnEnd: false,
  });

  await setStatus("harness", "idle");

  if (result.outcome === "stuck") {
    deps.say(ui.warn(`${agent.name} went silent (watchdog). [fallback comes in M4]`));
    return;
  }
  if (result.exitCode !== 0) {
    deps.say(ui.warn(`${agent.name} exited ${result.exitCode}. [fallback comes in M4]`));
    return;
  }

  const hash = await checkpoint(deps.workspace, `${agent.name}: ${task}`);
  deps.say(hash ? ui.ok(`done — checkpoint ${hash}`) : ui.ok("done — (no file changes to commit)"));
}
