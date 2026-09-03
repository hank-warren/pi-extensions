/**
 * Provenance marker for loop-injected pokes, following pi-goal's marker
 * pattern: an HTML comment the model and transcript can see but that reads as
 * metadata, so a wakeup is identifiable as loop-injected rather than
 * user-typed (research: Claude Code's untagged auto-fires made wakeups
 * indistinguishable from user prompts, issue #57660).
 *
 * Provenance only. Nothing in pi-loop reads the marker back to drop stale or
 * duplicate deliveries — the engine coalesces wakes in its own state, and the
 * marker exists for the model, the transcript, and sibling extensions.
 */

const POKE_MARKER_PREFIX = "pi-loop-poke:";
const CONTINUATION_MARKER_PREFIX = "pi-loop-continuation:";

const POKE_MARKER_PATTERN = markerPattern(POKE_MARKER_PREFIX);
const CONTINUATION_MARKER_PATTERN = markerPattern(CONTINUATION_MARKER_PREFIX);

function markerPattern(prefix: string) {
	return new RegExp(`<!--\\s*${escapeRegExpText(prefix)}([^\\s:>]+):(\\d+)\\s*-->`);
}

export function appendPokeMarker(prompt: string, loopId: string, iteration: number): string {
	return `${prompt}\n\n<!-- ${POKE_MARKER_PREFIX}${loopId}:${iteration} -->`;
}

/**
 * Settle-driven continuations carry their own marker so the transcript, the
 * model, and sibling extensions can tell a continuation apart from a
 * fallback wake — they mean different things about why the loop is talking.
 */
export function appendContinuationMarker(prompt: string, loopId: string, turn: number): string {
	return `${prompt}\n\n<!-- ${CONTINUATION_MARKER_PREFIX}${loopId}:${turn} -->`;
}

export function extractPokeMarker(
	prompt: string,
): { loopId: string; iteration: number } | undefined {
	const match = POKE_MARKER_PATTERN.exec(prompt);
	if (!match || match[1] === undefined || match[2] === undefined) return undefined;
	return { loopId: match[1], iteration: Number(match[2]) };
}

export function extractContinuationMarker(
	prompt: string,
): { loopId: string; turn: number } | undefined {
	const match = CONTINUATION_MARKER_PATTERN.exec(prompt);
	if (!match || match[1] === undefined || match[2] === undefined) return undefined;
	return { loopId: match[1], turn: Number(match[2]) };
}

function escapeRegExpText(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
