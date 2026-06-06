// M2 smoke test: the Orchestrator turns natural language into a valid task spec,
// hitting the real local model (gemma4:12b-mlx via Ollama).
//
//   - a chat-style message  -> reply non-null, task null
//   - a build-style message -> task non-null, reply null
//   - exactly one of reply/task is set in both cases

import { parseIntent, type TaskSpec } from "../src/orchestrator.ts";

function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
}

function exactlyOne(s: TaskSpec): boolean {
  return (s.reply === null) !== (s.task === null);
}

const ctx = {
  planMd: "# PLAN\n- [x] scaffold project\n- [ ] add a dark-mode toggle to settings",
  gitLog: "e13de99 M1: visible agent runner on cmux primitives",
};

console.log("calling gemma4:12b-mlx (first call loads the model)...");

const chat = await parseIntent("สวัสดี ตอนนี้โปรเจกต์ทำถึงไหนแล้ว", ctx);
console.log("  chat  ->", JSON.stringify(chat));
ok("chat -> reply", chat.reply !== null && chat.task === null && exactlyOne(chat));

const build = await parseIntent("เพิ่มปุ่ม dark mode ในหน้า settings ให้หน่อย", ctx);
console.log("  build ->", JSON.stringify(build));
ok("build -> task", build.task !== null && build.reply === null && exactlyOne(build));
