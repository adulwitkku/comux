// Compare the local Orchestrator (gemma4:12b-mlx) against pi (cloud) in the SAME router
// role: identical system prompt, identical inputs. Tests whether a small local model routes
// as well as a strong cloud model — the core bet behind a thin local Orchestrator (ADR-0003).
//
//   bun run scripts/compare-pi.ts

import { parseIntent, buildSystemPrompt, type TaskSpec, type IntentContext } from "../src/orchestrator.ts";
import { extractJson } from "../src/llm.ts";

const ctx: IntentContext = {
  planMd: "# PLAN\n- [x] scaffold project\n- [x] add a dark-mode toggle to settings\n- [ ] add user login",
  gitLog: "726a1a8 M2: thin Orchestrator\ne13de99 M1: visible agent runner",
};

const cases: { name: string; input: string; expect: "reply" | "task" }[] = [
  { name: "chat/status", input: "ตอนนี้โปรเจกต์ทำถึงไหนแล้ว", expect: "reply" },
  { name: "clear build", input: "เพิ่มระบบ login ด้วย JWT ในหน้า settings", expect: "task" },
  { name: "advice (ambiguous)", input: "ปุ่ม dark mode ควรเก็บค่าไว้ใน localStorage ไหม", expect: "reply" },
];

/** Run pi as a router with our exact system prompt; parse its output into a TaskSpec. */
async function piRoute(input: string): Promise<TaskSpec> {
  const proc = Bun.spawn(
    ["pi", "-p", "--no-tools", "--no-session", "--thinking", "off",
      "--system-prompt", buildSystemPrompt(ctx), input],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return extractJson<TaskSpec>(out);
}

function kind(s: TaskSpec): "reply" | "task" {
  return s.task !== null ? "task" : "reply";
}

let agree = 0;
let oursRight = 0;
let piRight = 0;

for (const c of cases) {
  const ours = await parseIntent(c.input, ctx);
  let pi: TaskSpec | null = null;
  try {
    pi = await piRoute(c.input);
  } catch (e) {
    console.log(`\n[${c.name}] pi parse failed: ${(e as Error).message}`);
  }

  const oursKind = kind(ours);
  const piKind = pi ? kind(pi) : "n/a";
  if (oursKind === piKind) agree++;
  if (oursKind === c.expect) oursRight++;
  if (piKind === c.expect) piRight++;

  console.log(`\n=== ${c.name} ===  expect: ${c.expect}`);
  console.log(`  input: ${c.input}`);
  console.log(`  ours (gemma4:12b-mlx): ${oursKind}  ${ours.task ?? ours.reply}`);
  console.log(`  pi   (cloud)         : ${piKind}  ${pi ? (pi.task ?? pi.reply) : "—"}`);
}

console.log(`\n— summary —`);
console.log(`  ours correct: ${oursRight}/${cases.length}   pi correct: ${piRight}/${cases.length}   agreement: ${agree}/${cases.length}`);
