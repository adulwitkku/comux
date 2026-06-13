import { Elysia, t } from "elysia";
import { checkDashboardAuth } from "@comux/dashboard-config.ts";
import type { HarnessEvent } from "@comux/harness-events.ts";
import { getDashboardSession } from "@/lib/harness-bridge";

const expectedToken = () => process.env.COMUX_DASHBOARD_TOKEN ?? "";

function unauthorized(): Response {
  return new Response("unauthorized", { status: 401 });
}

function authGuard(req: Request): boolean {
  return checkDashboardAuth(req, expectedToken());
}

export const apiApp = new Elysia({ prefix: "/api" })
  .get("/health", () => ({ ok: true }))
  .get("/status", async ({ request }) => {
    if (!authGuard(request)) return unauthorized();
    const s = await getDashboardSession();
    return s.statusSnapshot();
  })
  .get("/agents", async ({ request }) => {
    if (!authGuard(request)) return unauthorized();
    const s = await getDashboardSession();
    const agents = await s.getAgentRows();
    return { agents, refreshedAt: s.getLastQuotaRefreshAt() };
  })
  .post("/agents/refresh", async ({ request }) => {
    if (!authGuard(request)) return unauthorized();
    const s = await getDashboardSession();
    return s.refreshAgentQuotas();
  })
  .get("/commands", ({ request }) => {
    if (!authGuard(request)) return unauthorized();
    return {
      commands: [
        { name: "/plan", desc: "show PLAN.md" },
        { name: "/ws", desc: "show workspace path" },
        { name: "/agents", desc: "show capability chains" },
        { name: "/new", desc: "clear chat session" },
        { name: "/open", desc: "open .comux file" },
        { name: "/setup", desc: "detect agents & write chains" },
        { name: "/help", desc: "commands" },
      ],
    };
  })
  .post(
    "/message",
    async ({ request, body }) => {
      if (!authGuard(request)) return unauthorized();
      const s = await getDashboardSession();
      return s.submitMessage(body.text);
    },
    { body: t.Object({ text: t.String() }) },
  )
  .post(
    "/grill/:id",
    async ({ request, params, body }) => {
      if (!authGuard(request)) return unauthorized();
      const s = await getDashboardSession();
      const ok = s.resolveGrill(params.id, body.answer);
      if (!ok) return new Response("not found", { status: 404 });
      return { ok: true };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ answer: t.Union([t.Boolean(), t.Number()]) }),
    },
  )
  .get("/events", async ({ request }) => {
    if (!authGuard(request)) return unauthorized();

    const s = await getDashboardSession();
    const enc = new TextEncoder();
    let cleanup: (() => void) | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: HarnessEvent) => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        send({ type: "log", text: "connected", ts: Date.now() });
        void s.pushAgentStatus();
        cleanup = s.subscribeSse(send);
      },
      cancel() {
        cleanup?.();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });
