// Confine an Agent's process so it can only WRITE inside its workspace repo (ADR-0005).
//
// Agents run unattended and edit files automatically, so "the working directory is the
// repo" is not enough on its own — nothing stops a process from writing an absolute path
// or `cd ..`. On macOS we wrap the launch command with `sandbox-exec`: reads stay
// unrestricted, but writes are denied everywhere except the workspace (plus the few dirs
// an Agent legitimately needs — temp, /dev, and its own cache/config).
//
// This is a real boundary on the documented primary platform (darwin). On other platforms
// `sandbox-exec` does not exist, so we fall back to working-directory confinement only and
// say so — see ADR-0005. Opt out anywhere with COMUX_NO_SANDBOX=1.

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Single-quote a string for safe use inside a shell command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Resolve symlinks where possible; fall back to the raw path. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Double-quote a path for use inside a sandbox profile S-expression. */
function profilePath(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Wrap an Agent launch command so it can only write inside `workspace`. Returns the
 * command unchanged when confinement is disabled or unavailable on this platform.
 */
export function confine(launch: string, workspace: string): string {
  if (process.env.COMUX_NO_SANDBOX) return launch;
  if (process.platform !== "darwin") return launch; // enforced on macOS only (ADR-0005)

  const home = homedir();
  // Dirs the Agent may write to: the repo, temp, /dev, and common per-user cache/config.
  const writable = [
    real(workspace),
    real(tmpdir()),
    "/private/tmp",
    "/private/var/folders",
    "/dev",
    join(home, ".cache"),
    join(home, ".config"),
    join(home, ".local"),
    join(home, ".pi"),
  ];

  // Last-match-wins: allow everything, drop all writes, then re-allow the writable subpaths.
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    ...writable.map((p) => `(allow file-write* (subpath ${profilePath(p)}))`),
  ].join("\n");

  return `sandbox-exec -p ${shq(profile)} sh -c ${shq(launch)}`;
}
