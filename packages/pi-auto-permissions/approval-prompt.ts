import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { OptionSelector, SelectorTheme } from "@hank-warren/pi-permission-selector/selector.ts";

/** What an approval prompt shows, top to bottom above the options. */
export interface ApprovalPromptContent {
  header: string;
  command: string;
  /** Who wrote `note`: "Guardian", or "Review failed" for an infrastructure error. */
  noteLabel: string;
  note: string;
  /**
   * True when the transcript shows this exact command (a model-issued call).
   * A call a codemode script built shows only the script there.
   */
  inTranscript: boolean;
}

export interface ApprovalPromptTheme extends SelectorTheme {
  bold(text: string): string;
  /** Pi 1.x themes report the background they are designed for. */
  readonly appearance?: string;
}

/** The slice of pi-tui's mouse event this reads; older pi-tui releases do not export the type. */
export interface WheelEvent {
  type: string;
  wheelDelta?: number;
}

const MIN_PREVIEW_ROWS = 3;
/** Rows left for the rest of Pi's input dock when the full command is open. */
const RESERVED_ROWS = 6;
const MIN_VIEWER_ROWS = 3;
/** The note's height while the viewer is open, so a long note cannot crowd the command out. */
const VIEWER_NOTE_ROWS = 2;

// Fixed rather than the theme's `warning`, which some themes make green or dim:
// the approval note must read as a caution in every theme.
const NOTE_YELLOW_DARK = "\x1b[38;2;255;215;0m";
const NOTE_YELLOW_LIGHT = "\x1b[38;2;184;134;11m";
const FG_RESET = "\x1b[39m";

export function noteYellow(theme: Pick<ApprovalPromptTheme, "appearance">): (text: string) => string {
  const color = theme.appearance === "light" ? NOTE_YELLOW_LIGHT : NOTE_YELLOW_DARK;
  return (text) => `${color}${text}${FG_RESET}`;
}

/** Plain-text form for hosts that render the title themselves (RPC `ui.select`). */
export function approvalPromptText(content: Omit<ApprovalPromptContent, "inTranscript">): string {
  return `${content.header}\n\n${content.command}\n\n${content.noteLabel}: ${content.note}`;
}

function wrapBlock(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) lines.push("");
    else lines.push(...wrapTextWithAnsi(line, width));
  }
  return lines;
}

/**
 * The approval dialog: header, the command, the reviewer's note, then the
 * options. It stays compact so the session transcript above keeps its room: a
 * long command is cut to a preview. Ctrl+O opens the full command in a
 * scrolling viewer inside the dialog, because the transcript does not always
 * hold it (a codemode script's calls show only the script).
 */
export class ApprovalPrompt {
  private expanded = false;
  private scrollTop = 0;
  private maxScroll = 0;
  private viewportRows = 0;

  constructor(
    private readonly opts: {
      content: ApprovalPromptContent;
      selector: OptionSelector;
      theme: ApprovalPromptTheme;
      terminalRows: () => number;
      requestRender: () => void;
    },
  ) {}

  invalidate(): void {
    this.opts.selector.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("o"))) {
      this.expanded = !this.expanded;
      this.scrollTop = 0;
      this.opts.requestRender();
      return;
    }
    if (this.expanded) {
      const page = Math.max(1, this.viewportRows - 1);
      if (matchesKey(data, Key.pageUp)) return this.scrollBy(-page);
      if (matchesKey(data, Key.pageDown)) return this.scrollBy(page);
      if (matchesKey(data, Key.shift("up"))) return this.scrollBy(-1);
      if (matchesKey(data, Key.shift("down"))) return this.scrollBy(1);
    }
    this.opts.selector.handleInput(data);
  }

  /** Scrolls the open viewer; otherwise the wheel falls through to the session. */
  handleMouse(event: WheelEvent): { handled: true } | undefined {
    if (!this.expanded || event.type !== "wheel" || !event.wheelDelta || this.maxScroll === 0) return undefined;
    this.scrollBy(event.wheelDelta);
    return { handled: true };
  }

  private scrollBy(lines: number): void {
    const next = Math.max(0, Math.min(this.maxScroll, this.scrollTop + lines));
    if (next === this.scrollTop) return;
    this.scrollTop = next;
    this.opts.requestRender();
  }

  private noteLines(width: number): string[] {
    const { theme, content } = this.opts;
    const yellow = noteYellow(theme);
    const text = `${theme.bold(`${content.noteLabel}:`)} ${content.note}`;
    const inner = Math.max(1, width - 2);
    let lines = wrapBlock(text, inner);
    if (this.expanded && lines.length > VIEWER_NOTE_ROWS) {
      lines = lines.slice(0, VIEWER_NOTE_ROWS);
      // Reflow the last kept row so the ellipsis always fits.
      lines[VIEWER_NOTE_ROWS - 1] = truncateToWidth(`${lines[VIEWER_NOTE_ROWS - 1]} …`, inner, "…");
    }
    return lines.map((line) => `${yellow("▌ ")}${yellow(line)}`);
  }

  private preview(command: string[], width: number): string[] {
    const { theme, content } = this.opts;
    this.maxScroll = 0;
    const cap = Math.max(MIN_PREVIEW_ROWS, Math.floor(this.opts.terminalRows() / 4));
    if (command.length <= cap) return command;
    const shown = cap - 1;
    const where = content.inTranscript ? "ctrl+o view all, or scroll the session above" : "ctrl+o view all";
    const more = `… ${command.length - shown} more lines · ${where}`;
    return [...command.slice(0, shown), theme.fg("dim", truncateToWidth(more, width))];
  }

  private viewer(command: string[], width: number, fixedRows: number): string[] {
    const budget = Math.max(MIN_PREVIEW_ROWS + fixedRows, this.opts.terminalRows() - RESERVED_ROWS);
    // One row goes to the status line.
    this.viewportRows = Math.max(MIN_VIEWER_ROWS, budget - fixedRows - 1);
    this.maxScroll = Math.max(0, command.length - this.viewportRows);
    this.scrollTop = Math.min(this.scrollTop, this.maxScroll);
    const last = Math.min(command.length, this.scrollTop + this.viewportRows);
    const status = `── lines ${this.scrollTop + 1}-${last} of ${command.length} · shift+↑↓/wheel scroll · ctrl+o collapse ──`;
    return [...command.slice(this.scrollTop, last), this.opts.theme.fg("dim", truncateToWidth(status, width))];
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    const { theme, content } = this.opts;
    const header = wrapBlock(`${noteYellow(theme)(theme.bold("●"))} ${content.header}`, w);
    const note = this.noteLines(w);
    const options = this.opts.selector.render(w);
    const command = wrapBlock(content.command, w);
    const fixedRows = header.length + 1 + 1 + note.length + 1 + options.length;
    const commandRows = this.expanded ? this.viewer(command, w, fixedRows) : this.preview(command, w);
    const lines = [...header, "", ...commandRows, "", ...note, "", ...options];
    // A dock too short for the dialog clips from the top, keeping the options
    // visible: Pi's layout scrolls a clipped component to its cursor line.
    lines[lines.length - 1] = `${CURSOR_MARKER}${lines[lines.length - 1]}`;
    return lines;
  }
}
