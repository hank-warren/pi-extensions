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
    // Static rather than animated: the row is replaced the moment the command
    // gets its slot, so a spinner here would promise progress the command is
    // not making. It exists so a guarded command waiting for a review slot or
    // for another command's decision renders *something* instead of a blank gap.
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

/** The states a review is still in while it has not settled. */
export type ActiveReviewState = Extract<ReviewDisplayState, "queued" | "waiting" | "ask_user">;

export function isActiveReviewState(state: ReviewDisplayState): state is ActiveReviewState {
  return state === "queued" || state === "waiting" || state === "ask_user";
}

export interface ReviewSummaryCounts {
  waiting: number;
  queued: number;
  askUser: number;
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
 * Render the widget content: one status line, plus a detail line behind a
 * `▌` bar in the outcome's tone (the approval dialog's note style) only when
 * a reason is present. The command is intentionally omitted —
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
  if (detail) lines.push(`${palette[frame.tone]("▌")} ${palette.muted(detail)}`);
  return lines;
}

/**
 * One line for several unsettled reviews at once. Per-command detail is left
 * out: each command is visible in its own tool box, and an approval prompt
 * carries its own reason.
 */
export function reviewSummaryLines(
  counts: ReviewSummaryCounts,
  reviewer: string,
  frameIndex: number,
  palette: ReviewLinePalette,
): string[] {
  const total = counts.waiting + counts.queued + counts.askUser;
  const parts: string[] = [];
  if (counts.waiting > 0) {
    const frame = reviewStatusFrame("waiting", reviewer, frameIndex);
    parts.push(palette.warning(`${frame.glyph} ${counts.waiting} ${frame.label}`));
  }
  if (counts.queued > 0) parts.push(palette.muted(`⋯ ${counts.queued} queued`));
  if (counts.askUser > 0) parts.push(palette.accent(`? ${counts.askUser} waiting for your approval`));
  return [
    `${palette.header("auto permissions")} ${palette.muted(`· ${total} commands ·`)} ${parts.join(palette.muted(" · "))}`,
  ];
}
