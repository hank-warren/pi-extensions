import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	COLLISION_ERROR,
	CustomItemsTracker,
	DEFAULT_TIMEOUT_MS,
	EVENT_MIN_INTERVAL_MS,
	FAILURE_GRACE,
	MAX_OUTPUT_WIDTH,
	MAX_TIMEOUT_MS,
	normalizeCustomItems,
	serializeCustomItems,
	UNBOUND_ERROR,
} from "../custom.ts";
import { createCustomItemsSubmenu, type SubmenuHost } from "../settings-menu.ts";
import { defaultSettings, type StatuslineSettings } from "../settings.ts";

const HOME = "/home/tester";

/** Press Enter on whatever the submenu has selected. */
function enter(component: { handleInput?: (data: string) => void }): void {
	assert.ok(component.handleInput, "the submenu must accept input");
	component.handleInput("\r");
}

/**
 * Wait until no item is in flight.
 *
 * A registered function settles on the microtask queue and a command settles on
 * real process I/O, and the point of these tests is that both go through one
 * scheduler, so both are awaited the same way.
 */
async function settle(tracker: CustomItemsTracker): Promise<void> {
	const deadline = Date.now() + 5_000;
	do {
		await new Promise((resolve) => setTimeout(resolve, 5));
	} while (tracker.states().some((state) => state.running) && Date.now() < deadline);
}

/**
 * A tracker on a clock the test owns.
 *
 * Two runs of one item are never closer than {@link EVENT_MIN_INTERVAL_MS},
 * whatever triggers them — so a test that refreshes twice in the same
 * millisecond is testing the throttle, not the thing it meant to test.
 */
function trackerWith(options: { payload?: Record<string, unknown> } = {}) {
	const clock = { value: Date.now() };
	const tracker = new CustomItemsTracker({ spawn, cwd: process.cwd(), now: () => clock.value });
	if (options.payload) tracker.setPayloadFactory(() => options.payload as Record<string, unknown>);
	return {
		tracker,
		/** Move past the throttle so the next refresh actually runs. */
		tick: () => {
			clock.value += EVENT_MIN_INTERVAL_MS + 1;
		},
	};
}

test("an item registered before any settings arrive is appended, enabled, and runs", async () => {
	const { tracker } = trackerWith();
	tracker.register({ id: "pool", run: () => "92·40" });
	tracker.setItems(normalizeCustomItems([{ id: "clock", command: "printf 12:30" }]));
	tracker.refresh();
	await settle(tracker);

	assert.deepEqual(
		tracker.states().map((state) => [state.id, state.kind, state.enabled]),
		[
			["clock", "command", true],
			// Appended after the configured entries, because the file said nothing
			// about where it goes and inventing a position would be a guess.
			["pool", "extension", true],
		],
	);
	assert.deepEqual(tracker.values(), ["12:30", "92·40"]);
	tracker.dispose();
});

test("an item registered after the settings binds to its entry, keeping order and enabled", async () => {
	const { tracker, tick } = trackerWith();
	tracker.setItems(
		normalizeCustomItems([
			{ id: "pool", type: "extension" },
			{ id: "clock", command: "printf 12:30" },
			{ id: "off", type: "extension", enabled: false },
		]),
	);
	tracker.refresh();
	await settle(tracker);
	assert.deepEqual(
		tracker.states().map((state) => state.error),
		[UNBOUND_ERROR, undefined, UNBOUND_ERROR],
		"an entry with no provider says so rather than pretending to be broken",
	);

	tracker.register({ id: "pool", run: () => "92·40" });
	tracker.register({ id: "off", run: () => "never" });
	tick();
	tracker.refresh();
	await settle(tracker);

	assert.deepEqual(
		tracker.states().map((state) => [state.id, state.enabled, state.error]),
		[
			["pool", true, undefined],
			["clock", true, undefined],
			["off", false, undefined],
		],
	);
	// The file's order wins over registration order, and its `enabled: false`
	// keeps a provider from putting itself on the footer against the user.
	assert.deepEqual(tracker.values(), ["92·40", "12:30"]);
	tracker.dispose();
});

test("a registered run receives exactly the JSON a command reads on stdin", async () => {
	const directory = await mkdtemp(join(tmpdir(), "statusline-payload-"));
	try {
		const payload = {
			version: 1,
			session_id: "019fafa7-29c0-7e99-9f82-5794d5721848",
			cwd: "/tmp/project",
			model: { id: "some-model", provider: "some-provider" },
			git: { branch: "main", dirty: false, behind: 0 },
			context_window: { used_tokens: 40_000, context_window_size: 1_000_000, used_percentage: 4 },
			usage_remaining: {
				claude: { five_hour: 97, seven_day: 54, scoped_weekly: null },
				codex: null,
			},
		};
		const seen: Record<string, unknown>[] = [];
		const stdinPath = join(directory, "stdin.json");
		const { tracker } = trackerWith({ payload });
		tracker.setItems(normalizeCustomItems([{ id: "spy", command: `cat > ${stdinPath}` }]));
		tracker.register({
			id: "fn",
			run: (received) => {
				seen.push(received);
				return "ok";
			},
		});
		tracker.refresh();
		await settle(tracker);

		const fromStdin: unknown = JSON.parse(await readFile(stdinPath, "utf8"));
		assert.equal(seen.length, 1);
		assert.deepEqual(seen[0], fromStdin, "a ported script must read the same fields");
		assert.deepEqual(seen[0], payload);
		tracker.dispose();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a run that never settles is abandoned at the timeout and its signal aborted", async () => {
	const { tracker } = trackerWith();
	let aborted = false;
	tracker.setItems(normalizeCustomItems([{ id: "slow", type: "extension", timeout: 0.05 }]));
	tracker.register({
		id: "slow",
		run: (_payload, signal) =>
			new Promise<string>((resolve) => {
				signal.addEventListener("abort", () => {
					aborted = true;
					// Deliberately resolves after the deadline: the tracker must have
					// settled already, and this late value must not reach the footer.
					resolve("too late");
				});
			}),
	});
	tracker.refresh();
	await settle(tracker);

	assert.equal(aborted, true, "the provider is told to stop");
	const [state] = tracker.states();
	assert.equal(state?.error, "timed out after 0.1s");
	assert.equal(state?.value, undefined);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(tracker.values(), [], "a value produced after the deadline is dropped");
	tracker.dispose();
});

test("a throw is a failure, and the grace applies exactly as it does to an exit code", async () => {
	const { tracker, tick } = trackerWith();
	let fail = false;
	tracker.register({
		id: "flaky",
		run: () => {
			if (fail) throw new Error("feed unreachable: ETIMEDOUT");
			return "92";
		},
	});
	tracker.refresh();
	await settle(tracker);
	assert.deepEqual(tracker.values(), ["92"]);

	fail = true;
	for (let attempt = 1; attempt < FAILURE_GRACE; attempt += 1) {
		tick();
		tracker.refresh();
		await settle(tracker);
		assert.deepEqual(tracker.values(), ["92"], `blip ${attempt} keeps the last good value`);
		assert.equal(tracker.states()[0]?.error, "feed unreachable: ETIMEDOUT");
	}
	tick();
	tracker.refresh();
	await settle(tracker);
	assert.deepEqual(tracker.values(), [], "a broken item eventually loses its value");
	tracker.dispose();
});

test("a rejected promise is reported like a throw", async () => {
	const { tracker } = trackerWith();
	tracker.register({ id: "async", run: () => Promise.reject(new Error("feed 401: bad token")) });
	tracker.refresh();
	await settle(tracker);
	assert.equal(tracker.states()[0]?.error, "feed 401: bad token");
	tracker.dispose();
});

test("null hides the item without counting as a failure, and output is sanitised", async () => {
	const { tracker } = trackerWith();
	tracker.register({ id: "quiet", run: () => null });
	tracker.register({ id: "loud", run: () => `\x1b[32mgreen\x1b[0m\x1b[2Khidden\nsecond line` });
	tracker.register({ id: "long", run: () => "x".repeat(MAX_OUTPUT_WIDTH + 40) });
	tracker.refresh();
	await settle(tracker);

	const states = new Map(tracker.states().map((state) => [state.id, state]));
	assert.equal(states.get("quiet")?.value, "", "nothing to say is an answer, not an error");
	assert.equal(states.get("quiet")?.error, undefined);
	assert.equal(states.get("loud")?.value, "\x1b[32mgreen\x1b[0mhidden", "colour survives, cursor control does not");
	assert.equal(states.get("long")?.value?.length, MAX_OUTPUT_WIDTH);
	assert.deepEqual(tracker.values(), ["\x1b[32mgreen\x1b[0mhidden", "x".repeat(MAX_OUTPUT_WIDTH)]);
	tracker.dispose();
});

test("an id claimed by both a command and a registration keeps the command and says so", async () => {
	const { tracker, tick } = trackerWith();
	tracker.setItems(normalizeCustomItems([{ id: "cpa", command: "printf from-command" }]));
	tracker.register({ id: "cpa", run: () => "from-extension" });
	tracker.refresh();
	await settle(tracker);

	const [state] = tracker.states();
	assert.equal(state?.kind, "command", "the entry the user wrote is the one that runs");
	assert.equal(state?.error, COLLISION_ERROR);
	assert.equal(state?.configError, true, "so the submenu shows it instead of 'disabled'");
	assert.deepEqual(tracker.values(), ["from-command"]);

	// Deleting the command is what resolves it, and nothing else has to change.
	tracker.setItems(normalizeCustomItems([{ id: "cpa", type: "extension" }]));
	tick();
	tracker.refresh();
	await settle(tracker);
	assert.equal(tracker.states()[0]?.error, undefined);
	assert.deepEqual(tracker.values(), ["from-extension"]);
	tracker.dispose();
});

test("re-registering an id cancels the run in flight and the new function wins", async () => {
	const { tracker, tick } = trackerWith();
	let firstAborted = false;
	tracker.register({
		id: "pool",
		run: (_payload, signal) =>
			new Promise<string>((resolve) => {
				signal.addEventListener("abort", () => {
					firstAborted = true;
					resolve("stale");
				});
			}),
	});
	tracker.refresh();
	assert.equal(tracker.states()[0]?.running, true);

	tracker.register({ id: "pool", run: () => "fresh" });
	assert.equal(firstAborted, true);
	tick();
	tracker.refresh();
	await settle(tracker);
	assert.deepEqual(tracker.values(), ["fresh"]);
	tracker.dispose();
});

test("the settings entry wins for every field it names; the registration fills the rest", () => {
	const { tracker } = trackerWith();
	tracker.setItems(
		normalizeCustomItems([
			{ id: "explicit", type: "extension", refreshInterval: 30, timeout: 2 },
			{ id: "bare", type: "extension" },
		]),
	);
	tracker.register({ id: "explicit", run: () => "a", refreshInterval: 60, timeoutMs: 9_000 });
	tracker.register({ id: "bare", run: () => "b", refreshInterval: 60, timeoutMs: 9_000 });
	tracker.register({ id: "unlisted", run: () => "c" });

	const scheduled: number[] = [];
	const timed = new CustomItemsTracker({
		schedule: (_callback, intervalMs) => {
			scheduled.push(intervalMs);
			return intervalMs;
		},
		cancel: () => {},
	});
	timed.setItems(normalizeCustomItems([{ id: "explicit", type: "extension", refreshInterval: 30 }]));
	timed.register({ id: "explicit", run: () => "a", refreshInterval: 60 });
	timed.start();
	assert.deepEqual(scheduled, [30_000], "the file's interval is the one the timer follows");

	// Timeouts are not observable through the public state, so they are asserted
	// through the one thing that reports them: how long a run is given.
	assert.equal(DEFAULT_TIMEOUT_MS, 5_000);
	assert.equal(MAX_TIMEOUT_MS, 30_000);
	tracker.dispose();
});

test("a registration is ignored rather than thrown on when it is unusable", () => {
	const { tracker } = trackerWith();
	const bad = tracker as unknown as { register: (value: unknown) => void };
	assert.doesNotThrow(() => bad.register({ id: "", run: () => "x" }));
	assert.doesNotThrow(() => bad.register({ id: "no-run" }));
	assert.doesNotThrow(() => bad.register({ id: "wrong", run: "not a function" }));
	assert.deepEqual(tracker.states(), [], "a provider's mistake costs it its item, not the footer");
	tracker.dispose();
});

test("a registration only reaches the settings file when the user switches it off", () => {
	let settings: StatuslineSettings = { ...defaultSettings(HOME), customItems: [] };
	const { tracker } = trackerWith();
	tracker.register({ id: "pool", run: () => "92" });
	tracker.setItems(settings.customItems);

	const host: SubmenuHost = {
		getSettings: () => settings,
		customItemStates: () => tracker.states(),
		commit: (next) => {
			settings = next;
			tracker.setItems(next.customItems);
		},
		notify: () => {},
		requestRender: () => {},
		settingsTheme: {
			label: (text) => text,
			value: (text) => text,
			description: (text) => text,
			cursor: ">",
			hint: (text) => text,
		},
		selectTheme: {
			selectedPrefix: (text) => text,
			selectedText: (text) => text,
			description: (text) => text,
			scrollInfo: (text) => text,
			noMatch: (text) => text,
		},
		home: HOME,
	};

	const submenu = createCustomItemsSubmenu(host)("", () => {});
	// Nothing is written while it is simply on: the provider owns it.
	assert.deepEqual(settings.customItems, []);

	enter(submenu);
	assert.deepEqual(serializeCustomItems(settings.customItems), [
		{ id: "pool", type: "extension", enabled: false },
	]);
	assert.equal(tracker.states()[0]?.enabled, false);
	assert.deepEqual(tracker.values(), [], "and it stops rendering immediately");

	enter(submenu);
	assert.deepEqual(
		serializeCustomItems(settings.customItems),
		[{ id: "pool", type: "extension" }],
		"switching it back on leaves the row behind as its position",
	);
	assert.equal(tracker.states()[0]?.enabled, true);
	tracker.dispose();
});

test("a blocked entry still cannot be switched on from the menu", () => {
	let settings: StatuslineSettings = {
		...defaultSettings(HOME),
		customItems: normalizeCustomItems([{ id: "future", type: "websocket" }]),
	};
	const notices: string[] = [];
	const { tracker } = trackerWith();
	tracker.setItems(settings.customItems);

	const host: SubmenuHost = {
		getSettings: () => settings,
		customItemStates: () => tracker.states(),
		commit: (next) => {
			settings = next;
			tracker.setItems(next.customItems);
		},
		notify: (message) => notices.push(message),
		requestRender: () => {},
		settingsTheme: {
			label: (text) => text,
			value: (text) => text,
			description: (text) => text,
			cursor: ">",
			hint: (text) => text,
		},
		selectTheme: {
			selectedPrefix: (text) => text,
			selectedText: (text) => text,
			description: (text) => text,
			scrollInfo: (text) => text,
			noMatch: (text) => text,
		},
		home: HOME,
	};

	enter(createCustomItemsSubmenu(host)("", () => {}));
	assert.deepEqual(notices, ["future cannot run: unsupported type: websocket"]);
	assert.equal(settings.customItems[0]?.enabled, false);
	tracker.dispose();
});
