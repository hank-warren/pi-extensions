/**
 * Global pi-loop settings: `~/.pi/agent/pi-loop.json`. Follows the sibling
 * convention (pi-plan-mode): an absent file means defaults and is
 * never created implicitly, saves are atomic and preserve unknown fields, and
 * an invalid file warns and falls back to defaults without being overwritten.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseDuration } from "./interval.js";

const LOOP_SETTINGS_FILE = "pi-loop.json";

interface LoopCompactionSettings {
	enabled: boolean;
	/** Fraction of the context window that triggers a proactive compact. */
	threshold: number;
	/** Override for the built-in compaction instruction template. */
	instructions: string | null;
}

/**
 * The cap fields this one replaced: a delivered-wake cap (`maxIterations`,
 * `--max`) and a loop-caused-turn cap (`automaticTurns`). A settle-paced loop
 * can run its whole life without delivering a single fallback wake, so the
 * wake cap bounded nothing the turn cap did not already bound.
 */
const LEGACY_CAP_KEYS = ["maxIterations", "automaticTurns"] as const;

/**
 * Settings that no longer exist. They are tolerated on read (an unknown field
 * is ignored, never a reason to reject the file) and dropped on the next save,
 * so a settings file written by an older version keeps working and quietly
 * stops advertising a switch that controls nothing.
 *
 * `inlineInvocation` toggled mid-prompt `/loop` detection, which was removed
 * along with the `loop_start` tool it pointed at.
 */
const REMOVED_KEYS = ["inlineInvocation"] as const;

export interface LoopSettings {
	/**
	 * Cap on the turns the loop itself causes (settle continuations plus
	 * fallback pokes); null means unlimited, and unlimited is the default. The
	 * only cap there is: one wake can yield many turns, so counting turns is
	 * what actually bounds a loop.
	 *
	 * A turn budget is a proxy for cost, not for progress, and a loop that hits
	 * one stops in the middle of the work with nothing decided. The real bounds
	 * are the expiry and the no-progress breaker, which stop a loop for reasons
	 * a user can act on. Set a number here to opt back into a budget.
	 */
	maxTurns: number | null;
	/**
	 * Consecutive tool-free loop turns with identical output that pause the
	 * loop; null disables the breaker.
	 */
	noProgressTurns: number | null;
	/** Wall-clock expiry for a loop, e.g. "7d" (research: bound forgotten loops). */
	maxLoopDuration: string;
	/**
	 * Fallback heartbeat used by a proposal that names no interval. In a
	 * settle-paced loop the interval is only a fallback — the settle boundary is
	 * the pacemaker — so this value is far less consequential than it looks; it
	 * is still clamped to MIN_INTERVAL_MS.
	 */
	defaultInterval: string;
	compaction: LoopCompactionSettings;
}

export const DEFAULT_LOOP_SETTINGS: LoopSettings = {
	maxTurns: null,
	noProgressTurns: 3,
	maxLoopDuration: "7d",
	defaultInterval: "10m",
	compaction: {
		enabled: true,
		threshold: 0.7,
		instructions: null,
	},
};

type LoopSettingsLoadResult =
	| { kind: "missing"; settings: LoopSettings }
	| { kind: "invalid"; reason: string; settings: LoopSettings }
	| { kind: "loaded"; settings: LoopSettings };

export function normalizeLoopSettings(value: unknown): LoopSettings | undefined {
	const record = ownRecord(value);
	if (!record) return undefined;

	const maxTurns = normalizeTurnCap(record);
	if (maxTurns === false) return undefined;

	const noProgressTurns = normalizeCap(
		record.noProgressTurns,
		DEFAULT_LOOP_SETTINGS.noProgressTurns,
	);
	if (noProgressTurns === false) return undefined;

	const maxLoopDuration = Object.hasOwn(record, "maxLoopDuration")
		? record.maxLoopDuration
		: DEFAULT_LOOP_SETTINGS.maxLoopDuration;
	if (typeof maxLoopDuration !== "string" || parseDuration(maxLoopDuration) === undefined) {
		return undefined;
	}

	const defaultInterval = Object.hasOwn(record, "defaultInterval")
		? record.defaultInterval
		: DEFAULT_LOOP_SETTINGS.defaultInterval;
	if (typeof defaultInterval !== "string" || parseDuration(defaultInterval) === undefined) {
		return undefined;
	}

	const compactionValue = Object.hasOwn(record, "compaction") ? record.compaction : undefined;
	if (compactionValue !== undefined && !ownRecord(compactionValue)) return undefined;
	const compactionRecord = ownRecord(compactionValue) ?? {};
	// `postCompactContinuation` was removed in favour of the loop's own
	// re-anchor; a file still carrying it is preserved as an unknown field and
	// ignored, never rejected.
	const enabled = readBoolean(compactionRecord, "enabled", DEFAULT_LOOP_SETTINGS.compaction.enabled);
	const threshold = Object.hasOwn(compactionRecord, "threshold")
		? compactionRecord.threshold
		: DEFAULT_LOOP_SETTINGS.compaction.threshold;
	const instructions = readNullableString(
		compactionRecord,
		"instructions",
		DEFAULT_LOOP_SETTINGS.compaction.instructions,
	);
	if (
		typeof enabled !== "boolean" ||
		instructions === false ||
		typeof threshold !== "number" ||
		!Number.isFinite(threshold) ||
		threshold <= 0 ||
		threshold >= 1
	) {
		return undefined;
	}

	return {
		maxTurns,
		noProgressTurns,
		maxLoopDuration,
		defaultInterval,
		compaction: { enabled, threshold, instructions },
	};
}

/** Returns the cap, or false when invalid. */
function normalizeCap(value: unknown, fallback: number | null): number | null | false {
	if (value === undefined) return fallback;
	if (value === null) return null;
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : false;
}

/**
 * The turn cap, accepting the two caps it replaced.
 *
 * A settings file written by an older version names no `maxTurns`, and asking
 * users to rewrite their settings to keep a cap they already chose is not a
 * trade worth making. So a file carrying only the legacy keys keeps the
 * tighter of the two: that is the bound their loops were already running
 * under. An invalid value in either key still fails the whole file closed,
 * exactly as it did when the key was current.
 */
function normalizeTurnCap(record: Record<string, unknown>): number | null | false {
	if (Object.hasOwn(record, "maxTurns")) {
		return normalizeCap(record.maxTurns, DEFAULT_LOOP_SETTINGS.maxTurns);
	}
	let adopted: number | null | undefined;
	for (const key of LEGACY_CAP_KEYS) {
		if (!Object.hasOwn(record, key)) continue;
		const cap = normalizeCap(record[key], DEFAULT_LOOP_SETTINGS.maxTurns);
		if (cap === false) return false;
		// null is unlimited, so it only wins when every legacy cap is unlimited.
		if (adopted === undefined || adopted === null) adopted = cap;
		else if (cap !== null) adopted = Math.min(adopted, cap);
	}
	return adopted === undefined ? DEFAULT_LOOP_SETTINGS.maxTurns : adopted;
}

function readBoolean(record: Record<string, unknown>, key: string, fallback: boolean): unknown {
	return Object.hasOwn(record, key) ? record[key] : fallback;
}

/** Returns the string, null, the fallback, or false when invalid. */
function readNullableString(
	record: Record<string, unknown>,
	key: string,
	fallback: string | null,
): string | null | false {
	if (!Object.hasOwn(record, key)) return fallback;
	const value = record[key];
	if (value === null) return null;
	return typeof value === "string" && value.trim().length > 0 ? value : false;
}

export function loopSettingsPath(): string {
	return join(getAgentDir(), LOOP_SETTINGS_FILE);
}

export function readLoopSettings(settingsPath = loopSettingsPath()): LoopSettingsLoadResult {
	let contents: string;
	try {
		contents = readFileSync(settingsPath, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return { kind: "missing", settings: structuredClone(DEFAULT_LOOP_SETTINGS) };
		}
		return {
			kind: "invalid",
			reason: `${settingsPath}: ${formatError(error)}`,
			settings: structuredClone(DEFAULT_LOOP_SETTINGS),
		};
	}
	try {
		const settings = normalizeLoopSettings(JSON.parse(contents) as unknown);
		return settings
			? { kind: "loaded", settings }
			: {
					kind: "invalid",
					reason: `${settingsPath}: invalid settings shape`,
					settings: structuredClone(DEFAULT_LOOP_SETTINGS),
				};
	} catch (error) {
		return {
			kind: "invalid",
			reason: `${settingsPath}: ${formatError(error)}`,
			settings: structuredClone(DEFAULT_LOOP_SETTINGS),
		};
	}
}

export function saveLoopSettings(settings: LoopSettings, settingsPath = loopSettingsPath()): void {
	const normalized = normalizeLoopSettings(settings);
	if (!normalized) throw new Error("Refusing to save invalid pi-loop settings.");

	let raw: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
		if (!normalizeLoopSettings(parsed)) {
			throw new Error(`${settingsPath}: invalid settings shape`);
		}
		raw = ownRecord(parsed) ?? {};
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") {
			throw new Error(`Cannot save over invalid settings file: ${formatError(error)}`);
		}
	}

	const compaction = ownRecord(raw.compaction) ?? {};
	// Unknown fields are preserved, but the two caps `maxTurns` replaced are not
	// unknown: leaving them next to a cap that supersedes them would show the
	// user two numbers where only one applies.
	for (const key of LEGACY_CAP_KEYS) delete raw[key];
	// Removed settings are dropped rather than preserved: keeping a switch that
	// controls nothing is worse than losing it.
	for (const key of REMOVED_KEYS) delete raw[key];
	const document = `${JSON.stringify(
		{
			...raw,
			maxTurns: normalized.maxTurns,
			noProgressTurns: normalized.noProgressTurns,
			maxLoopDuration: normalized.maxLoopDuration,
			defaultInterval: normalized.defaultInterval,
			compaction: { ...compaction, ...normalized.compaction },
		},
		null,
		2,
	)}\n`;
	const temporaryPath = join(
		dirname(settingsPath),
		`.${basename(settingsPath)}.${randomUUID()}.tmp`,
	);
	try {
		mkdirSync(dirname(settingsPath), { recursive: true });
		writeFileSync(temporaryPath, document, { encoding: "utf8", flag: "wx" });
		renameSync(temporaryPath, settingsPath);
	} finally {
		try {
			rmSync(temporaryPath, { force: true });
		} catch {
			// Best-effort cleanup must not replace the save result.
		}
	}
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
