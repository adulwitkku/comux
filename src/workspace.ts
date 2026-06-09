// The workspace: the project directory the user runs comux from (ADR-0020).
// No longer a separate subdirectory — since ADR-0017 dropped write-confinement, the isolated
// ./workspace/ repo lost its sole justification. Agents work in the real project; checkpoints
// land in the project's own git history. Session files (chat, reports, search artifacts) live
// in .comux/ which is auto-added to .gitignore.

import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function git(args: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

/** Ensure `dir` exists and is a git repo. Returns the absolute path. */
export async function ensureWorkspace(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) {
    await git(["init", "-q"], dir);
  }
  // Set fallback identity only when the repo has none — don't override the user's own config.
  const hasEmail = (await git(["config", "user.email"], dir)).trim().length > 0;
  if (!hasEmail) {
    await git(["config", "user.email", "harness@local"], dir);
    await git(["config", "user.name", "comux"], dir);
  }
  // Harness session files live here, kept out of the project's git history.
  await mkdir(join(dir, ".comux"), { recursive: true });
  await ensureGitIgnore(dir);
  return dir;
}

async function ensureGitIgnore(dir: string): Promise<void> {
  const p = join(dir, ".gitignore");
  const entry = ".comux/";
  let content = "";
  if (existsSync(p)) {
    content = await readFile(p, "utf8");
    if (content.split("\n").some((l) => l.trim() === entry || l.trim() === ".comux")) return;
  }
  await writeFile(p, content + (content && !content.endsWith("\n") ? "\n" : "") + entry + "\n");
}

/** The PLAN.md the Orchestrator reads as its memory; placeholder text when absent. */
export async function readPlan(dir: string): Promise<string> {
  const p = join(dir, "PLAN.md");
  return existsSync(p) ? readFile(p, "utf8") : "(no PLAN.md yet — nothing planned)";
}

export async function recentGitLog(dir: string, n = 5): Promise<string> {
  return (await git(["log", "--oneline", `-${n}`], dir)).trim();
}

/** Path for the next sequential chat reply file (.comux/chat1.md, chat2.md, …). */
export function nextChatFile(dir: string): string {
  const comuxDir = join(dir, ".comux");
  const existing = existsSync(comuxDir)
    ? readdirSync(comuxDir).filter((f) => /^chat\d+\.md$/.test(f)).length
    : 0;
  return join(comuxDir, `chat${existing + 1}.md`);
}

/** Delete all .comux/chat*.md files. Returns the number of files removed. */
export async function clearChatFiles(dir: string): Promise<number> {
  const comuxDir = join(dir, ".comux");
  if (!existsSync(comuxDir)) return 0;
  const files = readdirSync(comuxDir).filter((f) => /^chat\d*\.md$/.test(f));
  await Promise.all(files.map((f) => unlink(join(comuxDir, f)).catch(() => {})));
  return files.length;
}

/** CONTEXT.md and README.md from the workspace root, for chatReply context. */
export async function readProjectDocs(dir: string): Promise<{ contextMd: string | null; readmeMd: string | null }> {
  const read = async (name: string): Promise<string | null> => {
    const p = join(dir, name);
    return existsSync(p) ? readFile(p, "utf8") : null;
  };
  const [contextMd, readmeMd] = await Promise.all([read("CONTEXT.md"), read("README.md")]);
  return { contextMd, readmeMd };
}

/** Current git branch name (synchronous; cheap enough to call once per prompt). */
export function currentBranch(dir: string): string {
  const r = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: dir });
  return r.stdout.toString().trim() || "—";
}

const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store"]);

/** Flat list of files in `.comux/` (agent artifacts, chat files, etc.) for `/open` completion. */
export function listComuxFiles(dir: string): string[] {
  const comuxDir = join(dir, ".comux");
  if (!existsSync(comuxDir)) return [];
  return readdirSync(comuxDir).filter((name) => !name.startsWith("."));
}

/** Relative file paths under `dir` (for `@` file mentions), skipping noise dirs. */
export function listFiles(dir: string, max = 2000): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    if (out.length >= max) return;
    let entries;
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
      if (out.length >= max) return;
    }
  };
  walk("");
  return out;
}
