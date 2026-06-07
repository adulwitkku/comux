// `comux update` — refresh the installed comux.
//
// comux is normally installed from a Homebrew tap whose formula ships the *source* into
// `libexec` and runs it with bun (no compiled binary). So there are two useful update paths:
//
//   comux update          → `brew update && brew upgrade comux` (the released version)
//   comux update --dev     → pull the latest origin/master source and copy it over the running
//                            install's libexec, so a freshly pushed commit can be tested without
//                            cutting a release (tag + formula bump).
//
// When comux is run straight from a git checkout (not a brew install), both paths reduce to a
// `git pull` of that checkout.

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";

/** Run a command with inherited stdio (so brew/git output streams to the user); return exit code. */
async function run(cmd: string[], cwd?: string): Promise<number> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  return await proc.exited;
}

/** The directory the running comux was installed into (libexec for brew, the repo for a checkout). */
function installRoot(): string {
  // This module lives at <root>/src/update.ts, so its parent's parent is <root>.
  return dirname(import.meta.dir);
}

function isBrewInstall(root: string): boolean {
  return root.includes("/Cellar/");
}

/** Copy src/scripts/package.json from a source repo over the install root. */
async function syncSource(root: string, log: (m: string) => void): Promise<void> {
  const local = process.env.COMUX_SRC;
  let srcRepo: string;
  if (local) {
    log(`using local source: ${local}`);
    srcRepo = local;
  } else {
    const cache = join(homedir(), ".cache", "comux", "repo");
    const url = process.env.COMUX_REPO ?? "https://github.com/adulwitkku/comux.git";
    if (existsSync(join(cache, ".git"))) {
      log(`updating cached source (${cache}) …`);
      if ((await run(["git", "-C", cache, "pull", "--ff-only"])) !== 0)
        throw new Error("git pull failed");
    } else {
      log(`cloning ${url} → ${cache} …`);
      await mkdir(dirname(cache), { recursive: true });
      if ((await run(["git", "clone", "--depth", "1", url, cache])) !== 0)
        throw new Error("git clone failed");
    }
    srcRepo = cache;
  }
  for (const item of ["src", "scripts", "package.json"]) {
    await cp(join(srcRepo, item), join(root, item), { recursive: true, force: true });
  }
  log(`synced source → ${root}`);
  log("done — run `comux --version` to confirm.");
}

export async function runUpdate(argv: string[]): Promise<void> {
  const log = (m: string) => console.log(m);
  const dev = argv.includes("--dev");
  const root = installRoot();
  const brew = isBrewInstall(root);

  if (!brew) {
    // Running from a git checkout: both paths are just a pull of this repo.
    log(`source checkout — git pull in ${root}`);
    if ((await run(["git", "pull", "--ff-only"], root)) !== 0) {
      log("git pull failed (uncommitted changes?). resolve and retry.");
    }
    return;
  }

  if (dev) {
    await syncSource(root, log);
    return;
  }

  // Released path: let Homebrew upgrade to the latest published formula.
  await run(["brew", "update"]);
  const code = await run(["brew", "upgrade", "comux"]);
  if (code !== 0) log("brew upgrade reported nothing to do (already latest published release).");
  log("tip: to test code pushed to master before a release, run `comux update --dev`.");
}
