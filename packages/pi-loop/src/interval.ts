/**
 * Deterministic duration parsing. The extension owns the grammar (research:
 * model-parsed intervals make timing undebuggable): a positive integer plus
 * one unit, `30s` / `5m` / `2h` / `1d`.
 */

export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 2_147_483_647; // setTimeout's cap.

const DURATION_PATTERN = /^(\d{1,9})(s|m|h|d)$/;

const UNIT_MS: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/** Parse a duration token to milliseconds, or undefined when malformed. */
export function parseDuration(token: string): number | undefined {
	const match = DURATION_PATTERN.exec(token.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2] === undefined ? undefined : UNIT_MS[match[2]];
	if (!Number.isSafeInteger(amount) || amount <= 0 || unit === undefined) return undefined;
	const ms = amount * unit;
	return ms > MAX_INTERVAL_MS ? undefined : ms;
}

interface ParsedInterval {
	requestedMs: number;
	/** Clamped to MIN_INTERVAL_MS; the caller must echo the effective value. */
	effectiveMs: number;
	clamped: boolean;
}

/** Parse a loop interval token, clamping below the minimum. */
export function parseInterval(token: string): ParsedInterval | undefined {
	const requestedMs = parseDuration(token);
	if (requestedMs === undefined) return undefined;
	const effectiveMs = Math.max(MIN_INTERVAL_MS, requestedMs);
	return { requestedMs, effectiveMs, clamped: effectiveMs !== requestedMs };
}

/** Render a millisecond duration back to the most compact token. */
export function formatDuration(ms: number): string {
	for (const [unit, size] of [
		["d", UNIT_MS.d],
		["h", UNIT_MS.h],
		["m", UNIT_MS.m],
	] as const) {
		if (size !== undefined && ms >= size && ms % size === 0) return `${ms / size}${unit}`;
	}
	return `${Math.round(ms / 1_000)}s`;
}

/**
 * Render an elapsed span approximately, for display only.
 *
 * `formatDuration` renders the *canonical token* for a configured interval and
 * only ever emits one unit on an exact multiple, so an arbitrary elapsed span
 * falls through it to seconds — 2h12m comes back as "7920s". An age needs the
 * opposite trade: two units at most, truncated, never exact.
 */
export function formatElapsed(ms: number): string {
	const clamped = Math.max(0, ms);
	if (clamped < UNIT_MS.m) return `${Math.floor(clamped / 1_000)}s`;
	for (const [big, small] of [
		["d", "h"],
		["h", "m"],
	] as const) {
		const bigMs = UNIT_MS[big];
		const smallMs = UNIT_MS[small];
		if (bigMs === undefined || smallMs === undefined || clamped < bigMs) continue;
		const whole = Math.floor(clamped / bigMs);
		const rest = Math.floor((clamped % bigMs) / smallMs);
		return rest > 0 ? `${whole}${big}${rest}${small}` : `${whole}${big}`;
	}
	return `${Math.floor(clamped / UNIT_MS.m)}m`;
}

/** Render a wall-clock time as HH:MM for the status widget. */
export function formatClock(timestamp: number): string {
	const date = new Date(timestamp);
	const hours = `${date.getHours()}`.padStart(2, "0");
	const minutes = `${date.getMinutes()}`.padStart(2, "0");
	return `${hours}:${minutes}`;
}
