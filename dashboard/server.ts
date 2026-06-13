#!/usr/bin/env bun
// Dashboard entry: Bun serves /api (comux core) and proxies everything else to Next.js.
// Next route handlers run on Node and cannot call Bun.* — keep Harness code on this side.

import { apiApp } from "./lib/api-app.ts";
import { getDashboardSession } from "./lib/harness-bridge.ts";

const mainPort = Number(process.env.PORT ?? process.env.COMUX_DASHBOARD_PORT ?? 62120);
const uiPort = mainPort + 1;
const cwd = import.meta.dir;
const prod = process.env.NODE_ENV === "production";

const nextCmd = prod
  ? ["bun", "--bun", "next", "start", "-p", String(uiPort)]
  : ["bun", "--bun", "next", "dev", "-p", String(uiPort)];

const nextProc = Bun.spawn(nextCmd, {
  cwd,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: {
    ...process.env,
    NEXT_PUBLIC_COMUX_API_PORT: String(mainPort),
    NEXT_PUBLIC_COMUX_DASHBOARD_TOKEN: process.env.COMUX_DASHBOARD_TOKEN ?? "",
  },
});

async function waitForNext(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error(`Next.js did not become ready on port ${port}`);
}

function shutdown(): void {
  nextProc.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await waitForNext(uiPort);

console.log(`  API + proxy: http://127.0.0.1:${mainPort}  (Next UI :${uiPort})`);

void getDashboardSession().catch((e: Error) => {
  console.error(`  ⚠ Harness session: ${e.message}`);
});

Bun.serve({
  port: mainPort,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api")) {
      return apiApp.fetch(req);
    }

    const target = `http://127.0.0.1:${uiPort}${url.pathname}${url.search}`;
    const headers = new Headers(req.headers);
    headers.set("x-forwarded-host", req.headers.get("host") ?? `127.0.0.1:${mainPort}`);
    headers.delete("host");

    const init: RequestInit & { duplex?: "half" } = {
      method: req.method,
      headers,
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = req.body;
      init.duplex = "half";
    }
    return fetch(target, init);
  },
});
