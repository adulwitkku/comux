// Offline gate for Broadcast mode (ADR-0014): the per-Agent launch/send profile, the grid math,
// the state-file roundtrip, the argv parse, and the paste-mode dispatch. No cmux/Ollama/Agents
// needed (the send dispatcher takes injectable cmux ops), so it runs in CI.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point XDG at a temp dir BEFORE the config/broadcast modules resolve any paths.
const xdg = mkdtempSync(join(tmpdir(), "comux-bc-"));
process.env.XDG_CONFIG_HOME = xdg;

const { REGISTRY } = await import("../src/agents.ts");
const {
  gridDims,
  cellsPerColumn,
  parseBroadcastArgs,
  dispatchSend,
  saveState,
  loadState,
  stateFile,
} = await import("../src/broadcast.ts");
import type { SendOps } from "../src/broadcast.ts";
import type { SurfaceRef } from "../src/cmux.ts";

function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
}

try {
  const reg = (n: string) => {
    const a = REGISTRY[n];
    if (!a) throw new Error(`registry missing ${n}`);
    return a;
  };

  // --- Step 1: every Agent has a bare interactive launch + a valid send profile ---
  const headless = /\s-p\b|--no-session|--prompt\b|--force\b|--dangerously|confine|sandbox-exec/;
  const modes = new Set(["bracketed", "buffer", "typed"]);
  let allOpenOk = true;
  for (const a of Object.values(REGISTRY)) {
    if (!a.openCommand || headless.test(a.openCommand) || !modes.has(a.pasteMode)) allOpenOk = false;
  }
  ok("every registry Agent has a bare openCommand + valid pasteMode", allOpenOk);
  ok("pi types its input", reg("pi").pasteMode === "typed");
  ok("cursor uses a buffer paste", reg("cursor").pasteMode === "buffer");
  ok("cursor launches the cursor-agent binary", reg("cursor").openCommand.startsWith("cursor-agent"));
  ok("claude pastes via bracketed mode", reg("claude").pasteMode === "bracketed");

  // --- Step 4: grid math ---
  const dims = (n: number) => `${gridDims(n).cols}x${gridDims(n).rows}`;
  ok("gridDims is roughly square", dims(1) === "1x1" && dims(2) === "2x1" && dims(3) === "2x2" && dims(4) === "2x2" && dims(5) === "3x2" && dims(6) === "3x2", [1, 2, 3, 4, 5, 6].map(dims).join(","));
  ok(
    "cellsPerColumn sums to n with extras left-loaded",
    cellsPerColumn(5, 3).join() === "2,2,1" && cellsPerColumn(6, 3).join() === "2,2,2" && cellsPerColumn(3, 2).join() === "2,1",
  );

  // --- Step 3: state-file roundtrip under temp XDG, keyed by workspace ---
  ok("no state before save", (await loadState("workspace:9")) === null);
  const path = await saveState({ workspace: "workspace:9", cwd: "/tmp/proj", agents: { claude: "surface:8" as SurfaceRef, pi: "surface:9" as SurfaceRef } });
  ok("saveState writes under XDG_CONFIG_HOME", path.startsWith(xdg) && stateFile("workspace:9").endsWith("9.json"), path);
  const st = await loadState("workspace:9");
  ok("loadState roundtrips the agent→surface map", st?.agents.claude === "surface:8" && st?.cwd === "/tmp/proj");

  // --- Step 5a: argv parsing (--cwd extracted, rest is the broadcast text) ---
  ok("parse open-only", parseBroadcastArgs([]).text === "" && parseBroadcastArgs([]).cwd === null);
  ok("parse text", parseBroadcastArgs(["hi", "there"]).text === "hi there");
  const p = parseBroadcastArgs(["--cwd", "/x", "hello"]);
  ok("parse --cwd before text", p.cwd === "/x" && p.text === "hello");

  // --- Step 5b: paste-mode dispatch picks the right cmux calls (recording mock) ---
  function recorder() {
    const calls: string[] = [];
    const ops: SendOps = {
      send: async (_s, t) => void calls.push(`send:${t}`),
      sendKey: async (_s, k) => void calls.push(`key:${k}`),
      setBuffer: async (n, t) => void calls.push(`setbuf:${n}:${t}`),
      pasteBuffer: async (n) => void calls.push(`pastebuf:${n}`),
    };
    return { calls, ops };
  }
  const surf = "surface:1" as SurfaceRef;

  const buf = recorder();
  await dispatchSend(buf.ops, reg("cursor"), surf, "hi");
  ok(
    "buffer mode uses set-buffer + paste-buffer (not send), then submits",
    buf.calls.some((c) => c.startsWith("setbuf:")) && buf.calls.some((c) => c.startsWith("pastebuf:")) && !buf.calls.some((c) => c.startsWith("send:")) && buf.calls.at(-1) === "key:enter",
    buf.calls.join(" "),
  );

  const typed = recorder();
  await dispatchSend(typed.ops, reg("pi"), surf, "line1\nline2");
  ok(
    "typed mode sends each line with a newline key between, then submits",
    typed.calls.join(" ") === "send:line1 key:shift+enter send:line2 key:enter",
    typed.calls.join(" "),
  );

  const brk = recorder();
  await dispatchSend(brk.ops, reg("claude"), surf, "hi");
  ok(
    "bracketed mode wraps text in OSC 200/201, then submits",
    brk.calls[0] === "send:\x1b[200~hi\x1b[201~" && brk.calls.at(-1) === "key:enter",
    brk.calls.join(" "),
  );
} finally {
  rmSync(xdg, { recursive: true, force: true });
}
