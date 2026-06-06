#!/usr/bin/env bun
// M5-spike: prove Handover QUALITY (the cheapest risky thing before building the Scheduler).
//
// The make-or-break question: can a *heterogeneous* Agent resume cold from git + PLAN.md and
// finish a job to an acceptable standard WITHOUT clobbering the previous Agent's work?
//
// Experiment (everything controlled except the handover): a hand-authored 2-Step PLAN.md where
// Step 2 depends on Step 1's artifact. Agent A (pi) does Step 1; then Agent B (Claude Code) —
// a different process with no shared memory — resumes from the repo + PLAN.md and does Step 2.
// We then re-run Step 1's frozen check to confirm B did not break A's work.
//
// Needs a live cmux + pi + claude on PATH. Not a CI gate.

import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identifySelf } from "../src/cmux.ts";
import { ensureWorkspace, recentGitLog } from "../src/workspace.ts";
import { runAgentStep, DEFAULT_WATCHDOG_MS } from "../src/agent-runner.ts";
import { runCheck } from "../src/check.ts";
import { checkpoint } from "../src/git.ts";
import { tickStep, stepPrompt, type Step } from "../src/plan.ts";
import { pi, claudeCode, type Agent } from "../src/agents.ts";

function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
}

// Step 2's check transitively re-runs greet.sh, so the Makefile must respect A's Step-1 work.
const steps: Step[] = [
  {
    description: "Create greet.sh that prints the line 'hello world' when run with sh.",
    check: "sh greet.sh | grep -q 'hello world'",
    done: false,
  },
  {
    description: "Create a Makefile whose 'run' target runs greet.sh.",
    check: "make run | grep -q 'hello world'",
    done: false,
  },
];

const PLAN = [
  "# Plan: greet via a Makefile",
  "",
  ...steps.flatMap((s) => [`- [ ] ${s.description}`, `  - check: \`${s.check}\``]),
  "",
].join("\n");

const workspace = await ensureWorkspace(mkdtempSync(join(tmpdir(), "comux-spike-")));
const selfSurface = await identifySelf();
await writeFile(join(workspace, "PLAN.md"), PLAN);
await checkpoint(workspace, "plan: greet via a Makefile (hand-authored for the spike)");
console.log(`workspace: ${workspace}\n`);

async function doStep(agent: Agent, step: Step, n: number): Promise<boolean> {
  console.log(`\n=== step ${n} via ${agent.name} ===`);
  const r = await runAgentStep({
    fromSurface: selfSurface,
    launchCommand: agent.buildCommand(stepPrompt(step), workspace),
    watchdogMs: DEFAULT_WATCHDOG_MS,
    closeOnEnd: false,
  });
  if (r.outcome !== "completed") {
    console.log(`  ${agent.name} went silent (watchdog).`);
    return false;
  }
  if (r.exitCode !== 0) {
    console.log(`  ${agent.name} exited ${r.exitCode}.`);
    return false;
  }
  const c = await runCheck(step.check, workspace);
  console.log(`  check: ${step.check}  ->  ${c.ok ? "PASS" : `FAIL (exit ${c.exitCode})`}`);
  if (c.ok) {
    await tickStep(workspace, step);
    await checkpoint(workspace, `${agent.name}: ${step.description}`);
  }
  return c.ok;
}

// Agent A (pi) does Step 1.
const aOk = await doStep(pi, steps[0]!, 1);
ok("agent A (pi) completed step 1", aOk);

// HANDOVER → Agent B (Claude Code) resumes cold from git + PLAN.md and does Step 2.
const bOk = aOk ? await doStep(claudeCode, steps[1]!, 2) : false;
ok("agent B (claude) resumed from git + PLAN.md and completed step 2", bOk);

// Regression: did B preserve A's work? Re-run Step 1's frozen check after the handover.
const regression = await runCheck(steps[0]!.check, workspace);
ok(
  "agent A's step-1 work still passes after B's handover (no clobber)",
  regression.ok,
  regression.ok ? "" : `exit ${regression.exitCode}`,
);

console.log("\n--- git log ---");
console.log(await recentGitLog(workspace, 9));
console.log(`\nworkspace kept at: ${workspace}`);
