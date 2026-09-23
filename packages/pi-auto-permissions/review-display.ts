import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ReviewScope } from "./review-scope.js";
import {
  reviewFrameIntervalMs,
  reviewStatusLines,
  type ReviewDisplayState,
  type ReviewLinePalette,
} from "./widget-status.js";

const WIDGET_KEY = "auto-permissions";

export interface ReviewDisplay {
  show(scope: ReviewScope, state: ReviewDisplayState, detail?: string, autoClear?: boolean): void;
  clear(scope: ReviewScope): void;
  shutdown(ctx: ExtensionContext): void;
}

/**
 * Where a review announces itself: the above-editor widget.
 *
 * Owns both widget timers — the animation interval and the auto-clear
 * timeout — because a timer outliving its widget animates or clears something
 * nobody can see.
 */
export function createReviewDisplay(deps: { isSessionActive: () => boolean }): ReviewDisplay {
  let clearWidgetTimer: ReturnType<typeof setTimeout> | undefined;
  let widgetAnimTimer: ReturnType<typeof setInterval> | undefined;

  function stopWidgetTimers(): void {
    if (clearWidgetTimer) clearTimeout(clearWidgetTimer);
    clearWidgetTimer = undefined;
    if (widgetAnimTimer) clearInterval(widgetAnimTimer);
    widgetAnimTimer = undefined;
  }

  function clearReviewWidget(ctx: ExtensionContext): void {
    stopWidgetTimers();
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  return {
    show(scope: ReviewScope, state: ReviewDisplayState, detail?: string, autoClear = false): void {
      const { ctx, config, gate } = scope;
      if (!deps.isSessionActive() || ctx.mode !== "tui" || !config.ui.enabled) return;
      const reviewer = config.reviewer
        ? `${config.reviewer.provider}/${config.reviewer.model}`
        : ctx.model
          ? `${ctx.model.provider}/${ctx.model.id}`
          : "active model";

      stopWidgetTimers();
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
        const intervalMs = reviewFrameIntervalMs(state);
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
            return reviewStatusLines(state, gate.label, reviewer, frameIndex, detail, palette)
              .map((line) => truncateToWidth(line, Math.max(1, width)));
          },
          invalidate() {},
          dispose() {
            stopTimer();
          },
        };
      }, { placement: "aboveEditor" });

      if (autoClear) {
        clearWidgetTimer = setTimeout(() => {
          if (deps.isSessionActive()) clearReviewWidget(ctx);
        }, config.ui.resultDisplayMs);
        clearWidgetTimer.unref?.();
      }
    },

    clear(scope: ReviewScope): void {
      clearReviewWidget(scope.ctx);
    },

    shutdown(ctx: ExtensionContext): void {
      clearReviewWidget(ctx);
    },
  };
}
