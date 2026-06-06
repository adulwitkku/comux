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
import { ui, c } from "../src/ui.ts";

const COMMANDS = ["/plan", "/ws", "/help", "/exit"] as const;

function completer(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const hits = COMMANDS.filter((cmd) => cmd.startsWith(line));
  return [hits.length ? hits : [...COMMANDS], line];
}

const wsArg = process.argv[2];
const workspace = await ensureWorkspace(
  wsArg ?? process.env.HARNESS_WORKSPACE ?? join(import.meta.dir, "..", "workspace"),
);
const selfSurface = await identifySelf();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  completer,
});
const say = (m: string) => console.log(m);

console.log(ui.banner("◆ cmux harness") + c.gray("  — M3"));
console.log(c.gray("  workspace: ") + c.blue(workspace));
console.log(ui.hint("  type a message, /help for commands (Tab completes /). first model call loads gemma (~10-30s).") + "\n");

const autoYes = !!process.env.HARNESS_YES;
const confirm = async (_task: string): Promise<boolean> => {
  if (autoYes) return true; // non-interactive / autonomous mode
  const a = (await rl.question(c.yellow("  รันงานนี้เลยไหม? ") + c.gray("[Y/n] "))).trim().toLowerCase();
  return a === "" || a === "y" || a === "yes";
};

loop: for (;;) {
  let line: string;
  try {
    line = (await rl.question(ui.prompt())).trim();
  } catch {
    break; // stdin closed (Ctrl-D / EOF)
  }
  if (!line) continue;

  switch (line) {
    case "/exit":
    case "/quit":
      break loop;
    case "/help":
      say(ui.hint("  /plan") + c.gray("  show PLAN.md") + ui.hint("   ·   /ws") +
        c.gray("  show workspace") + ui.hint("   ·   /exit"));
      continue;
    case "/ws":
      say(c.blue(`  ${workspace}`));
      continue;
    case "/plan":
      say(c.gray(await readPlan(workspace)));
      continue;
  }

  try {
    await runTurn(line, { workspace, selfSurface, confirm, say });
  } catch (e) {
    say(ui.warn(`error: ${(e as Error).message}`));
  }
}

rl.close();
console.log(c.gray("bye."));
