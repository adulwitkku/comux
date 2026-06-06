// PLAN.md is the job: an ordered list of Steps, each a checklist item paired with a frozen
// Acceptance check (ADR-0009). This module owns the on-disk format so the parser and the
// prompt that asks an Agent to author it stay in sync.
//
// Format (authored by the Plan dispatch, walked by the deterministic Harness):
//
//   # Plan: <goal>
//
//   - [ ] <imperative step description>
//     - check: `<one shell command that exits 0 only when the step is done>`
//   - [x] <a completed step>
//     - check: `test -f hello.txt`

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface Step {
  /** Imperative description of the work. */
  description: string;
  /** Frozen Acceptance check: a shell command that exits 0 iff the step is complete. */
  check: string;
  /** Whether the checklist item is already ticked. */
  done: boolean;
}

const STEP_RE = /^\s*-\s*\[([ xX])\]\s+(.*\S)\s*$/;
// Accept the check with or without backticks: "- check: `cmd`" or "check: cmd".
const CHECK_RE = /check:\s*(?:`([^`]+)`|(.+?))\s*$/i;

/** Parse PLAN.md text into Steps. A step with no check line is dropped (it is unverifiable). */
export function parsePlan(text: string): Step[] {
  const lines = text.split("\n");
  const steps: Step[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(STEP_RE);
    if (!m) continue;
    const done = m[1] !== " ";
    const description = m[2]!.trim();

    // The check lives on a following line, before the next step header.
    let check: string | null = null;
    for (let j = i + 1; j < lines.length && !lines[j]!.match(STEP_RE); j++) {
      const cm = lines[j]!.match(CHECK_RE);
      if (cm) {
        check = (cm[1] ?? cm[2] ?? "").trim();
        break;
      }
    }
    if (check) steps.push({ description, check, done });
  }
  return steps;
}

export async function readSteps(dir: string): Promise<Step[]> {
  const p = join(dir, "PLAN.md");
  return existsSync(p) ? parsePlan(await readFile(p, "utf8")) : [];
}

/**
 * Tick the first unchecked step whose description matches. Returns true if a box was flipped.
 * Matches on the description (not a line index) so it survives unrelated edits to PLAN.md.
 */
export async function tickStep(dir: string, step: Step): Promise<boolean> {
  const p = join(dir, "PLAN.md");
  if (!existsSync(p)) return false;
  const lines = (await readFile(p, "utf8")).split("\n");

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(STEP_RE);
    if (!m || m[1] !== " " || m[2]!.trim() !== step.description) continue;
    lines[i] = lines[i]!.replace(/\[ \]/, "[x]");
    await writeFile(p, lines.join("\n"));
    return true;
  }
  return false;
}

/** The Plan dispatch: instruct an Agent to author PLAN.md in the format above, then stop. */
export function planPrompt(goal: string): string {
  return [
    "You are writing a build plan. Do NOT build anything yet.",
    "",
    "Create a file named PLAN.md in the current directory that breaks this goal into the",
    "smallest sensible, independently-verifiable steps:",
    "",
    `GOAL: ${goal}`,
    "",
    "Write PLAN.md in EXACTLY this markdown format:",
    "",
    "# Plan: <one-line restatement of the goal>",
    "",
    "- [ ] <imperative description of step 1>",
    "  - check: `<a single shell command>`",
    "- [ ] <imperative description of step 2>",
    "  - check: `<a single shell command>`",
    "",
    "Rules:",
    "- Every step MUST have a `check:` line: ONE shell command that exits 0 only when that",
    "  step is genuinely complete. Prefer `bun run typecheck`, a test, `grep -q`, or `test -f`.",
    "- Keep steps small — as small as you can still write a check for.",
    "- Do NOT implement any step. Only write PLAN.md, then stop.",
  ].join("\n");
}

/** The implementation dispatch for a single Step. */
export function stepPrompt(step: Step): string {
  return [
    "Read PLAN.md and the existing files before editing.",
    "",
    "Implement ONLY this step:",
    `  ${step.description}`,
    "",
    "The step is complete when this command exits 0:",
    `  ${step.check}`,
    "",
    "Do not start other steps and do not edit PLAN.md. Stop once the check would pass.",
  ].join("\n");
}
