// One turn of the harness: parse the user's message into a Capability, then route it.
//
//   chat        → show a REPLY (the Orchestrator answered it).
//   web_search  → a single dispatch down the web_search chain (auto-run, no confirm).
//   image       → a single dispatch down the image chain (auto-run, no confirm).
//   coding      → the autonomous PLAN-walk: a plan dispatch (planning chain) authors PLAN.md,
//                 the human approves it once (ADR-0005), then each Step is implemented down the
//                 coding chain and gated on its frozen Acceptance check (ADR-0009).
//
// Every dispatch runs through the Scheduler (`runWithChain`): the most-preferred Agent that is
// still available runs; if it crashes or goes silent it is marked down and the next Agent in the
// chain takes over (ADR-0004). Timed Cooldown / quota-vs-error detection is the open M4 fork.

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseIntent, artifactFilename, resolveTopic, type TaskSpec } from "./orchestrator.ts";
import { DEFAULT_WATCHDOG_MS } from "./agent-runner.ts";
import { runWithChain } from "./scheduler.ts";
import { checkpoint, hasChanges } from "./git.ts";
import { readPlan, recentGitLog } from "./workspace.ts";
import { readSteps, tickStep, planPrompt, stepPrompt, type Step } from "./plan.ts";
import { setStatus, log, openMarkdown, type SurfaceRef } from "./cmux.ts";
import { ui, c } from "./ui.ts";
import type { Config, Capability } from "./config.ts";

export interface TurnDeps {
  workspace: string;
  selfSurface: SurfaceRef;
  /** Per-capability Agent chains. */
  config: Config;
  /** Human gate: approve a coding PLAN.md once before the autonomous walk (ADR-0005). */
  confirmPlan: (summary: string) => Promise<boolean>;
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

  const capability = spec.capability ?? "coding";
  deps.say(ui.dispatch(`${c.gray(`[${capability}]`)} ${spec.task}`));

  if (capability === "coding") {
    await codingJob(spec.task, deps);
  } else {
    await singleDispatch(capability, spec, input, deps);
  }
}

/** Find an optional markdown artifact on disk (exact topic path, else newest prefix match). */
function findArtifactPath(
  workspace: string,
  capability: "web_search" | "image",
  topic: string | null,
): string | null {
  if (topic) {
    const exact = join(workspace, artifactFilename(capability, topic));
    if (existsSync(exact)) return exact;
  }
  const prefix = capability === "web_search" ? "search_" : "image_";
  const matches = readdirSync(workspace)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".md"))
    .map((name) => join(workspace, name));
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0]!;
  const newest = matches.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  return newest ?? null;
}

/** A one-shot capability (web_search / image): auto-run down that capability's chain. */
async function singleDispatch(
  capability: "web_search" | "image",
  spec: TaskSpec,
  userInput: string,
  deps: TurnDeps,
): Promise<void> {
  const goal = spec.task!;
  const chain = deps.config.chains[capability];
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
    deps.say(ui.warn(`ทุก agent ใน ${capability} chain ใช้ไม่ได้แล้ว`));
    return;
  }

  const hash = (await hasChanges(deps.workspace))
    ? await checkpoint(deps.workspace, `${outcome.agent} (${capability}): ${goal}`)
    : null;
  deps.say(ui.ok(`เสร็จแล้ว (${outcome.agent})${hash ? ` — checkpoint ${hash}` : ""}`));

  const topic = resolveTopic(spec, userInput);
  const artifactPath = findArtifactPath(deps.workspace, capability, topic);
  if (!artifactPath) return;

  try {
    await openMarkdown(artifactPath, { surface: deps.selfSurface });
    deps.say(ui.ok(`เปิด ${basename(artifactPath)} ใน markdown viewer`));
  } catch (e) {
    deps.say(ui.warn(`พบ ${basename(artifactPath)} แต่เปิด markdown viewer ไม่ได้: ${(e as Error).message}`));
  }
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
  if (!(await deps.confirmPlan(goal))) {
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
