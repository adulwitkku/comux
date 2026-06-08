import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const DEFAULT_DIR = join(homedir(), ".cmuxterm", "workspaces");
const SESSION_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "cmux",
  "session-com.cmuxterm.app.json",
);

type SurfaceSpec = {
  type: "terminal" | "browser";
  url?: string;
  command?: string;
  cwd?: string;
  title?: string;
  profileID?: string;
  /** @deprecated legacy key from earlier cmux-ws saves */
  profileId?: string;
};

type PaneSpec = {
  name?: string;
  surfaces: SurfaceSpec[];
};

type LayoutNode =
  | { pane: PaneSpec }
  | {
      direction: "horizontal" | "vertical";
      split: number;
      children: LayoutNode[];
    };

type SavedWorkspace = {
  version: 1;
  savedAt: string;
  title: string;
  cwd: string;
  description?: string | null;
  layout: LayoutNode;
  source?: { workspaceRef?: string; workspaceId?: string };
};

type WorkspaceListItem = {
  ref: string;
  id?: string;
  title: string;
  current_directory: string;
  description?: string | null;
};

type TreeSurface = {
  ref?: string;
  type: string;
  url?: string | null;
  title?: string;
  tty?: string | null;
};

type TtyProcess = {
  stat: string;
  pid: number;
  ppid: number;
  command: string;
};

type TreePane = {
  name?: string;
  title?: string;
  surfaces: TreeSurface[];
};

type TreeWorkspace = {
  ref: string;
  title: string;
  panes: TreePane[];
};

type SessionPanel = {
  id: string;
  type: string;
  title?: string;
  customTitle?: string;
  directory?: string;
  browser?: { urlString?: string; profileID?: string };
  terminal?: { workingDirectory?: string };
};

type SessionLayout =
  | { type: "pane"; pane: { panelIds: string[]; selectedPanelId?: string } }
  | {
      type: "split";
      split: {
        orientation: "horizontal" | "vertical";
        dividerPosition: number;
        first: SessionLayout;
        second: SessionLayout;
      };
    };

type SessionWorkspace = {
  workspaceId: string;
  customTitle?: string;
  currentDirectory?: string;
  layout: SessionLayout;
  panels: SessionPanel[];
};

async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn({
    cmd: ["cmux", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CMUX_QUIET: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function runJSON<T>(args: string[]): Promise<T> {
  const { stdout, stderr, code } = await run(["--json", ...args]);
  if (code !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `cmux failed: ${args.join(" ")}`);
  }
  return JSON.parse(stdout) as T;
}

async function runCmd(args: string[]): Promise<string> {
  const { stdout, stderr, code } = await run(args);
  if (code !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `cmux failed: ${args.join(" ")}`);
  }
  return stdout.trim();
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function defaultSavePath(title: string): string {
  mkdirSync(DEFAULT_DIR, { recursive: true });
  return join(DEFAULT_DIR, `${slugify(title) || "workspace"}.json`);
}

function resolveSavePath(input: string): string {
  if (input.endsWith(".json")) {
    return resolve(input);
  }
  const byName = join(DEFAULT_DIR, `${slugify(input)}.json`);
  if (existsSync(byName)) return byName;
  return resolve(input);
}

function browserProfileId(surface: SurfaceSpec): string | undefined {
  return (surface.profileID ?? surface.profileId)?.trim() || undefined;
}

function normalizeSurfaceSpec(surface: SurfaceSpec): SurfaceSpec {
  if (surface.type !== "browser") {
    delete surface.profileId;
    return surface;
  }
  const profileID = browserProfileId(surface);
  if (profileID) {
    surface.profileID = profileID;
  } else {
    delete surface.profileID;
  }
  delete surface.profileId;
  return surface;
}

function normalizeLayoutNode(layout: LayoutNode): LayoutNode {
  if ("pane" in layout) {
    layout.pane.surfaces = layout.pane.surfaces.map(normalizeSurfaceSpec);
    return layout;
  }
  for (const child of layout.children) {
    normalizeLayoutNode(child);
  }
  return layout;
}

function normalizeSavedWorkspace(data: SavedWorkspace): SavedWorkspace {
  normalizeLayoutNode(data.layout);
  return data;
}

function readSaved(input: string): { path: string; data: SavedWorkspace } {
  const path = resolveSavePath(input);
  if (!existsSync(path)) {
    throw new Error(`saved workspace not found: ${path}`);
  }
  const data = normalizeSavedWorkspace(
    JSON.parse(readFileSync(path, "utf8")) as SavedWorkspace,
  );
  if (!data.layout || !data.title) {
    throw new Error(`invalid saved workspace file: ${path}`);
  }
  return { path, data };
}

function writeSaved(path: string, data: SavedWorkspace): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalizeSavedWorkspace(data), null, 2)}\n`, "utf8");
}

async function listWorkspaces(): Promise<WorkspaceListItem[]> {
  const data = await runJSON<{ workspaces: WorkspaceListItem[] }>([
    "--id-format",
    "both",
    "list-workspaces",
  ]);
  return data.workspaces;
}

async function resolveWorkspace(query?: string): Promise<WorkspaceListItem> {
  const workspaces = await listWorkspaces();
  if (workspaces.length === 0) {
    throw new Error("no workspaces found");
  }

  const q = query?.trim();
  if (!q) {
    const envId = process.env.CMUX_WORKSPACE_ID;
    if (envId) {
      const byEnv = workspaces.find((w) => w.id === envId);
      if (byEnv) return byEnv;
    }
    const current = await runJSON<{ caller?: { workspace_ref?: string } }>(["identify"]);
    const ref = current.caller?.workspace_ref;
    const byCaller = workspaces.find((w) => w.ref === ref);
    if (byCaller) return byCaller;
    throw new Error("could not resolve caller workspace; pass --workspace");
  }

  if (q.startsWith("workspace:")) {
    const hit = workspaces.find((w) => w.ref === q);
    if (hit) return hit;
    throw new Error(`workspace not found: ${q}`);
  }

  const lower = q.toLowerCase();
  const exactMatches = workspaces.filter((w) => w.title.toLowerCase() === lower);
  if (exactMatches.length === 1) return exactMatches[0]!;
  if (exactMatches.length > 1) {
    throw new Error(
      `ambiguous workspace "${q}": ${exactMatches.map((w) => `${w.title} (${w.ref})`).join(", ")} — use workspace:N or UUID`,
    );
  }

  const partial = workspaces.filter((w) => w.title.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new Error(`ambiguous workspace "${q}": ${partial.map((w) => w.title).join(", ")}`);
  }

  const byIndex = Number(q);
  if (!Number.isNaN(byIndex)) {
    const hit = workspaces.find(
      (w) => w.ref === `workspace:${byIndex}` || w.ref.endsWith(`:${byIndex}`),
    );
    if (hit) return hit;
  }

  throw new Error(`workspace not found: ${q}`);
}

async function getTreeWorkspace(ref: string): Promise<TreeWorkspace> {
  const tree = await runJSON<{ windows: Array<{ workspaces: TreeWorkspace[] }> }>([
    "tree",
    "--workspace",
    ref,
  ]);
  for (const window of tree.windows) {
    for (const ws of window.workspaces) {
      if (ws.ref === ref) return ws;
    }
  }
  throw new Error(`tree missing workspace ${ref}`);
}

function readSessionWorkspaces(): SessionWorkspace[] {
  if (!existsSync(SESSION_PATH)) return [];
  const session = JSON.parse(readFileSync(SESSION_PATH, "utf8")) as {
    windows?: Array<{ tabManager?: { workspaces?: SessionWorkspace[] } }>;
  };
  const out: SessionWorkspace[] = [];
  for (const window of session.windows ?? []) {
    for (const ws of window.tabManager?.workspaces ?? []) {
      out.push(ws);
    }
  }
  return out;
}

function surfaceDisplayTitle(title?: string, customTitle?: string): string | undefined {
  const name = (customTitle ?? title)?.trim();
  return name || undefined;
}

function isShellCommand(command: string): boolean {
  const cmd = command.trim();
  return (
    cmd.includes("/usr/bin/login") ||
    /^-\//.test(cmd) ||
    /\/(zsh|bash|sh|fish)(?:\s|$)/.test(cmd) ||
    /^(zsh|bash|sh|fish)(?:\s|$)/.test(cmd)
  );
}

function parseTtyProcesses(tty: string): TtyProcess[] {
  const proc = Bun.spawnSync({
    cmd: ["ps", "-t", tty, "-o", "stat=,pid=,ppid=,command="],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return [];

  const text = new TextDecoder().decode(proc.stdout).trim();
  if (!text) return [];

  const processes: TtyProcess[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    processes.push({
      stat: match[1]!,
      pid: Number(match[2]),
      ppid: Number(match[3]),
      command: match[4]!.trim(),
    });
  }
  return processes;
}

function foregroundCommandForTty(tty: string): string | undefined {
  const processes = parseTtyProcesses(tty);
  if (processes.length === 0) return undefined;

  const shells = processes.filter((p) => isShellCommand(p.command));
  const shellPids = new Set(shells.map((p) => p.pid));
  const foreground = processes.filter((p) => p.stat.includes("+") && !isShellCommand(p.command));

  const launched = foreground.filter((p) => shellPids.has(p.ppid));
  if (launched.length > 0) return launched[0]!.command;
  return foreground[0]?.command;
}

async function resumeCommandForSurface(
  workspaceRef: string,
  surfaceRef: string,
): Promise<string | undefined> {
  try {
    const data = await runJSON<{
      resume_binding?: { shell_command?: string; argv?: string[] } | null;
    }>(["surface", "resume", "get", "--workspace", workspaceRef, "--surface", surfaceRef]);
    const binding = data.resume_binding;
    if (!binding) return undefined;
    if (binding.shell_command?.trim()) return binding.shell_command.trim();
    if (binding.argv?.length) return binding.argv.join(" ");
  } catch {
    return undefined;
  }
  return undefined;
}

async function commandForTerminalSurface(
  workspaceRef: string,
  surfaceRef: string,
  tty?: string | null,
): Promise<string | undefined> {
  const resume = await resumeCommandForSurface(workspaceRef, surfaceRef);
  if (resume) return resume;
  if (!tty) return undefined;
  return foregroundCommandForTty(tty);
}

function panelToSurface(panel: SessionPanel): SurfaceSpec {
  const title = surfaceDisplayTitle(panel.title, panel.customTitle);
  if (panel.type === "browser") {
    const profileID = panel.browser?.profileID?.trim();
    return {
      type: "browser",
      url: panel.browser?.urlString ?? "about:blank",
      ...(title ? { title } : {}),
      ...(profileID ? { profileID } : {}),
    };
  }
  return {
    type: "terminal",
    cwd: panel.directory ?? panel.terminal?.workingDirectory,
    ...(title ? { title } : {}),
  };
}

function collectPaneNodes(layout: LayoutNode): PaneSpec[] {
  if ("pane" in layout) return [layout.pane];
  return layout.children.flatMap(collectPaneNodes);
}

function paneNameFromTree(pane: TreePane): string | undefined {
  const name = (pane.name ?? pane.title)?.trim();
  return name || undefined;
}

function applyTreeMetadata(layout: LayoutNode, treePanes: TreePane[]): LayoutNode {
  const paneNodes = collectPaneNodes(layout);
  for (let i = 0; i < paneNodes.length && i < treePanes.length; i += 1) {
    const paneNode = paneNodes[i]!;
    const treePane = treePanes[i]!;
    const paneName = paneNameFromTree(treePane);
    if (paneName) paneNode.name = paneName;
    for (let s = 0; s < paneNode.surfaces.length && s < treePane.surfaces.length; s += 1) {
      const treeTitle = treePane.surfaces[s]!.title?.trim();
      if (treeTitle) paneNode.surfaces[s]!.title = treeTitle;
    }
  }
  return layout;
}

function applyBrowserProfilesFromSession(layout: LayoutNode, workspaceId: string): LayoutNode {
  const sessionWs = readSessionWorkspaces().find((w) => w.workspaceId === workspaceId);
  if (!sessionWs) return layout;

  const profileByUrl = new Map<string, string>();
  for (const panel of sessionWs.panels) {
    if (panel.type !== "browser") continue;
    const url = panel.browser?.urlString?.trim();
    const profileId = panel.browser?.profileID?.trim();
    if (url && profileId) profileByUrl.set(url, profileId);
  }

  if (profileByUrl.size === 0) return layout;

  for (const pane of collectPaneNodes(layout)) {
    for (const surface of pane.surfaces) {
      if (surface.type !== "browser" || browserProfileId(surface)) continue;
      const url = surface.url?.trim();
      if (!url) continue;
      const profileID = profileByUrl.get(url);
      if (profileID) surface.profileID = profileID;
    }
  }
  return layout;
}

async function applyTerminalCommands(
  layout: LayoutNode,
  workspaceRef: string,
  treePanes: TreePane[],
): Promise<LayoutNode> {
  const paneNodes = collectPaneNodes(layout);
  for (let i = 0; i < paneNodes.length && i < treePanes.length; i += 1) {
    const paneNode = paneNodes[i]!;
    const treePane = treePanes[i]!;
    for (let s = 0; s < paneNode.surfaces.length && s < treePane.surfaces.length; s += 1) {
      const surface = paneNode.surfaces[s]!;
      const treeSurface = treePane.surfaces[s]!;
      if (surface.type !== "terminal") continue;
      const command = await commandForTerminalSurface(
        workspaceRef,
        treeSurface.ref ?? "",
        treeSurface.tty,
      );
      if (command) surface.command = command;
    }
  }
  return layout;
}

function surfacesFromTreePane(pane: TreePane): SurfaceSpec[] {
  return pane.surfaces.map((surface) => {
    const title = surface.title?.trim();
    if (surface.type === "browser") {
      return { type: "browser" as const, url: surface.url ?? "about:blank", ...(title ? { title } : {}) };
    }
    return { type: "terminal" as const, ...(title ? { title } : {}) };
  });
}

function paneSpecFromTree(pane: TreePane): PaneSpec {
  const name = paneNameFromTree(pane);
  const surfaces = surfacesFromTreePane(pane);
  return name ? { name, surfaces } : { surfaces };
}

function sessionLayoutToCmuxLayout(
  layout: SessionLayout,
  panelsById: Map<string, SessionPanel>,
): LayoutNode {
  if (layout.type === "pane") {
    const surfaces = layout.pane.panelIds.map((id) => {
      const panel = panelsById.get(id);
      return panel ? panelToSurface(panel) : { type: "terminal" as const };
    });
    return { pane: { surfaces } };
  }
  const { orientation, dividerPosition, first, second } = layout.split;
  return {
    direction: orientation,
    split: dividerPosition,
    children: [
      sessionLayoutToCmuxLayout(first, panelsById),
      sessionLayoutToCmuxLayout(second, panelsById),
    ],
  };
}

function treePanesToLayout(panes: TreePane[]): LayoutNode {
  if (panes.length === 0) throw new Error("workspace has no panes to save");
  if (panes.length === 1) return { pane: paneSpecFromTree(panes[0]!) };

  let node: LayoutNode = { pane: paneSpecFromTree(panes[panes.length - 1]!) };
  for (let i = panes.length - 2; i >= 0; i -= 1) {
    node = {
      direction: "horizontal",
      split: 0.5,
      children: [{ pane: paneSpecFromTree(panes[i]!) }, node],
    };
  }
  return node;
}

function layoutFromSession(workspaceId: string, tree: TreeWorkspace): LayoutNode | null {
  const sessionWs = readSessionWorkspaces().find((w) => w.workspaceId === workspaceId);
  if (!sessionWs) return null;
  const panelsById = new Map(sessionWs.panels.map((p) => [p.id, p]));
  try {
    return applyTreeMetadata(sessionLayoutToCmuxLayout(sessionWs.layout, panelsById), tree.panes);
  } catch {
    return treePanesToLayout(tree.panes);
  }
}

async function saveWorkspace(query: string | undefined, outPath?: string): Promise<string> {
  await runCmd(["ping"]);
  const ws = await resolveWorkspace(query);
  const tree = await getTreeWorkspace(ws.ref);
  const layout = await applyTerminalCommands(
    applyBrowserProfilesFromSession(
      applyTreeMetadata(
        (ws.id ? layoutFromSession(ws.id, tree) : null) ?? treePanesToLayout(tree.panes),
        tree.panes,
      ),
      ws.id ?? "",
    ),
    ws.ref,
    tree.panes,
  );

  const saved: SavedWorkspace = {
    version: 1,
    savedAt: new Date().toISOString(),
    title: ws.title,
    cwd: ws.current_directory,
    description: ws.description ?? null,
    layout,
    source: { workspaceRef: ws.ref, workspaceId: ws.id },
  };

  const target = outPath ? resolve(outPath) : defaultSavePath(ws.title);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, `${JSON.stringify(normalizeSavedWorkspace(saved), null, 2)}\n`, "utf8");
  return target;
}

function renameSaved(input: string, newSlug?: string, newTitle?: string): string {
  const { path, data } = readSaved(input);
  let targetPath = path;

  if (newSlug) {
    const slug = slugify(newSlug);
    if (!slug) throw new Error("new name must contain at least one letter or number");
    targetPath = join(DEFAULT_DIR, `${slug}.json`);
    if (targetPath !== path && existsSync(targetPath)) {
      throw new Error(`saved workspace already exists: ${targetPath}`);
    }
  }

  if (newTitle) data.title = newTitle;

  if (targetPath === path && !newTitle) {
    throw new Error("rename requires a new name and/or --name");
  }

  writeSaved(targetPath, data);
  if (targetPath !== path) unlinkSync(path);
  return targetPath;
}

function deleteSaved(input: string): string {
  const { path } = readSaved(input);
  unlinkSync(path);
  return path;
}

async function applySavedSurfaceTitles(workspaceRef: string, layout: LayoutNode): Promise<void> {
  const tree = await getTreeWorkspace(workspaceRef);
  const paneNodes = collectPaneNodes(layout);

  for (let i = 0; i < paneNodes.length && i < tree.panes.length; i += 1) {
    const savedSurfaces = paneNodes[i]!.surfaces;
    const liveSurfaces = tree.panes[i]!.surfaces;
    for (let s = 0; s < savedSurfaces.length && s < liveSurfaces.length; s += 1) {
      const wantTitle = savedSurfaces[s]!.title?.trim();
      if (!wantTitle) continue;
      const live = liveSurfaces[s]!;
      if (live.title?.trim() === wantTitle) continue;
      if (!live.ref) continue;
      await runCmd([
        "tab-action",
        "--workspace", workspaceRef,
        "--surface", live.ref,
        "--action", "rename",
        "--title", wantTitle,
      ]);
    }
  }
}

async function loadWorkspace(input: string, nameOverride?: string): Promise<string> {
  await runCmd(["ping"]);
  const { path, data: saved } = readSaved(input);
  const title = nameOverride ?? saved.title;

  const callerData = await runJSON<{ caller?: { surface_ref?: string } }>(["identify"]).catch(() => null);
  const callerSurface = callerData?.caller?.surface_ref;

  const createArgs = [
    "workspace", "create",
    "--name", title,
    "--cwd", saved.cwd,
    "--layout", JSON.stringify(saved.layout),
    "--focus", "true",
  ];
  if (saved.description) createArgs.push("--description", saved.description);

  const created = await runJSON<{ workspace_ref?: string }>(createArgs);
  const workspaceRef = created.workspace_ref;
  if (!workspaceRef) throw new Error("workspace create returned unexpected response");

  await applySavedSurfaceTitles(workspaceRef, saved.layout);

  if (callerSurface) {
    await runCmd(["close-surface", "--surface", callerSurface]);
  }

  return `OK loaded ${title} as ${workspaceRef} from ${basename(path)}`;
}

function listSaved(): Array<{ name: string; path: string; title: string; savedAt: string }> {
  if (!existsSync(DEFAULT_DIR)) return [];
  return readdirSync(DEFAULT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const path = join(DEFAULT_DIR, f);
      const data = JSON.parse(readFileSync(path, "utf8")) as SavedWorkspace;
      return { name: f.replace(/\.json$/, ""), path, title: data.title, savedAt: data.savedAt };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

function parseFlags(argv: string[]): {
  flags: { workspace?: string; out?: string; name?: string; focus: boolean };
  positional: string[];
} {
  const flags: { workspace?: string; out?: string; name?: string; focus: boolean } = {
    focus: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--workspace" || arg === "-w") {
      flags.workspace = argv[++i]!;
    } else if (arg === "--out" || arg === "-o") {
      flags.out = argv[++i]!;
    } else if (arg === "--name" || arg === "-n") {
      flags.name = argv[++i]!;
    } else if (arg === "--focus") {
      flags.focus = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

export async function runWorkspaceCommand(command: string, argv: string[]): Promise<void> {
  const { flags, positional } = parseFlags(argv);

  switch (command) {
    case "save": {
      const path = await saveWorkspace(flags.workspace ?? positional[0], flags.out);
      console.log(`saved ${path}`);
      break;
    }
    case "load": {
      const input = positional[0] ?? flags.name;
      if (!input) throw new Error("load requires a saved file or name");
      const result = await loadWorkspace(input, flags.name);
      console.log(result);
      break;
    }
    case "rename": {
      const input = positional[0];
      if (!input) throw new Error("rename requires a saved workspace name");
      const path = renameSaved(input, positional[1], flags.name);
      console.log(`renamed ${path}`);
      break;
    }
    case "delete":
    case "rm": {
      const input = positional[0];
      if (!input) throw new Error("delete requires a saved workspace name");
      const path = deleteSaved(input);
      console.log(`deleted ${path}`);
      break;
    }
    case "list": {
      const items = listSaved();
      if (items.length === 0) {
        console.log(`no saved workspaces in ${DEFAULT_DIR}`);
        break;
      }
      for (const item of items) {
        console.log(`${item.name}\t${item.title}\t${item.savedAt}\t${item.path}`);
      }
      break;
    }
    default:
      throw new Error(`unknown workspace command: ${command}`);
  }
}
