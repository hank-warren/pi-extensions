import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OptionSelector } from "@hank-warren/pi-permission-selector/selector.ts";
import { ApprovalPrompt, type ApprovalPromptContent, approvalPromptText } from "./approval-prompt.js";

/**
 * Tell Herdr this pane is waiting on a human, so a supervising agent can see
 * the block instead of reading a stalled turn as progress. No-op outside Herdr.
 */
export function setHerdrBlocked(pi: ExtensionAPI, active: boolean, label?: string): void {
  if (process.env.HERDR_ENV !== "1") return;
  pi.events.emit("herdr:blocked", active ? { active: true, label } : { active: false });
}

/**
 * Render an approval prompt — an `ApprovalPrompt` wrapping the shared
 * `OptionSelector` — through `ctx.ui.custom()` (non-overlay, so it swaps into
 * the editor area exactly where `ctx.ui.select` used to render).
 *
 * Cancellation parity with `ctx.ui.select` — all of these resolve
 * `undefined`, which every caller must treat as deny/cancel, never allow:
 * - Esc (`OptionSelector.onCancel`)
 * - `signal` abort (listener calls `done(undefined)`; pi's `done` is
 *   idempotent and performs its own teardown, so nothing else is needed)
 * - a host that reports `hasUI` but cannot render custom components
 *
 * In RPC mode (`hasUI` is true but `custom()` returns undefined) the prompt
 * goes through `ctx.ui.select`, which the RPC client renders: that is how a
 * subagent child's approval reaches the human in the parent session.
 *
 * A Tab-typed note is delivered to the agent as a steering user message,
 * matching what the retired `ExtensionSelectorComponent` monkey patch in
 * pi-permission-selector did.
 */
export function promptSelect(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  content: ApprovalPromptContent,
  values: string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  if (ctx.mode === "rpc") return ctx.ui.select(approvalPromptText(content), values, { signal });
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    let finished = false;
    const onAbort = () => finish(undefined);
    const finish = (result: string | undefined) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", onAbort);
      done(result);
    };
    const selector = new OptionSelector({
      options: values.map((value) => ({ value, label: value })),
      allowComment: true,
      theme,
      onSelect: (option, comment) => {
        if (comment) {
          try {
            pi.sendUserMessage(comment, { deliverAs: "steer" });
          } catch {
            // Never let note delivery break the approval flow.
          }
        }
        finish(option.value);
      },
      onCancel: () => finish(undefined),
      requestRender: () => tui.requestRender(),
    });
    signal.addEventListener("abort", onAbort, { once: true });
    // `done` before the factory resolves is safe: pi marks the dialog closed
    // and never mounts the component.
    if (signal.aborted) onAbort();
    return new ApprovalPrompt({
      content,
      selector,
      theme,
      terminalRows: () => tui.terminal.rows,
      requestRender: () => tui.requestRender(),
    });
  });
}
