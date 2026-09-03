export const CACHE_HIT_THRESHOLD = 0.96;
export const CACHE_CELEBRATION_FRAME_INTERVAL_MS = 60;
export const CACHE_CELEBRATION_DURATION_MS = 2_000;

interface CacheUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface CacheCelebrationSnapshot {
	percent: number;
	frame: number;
}

interface CacheCelebrationTarget {
	start(percent: number): void;
}

interface CacheCelebrationControllerOptions {
	frameIntervalMs?: number;
	durationMs?: number;
	now?: () => number;
	schedule?: (callback: () => void, intervalMs: number) => unknown;
	cancel?: (handle: unknown) => void;
}

function defaultSchedule(callback: () => void, intervalMs: number): unknown {
	const timer = setInterval(callback, intervalMs);
	// A cosmetic celebration must never keep Pi alive.
	(timer as { unref?: () => void }).unref?.();
	return timer;
}

function defaultCancel(handle: unknown): void {
	clearInterval(handle as ReturnType<typeof setInterval>);
}

/** Return the prompt-cache hit ratio for one response, or null without prompt tokens. */
export function cacheReadHitRate(usage: CacheUsage): number | null {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return promptTokens > 0 ? usage.cacheRead / promptTokens : null;
}

/** Return the rounded badge percentage only when a response qualifies for celebration. */
export function qualifyingCacheHitPercent(usage: CacheUsage): number | null {
	const rate = cacheReadHitRate(usage);
	return rate !== null && rate >= CACHE_HIT_THRESHOLD ? Math.round(rate * 100) : null;
}

/**
 * Apply the same narrowing used by the turn_end hook and start a celebration
 * for a qualifying assistant response.
 */
export function triggerCacheCelebrationForMessage(
	message: unknown,
	target: CacheCelebrationTarget,
): boolean {
	if (!message || typeof message !== "object") return false;
	const candidate = message as { role?: unknown; usage?: Partial<CacheUsage> };
	if (candidate.role !== "assistant" || !candidate.usage) return false;
	const { input, cacheRead, cacheWrite } = candidate.usage;
	if (typeof input !== "number" || typeof cacheRead !== "number" || typeof cacheWrite !== "number") {
		return false;
	}
	const percent = qualifyingCacheHitPercent({ input, cacheRead, cacheWrite });
	if (percent === null) return false;
	target.start(percent);
	return true;
}

/** Owns the short-lived animation timer and exposes an immutable render snapshot. */
export class CacheCelebrationController implements CacheCelebrationTarget {
	private current: CacheCelebrationSnapshot | undefined;
	private startedAt = 0;
	private timerHandle: unknown;
	private readonly frameIntervalMs: number;
	private readonly durationMs: number;
	private readonly now: () => number;
	private readonly schedule: (callback: () => void, intervalMs: number) => unknown;
	private readonly cancel: (handle: unknown) => void;

	constructor(
		private readonly requestRender: () => void,
		options: CacheCelebrationControllerOptions = {},
	) {
		this.frameIntervalMs = options.frameIntervalMs ?? CACHE_CELEBRATION_FRAME_INTERVAL_MS;
		this.durationMs = options.durationMs ?? CACHE_CELEBRATION_DURATION_MS;
		this.now = options.now ?? Date.now;
		this.schedule = options.schedule ?? defaultSchedule;
		this.cancel = options.cancel ?? defaultCancel;
	}

	start(percent: number): void {
		this.clearTimer();
		this.startedAt = this.now();
		this.current = { percent, frame: 0 };
		this.requestRender();
		this.timerHandle = this.schedule(() => this.tick(), this.frameIntervalMs);
	}

	snapshot(): CacheCelebrationSnapshot | undefined {
		return this.current ? { ...this.current } : undefined;
	}

	/** Stop without requesting a render; intended for footer/session teardown. */
	dispose(): void {
		this.clearTimer();
		this.current = undefined;
	}

	private tick(): void {
		if (!this.current) return;
		const elapsed = this.now() - this.startedAt;
		if (elapsed >= this.durationMs) {
			this.clearTimer();
			this.current = undefined;
			this.requestRender();
			return;
		}
		this.current = {
			...this.current,
			frame: Math.floor(elapsed / this.frameIntervalMs),
		};
		this.requestRender();
	}

	private clearTimer(): void {
		if (this.timerHandle !== undefined) this.cancel(this.timerHandle);
		this.timerHandle = undefined;
	}
}
