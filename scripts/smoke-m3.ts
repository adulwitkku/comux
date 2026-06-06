// M3.5 smoke test: the deterministic core of the autonomous PLAN-walk — PLAN.md parsing,
// step ticking, and the Acceptance check runner. Pure/offline (no cmux, Ollama, or Agent),
// so it runs in CI as a real gate. The Agent-driven plan→walk loop itself needs the live
// stack and is exercised by `bun run start`.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlan, readSteps, tickStep } from "../src/plan.ts";
import { runCheck } from "../src/check.ts";

function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
}

const PLAN = [
  "# Plan: add a greeting file",
  "",
  "- [x] scaffold the repo",
  "  - check: `test -d .`",
  "- [ ] create hello.txt with a greeting",
  "  - check: `test -f hello.txt`",
  "- [ ] this step has no check and must be dropped",
  "- [ ] add a second line",
  "  - check: grep -q world hello.txt",
  "",
].join("\n");

// --- parsing ---
const steps = parsePlan(PLAN);
ok("parses only verifiable steps (drops the check-less one)", steps.length === 3, `got ${steps.length}`);
ok("first step is marked done", steps[0]?.done === true);
ok("second step is undone with backticked check", steps[1]?.done === false && steps[1]?.check === "test -f hello.txt");
ok("third step parses a check without backticks", steps[2]?.check === "grep -q world hello.txt");

// --- ticking + reading from disk ---
const dir = mkdtempSync(join(tmpdir(), "comux-m3-"));
try {
  writeFileSync(join(dir, "PLAN.md"), PLAN);

  const onDisk = await readSteps(dir);
  ok("readSteps matches parsePlan", onDisk.length === 3);

  const flipped = await tickStep(dir, onDisk[1]!);
  const after = readFileSync(join(dir, "PLAN.md"), "utf8");
  ok("tickStep flips the matching box", flipped && after.includes("- [x] create hello.txt with a greeting"));
  ok("tickStep leaves other boxes untouched", after.includes("- [ ] add a second line"));

  // --- the Acceptance check runner ---
  const fail = await runCheck("test -f hello.txt", dir);
  ok("check fails before the file exists", fail.ok === false && fail.exitCode !== 0);

  writeFileSync(join(dir, "hello.txt"), "hello world\n");
  const pass = await runCheck("test -f hello.txt", dir);
  ok("check passes once the file exists", pass.ok === true && pass.exitCode === 0);

  const grep = await runCheck("grep -q world hello.txt", dir);
  ok("a grep check passes on matching content", grep.ok === true);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
