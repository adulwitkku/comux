// The Grilling answerer (ADR-0016): subscribe to cmux's Feed event stream and answer the Agent
// decisions that park a hook on cmux's semaphore — permission requests, "plan is ready"
// (ExitPlanMode), and multiple-choice questions (AskUserQuestion).
//
//   Bypass mode ON (default)  — auto-answer everything: permission → allow, plan → proceed,
//                               question → its recommended option (first option as the fallback).
//   Bypass mode OFF           — auto-answer any decision that carries a recommended option, and
//                               leave the rest for the human, who answers in the visible pane.
//
// This is a SECONDARY net: Agents are also launched with their own bypass flags
// (--dangerously-skip-permissions, --force, …), which already suppress most prompts. So if the
// exact Feed schema below drifts from a given cmux build, the orchestrated run still makes
// progress — the Agent's own flags carry it.
//
// IMPORTANT: the precise event/reply field names are cmux-internal and were NOT verified against a
// live Feed in this change. The parser is deliberately tolerant (it reacts only to items it can
// positively recognise) and replies through `cmux rpc`, which fails harmlessly if a shape is off.
// See docs/feed.md (feed.item.received / feed.{permission,question,exit_plan}.reply) and ADR-0016.

type Say = (m: string) => void;

export interface FeedWatcher {
  stop(): void;
}

/** A best-effort view of an incoming actionable Feed item. */
interface FeedItem {
  request_id?: string;
  requestId?: string;
  // kind/type spelling varies across cmux builds; we check several.
  type?: string;
  kind?: string;
  category?: string;
  options?: Array<{ label?: string; value?: string; recommended?: boolean } | string>;
}

/** Run `cmux rpc <method> <json>`; resolve true on exit 0. Errors are swallowed (best-effort). */
async function cmuxRpc(method: string, params: unknown): Promise<boolean> {
  try {
    const proc = Bun.spawn(["cmux", "rpc", method, JSON.stringify(params)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

function requestId(item: FeedItem): string | null {
  return item.request_id ?? item.requestId ?? null;
}

/** Normalise the item's kind to one of our three actionable decisions, or null. */
function decisionKind(item: FeedItem): "permission" | "exit_plan" | "question" | null {
  const raw = `${item.type ?? ""} ${item.kind ?? ""} ${item.category ?? ""}`.toLowerCase();
  if (raw.includes("permission")) return "permission";
  if (raw.includes("exit") && raw.includes("plan")) return "exit_plan";
  if (raw.includes("exitplan")) return "exit_plan";
  if (raw.includes("question")) return "question";
  return null;
}

/** Pick the recommended option index for a question (convention: tagged or the first option). */
function recommendedIndex(item: FeedItem): number | null {
  const opts = item.options;
  if (!opts || opts.length === 0) return null;
  const flagged = opts.findIndex(
    (o) => typeof o === "object" && o !== null && o.recommended === true,
  );
  if (flagged >= 0) return flagged;
  const tagged = opts.findIndex(
    (o) => typeof o === "object" && /recommended/i.test(o?.label ?? ""),
  );
  if (tagged >= 0) return tagged;
  return 0; // convention: recommended option is listed first
}

/**
 * Answer one recognised Feed item. Returns true if we replied. With bypass off we only reply to
 * questions that have a recommended option; permission/plan and no-recommendation questions are
 * left for the human in the visible pane.
 */
async function answer(item: FeedItem, bypass: boolean, say: Say): Promise<boolean> {
  const id = requestId(item);
  const kind = decisionKind(item);
  if (!id || !kind) return false;

  if (kind === "permission") {
    if (!bypass) return false;
    await cmuxRpc("feed.permission.reply", { request_id: id, decision: "allow" });
    say(`  ${"✓"} bypass: allowed an agent permission request`);
    return true;
  }
  if (kind === "exit_plan") {
    if (!bypass) return false;
    await cmuxRpc("feed.exit_plan.reply", { request_id: id, decision: "proceed" });
    say(`  ${"✓"} bypass: approved a plan-is-ready decision`);
    return true;
  }
  // question
  const idx = recommendedIndex(item);
  if (idx === null) return false;
  if (!bypass && idx === 0 && !hasRecommendation(item)) {
    // no genuine recommendation and bypass is off → leave it to the human
    return false;
  }
  await cmuxRpc("feed.question.reply", { request_id: id, selected: [idx] });
  say(`  ${"✓"} ${bypass ? "bypass" : "auto"}: answered an agent question (option ${idx + 1})`);
  return true;
}

function hasRecommendation(item: FeedItem): boolean {
  const opts = item.options ?? [];
  return opts.some(
    (o) => typeof o === "object" && o !== null && (o.recommended === true || /recommended/i.test(o.label ?? "")),
  );
}

/**
 * Start the Feed watcher for the session. Spawns `cmux events --category feed` and answers
 * actionable items as they arrive. Returns a handle whose `stop()` ends the subscription.
 */
export function startFeedWatcher(opts: { bypass: boolean; say: Say }): FeedWatcher {
  let stopped = false;
  let proc: ReturnType<typeof Bun.spawn> | null = null;

  (async () => {
    try {
      proc = Bun.spawn(
        ["cmux", "events", "--category", "feed", "--reconnect", "--no-heartbeat", "--no-ack"],
        { stdout: "pipe", stderr: "ignore" },
      );
    } catch {
      return; // cmux events unavailable; agents' own bypass flags carry the run
    }

    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (!stopped) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let frame: { name?: string; data?: FeedItem; item?: FeedItem } & FeedItem;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        // Only react to incoming actionable items, not completions/telemetry.
        if (frame.name && !/received/i.test(frame.name)) continue;
        const item: FeedItem = frame.data ?? frame.item ?? frame;
        try {
          await answer(item, opts.bypass, opts.say);
        } catch {
          // best-effort; never let an answer failure kill the watcher
        }
      }
    }
  })();

  return {
    stop() {
      stopped = true;
      try {
        proc?.kill();
      } catch {
        // already gone
      }
    },
  };
}
