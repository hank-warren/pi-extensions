import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pid } from "node:process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Remaining (not used) integer percents per provider window.
 *
 * `resetsAt` is the soonest moment any of that provider's windows rolls over,
 * as epoch milliseconds. It is what makes a cached value falsifiable: once that
 * boundary passes, the percentages describe the *previous* window and are not
 * merely old but wrong. Absent when the payload carried no usable reset time,
 * which is also what an entry written by an older statusline looks like.
 */
export interface UsageSnapshot {
	claude?: { fiveHour: number; sevenDay: number; scopedWeekly?: number };
	/**
	 * Codex reports one or two windows depending on the plan: a short (5-hour)
	 * window, a long one, or both. Every field is optional because which of them
	 * exists is a property of the account, not of the payload shape.
	 */
	codex?: { fiveHour?: number; weekly?: number };
}

/**
 * Whether a reset boundary has passed. A missing boundary never expires, which
 * is what an entry written by an older statusline looks like.
 */
function hasReset(resetsAt: number | undefined, now: number): boolean {
	return resetsAt !== undefined && now >= resetsAt;
}

/** The soonest of a set of candidate reset times, ignoring unusable ones. */
function earliestReset(candidates: (number | undefined)[]): number | undefined {
	const usable = candidates.filter((value): value is number => value !== undefined && Number.isFinite(value));
	return usable.length === 0 ? undefined : Math.min(...usable);
}

/** Anthropic reports reset times as an ISO 8601 string. */
function parseIsoReset(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/**
 * Minimum spacing between usage polls. The Anthropic usage endpoint rate-limits
 * (429) aggressively, so keep this well above a per-turn cadence.
 */
export const USAGE_REFRESH_INTERVAL_MS = 5 * 60_000;
/**
 * Minimum spacing for the Codex endpoint, which is markedly more permissive
 * than Anthropic's. OpenAI's own Codex CLI polls this exact endpoint on a
 * 60-second interval (`ChatWidget::prefetch_rate_limits`), and independent
 * community tools converge on the same figure, so matching the first-party
 * client is well inside what the endpoint expects. The two providers had
 * shared one interval purely because it was written for the stricter of them.
 */
export const CODEX_USAGE_REFRESH_INTERVAL_MS = 60_000;
/**
 * Shorter spacing used while a credentialed provider still has no value. Pi
 * refreshes an expired OAuth token only when that provider is first used, so a
 * session that starts with a stale token would otherwise show nothing for a
 * full refresh interval.
 */
export const USAGE_RETRY_INTERVAL_MS = 30_000;
/**
 * How long an account is left alone after it answers 429 *without* telling us
 * when to come back. Polls are host-wide (see the shared cache below), so a rate
 * limit means the provider itself wants a break rather than that we are racing
 * ourselves. A usable `Retry-After` always wins over this guess.
 */
export const USAGE_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
/**
 * How often a bound tracker calls itself. This is deliberately far shorter than
 * the poll interval, because a throttled `refresh()` issues no request at all:
 * it reads auth.json and the shared cache, publishes whatever another process
 * has already fetched, finds the poll gate closed, and returns. So the tick
 * costs two small local reads and buys two things the previous turn-driven
 * cadence could not — an idle session's meters keep moving, and a sibling
 * process's fresh values appear within one tick instead of at the next turn.
 * Request volume is unchanged: both throttles still gate every fetch.
 */
const USAGE_TICK_INTERVAL_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;
const ONE_DAY_SECONDS = 86_400;

function toRemaining(usedPercent: unknown): number | undefined {
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
	return Math.round(Math.min(100, Math.max(0, 100 - usedPercent)));
}

interface ClaudeLimitEntry {
	kind?: unknown;
	percent?: unknown;
	scope?: { model?: unknown } | null;
}

/**
 * Parse the Anthropic OAuth usage payload into remaining percents. Accounts
 * with a model-scoped weekly limit (e.g. Fable) expose it in the `limits`
 * array as `weekly_scoped`; accounts without one simply omit the entry.
 */
export function parseClaudeUsage(json: unknown): UsageSnapshot["claude"] | undefined {
	if (typeof json !== "object" || json === null) return undefined;
	const body = json as {
		five_hour?: { utilization?: unknown; resets_at?: unknown };
		seven_day?: { utilization?: unknown; resets_at?: unknown };
		limits?: unknown;
	};
	const fiveHour = toRemaining(body.five_hour?.utilization);
	const sevenDay = toRemaining(body.seven_day?.utilization);
	if (fiveHour === undefined || sevenDay === undefined) return undefined;
	const result: UsageSnapshot["claude"] = { fiveHour, sevenDay };
	if (Array.isArray(body.limits)) {
		const scoped = body.limits.find(
			(entry): entry is ClaudeLimitEntry =>
				typeof entry === "object" &&
				entry !== null &&
				(entry as ClaudeLimitEntry).kind === "weekly_scoped" &&
				typeof (entry as ClaudeLimitEntry).percent === "number",
		);
		const scopedWeekly = scoped === undefined ? undefined : toRemaining(scoped.percent);
		if (scopedWeekly !== undefined) result.scopedWeekly = scopedWeekly;
	}
	return result;
}

interface CodexWindow {
	used_percent?: unknown;
	limit_window_seconds?: unknown;
	/** Absolute reset, Unix seconds. Preferred over the relative form. */
	reset_at?: unknown;
	/** Relative reset, seconds from the moment the payload was produced. */
	reset_after_seconds?: unknown;
}

/** A Codex window's reset time as epoch ms, absolute form preferred. */
function codexReset(window: CodexWindow | undefined, now: number): number | undefined {
	if (window === undefined) return undefined;
	if (typeof window.reset_at === "number" && Number.isFinite(window.reset_at)) return window.reset_at * 1_000;
	const after = window.reset_after_seconds;
	return typeof after === "number" && Number.isFinite(after) ? now + after * 1_000 : undefined;
}

/** A window whose span is known, so it can be sorted into a slot. */
interface SpannedCodexWindow extends CodexWindow {
	limit_window_seconds: number;
}

/**
 * Parse the Codex usage payload into the short (sub-day) and long (≥ 1 day)
 * windows. Which ones exist depends on the plan — $20 plans report a 5-hour
 * window alongside the weekly one, larger plans have reported weekly only, and
 * free plans report a single 30-day window that lands in the long slot. So the
 * slots are filled from `limit_window_seconds` rather than from `plan_type`,
 * and an absent window simply leaves its slot empty.
 */
export function parseCodexUsage(json: unknown): UsageSnapshot["codex"] | undefined {
	const { shortest, longest } = slotCodexWindows(json);
	const fiveHour = toRemaining(shortest?.used_percent);
	const weekly = toRemaining(longest?.used_percent);
	if (fiveHour === undefined && weekly === undefined) return undefined;
	const result: UsageSnapshot["codex"] = {};
	if (fiveHour !== undefined) result.fiveHour = fiveHour;
	if (weekly !== undefined) result.weekly = weekly;
	return result;
}

/** Sort a Codex payload's windows into the short and long display slots. */
function slotCodexWindows(json: unknown): { shortest?: SpannedCodexWindow; longest?: SpannedCodexWindow } {
	if (typeof json !== "object" || json === null) return {};
	const rateLimit = (json as { rate_limit?: unknown }).rate_limit;
	if (typeof rateLimit !== "object" || rateLimit === null) return {};
	const { primary_window, secondary_window } = rateLimit as {
		primary_window?: CodexWindow | null;
		secondary_window?: CodexWindow | null;
	};
	// A window without a usable span cannot be placed in either slot.
	const windows = [primary_window, secondary_window].filter(
		(window): window is SpannedCodexWindow =>
			typeof window === "object" &&
			window !== null &&
			typeof window.limit_window_seconds === "number" &&
			Number.isFinite(window.limit_window_seconds),
	);
	return {
		shortest: windows
			.filter((window) => window.limit_window_seconds < ONE_DAY_SECONDS)
			.sort((a, b) => a.limit_window_seconds - b.limit_window_seconds)[0],
		longest: windows
			.filter((window) => window.limit_window_seconds >= ONE_DAY_SECONDS)
			.sort((a, b) => b.limit_window_seconds - a.limit_window_seconds)[0],
	};
}

/**
 * The soonest moment any window in a Claude payload rolls over, epoch ms.
 * Kept out of the parsed value on purpose: this is cache-lifetime metadata,
 * never rendered, and folding it into the display shape would make every
 * snapshot assertion carry a timestamp.
 */
export function claudeResetAt(json: unknown): number | undefined {
	if (typeof json !== "object" || json === null) return undefined;
	const body = json as { five_hour?: { resets_at?: unknown }; seven_day?: { resets_at?: unknown } };
	return earliestReset([parseIsoReset(body.five_hour?.resets_at), parseIsoReset(body.seven_day?.resets_at)]);
}

/**
 * The soonest moment any slotted Codex window rolls over, epoch ms. Needs the
 * clock because Codex may report only a relative `reset_after_seconds`.
 */
export function codexResetAt(json: unknown, now: number): number | undefined {
	const { shortest, longest } = slotCodexWindows(json);
	return earliestReset([codexReset(shortest, now), codexReset(longest, now)]);
}

/** Color band for a remaining percent: >60 green, >40 yellow, >15 orange, else red. */
export function usageBand(remaining: number): "green" | "yellow" | "orange" | "red" {
	if (remaining > 60) return "green";
	if (remaining > 40) return "yellow";
	if (remaining > 15) return "orange";
	return "red";
}

type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
	ok: boolean;
	status?: number;
	/** Optional so a caller (or a test double) may omit response headers. */
	headers?: { get(name: string): string | null };
	json(): Promise<unknown>;
}>;

/**
 * Absolute time a `Retry-After` header points at, or undefined when it is
 * absent, unparseable, or already in the past. Both forms in RFC 9110 are
 * accepted: delta-seconds (`Retry-After: 120`) and an HTTP-date.
 *
 * A value that is not in the future is deliberately discarded rather than
 * clamped to now. Anthropic's usage endpoint is documented by its users to
 * answer `retry-after: 0` while continuing to refuse requests, so obeying it
 * literally would retry straight into the limit that produced it.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const seconds = Number(trimmed);
	const at = Number.isFinite(seconds) ? now + seconds * 1_000 : Date.parse(trimmed);
	if (!Number.isFinite(at) || at <= now) return undefined;
	return at;
}

export interface UsageTrackerOptions {
	authPath?: string;
	cachePath?: string;
	fetchFn?: FetchFn;
	onChange?: () => void;
	now?: () => number;
	/** Provider id of the session's main model; selects which account is polled. */
	activeProvider?: string;
	tickIntervalMs?: number;
	schedule?: (callback: () => void, intervalMs: number) => unknown;
	cancel?: (handle: unknown) => void;
}

function defaultSchedule(callback: () => void, intervalMs: number): unknown {
	const timer = setInterval(callback, intervalMs);
	// A usage meter is cosmetic; it must never hold the process open at exit.
	(timer as { unref?: () => void }).unref?.();
	return timer;
}

function defaultCancel(handle: unknown): void {
	clearInterval(handle as ReturnType<typeof setInterval>);
}

type ProviderKey = "claude" | "codex";

const PROVIDER_KEYS = ["claude", "codex"] as const;

/** Provider ids whose additional logins (`${base}-${suffix}`) share a meter. */
const USAGE_BASE_PROVIDERS: Record<ProviderKey, string> = {
	claude: "anthropic",
	codex: "openai-codex",
};

/** Steady-state poll spacing per family; each endpoint has its own tolerance. */
const PROVIDER_REFRESH_INTERVAL_MS: Record<ProviderKey, number> = {
	claude: USAGE_REFRESH_INTERVAL_MS,
	codex: CODEX_USAGE_REFRESH_INTERVAL_MS,
};

/** Credential id polled for each family. */
type UsageAccounts = Record<ProviderKey, string>;

/** A freshly fetched value together with the boundary it is valid until. */
interface FetchedUsage<K extends ProviderKey> {
	value: NonNullable<UsageSnapshot[K]>;
	resetsAt?: number;
}

function inFamily(providerId: string | undefined, base: string): boolean {
	return providerId === base || (providerId !== undefined && providerId.startsWith(`${base}-`));
}

/** The family an account id belongs to, or undefined when it is neither. */
function familyOf(accountId: string): ProviderKey | undefined {
	return PROVIDER_KEYS.find((key) => inFamily(accountId, USAGE_BASE_PROVIDERS[key]));
}

/**
 * Choose the account whose meter each family shows.
 *
 * Additional logins (@hank-warren/pi-multi-login) mean a family can hold several
 * accounts at once. The one worth showing is the one the session is actually
 * spending: the provider of the main model. Every other family falls back to its
 * base account, which is what makes a backup provider's meter stay visible while
 * you are not using it — and what keeps a dedicated background-reviewer login
 * (never the main model) from ever being polled.
 */
export function resolveUsageAccounts(activeProvider: string | undefined): UsageAccounts {
	const accounts = { ...USAGE_BASE_PROVIDERS };
	for (const key of PROVIDER_KEYS) {
		if (inFamily(activeProvider, USAGE_BASE_PROVIDERS[key])) accounts[key] = activeProvider as string;
	}
	return accounts;
}

/** Non-reversible per-family credential fingerprints; never raw tokens. */
type ProviderIdentities = Partial<Record<ProviderKey, string>>;

function fingerprint(material: string): string {
	return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

interface AuthEntry {
	access?: unknown;
	accountId?: unknown;
}

type AuthEntries = Record<string, AuthEntry | undefined>;

/**
 * Fingerprint the credential an account would be polled with, or undefined when
 * it cannot be polled at all. Usage percentages belong to an account, so a
 * cached value is only trustworthy while the credential that produced it is
 * still the one in auth.json — after an account switch, yesterday's "1% left"
 * is somebody else's meter.
 */
function accountFingerprint(auth: AuthEntries, accountId: string): string | undefined {
	const entry = auth[accountId];
	const access = entry?.access;
	if (typeof access !== "string" || access.length === 0) return undefined;
	if (familyOf(accountId) === "codex") {
		const account = entry?.accountId;
		if (typeof account !== "string" || account.length === 0) return undefined;
		return fingerprint(`${access}\n${account}`);
	}
	return fingerprint(access);
}

function hasAuth(auth: AuthEntries, accountId: string): boolean {
	return accountFingerprint(auth, accountId) !== undefined;
}

function credentialIdentities(auth: AuthEntries, accounts: UsageAccounts): ProviderIdentities {
	const identities: ProviderIdentities = {};
	for (const key of PROVIDER_KEYS) {
		const value = accountFingerprint(auth, accounts[key]);
		if (value !== undefined) identities[key] = value;
	}
	return identities;
}

/** One account's shared poll state. Only the family's own field is ever set. */
interface UsageAccountEntry {
	/** Credential fingerprint the stored values were fetched with. */
	identity: string;
	/**
	 * Epoch ms at which the soonest window in the stored value rolls over. Past
	 * it the percentages describe the previous window, so they are wrong rather
	 * than merely old. Absent on entries written before this existed.
	 */
	resetsAt?: number;
	/** Last time any process started a poll for this account. */
	attemptedAt: number;
	/** Absolute time before which a rate-limited account must not be polled. */
	backoff?: number;
	claude?: UsageSnapshot["claude"];
	codex?: UsageSnapshot["codex"];
}

/**
 * Host-wide poll state shared by every pi process. Usage percentages are a
 * property of the account, not of a session, so one poll per interval per
 * account is both sufficient and necessary: a busy host runs dozens of pi
 * processes, and per-process polling stampedes the endpoints into rate limiting
 * everyone.
 *
 * Keyed by credential id rather than by family, because two sessions on the
 * same host may legitimately be using two different Anthropic accounts. Keying
 * by family made each of them look like an account switch to the other, so they
 * evicted each other's values and re-polled on every cycle — the exact
 * stampede this cache exists to prevent.
 */
interface UsageCache {
	accounts: Record<string, UsageAccountEntry>;
}

const EMPTY_CACHE: UsageCache = { accounts: {} };

/**
 * Drop entries whose credential no longer matches auth.json. A token rotation
 * looks the same as an account switch here; the cost of treating it as one is a
 * single immediate re-poll, while trusting a stale identity means showing
 * another account's numbers as if they were current. Logged-out accounts fail
 * the same check, so the file garbage-collects itself.
 */
function pruneCache(cache: UsageCache, auth: AuthEntries): UsageCache {
	const accounts: Record<string, UsageAccountEntry> = {};
	let changed = false;
	for (const [accountId, entry] of Object.entries(cache.accounts)) {
		if (accountFingerprint(auth, accountId) === entry.identity) accounts[accountId] = entry;
		else changed = true;
	}
	return changed ? { accounts } : cache;
}

function parseUsageCache(json: unknown): UsageCache | undefined {
	if (typeof json !== "object" || json === null) return undefined;
	const rawAccounts = (json as { accounts?: unknown }).accounts;
	if (typeof rawAccounts !== "object" || rawAccounts === null) return undefined;
	const accounts: Record<string, UsageAccountEntry> = {};
	for (const [accountId, value] of Object.entries(rawAccounts as Record<string, unknown>)) {
		if (typeof value !== "object" || value === null) continue;
		const body = value as Record<string, unknown>;
		if (typeof body.identity !== "string") continue;
		if (typeof body.attemptedAt !== "number" || !Number.isFinite(body.attemptedAt)) continue;
		const entry: UsageAccountEntry = { identity: body.identity, attemptedAt: body.attemptedAt };
		if (typeof body.backoff === "number" && Number.isFinite(body.backoff)) entry.backoff = body.backoff;
		if (typeof body.resetsAt === "number" && Number.isFinite(body.resetsAt)) entry.resetsAt = body.resetsAt;
		if (typeof body.claude === "object" && body.claude !== null) entry.claude = body.claude as UsageSnapshot["claude"];
		if (typeof body.codex === "object" && body.codex !== null) entry.codex = body.codex as UsageSnapshot["codex"];
		accounts[accountId] = entry;
	}
	return { accounts };
}

/**
 * Best-effort subscription usage poller. Reads Pi's auth.json for tokens (never
 * refreshes them), fetches both usage endpoints, and keeps the last-known good
 * value per account. Refreshes are throttled and must never throw.
 */
export class UsageTracker {
	private readonly authPath: string;
	private readonly cachePath: string;
	private readonly fetchFn: FetchFn;
	private readonly onChange?: () => void;
	private readonly now: () => number;
	private current: UsageSnapshot = {};
	/** Reset boundary of each value in `current`, so it can expire in place. */
	private currentResets: Partial<Record<ProviderKey, number>> = {};
	private identities: ProviderIdentities = {};
	private activeProvider: string | undefined;
	private awaitingProvider = true;
	/** Families that answered 429 this cycle, mapped to their `Retry-After`. */
	private readonly rateLimited = new Map<ProviderKey, number | undefined>();
	private lastAttempt: Record<string, number> = {};
	private inFlight: Promise<void> | undefined;
	private readonly tickIntervalMs: number;
	private readonly schedule: (callback: () => void, intervalMs: number) => unknown;
	private readonly cancel: (handle: unknown) => void;
	private tickHandle: unknown;

	constructor(options: UsageTrackerOptions = {}) {
		// getAgentDir(), not ~/.pi/agent: pi honours PI_CODING_AGENT_DIR, and a
		// hardcoded home path made a session pointed at another agent dir read the
		// wrong credentials and write its usage cache into the host's real one.
		this.authPath = options.authPath ?? join(getAgentDir(), "auth.json");
		this.cachePath = options.cachePath ?? join(getAgentDir(), "statusline-usage.json");
		this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
		this.onChange = options.onChange;
		this.now = options.now ?? Date.now;
		this.activeProvider = options.activeProvider;
		this.tickIntervalMs = options.tickIntervalMs ?? USAGE_TICK_INTERVAL_MS;
		this.schedule = options.schedule ?? defaultSchedule;
		this.cancel = options.cancel ?? defaultCancel;
	}

	snapshot(): UsageSnapshot {
		return this.current;
	}

	/**
	 * Begin ticking. Idempotent, so the caller may start from whichever lifecycle
	 * event happens first without tracking whether it already did.
	 */
	start(): void {
		if (this.tickHandle !== undefined) return;
		this.tickHandle = this.schedule(() => {
			// refresh() swallows its own failures and no-ops while one is in flight.
			void this.refresh();
		}, this.tickIntervalMs);
	}

	/** Stop ticking. Safe to call when never started, and leaves values in place. */
	stop(): void {
		if (this.tickHandle === undefined) return;
		this.cancel(this.tickHandle);
		this.tickHandle = undefined;
	}

	/**
	 * Point the meters at the session's main model. A switch between two accounts
	 * in the same family changes which one is displayed; the next refresh adopts
	 * the new account's cached value if there is one, and polls otherwise.
	 */
	setActiveProvider(providerId: string | undefined): void {
		this.activeProvider = providerId;
	}

	/**
	 * Interval until the next allowed attempt for one family: the short retry
	 * window while a credentialed provider is still missing a value, that
	 * family's own steady-state interval otherwise.
	 */
	private currentInterval(key: ProviderKey): number {
		return this.awaitingProvider ? USAGE_RETRY_INTERVAL_MS : PROVIDER_REFRESH_INTERVAL_MS[key];
	}

	/** Throttled refresh; resolves when the current attempt (if any) settles. */
	refresh(): Promise<void> {
		if (this.inFlight) return this.inFlight;
		const attempt = this.performRefresh()
			.catch(() => {
				// Usage display is best-effort and must never interrupt the agent.
			})
			.finally(() => {
				if (this.inFlight === attempt) this.inFlight = undefined;
			});
		this.inFlight = attempt;
		return attempt;
	}

	/**
	 * One refresh cycle: adopt whatever another process has already published for
	 * the selected accounts, then poll only those the shared throttle allows.
	 */
	private async performRefresh(): Promise<void> {
		const auth = (await this.readAuth()) ?? {};
		const accounts = resolveUsageAccounts(this.activeProvider);
		const identity = credentialIdentities(auth, accounts);
		const cache = pruneCache((await this.readCache()) ?? EMPTY_CACHE, auth);
		this.pruneCurrent(identity, accounts);
		// Another process's values are as good as ours and cost no request, so a new
		// session — or a switch back to an account polled earlier — shows real
		// numbers on its very first render.
		const now = this.now();
		this.publish(this.merge(...cachedSnapshot(cache, accounts, now), auth, accounts, now), auth, accounts, cache);

		const pollable: Partial<Record<ProviderKey, string>> = {};
		for (const key of PROVIDER_KEYS) {
			const accountId = accounts[key];
			if (!hasAuth(auth, accountId)) continue;
			const entry = cache.accounts[accountId];
			// A backoff outranks everything: a rate-limited endpoint does not want to
			// hear from us at a window boundary either.
			if (now < (entry?.backoff ?? Number.NEGATIVE_INFINITY)) continue;
			const lastAttempt = Math.max(
				this.lastAttempt[accountId] ?? Number.NEGATIVE_INFINITY,
				entry?.attemptedAt ?? Number.NEGATIVE_INFINITY,
			);
			// Past a window boundary the stored percentages are wrong rather than
			// merely old, so the interval is skipped to republish promptly — but only
			// for a boundary we have not already answered. A failed poll leaves the
			// boundary in the past, so an unconditional override would poll on every
			// tick for as long as the failure lasted. A 429 sets a backoff that stops
			// that; a 500, a timeout or a dropped connection does not. Answering each
			// boundary once hands the account back to the ordinary intervals, which
			// for a provider now holding no value is the short retry window.
			const boundary = entry?.resetsAt;
			const boundaryUnanswered = hasReset(boundary, now) && (boundary as number) > lastAttempt;
			if (!boundaryUnanswered && now - lastAttempt < this.currentInterval(key)) continue;
			pollable[key] = accountId;
		}
		if (pollable.claude === undefined && pollable.codex === undefined) return;

		// Claim each slot before fetching so sibling processes skip this window even
		// if our own request is slow or fails outright. The claim carries the fresh
		// identity so siblings do not re-prune and stampede the same window.
		const claimed = { ...cache.accounts };
		for (const key of PROVIDER_KEYS) {
			const accountId = pollable[key];
			if (accountId === undefined) continue;
			this.lastAttempt[accountId] = now;
			claimed[accountId] = {
				...claimed[accountId],
				identity: identity[key] as string,
				attemptedAt: now,
			};
		}
		await this.writeCache({ accounts: claimed });

		const [claudeResult, codexResult] = await Promise.all([
			pollable.claude === undefined ? Promise.resolve(undefined) : this.fetchClaude(auth, pollable.claude),
			pollable.codex === undefined ? Promise.resolve(undefined) : this.fetchCodex(auth, pollable.codex),
		]);
		const claude = claudeResult?.value;
		const codex = codexResult?.value;
		const incomingResets: Partial<Record<ProviderKey, number>> = {};
		if (claudeResult?.resetsAt !== undefined) incomingResets.claude = claudeResult.resetsAt;
		if (codexResult?.resetsAt !== undefined) incomingResets.codex = codexResult.resetsAt;

		const updatedAccounts = { ...claimed };
		for (const key of PROVIDER_KEYS) {
			const accountId = pollable[key];
			if (accountId === undefined) continue;
			const entry: UsageAccountEntry = { ...(updatedAccounts[accountId] as UsageAccountEntry) };
			const value = key === "claude" ? claude : codex;
			// A `Retry-After` we could use is authoritative; the flat window is only a
			// guess for a 429 that told us nothing. Deliberately a plain assignment:
			// the poll gate above skips any account whose backoff is still in the
			// future, so a value we are about to overwrite is necessarily absent or
			// already expired, and a monotonic max() here would never do anything.
			if (this.rateLimited.has(key)) {
				entry.backoff = this.rateLimited.get(key) ?? now + USAGE_RATE_LIMIT_BACKOFF_MS;
			}
			else if (value !== undefined) delete entry.backoff;
			// A failed fetch leaves the last-known value in place rather than blanking
			// the meter for whatever caused one bad response.
			if (claude !== undefined && key === "claude") entry.claude = claude;
			if (codex !== undefined && key === "codex") entry.codex = codex;
			// The boundary travels with the value it describes: a refreshed value gets
			// the new window, and one that arrived without a usable reset must not
			// inherit the previous window's.
			if (value !== undefined) {
				const resetsAt = incomingResets[key];
				if (resetsAt === undefined) delete entry.resetsAt;
				else entry.resetsAt = resetsAt;
			}
			updatedAccounts[accountId] = entry;
		}
		this.rateLimited.clear();

		const updated: UsageCache = { accounts: updatedAccounts };
		this.publish(this.merge({ claude, codex }, incomingResets, auth, accounts, now), auth, accounts, updated);
		await this.writeCache(updated);
	}

	/**
	 * Drop in-memory values fetched with previous credentials so merge() cannot
	 * resurrect another account's numbers, and let the changed identity reopen
	 * this process's own throttle gate for the newly selected account.
	 */
	private pruneCurrent(identity: ProviderIdentities, accounts: UsageAccounts): void {
		const changedKeys = PROVIDER_KEYS.filter((key) => this.identities[key] !== identity[key]);
		this.identities = identity;
		if (changedKeys.length === 0) return;
		for (const key of changedKeys) delete this.lastAttempt[accounts[key]];
		for (const key of changedKeys) delete this.currentResets[key];
		if (!changedKeys.some((key) => this.current[key] !== undefined)) return;
		const next = { ...this.current };
		for (const key of changedKeys) delete next[key];
		this.current = next;
		// snapshot() changed even if the upcoming publish() sees no further delta.
		this.onChange?.();
	}

	/**
	 * Layer fresh values over the last-known ones and drop families whose selected
	 * account has no credentials: a logged-out account must disappear immediately,
	 * while a failed fetch keeps whatever we last saw.
	 */
	private merge(
		incoming: UsageSnapshot,
		incomingResets: Partial<Record<ProviderKey, number>>,
		auth: AuthEntries,
		accounts: UsageAccounts,
		now: number,
	): { snapshot: UsageSnapshot; resets: Partial<Record<ProviderKey, number>> } {
		const snapshot: UsageSnapshot = {};
		const resets: Partial<Record<ProviderKey, number>> = {};
		for (const key of PROVIDER_KEYS) {
			if (!hasAuth(auth, accounts[key])) continue;
			if (incoming[key] !== undefined) {
				// biome-ignore lint/suspicious/noExplicitAny: one assignment, two value shapes.
				snapshot[key] = incoming[key] as any;
				if (incomingResets[key] !== undefined) resets[key] = incomingResets[key];
				continue;
			}
			// A last-known-good value survives a failed fetch, but not the rollover of
			// the window it describes.
			if (this.current[key] === undefined || hasReset(this.currentResets[key], now)) continue;
			// biome-ignore lint/suspicious/noExplicitAny: one assignment, two value shapes.
			snapshot[key] = this.current[key] as any;
			if (this.currentResets[key] !== undefined) resets[key] = this.currentResets[key];
		}
		return { snapshot, resets };
	}

	/** Adopt a snapshot, recompute the retry gate, and repaint only on a change. */
	private publish(
		merged: { snapshot: UsageSnapshot; resets: Partial<Record<ProviderKey, number>> },
		auth: AuthEntries,
		accounts: UsageAccounts,
		cache: UsageCache,
	): void {
		const next = merged.snapshot;
		// Boundaries follow their values even when the percentages are unchanged, so
		// a refreshed window cannot be judged against the previous one's deadline.
		this.currentResets = merged.resets;
		const now = this.now();
		// An account serving 429s is not "pending": retrying it faster is exactly
		// what got us rate limited, so it must not hold the short window open.
		this.awaitingProvider = PROVIDER_KEYS.some(
			(key) =>
				hasAuth(auth, accounts[key]) &&
				next[key] === undefined &&
				now >= (cache.accounts[accounts[key]]?.backoff ?? 0),
		);
		if (JSON.stringify(next) === JSON.stringify(this.current)) return;
		this.current = next;
		this.onChange?.();
	}

	private async readCache(): Promise<UsageCache | undefined> {
		try {
			return parseUsageCache(JSON.parse(await readFile(this.cachePath, "utf8")));
		} catch {
			return undefined;
		}
	}

	/** Atomic write; a lost race just costs one extra poll, never a corrupt file. */
	private async writeCache(cache: UsageCache): Promise<void> {
		const temporary = `${this.cachePath}.${pid}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
			await rename(temporary, this.cachePath);
		} catch {
			// The cache is an optimisation; failing to share it must never surface.
		}
	}

	private async readAuth(): Promise<AuthEntries | undefined> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.authPath, "utf8"));
			if (typeof parsed !== "object" || parsed === null) return undefined;
			return parsed as AuthEntries;
		} catch {
			return undefined;
		}
	}

	private async fetchJson(url: string, headers: Record<string, string>, provider: ProviderKey): Promise<unknown> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const response = await this.fetchFn(url, { headers, signal: controller.signal });
			if (response.status === 429) {
				this.rateLimited.set(provider, parseRetryAfter(response.headers?.get("retry-after"), this.now()));
			}
			if (!response.ok) return undefined;
			return await response.json();
		} finally {
			clearTimeout(timeout);
		}
	}

	private async fetchClaude(auth: AuthEntries, accountId: string): Promise<FetchedUsage<"claude"> | undefined> {
		const access = auth[accountId]?.access;
		if (typeof access !== "string" || access.length === 0) return undefined;
		try {
			const json = await this.fetchJson(
				CLAUDE_USAGE_URL,
				{ Authorization: `Bearer ${access}`, "anthropic-beta": "oauth-2025-04-20" },
				"claude",
			);
			const value = parseClaudeUsage(json);
			return value === undefined ? undefined : { value, resetsAt: claudeResetAt(json) };
		} catch {
			return undefined;
		}
	}

	private async fetchCodex(auth: AuthEntries, accountId: string): Promise<FetchedUsage<"codex"> | undefined> {
		const entry = auth[accountId];
		const access = entry?.access;
		const account = entry?.accountId;
		if (typeof access !== "string" || typeof account !== "string" || !access || !account) return undefined;
		try {
			const json = await this.fetchJson(
				CODEX_USAGE_URL,
				{ Authorization: `Bearer ${access}`, "chatgpt-account-id": account },
				"codex",
			);
			const value = parseCodexUsage(json);
			// Codex may report only a relative reset, which is meaningless without the
			// clock the rest of the tracker runs on.
			return value === undefined ? undefined : { value, resetsAt: codexResetAt(json, this.now()) };
		} catch {
			return undefined;
		}
	}
}

/**
 * The cached values for the currently selected accounts, in display shape.
 * Values whose window has already rolled are dropped: adopting another
 * process's stale reading is exactly as wrong as keeping our own.
 */
function cachedSnapshot(
	cache: UsageCache,
	accounts: UsageAccounts,
	now: number,
): [UsageSnapshot, Partial<Record<ProviderKey, number>>] {
	const snapshot: UsageSnapshot = {};
	const resets: Partial<Record<ProviderKey, number>> = {};
	const claudeEntry = cache.accounts[accounts.claude];
	const codexEntry = cache.accounts[accounts.codex];
	if (claudeEntry?.claude && !hasReset(claudeEntry.resetsAt, now)) {
		snapshot.claude = claudeEntry.claude;
		if (claudeEntry.resetsAt !== undefined) resets.claude = claudeEntry.resetsAt;
	}
	if (codexEntry?.codex && !hasReset(codexEntry.resetsAt, now)) {
		snapshot.codex = codexEntry.codex;
		if (codexEntry.resetsAt !== undefined) resets.codex = codexEntry.resetsAt;
	}
	return [snapshot, resets];
}
