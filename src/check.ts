// Run a Step's Acceptance check and report pass/fail (ADR-0009). A Step is "done" only when
// its frozen check exits 0 — this is the deterministic gate, not the Agent's word.
//
// The check is run through `confine` (ADR-0005): a check should only ever read the repo and
// write build/cache artefacts, never touch the rest of the disk, so the same write-boundary
// that wraps Agents wraps checks too.

import { confine } from "./sandbox.ts";

export interface CheckResult {
  /** True when the check command exited 0. */
  ok: boolean;
  exitCode: number;
  /** Combined stdout+stderr, trimmed (for surfacing why a check failed). */
  output: string;
}

export async function runCheck(check: string, cwd: string): Promise<CheckResult> {
  const proc = Bun.spawn(["sh", "-c", confine(check, cwd)], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, exitCode, output: `${stdout}${stderr}`.trim() };
}
