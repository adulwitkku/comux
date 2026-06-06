// Interactive TUI for the harness (M3). Type a message: the Orchestrator either answers,
// or dispatches the work to an Agent that runs visibly in a new cmux pane, after which the
// result is git-checkpointed in the workspace.
//
//   bun run start                 # workspace defaults to ./workspace
//   bun run start /path/to/repo   # use a specific workspace
//
// Commands:  /plan  show PLAN.md   ·   /ws  show workspace   ·   /help   ·   /exit

import { homedir } from "node:os";
import { join } from "node:path";
import { identifySelf } from "../src/cmux.ts";
import { ensureWorkspace, readPlan, currentBranch } from "../src/workspace.ts";
import { runTurn } from "../src/harness.ts";
import { Tui, type Command } from "../src/tui.ts";
import { lastStats } from "../src/llm.ts";
import { c } from "../src/ui.ts";

const wsArg = process.argv[2];
const workspace = await ensureWorkspace(
  wsArg ?? process.env.HARNESS_WORKSPACE ?? join(import.meta.dir, "..", "workspace"),
);
const selfSurface = await identifySelf();
const model = process.env.HARNESS_MODEL ?? "gemma4:12b-mlx";
const autoYes = !!process.env.HARNESS_YES;

const commands: Command[] = [
  { name: "/plan", desc: "show PLAN.md" },
  { name: "/ws", desc: "show workspace path" },
  { name: "/help", desc: "keybindings & commands" },
  { name: "/exit", desc: "quit" },
];

const tilde = (p: string) => (p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p);

function statusBar(): string {
  const loc = `${c.blue(tilde(workspace))} ${c.gray(`(${currentBranch(workspace)})`)}`;
  const ctx = c.gray(
    lastStats.promptTokens != null ? `${lastStats.promptTokens}/256k` : "0/256k",
  );
  const m = c.gray(`(ollama) `) + c.magenta(model);
  const tps =
    lastStats.tokensPerSec != null
      ? c.yellow("⚡ ") + c.gray(`${lastStats.tokensPerSec.toFixed(1)} tok/s`)
      : c.yellow("⚡ ") + c.gray("TPS: --");
  return `${loc}  ${c.gray("·")}  ${ctx}  ${c.gray("·")}  ${m}  ${c.gray("·")}  ${tps}`;
}

const tui = new Tui({ commands, status: statusBar });
const say = (m: string) => tui.print(m);
const confirm = async (_task: string) => (autoYes ? true : tui.confirm("รันงานนี้เลยไหม?"));

tui.printHeader();
say(c.gray("  workspace: ") + c.blue(tilde(workspace)));
say("");

if (!process.stdin.isTTY) {
  say(c.red("  this TUI needs an interactive terminal (run it directly, not piped)."));
  process.exit(0);
}

loop: for (;;) {
  const line = (await tui.readLine())?.trim();
  if (line == null) break; // ctrl+c / ctrl+d
  if (!line) continue;

  switch (line) {
    case "/exit":
    case "/quit":
      break loop;
    case "/help":
      say(c.gray("  /plan  show PLAN.md   ·   /ws  show workspace   ·   /exit"));
      say(c.gray("  keys: ↑↓ choose command · ⏎ run · ⇥ complete · esc clear · ctrl+c exit"));
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
    say(c.red(`  ⚠ error: ${(e as Error).message}`));
  }
}

console.log(c.gray("bye."));
