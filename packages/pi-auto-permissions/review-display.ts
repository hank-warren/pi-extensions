import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Gate } from "./gates.js";
import type { ReviewScope, ReviewTarget } from "./review-scope.js";
import {
  reviewFrameIntervalMs,
  reviewStatusFrame,
  reviewStatusLines,
  type ReviewDisplayState,
  type ReviewLinePalette,
} from "./widget-status.js";

/** The subset of Pi's tool-render theme the review status line uses. */
interface RowTheme {
  fg(role: string, text: string): string;
}

const WIDGET_KEY = "auto-permissions";
const PROJECT_CONFIG_DIR_NAME = (PiCodingAgent as { CONFIG_DIR_NAME?: string }).CONFIG_DIR_NAME ?? ".pi";

type ReviewRow = {
  gate: Gate;
  state: ReviewDisplayState;
  reviewer: string;
  detail?: string;
};

/**
 * The status line for one review row.
 *
 * The tool row words the states that describe *this* call in its own terms
 * ("guardian running" where the widget says "waiting for <model>"), because
 * the row already sits under the command it belongs to. `queued` is the one
 * state that describes the queue rather than the call, so it reuses the
 * widget's frame verbatim rather than restating it — two placements
 * disagreeing about what "queued" says is exactly what sharing this prevents.
 */
function rowStatus(review: ReviewRow, theme: RowTheme): string {
  if (review.state === "queued") {
    const frame = reviewStatusFrame(review.state, review.reviewer, 0);
    return theme.fg(frame.tone, `${frame.glyph} ${frame.label}`);
  }
  return review.state === "waiting"
    ? theme.fg("warning", "◌ guardian running")
    : review.state === "approved"
      ? theme.fg("success", "✓ approved")
      : review.state === "revise"
        ? theme.fg("warning", "↻ revision requested")
        : review.state === "ask_user"
          ? theme.fg("accent", "? approval required")
          : theme.fg("error", "✗ blocked");
}

export interface ReviewDisplay {
  /**
   * Take over the `bash` tool so review status renders inside its call row
   * instead of above the editor. Only for `ui.placement: "toolRow"`.
   */
  registerGuardedBash(ctx: ExtensionContext): void;
  show(scope: ReviewScope, state: ReviewDisplayState, detail?: string, autoClear?: boolean): void;
  clear(scope: ReviewScope): void;
  shutdown(ctx: ExtensionContext): void;
}

function loadNativeBashOptions(cwd: string, projectTrusted: boolean): { commandPrefix?: string; shellPath?: string } {
  const readSettings = (path: string): Record<string, unknown> => {
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch {
      return {};
    }
  };
  const getAgentDir = (PiCodingAgent as { getAgentDir?: () => string }).getAgentDir;
  const global = getAgentDir ? readSettings(join(getAgentDir(), "settings.json")) : {};
  const project = projectTrusted ? readSettings(join(cwd, PROJECT_CONFIG_DIR_NAME, "settings.json")) : {};
  const setting = (name: string): string | undefined => {
    const value = project[name] ?? global[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  return { commandPrefix: setting("shellCommandPrefix"), shellPath: setting("shellPath") };
}

/**
 * Where a review announces itself: the bash tool row when this extension owns
 * the renderer, and the above-editor widget otherwise.
 *
 * Owns the rows, their invalidators, and both widget timers, because every one
 * of them is only meaningful next to the others — a row without its
 * invalidator never repaints, and a widget timer outliving its widget animates
 * something nobody can see.
 */
export function createReviewDisplay(
  pi: ExtensionAPI,
  deps: { isSessionActive: () => boolean },
): ReviewDisplay {
  const reviewRows = new Map<string, ReviewRow>();
  const reviewRowInvalidators = new Map<string, () => void>();
  let bashRendererRegistered = false;
  let bashRendererSourcePath: string | undefined;
  let clearWidgetTimer: ReturnType<typeof setTimeout> | undefined;
  let widgetAnimTimer: ReturnType<typeof setInterval> | undefined;

  function ownsBashRenderer(): boolean {
    if (!bashRendererRegistered) return false;
    const current = pi.getAllTools().find((tool) => tool.name === "bash");
    return bashRendererSourcePath === undefined || current?.sourceInfo.path === bashRendererSourcePath;
  }

  function clearReviewWidget(ctx: ExtensionContext): void {
    if (clearWidgetTimer) clearTimeout(clearWidgetTimer);
    clearWidgetTimer = undefined;
    if (widgetAnimTimer) clearInterval(widgetAnimTimer);
    widgetAnimTimer = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  function rowTarget(target: ReviewTarget): string | undefined {
    return target.toolName === "bash" && target.toolCallId && ownsBashRenderer()
      ? target.toolCallId
      : undefined;
  }

  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== "bash") return;
    if (!reviewRows.has(event.toolCallId)) reviewRowInvalidators.delete(event.toolCallId);
  });

  return {
    registerGuardedBash(ctx: ExtensionContext): void {
      if (bashRendererRegistered) return;
      const existing = pi.getAllTools().find((tool) => tool.name === "bash");
      if (existing && existing.sourceInfo.source !== "builtin") {
        ctx.ui.notify("Auto Permissions kept the existing non-native bash backend; review status will use the editor widget.", "warning");
        return;
      }

      const createBashToolDefinition = (PiCodingAgent as {
        createBashToolDefinition?: (cwd: string, options?: { commandPrefix?: string; shellPath?: string }) => any;
      }).createBashToolDefinition;
      if (!createBashToolDefinition) return;
      const native = createBashToolDefinition(
        ctx.cwd,
        loadNativeBashOptions(ctx.cwd, ctx.isProjectTrusted()),
      );
      const nativeRenderCall = native.renderCall;
      const { renderResult: _nativeResultRenderer, ...nativeWithoutResultRenderer } = native;

      pi.registerTool({
        ...nativeWithoutResultRenderer,
        renderCall(args: unknown, theme: any, context: any) {
          const state = context.state as Record<string, unknown>;
          const base = nativeRenderCall(args, theme, {
            ...context,
            lastComponent: state.autoPermissionsBaseCallComponent,
          });
          state.autoPermissionsBaseCallComponent = base;
          reviewRowInvalidators.set(context.toolCallId, context.invalidate);

          const container = new Container();
          container.addChild(base);
          const review = reviewRows.get(context.toolCallId);
          if (review) {
            const status = rowStatus(review, theme);
            const suffix = review.state === "waiting"
              ? ` · ${review.gate.label} · ${review.reviewer}`
              : ` · ${review.gate.label}`;
            let text = `\n  ${status}${theme.fg("muted", suffix)}`;
            if (review.detail) text += `\n  ${theme.fg("muted", review.detail)}`;
            container.addChild(new Text(text, 0, 0));
          }
          return container;
        },
      });
      bashRendererRegistered = true;
      bashRendererSourcePath = pi.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo.path;
    },

    show(scope: ReviewScope, state: ReviewDisplayState, detail?: string, autoClear = false): void {
      const { ctx, config, gate, target } = scope;
      if (!deps.isSessionActive() || ctx.mode !== "tui" || !config.ui.enabled) return;
      const reviewer = config.reviewer
        ? `${config.reviewer.provider}/${config.reviewer.model}`
        : ctx.model
          ? `${ctx.model.provider}/${ctx.model.id}`
          : "active model";

      const rowId = rowTarget(target);
      if (rowId) {
        reviewRows.set(rowId, { gate, state, reviewer, detail });
        reviewRowInvalidators.get(rowId)?.();
        return;
      }

      if (clearWidgetTimer) clearTimeout(clearWidgetTimer);
      clearWidgetTimer = undefined;
      if (widgetAnimTimer) clearInterval(widgetAnimTimer);
      widgetAnimTimer = undefined;
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
            if (reviewStatusFrame(state, reviewer, frameIndex).done) stopTimer();
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
      const rowId = rowTarget(scope.target);
      if (rowId) {
        reviewRows.delete(rowId);
        const invalidate = reviewRowInvalidators.get(rowId);
        invalidate?.();
        reviewRowInvalidators.delete(rowId);
        return;
      }
      clearReviewWidget(scope.ctx);
    },

    shutdown(ctx: ExtensionContext): void {
      reviewRows.clear();
      for (const invalidate of reviewRowInvalidators.values()) invalidate();
      reviewRowInvalidators.clear();
      clearReviewWidget(ctx);
    },
  };
}
