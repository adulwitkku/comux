"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ContextPct, QuotaBar } from "@/components/quota-bar";
import { authHeaders, getDashboardToken } from "@/lib/utils";

interface QuotaWindow {
  usedPct: number | null;
  resetIn: string | null;
}

interface AgentQuota {
  contextPct: number | null;
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  noData: boolean;
  probeError: string | null;
}

interface AgentRow {
  name: string;
  binary: string;
  installed: boolean;
  lifecycle: string;
  quota: AgentQuota;
}

type HarnessEvent =
  | { type: "log"; text: string }
  | { type: "status"; phase: string }
  | {
      type: "grill";
      id: string;
      kind: "confirm" | "choose";
      question: string;
      options?: string[];
    }
  | { type: "turn_done" }
  | { type: "agent_status"; agents: AgentRow[] };

interface StatusSnapshot {
  workspace: string;
  branch: string;
  model: string;
  promptTokens: string;
  tokensPerSec: string;
  bypass: boolean;
}

interface SlashCmd {
  name: string;
  desc: string;
}

type Tab = "chat" | "agents";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function DashboardApp() {
  const [tab, setTab] = useState<Tab>("chat");
  const [logs, setLogs] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState("idle");
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentsRefreshing, setAgentsRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [grill, setGrill] = useState<Extract<HarnessEvent, { type: "grill" }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashItems, setSlashItems] = useState<SlashCmd[]>([]);
  const [slashSel, setSlashSel] = useState(0);
  const logEnd = useRef<HTMLDivElement>(null);

  const appendLog = useCallback((text: string) => {
    setLogs((prev) => [...prev, stripAnsi(text)]);
  }, []);

  const apiFetch = useCallback(async (path: string, init?: RequestInit) => {
    const token = getDashboardToken();
    const url = token ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : path;
    return fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  }, []);

  const refreshAgents = useCallback(async () => {
    const r = await apiFetch("/api/agents");
    if (r.ok) {
      const data = (await r.json()) as { agents: AgentRow[]; refreshedAt: number | null };
      setAgents(data.agents);
      if (data.refreshedAt) setLastRefreshedAt(data.refreshedAt);
    }
  }, [apiFetch]);

  const probeAgents = useCallback(async () => {
    setAgentsRefreshing(true);
    try {
      const r = await apiFetch("/api/agents/refresh", { method: "POST" });
      if (r.ok) {
        const data = (await r.json()) as { agents: AgentRow[]; refreshedAt: number };
        setAgents(data.agents);
        setLastRefreshedAt(data.refreshedAt);
      }
    } finally {
      setAgentsRefreshing(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void apiFetch("/api/status").then(async (r) => {
      if (r.ok) setStatus((await r.json()) as StatusSnapshot);
    });
    void apiFetch("/api/commands").then(async (r) => {
      if (r.ok) {
        const data = (await r.json()) as { commands: SlashCmd[] };
        setSlashItems(data.commands);
      }
    });
    void refreshAgents();
  }, [apiFetch, refreshAgents]);

  useEffect(() => {
    if (tab === "agents") void refreshAgents();
  }, [tab, refreshAgents]);

  useEffect(() => {
    const token = getDashboardToken();
    const url = token
      ? `/api/events?token=${encodeURIComponent(token)}`
      : "/api/events";
    const es = new EventSource(url);
    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as HarnessEvent;
        if (event.type === "log") appendLog(event.text);
        else if (event.type === "status") setPhase(event.phase);
        else if (event.type === "grill") setGrill(event);
        else if (event.type === "turn_done") setBusy(false);
        else if (event.type === "agent_status") setAgents(event.agents);
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [appendLog]);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const submit = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setInput("");
    setSlashOpen(false);
    appendLog(`› ${text}`);
    const res = await apiFetch("/api/message", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      appendLog(`⚠ ${res.status} ${await res.text()}`);
      setBusy(false);
    }
  };

  const answerGrill = async (answer: boolean | number) => {
    if (!grill) return;
    await apiFetch(`/api/grill/${grill.id}`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    });
    setGrill(null);
  };

  const filteredSlash = slashItems.filter((c) => {
    const q = input.slice(1).toLowerCase();
    return !q || c.name.slice(1).includes(q) || c.desc.toLowerCase().includes(q);
  });

  const onInputChange = (v: string) => {
    setInput(v);
    setSlashOpen(v.startsWith("/"));
    setSlashSel(0);
  };

  const pickSlash = (name: string) => {
    setInput(`${name} `);
    setSlashOpen(false);
  };

  return (
    <div className="flex h-screen">
      <aside className="flex w-48 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900 p-3">
        <div className="mb-4 text-sm font-semibold tracking-wide text-zinc-100">comux</div>
        <nav className="flex flex-col gap-1">
          <Button
            variant={tab === "agents" ? "default" : "ghost"}
            className="justify-start"
            onClick={() => setTab("agents")}
          >
            Agents
          </Button>
          <Button
            variant={tab === "chat" ? "default" : "ghost"}
            className="justify-start"
            onClick={() => setTab("chat")}
          >
            Chat
          </Button>
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {tab === "chat" ? (
          <>
            <div className="flex-1 overflow-y-auto p-4">
              {logs.map((line, i) => (
                <div key={i} className="log-line">
                  {line}
                </div>
              ))}
              <div ref={logEnd} />
            </div>

            {status && (
              <div className="border-t border-zinc-800 px-4 py-2 text-xs text-zinc-500">
                {status.workspace} ({status.branch}) · {status.promptTokens} · {status.model} ·{" "}
                {status.tokensPerSec} · phase: {phase}
                {status.bypass ? " · bypass on" : ""}
              </div>
            )}

            {grill && (
              <div className="border-t border-amber-900/50 bg-amber-950/30 px-4 py-3">
                <p className="mb-2 text-sm text-amber-100">{grill.question}</p>
                {grill.kind === "confirm" ? (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void answerGrill(true)}>
                      ใช่
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void answerGrill(false)}>
                      ไม่
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {grill.options?.map((opt, i) => (
                      <Button key={opt} size="sm" variant="outline" onClick={() => void answerGrill(i)}>
                        {opt}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="relative border-t border-zinc-800 p-4">
              {slashOpen && filteredSlash.length > 0 && (
                <div className="absolute bottom-full left-4 right-4 mb-1 max-h-40 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 shadow-lg">
                  {filteredSlash.map((c, i) => (
                    <button
                      key={c.name}
                      type="button"
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${
                        i === slashSel ? "bg-zinc-800 text-cyan-300" : "text-zinc-300 hover:bg-zinc-800"
                      }`}
                      onClick={() => pickSlash(c.name)}
                    >
                      <span className="font-mono">{c.name}</span>
                      <span className="text-xs text-zinc-500">{c.desc}</span>
                    </button>
                  ))}
                </div>
              )}
              <Textarea
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (slashOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                    e.preventDefault();
                    setSlashSel((s) => {
                      const n = filteredSlash.length;
                      if (!n) return 0;
                      return e.key === "ArrowDown" ? (s + 1) % n : (s - 1 + n) % n;
                    });
                    return;
                  }
                  if (e.key === "Tab" && slashOpen && filteredSlash[slashSel]) {
                    e.preventDefault();
                    pickSlash(filteredSlash[slashSel]!.name);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder="Message… (/ commands · Shift+Enter newline)"
                disabled={busy}
              />
              <div className="mt-2 flex justify-end">
                <Button onClick={() => void submit()} disabled={busy || !input.trim()}>
                  {busy ? "Running…" : "Send"}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-auto p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-medium">Agent roster (chains)</h2>
              <div className="flex items-center gap-3">
                {lastRefreshedAt != null && (
                  <span className="text-xs text-zinc-500">
                    Last refreshed {new Date(lastRefreshedAt).toLocaleString()}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={agentsRefreshing}
                  onClick={() => void probeAgents()}
                >
                  {agentsRefreshing ? "Refreshing…" : "Refresh quotas"}
                </Button>
              </div>
            </div>
            <table className="w-full text-left text-sm">
              <thead className="text-zinc-500">
                <tr className="border-b border-zinc-800">
                  <th className="py-2 pr-4">Agent</th>
                  <th className="py-2 pr-4">CLI</th>
                  <th className="py-2 pr-4">PATH</th>
                  <th className="py-2 pr-4">Lifecycle</th>
                  <th className="py-2 pr-4">Context</th>
                  <th className="py-2 pr-4">5h</th>
                  <th className="py-2 pr-4">7d</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.name} className="border-b border-zinc-900 align-top">
                    <td className="py-2 pr-4 font-mono">{a.name}</td>
                    <td className="py-2 pr-4 text-zinc-400">{a.binary}</td>
                    <td className="py-2 pr-4">{a.installed ? "✓" : "✗"}</td>
                    <td className="py-2 pr-4">{a.lifecycle}</td>
                    <td className="py-2 pr-4">
                      <ContextPct pct={a.quota.contextPct} noData={a.quota.noData} />
                    </td>
                    <td className="py-2 pr-4">
                      <QuotaBar
                        usedPct={a.quota.fiveHour?.usedPct ?? null}
                        resetIn={a.quota.fiveHour?.resetIn}
                        noData={a.quota.noData}
                      />
                    </td>
                    <td className="py-2 pr-4">
                      <QuotaBar
                        usedPct={a.quota.sevenDay?.usedPct ?? null}
                        resetIn={a.quota.sevenDay?.resetIn}
                        noData={a.quota.noData}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {agents.some((a) => a.quota.probeError) && (
              <div className="mt-3 space-y-1 text-xs text-red-400">
                {agents
                  .filter((a) => a.quota.probeError)
                  .map((a) => (
                    <div key={a.name}>
                      {a.name}: {a.quota.probeError}
                    </div>
                  ))}
              </div>
            )}
            {!agents.length && (
              <p className="text-sm text-zinc-500">Waiting for agent_status events…</p>
            )}
            <p className="mt-4 text-xs text-zinc-600">
              Lifecycle และ PATH อัปเดตอัตโนมัติทุก ~5s. Quota/context อัปเดตเมื่อกด Refresh — มี probe
              สำหรับ cursor, claude (cache จาก statusline), codex (อ่าน session log) และ agy (อ่าน state.vscdb จาก Antigravity IDE);
              pi/opencode เป็น local model จึงไม่มี quota. ทั้งหมดอ่าน cache เท่านั้น ไม่ยิง prompt
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
