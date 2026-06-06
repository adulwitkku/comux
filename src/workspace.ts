// The workspace: the git repo Agents work inside. Kept separate from the harness repo so
// Agents are confined to their own project (ADR-0005) and the harness stays clean.

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function git(args: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

/** Ensure `dir` exists and is a git repo. Returns the absolute path. */
export async function ensureWorkspace(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) {
    await git(["init", "-q"], dir);
    // Local identity so the harness can commit even on a fresh machine.
    await git(["config", "user.email", "harness@local"], dir);
    await git(["config", "user.name", "cmux harness"], dir);
  }
  return dir;
}

/** The PLAN.md the Orchestrator reads as its memory; placeholder text when absent. */
export async function readPlan(dir: string): Promise<string> {
  const p = join(dir, "PLAN.md");
  return existsSync(p) ? readFile(p, "utf8") : "(no PLAN.md yet — nothing planned)";
}

export async function recentGitLog(dir: string, n = 5): Promise<string> {
  return (await git(["log", "--oneline", `-${n}`], dir)).trim();
}
