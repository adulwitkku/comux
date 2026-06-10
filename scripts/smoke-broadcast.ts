// Offline gate for Broadcast mode (ADR-0014/0021): roster resolution, open-command build,
// grid math, state-file roundtrip, argv parse, and paste-mode dispatch. No cmux/Ollama/Agents
// needed (the send dispatcher takes injectable cmux ops), so it runs in CI.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point XDG at a temp dir BEFORE the config/broadcast modules resolve any paths.
const xdg = mkdtempSync(join(tmpdir(), "comux-bc-"));
process.env.XDG_CONFIG_HOME = xdg;

const { REGISTRY } = await import("../src/agents.ts");
const { DEFAULT_BROADCAST_ROSTER, rosterHash } = await import("../src/config.ts");
const {
  gridDims,
  cellsPerColumn,
  parseBroadcastArgs,
  dispatchSend,
  saveState,
  loadState,
  stateFile,
  buildOpenCommand,
  resolveBroadcastTargets,
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

  // --- Step 1: default roster has ten enabled slots with models ---
  ok("default roster has 10 slots", DEFAULT_BROADCAST_ROSTER.length === 10);
  ok("default roster slots are enabled", DEFAULT_BROADCAST_ROSTER.every((s) => s.enabled));
  ok("agy model is quoted-safe", buildOpenCommand(DEFAULT_BROADCAST_ROSTER.find((s) => s.binary === "agy")!).includes("'Gemini 3.5 Flash (Medium)'"));

  // --- Step 2: open commands per binary ---
  const pi = DEFAULT_BROADCAST_ROSTER.find((s) => s.id === "pi-gemma4-12b-mlx")!;
  ok("pi open command", buildOpenCommand(pi) === "pi --model 'gemma4:12b-mlx'");
  const oc = DEFAULT_BROADCAST_ROSTER.find((s) => s.id === "opencode-glm-5.1")!;
  ok("opencode uses -m", buildOpenCommand(oc) === "opencode -m 'zai/glm-5.1'");

  // --- Step 3: resolve targets picks paste profiles from registry ---
  const targets = resolveBroadcastTargets(DEFAULT_BROADCAST_ROSTER);
  ok("resolve ten enabled targets", targets.length === 10);
  const piT = targets.find((t) => t.id === "pi-gemma4-12b-mlx")!;
  ok("pi types its input", piT.pasteMode === "typed");
  const curT = targets.find((t) => t.id === "cursor-composer-2.5")!;
  ok("cursor uses buffer paste", curT.pasteMode === "buffer");

  // --- Step 4: every registry Agent still has a bare openCommand (orchestrated path) ---
  const headless = /\s-p\b|--no-session|--prompt\b|--force\b|--dangerously|confine|sandbox-exec/;
  const modes = new Set(["bracketed", "buffer", "typed"]);
  let allOpenOk = true;
  for (const a of Object.values(REGISTRY)) {
    if (!a.openCommand || headless.test(a.openCommand) || !modes.has(a.pasteMode)) allOpenOk = false;
  }
  ok("every registry Agent has a bare openCommand + valid pasteMode", allOpenOk);

  // --- Step 5: roster hash changes when a slot is toggled ---
  const hashA = rosterHash(DEFAULT_BROADCAST_ROSTER);
  const toggled = structuredClone(DEFAULT_BROADCAST_ROSTER);
  toggled[0]!.enabled = false;
  ok("rosterHash changes on toggle", rosterHash(toggled) !== hashA);

  // --- Step 6: grid math ---
  const dims = (n: number) => `${gridDims(n).cols}x${gridDims(n).rows}`;
  ok("gridDims is roughly square", dims(1) === "1x1" && dims(2) === "2x1" && dims(3) === "2x2" && dims(4) === "2x2" && dims(5) === "3x2" && dims(6) === "3x2" && dims(10) === "4x3", [1, 2, 3, 4, 5, 6, 10].map(dims).join(","));
  ok(
    "cellsPerColumn sums to n with extras left-loaded",
    cellsPerColumn(5, 3).join() === "2,2,1" && cellsPerColumn(6, 3).join() === "2,2,2" && cellsPerColumn(3, 2).join() === "2,1",
  );

  // --- Step 7: state-file roundtrip under temp XDG, keyed by workspace ---
  ok("no state before save", (await loadState("workspace:9")) === null);
  const path = await saveState({
    workspace: "workspace:9",
    cwd: "/tmp/proj",
    rosterHash: hashA,
    slots: { "pi-gemma4-12b-mlx": "surface:8" as SurfaceRef, "claude-sonnet": "surface:9" as SurfaceRef },
  });
  ok("saveState writes under XDG_CONFIG_HOME", path.startsWith(xdg) && stateFile("workspace:9").endsWith("9.json"), path);
  const st = await loadState("workspace:9");
  ok("loadState roundtrips slot→surface map", st?.slots["claude-sonnet"] === "surface:9" && st?.cwd === "/tmp/proj" && st?.rosterHash === hashA);

  // --- Step 8: argv parsing (--cwd extracted, rest is the broadcast text) ---
  ok("parse open-only", parseBroadcastArgs([]).text === "" && parseBroadcastArgs([]).cwd === null);
  ok("parse text", parseBroadcastArgs(["hi", "there"]).text === "hi there");
  const p = parseBroadcastArgs(["--cwd", "/x", "hello"]);
  ok("parse --cwd before text", p.cwd === "/x" && p.text === "hello");

  // --- Step 9: paste-mode dispatch picks the right cmux calls (recording mock) ---
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
  await dispatchSend(buf.ops, curT, surf, "hi");
  ok(
    "buffer mode uses set-buffer + paste-buffer (not send), then submits",
    buf.calls.some((c) => c.startsWith("setbuf:")) && buf.calls.some((c) => c.startsWith("pastebuf:")) && !buf.calls.some((c) => c.startsWith("send:")) && buf.calls.at(-1) === "key:enter",
    buf.calls.join(" "),
  );

  const typed = recorder();
  await dispatchSend(typed.ops, piT, surf, "line1\nline2");
  ok(
    "typed mode sends each line with a newline key between, then submits",
    typed.calls.join(" ") === "send:line1 key:shift+enter send:line2 key:enter",
    typed.calls.join(" "),
  );

  const brk = recorder();
  const claudeT = targets.find((t) => t.id === "claude-sonnet")!;
  await dispatchSend(brk.ops, claudeT, surf, "hi");
  ok(
    "bracketed mode wraps text in OSC 200/201, then submits",
    brk.calls[0] === "send:\x1b[200~hi\x1b[201~" && brk.calls.at(-1) === "key:enter",
    brk.calls.join(" "),
  );
} finally {
  rmSync(xdg, { recursive: true, force: true });
}
