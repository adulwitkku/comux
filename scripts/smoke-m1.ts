// M1 smoke test: prove the make-or-break spike end to end against the real cmux.
//
//   1. launch a (fake) Agent in a visible cmux pane, seeded via its launch command
//   2. detect completion + capture its exit code
//   3. git-checkpoint the work it produced
//   4. detect a *stuck* Agent via the silence watchdog
//
// The fake Agent is a plain shell command so this runs without any real agent CLI
// installed. Work happens in a throwaway temp git repo so the harness repo stays clean.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identifySelf, closeSurface, log } from "../src/cmux.ts";
import { runAgentStep } from "../src/agent-runner.ts";
import { checkpoint } from "../src/git.ts";

function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
}

async function sh(cmd: string, cwd: string) {
  const p = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  await p.exited;
}

const repo = await mkdtemp(join(tmpdir(), "cmux-m1-"));
await sh("git init -q && git config user.email t@t && git config user.name t", repo);

const self = await identifySelf();
await log("M1 smoke: starting");

try {
  // --- 1+2+3: a completing Agent, exit code captured, then checkpointed ---
  const done = await runAgentStep({
    fromSurface: self,
    launchCommand: `cd ${repo} && echo 'agent: working...' && sleep 1 && echo built > artifact.txt && echo 'agent: done'`,
    watchdogMs: 30_000,
    pollMs: 1_000,
    closeOnEnd: true,
  });

  ok("completes & captures exit code", done.outcome === "completed" && done.exitCode === 0,
    JSON.stringify(done));

  const hash = await checkpoint(repo, "M1: agent step");
  ok("git checkpoint after success", hash !== null, hash ?? "no commit");

  // --- 4: a stuck Agent caught by the silence watchdog (short threshold) ---
  const stuckResult = await Promise.race([
    runAgentStep({
      fromSurface: self,
      launchCommand: `echo 'agent: hanging...' && sleep 600`,
      watchdogMs: 4_000,
      pollMs: 1_000,
      closeOnEnd: true,
    }),
    Bun.sleep(20_000).then(() => ({ outcome: "timeout" as const, surface: self })),
  ]);

  ok("watchdog detects stuck agent", stuckResult.outcome === "stuck",
    `outcome=${stuckResult.outcome}`);
  if (stuckResult.outcome === "timeout") await closeSurface(self); // nothing to close, defensive
} finally {
  await rm(repo, { recursive: true, force: true });
  await log("M1 smoke: finished");
}
