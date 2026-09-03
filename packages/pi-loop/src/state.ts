/**
 * Loop state persisted as `loop-state` custom session entries, plus one
 * read-only fail-open reader for a sibling extension's entries:
 * pi-plan-mode's `plan-mode-state`. The coupling is deliberately loose — no
 * package dependency, no RPC; an absent or unrecognizable entry degrades
 * pi-loop to "not planning", never crashes it.
 */

export const LOOP_STATE_ENTRY_TYPE = "loop-state";
export const PLAN_MODE_STATE_ENTRY_TYPE = "plan-mode-state";

import { type LoopWait, normalizeLoopWait } from "./wait.js";

const LOOP_STATUSES = ["active", "paused", "stopped"] as const;
type LoopStatus = (typeof LOOP_STATUSES)[number];

export interface LoopState {
	id: string;
	status: LoopStatus;
	/**
	 * An optional recurring focus, restated on every loop message. Also the
	 * only field a loop persisted before 0.6.0 may carry instead of an
	 * objective; the restore shim adopts it as one.
	 */
	prompt?: string;
	/**
	 * The loop's objective and completion criteria: what it works on, and what
	 * `loop_complete` answers for. Optional only because a loop persisted
	 * before 0.6.0 may predate it — every loop started now has one.
	 */
	objective?: string;
	/**
	 * Hard constraints, approved with the objective and injected alongside it on
	 * every active turn. Optional: a loop started before ground rules existed,
	 * or approved without any, simply has none.
	 */
	groundRules?: string[];
	intervalMs: number;
	/**
	 * Cap on the turns this loop causes (continuations plus pokes); null means
	 * unlimited. The only cap: a settle-driven continuation chain runs without
	 * any wake at all, so a wake cap bounded nothing this one does not.
	 */
	maxTurns: number | null;
	/** Proactive-compaction threshold fraction, or null when disabled per loop. */
	compactAt: number | null;
	/** Delivered wakes so far (fallback pokes only); uncapped, and displayed. */
	iteration: number;
	/** Loop-caused turns so far (continuations + pokes): what `maxTurns` caps. */
	automaticTurns: number;
	startedAt: number;
	expiresAt: number;
	lastWakeAt?: number;
	/** Set while the model has declared an external wait through `loop_wait`. */
	waiting?: LoopWait;
	/**
	 * The reason of a wait cancelled by something other than its own deadline,
	 * surfaced once in the next loop message so the context is not simply lost.
	 */
	cancelledWaitReason?: string;
	/** Consecutive tool-free loop turns with identical visible output. */
	toolFreeRepeatCount?: number;
	lastFingerprint?: string;
	/** Why a paused loop paused, for the widget and status after a restore. */
	pauseCause?: string;
	/** Durable reason recorded when the loop enters its terminal stopped state. */
	terminalReason?: string;
	/**
	 * Set once the expiry's final wake has been delivered. The loop is still
	 * active for exactly that one turn, so the objective append is present
	 * while it writes its state down; the next settle stops it.
	 */
	expiring?: true;
	/**
	 * Set on a loop handed to a fresh session and cleared the moment that
	 * session restores it.
	 *
	 * The launching session cannot kick the loop off itself: Pi builds a new
	 * extension instance for the new session, so the controller that ran the
	 * approval menu is not the controller that ends up holding the loop —
	 * observed live, where the loop crossed correctly and then sat idle waiting
	 * for its first fallback wake. Carrying the intent in the state instead
	 * means whichever instance restores it does the kickoff, which is true for
	 * every lifecycle the host might have.
	 */
	handoff?: true;
}

const MAX_PROMPT_LENGTH = 100_000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

export function normalizeLoopState(value: unknown): LoopState | undefined {
	const record = ownRecord(value);
	if (!record) return undefined;
	const id = typeof record.id === "string" ? record.id.trim() : "";
	if (!id || id.length > 200 || /[\s:>]/.test(id)) return undefined;
	const status = record.status;
	if (!LOOP_STATUSES.includes(status as LoopStatus)) return undefined;
	let prompt: string | undefined;
	if (record.prompt !== undefined) {
		if (typeof record.prompt !== "string") return undefined;
		prompt = record.prompt.trim();
		if (!prompt || prompt.length > MAX_PROMPT_LENGTH) return undefined;
	}
	let objective: string | undefined;
	if (record.objective !== undefined) {
		if (typeof record.objective !== "string") return undefined;
		objective = record.objective.trim();
		if (!objective || objective.length > MAX_PROMPT_LENGTH) return undefined;
	}
	const groundRules = normalizeGroundRuleList(record.groundRules);
	if (groundRules === false) return undefined;
	const intervalMs = record.intervalMs;
	if (!isPositiveSafeInteger(intervalMs)) return undefined;
	const maxTurns = readTurnCap(record);
	if (maxTurns === false) return undefined;
	const compactAt = record.compactAt;
	if (
		compactAt !== null &&
		(typeof compactAt !== "number" || !Number.isFinite(compactAt) || compactAt <= 0 || compactAt >= 1)
	) {
		return undefined;
	}
	const iteration = record.iteration;
	if (typeof iteration !== "number" || !Number.isSafeInteger(iteration) || iteration < 0) {
		return undefined;
	}
	// A loop persisted before the turn counter existed carries no automaticTurns;
	// an absent counter restores as zero rather than rejecting the whole state.
	const automaticTurns = Object.hasOwn(record, "automaticTurns") ? record.automaticTurns : 0;
	if (
		typeof automaticTurns !== "number" ||
		!Number.isSafeInteger(automaticTurns) ||
		automaticTurns < 0
	) {
		return undefined;
	}
	if (!isTimestamp(record.startedAt) || !isTimestamp(record.expiresAt)) return undefined;
	if (record.lastWakeAt !== undefined && !isTimestamp(record.lastWakeAt)) return undefined;
	let waiting: LoopWait | undefined;
	if (record.waiting !== undefined) {
		waiting = normalizeLoopWait(record.waiting);
		if (!waiting) return undefined;
	}
	const cancelledWaitReason = optionalText(record.cancelledWaitReason);
	if (cancelledWaitReason === false) return undefined;
	const pauseCause = optionalText(record.pauseCause);
	if (pauseCause === false) return undefined;
	const terminalReason = optionalText(record.terminalReason);
	if (terminalReason === false) return undefined;
	const toolFreeRepeatCount = record.toolFreeRepeatCount;
	if (
		toolFreeRepeatCount !== undefined &&
		(typeof toolFreeRepeatCount !== "number" ||
			!Number.isSafeInteger(toolFreeRepeatCount) ||
			toolFreeRepeatCount < 0)
	) {
		return undefined;
	}
	const lastFingerprint = optionalText(record.lastFingerprint);
	if (lastFingerprint === false) return undefined;
	if (record.expiring !== undefined && record.expiring !== true) return undefined;
	if (record.handoff !== undefined && record.handoff !== true) return undefined;
	return {
		id,
		status: status as LoopStatus,
		...(prompt === undefined ? {} : { prompt }),
		...(objective === undefined ? {} : { objective }),
		...(groundRules === undefined ? {} : { groundRules }),
		intervalMs,
		maxTurns,
		compactAt: compactAt as number | null,
		iteration,
		automaticTurns,
		startedAt: record.startedAt as number,
		expiresAt: record.expiresAt as number,
		...(record.lastWakeAt === undefined ? {} : { lastWakeAt: record.lastWakeAt as number }),
		...(waiting === undefined ? {} : { waiting }),
		...(cancelledWaitReason === undefined ? {} : { cancelledWaitReason }),
		...(toolFreeRepeatCount === undefined ? {} : { toolFreeRepeatCount }),
		...(lastFingerprint === undefined ? {} : { lastFingerprint }),
		...(pauseCause === undefined ? {} : { pauseCause }),
		...(terminalReason === undefined ? {} : { terminalReason }),
		...(record.expiring === true ? { expiring: true as const } : {}),
		...(record.handoff === true ? { handoff: true as const } : {}),
	};
}

/**
 * The turn cap, adopting the caps a loop persisted by an older version
 * carries: `maxAutomaticTurns` (turns) and `maxIterations` (wakes). An
 * in-flight loop restored mid-upgrade keeps the tighter of them rather than
 * having its bound widened or being dropped as unparsable; its wake *counter*
 * is kept for display but no longer caps anything. Returns the cap, or false
 * when a present value is invalid.
 */
function readTurnCap(record: Record<string, unknown>): number | null | false {
	if (Object.hasOwn(record, "maxTurns")) {
		const value = record.maxTurns;
		if (value === null) return null;
		return isPositiveSafeInteger(value) ? value : false;
	}
	let adopted: number | null | undefined;
	for (const key of ["maxAutomaticTurns", "maxIterations"]) {
		if (!Object.hasOwn(record, key)) continue;
		const value = record[key];
		if (value !== null && !isPositiveSafeInteger(value)) return false;
		const cap = value as number | null;
		// null is unlimited, so it only wins when every legacy cap is unlimited.
		if (adopted === undefined || adopted === null) adopted = cap;
		else if (cap !== null) adopted = Math.min(adopted, cap);
	}
	return adopted === undefined ? null : adopted;
}

// --- session-branch entry readers ---

interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

function lastCustomEntryData(entries: unknown[], customType: string): unknown {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as SessionEntryLike | undefined;
		if (entry?.type === "custom" && entry.customType === customType) return entry.data;
	}
	return undefined;
}

/** Restore the persisted loop state from a session branch, fail-open. */
export function restoreLoopState(entries: unknown[]): LoopState | undefined {
	const data = lastCustomEntryData(entries, LOOP_STATE_ENTRY_TYPE);
	const record = ownRecord(data);
	if (!record) return undefined;
	return normalizeLoopState(record.loop);
}

/** Read pi-plan-mode's persisted state, fail-open: absent or malformed = not planning. */
export function readPlanModeEnabled(entries: unknown[]): boolean {
	const data = ownRecord(lastCustomEntryData(entries, PLAN_MODE_STATE_ENTRY_TYPE));
	return data?.enabled === true;
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * A present-but-optional ground-rule list: the list, undefined when absent,
 * false when invalid. Empty survives as undefined so an approved loop with no
 * rules and a restored one are the same state.
 */
function normalizeGroundRuleList(value: unknown): string[] | undefined | false {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return false;
	const rules: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") return false;
		const trimmed = entry.trim();
		if (!trimmed) continue;
		if (trimmed.length > MAX_PROMPT_LENGTH) return false;
		rules.push(trimmed);
	}
	return rules.length > 0 ? rules : undefined;
}

/** A present-but-optional string: the value, undefined when absent, false when invalid. */
function optionalText(value: unknown): string | undefined | false {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return false;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= MAX_PROMPT_LENGTH ? trimmed : false;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP
	);
}
