// A small raw-mode line editor with a pi-style command palette. No dependencies.
//
// Layout per input cycle:
//   <dim rule>
//   <status bar: cwd (branch) · ctx · model · ⚡ TPS>
//   › <buffer>
//     → /plan   show PLAN.md         ← palette dropdown, only when the line starts with "/"
//       /ws     show workspace
//     (1/4)
//
// The status line is drawn once above the input; the input line + palette below it are the
// redraw region (cleared with \r\x1b[J on every keypress). Cursor math is Thai-aware: Thai
// combining marks are zero-width.

import { c } from "./ui.ts";

export interface Command {
  name: string;
  desc: string;
}

const COMBINING = /[ัิ-ฺ็-๎]/;

/** Visible column width of a string, treating Thai combining marks as zero-width. */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of s) if (!COMBINING.test(ch)) w++;
  return w;
}

export interface PaletteView {
  lines: string[]; // formatted dropdown rows + counter, already coloured
  matches: Command[];
}

/** Build the dropdown rows for the current buffer + selection (pure, testable). */
export function formatPalette(commands: Command[], buf: string, sel: number): PaletteView {
  const matches = commands.filter((cmd) => cmd.name.startsWith(buf));
  if (!matches.length) return { lines: [], matches };
  const width = Math.max(...matches.map((m) => m.name.length));
  const lines = matches.map((m, i) => {
    const selected = i === sel;
    const marker = selected ? c.cyan("→ ") : "  ";
    const name = selected ? c.cyan(c.bold(m.name)) : m.name;
    const pad = " ".repeat(width - m.name.length + 2);
    return `  ${marker}${name}${pad}${c.gray(m.desc)}`;
  });
  lines.push(`  ${c.gray(`(${sel + 1}/${matches.length})`)}`);
  return { lines, matches };
}

/**
 * Build the full redraw string for one frame (pure, testable).
 * `promptW` is the visible width of `prompt`. Returns bytes to write to the terminal.
 */
export function buildFrame(
  prompt: string,
  promptW: number,
  buf: string,
  cur: number,
  palette: string[],
): string {
  let out = "\r\x1b[J"; // col 0 of input line, clear to end of screen
  out += prompt + buf;
  for (const l of palette) out += "\n" + l;
  if (palette.length) out += `\x1b[${palette.length}A`; // back up to the input line
  out += "\r";
  const col = promptW + visibleWidth(buf.slice(0, cur));
  if (col > 0) out += `\x1b[${col}C`;
  return out;
}

const PROMPT = c.cyan(c.bold("› "));
const PROMPT_W = 2;

export interface TuiOptions {
  commands: Command[];
  /** Returns the status-bar text drawn above the input each cycle. */
  status: () => string;
}

export class Tui {
  private readonly commands: Command[];
  private readonly status: () => string;

  constructor(opts: TuiOptions) {
    this.commands = opts.commands;
    this.status = opts.status;
  }

  print(s: string): void {
    process.stdout.write(s + "\n");
  }

  printHeader(): void {
    const cols = process.stdout.columns ?? 60;
    this.print(c.gray("─".repeat(Math.min(cols, 72))));
    this.print(c.magenta(c.bold("◆ cmux harness")) + c.gray("  v0.0.1"));
    this.print(
      c.gray("ctrl+c/ctrl+d exit · ") + c.gray("/") + c.gray(" commands (↑↓ select, ⏎ run) · type to chat"),
    );
    this.print("");
  }

  /** Read one line. Resolves with the text, or null on ctrl+c / ctrl+d. */
  readLine(): Promise<string | null> {
    return new Promise((resolve) => {
      const stdin = process.stdin;
      let buf = "";
      let cur = 0;
      let sel = 0;

      // status line above the input (drawn once; not part of the redraw region)
      process.stdout.write("\n" + this.status() + "\n");

      const paletteActive = () => buf.startsWith("/") && !buf.includes(" ");

      const render = () => {
        let view: string[] = [];
        if (paletteActive()) {
          const total = this.commands.filter((cmd) => cmd.name.startsWith(buf)).length;
          if (sel >= total) sel = Math.max(0, total - 1);
          view = formatPalette(this.commands, buf, sel).lines;
        }
        process.stdout.write(buildFrame(PROMPT, PROMPT_W, buf, cur, view));
      };

      const teardown = () => {
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        stdin.pause();
      };

      const submit = (val: string) => {
        process.stdout.write("\r\x1b[J" + PROMPT + buf + "\n");
        teardown();
        resolve(val);
      };

      const onData = (s: string) => {
        // control keys
        if (s === "\x03" || s === "\x04") { // ctrl+c / ctrl+d
          process.stdout.write("\r\x1b[J" + PROMPT + buf + "\n");
          teardown();
          resolve(null);
          return;
        }
        if (s === "\r" || s === "\n") {
          if (paletteActive()) {
            const m = formatPalette(this.commands, buf, sel).matches[sel];
            if (m) return submit(m.name);
          }
          return submit(buf);
        }
        if (s === "\t") {
          if (paletteActive()) {
            const m = formatPalette(this.commands, buf, sel).matches[sel];
            if (m) { buf = m.name; cur = buf.length; }
          }
        } else if (s === "\x7f" || s === "\x08") { // backspace
          if (cur > 0) { buf = buf.slice(0, cur - 1) + buf.slice(cur); cur--; }
        } else if (s === "\x1b[A") { // up
          if (paletteActive()) { const n = formatPalette(this.commands, buf, sel).matches.length; if (n) sel = (sel - 1 + n) % n; }
        } else if (s === "\x1b[B") { // down
          if (paletteActive()) { const n = formatPalette(this.commands, buf, sel).matches.length; if (n) sel = (sel + 1) % n; }
        } else if (s === "\x1b[C") { // right
          if (cur < buf.length) cur++;
        } else if (s === "\x1b[D") { // left
          if (cur > 0) cur--;
        } else if (s === "\x1b") { // bare esc: clear the line
          buf = ""; cur = 0; sel = 0;
        } else if (s.startsWith("\x1b")) {
          // unhandled escape sequence — ignore
        } else if (s.length >= 1 && s.charCodeAt(0) >= 32) {
          buf = buf.slice(0, cur) + s + buf.slice(cur); cur += s.length; sel = 0;
        } else {
          return; // other control char, ignore (no re-render needed)
        }
        render();
      };

      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
      render();
    });
  }

  /** Read a single y/n keypress. */
  confirm(question: string): Promise<boolean> {
    return new Promise((resolve) => {
      const stdin = process.stdin;
      process.stdout.write(c.yellow("  " + question + " ") + c.gray("[Y/n] "));
      const onData = (s: string) => {
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        stdin.pause();
        process.stdout.write("\n");
        const ch = s.toLowerCase();
        resolve(s === "\r" || s === "\n" || ch === "y");
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
    });
  }
}
