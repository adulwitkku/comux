// M2 smoke test: the Orchestrator classifies natural language into a Capability (ADR-0018),
// hitting the real local model (gemma4:12b-mlx via Ollama). Every message dispatches; there is
// no reply branch any more — what we check is the chosen capability.
//
//   - a chat-style message  -> capability "chat"
//   - a build-style message -> capability "coding"
//   - task is always present in both cases

import { parseIntent } from "../src/orchestrator.ts";

function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
}

const ctx = {
  planMd: "# PLAN\n- [x] scaffold project\n- [ ] add a dark-mode toggle to settings",
  gitLog: "e13de99 M1: visible agent runner on cmux primitives",
};

console.log("calling gemma4:12b-mlx (first call loads the model)...");

const chat = await parseIntent("สวัสดี ตอนนี้โปรเจกต์ทำถึงไหนแล้ว", ctx);
console.log("  chat  ->", JSON.stringify(chat));
ok("chat -> capability chat", chat.capability === "chat" && chat.task.length > 0);

const build = await parseIntent("เพิ่มปุ่ม dark mode ในหน้า settings ให้หน่อย", ctx);
console.log("  build ->", JSON.stringify(build));
ok("build -> capability coding", build.capability === "coding" && build.task.length > 0);
