import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function getDashboardToken(): string | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search).get("token");
  if (q) {
    sessionStorage.setItem("comux-dashboard-token", q);
    return q;
  }
  const stored = sessionStorage.getItem("comux-dashboard-token");
  if (stored) return stored;
  // Next dev (:PORT+1) often opens without ?token=; token was injected at spawn time.
  const embedded = process.env.NEXT_PUBLIC_COMUX_DASHBOARD_TOKEN;
  return embedded || null;
}

export function authHeaders(): HeadersInit {
  const token = getDashboardToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
