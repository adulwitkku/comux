// A pi-style raw-mode TUI: boxed multiline editor + palettes + list pickers. No dependencies.
//
// Frame per input cycle (the whole frame is the redraw region, cleared on every keypress):
//
//   ╭──────────────────────────────────────────────╮
//   │ › first line of the message                  │
//   │   second line (alt+⏎) or a soft-wrapped one  │
//   ╰──────────────────────────────────────────────╯
//     <status: cwd (branch) · ctx · model · ⚡ TPS>
//     → /plan   show PLAN.md     ← palette: "/" commands, "@" files, command args
//       /ws     show workspace
//     (1/4)
//
// Keys: ⏎ submit · alt+⏎ newline · ↑↓ palette / cursor / history · ⇥ complete ·
// ctrl+a/e line start/end · ctrl+u/k/w kill · alt+←→ word jump · esc clear.
// Multi-line paste arrives via bracketed paste (so a pasted \n does not submit).
// Cursor math is Thai-aware (combining marks are zero-width). Submitted inputs
// persist as JSONL at `historyPath` and are recalled with ↑ from the top row.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { c } from "./ui.ts";
import { VERSION } from "./version.ts";

export interface Item {
  name: string;
  desc: string;
}

const COMBINING = /[ัิ-ฺ็-๎]/;
const HISTORY_MAX = 1000;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

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

export interface VisualRow {
  /** Buffer index of the row's first character. */
  start: number;
  text: string;
}

export interface BufferLayout {
  rows: VisualRow[];
  curRow: number;
  curCol: number;
}

/** Soft-wrap `buf` (logical lines split on \n) into visual rows of `textW` columns and
 *  locate the cursor within them (pure; Thai combining marks are zero-width). */
export function layoutBuffer(buf: string, cur: number, textW: number): BufferLayout {
  const rows: VisualRow[] = [];
  let rowStart = 0;
  let rowText = "";
  let rowW = 0;
  let curRow = 0;
  let curCol = 0;
  let located = false;
  const pushRow = () => rows.push({ start: rowStart, text: rowText });
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i]!;
    if (ch === "\n") {
      if (i === cur) { curRow = rows.length; curCol = rowW; located = true; }
      pushRow();
      rowStart = i + 1; rowText = ""; rowW = 0;
      continue;
    }
    const w = COMBINING.test(ch) ? 0 : 1;
    if (rowW + w > textW) {
      pushRow();
      rowStart = i; rowText = ""; rowW = 0;
    }
    if (i === cur) { curRow = rows.length; curCol = rowW; located = true; }
    rowText += ch; rowW += w;
  }
  if (!located) { curRow = rows.length; curCol = rowW; }
  pushRow();
  return { rows, curRow, curCol };
}

/** Buffer index of visual position (`row`, `col`) within `rows` (pure). */
export function indexAt(buf: string, rows: VisualRow[], row: number, col: number): number {
  const r = rows[Math.max(0, Math.min(row, rows.length - 1))]!;
  let i = r.start;
  let w = 0;
  for (const ch of r.text) {
    const cw = COMBINING.test(ch) ? 0 : 1;
    if (w + cw > col) break;
    i++; w += cw;
  }
  return i;
}

export interface Frame {
  text: string;
  /** Screen row of the cursor, 0-based from the frame top. */
  cursorRow: number;
  cursorCol: number;
  totalRows: number;
}

const PROMPT = c.cyan(c.bold("› "));

/** Build the full redraw string for one frame: box, status line, palette (pure, testable). */
export function buildFrame(
  lay: BufferLayout,
  statusLine: string,
  palette: string[],
  width: number,
): Frame {
  const textW = width - 6; // "│ " + 2-col prompt + " │"
  const top = c.gray("╭" + "─".repeat(width - 2) + "╮");
  const bot = c.gray("╰" + "─".repeat(width - 2) + "╯");
  const bar = c.gray("│");
  const rows = lay.rows.map((r, i) => {
    const prefix = i === 0 ? PROMPT : "  ";
    const pad = " ".repeat(Math.max(0, textW - visibleWidth(r.text)));
    return `${bar} ${prefix}${r.text}${pad} ${bar}`;
  });
  const lines = [top, ...rows, bot, statusLine, ...palette];
  return {
    text: lines.join("\n"),
    cursorRow: 1 + lay.curRow,
    cursorCol: 4 + lay.curCol,
    totalRows: lines.length,
  };
}

/** Split raw stdin data into key tokens: whole escape sequences, single control chars,
 *  and runs of printable text. Typed input arrives one key per chunk, but pasted or piped
 *  input arrives many keys per chunk — without this a stray \r would be inserted literally. */
export function tokenizeKeys(data: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i]!;
    if (ch === "\x1b") {
      if (data[i + 1] === "[") {
        let j = i + 2;
        while (j < data.length && !/[A-Za-z~]/.test(data[j]!)) j++;
        out.push(data.slice(i, Math.min(j + 1, data.length)));
        i = j + 1;
      } else if (i + 1 < data.length) {
        out.push(data.slice(i, i + 2)); // alt+<key>, incl. \x1b\r and \x1bb/\x1bf
        i += 2;
      } else {
        out.push("\x1b");
        i++;
      }
    } else if (ch === "\x7f" || ch.charCodeAt(0) < 32) {
      out.push(ch);
      i++;
    } else {
      let j = i;
      while (j < data.length && data[j] !== "\x1b" && data[j] !== "\x7f" && data[j]!.charCodeAt(0) >= 32) j++;
      out.push(data.slice(i, j));
      i = j;
    }
  }
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

// Some PTYs report columns as 0/undefined — clamp so box math never goes negative.
const frameWidth = () => Math.max(20, Math.min(process.stdout.columns || 60, 80));

export interface PickRow<T = unknown> {
  label: string;
  detail?: string;
  /** Shown as [x]/[ ] when the picker has `toggle`. */
  enabled?: boolean;
  value: T;
}

export interface PickListOpts {
  toggle?: boolean;
  reorder?: boolean;
  rename?: boolean;
}

export interface TuiOptions {
  commands: Item[];
  /** Returns the status-bar text drawn under the input box each cycle. */
  status: () => string;
  /** Returns relative file paths for `@` mentions. */
  listFiles?: () => string[];
  /** Argument completion for a slash command (wired to the command registry). */
  completeArg?: (cmd: string, query: string) => Item[];
  /** JSONL file persisting submitted inputs across sessions (↑ recall). */
  historyPath?: string;
}

export class Tui {
  private readonly commands: Item[];
  private readonly status: () => string;
  private readonly listFiles?: () => string[];
  private readonly completeArg?: (cmd: string, query: string) => Item[];
  private readonly historyPath?: string;
  private historyCache: string[] | null = null;

  constructor(opts: TuiOptions) {
    this.commands = opts.commands;
    this.status = opts.status;
    this.listFiles = opts.listFiles;
    this.completeArg = opts.completeArg;
    this.historyPath = opts.historyPath;
  }

  print(s: string): void {
    process.stdout.write(s + "\n");
  }

  printHeader(): void {
    this.print(c.magenta(c.bold("◆ comux")) + c.gray(`  v${VERSION}`));
    this.print(
      c.gray("ctrl+c/ctrl+d exit · ") +
        c.gray("/") + c.gray(" commands · ") +
        c.gray("@") + c.gray(" files · alt+⏎ newline · ↑↓ select/history · ⏎ run · type to chat"),
    );
    this.print("");
  }

  private loadHistory(): string[] {
    if (this.historyCache) return this.historyCache;
    let entries: string[] = [];
    if (this.historyPath && existsSync(this.historyPath)) {
      try {
        entries = readFileSync(this.historyPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            try { return JSON.parse(l) as unknown; } catch { return l; }
          })
          .filter((e): e is string => typeof e === "string" && e.length > 0);
      } catch { /* an unreadable history file is not fatal */ }
    }
    this.historyCache = entries;
    return entries;
  }

  private appendHistory(text: string): void {
    if (!this.historyPath) return;
    const h = this.loadHistory();
    if (h[h.length - 1] === text) return; // skip consecutive duplicates
    h.push(text);
    try {
      if (h.length > HISTORY_MAX + 200) {
        this.historyCache = h.slice(-HISTORY_MAX);
        writeFileSync(this.historyPath, this.historyCache.map((e) => JSON.stringify(e)).join("\n") + "\n");
      } else {
        appendFileSync(this.historyPath, JSON.stringify(text) + "\n");
      }
    } catch { /* best-effort */ }
  }

  /** Read one message. Resolves with the text, or null on ctrl+c / ctrl+d. */
  readLine(): Promise<string | null> {
    return new Promise((resolve) => {
      const stdin = process.stdin;
      let buf = "";
      let cur = 0;
      let sel = 0;
      let first = true;
      let lastCursorRow = 0;
      let files: string[] | null = null;
      let histIdx: number | null = null;
      let draft = "";
      let pasting = false;
      let pasteBuf = "";
      let done = false;
      const statusLine = "  " + this.status();
      const textW = () => frameWidth() - 6;

      const commandMode = () => buf.startsWith("/") && !/\s/.test(buf);
      const argMode = (): { cmd: string; query: string } | null => {
        if (!this.completeArg || buf.includes("\n")) return null;
        const m = /^(\/\S+) (.*)$/.exec(buf);
        return m ? { cmd: m[1]!, query: m[2]! } : null;
      };
      const mentionMode = () => !commandMode() && activeMention(buf, cur) !== null;

      const items = (): Item[] => {
        if (commandMode()) return this.commands.filter((cmd) => cmd.name.startsWith(buf));
        const am = argMode();
        if (am) return this.completeArg!(am.cmd, am.query);
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
        const frame = buildFrame(
          layoutBuffer(buf, cur, textW()),
          statusLine,
          formatPalette(list, sel),
          frameWidth(),
        );
        let out = !first && lastCursorRow > 0 ? `\x1b[${lastCursorRow}A` : "";
        out += "\r\x1b[J" + frame.text;
        const up = frame.totalRows - 1 - frame.cursorRow;
        if (up > 0) out += `\x1b[${up}A`;
        out += "\r";
        if (frame.cursorCol > 0) out += `\x1b[${frame.cursorCol}C`;
        process.stdout.write(out);
        lastCursorRow = frame.cursorRow;
        first = false;
      };

      const teardown = () => {
        process.stdout.write("\x1b[?2004l"); // bracketed paste off
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        stdin.pause();
      };

      const finish = (val: string | null) => {
        done = true;
        // Replace the frame with a compact transcript of what was submitted.
        let out = lastCursorRow > 0 ? `\x1b[${lastCursorRow}A` : "";
        out += "\r\x1b[J";
        const logical = buf.split("\n");
        out += PROMPT + (logical[0] ?? "") + "\n";
        for (const l of logical.slice(1)) out += "  " + l + "\n";
        process.stdout.write(out);
        teardown();
        if (val && val.trim()) this.appendHistory(val);
        resolve(val);
      };

      const insertText = (text: string) => {
        buf = buf.slice(0, cur) + text + buf.slice(cur);
        cur += text.length;
        sel = 0;
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

      const lineStart = () => (cur === 0 ? 0 : buf.lastIndexOf("\n", cur - 1) + 1);
      const lineEnd = () => {
        const e = buf.indexOf("\n", cur);
        return e === -1 ? buf.length : e;
      };
      const wordLeft = () => {
        let i = cur;
        while (i > 0 && /\s/.test(buf[i - 1]!)) i--;
        while (i > 0 && !/\s/.test(buf[i - 1]!)) i--;
        return i;
      };
      const wordRight = () => {
        let i = cur;
        while (i < buf.length && /\s/.test(buf[i]!)) i++;
        while (i < buf.length && !/\s/.test(buf[i]!)) i++;
        return i;
      };

      /** Move the cursor one visual row up/down; false at the buffer edge (→ history). */
      const moveVert = (dir: -1 | 1): boolean => {
        const lay = layoutBuffer(buf, cur, textW());
        const target = lay.curRow + dir;
        if (target < 0 || target >= lay.rows.length) return false;
        cur = indexAt(buf, lay.rows, target, lay.curCol);
        return true;
      };

      const recall = (text: string) => {
        buf = text;
        cur = buf.length;
        sel = 0;
      };
      const historyPrev = () => {
        const h = this.loadHistory();
        if (!h.length) return;
        if (histIdx === null) { draft = buf; histIdx = h.length; }
        if (histIdx === 0) return;
        histIdx--;
        recall(h[histIdx]!);
      };
      const historyNext = () => {
        if (histIdx === null) return;
        const h = this.loadHistory();
        histIdx++;
        if (histIdx >= h.length) { histIdx = null; recall(draft); }
        else recall(h[histIdx]!);
      };

      const handleKeys = (s: string) => {
        if (s === "\x03" || s === "\x04") return finish(null); // ctrl+c / ctrl+d
        if (s === "\r" || s === "\n") {
          if (commandMode()) {
            const m = items()[sel];
            if (m) return finish(m.name);
          }
          const am = argMode();
          if (am && items().length) {
            const selItem = items()[sel];
            if (selItem) return finish(`${am.cmd} ${selItem.name}`);
          }
          if (mentionMode() && items().length) {
            insertMention();
            return render();
          }
          return finish(buf);
        }
        if (s === "\x1b\r" || s === "\x1b\n") {
          insertText("\n"); // alt+⏎
        } else if (s === "\t") {
          if (commandMode()) {
            const m = items()[sel];
            if (m) { buf = m.name; cur = buf.length; }
          } else if (argMode() && items().length) {
            const am = argMode()!;
            const selItem = items()[sel];
            if (selItem) { buf = `${am.cmd} ${selItem.name}`; cur = buf.length; }
          } else if (mentionMode()) {
            insertMention();
          }
        } else if (s === "\x7f" || s === "\x08") {
          if (cur > 0) { buf = buf.slice(0, cur - 1) + buf.slice(cur); cur--; sel = 0; }
        } else if (s === "\x1b\x7f" || s === "\x17") { // alt+⌫ / ctrl+w
          const w = wordLeft();
          buf = buf.slice(0, w) + buf.slice(cur); cur = w; sel = 0;
        } else if (s === "\x01" || s === "\x1b[H") {
          cur = lineStart();
        } else if (s === "\x05" || s === "\x1b[F") {
          cur = lineEnd();
        } else if (s === "\x15") { // ctrl+u: kill to line start
          const ls = lineStart();
          buf = buf.slice(0, ls) + buf.slice(cur); cur = ls; sel = 0;
        } else if (s === "\x0b") { // ctrl+k: kill to line end
          buf = buf.slice(0, cur) + buf.slice(lineEnd()); sel = 0;
        } else if (s === "\x1b[3~") { // forward delete
          if (cur < buf.length) { buf = buf.slice(0, cur) + buf.slice(cur + 1); sel = 0; }
        } else if (s === "\x1b[A") {
          const n = items().length;
          if (n) sel = (sel - 1 + n) % n;
          else if (!moveVert(-1)) historyPrev();
        } else if (s === "\x1b[B") {
          const n = items().length;
          if (n) sel = (sel + 1) % n;
          else if (!moveVert(1)) historyNext();
        } else if (s === "\x1b[C") {
          if (cur < buf.length) cur++;
        } else if (s === "\x1b[D") {
          if (cur > 0) cur--;
        } else if (s === "\x1b[1;3D" || s === "\x1bb") {
          cur = wordLeft();
        } else if (s === "\x1b[1;3C" || s === "\x1bf") {
          cur = wordRight();
        } else if (s === "\x1b") {
          buf = ""; cur = 0; sel = 0; histIdx = null;
        } else if (s.startsWith("\x1b")) {
          return; // unhandled escape
        } else if (s.length >= 1 && s.charCodeAt(0) >= 32) {
          insertText(s);
        } else {
          return;
        }
        render();
      };

      const onData = (s: string) => {
        // Bracketed paste: accumulate between the markers, then insert verbatim (with \n).
        let data = s;
        while (data) {
          if (pasting) {
            const end = data.indexOf(PASTE_END);
            if (end === -1) { pasteBuf += data; data = ""; }
            else {
              pasteBuf += data.slice(0, end);
              const clean = pasteBuf
                .replace(/\r\n?/g, "\n")
                .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
              insertText(clean);
              pasteBuf = ""; pasting = false;
              data = data.slice(end + PASTE_END.length);
              render();
            }
          } else {
            const st = data.indexOf(PASTE_START);
            const plain = st === -1 ? data : data.slice(0, st);
            for (const key of tokenizeKeys(plain)) {
              if (done) return;
              handleKeys(key);
            }
            if (st === -1) data = "";
            else {
              pasting = true;
              data = data.slice(st + PASTE_START.length);
            }
          }
          if (done) return;
        }
      };

      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
      process.stdout.write("\n\x1b[?2004h"); // bracketed paste on
      render();
    });
  }

  /**
   * Interactive list picker: ↑↓ move · space toggle (opts.toggle) · K/J reorder (opts.reorder)
   * · r rename (opts.rename) · ⏎ save · esc cancel. Resolves the edited rows, or null on cancel.
   */
  pickList<T>(title: string, rows: PickRow<T>[], opts: PickListOpts = {}): Promise<PickRow<T>[] | null> {
    return new Promise((resolve) => {
      const stdin = process.stdin;
      const work = rows.map((r) => ({ ...r }));
      let sel = 0;
      let prevLines = 0;
      let renaming = false;
      let nameBuf = "";

      const hintParts = ["↑↓ move"];
      if (opts.toggle) hintParts.push("space toggle");
      if (opts.reorder) hintParts.push("K/J reorder");
      if (opts.rename) hintParts.push("r rename");
      hintParts.push("⏎ save", "esc cancel");
      const hint = c.gray("  " + hintParts.join(" · "));

      const paint = () => {
        const lines: string[] = [c.bold("  " + title)];
        work.forEach((r, i) => {
          const marker = i === sel ? c.cyan("→ ") : "  ";
          const box = opts.toggle ? (r.enabled ? c.green("[x] ") : c.gray("[ ] ")) : "";
          const label = i === sel ? c.cyan(c.bold(r.label)) : r.label;
          const detail = r.detail ? "  " + c.gray(r.detail) : "";
          lines.push(`  ${marker}${box}${label}${detail}`);
        });
        lines.push(hint);
        if (renaming) lines.push(c.yellow("  new name: ") + nameBuf);
        let out = prevLines > 0 ? `\x1b[${prevLines}A\r\x1b[J` : "";
        out += lines.join("\n") + "\n";
        process.stdout.write(out);
        prevLines = lines.length;
      };

      const cleanup = (result: PickRow<T>[] | null) => {
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        stdin.pause();
        process.stdout.write("\x1b[?25h");
        resolve(result);
      };

      const onData = (data: string) => {
        for (const s of tokenizeKeys(data)) if (handleKey(s)) return;
      };

      // Returns true once the picker has resolved (stop processing queued keys).
      const handleKey = (s: string): boolean => {
        if (renaming) {
          if (s === "\x03") { cleanup(null); return true; }
          if (s === "\r" || s === "\n") {
            if (nameBuf.trim()) work[sel]!.label = nameBuf.trim();
            renaming = false; nameBuf = "";
          } else if (s === "\x1b") { renaming = false; nameBuf = ""; }
          else if (s === "\x7f" || s === "\x08") nameBuf = nameBuf.slice(0, -1);
          else if (s.charCodeAt(0) >= 32) nameBuf += s;
          paint();
          return false;
        }
        if (s === "\x03" || s === "\x04" || s === "\x1b") { cleanup(null); return true; }
        if (s === "\r" || s === "\n") { cleanup(work); return true; }
        if (s === "\x1b[A") sel = (sel - 1 + work.length) % work.length;
        else if (s === "\x1b[B") sel = (sel + 1) % work.length;
        else if (s === " " && opts.toggle) work[sel]!.enabled = !work[sel]!.enabled;
        else if ((s === "K" || s === "\x1b[1;3A") && opts.reorder && sel > 0) {
          [work[sel - 1], work[sel]] = [work[sel]!, work[sel - 1]!];
          sel--;
        } else if ((s === "J" || s === "\x1b[1;3B") && opts.reorder && sel < work.length - 1) {
          [work[sel + 1], work[sel]] = [work[sel]!, work[sel + 1]!];
          sel++;
        } else if (s === "r" && opts.rename) {
          renaming = true; nameBuf = "";
        } else return false;
        paint();
        return false;
      };

      process.stdout.write("\x1b[?25l");
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
      paint();
    });
  }

  /** Single-select picker (↑↓ / 1–9 / ⏎ pick / esc cancel). Resolves the index, or null. */
  pickOne(title: string, items: Item[], initial = 0): Promise<number | null> {
    return new Promise((resolve) => {
      const stdin = process.stdin;
      let sel = Math.max(0, Math.min(initial, items.length - 1));
      let prevLines = 0;
      const hint = c.gray(`  ↑↓ move · 1–${Math.min(items.length, 9)} pick · ⏎ pick · esc cancel`);

      const paint = () => {
        const lines: string[] = [c.bold("  " + title)];
        items.forEach((it, i) => {
          const marker = i === sel ? c.cyan("→ ") : "  ";
          const name = i === sel ? c.cyan(c.bold(it.name)) : it.name;
          const desc = it.desc ? "  " + c.gray(it.desc) : "";
          lines.push(`  ${marker}${name}${desc}`);
        });
        lines.push(hint);
        let out = prevLines > 0 ? `\x1b[${prevLines}A\r\x1b[J` : "";
        out += lines.join("\n") + "\n";
        process.stdout.write(out);
        prevLines = lines.length;
      };

      const cleanup = (result: number | null) => {
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        stdin.pause();
        process.stdout.write("\x1b[?25h");
        resolve(result);
      };

      const onData = (data: string) => {
        for (const s of tokenizeKeys(data)) if (handleKey(s)) return;
      };

      // Returns true once the picker has resolved (stop processing queued keys).
      const handleKey = (s: string): boolean => {
        if (s === "\x03" || s === "\x04" || s === "\x1b") { cleanup(null); return true; }
        if (s === "\r" || s === "\n") { cleanup(sel); return true; }
        const n = Number(s);
        if (Number.isInteger(n) && n >= 1 && n <= Math.min(items.length, 9)) { cleanup(n - 1); return true; }
        if (s === "\x1b[A") sel = (sel - 1 + items.length) % items.length;
        else if (s === "\x1b[B") sel = (sel + 1) % items.length;
        else return false;
        paint();
        return false;
      };

      process.stdout.write("\x1b[?25l");
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
      paint();
    });
  }

  /**
   * Present a multiple-choice question and read one selection (Grilling, ADR-0016/0019).
   * Option 0 is the recommended/default — Enter (or esc) selects it. Resolves the chosen index.
   */
  async choose(question: string, options: string[]): Promise<number> {
    const items = options.map((o, i) => ({ name: o, desc: i === 0 ? "(recommended)" : "" }));
    const i = await this.pickOne(c.yellow(question), items);
    return i ?? 0;
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
