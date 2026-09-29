import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ReviewScope } from "./review-scope.js";
import {
  isActiveReviewState,
  reviewFrameIntervalMs,
  reviewStatusLines,
  reviewSummaryLines,
  WAITING_FRAME_INTERVAL_MS,
  type ReviewDisplayState,
  type ReviewLinePalette,
  type ReviewSummaryCounts,
} from "./widget-status.js";

const WIDGET_KEY = "auto-permissions";

export interface ReviewDisplay {
  show(scope: ReviewScope, state: ReviewDisplayState, detail?: string, autoClear?: boolean): void;
  clear(scope: ReviewScope): void;
  shutdown(ctx: ExtensionContext): void;
}

interface Row {
  scope: ReviewScope;
  state: ReviewDisplayState;
  detail?: string;
}

function rowKey(scope: ReviewScope): string {
  return scope.target.toolCallId ?? `command:${scope.command}`;
}

function reviewerLabel(scope: ReviewScope): string {
  const { ctx, config } = scope;
  return config.reviewer
    ? `${config.reviewer.provider}/${config.reviewer.model}`
    : ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : "active model";
}

/**
 * Where reviews announce themselves: the above-editor widget.
 *
 * Several guarded commands can be under review at once, so the display keeps
 * one row per unsettled command. One row renders exactly as a lone review
 * always has; several collapse into a single summary line. A settled result
 * is shown only once nothing is left unsettled, and a new review replaces it.
 *
 * Owns both widget timers — the animation interval and the auto-clear
 * timeout — because a timer outliving its widget animates or clears something
 * nobody can see.
 */
export function createReviewDisplay(deps: { isSessionActive: () => boolean }): ReviewDisplay {
  const active = new Map<string, Row>();
  let settled: Row | undefined;
  let clearWidgetTimer: ReturnType<typeof setTimeout> | undefined;
  let widgetAnimTimer: ReturnType<typeof setInterval> | undefined;

  function stopAnimation(): void {
    if (widgetAnimTimer) clearInterval(widgetAnimTimer);
    widgetAnimTimer = undefined;
  }

  function stopClearTimer(): void {
    if (clearWidgetTimer) clearTimeout(clearWidgetTimer);
    clearWidgetTimer = undefined;
  }

  function visible(scope: ReviewScope): boolean {
    return deps.isSessionActive() && scope.ctx.mode === "tui" && scope.config.ui.enabled;
  }

  function render(ctx: ExtensionContext): void {
    stopAnimation();
    if (ctx.mode !== "tui") return;
    const rows = [...active.values()];
    const shown = rows.length === 1 ? rows[0] : rows.length === 0 ? settled : undefined;
    if (rows.length === 0 && !settled) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const latest = rows.at(-1) ?? settled!;
    const reviewer = reviewerLabel(latest.scope);
    const counts: ReviewSummaryCounts = { waiting: 0, queued: 0, askUser: 0 };
    for (const row of rows) {
      if (row.state === "waiting") counts.waiting += 1;
      else if (row.state === "queued") counts.queued += 1;
      else if (row.state === "ask_user") counts.askUser += 1;
    }
    const intervalMs = shown
      ? reviewFrameIntervalMs(shown.state)
      : counts.waiting > 0 ? WAITING_FRAME_INTERVAL_MS : undefined;

    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      const palette: ReviewLinePalette = {
        header: (text) => theme.fg("accent", theme.bold(text)),
        muted: (text) => theme.fg("muted", text),
        warning: (text) => theme.fg("warning", text),
        success: (text) => theme.fg("success", text),
        accent: (text) => theme.fg("accent", text),
        error: (text) => theme.fg("error", text),
      };
      let frameIndex = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      const stopTimer = () => {
        if (timer) clearInterval(timer);
        if (widgetAnimTimer === timer) widgetAnimTimer = undefined;
        timer = undefined;
      };
      if (intervalMs !== undefined) {
        timer = setInterval(() => {
          frameIndex++;
          tui.requestRender();
        }, intervalMs);
        timer.unref?.();
        widgetAnimTimer = timer;
      }
      return {
        render(width: number): string[] {
          const lines = shown
            ? reviewStatusLines(shown.state, shown.scope.gate.label, reviewer, frameIndex, shown.detail, palette)
            : reviewSummaryLines(counts, reviewer, frameIndex, palette);
          return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
        },
        invalidate() {},
        dispose() {
          stopTimer();
        },
      };
    }, { placement: "aboveEditor" });
  }

  function reset(ctx: ExtensionContext): void {
    active.clear();
    settled = undefined;
    stopClearTimer();
    stopAnimation();
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  return {
    show(scope: ReviewScope, state: ReviewDisplayState, detail?: string, autoClear = false): void {
      if (!visible(scope)) return;
      const key = rowKey(scope);
      stopClearTimer();
      if (isActiveReviewState(state)) {
        active.set(key, { scope, state, detail });
        settled = undefined;
      } else {
        active.delete(key);
        const row: Row = { scope, state, detail };
        settled = row;
        if (autoClear) {
          clearWidgetTimer = setTimeout(() => {
            clearWidgetTimer = undefined;
            if (!deps.isSessionActive() || settled !== row) return;
            settled = undefined;
            render(scope.ctx);
          }, scope.config.ui.resultDisplayMs);
          clearWidgetTimer.unref?.();
        }
      }
      render(scope.ctx);
    },

    clear(scope: ReviewScope): void {
      const key = rowKey(scope);
      const wasShown = active.delete(key) || (settled !== undefined && rowKey(settled.scope) === key);
      if (settled && rowKey(settled.scope) === key) {
        settled = undefined;
        stopClearTimer();
      }
      if (wasShown || (active.size === 0 && !settled)) render(scope.ctx);
    },

    shutdown(ctx: ExtensionContext): void {
      reset(ctx);
    },
  };
}
