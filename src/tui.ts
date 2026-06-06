// A small raw-mode line editor with pi-style palettes. No dependencies.
//
// Layout per input cycle:
//   <status bar: cwd (branch) · ctx · model · ⚡ TPS>
//   ───────────────────────────────────────────────   ← top rule (frames the chat block)
//   › <buffer>
//   ───────────────────────────────────────────────   ← bottom rule
//     → /plan   show PLAN.md          ← palette: "/" lists commands, "@" lists files
//       /ws     show workspace
//     (1/4)
//
// The status line is drawn once above the block; the framed input + palette are the redraw
// region (cleared on every keypress). Cursor math is Thai-aware (combining marks are
// zero-width).

import { c } from "./ui.ts";

export interface Item {
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

/** Build dropdown rows for pre-filtered `items` + selection, windowed to `maxRows` (pure). */
export function formatPalette(items: Item[], sel: number, maxRows = 8): string[] {
  if (!items.length) return [];
  const total = items.length;
  let start = 0;
  if (total > maxRows) start = Math.min(Math.max(0, sel - (maxRows >> 1)), total - maxRows);
  const win = items.slice(start, start + maxRows);
  const width = Math.max(...win.map((i) => i.name.length));
  const lines = win.map((it, idx) => {
    const selected = start + idx === sel;
    const marker = selected ? c.cyan("→ ") : "  ";
    const name = selected ? c.cyan(c.bold(it.name)) : it.name;
    const pad = " ".repeat(width - it.name.length + 2);
    return `  ${marker}${name}${pad}${c.gray(it.desc)}`;
  });
  lines.push(`  ${c.gray(`(${sel + 1}/${total})`)}`);
  return lines;
}

/** Build the full redraw string for one frame (pure, testable). */
export function buildFrame(
  prompt: string,
  promptW: number,
  buf: string,
  cur: number,
  palette: string[],
  ruleWidth: number,
  firstRender: boolean,
): string {
  const rule = c.gray("─".repeat(ruleWidth));
  let out = firstRender ? "" : "\x1b[1A"; // up to the top rule (anchor) on redraws
  out += "\r\x1b[J";
  out += rule + "\n";
  out += prompt + buf + "\n";
  out += rule;
  for (const l of palette) out += "\n" + l;
  out += `\x1b[${1 + palette.length}A\r`; // back up to the input line
  const col = promptW + visibleWidth(buf.slice(0, cur));
  if (col > 0) out += `\x1b[${col}C`;
  return out;
}

/** The active `@file` mention left of the cursor, if any. */
export function activeMention(buf: string, cur: number): { at: number; query: string } | null {
  const left = buf.slice(0, cur);
  const at = left.lastIndexOf("@");
  if (at === -1) return null;
  const token = left.slice(at + 1);
  if (/\s/.test(token)) return null;
  return { at, query: token };
}

const PROMPT = c.cyan(c.bold("› "));
const PROMPT_W = 2;
const ruleWidth = () => Math.min(process.stdout.columns ?? 60, 80);

export interface TuiOptions {
  commands: Item[];
  /** Returns the status-bar text drawn above the block each cycle. */
  status: () => string;
  /** Returns relative file paths for `@` mentions. */
  listFiles?: () => string[];
}

export class Tui {
  private readonly commands: Item[];
  private readonly status: () => string;
  private readonly listFiles?: () => string[];

  constructor(opts: TuiOptions) {
    this.commands = opts.commands;
    this.status = opts.status;
    this.listFiles = opts.listFiles;
  }

  print(s: string): void {
    process.stdout.write(s + "\n");
  }

  printHeader(): void {
    this.print(c.magenta(c.bold("◆ cmux harness")) + c.gray("  v0.0.1"));
    this.print(
      c.gray("ctrl+c/ctrl+d exit · ") +
        c.gray("/") + c.gray(" commands · ") +
        c.gray("@") + c.gray(" files · ↑↓ select · ⏎ run · type to chat"),
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
      let first = true;
      let files: string[] | null = null;

      process.stdout.write("\n" + this.status() + "\n");

      const commandMode = () => buf.startsWith("/") && !buf.includes(" ");
      const mentionMode = () => !commandMode() && activeMention(buf, cur) !== null;

      const items = (): Item[] => {
        if (commandMode()) return this.commands.filter((cmd) => cmd.name.startsWith(buf));
        const m = activeMention(buf, cur);
        if (m && this.listFiles) {
          if (!files) files = this.listFiles();
          const q = m.query.toLowerCase();
          return files
            .filter((f) => f.toLowerCase().includes(q))
            .slice(0, 200)
            .map((f) => ({ name: f, desc: "" }));
        }
        return [];
      };

      const render = () => {
        const list = items();
        if (sel >= list.length) sel = Math.max(0, list.length - 1);
        process.stdout.write(
          buildFrame(PROMPT, PROMPT_W, buf, cur, formatPalette(list, sel), ruleWidth(), first),
        );
        first = false;
      };

      const teardown = () => {
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        stdin.pause();
      };

      const finish = (val: string | null) => {
        process.stdout.write(`\x1b[1A\r\x1b[J${c.gray("─".repeat(ruleWidth()))}\n${PROMPT}${buf}\n`);
        teardown();
        resolve(val);
      };

      const insertMention = () => {
        const list = items();
        const selItem = list[sel];
        const m = activeMention(buf, cur);
        if (!m || !selItem) return;
        const file = selItem.name;
        buf = buf.slice(0, m.at) + "@" + file + " " + buf.slice(cur);
        cur = m.at + file.length + 2;
        sel = 0;
      };

      const onData = (s: string) => {
        if (s === "\x03" || s === "\x04") return finish(null); // ctrl+c / ctrl+d
        if (s === "\r" || s === "\n") {
          if (commandMode()) {
            const m = items()[sel];
            if (m) return finish(m.name);
          }
          if (mentionMode() && items().length) {
            insertMention();
            return render();
          }
          return finish(buf);
        }
        if (s === "\t") {
          if (commandMode()) {
            const m = items()[sel];
            if (m) { buf = m.name; cur = buf.length; }
          } else if (mentionMode()) {
            insertMention();
          }
        } else if (s === "\x7f" || s === "\x08") {
          if (cur > 0) { buf = buf.slice(0, cur - 1) + buf.slice(cur); cur--; sel = 0; }
        } else if (s === "\x1b[A") {
          const n = items().length; if (n) sel = (sel - 1 + n) % n;
        } else if (s === "\x1b[B") {
          const n = items().length; if (n) sel = (sel + 1) % n;
        } else if (s === "\x1b[C") {
          if (cur < buf.length) cur++;
        } else if (s === "\x1b[D") {
          if (cur > 0) cur--;
        } else if (s === "\x1b") {
          buf = ""; cur = 0; sel = 0;
        } else if (s.startsWith("\x1b")) {
          return; // unhandled escape
        } else if (s.length >= 1 && s.charCodeAt(0) >= 32) {
          buf = buf.slice(0, cur) + s + buf.slice(cur); cur += s.length; sel = 0;
        } else {
          return;
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
