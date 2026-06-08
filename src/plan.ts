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

/** The markdown file every dispatch writes its answer/summary to; the Harness opens it (ADR-0018). */
export const REPORT_FILE = ".comux/REPORT.md";

/**
 * Appended to every implementation/single dispatch so the Agent's answer lands as a markdown
 * artifact the Harness opens in cmux's viewer (ADR-0018) — the TUI renders tables/images/graphs
 * poorly, so the readable answer always lives in markdown.
 */
export function outputInstruction(): string {
  return [
    "",
    `When you are done, write a concise summary of what you did and any results to \`${REPORT_FILE}\``,
    "in the working directory, as GitHub-flavored Markdown (use headings, tables, links, and image",
    "references where they help). This file is what the user reads, so make it self-contained.",
  ].join("\n");
}

/**
 * Appended to `image` dispatches: ask the Agent to copy the generated image into the workspace
 * so the Harness can find and open it without agent-specific path knowledge.
 */
export function imageInstruction(): string {
  return [
    "",
    "After generating the image, copy it to `.comux/result.png` (or `.jpg`/`.webp` as appropriate)",
    "in the current working directory so the Harness can display it. Create `.comux/` if needed.",
  ].join("\n");
}

/**
 * Appended to dispatches that may benefit from a real browser (ADR-0018): the Agent can test a web
 * app it built or gather information by driving cmux's browser. Only skill/CLI-capable Agents will
 * act on it; it is harmless otherwise.
 */
export function browserHint(): string {
  return [
    "",
    "If you need to view or test a web page (e.g. a web app you just built, or to gather",
    "information), you can drive a real browser via the cmux CLI:",
    "  cmux browser open <url>            # opens a browser surface, prints its surface ref",
    "  cmux browser <surface> wait --load-state complete",
    "  cmux browser <surface> snapshot --interactive   # element refs to act on",
    "  cmux browser <surface> click <ref> | fill <ref> <text> | get url",
    "Re-snapshot after navigation or DOM changes.",
  ].join("\n");
}
