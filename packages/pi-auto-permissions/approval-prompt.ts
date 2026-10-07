import { CURSOR_MARKER, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { OptionSelector, SelectorTheme } from "@hank-warren/pi-permission-selector/selector.ts";

/** What an approval prompt shows, top to bottom above the options. */
export interface ApprovalPromptContent {
  header: string;
  command: string;
  /** Who wrote `note`: "Guardian", or "Review failed" for an infrastructure error. */
  noteLabel: string;
  note: string;
}

export interface ApprovalPromptTheme extends SelectorTheme {
  bold(text: string): string;
  /** Pi 1.x themes report the background they are designed for. */
  readonly appearance?: string;
}

const MIN_PREVIEW_ROWS = 3;

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
export function approvalPromptText(content: ApprovalPromptContent): string {
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
 * The approval dialog: header, a command preview, the reviewer's note, then
 * the options. It stays compact so the session transcript above keeps its
 * room: a long command is cut to a preview, and the full tool call is read by
 * scrolling the session, which the dialog never intercepts.
 */
export class ApprovalPrompt {
  constructor(
    private readonly opts: {
      content: ApprovalPromptContent;
      selector: OptionSelector;
      theme: ApprovalPromptTheme;
      terminalRows: () => number;
    },
  ) {}

  invalidate(): void {
    this.opts.selector.invalidate();
  }

  handleInput(data: string): void {
    this.opts.selector.handleInput(data);
  }

  private noteLines(width: number): string[] {
    const { theme, content } = this.opts;
    const yellow = noteYellow(theme);
    const text = `${theme.bold(`${content.noteLabel}:`)} ${content.note}`;
    return wrapBlock(text, Math.max(1, width - 2)).map((line) => `${yellow("▌ ")}${yellow(line)}`);
  }

  private commandLines(width: number): string[] {
    const { theme, content } = this.opts;
    const command = wrapBlock(content.command, width);
    const cap = Math.max(MIN_PREVIEW_ROWS, Math.floor(this.opts.terminalRows() / 4));
    if (command.length <= cap) return command;
    const shown = cap - 1;
    const more = `… ${command.length - shown} more lines · full command is in the session above`;
    return [...command.slice(0, shown), theme.fg("dim", truncateToWidth(more, width))];
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    const { theme, content } = this.opts;
    const header = wrapBlock(`${noteYellow(theme)(theme.bold("●"))} ${content.header}`, w);
    const lines = [
      ...header,
      "",
      ...this.commandLines(w),
      "",
      ...this.noteLines(w),
      "",
      ...this.opts.selector.render(w),
    ];
    // A dock too short for the dialog clips from the top, keeping the options
    // visible: Pi's layout scrolls a clipped component to its cursor line.
    lines[lines.length - 1] = `${CURSOR_MARKER}${lines[lines.length - 1]}`;
    return lines;
  }
}
