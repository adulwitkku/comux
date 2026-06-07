// Manual tester for the Orchestrator. Throw it any message and see the task spec.
//
//   bun run try "ตอนนี้ทำถึงไหนแล้ว"
//   bun run try --pi "เพิ่มหน้า about"      # also route the same input through pi (cloud)
//
// Context (the Orchestrator's only memory) is taken from the real repo: ./PLAN.md if it
// exists, plus the last few git commits.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseIntent, buildSystemPrompt, type IntentContext, type TaskSpec } from "../src/orchestrator.ts";
import { extractJson } from "../src/llm.ts";

const args = process.argv.slice(2);
const withPi = args[0] === "--pi";
const message = (withPi ? args.slice(1) : args).join(" ").trim();

if (!message) {
  console.error('usage: bun run try [--pi] "your message"');
  process.exit(1);
}

const planMd = existsSync("PLAN.md") ? await readFile("PLAN.md", "utf8") : "(no PLAN.md yet)";
const gitLog = await new Response(
  Bun.spawn(["git", "log", "--oneline", "-5"], { stdout: "pipe" }).stdout,
).text();

const ctx: IntentContext = { planMd, gitLog };

console.log(`\ninput: ${message}\n`);

const ours = await parseIntent(message, ctx);
print("ours (gemma4:12b-mlx)", ours);

if (withPi) {
  const proc = Bun.spawn(
    ["pi", "-p", "--no-tools", "--no-session", "--thinking", "off",
      "--system-prompt", buildSystemPrompt(ctx), message],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    print("pi (cloud)", extractJson<TaskSpec>(out));
  } catch {
    console.log(`pi (cloud): could not parse JSON ->\n${out.slice(0, 300)}`);
  }
}

function print(who: string, s: TaskSpec) {
  console.log(`${who}: [${s.capability}]${s.confident ? "" : " (unsure)"}`);
  if (s.topic) console.log(`  topic: ${s.topic}`);
  const alts = s.alternatives ?? [];
  if (!s.confident && alts.length) console.log(`  alternatives: ${alts.join(", ")}`);
  console.log(`  task: ${s.task}`);
  console.log();
}
