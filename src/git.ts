// Git is the source of truth for handover (ADR-0002). The Harness checkpoints
// after each successful step so a handover can resume from a known-good commit.

async function git(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { stdout, code };
}

/** True if the working tree has uncommitted changes. */
export async function hasChanges(cwd: string): Promise<boolean> {
  const { stdout } = await git(["status", "--porcelain"], cwd);
  return stdout.trim().length > 0;
}

/**
 * Commit the current working tree as a checkpoint. No-op (returns null) when
 * there is nothing to commit. Returns the short commit hash on success.
 */
export async function checkpoint(cwd: string, message: string): Promise<string | null> {
  if (!(await hasChanges(cwd))) return null;
  const add = await git(["add", "-A"], cwd);
  if (add.code !== 0) throw new Error("git add failed");
  const commit = await git(["commit", "-m", message], cwd);
  if (commit.code !== 0) throw new Error("git commit failed");
  const rev = await git(["rev-parse", "--short", "HEAD"], cwd);
  return rev.stdout.trim();
}
