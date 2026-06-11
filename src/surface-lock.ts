// Per-workspace surface exclusivity (ADR-0023): only one of TUI or Dashboard at a time.

import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SurfaceKind = "tui" | "dashboard";

export interface SurfaceLock {
  surface: SurfaceKind;
  pid: number;
  startedAt: string;
}

function lockPath(workspace: string): string {
  return join(workspace, ".comux", "surface.lock");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readSurfaceLock(workspace: string): Promise<SurfaceLock | null> {
  const path = lockPath(workspace);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as SurfaceLock;
  } catch {
    return null;
  }
}

/** Acquire the lock or throw if another live surface holds it. */
export async function acquireSurfaceLock(workspace: string, surface: SurfaceKind): Promise<void> {
  const existing = await readSurfaceLock(workspace);
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
    throw new Error(
      `workspace locked by ${existing.surface} (pid ${existing.pid}) — stop it before starting ${surface}`,
    );
  }
  const lock: SurfaceLock = { surface, pid: process.pid, startedAt: new Date().toISOString() };
  await writeFile(lockPath(workspace), JSON.stringify(lock, null, 2) + "\n");
}

/** Release the lock when it belongs to this process. */
export async function releaseSurfaceLock(workspace: string): Promise<void> {
  const existing = await readSurfaceLock(workspace);
  if (existing?.pid === process.pid) {
    await unlink(lockPath(workspace)).catch(() => {});
  }
}
