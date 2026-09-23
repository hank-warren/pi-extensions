/**
 * Pure helpers for the above-editor review status widget: single-line status
 * formatting plus frame progression for the waiting sparkle spinner. Kept
 * free of TUI dependencies so they are unit-testable.
 */

export type ReviewDisplayState =
  | "queued"
  | "waiting"
  | "approved"
  | "revise"
  | "ask_user"
  | "blocked";

type ReviewStatusTone = "muted" | "warning" | "success" | "accent" | "error";

interface ReviewStatusFrame {
  glyph: string;
  label: string;
  tone: ReviewStatusTone;
}

export const WAITING_FRAMES = ["✶", "✸", "✻", "✽"] as const;
export const WAITING_FRAME_INTERVAL_MS = 300;

export function reviewStatusFrame(
  state: ReviewDisplayState,
  reviewer: string,
  frameIndex: number,
): ReviewStatusFrame {
  const index = Math.max(0, Math.floor(frameIndex));
  switch (state) {
    // Static rather than animated: the row is replaced by `waiting` the moment
    // the queue hands over, so a spinner here would promise progress the
    // command is not making. It exists so a second guarded command in one turn
    // renders *something* instead of a blank gap while it waits its turn.
    case "queued":
      return {
        glyph: "⋯",
        label: "queued behind another review",
        tone: "muted",
      };
    case "waiting":
      return {
        glyph: WAITING_FRAMES[index % WAITING_FRAMES.length],
        label: `waiting for ${reviewer}`,
        tone: "warning",
      };
    case "approved":
      return { glyph: "✓", label: "approved", tone: "success" };
    case "revise":
      return { glyph: "↻", label: "revision requested", tone: "warning" };
    case "ask_user":
      return { glyph: "?", label: "waiting for your approval", tone: "accent" };
    case "blocked":
      return { glyph: "✗", label: "blocked", tone: "error" };
  }
}

export function reviewFrameIntervalMs(state: ReviewDisplayState): number | undefined {
  return state === "waiting" ? WAITING_FRAME_INTERVAL_MS : undefined;
}

export interface ReviewLinePalette {
  header: (text: string) => string;
  muted: (text: string) => string;
  warning: (text: string) => string;
  success: (text: string) => string;
  accent: (text: string) => string;
  error: (text: string) => string;
}

/**
 * Render the widget content: one status line, plus a dim detail line only
 * when a guardian reason is present. The command is intentionally omitted —
 * it is already visible in the bash tool box above.
 */
export function reviewStatusLines(
  state: ReviewDisplayState,
  gateLabel: string,
  reviewer: string,
  frameIndex: number,
  detail: string | undefined,
  palette: ReviewLinePalette,
): string[] {
  const frame = reviewStatusFrame(state, reviewer, frameIndex);
  const status = palette[frame.tone](`${frame.glyph} ${frame.label}`);
  const lines = [
    `${palette.header("auto permissions")} ${palette.muted(`· ${gateLabel} ·`)} ${status}`,
  ];
  if (detail) lines.push(palette.muted(detail));
  return lines;
}
