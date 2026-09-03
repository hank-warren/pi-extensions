/**
 * `loop_wait` state: the model's declaration that progress now depends on
 * something outside the session.
 *
 * A wait does not stop the loop and does not cancel the pacemaker. It
 * supersedes the *next* fallback wake — the loop stops continuing on its own
 * and the wait's own deadline becomes the next thing that speaks. That is the
 * whole difference between "waiting" and "paused": a paused loop needs the
 * user, a waiting loop needs the world.
 *
 * The clamp is a range, not a floor. Below 60s a wait is polling, which is
 * what the tool exists to replace; above an hour it stops being a wait and
 * becomes an abandonment, and the fallback heartbeat covers that case better.
 */

export interface LoopWait {
	reason: string;
	resumeAt?: number;
}

export const MAX_WAIT_REASON_LENGTH = 1_000;
export const MIN_WAIT_DELAY_MS = 60_000;
export const MAX_WAIT_DELAY_MS = 3_600_000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

export interface ResolvedWaitDelay {
	requestedMs?: number;
	effectiveMs?: number;
	clamped: boolean;
}

export function resolveWaitDelay(resumeAfterMs: number | undefined): ResolvedWaitDelay {
	if (resumeAfterMs === undefined || !Number.isFinite(resumeAfterMs)) return { clamped: false };
	const effectiveMs = Math.min(MAX_WAIT_DELAY_MS, Math.max(MIN_WAIT_DELAY_MS, resumeAfterMs));
	return { requestedMs: resumeAfterMs, effectiveMs, clamped: effectiveMs !== resumeAfterMs };
}

export function createLoopWait(
	reason: string,
	resumeAfterMs: number | undefined,
	now: number,
): LoopWait {
	const { effectiveMs } = resolveWaitDelay(resumeAfterMs);
	return {
		reason,
		...(effectiveMs === undefined ? {} : { resumeAt: now + effectiveMs }),
	};
}

export function normalizeLoopWait(value: unknown): LoopWait | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const reason = typeof record.reason === "string" ? record.reason.trim() : "";
	if (!reason || reason.length > MAX_WAIT_REASON_LENGTH) return undefined;
	if (!Object.hasOwn(record, "resumeAt")) return { reason };
	const resumeAt = record.resumeAt;
	if (
		typeof resumeAt !== "number" ||
		!Number.isSafeInteger(resumeAt) ||
		resumeAt < 0 ||
		resumeAt > MAX_TIMESTAMP
	) {
		return undefined;
	}
	return { reason, resumeAt };
}

/**
 * A single-slot timer whose callbacks are generation-guarded, so a wait that
 * was cleared or replaced can never fire against the loop that replaced it.
 */
export class LoopWaitTimer {
	private generation = 0;
	private timer: NodeJS.Timeout | undefined;

	clear(): void {
		this.generation += 1;
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	schedule(resumeAt: number, onDue: () => void, now: number = Date.now()): void {
		this.clear();
		const generation = this.generation;
		const delay = Math.max(0, Math.min(MAX_WAIT_DELAY_MS, resumeAt - now));
		this.timer = setTimeout(() => {
			if (generation !== this.generation) return;
			this.timer = undefined;
			onDue();
		}, delay);
		// A pending wake must never hold the process open.
		this.timer.unref?.();
	}
}
