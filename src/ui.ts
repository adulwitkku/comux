// Tiny ANSI styling helper — no dependencies. Colour is disabled when NO_COLOR is set or
// stdout is not a TTY (e.g. piped), so output stays clean in tests and logs.

const enabled = !process.env.NO_COLOR && Boolean(process.stdout.isTTY);

const wrap = (open: number, close: number) => (s: string) =>
  enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const c = {
  reset: "\x1b[0m",
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

/** Common semantic line styles used across the TUI. */
export const ui = {
  prompt: () => c.cyan(c.bold("› ")),
  user: (s: string) => c.cyan(s),
  reply: (s: string) => `${c.green("●")} ${s}`,
  dispatch: (task: string) => `${c.yellow("⟶")} ${c.dim("dispatch:")} ${c.yellow(task)}`,
  running: (s: string) => c.dim(`  ${s}`),
  ok: (s: string) => c.green(`  ✓ ${s}`),
  warn: (s: string) => c.red(`  ⚠ ${s}`),
  hint: (s: string) => c.gray(s),
  banner: (title: string) => c.magenta(c.bold(title)),
};
