import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { renderStatusline, renderUsageSegment } from "../index.ts";
import {
	CODEX_USAGE_REFRESH_INTERVAL_MS,
	claudeResetAt,
	codexResetAt,
	parseClaudeUsage,
	parseCodexUsage,
	parseRetryAfter,
	resolveUsageAccounts,
	usageBand,
	USAGE_RATE_LIMIT_BACKOFF_MS,
	USAGE_REFRESH_INTERVAL_MS,
	USAGE_RETRY_INTERVAL_MS,
	UsageTracker,
	type UsageTrackerOptions,
} from "../usage.ts";

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");

const claudePayload = {
	five_hour: { utilization: 3.0, resets_at: "2026-08-14T00:29:59+00:00" },
	seven_day: { utilization: 46.0, resets_at: "2026-08-17T07:59:59+00:00" },
	limits: [
		{ kind: "session", group: "session", percent: 3, severity: "normal", scope: null, is_active: false },
		{ kind: "weekly_all", group: "weekly", percent: 46, severity: "normal", scope: null, is_active: false },
	],
};

const claudeScopedPayload = {
	...claudePayload,
	limits: [
		...claudePayload.limits,
		{
			kind: "weekly_scoped",
			group: "weekly",
			percent: 76,
			severity: "warning",
			scope: { model: { id: null, display_name: "Fable" }, surface: null },
			is_active: true,
		},
	],
};

/** A plan with no 5-hour limit: one weekly window and nothing else. */
const codexWeeklyOnlyPayload = {
	plan_type: "pro",
	rate_limit: {
		primary_window: { used_percent: 93, limit_window_seconds: 604_800, reset_after_seconds: 433_605 },
		secondary_window: null,
	},
};

const codexPlusPayload = {
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 20, limit_window_seconds: 18_000 },
		secondary_window: { used_percent: 55, limit_window_seconds: 604_800 },
	},
};

/** Transcribed from a live team account: a 5-hour window plus a weekly one. */
const codexDualPayload = {
	plan_type: "team",
	rate_limit: {
		primary_window: { used_percent: 8, limit_window_seconds: 18_000, reset_after_seconds: 14_716 },
		secondary_window: { used_percent: 1, limit_window_seconds: 604_800, reset_after_seconds: 601_516 },
	},
};

/** Transcribed from a live free account: a single 30-day window. */
const codexFreePayload = {
	plan_type: "free",
	rate_limit: {
		primary_window: { used_percent: 100, limit_window_seconds: 2_592_000, reset_after_seconds: 1_992_123 },
		secondary_window: null,
	},
};

test("parseClaudeUsage converts utilization to remaining percents", () => {
	assert.deepEqual(parseClaudeUsage(claudePayload), { fiveHour: 97, sevenDay: 54 });
});

test("parseClaudeUsage includes the model-scoped weekly limit when present", () => {
	assert.deepEqual(parseClaudeUsage(claudeScopedPayload), { fiveHour: 97, sevenDay: 54, scopedWeekly: 24 });
});

test("parseClaudeUsage omits scopedWeekly without a weekly_scoped entry or limits array", () => {
	assert.equal(parseClaudeUsage(claudePayload)?.scopedWeekly, undefined);
	assert.equal(
		parseClaudeUsage({ five_hour: { utilization: 3 }, seven_day: { utilization: 46 } })?.scopedWeekly,
		undefined,
	);
	assert.equal(
		parseClaudeUsage({ ...claudeScopedPayload, limits: [{ kind: "weekly_scoped", percent: "76" }] })?.scopedWeekly,
		undefined,
	);
});

test("parseClaudeUsage clamps out-of-range utilization", () => {
	assert.deepEqual(
		parseClaudeUsage({ five_hour: { utilization: 120 }, seven_day: { utilization: -5 } }),
		{ fiveHour: 0, sevenDay: 100 },
	);
});

test("parseClaudeUsage rejects malformed payloads", () => {
	assert.equal(parseClaudeUsage(undefined), undefined);
	assert.equal(parseClaudeUsage(null), undefined);
	assert.equal(parseClaudeUsage({}), undefined);
	assert.equal(parseClaudeUsage({ five_hour: { utilization: 3 } }), undefined);
	assert.equal(parseClaudeUsage({ five_hour: { utilization: "3" }, seven_day: { utilization: 46 } }), undefined);
});

test("parseCodexUsage reads both windows when the plan has a 5-hour limit", () => {
	assert.deepEqual(parseCodexUsage(codexDualPayload), { fiveHour: 92, weekly: 99 });
	assert.deepEqual(parseCodexUsage(codexPlusPayload), { fiveHour: 80, weekly: 45 });
});

test("parseCodexUsage omits fiveHour on a plan with only a weekly window", () => {
	assert.deepEqual(parseCodexUsage(codexWeeklyOnlyPayload), { weekly: 7 });
	assert.equal(parseCodexUsage(codexWeeklyOnlyPayload)?.fiveHour, undefined);
});

test("parseCodexUsage treats a free plan's 30-day window as the long window", () => {
	assert.deepEqual(parseCodexUsage(codexFreePayload), { weekly: 0 });
});

test("parseCodexUsage reports a lone sub-day window as fiveHour, not weekly", () => {
	assert.deepEqual(
		parseCodexUsage({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } } }),
		{ fiveHour: 90 },
	);
});

test("parseCodexUsage picks the shortest sub-day and the longest multi-day window", () => {
	assert.deepEqual(
		parseCodexUsage({
			rate_limit: {
				primary_window: { used_percent: 20, limit_window_seconds: 18_000 },
				secondary_window: { used_percent: 40, limit_window_seconds: 3_600 },
			},
		}),
		{ fiveHour: 60 },
		"the 1-hour window wins the short slot",
	);
	assert.deepEqual(
		parseCodexUsage({
			rate_limit: {
				primary_window: { used_percent: 20, limit_window_seconds: 604_800 },
				secondary_window: { used_percent: 40, limit_window_seconds: 2_592_000 },
			},
		}),
		{ weekly: 60 },
		"the 30-day window wins the long slot and no short slot is filled",
	);
});

test("parseCodexUsage rejects malformed payloads", () => {
	assert.equal(parseCodexUsage(undefined), undefined);
	assert.equal(parseCodexUsage({}), undefined);
	assert.equal(parseCodexUsage({ rate_limit: null }), undefined);
	assert.equal(parseCodexUsage({ rate_limit: { primary_window: { used_percent: "93" } } }), undefined);
	assert.equal(
		parseCodexUsage({ rate_limit: { primary_window: { used_percent: 93, limit_window_seconds: "604800" } } }),
		undefined,
		"a window with no usable span fills no slot",
	);
});

test("usageBand maps remaining percent to the specified color bands", () => {
	assert.equal(usageBand(100), "green");
	assert.equal(usageBand(61), "green");
	assert.equal(usageBand(60), "yellow");
	assert.equal(usageBand(41), "yellow");
	assert.equal(usageBand(40), "orange");
	assert.equal(usageBand(16), "orange");
	assert.equal(usageBand(15), "red");
	assert.equal(usageBand(0), "red");
});

test("renderUsageSegment appends the scoped weekly percent when present", () => {
	const segment = renderUsageSegment({ claude: { fiveHour: 97, sevenDay: 54, scopedWeekly: 24 } });
	assert.equal(stripAnsi(segment ?? ""), "\uec82 97\u00b754\u00b724");
	assert.ok(segment?.includes("\x1b[38;2;255;176;85m24\x1b[0m"), "24 remaining renders orange");
});

test("renderUsageSegment renders icons with remaining percents in band colors", () => {
	const segment = renderUsageSegment({ claude: { fiveHour: 97, sevenDay: 54 }, codex: { weekly: 7 } });
	assert.ok(segment);
	assert.equal(stripAnsi(segment), "\uec82 97\u00b754 \uec81 7");
	assert.ok(segment.includes("\x1b[38;2;0;175;80m97\x1b[0m"), "97 remaining renders green");
	assert.ok(segment.includes("\x1b[38;2;230;200;0m54\x1b[0m"), "54 remaining renders yellow");
	assert.ok(segment.includes("\x1b[38;2;255;85;85m7\x1b[0m"), "7 remaining renders red");
});

test("renderUsageSegment renders the codex 5-hour percent before the weekly one", () => {
	const segment = renderUsageSegment({ codex: { fiveHour: 92, weekly: 99 } });
	assert.ok(segment);
	assert.equal(stripAnsi(segment), "\uec81 92\u00b799");
	assert.ok(segment.includes("\x1b[38;2;0;175;80m92\x1b[0m"), "92 remaining renders green");
	assert.ok(segment.includes("\x1b[38;2;0;175;80m99\x1b[0m"), "99 remaining renders green");
	const both = renderUsageSegment({ claude: { fiveHour: 97, sevenDay: 54 }, codex: { fiveHour: 92, weekly: 99 } });
	assert.equal(stripAnsi(both ?? ""), "\uec82 97\u00b754 \uec81 92\u00b799");
});

test("renderUsageSegment omits missing providers", () => {
	const claudeOnly = renderUsageSegment({ claude: { fiveHour: 30, sevenDay: 20 } });
	assert.equal(stripAnsi(claudeOnly ?? ""), "\uec82 30\u00b720");
	assert.ok(claudeOnly?.includes("\x1b[38;2;255;176;85m30\x1b[0m"), "30 remaining renders orange");
	const codexOnly = renderUsageSegment({ codex: { weekly: 80 } });
	assert.equal(stripAnsi(codexOnly ?? ""), "\uec81 80");
	assert.equal(stripAnsi(renderUsageSegment({ codex: { fiveHour: 80 } }) ?? ""), "\uec81 80");
	assert.equal(renderUsageSegment({}), undefined);
});

test("renderUsageSegment drops a codex entry carrying no percents", () => {
	assert.equal(renderUsageSegment({ codex: {} }), undefined);
	assert.equal(
		stripAnsi(renderUsageSegment({ claude: { fiveHour: 97, sevenDay: 54 }, codex: {} }) ?? ""),
		"\uec82 97\u00b754",
		"no stray icon or separator is left behind",
	);
});

const baseData = {
	model: "gpt-5.6-sol",
	cwd: "pi-extensions",
	cwdGit: { branch: "main", dirty: false, behind: 0 },
	contextTokens: 40_000,
	contextWindow: 1_000_000,
	worktrees: [],
	sessionId: "019fafa7-29c0-7e99-9f82-5794d5721848",
};

test("renderStatusline appends the usage segment after context", () => {
	const lines = renderStatusline(
		{ ...baseData, usage: { claude: { fiveHour: 97, sevenDay: 54 }, codex: { weekly: 7 } } },
		160,
	);
	assert.equal(
		stripAnsi(lines[0]),
		"gpt-5.6-sol | pi-extensions:main | 40k/1.0m | \uec82 97\u00b754 \uec81 7",
	);
});

test("renderStatusline renders both codex windows in the usage segment", () => {
	const lines = renderStatusline(
		{ ...baseData, usage: { claude: { fiveHour: 97, sevenDay: 54 }, codex: { fiveHour: 92, weekly: 99 } } },
		160,
	);
	assert.equal(
		stripAnsi(lines[0]),
		"gpt-5.6-sol | pi-extensions:main | 40k/1.0m | \uec82 97\u00b754 \uec81 92\u00b799",
	);
});

test("renderStatusline omits the usage segment when the snapshot is empty", () => {
	const lines = renderStatusline({ ...baseData, usage: {} }, 160);
	assert.equal(stripAnsi(lines[0]), "gpt-5.6-sol | pi-extensions:main | 40k/1.0m");
});

test("renderStatusline keeps the cache celebration badge after the usage segment", () => {
	const lines = renderStatusline(
		{
			...baseData,
			usage: { codex: { weekly: 80 } },
			cacheCelebration: { percent: 97, frame: 0 },
		},
		200,
	);
	assert.equal(
		stripAnsi(lines[0]),
		"gpt-5.6-sol | pi-extensions:main | 40k/1.0m | \uec81 80 | \u26a197%\u00b7CACHE\u00b7HIT",
	);
});

/** A 429 whose response carries a `Retry-After` header, for fakeFetch. */
class RateLimited {
	constructor(readonly retryAfter: string | null) {}
}

interface FetchCall {
	url: string;
	headers: Record<string, string>;
}

function fakeFetch(
	responses: Record<string, unknown>,
	calls: FetchCall[] = [],
): (
	url: string,
	init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }> {
	return async (url, init) => {
		calls.push({ url, headers: init.headers });
		if (!(url in responses)) return { ok: false, status: 404, json: async () => ({}) };
		const body = responses[url];
		if (body instanceof Error) throw body;
		// A bare number stands in for an error status, e.g. 429 rate limiting.
		if (typeof body === "number") return { ok: false, status: body, json: async () => ({}) };
		// A RateLimited stands in for a 429 that carries response headers.
		if (body instanceof RateLimited) {
			return {
				ok: false,
				status: 429,
				headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? body.retryAfter : null) },
				json: async () => ({}),
			};
		}
		return { ok: true, status: 200, json: async () => body };
	};
}

/**
 * Every tracker gets its own cache file: the real one is shared host-wide, so a
 * test must never read or write the developer's own ~/.pi/agent copy.
 */
function makeTracker(options: UsageTrackerOptions & { authPath: string }): UsageTracker {
	return new UsageTracker({ cachePath: `${options.authPath}.usage-cache.json`, ...options });
}

/**
 * The unconfigured tracker follows PI_CODING_AGENT_DIR.
 *
 * It used to join homedir() with ".pi/agent", so a session pointed at another
 * agent dir read the wrong auth.json and wrote its usage cache into the host's
 * real one. The preload gives this process a scratch agent dir, so passing no
 * paths at all is safe here and would have failed loudly before the fix.
 */
test("UsageTracker defaults its auth and cache paths to the agent dir", async () => {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	assert.ok(agentDir, "the hermetic preload set an agent dir");
	await writeFile(join(agentDir, "auth.json"), JSON.stringify(fullAuth));
	const tracker = new UsageTracker({
		fetchFn: fakeFetch({ [CLAUDE_URL]: claudePayload, [CODEX_URL]: codexWeeklyOnlyPayload }),
	});
	await tracker.refresh();

	assert.deepEqual(tracker.snapshot(), { claude: { fiveHour: 97, sevenDay: 54 }, codex: { weekly: 7 } });
	const cache = JSON.parse(await readFile(join(agentDir, "statusline-usage.json"), "utf8"));
	assert.ok(cache.accounts, "the shared cache landed in the agent dir");
});

async function writeAuthFile(auth: unknown): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-statusline-usage-"));
	const authPath = join(dir, "auth.json");
	await writeFile(authPath, JSON.stringify(auth));
	return authPath;
}

const fullAuth = {
	anthropic: { type: "oauth", access: "claude-token", refresh: "r", expires: 0 },
	"openai-codex": { type: "oauth", access: "codex-token", refresh: "r", expires: 0, accountId: "acct-1" },
};

const CLAUDE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";

test("UsageTracker fetches both providers with Pi's tokens and fires onChange", async () => {
	const authPath = await writeAuthFile(fullAuth);
	const calls: FetchCall[] = [];
	let changes = 0;
	const tracker = makeTracker({
		authPath,
		fetchFn: fakeFetch({ [CLAUDE_URL]: claudePayload, [CODEX_URL]: codexWeeklyOnlyPayload }, calls),
		onChange: () => changes++,
	});
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot(), { claude: { fiveHour: 97, sevenDay: 54 }, codex: { weekly: 7 } });
	assert.equal(changes, 1);
	const claudeCall = calls.find((call) => call.url === CLAUDE_URL);
	assert.equal(claudeCall?.headers.Authorization, "Bearer claude-token");
	assert.equal(claudeCall?.headers["anthropic-beta"], "oauth-2025-04-20");
	const codexCall = calls.find((call) => call.url === CODEX_URL);
	assert.equal(codexCall?.headers.Authorization, "Bearer codex-token");
	assert.equal(codexCall?.headers["chatgpt-account-id"], "acct-1");
});

test("UsageTracker keeps last-known values when a provider fails", async () => {
	const authPath = await writeAuthFile(fullAuth);
	let now = 0;
	const responses: Record<string, unknown> = { [CLAUDE_URL]: claudePayload, [CODEX_URL]: codexWeeklyOnlyPayload };
	const tracker = makeTracker({ authPath, fetchFn: fakeFetch(responses), now: () => now });
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot(), { claude: { fiveHour: 97, sevenDay: 54 }, codex: { weekly: 7 } });
	delete responses[CLAUDE_URL];
	responses[CODEX_URL] = { rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 604_800 } } };
	now = USAGE_REFRESH_INTERVAL_MS;
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot(), { claude: { fiveHour: 97, sevenDay: 54 }, codex: { weekly: 50 } });
});

test("UsageTracker throttles refreshes to each provider's own interval", async () => {
	const authPath = await writeAuthFile(fullAuth);
	const calls: FetchCall[] = [];
	let now = 0;
	const tracker = makeTracker({
		authPath,
		fetchFn: fakeFetch({ [CLAUDE_URL]: claudePayload, [CODEX_URL]: codexWeeklyOnlyPayload }, calls),
		now: () => now,
	});
	const claudeCalls = (): number => calls.filter((call) => call.url === CLAUDE_URL).length;
	await tracker.refresh();
	assert.equal(calls.length, 2, "both providers are polled on the first refresh");

	now = CODEX_USAGE_REFRESH_INTERVAL_MS - 1;
	await tracker.refresh();
	assert.equal(calls.length, 2, "a refresh inside both intervals fetches nothing");

	now = USAGE_REFRESH_INTERVAL_MS - 1;
	await tracker.refresh();
	assert.equal(claudeCalls(), 1, "claude stays throttled for its full window");

	now = USAGE_REFRESH_INTERVAL_MS;
	await tracker.refresh();
	assert.equal(claudeCalls(), 2, "claude fetches again after its window");
	assert.equal(USAGE_REFRESH_INTERVAL_MS, 300_000, "claude polls stay at most once per five minutes");
	assert.equal(CODEX_USAGE_REFRESH_INTERVAL_MS, 60_000, "codex matches its own vendor client's cadence");
});

test("UsageTracker retries quickly while a credentialed provider has no value yet", async () => {
	// Pi refreshes an expired Anthropic token only on first use, so a session that
	// starts with a stale token must not wait a full interval for Claude to appear.
	const authPath = await writeAuthFile(fullAuth);
	const calls: FetchCall[] = [];
	let now = 0;
	const responses: Record<string, unknown> = { [CODEX_URL]: codexWeeklyOnlyPayload };
	const tracker = makeTracker({ authPath, fetchFn: fakeFetch(responses, calls), now: () => now });

	await tracker.refresh();
	assert.deepEqual(tracker.snapshot(), { codex: { weekly: 7 } }, "claude is still missing");

	now = USAGE_RETRY_INTERVAL_MS - 1;
	await tracker.refresh();
	assert.equal(calls.length, 2, "retries stay throttled inside the retry window");

	now = USAGE_RETRY_INTERVAL_MS;
	responses[CLAUDE_URL] = claudePayload;
	await tracker.refresh();
	assert.equal(calls.length, 4, "a missing provider is retried after the short window");
	assert.deepEqual(tracker.snapshot(), { claude: { fiveHour: 97, sevenDay: 54 }, codex: { weekly: 7 } });

	// Both providers resolved: each family falls back to its own steady-state
	// interval. Claude is the one this test is about, and codex now polls on a
	// shorter cadence of its own, so count claude's calls rather than every call.
	const claudeCalls = (): number => calls.filter((call) => call.url === CLAUDE_URL).length;
	const beforeClaude = claudeCalls();
	now = USAGE_RETRY_INTERVAL_MS + USAGE_REFRESH_INTERVAL_MS - 1;
	await tracker.refresh();
	assert.equal(claudeCalls(), beforeClaude, "the short window no longer applies once every provider has a value");
	now = USAGE_RETRY_INTERVAL_MS + USAGE_REFRESH_INTERVAL_MS;
	await tracker.refresh();
	assert.equal(claudeCalls(), beforeClaude + 1);
	assert.ok(USAGE_RETRY_INTERVAL_MS < USAGE_REFRESH_INTERVAL_MS);
});

test("UsageTracker does not fast-retry for providers without credentials", async () => {
	const authPath = await writeAuthFile({ anthropic: fullAuth.anthropic });
	const calls: FetchCall[] = [];
	let now = 0;
	const tracker = makeTracker({
		authPath,
		fetchFn: fakeFetch({ [CLAUDE_URL]: claudePayload }, calls),
		now: () => now,
	});
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot(), { claude: { fiveHour: 97, sevenDay: 54 } });
	now = USAGE_RETRY_INTERVAL_MS;
	await tracker.refresh();
	assert.equal(calls.length, 1, "a logged-out provider never counts as pending");
});

test("UsageTracker shares one poll per interval across processes via the cache file", async () => {
	// A busy host runs dozens of pi processes; per-process polling is what got the
	// Anthropic usage endpoint to rate-limit every session on the machine.
	const authPath = await writeAuthFile(fullAuth);
	const cachePath = join(dirname(authPath), "shared-usage.json");
	const firstCalls: FetchCall[] = [];
	const secondCalls: FetchCall[] = [];
	let now = 0;
	const responses = { [CLAUDE_URL]: claudePayload, [CODEX_URL]: codexWeeklyOnlyPayload };
	const first = makeTracker({ authPath, cachePath, fetchFn: fakeFetch(responses, firstCalls), now: () => now });
	await first.refresh();
	assert.equal(firstCalls.length, 2);

	// A session starting later adopts the cached values on its first refresh and
	// issues no request of its own.
	let changes = 0;
	now = 1_000;
	const second = makeTracker({
		authPath,
		cachePath,
		fetchFn: fakeFetch(responses, secondCalls),
		onChange: () => changes++,
		now: () => now,
	});
	await second.refresh();
	assert.deepEqual(second.snapshot(), { claude: { fiveHour: 97, sevenDay: 54 }, codex: { weekly: 7 } });
	assert.equal(changes, 1, "the adopted snapshot repaints once");
	assert.equal(secondCalls.length, 0, "a sibling process reuses the shared poll");

	// Past the shared window either process may poll; whoever gets there first
	// claims the slot for everyone.
	now = USAGE_REFRESH_INTERVAL_MS + 1_000;
	await second.refresh();
	assert.equal(secondCalls.length, 2, "the next window is polled once");
	await first.refresh();
	assert.equal(firstCalls.length, 2, "the sibling skips the window another process claimed");
});

test("UsageTracker backs off a provider that answers 429", async () => {
	const authPath = await writeAuthFile(fullAuth);
	const calls: FetchCall[] = [];
	let now = 0;
	const responses: Record<string, unknown> = { [CLAUDE_URL]: 429, [CODEX_URL]: codexWeeklyOnlyPayload };
	const tracker = makeTracker({ authPath, fetchFn: fakeFetch(responses, calls), now: () => now });
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot(), { codex: { weekly: 7 } });

	// A rate-limited provider must not hold the fast-retry window open: retrying
	// harder is what earned the 429.
	now = USAGE_RETRY_INTERVAL_MS;
	await tracker.refresh();
	assert.equal(calls.length, 2, "no retry inside the full window");

	responses[CLAUDE_URL] = claudePayload;
	now = USAGE_REFRESH_INTERVAL_MS;
	await tracker.refresh();
	assert.equal(calls.length, 3, "only the healthy provider is polled while claude is backed off");
	assert.equal(calls.at(-1)?.url, CODEX_URL);

	now = USAGE_RATE_LIMIT_BACKOFF_MS;
	await tracker.refresh();
	assert.equal(calls.length, 5, "the backed-off provider is polled again once the backoff expires");
	assert.deepEqual(tracker.snapshot(), { claude: { fiveHour: 97, sevenDay: 54 }, codex: { weekly: 7 } });
});

test("UsageTracker discards cached usage from a previous account", async () => {
	const authPath = await writeAuthFile(fullAuth);
	const cachePath = join(dirname(authPath), "shared-usage.json");
	let now = 0;
	const first = makeTracker({
		authPath,
		cachePath,
		fetchFn: fakeFetch({ [CLAUDE_URL]: claudeScopedPayload, [CODEX_URL]: codexWeeklyOnlyPayload }),
		now: () => now,
	});
	await first.refresh();
	assert.deepEqual(first.snapshot(), {
		claude: { fiveHour: 97, sevenDay: 54, scopedWeekly: 24 },
		codex: { weekly: 7 },
	});

	// Switch Anthropic accounts: auth.json holds a new token while the shared
	// cache still carries the exhausted account's numbers and a fresh attemptedAt.
	await writeFile(
		authPath,
		JSON.stringify({ ...fullAuth, anthropic: { ...fullAuth.anthropic, access: "claude-token-2" } }),
	);
	const calls: FetchCall[] = [];
	now = 1_000;
	const second = makeTracker({
		authPath,
		cachePath,
		fetchFn: fakeFetch({ [CLAUDE_URL]: claudePayload, [CODEX_URL]: codexWeeklyOnlyPayload }, calls),
		now: () => now,
	});
	await second.refresh();
	assert.ok(
		calls.some((call) => call.url === CLAUDE_URL),
		"the shared throttle does not block the new account's first poll",
	);
	assert.deepEqual(
		second.snapshot().claude,
		{ fiveHour: 97, sevenDay: 54 },
		"the old account's scoped weekly limit does not linger",
	);
});

test("UsageTracker refetches immediately after a mid-session account switch", async () => {
	const authPath = await writeAuthFile(fullAuth);
	const responses: Record<string, unknown> = { [CLAUDE_URL]: claudeScopedPayload, [CODEX_URL]: codexWeeklyOnlyPayload };
	const calls: FetchCall[] = [];
	let now = 0;
	const tracker = makeTracker({ authPath, fetchFn: fakeFetch(responses, calls), now: () => now });
	await tracker.refresh();
	assert.equal(tracker.snapshot().claude?.scopedWeekly, 24);

	await writeFile(
		authPath,
		JSON.stringify({ ...fullAuth, anthropic: { ...fullAuth.anthropic, access: "claude-token-2" } }),
	);
	responses[CLAUDE_URL] = claudePayload;
	now = 1_000; // well inside the refresh interval
	await tracker.refresh();
	assert.deepEqual(
		tracker.snapshot().claude,
		{ fiveHour: 97, sevenDay: 54 },
		"the same process drops and re-polls after the token changes",
	);
});

test("UsageTracker never shows a previous account's numbers when the new fetch fails", async () => {
	const authPath = await writeAuthFile(fullAuth);
	const responses: Record<string, unknown> = { [CLAUDE_URL]: claudeScopedPayload, [CODEX_URL]: codexWeeklyOnlyPayload };
	let now = 0;
	let changes = 0;
	const tracker = makeTracker({ authPath, fetchFn: fakeFetch(responses), now: () => now, onChange: () => changes++ });
	await tracker.refresh();
	assert.equal(tracker.snapshot().claude?.scopedWeekly, 24);

	await writeFile(
		authPath,
		JSON.stringify({ ...fullAuth, anthropic: { ...fullAuth.anthropic, access: "claude-token-2" } }),
	);
	delete responses[CLAUDE_URL];
	now = 1_000;
	const before = changes;
	await tracker.refresh();
	assert.equal(tracker.snapshot().claude, undefined, "no value beats another account's value");
	assert.deepEqual(tracker.snapshot().codex, { weekly: 7 }, "the unswitched provider keeps its value");
	assert.ok(changes > before, "dropping the stale value repaints");
});

test("UsageTracker skips providers with missing auth entries", async () => {
	const authPath = await writeAuthFile({ anthropic: { access: "claude-token" } });
	const calls: FetchCall[] = [];
	const tracker = makeTracker({
		authPath,
		fetchFn: fakeFetch({ [CLAUDE_URL]: claudePayload, [CODEX_URL]: codexWeeklyOnlyPayload }, calls),
	});
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot(), { claude: { fiveHour: 97, sevenDay: 54 } });
	assert.equal(calls.some((call) => call.url === CODEX_URL), false);
});

test("UsageTracker drops a provider once its auth entry disappears", async () => {
	const authPath = await writeAuthFile(fullAuth);
	let now = 0;
	let changes = 0;
	const tracker = makeTracker({
		authPath,
		fetchFn: fakeFetch({ [CLAUDE_URL]: claudePayload, [CODEX_URL]: codexWeeklyOnlyPayload }),
		onChange: () => changes++,
		now: () => now,
	});
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot(), { claude: { fiveHour: 97, sevenDay: 54 }, codex: { weekly: 7 } });
	// Log out of codex: entry removed from auth.json; stale value must not linger.
	await writeFile(authPath, JSON.stringify({ anthropic: fullAuth.anthropic }));
	now = USAGE_REFRESH_INTERVAL_MS;
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot(), { claude: { fiveHour: 97, sevenDay: 54 } });
	// Log out entirely: auth.json gone; snapshot clears.
	await rm(authPath);
	now = 2 * USAGE_REFRESH_INTERVAL_MS;
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot(), {});
	assert.equal(changes, 3);
});

test("resolveUsageAccounts follows the main model's account and defaults the rest", () => {
	// No active model, and the traditional single-account setup: both meters read
	// the base credential, exactly as they did before additional logins existed.
	assert.deepEqual(resolveUsageAccounts(undefined), { claude: "anthropic", codex: "openai-codex" });
	assert.deepEqual(resolveUsageAccounts("anthropic"), { claude: "anthropic", codex: "openai-codex" });
	assert.deepEqual(resolveUsageAccounts("openai-codex"), { claude: "anthropic", codex: "openai-codex" });

	// An additional login takes over its own family only; the other family keeps
	// showing the base account, so a backup provider's meter stays visible.
	assert.deepEqual(resolveUsageAccounts("anthropic-work"), { claude: "anthropic-work", codex: "openai-codex" });
	assert.deepEqual(resolveUsageAccounts("openai-codex-alt"), { claude: "anthropic", codex: "openai-codex-alt" });

	// Unrelated providers never claim a meter.
	assert.deepEqual(resolveUsageAccounts("google"), { claude: "anthropic", codex: "openai-codex" });
	assert.deepEqual(resolveUsageAccounts("anthropicx"), { claude: "anthropic", codex: "openai-codex" });
});

const multiAccountAuth = {
	...fullAuth,
	"anthropic-work": { type: "oauth", access: "claude-work-token", refresh: "r", expires: 0 },
	"openai-codex-auto-permissions": {
		type: "oauth",
		access: "codex-guardian-token",
		refresh: "r",
		expires: 0,
		accountId: "acct-guardian",
	},
};

test("UsageTracker polls the main model's account and leaves other logins alone", async () => {
	const authPath = await writeAuthFile(multiAccountAuth);
	const calls: FetchCall[] = [];
	const tracker = makeTracker({
		authPath,
		activeProvider: "anthropic-work",
		fetchFn: fakeFetch({ [CLAUDE_URL]: claudePayload, [CODEX_URL]: codexWeeklyOnlyPayload }, calls),
	});
	await tracker.refresh();

	assert.equal(
		calls.find((call) => call.url === CLAUDE_URL)?.headers.Authorization,
		"Bearer claude-work-token",
		"the Anthropic meter follows the main model's login",
	);
	assert.equal(
		calls.find((call) => call.url === CODEX_URL)?.headers["chatgpt-account-id"],
		"acct-1",
		"the unused family keeps showing its base account",
	);
	assert.equal(calls.length, 2, "a dedicated background-reviewer login is never polled");
});

test("UsageTracker swaps meters when the main model moves between two logins", async () => {
	const authPath = await writeAuthFile(multiAccountAuth);
	const calls: FetchCall[] = [];
	const workPayload = { ...claudePayload, five_hour: { utilization: 80 }, seven_day: { utilization: 10 } };
	let now = 0;
	const tracker = makeTracker({
		authPath,
		fetchFn: async (url, init) => {
			calls.push({ url, headers: init.headers });
			if (url === CODEX_URL) return { ok: true, status: 200, json: async () => codexWeeklyOnlyPayload };
			const work = init.headers.Authorization === "Bearer claude-work-token";
			return { ok: true, status: 200, json: async () => (work ? workPayload : claudePayload) };
		},
		now: () => now,
	});

	await tracker.refresh();
	assert.deepEqual(tracker.snapshot().claude, { fiveHour: 97, sevenDay: 54 }, "starts on the base account");

	// Switching the main model must repoint the meter immediately, without waiting
	// out the shared throttle -- it is a different account, not a stale value.
	tracker.setActiveProvider("anthropic-work");
	now = 1_000;
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot().claude, { fiveHour: 20, sevenDay: 90 }, "shows the work account");

	// Switching back is free: the base account's value is still cached under its
	// own key, so it repaints without another request.
	const before = calls.length;
	tracker.setActiveProvider("anthropic");
	now = 2_000;
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot().claude, { fiveHour: 97, sevenDay: 54 }, "restores the base account");
	assert.equal(calls.length, before, "a cached account needs no poll");
});

test("UsageTracker lets two processes on different accounts share the cache", async () => {
	// Keying the shared cache by provider family made each process look like an
	// account switch to the other: both evicted the other's entry and re-polled
	// every cycle, which is the stampede the cache exists to prevent.
	const authPath = await writeAuthFile(multiAccountAuth);
	const cachePath = join(dirname(authPath), "shared-usage.json");
	const baseCalls: FetchCall[] = [];
	const workCalls: FetchCall[] = [];
	let now = 0;
	const responses = { [CLAUDE_URL]: claudePayload, [CODEX_URL]: codexWeeklyOnlyPayload };

	const base = makeTracker({
		authPath,
		cachePath,
		activeProvider: "anthropic",
		fetchFn: fakeFetch(responses, baseCalls),
		now: () => now,
	});
	const work = makeTracker({
		authPath,
		cachePath,
		activeProvider: "anthropic-work",
		fetchFn: fakeFetch(responses, workCalls),
		now: () => now,
	});

	await base.refresh();
	assert.equal(baseCalls.length, 2);
	now = 1_000;
	await work.refresh();
	assert.equal(
		workCalls.filter((call) => call.url === CLAUDE_URL).length,
		1,
		"the second account polls its own meter once",
	);
	assert.equal(
		workCalls.filter((call) => call.url === CODEX_URL).length,
		0,
		"the shared codex account is still covered by the sibling's poll",
	);

	// Neither process re-polls inside the window, and neither evicted the other.
	now = 2_000;
	await base.refresh();
	await work.refresh();
	assert.equal(baseCalls.length, 2, "the base process is unaffected by the sibling");
	assert.equal(workCalls.length, 1, "the work process is unaffected by the sibling");
	assert.deepEqual(base.snapshot().claude, { fiveHour: 97, sevenDay: 54 });
	assert.deepEqual(work.snapshot().claude, { fiveHour: 97, sevenDay: 54 });
});

test("UsageTracker still handles a plain single-account switch on the base provider", async () => {
	// The traditional flow: no additional logins at all, just /login again as a
	// different Anthropic account under the same provider id.
	const authPath = await writeAuthFile(fullAuth);
	const cachePath = join(dirname(authPath), "shared-usage.json");
	const calls: FetchCall[] = [];
	const responses: Record<string, unknown> = { [CLAUDE_URL]: claudeScopedPayload, [CODEX_URL]: codexWeeklyOnlyPayload };
	let now = 0;
	const tracker = makeTracker({ authPath, cachePath, fetchFn: fakeFetch(responses, calls), now: () => now });
	await tracker.refresh();
	assert.equal(tracker.snapshot().claude?.scopedWeekly, 24);

	await writeFile(
		authPath,
		JSON.stringify({ ...fullAuth, anthropic: { ...fullAuth.anthropic, access: "claude-token-2" } }),
	);
	responses[CLAUDE_URL] = claudePayload;
	now = 1_000; // well inside the refresh interval
	await tracker.refresh();
	assert.deepEqual(
		tracker.snapshot().claude,
		{ fiveHour: 97, sevenDay: 54 },
		"the replaced account re-polls immediately and drops the old scoped limit",
	);
	assert.deepEqual(tracker.snapshot().codex, { weekly: 7 }, "the untouched provider keeps its value");
});

test("UsageTracker ignores a cache file written by an older version", async () => {
	const authPath = await writeAuthFile(fullAuth);
	const cachePath = join(dirname(authPath), "legacy-usage.json");
	await writeFile(
		cachePath,
		JSON.stringify({
			attemptedAt: 0,
			backoff: {},
			snapshot: { claude: { fiveHour: 1, sevenDay: 1 }, codex: { weekly: 1 } },
			identity: {},
		}),
	);
	const tracker = makeTracker({
		authPath,
		cachePath,
		fetchFn: fakeFetch({ [CLAUDE_URL]: claudePayload, [CODEX_URL]: codexWeeklyOnlyPayload }),
		now: () => 1_000,
	});
	await tracker.refresh();
	assert.deepEqual(
		tracker.snapshot(),
		{ claude: { fiveHour: 97, sevenDay: 54 }, codex: { weekly: 7 } },
		"the legacy shape is discarded rather than misread, costing one extra poll",
	);
});

test("UsageTracker tolerates a missing auth file and thrown fetches", async () => {
	const missing = makeTracker({
		authPath: join(tmpdir(), "pi-statusline-usage-missing", "auth.json"),
		fetchFn: fakeFetch({}),
	});
	await missing.refresh();
	assert.deepEqual(missing.snapshot(), {});

	const authPath = await writeAuthFile(fullAuth);
	let now = 0;
	const throwing = makeTracker({
		authPath,
		fetchFn: fakeFetch({ [CLAUDE_URL]: new Error("network down"), [CODEX_URL]: new Error("network down") }),
		now: () => now,
	});
	await throwing.refresh();
	assert.deepEqual(throwing.snapshot(), {});
});

/**
 * A fake timer that records every scheduled interval and lets a test fire one.
 * The tracker's tick is deliberately fire-and-forget, so `tick` also awaits the
 * refresh it started: `refresh()` hands back the in-flight promise.
 */
function fakeTimer(): {
	options: Pick<UsageTrackerOptions, "schedule" | "cancel">;
	scheduled: number[];
	cancelled: number;
	fire(): void;
} {
	const callbacks: (() => void)[] = [];
	const state = {
		scheduled: [] as number[],
		cancelled: 0,
		fire(): void {
			for (const callback of callbacks) callback();
		},
	};
	// Object.assign, not a spread: `cancelled` is a primitive, so a copied harness
	// would keep reporting the zero it was built with.
	return Object.assign(state, {
		options: {
			schedule: (callback: () => void, intervalMs: number) => {
				state.scheduled.push(intervalMs);
				callbacks.push(callback);
				return callbacks.length - 1;
			},
			cancel: (handle: unknown) => {
				state.cancelled += 1;
				callbacks.splice(handle as number, 1);
			},
		},
	});
}

test("UsageTracker start schedules one tick and stop cancels it", async () => {
	const authPath = await writeAuthFile(fullAuth);
	const timer = fakeTimer();
	const tracker = makeTracker({
		authPath,
		fetchFn: fakeFetch({}),
		tickIntervalMs: 10_000,
		...timer.options,
	});

	tracker.start();
	tracker.start();
	assert.deepEqual(timer.scheduled, [10_000], "start is idempotent, so a second call adds no timer");

	tracker.stop();
	assert.equal(timer.cancelled, 1);
	tracker.stop();
	assert.equal(timer.cancelled, 1, "stop is safe to repeat");
});

test("UsageTracker ticks adopt a sibling process's values without polling", async () => {
	// The turn-driven cadence could not do this: fresh values sat in the shared
	// cache until this session happened to finish a turn.
	const authPath = await writeAuthFile(fullAuth);
	const cachePath = join(dirname(authPath), "shared-usage.json");
	const responses = { [CLAUDE_URL]: claudePayload, [CODEX_URL]: codexWeeklyOnlyPayload };
	let now = 0;
	const first = makeTracker({ authPath, cachePath, fetchFn: fakeFetch(responses), now: () => now });
	await first.refresh();

	const calls: FetchCall[] = [];
	let changes = 0;
	const timer = fakeTimer();
	const idle = makeTracker({
		authPath,
		cachePath,
		fetchFn: fakeFetch(responses, calls),
		onChange: () => changes++,
		now: () => now,
		...timer.options,
	});
	idle.start();

	now = 1_000;
	timer.fire();
	await idle.refresh();

	assert.deepEqual(idle.snapshot(), { claude: { fiveHour: 97, sevenDay: 54 }, codex: { weekly: 7 } });
	assert.equal(changes, 1, "adopting the sibling's values repaints once");
	assert.equal(calls.length, 0, "a tick inside the shared window issues no request");
	idle.stop();
});

test("UsageTracker ticks poll once the window opens, with no turn involved", async () => {
	const authPath = await writeAuthFile(fullAuth);
	const calls: FetchCall[] = [];
	let now = 0;
	const timer = fakeTimer();
	const tracker = makeTracker({
		authPath,
		fetchFn: fakeFetch({ [CLAUDE_URL]: claudePayload, [CODEX_URL]: codexWeeklyOnlyPayload }, calls),
		now: () => now,
		...timer.options,
	});
	await tracker.refresh();
	assert.equal(calls.length, 2);

	// An idle session: no turn ends, only ticks. 30s is inside both providers'
	// intervals — codex's is 60s, claude's the full five minutes.
	now = 30_000;
	timer.fire();
	await tracker.refresh();
	assert.equal(calls.length, 2, "a tick inside both intervals stays throttled");

	now = USAGE_REFRESH_INTERVAL_MS + 1;
	timer.fire();
	await tracker.refresh();
	assert.equal(calls.length, 4, "the tick polls as soon as the window opens");
	tracker.stop();
});

test("UsageTracker ticks respect a rate-limit backoff", async () => {
	// Ticking is far more frequent than turns, so a tick that ignored the backoff
	// would turn one 429 into a stream of them.
	const authPath = await writeAuthFile(fullAuth);
	const calls: FetchCall[] = [];
	let now = 0;
	const timer = fakeTimer();
	const tracker = makeTracker({
		authPath,
		fetchFn: fakeFetch({ [CLAUDE_URL]: 429, [CODEX_URL]: codexWeeklyOnlyPayload }, calls),
		now: () => now,
		...timer.options,
	});
	tracker.start();
	timer.fire();
	await tracker.refresh();
	assert.equal(calls.length, 2);

	now = USAGE_REFRESH_INTERVAL_MS + 1;
	timer.fire();
	await tracker.refresh();
	assert.equal(calls.length, 3, "only the healthy provider is re-polled while claude is backed off");
	assert.equal(calls.at(-1)?.url, CODEX_URL);
	tracker.stop();
});

test("UsageTracker polls codex on its own shorter interval", async () => {
	// OpenAI's Codex CLI polls this endpoint every 60s; Anthropic's tolerates far
	// less. One shared interval meant codex inherited the stricter provider's
	// spacing and sat five times more conservative than the vendor's own client.
	const authPath = await writeAuthFile(fullAuth);
	const calls: FetchCall[] = [];
	let now = 0;
	const tracker = makeTracker({
		authPath,
		fetchFn: fakeFetch({ [CLAUDE_URL]: claudePayload, [CODEX_URL]: codexWeeklyOnlyPayload }, calls),
		now: () => now,
	});
	await tracker.refresh();
	assert.equal(calls.length, 2, "both providers are polled on the first refresh");

	now = CODEX_USAGE_REFRESH_INTERVAL_MS - 1;
	await tracker.refresh();
	assert.equal(calls.length, 2, "codex stays throttled inside its own interval");

	now = CODEX_USAGE_REFRESH_INTERVAL_MS;
	await tracker.refresh();
	assert.equal(calls.length, 3, "codex polls again once its interval elapses");
	assert.equal(calls.at(-1)?.url, CODEX_URL, "and claude is not dragged along with it");

	now = USAGE_REFRESH_INTERVAL_MS - 1;
	const beforeClaude = calls.filter((call) => call.url === CLAUDE_URL).length;
	await tracker.refresh();
	assert.equal(
		calls.filter((call) => call.url === CLAUDE_URL).length,
		beforeClaude,
		"claude keeps the full five-minute spacing",
	);

	now = USAGE_REFRESH_INTERVAL_MS;
	await tracker.refresh();
	assert.equal(
		calls.filter((call) => call.url === CLAUDE_URL).length,
		beforeClaude + 1,
		"claude polls once its own interval elapses",
	);
});

test("UsageTracker keeps the fast retry window for a codex account with no value", async () => {
	// The retry window is shorter than codex's interval, so a credentialed
	// provider still missing a value must not be slowed down by this split.
	const authPath = await writeAuthFile(fullAuth);
	const calls: FetchCall[] = [];
	let now = 0;
	const responses: Record<string, unknown> = { [CLAUDE_URL]: claudePayload, [CODEX_URL]: 500 };
	const tracker = makeTracker({ authPath, fetchFn: fakeFetch(responses, calls), now: () => now });
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot(), { claude: { fiveHour: 97, sevenDay: 54 } });

	responses[CODEX_URL] = codexWeeklyOnlyPayload;
	now = USAGE_RETRY_INTERVAL_MS;
	await tracker.refresh();
	assert.deepEqual(
		tracker.snapshot(),
		{ claude: { fiveHour: 97, sevenDay: 54 }, codex: { weekly: 7 } },
		"the 30s retry window still applies while a value is missing",
	);
});

test("parseRetryAfter accepts both header forms and rejects useless values", () => {
	const now = 1_000_000;
	assert.equal(parseRetryAfter("120", now), now + 120_000, "delta-seconds");
	assert.equal(parseRetryAfter("  90 ", now), now + 90_000, "surrounding whitespace is tolerated");
	assert.equal(
		parseRetryAfter(new Date(now + 300_000).toUTCString(), now),
		Math.floor((now + 300_000) / 1000) * 1000,
		"an HTTP-date, to the second the header can express",
	);
	// Anthropic's usage endpoint is widely reported to answer `retry-after: 0`
	// while continuing to refuse requests, so obeying it would retry straight
	// back into the limit that produced it.
	assert.equal(parseRetryAfter("0", now), undefined, "a zero delta is not a usable instruction");
	assert.equal(parseRetryAfter("-30", now), undefined, "nor is a negative one");
	assert.equal(parseRetryAfter(new Date(now - 60_000).toUTCString(), now), undefined, "nor a past date");
	assert.equal(parseRetryAfter("soon", now), undefined, "unparseable");
	assert.equal(parseRetryAfter("", now), undefined, "empty");
	assert.equal(parseRetryAfter(null, now), undefined, "absent");
});

test("UsageTracker honours a Retry-After shorter than the flat backoff", async () => {
	// The win: recover in the minute the provider asked for instead of sitting
	// out the full fifteen because we guessed.
	const authPath = await writeAuthFile(fullAuth);
	const calls: FetchCall[] = [];
	let now = 0;
	const responses: Record<string, unknown> = {
		[CLAUDE_URL]: new RateLimited("60"),
		[CODEX_URL]: codexWeeklyOnlyPayload,
	};
	const tracker = makeTracker({ authPath, fetchFn: fakeFetch(responses, calls), now: () => now });
	await tracker.refresh();
	assert.equal(calls.length, 2);

	responses[CLAUDE_URL] = claudePayload;
	now = 59_000;
	await tracker.refresh();
	assert.equal(tracker.snapshot().claude, undefined, "still blocked one second early");

	now = 60_000;
	await tracker.refresh();
	assert.deepEqual(
		tracker.snapshot().claude,
		{ fiveHour: 97, sevenDay: 54 },
		"polled again exactly when the provider said to",
	);
});

test("UsageTracker honours a Retry-After longer than the flat backoff", async () => {
	const authPath = await writeAuthFile(fullAuth);
	const calls: FetchCall[] = [];
	let now = 0;
	const hour = 3_600_000;
	const responses: Record<string, unknown> = {
		[CLAUDE_URL]: new RateLimited(String(hour / 1000)),
		[CODEX_URL]: codexWeeklyOnlyPayload,
	};
	const tracker = makeTracker({ authPath, fetchFn: fakeFetch(responses, calls), now: () => now });
	await tracker.refresh();
	responses[CLAUDE_URL] = claudePayload;

	now = USAGE_RATE_LIMIT_BACKOFF_MS;
	await tracker.refresh();
	assert.equal(tracker.snapshot().claude, undefined, "the flat window does not override a longer instruction");

	now = hour;
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot().claude, { fiveHour: 97, sevenDay: 54 });
});

test("UsageTracker falls back to the flat backoff for an uninformative 429", async () => {
	const authPath = await writeAuthFile(fullAuth);
	let now = 0;
	const responses: Record<string, unknown> = {
		// retry-after: 0 and a bare 429 with no headers at all must behave alike.
		[CLAUDE_URL]: new RateLimited("0"),
		[CODEX_URL]: 429,
	};
	const tracker = makeTracker({ authPath, fetchFn: fakeFetch(responses), now: () => now });
	await tracker.refresh();

	responses[CLAUDE_URL] = claudePayload;
	responses[CODEX_URL] = codexWeeklyOnlyPayload;
	now = USAGE_RATE_LIMIT_BACKOFF_MS - 1;
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot(), {}, "both stay blocked for the flat window");

	now = USAGE_RATE_LIMIT_BACKOFF_MS;
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot(), { claude: { fiveHour: 97, sevenDay: 54 }, codex: { weekly: 7 } });
});

const RESET_ISO = "2026-08-14T00:29:59+00:00";
const RESET_MS = Date.parse(RESET_ISO);

function claudePayloadResettingAt(iso: string): unknown {
	return { five_hour: { utilization: 3.0, resets_at: iso }, seven_day: { utilization: 46.0, resets_at: iso } };
}

const claudeOnlyAuth = { anthropic: { type: "oauth", access: "claude-token", refresh: "r", expires: 0 } };

test("claudeResetAt takes the soonest window and ignores unusable ones", () => {
	assert.equal(claudeResetAt(claudePayload), Date.parse("2026-08-14T00:29:59+00:00"), "the five-hour window is sooner");
	assert.equal(
		claudeResetAt({ five_hour: { resets_at: "nonsense" }, seven_day: { resets_at: RESET_ISO } }),
		RESET_MS,
		"an unparseable timestamp does not hide a usable sibling",
	);
	assert.equal(claudeResetAt({}), undefined, "no windows, no boundary");
	assert.equal(claudeResetAt(null), undefined);
});

test("codexResetAt prefers the absolute reset and falls back to the relative one", () => {
	const now = 1_000_000;
	const absolute = {
		rate_limit: {
			primary_window: { used_percent: 8, limit_window_seconds: 18_000, reset_at: 2_000, reset_after_seconds: 5 },
			secondary_window: null,
		},
	};
	assert.equal(codexResetAt(absolute, now), 2_000_000, "reset_at is Unix seconds and outranks the relative form");

	const relative = {
		rate_limit: {
			primary_window: { used_percent: 8, limit_window_seconds: 18_000, reset_after_seconds: 90 },
			secondary_window: null,
		},
	};
	assert.equal(codexResetAt(relative, now), now + 90_000, "a relative reset is resolved against our clock");
	assert.equal(codexResetAt(codexPlusPayload, now), undefined, "a payload with no reset fields has no boundary");
});

test("UsageTracker does not adopt a cached value whose window has rolled", async () => {
	// The bug this prevents: after a five-hour window resets, the cached
	// percentage describes the window that just ended. It is not stale, it is
	// wrong, and age-based expiry alone cannot see that.
	const authPath = await writeAuthFile(claudeOnlyAuth);
	const cachePath = join(dirname(authPath), "shared-usage.json");
	const responses: Record<string, unknown> = { [CLAUDE_URL]: claudePayloadResettingAt(RESET_ISO) };
	let now = 0;
	const first = makeTracker({ authPath, cachePath, fetchFn: fakeFetch(responses), now: () => now });
	await first.refresh();
	assert.deepEqual(first.snapshot().claude, { fiveHour: 97, sevenDay: 54 }, "stored before the boundary");

	// A second process starting after the boundary must not inherit it, even
	// though the value is only milliseconds "old" by timestamp.
	const calls: FetchCall[] = [];
	now = RESET_MS;
	responses[CLAUDE_URL] = 500;
	const second = makeTracker({ authPath, cachePath, fetchFn: fakeFetch(responses, calls), now: () => now });
	await second.refresh();
	assert.equal(second.snapshot().claude, undefined, "the rolled-over value is not adopted");
	assert.equal(calls.length, 1, "and a fresh poll is issued immediately");
});

test("UsageTracker polls past a boundary without waiting out the interval", async () => {
	const authPath = await writeAuthFile(claudeOnlyAuth);
	const calls: FetchCall[] = [];
	let now = RESET_MS - USAGE_REFRESH_INTERVAL_MS;
	const responses: Record<string, unknown> = { [CLAUDE_URL]: claudePayloadResettingAt(RESET_ISO) };
	const tracker = makeTracker({ authPath, fetchFn: fakeFetch(responses, calls), now: () => now });
	await tracker.refresh();
	assert.equal(calls.length, 1);

	// One second before the boundary the ordinary interval still governs.
	now = RESET_MS - 1;
	await tracker.refresh();
	assert.equal(calls.length, 1, "inside the interval and before the boundary, nothing is polled");

	now = RESET_MS;
	responses[CLAUDE_URL] = claudePayloadResettingAt("2026-08-14T05:29:59+00:00");
	await tracker.refresh();
	assert.equal(calls.length, 2, "the boundary overrides the interval");
	assert.deepEqual(tracker.snapshot().claude, { fiveHour: 97, sevenDay: 54 });
});

test("UsageTracker lets a backoff outrank a window boundary", async () => {
	// Otherwise a rate-limited endpoint would be polled again the moment its
	// window rolled, which is exactly when we least want to argue with it.
	const authPath = await writeAuthFile(claudeOnlyAuth);
	const calls: FetchCall[] = [];
	let now = RESET_MS - 1_000;
	const responses: Record<string, unknown> = { [CLAUDE_URL]: claudePayloadResettingAt(RESET_ISO) };
	const tracker = makeTracker({ authPath, fetchFn: fakeFetch(responses, calls), now: () => now });
	await tracker.refresh();

	// Crossing the boundary triggers the poll, and that poll is rate limited. The
	// failed fetch leaves the old value and its now-passed boundary in place.
	responses[CLAUDE_URL] = new RateLimited(String(USAGE_RATE_LIMIT_BACKOFF_MS / 1000));
	now = RESET_MS;
	await tracker.refresh();
	assert.equal(calls.length, 2, "the boundary prompted a poll");

	// The boundary is still in the past, so it would prompt another poll every
	// tick from here on. The backoff is what has to stop it.
	now = RESET_MS + 1_000;
	responses[CLAUDE_URL] = claudePayloadResettingAt("2026-08-14T05:29:59+00:00");
	await tracker.refresh();
	assert.equal(calls.length, 2, "the boundary does not punch through an active backoff");

	now = RESET_MS + USAGE_RATE_LIMIT_BACKOFF_MS;
	await tracker.refresh();
	assert.equal(calls.length, 3, "and polling resumes once the backoff expires");
});

test("UsageTracker keeps a value that carries no reset boundary", async () => {
	// Entries written by an earlier statusline have no boundary, and a payload
	// may simply omit one; neither may start expiring instantly.
	const authPath = await writeAuthFile(claudeOnlyAuth);
	const calls: FetchCall[] = [];
	let now = 0;
	const responses: Record<string, unknown> = {
		[CLAUDE_URL]: { five_hour: { utilization: 3.0 }, seven_day: { utilization: 46.0 } },
	};
	const tracker = makeTracker({ authPath, fetchFn: fakeFetch(responses, calls), now: () => now });
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot().claude, { fiveHour: 97, sevenDay: 54 });

	responses[CLAUDE_URL] = 500;
	now = USAGE_REFRESH_INTERVAL_MS - 1;
	await tracker.refresh();
	assert.deepEqual(tracker.snapshot().claude, { fiveHour: 97, sevenDay: 54 }, "no boundary means no expiry");
	assert.equal(calls.length, 1, "and no boundary-driven poll");
});

test("UsageTracker retries a boundary once, not on every tick, when the poll keeps failing", async () => {
	// Found by a live canary. A failed poll leaves the boundary in the past, so
	// an unconditional boundary override would re-poll on every ten-second tick
	// for as long as the failure lasted. A 429 sets a backoff that stops that; a
	// 500, a timeout or a dropped connection does not. Answering a boundary once
	// hands the account back to the ordinary intervals — here the short retry
	// window, because the expired value leaves this provider holding nothing.
	const authPath = await writeAuthFile(claudeOnlyAuth);
	const calls: FetchCall[] = [];
	let now = RESET_MS - USAGE_REFRESH_INTERVAL_MS;
	const responses: Record<string, unknown> = { [CLAUDE_URL]: claudePayloadResettingAt(RESET_ISO) };
	const tracker = makeTracker({ authPath, fetchFn: fakeFetch(responses, calls), now: () => now });
	await tracker.refresh();
	assert.equal(calls.length, 1);

	// The window rolls and the endpoint is broken in a way that sets no backoff.
	responses[CLAUDE_URL] = 500;
	now = RESET_MS;
	await tracker.refresh();
	assert.equal(calls.length, 2, "the boundary is answered once");

	// Ticks inside the retry window must not poll. Without answering-once these
	// would each fire, because the boundary stays in the past forever.
	for (const tick of [10_000, 20_000, USAGE_RETRY_INTERVAL_MS - 1]) {
		now = RESET_MS + tick;
		await tracker.refresh();
	}
	assert.equal(calls.length, 2, "and not answered again on every following tick");

	// The ordinary rules govern from there. The expired value left this provider
	// with nothing, so that is the short retry window rather than five minutes.
	now = RESET_MS + USAGE_RETRY_INTERVAL_MS;
	responses[CLAUDE_URL] = claudePayloadResettingAt("2026-08-14T05:29:59+00:00");
	await tracker.refresh();
	assert.equal(calls.length, 3, "the retry window resumes governing once the boundary is answered");
	assert.deepEqual(tracker.snapshot().claude, { fiveHour: 97, sevenDay: 54 });
});
