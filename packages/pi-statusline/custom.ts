import { spawn as nodeSpawn } from "node:child_process";
import { platform } from "node:process";

/**
 * User-defined statusline segments, modelled on Claude Code's `statusLine`.
 *
 * An item's value comes from one of two places. The original is a **shell
 * command** that receives a JSON snapshot of the session on stdin and prints
 * one line to stdout — deliberately Claude Code's contract, so an existing
 * statusline script mostly ports over; the differences are that pi renders each
 * item as one *segment* of line 1 rather than owning the whole row, and that
 * the payload's usage numbers are remaining percentages (see the README).
 *
 * The second is a **function another extension registers** over `pi.events`,
 * which gets the same payload as an object and returns the same one line. That
 * exists because a command forces anything serious onto PATH, into a config
 * file outside any package, and into a process spawn per refresh, for a value
 * the host could compute in-process. Both kinds run through one scheduler here:
 * there is no second code path for turn ends, intervals, overlap, timeouts or
 * the failure grace.
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
/** Longest rendered value kept from an item, before the line is truncated. */
export const MAX_OUTPUT_WIDTH = 120;

/**
 * The event pi-statusline emits to collect items from other extensions.
 *
 * This name is the entire coupling between the statusline and a provider:
 * nothing here imports a provider, and a provider imports nothing from here.
 * Changing the string is a breaking change for every provider in the wild.
 */
export const CUSTOM_ITEMS_REQUEST_EVENT = "pi-statusline:custom-items:request";

/**
 * A registered item's value function.
 *
 * `payload` is the object the command path serialises onto stdin, built fresh
 * for each run. `signal` aborts at the item's timeout; a run that ignores it is
 * simply not awaited past the deadline. Returning `null`/`undefined`/`""` hides
 * the item, and throwing is a failure, counted exactly like a non-zero exit.
 */
export type CustomItemRun = (
	payload: Record<string, unknown>,
	signal: AbortSignal,
) => string | null | undefined | Promise<string | null | undefined>;

/** What a provider passes to `register`. */
export interface CustomItemRegistration {
	/** Stable name, in the same namespace as a command item's `id`. */
	id: string;
	run: CustomItemRun;
	/** Seconds between forced re-runs; the settings entry wins when it names one. */
	refreshInterval?: number;
	/** Milliseconds before the run is abandoned; capped at {@link MAX_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/** The payload of {@link CUSTOM_ITEMS_REQUEST_EVENT}. */
export interface CustomItemsRequest {
	register(registration: CustomItemRegistration): void;
}

/** Shown for an entry that names no command and has no registration yet. */
export const UNBOUND_ERROR = "no command; waiting for an extension to register this id";
/**
 * Shown when an id is claimed by both a command entry and a registration.
 *
 * The command keeps running: the file is the user's, and an extension must not
 * be able to take over a row somebody wrote by hand. Saying so is the whole
 * remedy — deleting either side resolves it.
 */
export const COLLISION_ERROR = "id also provided by an extension \u2014 remove one";

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
	/** Where the value comes from; drives the `(extension)` tag in the submenu. */
	kind: "command" | "extension";
	/** Absent for an extension item, or when the entry is not runnable. */
	command?: string;
	/** Bound from a registration; absent until a provider claims this id. */
	run?: CustomItemRun;
	/** Seconds between forced re-runs. Absent means event-driven only. */
	refreshInterval?: number;
	timeoutMs: number;
	/**
	 * Whether `timeoutMs` came from the entry's own `timeout` rather than from a
	 * default. A registration may only supply the timeout the file left unsaid.
	 */
	timeoutExplicit?: boolean;
	/** Why this entry cannot run, shown in the `/statusline` submenu. */
	error?: string;
	/**
	 * Set when the entry can never run as written — not an object, or a `type`
	 * this version does not implement. The submenu refuses to enable those, and
	 * only those: an entry still waiting for its provider is perfectly valid.
	 */
	blocked?: boolean;
	/** The on-disk entry, preserved for round-tripping. Absent when synthesised. */
	source?: unknown;
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
			items.push({
				id,
				enabled: false,
				kind: "command",
				timeoutMs: DEFAULT_TIMEOUT_MS,
				error: "not an object",
				blocked: true,
				source: entry,
			});
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
		const base = {
			id,
			enabled,
			timeoutMs,
			source: entry,
			...(timeoutSeconds === undefined ? {} : { timeoutExplicit: true }),
			...(refreshInterval ? { refreshInterval } : {}),
		};
		// Claude Code's `statusLine` carries `type: "command"`, so a pasted entry
		// may too. `"extension"` is this package's own, and optional: an entry with
		// no command is an extension slot whether or not it says so. Any other value
		// is not a mistake this version can judge, so the entry is kept and flagged
		// rather than run or dropped.
		const hasCommand = typeof entry.command === "string" && entry.command.trim().length > 0;
		const type = entry.type ?? (hasCommand ? "command" : "extension");
		if (type !== "command" && type !== "extension") {
			items.push({
				...base,
				kind: "command",
				enabled: false,
				error: `unsupported type: ${String(type)}`,
				blocked: true,
			});
			return;
		}
		if (!hasCommand) {
			// Not an error yet: a provider may register this id later in the session,
			// and the entry is what reserves its position and enabled state.
			items.push({ ...base, kind: "extension", error: UNBOUND_ERROR });
			return;
		}
		if (type === "extension") {
			items.push({
				...base,
				kind: "command",
				enabled: false,
				error: "an extension item must not name a command",
				blocked: true,
			});
			return;
		}
		items.push({ ...base, kind: "command", command: entry.command as string });
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
	// A registration with no entry of its own has no on-disk form until the user
	// toggles it, which is what creates the entry; it must never be written here.
	return items.filter((item) => item.source !== undefined).map((item) => {
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
	/** Where the value comes from, for the submenu's `(extension)` tag. */
	kind: "command" | "extension";
	/** Sanitized first line of output; absent when there is nothing to show. */
	value?: string;
	/** Configuration or run failure, whichever applies. */
	error?: string;
	/**
	 * True when `error` describes the entry itself rather than its last run. A
	 * configuration problem outranks "disabled" in the submenu, because the item
	 * is off *because* of it; a run failure does not.
	 */
	configError?: boolean;
	/** True when the entry can never run as written, so it must not be enabled. */
	blocked?: boolean;
	/** When the value was produced, as epoch ms. */
	updatedAt?: number;
	running: boolean;
}

export type SpawnFn = typeof nodeSpawn;

export interface CustomItemsTrackerOptions {
	spawn?: SpawnFn;
	now?: () => number;
	onChange?: () => void;
	/**
	 * Called after a registration is accepted. The tracker cannot know whether
	 * the footer is live or whether items are switched on, so the extension does
	 * the timer and refresh work and this is the notification that it is needed.
	 */
	onRegister?: () => void;
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
	/** Entries exactly as configured on disk. */
	private configured: CustomItem[] = [];
	/** Registrations by id, in the order providers claimed them. */
	private readonly registrations = new Map<string, CustomItemRegistration>();
	/** The two merged: what actually renders and runs. */
	private items: CustomItem[] = [];
	private readonly records = new Map<string, RunRecord>();
	private readonly spawnFn: SpawnFn;
	private readonly now: () => number;
	private readonly onChange?: () => void;
	private readonly onRegister?: () => void;
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
		this.onRegister = options.onRegister;
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
		this.configured = [...items];
		this.recompute();
	}

	/**
	 * Adopt an item provided by another extension.
	 *
	 * Idempotent on id and deliberately silent about bad input: this runs inside
	 * a provider's event handler, where a throw would be reported as that
	 * extension failing rather than as a registration this one refused.
	 */
	register(registration: CustomItemRegistration): void {
		const id = typeof registration?.id === "string" ? registration.id.trim() : "";
		if (id.length === 0 || typeof registration.run !== "function") return;
		// A re-registration replaces the function, so whatever the old one is doing
		// is already obsolete; its record keeps the last good value so the footer
		// does not blink while the new one produces its first.
		if (this.registrations.has(id)) this.records.get(id)?.abort?.();
		this.registrations.set(id, {
			id,
			run: registration.run,
			...(positiveSeconds(registration.refreshInterval) === undefined
				? {}
				: { refreshInterval: registration.refreshInterval }),
			...(typeof registration.timeoutMs === "number" && Number.isFinite(registration.timeoutMs) && registration.timeoutMs > 0
				? { timeoutMs: Math.min(registration.timeoutMs, MAX_TIMEOUT_MS) }
				: {}),
		});
		this.recompute();
		this.onRegister?.();
	}

	/**
	 * Merge configured entries with registrations.
	 *
	 * The file owns order and enabled; a registration fills in the value function
	 * and any field the file left unsaid. An id in both a command entry and a
	 * registration is a conflict the user has to resolve, so it is shown rather
	 * than decided silently — and the command, being the thing they wrote, wins.
	 */
	private recompute(): void {
		const configuredIds = new Set(this.configured.map((item) => item.id));
		const items = this.configured.map((item) => {
			const registration = this.registrations.get(item.id);
			if (item.blocked === true) return item;
			if (item.command !== undefined) {
				return registration === undefined ? item : { ...item, error: COLLISION_ERROR };
			}
			if (registration === undefined) return item;
			const { error: _unbound, ...bound } = item;
			return {
				...bound,
				kind: "extension" as const,
				run: registration.run,
				...(item.refreshInterval ?? registration.refreshInterval
					? { refreshInterval: item.refreshInterval ?? registration.refreshInterval }
					: {}),
				timeoutMs: item.timeoutExplicit ? item.timeoutMs : (registration.timeoutMs ?? DEFAULT_TIMEOUT_MS),
			};
		});
		for (const [id, registration] of this.registrations) {
			if (configuredIds.has(id)) continue;
			// No entry claims this id, so it is appended, switched on, and has no
			// `source`: nothing is written to the settings file until it is toggled.
			items.push({
				id,
				enabled: true,
				kind: "extension",
				run: registration.run,
				...(registration.refreshInterval ? { refreshInterval: registration.refreshInterval } : {}),
				timeoutMs: registration.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			});
		}
		this.items = items;
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
				kind: item.kind,
				...(item.blocked === true ? { blocked: true } : {}),
				...(record?.value !== undefined ? { value: record.value } : {}),
				...(item.error !== undefined
					? { error: item.error, configError: true }
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

	/**
	 * Stop everything and abandon in-flight runs.
	 *
	 * Registrations survive: this also fires when the footer is torn down, and a
	 * provider has no way to hear about that to register again. They die with the
	 * extension instance instead, which is when the next request event is sent.
	 */
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
			if (!item.enabled) continue;
			if (item.command === undefined && item.run === undefined) continue;
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
		if (item.run !== undefined) {
			this.runRegistered(item, item.run);
			return;
		}
		this.runCommand(item);
	}

	/** How long an item may run, rendered the way both paths report a timeout. */
	private timeoutLabel(item: CustomItem): string {
		return `timed out after ${Math.round(item.timeoutMs / 100) / 10}s`;
	}

	/**
	 * Run a registered function under the command path's guarantees.
	 *
	 * The deadline is the tracker's, not the provider's: `signal` asks it to stop
	 * and the outcome is settled regardless, so a provider that ignores the
	 * signal costs a leaked promise rather than a stuck segment.
	 */
	private runRegistered(item: CustomItem, run: CustomItemRun): void {
		const record = this.record(item.id);
		record.lastAttempt = this.now();
		record.running = true;

		const controller = new AbortController();
		let settled = false;
		const finish = (outcome: { value?: string; error?: string }): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			record.abort = undefined;
			this.settle(item, record, outcome);
		};

		const timer = setTimeout(() => {
			controller.abort();
			finish({ error: this.timeoutLabel(item) });
		}, item.timeoutMs);
		timer.unref?.();

		record.abort = () => {
			clearTimeout(timer);
			settled = true;
			record.running = false;
			controller.abort();
		};

		let result: ReturnType<CustomItemRun>;
		try {
			result = run(this.payloadFactory(), controller.signal);
		} catch (error) {
			finish({ error: error instanceof Error ? error.message : String(error) });
			return;
		}
		Promise.resolve(result).then(
			(value) => finish({ value: value === null || value === undefined ? "" : sanitizeOutput(String(value)) }),
			(error: unknown) => finish({ error: error instanceof Error ? error.message : String(error) }),
		);
	}

	private runCommand(item: CustomItem): void {
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
			finish({ error: this.timeoutLabel(item) });
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
