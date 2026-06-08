// One turn of the harness: classify the user's message into a Capability, then dispatch it.
// Every message dispatches and its answer comes back as a markdown artifact the Harness opens
// (ADR-0018) — there is no direct chat reply.
//
//   chat        → the local Orchestrator model writes a markdown reply (no Agent spun up, ADR-0019).
//   web_search  → a single dispatch down the web_search chain (auto-run).
//   image       → a single dispatch down the image chain (auto-run).
//   coding      → the autonomous PLAN-walk: a plan dispatch (planning chain) authors PLAN.md, the
//                 plan-is-ready decision is answered by Bypass mode (or the human when bypass is
//                 off, ADR-0016), then each Step is implemented down the coding chain and gated on
//                 its frozen Acceptance check (ADR-0009).
//
// When the classifier is not confident which Capability a message is, the choice is grilled
// (ADR-0019): Bypass mode takes the model's top guess; otherwise the human picks. Every dispatch
// runs through the Scheduler (`runWithChain`): the most-preferred Agent runs; if it crashes or goes
// silent it is marked down and the next Agent takes over (ADR-0004); completion is read from cmux's
// agent lifecycle (ADR-0015).

import { existsSync, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  parseIntent,
  chatReply,
  artifactFilename,
  resolveTopic,
  type TaskSpec,
} from "./orchestrator.ts";
import { DEFAULT_WATCHDOG_MS } from "./agent-runner.ts";
import { runWithChain } from "./scheduler.ts";
import { checkpoint, hasChanges } from "./git.ts";
import { readPlan, recentGitLog, readProjectDocs, nextChatFile } from "./workspace.ts";
import {
  readSteps,
  tickStep,
  planPrompt,
  stepPrompt,
  outputInstruction,
  imageInstruction,
  browserHint,
  REPORT_FILE,
  type Step,
} from "./plan.ts";
import {
  setStatus, log, openMarkdown, openFile, renameTab, findResultSurface, closeSurface,
  type SurfaceRef,
} from "./cmux.ts";
import { ui, c } from "./ui.ts";
import type { Config, Capability } from "./config.ts";

export interface TurnDeps {
  workspace: string;
  selfSurface: SurfaceRef;
  /** Per-capability Agent chains + Bypass mode (ADR-0016). */
  config: Config;
  /** Human gate for the plan-is-ready decision when Bypass mode is OFF (ADR-0016). */
  confirmPlan: (summary: string) => Promise<boolean>;
  /** Resolve an uncertain capability when Bypass mode is OFF (ADR-0019). */
  chooseCapability?: (top: Capability, alternatives: Capability[]) => Promise<Capability>;
  /** Emit a line to the user. */
  say: (msg: string) => void;
  watchdogMs?: number;
}

export async function runTurn(input: string, deps: TurnDeps): Promise<void> {
  const planMd = await readPlan(deps.workspace);
  const gitLog = await recentGitLog(deps.workspace);

  await setStatus("harness", "thinking");
  const spec = await parseIntent(input, { planMd, gitLog });

  // ADR-0019: an uncertain classification is grilled, not silently routed. Bypass mode takes the
  // model's top guess; with bypass off the human picks among the alternatives.
  let capability = spec.capability;
  if (!spec.confident) {
    if (!deps.config.bypass && deps.chooseCapability) {
      capability = await deps.chooseCapability(spec.capability, spec.alternatives);
    } else {
      deps.say(ui.hint(`  (unsure — going with ${capability}; alternatives: ${spec.alternatives.join(", ") || "none"})`));
    }
  }

  deps.say(ui.dispatch(`${c.gray(`[${capability}]`)} ${spec.task}`));

  if (capability === "chat") {
    await chatDispatch(input, { planMd, gitLog }, deps);
  } else if (capability === "coding") {
    await codingJob(spec.task, deps);
  } else {
    await singleDispatch(capability, spec, input, deps);
  }
}

/** The `chat` Capability (ADR-0019): the local model writes a markdown reply the Harness opens.
 *  Each reply goes to the next sequential file (chat1.md, chat2.md, …). The previous
 *  comux-result tab is closed first so only one result tab is ever open at a time. */
async function chatDispatch(
  input: string,
  ctx: { planMd: string; gitLog: string },
  deps: TurnDeps,
): Promise<void> {
  await setStatus("harness", "chat");
  const { contextMd, readmeMd } = await readProjectDocs(deps.workspace);
  const md = await chatReply(input, { ...ctx, contextMd, readmeMd });

  const file = nextChatFile(deps.workspace);
  await writeFile(file, md.endsWith("\n") ? md : md + "\n");
  await setStatus("harness", "idle");
  await openResult(file, deps);
}

/** Find an optional markdown artifact on disk (exact topic path, else newest prefix match).
 *  Checks .comux/ first (preferred), then the workspace root (agent fallback). */
function findArtifactPath(
  workspace: string,
  capability: "web_search" | "image",
  topic: string | null,
): string | null {
  const dirs = [join(workspace, ".comux"), workspace];
  const prefix = capability === "web_search" ? "search_" : "image_";

  if (topic) {
    const filename = artifactFilename(capability, topic);
    for (const dir of dirs) {
      const exact = join(dir, filename);
      if (existsSync(exact)) return exact;
    }
  }

  const matches: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".md"))
      .forEach((name) => matches.push(join(dir, name)));
  }
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0]!;
  return matches.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

/** Find the newest image file written to workspace/.comux or workspace root since `since` ms. */
function findImagePath(workspace: string, since: number): string | null {
  const dirs = [join(workspace, ".comux"), workspace];
  const candidates: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      if (!IMAGE_EXTS.has(ext)) continue;
      const full = join(dir, name);
      const mtime = statSync(full).mtimeMs;
      if (mtime >= since) candidates.push(full);
    }
  }
  if (!candidates.length) return null;
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

/**
 * Close any existing "comux-result" tab, open `path` in cmux's viewer (image or markdown),
 * and rename the new tab to "comux-result" so future opens can find and close it by name.
 */
async function openResult(path: string, deps: TurnDeps): Promise<SurfaceRef | null> {
  const existing = await findResultSurface().catch(() => null);
  if (existing) await closeSurface(existing).catch(() => {});

  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const isImage = IMAGE_EXTS.has(ext);

  try {
    const surface = isImage
      ? await openFile(path, { surface: deps.selfSurface })
      : await openMarkdown(path, { surface: deps.selfSurface });
    if (surface) {
      await renameTab(surface, "comux-result").catch(() => {});
      deps.say(ui.ok(`เปิด ${basename(path)} ใน viewer`));
    }
    return surface ?? null;
  } catch (e) {
    deps.say(ui.warn(`เปิด ${basename(path)} ไม่ได้: ${(e as Error).message}`));
    return null;
  }
}

/** A one-shot capability (web_search / image): auto-run down that capability's chain (ADR-0018). */
async function singleDispatch(
  capability: "web_search" | "image",
  spec: TaskSpec,
  userInput: string,
  deps: TurnDeps,
): Promise<void> {
  const goal = spec.task;
  const chain = deps.config.chains[capability];
  await setStatus("harness", `running ${capability}`);
  await log(`${capability}: ${goal}`);

  const dispatchStartMs = Date.now();

  // web_search: pi uses its native search tools — no browser hint (it confuses the agent).
  // image: tell the agent to save the output to .comux/result.<ext> so we can open it.
  const prompt =
    capability === "image"
      ? goal + outputInstruction() + imageInstruction() + browserHint()
      : goal + outputInstruction();

  const outcome = await runWithChain({
    chain,
    prompt,
    workspace: deps.workspace,
    fromSurface: deps.selfSurface,
    watchdogMs: deps.watchdogMs ?? DEFAULT_WATCHDOG_MS,
    down: new Set(),
    say: deps.say,
    label: capability,
  });

  await setStatus("harness", "idle");
  if (!outcome.ok) {
    deps.say(ui.warn(`ทุก agent ใน ${capability} chain ใช้ไม่ได้แล้ว`));
    return;
  }

  const hash = (await hasChanges(deps.workspace))
    ? await checkpoint(deps.workspace, `${outcome.agent} (${capability}): ${goal}`)
    : null;
  deps.say(ui.ok(`เสร็จแล้ว (${outcome.agent})${hash ? ` — checkpoint ${hash}` : ""}`));

  // For image: prefer a generated image file over the markdown report.
  let artifactPath: string | null = null;
  if (capability === "image") {
    artifactPath = findImagePath(deps.workspace, dispatchStartMs);
  }
  if (!artifactPath) {
    const topic = resolveTopic(spec, userInput);
    artifactPath = findArtifactPath(deps.workspace, capability, topic) ?? reportPath(deps.workspace);
  }
  if (artifactPath) await openResult(artifactPath, deps);

  // Close the agent pane after the result is open so single dispatches don't litter panes.
  if (outcome.surface) await closeSurface(outcome.surface).catch(() => {});
}

/** The conventional REPORT.md the Harness opens after a dispatch, if the Agent wrote one. */
function reportPath(workspace: string): string | null {
  const p = join(workspace, REPORT_FILE);
  return existsSync(p) ? p : null;
}

/** A coding job: plan (planning chain) → answer plan-is-ready → walk Steps (coding chain). */
async function codingJob(goal: string, deps: TurnDeps): Promise<void> {
  const watchdogMs = deps.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const down = new Set<string>(); // agents that fall over stay down for the rest of the job

  // 1. Plan dispatch — author PLAN.md down the planning chain (nothing is built yet).
  await setStatus("harness", "planning");
  await log(`plan dispatch: ${goal}`);
  const planned = await runWithChain({
    chain: deps.config.chains.planning,
    prompt: planPrompt(goal),
    workspace: deps.workspace,
    fromSurface: deps.selfSurface,
    watchdogMs,
    down,
    say: deps.say,
    label: "planning",
  });
  if (!planned.ok) {
    await setStatus("harness", "idle");
    deps.say(ui.warn("every agent in the planning chain was exhausted. aborting."));
    return;
  }

  const steps = await readSteps(deps.workspace);
  if (steps.length === 0) {
    await setStatus("harness", "idle");
    deps.say(ui.warn("no verifiable steps in PLAN.md (each step needs a `check:`). aborting."));
    return;
  }
  await checkpoint(deps.workspace, `plan: ${goal}`);

  // 2. Plan-is-ready decision (ADR-0016): Bypass mode proceeds automatically; otherwise the human
  // approves the whole autonomous walk once.
  deps.say(ui.banner("  PLAN"));
  steps.forEach((s, i) =>
    deps.say(`  ${c.bold(String(i + 1))}. ${s.description}  ${c.gray(`· check: ${s.check}`)}`),
  );
  if (!deps.config.bypass && !(await deps.confirmPlan(goal))) {
    await setStatus("harness", "idle");
    deps.say(ui.warn("cancelled."));
    return;
  }

  // 3. Walk — implement each Step down the coding chain, gated on its Acceptance check.
  await walkPlan(steps, deps, down, watchdogMs);
}

async function walkPlan(
  steps: Step[],
  deps: TurnDeps,
  down: Set<string>,
  watchdogMs: number,
): Promise<void> {
  const total = steps.length;

  for (const [idx, step] of steps.entries()) {
    const n = idx + 1;
    if (step.done) {
      deps.say(ui.ok(`step ${n}/${total} already done — skipping`));
      continue;
    }

    await setStatus("harness", `step ${n}/${total}`);
    await log(`step ${n}/${total}: ${step.description}`);
    const outcome = await runWithChain({
      chain: deps.config.chains.coding,
      prompt: stepPrompt(step) + outputInstruction() + browserHint(),
      workspace: deps.workspace,
      fromSurface: deps.selfSurface,
      watchdogMs,
      down,
      check: step.check,
      say: deps.say,
      label: `step ${n}/${total}`,
    });

    if (!outcome.ok) {
      await setStatus("harness", "idle");
      deps.say(ui.warn(`stopped at step ${n}/${total}: coding chain exhausted. left at last checkpoint. [resume via M5 handover]`));
      return;
    }

    await tickStep(deps.workspace, step);
    const hash = await checkpoint(deps.workspace, `${outcome.agent}: ${step.description}`);
    deps.say(ui.ok(`step ${n}/${total} done via ${outcome.agent}${hash ? ` — checkpoint ${hash}` : ""}`));
  }

  await setStatus("harness", "idle");
  deps.say(ui.ok(`all ${total} steps done.`));

  // ADR-0018: open the Agent-authored report for the finished job, if there is one.
  const report = reportPath(deps.workspace);
  if (report) await openResult(report, deps);
}
