// Interactive TUI for the harness (M3). Type a message: the Orchestrator either answers,
// or dispatches the work to an Agent that runs visibly in a new cmux pane, after which the
// result is git-checkpointed in the workspace.
//
//   bun run start                 # workspace defaults to ./workspace
//   bun run start /path/to/repo   # use a specific workspace
//
// Commands:  /plan  show PLAN.md   ·   /ws  show workspace   ·   /help   ·   /exit

import * as readline from "node:readline/promises";
import { join } from "node:path";
import { identifySelf } from "../src/cmux.ts";
import { ensureWorkspace, readPlan } from "../src/workspace.ts";
import { runTurn } from "../src/harness.ts";

const wsArg = process.argv[2];
const workspace = await ensureWorkspace(
  wsArg ?? process.env.HARNESS_WORKSPACE ?? join(import.meta.dir, "..", "workspace"),
);
const selfSurface = await identifySelf();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const say = (m: string) => console.log(m);

console.log("cmux harness — M3");
console.log(`workspace: ${workspace}`);
console.log("type a message, or /help. first model call loads gemma (~10-30s).\n");

const autoYes = !!process.env.HARNESS_YES;
const confirm = async (_task: string): Promise<boolean> => {
  if (autoYes) return true; // non-interactive / autonomous mode
  const a = (await rl.question(`  รันงานนี้เลยไหม? [Y/n] `)).trim().toLowerCase();
  return a === "" || a === "y" || a === "yes";
};

loop: for (;;) {
  let line: string;
  try {
    line = (await rl.question("› ")).trim();
  } catch {
    break; // stdin closed (Ctrl-D / EOF)
  }
  if (!line) continue;

  switch (line) {
    case "/exit":
    case "/quit":
      break loop;
    case "/help":
      say("  /plan  show PLAN.md   ·   /ws  show workspace   ·   /exit");
      continue;
    case "/ws":
      say(`  ${workspace}`);
      continue;
    case "/plan":
      say(await readPlan(workspace));
      continue;
  }

  try {
    await runTurn(line, { workspace, selfSurface, confirm, say });
  } catch (e) {
    say(`error: ${(e as Error).message}`);
  }
}

rl.close();
console.log("bye.");
