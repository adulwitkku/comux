#!/usr/bin/env bun
// Live M3.5 validation: drive the real plan -> approve-once -> walk pipeline against a live
// cmux + Ollama + pi, on a throwaway workspace. Not a CI gate (needs the full stack); a
// one-shot end-to-end check that the Agent-driven walk actually works. Auto-approves the plan.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identifySelf } from "../src/cmux.ts";
import { ensureWorkspace } from "../src/workspace.ts";
import { runTurn } from "../src/harness.ts";

const goal =
  process.argv[2] ??
  "Create hello.txt containing the text 'hello world', and bye.txt containing 'goodbye'.";

const workspace = await ensureWorkspace(mkdtempSync(join(tmpdir(), "comux-live-")));
const selfSurface = await identifySelf();

console.log(`workspace: ${workspace}`);
console.log(`goal: ${goal}\n`);

await runTurn(goal, {
  workspace,
  selfSurface,
  confirm: async () => {
    console.log("[auto-approve plan]");
    return true;
  },
  say: (m) => console.log(m),
});

console.log("\n--- final state ---");
const proc = Bun.spawn(["sh", "-c", "ls -la && echo '--- git log ---' && git log --oneline && echo '--- PLAN.md ---' && cat PLAN.md"], {
  cwd: workspace,
  stdout: "inherit",
  stderr: "inherit",
});
await proc.exited;
console.log(`\nworkspace kept at: ${workspace}`);
