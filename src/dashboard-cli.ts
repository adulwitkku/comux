// `comux dashboard` entry (ADR-0023): surface lock, token, optional cloudflared, spawn Next.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { acquireSurfaceLock, releaseSurfaceLock } from "./surface-lock.ts";
import { dashboardPort, ensureDashboardToken } from "./dashboard-config.ts";
import { ensureWorkspace } from "./workspace.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Brew/dev installs ship dashboard/ without node_modules — install once on first launch. */
async function ensureDashboardDeps(dashboardDir: string): Promise<void> {
  const marker = join(dashboardDir, "node_modules", "@sinclair", "typebox");
  if (existsSync(marker)) return;
  console.log("  Installing dashboard dependencies (first run)…");
  const proc = Bun.spawn(["bun", "install"], { cwd: dashboardDir, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error("dashboard: bun install failed — run: bun install --cwd dashboard");
}

export interface DashboardCliArgs {
  gateway: boolean;
}

export function parseDashboardArgs(argv: string[]): DashboardCliArgs {
  return { gateway: argv.includes("--gateway") };
}

export async function runDashboard(args: DashboardCliArgs): Promise<number> {
  const workspace = await ensureWorkspace(process.env.COMUX_WORKSPACE ?? process.cwd());
  await acquireSurfaceLock(workspace, "dashboard");

  const token = await ensureDashboardToken();
  const port = dashboardPort();

  if (args.gateway) process.env.COMUX_DASHBOARD_GATEWAY = "1";

  process.env.COMUX_WORKSPACE = workspace;
  process.env.COMUX_DASHBOARD_TOKEN = token;
  process.env.COMUX_DASHBOARD_PORT = String(port);

  const dashboardDir = join(REPO_ROOT, "dashboard");
  await ensureDashboardDeps(dashboardDir);
  const proc = Bun.spawn(["bun", "run", "dev"], {
    cwd: dashboardDir,
    env: { ...process.env, PORT: String(port) },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  let tunnel: ReturnType<typeof Bun.spawn> | null = null;
  if (args.gateway) {
    const cloudflared = Bun.which("cloudflared");
    if (!cloudflared) {
      console.error("error: cloudflared not on PATH — install it or omit --gateway");
      proc.kill();
      await releaseSurfaceLock(workspace);
      return 1;
    }
    tunnel = Bun.spawn([cloudflared, "tunnel", "--url", `http://127.0.0.1:${port}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    void watchTunnelUrl(tunnel, token);
  }

  console.log(`\n  Dashboard: http://127.0.0.1:${port}`);
  console.log(`  Token (remote): ${token}`);
  console.log(`  Remote URL: http://127.0.0.1:${port}?token=${encodeURIComponent(token)}\n`);

  const onExit = async () => {
    tunnel?.kill();
    proc.kill();
    await releaseSurfaceLock(workspace);
  };
  process.on("SIGINT", () => void onExit().then(() => process.exit(0)));
  process.on("SIGTERM", () => void onExit().then(() => process.exit(0)));

  const code = await proc.exited;
  tunnel?.kill();
  await releaseSurfaceLock(workspace);
  return code;
}

function watchTunnelUrl(proc: ReturnType<typeof Bun.spawn>, token: string): void {
  const stderr = proc.stderr;
  if (!stderr || typeof stderr === "number") return;
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of stderr as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m) {
        const url = `${m[0]}?token=${encodeURIComponent(token)}`;
        console.log(`\n  Gateway: ${url}\n`);
        break;
      }
    }
  })();
}
