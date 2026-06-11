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
  return sessionStorage.getItem("comux-dashboard-token");
}

export function authHeaders(): HeadersInit {
  const token = getDashboardToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
