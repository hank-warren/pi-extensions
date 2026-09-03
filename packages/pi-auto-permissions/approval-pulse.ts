import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

export const APPROVAL_PULSE_INTERVAL_MS = 600;

interface ApprovalPulseTheme {
  fg(role: "warning" | "dim", text: string): string;
  bold(text: string): string;
}

export interface ApprovalPulseScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

type InteractiveComponent = Component & Required<Pick<Component, "handleInput">>;

const DEFAULT_SCHEDULER: ApprovalPulseScheduler = {
  setInterval(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    timer.unref?.();
    return timer;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * Decorates an interactive prompt with a bright/dim approval light.
 *
 * The child still owns all content and input. Only its first rendered line is
 * replaced, preserving the selector's existing spacing and wrapping exactly.
 */
export class PulsingApprovalIndicator implements Component {
  private bright = true;
  private timer: unknown;

  constructor(
    private readonly headline: string,
    private readonly child: InteractiveComponent,
    private readonly theme: ApprovalPulseTheme,
    private readonly requestRender: () => void,
    private readonly scheduler: ApprovalPulseScheduler = DEFAULT_SCHEDULER,
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = this.scheduler.setInterval(() => {
      this.bright = !this.bright;
      this.requestRender();
    }, APPROVAL_PULSE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer === undefined) return;
    this.scheduler.clearInterval(this.timer);
    this.timer = undefined;
  }

  isRunning(): boolean {
    return this.timer !== undefined;
  }

  render(width: number): string[] {
    const lines = this.child.render(width);
    const glyph = this.bright
      ? this.theme.fg("warning", this.theme.bold("●"))
      : this.theme.fg("dim", "●");
    const headline = truncateToWidth(`${glyph} ${this.headline}`, Math.max(1, width), "");
    return lines.length > 0 ? [headline, ...lines.slice(1)] : [headline];
  }

  handleInput(data: string): void {
    this.child.handleInput(data);
  }

  invalidate(): void {
    this.child.invalidate();
  }
}
