/**
 * Fullscreen TUI artifact repair.
 *
 * Pi's fullscreen (alt-screen) renderer writes rows differentially: a row whose
 * rendered content is byte-identical to the previous frame is never re-emitted.
 * Once terminal cells desync from Pi's row cache, static statusline rows can
 * therefore retain stale text indefinitely.
 *
 * This scheduler repairs the footer in two layers:
 *
 * 1. A short timer alternates between two visually equivalent ANSI reset
 *    prefixes and requests a normal render. Only the statusline rows compare as
 *    changed, even when Pi is otherwise idle.
 * 2. `request()` keeps the slower forced full redraw fallback for corruption
 *    outside the footer.
 *
 * Both layers are fullscreen-only. Regular mode already reprints its block and
 * does not need a periodic render.
 */

/** Minimum spacing between forced full redraws. */
export const DEFAULT_MIN_GAP_MS = 5_000;
/** Idle cadence for targeted statusline-row repainting. */
export const DEFAULT_ROW_REFRESH_INTERVAL_MS = 1_000;
/** Slow fallback cadence for corruption outside the footer. */
export const DEFAULT_IDLE_INTERVAL_MS = 30_000;

const ANSI_RESET = "\x1b[0m";

/** The subset of Pi's TUI surface this scheduler needs. */
export interface RedrawTarget {
	readonly mode: string;
	requestRender(force?: boolean): void;
}

interface FullRedrawSchedulerOptions {
	minGapMs?: number;
	rowRefreshIntervalMs?: number;
	idleIntervalMs?: number;
	now?: () => number;
	schedule?: (callback: () => void, intervalMs: number) => unknown;
	cancel?: (handle: unknown) => void;
}

function defaultSchedule(callback: () => void, intervalMs: number): unknown {
	const timer = setInterval(callback, intervalMs);
	// Never hold the process open just to repair cosmetic artifacts.
	(timer as { unref?: () => void }).unref?.();
	return timer;
}

function defaultCancel(handle: unknown): void {
	clearInterval(handle as ReturnType<typeof setInterval>);
}

export class FullRedrawScheduler {
	private target: RedrawTarget | undefined;
	private rowRefreshHandle: unknown;
	private fullRedrawHandle: unknown;
	private lastRedrawAt = Number.NEGATIVE_INFINITY;
	private decorationPhase = 0;
	private readonly minGapMs: number;
	private readonly rowRefreshIntervalMs: number;
	private readonly idleIntervalMs: number;
	private readonly now: () => number;
	private readonly schedule: (callback: () => void, intervalMs: number) => unknown;
	private readonly cancel: (handle: unknown) => void;

	constructor(options: FullRedrawSchedulerOptions = {}) {
		this.minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS;
		this.rowRefreshIntervalMs = options.rowRefreshIntervalMs ?? DEFAULT_ROW_REFRESH_INTERVAL_MS;
		this.idleIntervalMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;
		this.now = options.now ?? Date.now;
		this.schedule = options.schedule ?? defaultSchedule;
		this.cancel = options.cancel ?? defaultCancel;
	}

	/** Bind to the TUI that owns the footer and start both repair sweeps. */
	attach(target: RedrawTarget): void {
		this.detach();
		this.target = target;
		this.lastRedrawAt = Number.NEGATIVE_INFINITY;
		this.decorationPhase = 0;
		this.rowRefreshHandle = this.schedule(() => {
			this.requestRowRefresh();
		}, this.rowRefreshIntervalMs);
		this.fullRedrawHandle = this.schedule(() => {
			this.request();
		}, this.idleIntervalMs);
	}

	detach(): void {
		if (this.rowRefreshHandle !== undefined) this.cancel(this.rowRefreshHandle);
		if (this.fullRedrawHandle !== undefined) this.cancel(this.fullRedrawHandle);
		this.rowRefreshHandle = undefined;
		this.fullRedrawHandle = undefined;
		this.target = undefined;
	}

	/**
	 * Make footer rows byte-different without changing their visible contents.
	 * Pi will then clear and repaint those rows during an ordinary differential
	 * render instead of requiring a full-screen clear.
	 */
	decorate(lines: string[]): string[] {
		if (this.target?.mode !== "fullscreen") return lines;
		const prefix = this.decorationPhase === 0 ? ANSI_RESET : `${ANSI_RESET}${ANSI_RESET}`;
		return lines.map((line) => `${prefix}${line}`);
	}

	/**
	 * Advance the invisible footer marker and request an ordinary render. The
	 * timer calls this at most once per interval, so active Pi frames do not
	 * repeatedly repaint otherwise-static statusline rows.
	 */
	requestRowRefresh(): boolean {
		const target = this.target;
		if (!target || target.mode !== "fullscreen") return false;
		this.decorationPhase = (this.decorationPhase + 1) % 2;
		target.requestRender();
		return true;
	}

	/**
	 * Ask for a forced full redraw. No-ops outside fullscreen mode and while
	 * throttled. Returns whether a redraw was actually requested.
	 */
	request(): boolean {
		const target = this.target;
		if (!target || target.mode !== "fullscreen") return false;
		const now = this.now();
		if (now - this.lastRedrawAt < this.minGapMs) return false;
		this.lastRedrawAt = now;
		target.requestRender(true);
		return true;
	}
}
