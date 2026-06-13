// Dashboard Harness session: shared runTurn + SSE + Grilling (ADR-0023).

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { identifySelf, findResultSurface, closeSurface, openMarkdown, openFile, renameTab, type SurfaceRef } from "@comux/cmux.ts";
import { runTurn } from "@comux/harness.ts";
import { harnessBus, type HarnessEvent, type GrillKind } from "@comux/harness-events.ts";
import { createSay } from "@comux/harness-say.ts";
import { collectAgentStatus, refreshAgentQuotas, type AgentQuotaView, type AgentStatusRow } from "@comux/agent-roster.ts";
import { loadConfig, configExists, type Config, type Capability } from "@comux/config.ts";
import { runSetup, detectAgents } from "@comux/setup.ts";
import { startFeedWatcher } from "@comux/feed.ts";
import { ensureWorkspace, readPlan, currentBranch, clearChatFiles } from "@comux/workspace.ts";
import { lastStats, setDefaultModel } from "@comux/llm.ts";
import { c, ui } from "@comux/ui.ts";

type GrillResolver = (value: boolean | number) => void;

interface PendingGrill {
  kind: GrillKind;
  resolve: GrillResolver;
}

export interface StatusSnapshot {
  workspace: string;
  branch: string;
  model: string;
  promptTokens: string;
  tokensPerSec: string;
  bypass: boolean;
}

export class DashboardSession {
  readonly workspace: string;
  readonly config: Config;
  private selfSurface: SurfaceRef | null = null;
  private readonly say: (msg: string) => void;
  private readonly feed: ReturnType<typeof startFeedWatcher>;
  private readonly pending = new Map<string, PendingGrill>();
  private turnBusy = false;
  private agentTimer: ReturnType<typeof setInterval> | null = null;
  private sseClients = new Set<(event: HarnessEvent) => void>();
  private busHooked = false;
  private quotaByAgent = new Map<string, AgentQuotaView>();
  private lastQuotaRefreshAt: number | null = null;

  private constructor(workspace: string, config: Config) {
    this.workspace = workspace;
    this.config = config;
    this.say = createSay(() => {});
    this.feed = startFeedWatcher({ bypass: config.bypass, say: this.say });
    this.agentTimer = setInterval(() => void this.pushAgentStatus(), 5000);
    void this.pushAgentStatus();
  }

  static async create(): Promise<DashboardSession> {
    const workspace = await ensureWorkspace(process.env.COMUX_WORKSPACE ?? process.cwd());
    const envModel = process.env.COMUX_MODEL;
    let config = await loadConfig();
    if (!configExists()) {
      const setup = await runSetup();
      config = setup.config;
    }
    const model = envModel ?? config.model ?? "gemma4:12b-mlx";
    if (!envModel && config.model) setDefaultModel(config.model);
    else setDefaultModel(model);
    return new DashboardSession(workspace, config);
  }

  private async getSelfSurface(): Promise<SurfaceRef> {
    if (!this.selfSurface) this.selfSurface = await identifySelf();
    return this.selfSurface;
  }

  subscribeSse(send: (event: HarnessEvent) => void): () => void {
    this.sseClients.add(send);
    return () => this.sseClients.delete(send);
  }

  private broadcast(event: HarnessEvent): void {
    for (const fn of this.sseClients) fn(event);
  }

  /** Call once when the API module loads. */
  start(): void {
    if (this.busHooked) return;
    this.busHooked = true;
    harnessBus.subscribe((event) => this.broadcast(event));
    harnessBus.log("Dashboard connected");
  }

  statusSnapshot(): StatusSnapshot {
    const model = process.env.COMUX_MODEL ?? this.config.model ?? "gemma4:12b-mlx";
    return {
      workspace: this.workspace,
      branch: currentBranch(this.workspace),
      model,
      promptTokens:
        lastStats.promptTokens != null ? `${lastStats.promptTokens}/256k` : "0/256k",
      tokensPerSec:
        lastStats.tokensPerSec != null ? `${lastStats.tokensPerSec.toFixed(1)} tok/s` : "TPS: --",
      bypass: this.config.bypass,
    };
  }

  async pushAgentStatus(): Promise<void> {
    const agents = await this.getAgentRows();
    harnessBus.emit({ type: "agent_status", agents, ts: Date.now() });
  }

  async getAgentRows(): Promise<AgentStatusRow[]> {
    return collectAgentStatus(this.config, this.workspace, this.quotaByAgent);
  }

  async refreshAgentQuotas(): Promise<{ agents: AgentStatusRow[]; refreshedAt: number }> {
    const result = await refreshAgentQuotas(this.config, this.workspace);
    this.quotaByAgent = new Map(result.agents.map((a) => [a.name, a.quota]));
    this.lastQuotaRefreshAt = result.refreshedAt;
    harnessBus.emit({ type: "agent_status", agents: result.agents, ts: result.refreshedAt });
    return result;
  }

  getLastQuotaRefreshAt(): number | null {
    return this.lastQuotaRefreshAt;
  }

  resolveGrill(id: string, answer: boolean | number): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.resolve(answer);
    return true;
  }

  private askGrill(
    kind: GrillKind,
    question: string,
    options?: string[],
  ): Promise<boolean | number> {
    const id = crypto.randomUUID();
    const event: HarnessEvent = {
      type: "grill",
      id,
      kind,
      question,
      options,
      ts: Date.now(),
    };
    harnessBus.emit(event);
    return new Promise((resolve) => {
      this.pending.set(id, { kind, resolve });
    });
  }

  private confirmPlan = async (_summary: string): Promise<boolean> => {
    if (process.env.COMUX_YES) return true;
    if (this.config.bypass) return true;
    const ans = await this.askGrill("confirm", "อนุมัติแผนนี้แล้วรันทั้งหมดเลยไหม?");
    return ans === true;
  };

  private chooseCapability = async (
    top: Capability,
    alts: Capability[],
  ): Promise<Capability> => {
    if (this.config.bypass) return top;
    const opts = [top, ...alts.filter((c) => c !== top)];
    const ans = await this.askGrill("choose", "งานนี้เป็นแบบไหน?", opts);
    if (typeof ans === "number") return opts[ans] ?? top;
    return top;
  };

  async handleSlash(line: string): Promise<void> {
    const sp = line.search(/\s/);
    const name = sp === -1 ? line : line.slice(0, sp);
    const arg = sp === -1 ? "" : line.slice(sp + 1).trim();

    switch (name) {
      case "/plan":
        this.say(c.gray(await readPlan(this.workspace)));
        break;
      case "/ws":
        this.say(c.blue(`  ${this.workspace}`));
        break;
      case "/agents": {
        const installed = new Map(detectAgents().map((a) => [a.name, a.installed]));
        for (const [cap, names] of Object.entries(this.config.chains)) {
          const mark = names.map((n) => (installed.get(n) ? n : `${n}✗`)).join(" → ");
          this.say(`  ${cap.padEnd(11)} ${mark}`);
        }
        break;
      }
      case "/help":
        this.say(c.gray("  /plan · /ws · /agents · /new · /open · /setup · /help"));
        this.say(c.gray("  pickers (/model, /settings, /broadcast) — use the TUI or edit config.json"));
        break;
      case "/new": {
        const existing = await findResultSurface().catch(() => null);
        if (existing) await closeSurface(existing).catch(() => {});
        const n = await clearChatFiles(this.workspace);
        this.say(c.green(`  ✓ new session${n > 0 ? ` — cleared ${n} chat file(s)` : ""}`));
        break;
      }
      case "/open":
      case "/open-new":
        await this.openComuxFile(arg, name === "/open");
        break;
      case "/setup": {
        const r = await runSetup();
        Object.assign(this.config, r.config);
        this.say(c.green("  ✓ wrote default agent chains"));
        break;
      }
      case "/model":
      case "/settings":
      case "/broadcast":
        this.say(ui.warn(`${name} picker ยังไม่มีบน Dashboard — ใช้ TUI หรือแก้ ~/.config/comux/config.json`));
        break;
      default:
        this.say(ui.warn(`ไม่รู้จักคำสั่ง ${name} — ดู /help`));
    }
  }

  private async openComuxFile(filename: string, closeExisting: boolean): Promise<void> {
    if (!filename) {
      this.say(c.gray("  พิมพ์ /open <ชื่อไฟล์>"));
      return;
    }
    const filePath = join(this.workspace, ".comux", filename);
    if (!existsSync(filePath)) {
      this.say(c.red(`  ไม่พบ ${filename} ใน .comux/`));
      return;
    }
    if (closeExisting) {
      const existing = await findResultSurface().catch(() => null);
      if (existing) await closeSurface(existing).catch(() => {});
    }
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
    try {
      const surface = IMAGE.has(ext)
        ? await openFile(filePath, { surface: await this.getSelfSurface() })
        : await openMarkdown(filePath, { surface: await this.getSelfSurface() });
      if (surface) {
        await renameTab(surface, closeExisting ? "comux-result" : basename(filename)).catch(() => {});
        this.say(ui.ok(`เปิด ${filename} ใน viewer`));
      }
    } catch (e) {
      this.say(ui.warn(`เปิด ${filename} ไม่ได้: ${(e as Error).message}`));
    }
  }

  async submitMessage(text: string): Promise<{ ok: boolean; error?: string }> {
    const line = text.trim();
    if (!line) return { ok: true };
    if (this.turnBusy) return { ok: false, error: "turn in progress" };

    if (line.startsWith("/")) {
      await this.handleSlash(line);
      harnessBus.turnDone();
      return { ok: true };
    }

    this.turnBusy = true;
    harnessBus.status("thinking");
    try {
      await runTurn(line, {
        workspace: this.workspace,
        selfSurface: await this.getSelfSurface(),
        config: this.config,
        confirmPlan: this.confirmPlan,
        chooseCapability: this.chooseCapability,
        say: this.say,
      });
      return { ok: true };
    } catch (e) {
      this.say(c.red(`  ⚠ error: ${(e as Error).message}`));
      return { ok: false, error: (e as Error).message };
    } finally {
      this.turnBusy = false;
      harnessBus.status("idle");
      harnessBus.turnDone();
    }
  }

  dispose(): void {
    this.feed.stop();
    if (this.agentTimer) clearInterval(this.agentTimer);
  }
}

let session: DashboardSession | null = null;
let started = false;

export async function getDashboardSession(): Promise<DashboardSession> {
  if (!session) session = await DashboardSession.create();
  if (!started) {
    session.start();
    started = true;
  }
  return session;
}
