import { spawn as nodeSpawn } from "node:child_process";
import { platform } from "node:process";

/**
 * User-defined statusline segments, modelled on Claude Code's `statusLine`.
 *
 * Each item is a shell command that receives a JSON snapshot of the session on
 * stdin and prints one line to stdout. That contract is deliberately the same
 * one Claude Code uses, so an existing statusline script mostly ports over; the
 * differences are that pi renders each item as one *segment* of line 1 rather
 * than owning the whole row, and that the payload's usage numbers are remaining
 * percentages (see `custom-items.md` in the README).
 */

/** How long a command may run before it is killed, when it names no timeout. */
export const DEFAULT_TIMEOUT_MS = 5_000;
/** Ceiling for a configured timeout: a statusline must never block on a hang. */
export const MAX_TIMEOUT_MS = 30_000;
/**
 * Floor between two event-driven runs of the same item. Turn ends are the main
 * trigger and are already coarse, but a session can end several turns in a
 * second, and an item that shells out to `curl` should not follow it there.
 */
export const EVENT_MIN_INTERVAL_MS = 1_000;
/**
 * Consecutive failures tolerated before an item's last good value is dropped.
 *
 * A statusline value that quietly goes stale is worse than an empty slot: the
 * number stays plausible while it describes a world that has moved on. One
 * blip (a laptop between networks) keeps the value; a command that is simply
 * broken loses it.
 */
export const FAILURE_GRACE = 3;
/** Longest rendered value kept from a command, before the line is truncated. */
export const MAX_OUTPUT_WIDTH = 120;

/**
 * One configured item.
 *
 * `source` is the entry exactly as it appeared on disk. Serialization writes it
 * back verbatim apart from the one field the menu owns (`enabled`), so an entry
 * this version cannot parse — a `type` from a newer release, a key added by a
 * future feature — survives a settings write instead of being silently deleted
 * by the first person who toggles an unrelated row.
 */
export interface CustomItem {
	id: string;
	enabled: boolean;
	/** Absent when the entry is not runnable; `error` then says why. */
	command?: string;
	/** Seconds between forced re-runs. Absent means event-driven only. */
	refreshInterval?: number;
	timeoutMs: number;
	/** Why this entry cannot run, shown in the `/statusline` submenu. */
	error?: string;
	/** The on-disk entry, preserved for round-tripping. */
	source: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Positive finite seconds, or undefined for anything unusable. */
function positiveSeconds(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return value;
}

function uniqueId(candidate: string, taken: Set<string>): string {
	if (!taken.has(candidate)) return candidate;
	for (let suffix = 2; ; suffix += 1) {
		const next = `${candidate}#${suffix}`;
		if (!taken.has(next)) return next;
	}
}

/**
 * Parse the `customItems` array.
 *
 * Every entry becomes an item, including the ones that cannot run: an invalid
 * entry is reported through `error` rather than dropped, because dropping it
 * would erase it from the file on the next write. Validation failures are
 * per-entry, so one bad command never costs the user their other items.
 */
export function normalizeCustomItems(value: unknown): CustomItem[] {
	if (!Array.isArray(value)) return [];
	const items: CustomItem[] = [];
	const taken = new Set<string>();
	value.forEach((entry, index) => {
		const fallbackId = `item-${index + 1}`;
		if (!isPlainObject(entry)) {
			const id = uniqueId(fallbackId, taken);
			taken.add(id);
			items.push({ id, enabled: false, timeoutMs: DEFAULT_TIMEOUT_MS, error: "not an object", source: entry });
			return;
		}
		const rawId = entry.id;
		const id = uniqueId(typeof rawId === "string" && rawId.length > 0 ? rawId : fallbackId, taken);
		taken.add(id);
		// `enabled` is the menu's field; everything else is the user's.
		const enabled = entry.enabled !== false;
		const timeoutSeconds = positiveSeconds(entry.timeout);
		const timeoutMs = Math.min(
			timeoutSeconds === undefined ? DEFAULT_TIMEOUT_MS : timeoutSeconds * 1000,
			MAX_TIMEOUT_MS,
		);
		const refreshInterval = positiveSeconds(entry.refreshInterval);
		const base = { id, enabled, timeoutMs, source: entry, ...(refreshInterval ? { refreshInterval } : {}) };
		// Claude Code's `statusLine` carries `type: "command"`, so a pasted entry
		// may too. That value is accepted; any other is not a mistake this version
		// can judge, so the entry is kept and flagged rather than run or dropped.
		const type = entry.type ?? "command";
		if (type !== "command") {
			items.push({ ...base, enabled: false, error: `unsupported type: ${String(type)}` });
			return;
		}
		if (typeof entry.command !== "string" || entry.command.trim().length === 0) {
			items.push({ ...base, enabled: false, error: "missing command" });
			return;
		}
		items.push({ ...base, command: entry.command });
	});
	return items;
}

/**
 * Write items back to their on-disk form.
 *
 * The source entry wins for every field except `enabled`, which the menu owns:
 * it is written only when false, so toggling an item on again leaves the file
 * as the user wrote it rather than accumulating defaults.
 */
export function serializeCustomItems(items: readonly CustomItem[]): unknown[] {
	return items.map((item) => {
		if (!isPlainObject(item.source)) return item.source;
		const entry = { ...item.source };
		if (item.enabled) delete entry.enabled;
		else entry.enabled = false;
		return entry;
	});
}

/** Whether two item lists are the same for save-diffing purposes. */
export function sameCustomItems(a: readonly CustomItem[], b: readonly CustomItem[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((item, index) => {
		const other = b[index];
		return (
			other !== undefined &&
			item.id === other.id &&
			item.enabled === other.enabled &&
			JSON.stringify(item.source) === JSON.stringify(other.source)
		);
	});
}

/**
 * Strip anything that could damage the footer, keeping SGR colour sequences.
 *
 * Scripts are encouraged to colour their output, so `\x1b[32m` has to survive.
 * Every other escape sequence does not: a cursor move or an erase-line writes
 * outside the row the statusline owns and corrupts the frame around it.
 */
export function sanitizeOutput(raw: string): string {
	const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
	let out = "";
	for (let index = 0; index < firstLine.length; index += 1) {
		const char = firstLine[index] as string;
		if (char === "\x1b") {
			const sgr = /^\x1b\[[0-9;:]*m/.exec(firstLine.slice(index));
			if (sgr) {
				out += sgr[0];
				index += sgr[0].length - 1;
				continue;
			}
			// Any other escape sequence: skip the introducer and its final byte.
			const other = /^\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/.exec(
				firstLine.slice(index),
			);
			if (other) index += other[0].length - 1;
			continue;
		}
		// eslint-disable-next-line no-control-regex
		if (char === "\t") {
			out += " ";
			continue;
		}
		const code = char.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) continue;
		out += char;
	}
	return out.trim().slice(0, MAX_OUTPUT_WIDTH);
}

/** The last thing an item did, for rendering and for the settings submenu. */
export interface CustomItemState {
	id: string;
	enabled: boolean;
	/** Sanitized first line of stdout; absent when there is nothing to show. */
	value?: string;
	/** Configuration or run failure, whichever applies. */
	error?: string;
	/** When the value was produced, as epoch ms. */
	updatedAt?: number;
	running: boolean;
}

export type SpawnFn = typeof nodeSpawn;

export interface CustomItemsTrackerOptions {
	spawn?: SpawnFn;
	now?: () => number;
	onChange?: () => void;
	cwd?: string;
	schedule?: (callback: () => void, intervalMs: number) => unknown;
	cancel?: (handle: unknown) => void;
}

interface RunRecord {
	value?: string;
	error?: string;
	updatedAt?: number;
	lastAttempt: number;
	failures: number;
	running: boolean;
	abort?: () => void;
}

function defaultSchedule(callback: () => void, intervalMs: number): unknown {
	const handle = setInterval(callback, intervalMs);
	if (typeof handle.unref === "function") handle.unref();
	return handle;
}

function defaultCancel(handle: unknown): void {
	clearInterval(handle as ReturnType<typeof setInterval>);
}

/** Smallest configured refresh interval, which sets the tick rate. */
const TICK_FLOOR_MS = 1_000;

/**
 * Runs the configured items and holds their latest values.
 *
 * Each item runs at most once at a time: a trigger that arrives while a command
 * is still going is dropped rather than queued, so a slow command degrades to a
 * lower refresh rate instead of a pile of processes.
 */
export class CustomItemsTracker {
	private items: CustomItem[] = [];
	private readonly records = new Map<string, RunRecord>();
	private readonly spawnFn: SpawnFn;
	private readonly now: () => number;
	private readonly onChange?: () => void;
	private readonly schedule: (callback: () => void, intervalMs: number) => unknown;
	private readonly cancel: (handle: unknown) => void;
	private cwd: string | undefined;
	private columns = 80;
	private payloadFactory: () => Record<string, unknown> = () => ({});
	private tickHandle: unknown;

	constructor(options: CustomItemsTrackerOptions = {}) {
		this.spawnFn = options.spawn ?? nodeSpawn;
		this.now = options.now ?? Date.now;
		this.onChange = options.onChange;
		this.cwd = options.cwd;
		this.schedule = options.schedule ?? defaultSchedule;
		this.cancel = options.cancel ?? defaultCancel;
	}

	/**
	 * Adopt a new configuration, keeping the state of items that survived it.
	 *
	 * Identity is the item id, so editing a command's text keeps its slot filled
	 * with the previous value until the new command first answers — the footer
	 * does not blink on every settings save.
	 */
	setItems(items: readonly CustomItem[]): void {
		this.items = [...items];
		const live = new Set(items.map((item) => item.id));
		for (const [id, record] of this.records) {
			if (live.has(id)) continue;
			record.abort?.();
			this.records.delete(id);
		}
	}

	setContext(context: { cwd?: string; columns?: number }): void {
		if (context.cwd !== undefined) this.cwd = context.cwd;
		if (context.columns !== undefined && context.columns > 0) this.columns = context.columns;
	}

	/**
	 * Supply the stdin payload lazily.
	 *
	 * A factory rather than a value because the timer fires between turns: a
	 * snapshot captured at configuration time would hand a script the context
	 * usage and quota numbers of whenever the session last had an event.
	 */
	setPayloadFactory(factory: () => Record<string, unknown>): void {
		this.payloadFactory = factory;
	}

	/** Current state of every configured item, in configuration order. */
	states(): CustomItemState[] {
		return this.items.map((item) => {
			const record = this.records.get(item.id);
			return {
				id: item.id,
				enabled: item.enabled,
				...(record?.value !== undefined ? { value: record.value } : {}),
				...(item.error !== undefined
					? { error: item.error }
					: record?.error !== undefined
						? { error: record.error }
						: {}),
				...(record?.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
				running: record?.running ?? false,
			};
		});
	}

	/** Rendered values, in order, for the items that currently have one. */
	values(): string[] {
		return this.items
			.filter((item) => item.enabled)
			.map((item) => this.records.get(item.id)?.value)
			.filter((value): value is string => value !== undefined && value.length > 0);
	}

	/** Begin ticking, if any item asked for a timer. Idempotent. */
	start(): void {
		if (this.tickHandle !== undefined) return;
		const intervals = this.items
			.filter((item) => item.enabled && item.refreshInterval !== undefined)
			.map((item) => (item.refreshInterval as number) * 1000);
		if (intervals.length === 0) return;
		const tick = Math.max(TICK_FLOOR_MS, Math.min(...intervals));
		this.tickHandle = this.schedule(() => this.refresh(), tick);
	}

	stop(): void {
		if (this.tickHandle === undefined) return;
		this.cancel(this.tickHandle);
		this.tickHandle = undefined;
	}

	/** Stop everything and abandon in-flight commands. */
	dispose(): void {
		this.stop();
		for (const record of this.records.values()) record.abort?.();
		this.records.clear();
	}

	/**
	 * Restart the timer after a configuration change, since the tick rate is
	 * derived from the items themselves.
	 */
	restartTimer(): void {
		const wasRunning = this.tickHandle !== undefined;
		this.stop();
		if (wasRunning) this.start();
	}

	/** Run every item whose throttle has elapsed. Never rejects. */
	refresh(): void {
		const now = this.now();
		for (const item of this.items) {
			if (!item.enabled || item.command === undefined) continue;
			const record = this.records.get(item.id);
			if (record?.running) continue;
			const minimum =
				item.refreshInterval !== undefined
					? Math.max(EVENT_MIN_INTERVAL_MS, item.refreshInterval * 1000)
					: EVENT_MIN_INTERVAL_MS;
			if (record !== undefined && now - record.lastAttempt < minimum) continue;
			this.run(item);
		}
	}

	private record(id: string): RunRecord {
		const existing = this.records.get(id);
		if (existing) return existing;
		const created: RunRecord = { lastAttempt: 0, failures: 0, running: false };
		this.records.set(id, created);
		return created;
	}

	private run(item: CustomItem): void {
		const command = item.command;
		if (command === undefined) return;
		const record = this.record(item.id);
		record.lastAttempt = this.now();
		record.running = true;

		const shell = platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "sh";
		const args = platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];

		let child: ReturnType<SpawnFn>;
		try {
			child = this.spawnFn(shell, args, {
				cwd: this.cwd,
				// COLUMNS is how Claude Code tells a script the width it may use;
				// keeping the name means a ported script sizes itself correctly.
				env: { ...process.env, COLUMNS: String(this.columns) },
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			this.settle(item, record, { error: error instanceof Error ? error.message : String(error) });
			return;
		}

		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (outcome: { value?: string; error?: string }): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			record.abort = undefined;
			this.settle(item, record, outcome);
		};

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			// A command ignoring SIGTERM must not outlive the session either.
			setTimeout(() => child.kill("SIGKILL"), 500).unref?.();
			finish({ error: `timed out after ${Math.round(item.timeoutMs / 100) / 10}s` });
		}, item.timeoutMs);
		timer.unref?.();

		record.abort = () => {
			clearTimeout(timer);
			settled = true;
			record.running = false;
			child.kill("SIGKILL");
		};

		child.stdout?.on("data", (chunk: Buffer | string) => {
			// One line is all that is rendered; stop accumulating well before a
			// runaway command can fill memory with output nobody will read.
			if (stdout.length < 64_000) stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			if (stderr.length < 4_000) stderr += String(chunk);
		});
		child.on("error", (error: Error) => finish({ error: error.message }));
		child.on("close", (code: number | null) => {
			if (code === 0) {
				finish({ value: sanitizeOutput(stdout) });
				return;
			}
			const detail = sanitizeOutput(stderr);
			finish({ error: detail.length > 0 ? `exit ${code ?? "?"}: ${detail}` : `exit ${code ?? "?"}` });
		});

		try {
			child.stdin?.on("error", () => {
				// A command that never reads stdin (`date`, a shell one-liner) closes
				// the pipe under us; that is not a failure of the item.
			});
			child.stdin?.end(`${JSON.stringify(this.payloadFactory())}\n`);
		} catch {
			// Same case, raised synchronously.
		}
	}

	private settle(item: CustomItem, record: RunRecord, outcome: { value?: string; error?: string }): void {
		record.running = false;
		const previous = record.value;
		if (outcome.error === undefined) {
			record.failures = 0;
			delete record.error;
			// Empty output is a deliberate "nothing to show right now", not a
			// failure: it is how a script hides itself when its subject is idle.
			record.value = outcome.value ?? "";
			record.updatedAt = this.now();
		} else {
			record.failures += 1;
			record.error = outcome.error;
			if (record.failures >= FAILURE_GRACE) delete record.value;
		}
		if (record.value !== previous) this.onChange?.();
	}
}
