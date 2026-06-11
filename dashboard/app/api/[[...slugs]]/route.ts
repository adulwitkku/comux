import { apiApp } from "@/lib/api-app";

export const GET = (req: Request) => apiApp.fetch(req);
export const POST = (req: Request) => apiApp.fetch(req);
