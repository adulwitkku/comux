// Dashboard token persistence (ADR-0023).

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { configDir } from "./config.ts";

export interface DashboardConfig {
  token: string;
  createdAt: string;
}

export function dashboardConfigPath(): string {
  return join(configDir(), "dashboard.json");
}

export function dashboardPort(): number {
  const raw = process.env.COMUX_DASHBOARD_PORT ?? "62120";
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return 62120;
  return n;
}

/** Load or create the persisted Dashboard token. */
export async function ensureDashboardToken(): Promise<string> {
  const path = dashboardConfigPath();
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as Partial<DashboardConfig>;
      if (raw.token?.trim()) return raw.token.trim();
    } catch {
      /* regenerate */
    }
  }
  const token = randomBytes(24).toString("base64url");
  const cfg: DashboardConfig = { token, createdAt: new Date().toISOString() };
  await mkdir(configDir(), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2) + "\n");
  return token;
}

export function gatewayMode(): boolean {
  return process.env.COMUX_DASHBOARD_GATEWAY === "1";
}

/** Whether this HTTP request must present a Dashboard token. */
export function requiresDashboardAuth(req: Request): boolean {
  if (gatewayMode()) return true;
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").toLowerCase();
  if (!host) return false;
  const hostname = host.split(":")[0] ?? host;
  return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]";
}

export function tokenFromRequest(req: Request): string | null {
  const url = new URL(req.url);
  const q = url.searchParams.get("token");
  if (q) return q;
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

export function checkDashboardAuth(req: Request, expectedToken: string): boolean {
  if (!requiresDashboardAuth(req)) return true;
  return tokenFromRequest(req) === expectedToken;
}
