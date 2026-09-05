import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CustomItemsTracker,
	DEFAULT_TIMEOUT_MS,
	FAILURE_GRACE,
	MAX_TIMEOUT_MS,
	normalizeCustomItems,
	sameCustomItems,
	sanitizeOutput,
	serializeCustomItems,
} from "../custom.ts";
import { renderStatusline, type StatuslineData } from "../index.ts";
import { buildCustomItemSetupPrompt } from "../custom-setup.ts";
import { ADD_CUSTOM_ITEM_VALUE, customItemRows, customItemsSummary } from "../settings-menu.ts";
import { defaultSettings, normalizeSettings, serializeSettings } from "../settings.ts";

const HOME = "/home/hank";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (value: string): string => value.replace(ANSI, "");

/**
 * Wait until no command is in flight.
 *
 * Spawning is real I/O, so a fixed number of microtask turns is a race: the
 * first run usually lands and a later one does not, which reads as a logic bug.
 */
async function settle(tracker: CustomItemsTracker): Promise<void> {
	const deadline = Date.now() + 5_000;
	do {
		await new Promise((resolve) => setTimeout(resolve, 5));
	} while (tracker.states().some((state) => state.running) && Date.now() < deadline);
}

test("an entry is parsed into a runnable item with Claude Code's field names", () => {
	const [item] = normalizeCustomItems([
		{ id: "cpa", type: "command", command: "cpa-quota --line", refreshInterval: 60, timeout: 3 },
	]);
	assert.equal(item?.id, "cpa");
	assert.equal(item?.command, "cpa-quota --line");
	assert.equal(item?.refreshInterval, 60);
	assert.equal(item?.timeoutMs, 3000);
	assert.equal(item?.enabled, true);
	assert.equal(item?.error, undefined);
});

test("omitted fields take defaults and a runaway timeout is clamped", () => {
	const [plain, huge] = normalizeCustomItems([
		{ command: "date" },
		{ command: "sleep 600", timeout: 3600 },
	]);
	assert.equal(plain?.id, "item-1", "an unnamed item still gets a stable id");
	assert.equal(plain?.timeoutMs, DEFAULT_TIMEOUT_MS);
	assert.equal(plain?.refreshInterval, undefined, "no interval means event-driven only");
	assert.equal(huge?.timeoutMs, MAX_TIMEOUT_MS, "a statusline may never block on a hang");
});

test("duplicate ids are disambiguated so a toggle cannot move the wrong item", () => {
	const items = normalizeCustomItems([{ id: "x", command: "a" }, { id: "x", command: "b" }]);
	assert.deepEqual(
		items.map((item) => item.id),
		["x", "x#2"],
	);
});

test("an invalid entry is kept, flagged, and never runs", () => {
	const items = normalizeCustomItems([
		{ id: "ok", command: "date" },
		{ id: "empty", command: "   " },
		{ id: "future", type: "websocket", command: "date" },
		"nonsense",
	]);
	assert.equal(items.length, 4, "every entry survives parsing");
	assert.equal(items[1]?.error, "missing command");
	assert.equal(items[2]?.error, "unsupported type: websocket");
	assert.equal(items[3]?.error, "not an object");
	for (const item of items.slice(1)) assert.equal(item.enabled, false, "an unusable entry is not run");
});

test("a file this version cannot fully read survives a write of an unrelated setting", () => {
	// The failure this prevents: someone toggles a checkbox and their carefully
	// written items — or a newer release's item type — vanish from the file.
	const onDisk = {
		showUsage: false,
		customItems: [
			{ id: "cpa", command: "cpa-quota --line", refreshInterval: 60, futureKey: { nested: true } },
			{ id: "next", type: "websocket", url: "wss://example.test" },
		],
	};
	const { settings, extra } = normalizeSettings(onDisk, HOME);
	const written = serializeSettings({ ...settings, showModel: false }, extra, HOME);
	assert.deepEqual(
		written.customItems,
		[
			{ id: "cpa", command: "cpa-quota --line", refreshInterval: 60, futureKey: { nested: true } },
			// Disabled because it cannot run here, which is recorded rather than
			// dropping the entry a newer version understands.
			{ id: "next", type: "websocket", url: "wss://example.test", enabled: false },
		],
		"unknown per-item keys and unsupported types round-trip untouched",
	);
});

test("serialization writes enabled only when it is off", () => {
	const items = normalizeCustomItems([{ id: "a", command: "date", enabled: true }]);
	assert.deepEqual(serializeCustomItems(items), [{ id: "a", command: "date" }], "the default is not written back");
	assert.deepEqual(serializeCustomItems([{ ...items[0]!, enabled: false }]), [
		{ id: "a", command: "date", enabled: false },
	]);
});

test("items diff by content, so a reparse of the same file is not a change", () => {
	const source = [{ id: "a", command: "date" }];
	assert.ok(sameCustomItems(normalizeCustomItems(source), normalizeCustomItems(source)));
	assert.ok(!sameCustomItems(normalizeCustomItems(source), normalizeCustomItems([{ id: "a", command: "date -u" }])));
});

test("output keeps colour but loses anything that could corrupt the frame", () => {
	assert.equal(sanitizeOutput("\x1b[32mok\x1b[0m\n"), "\x1b[32mok\x1b[0m", "SGR colour survives");
	assert.equal(sanitizeOutput("first\nsecond"), "first", "only the first line is a segment");
	assert.equal(sanitizeOutput("a\x1b[2Kb"), "ab", "erase-line is stripped");
	assert.equal(sanitizeOutput("a\x1b[3Ab"), "ab", "cursor movement is stripped");
	assert.equal(sanitizeOutput("a\x07\x00b"), "ab", "control characters are stripped");
	assert.equal(sanitizeOutput("a\tb"), "a b", "tabs become spaces");
	assert.equal(sanitizeOutput("x".repeat(500)).length, 120, "output is bounded");
});

test("a command's stdout becomes a segment after the usage meters", async () => {
	const tracker = new CustomItemsTracker({ spawn, cwd: process.cwd() });
	tracker.setItems(normalizeCustomItems([{ id: "hi", command: "printf 'cpa 22/55'" }]));
	tracker.refresh();
	await settle(tracker);
	assert.deepEqual(tracker.values(), ["cpa 22/55"]);

	const data: StatuslineData = {
		model: "gpt-5.6-sol",
		cwd: "pi-extensions",
		cwdGit: null,
		contextTokens: 40_000,
		contextWindow: 1_000_000,
		worktrees: [],
		sessionId: "session-id",
		usage: { codex: { weekly: 80 } },
		customValues: tracker.values(),
	};
	const settings = defaultSettings(HOME);
	assert.equal(
		stripAnsi(renderStatusline(data, 160, settings)[0] ?? ""),
		"gpt-5.6-sol | pi-extensions | 40k/1.0m | \uec81 80 | cpa 22/55",
		"the custom segment follows the usage meters",
	);
	assert.equal(
		stripAnsi(renderStatusline(data, 160, { ...settings, showCustomItems: false })[0] ?? ""),
		"gpt-5.6-sol | pi-extensions | 40k/1.0m | \uec81 80",
		"hiding the segment leaves no stray separator",
	);
	tracker.dispose();
});

test("the session payload reaches the command on stdin", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-statusline-custom-"));
	const script = join(directory, "read-payload.mjs");
	// A script file rather than an inline one-liner: this asserts the documented
	// contract (a program reading JSON from stdin), and nested shell quoting in
	// the test would be testing the test.
	await writeFile(
		script,
		[
			'let data = "";',
			'process.stdin.on("data", (chunk) => { data += chunk; });',
			'process.stdin.on("end", () => {',
			"  const payload = JSON.parse(data);",
			'  process.stdout.write(`${payload.model.id} ${payload.usage_remaining.codex.weekly}`);',
			"});",
		].join("\n"),
	);

	const tracker = new CustomItemsTracker({ spawn, cwd: process.cwd() });
	tracker.setPayloadFactory(() => ({ model: { id: "gpt-5.6-sol" }, usage_remaining: { codex: { weekly: 55 } } }));
	tracker.setItems(normalizeCustomItems([{ id: "echo", command: `node ${script}` }]));
	tracker.refresh();
	await settle(tracker);
	assert.deepEqual(tracker.values(), ["gpt-5.6-sol 55"]);
	tracker.dispose();
	await rm(directory, { recursive: true, force: true });
});

test("COLUMNS tells the command how wide the footer is", async () => {
	const tracker = new CustomItemsTracker({ spawn, cwd: process.cwd() });
	tracker.setItems(normalizeCustomItems([{ id: "cols", command: "printf %s \"$COLUMNS\"" }]));
	tracker.setContext({ columns: 137 });
	tracker.refresh();
	await settle(tracker);
	assert.deepEqual(tracker.values(), ["137"]);
	tracker.dispose();
});

test("a failing command reports its error and keeps the last value briefly", async () => {
	// A monotonic fake clock, so consecutive refreshes are never throttled and
	// the test measures failure counting rather than wall-clock spacing.
	let clock = 0;
	const tracker = new CustomItemsTracker({ spawn, cwd: process.cwd(), now: () => (clock += 10_000) });
	// The command reads MODE from the environment the tracker passes through.
	tracker.setItems(
		normalizeCustomItems([
			{ id: "flaky", command: 'test "$MODE" = good && printf ok || { echo boom >&2; exit 3; }' },
		]),
	);
	process.env.MODE = "good";
	tracker.refresh();
	await settle(tracker);
	assert.deepEqual(tracker.values(), ["ok"]);

	process.env.MODE = "bad";
	for (let attempt = 1; attempt < FAILURE_GRACE; attempt += 1) {
		tracker.refresh();
		await settle(tracker);
		assert.deepEqual(tracker.values(), ["ok"], "one blip does not blank a value");
		assert.match(tracker.states()[0]?.error ?? "", /exit 3: boom/, "the stderr line is kept for the menu");
	}

	tracker.refresh();
	await settle(tracker);
	assert.deepEqual(tracker.values(), [], "a persistently broken command loses its stale value");
	delete process.env.MODE;
	tracker.dispose();
});

test("empty output hides the segment without counting as a failure", async () => {
	const tracker = new CustomItemsTracker({ spawn, cwd: process.cwd() });
	tracker.setItems(normalizeCustomItems([{ id: "quiet", command: "true" }]));
	tracker.refresh();
	await settle(tracker);
	assert.deepEqual(tracker.values(), []);
	assert.equal(tracker.states()[0]?.error, undefined, "printing nothing is a valid answer");
	tracker.dispose();
});

test("a hanging command is killed and reported", async () => {
	const tracker = new CustomItemsTracker({ spawn, cwd: process.cwd() });
	tracker.setItems(normalizeCustomItems([{ id: "hang", command: "sleep 30", timeout: 0.2 }]));
	tracker.refresh();
	await new Promise((resolve) => setTimeout(resolve, 700));
	assert.deepEqual(tracker.values(), []);
	assert.match(tracker.states()[0]?.error ?? "", /timed out after 0\.2s/);
	tracker.dispose();
});

test("triggers arriving during a run are dropped, not queued", async () => {
	let spawned = 0;
	const tracker = new CustomItemsTracker({
		spawn: ((command: string, args: string[], options: object) => {
			spawned += 1;
			return spawn(command, args, options as never);
		}) as never,
		cwd: process.cwd(),
	});
	tracker.setItems(normalizeCustomItems([{ id: "slow", command: "sleep 0.3; printf done" }]));
	tracker.refresh();
	tracker.refresh();
	tracker.refresh();
	assert.equal(spawned, 1, "one process per item, however many triggers arrive");
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.deepEqual(tracker.values(), ["done"]);
	tracker.dispose();
});

test("a disabled item never spawns anything", async () => {
	let spawned = 0;
	const tracker = new CustomItemsTracker({
		spawn: ((command: string, args: string[], options: object) => {
			spawned += 1;
			return spawn(command, args, options as never);
		}) as never,
		cwd: process.cwd(),
	});
	tracker.setItems(normalizeCustomItems([{ id: "off", command: "printf x", enabled: false }]));
	tracker.refresh();
	await settle(tracker);
	assert.equal(spawned, 0);
	assert.deepEqual(tracker.values(), []);
	tracker.dispose();
});

test("editing an item keeps its value until the new command answers", async () => {
	const tracker = new CustomItemsTracker({ spawn, cwd: process.cwd() });
	tracker.setItems(normalizeCustomItems([{ id: "a", command: "printf first" }]));
	tracker.refresh();
	await settle(tracker);
	assert.deepEqual(tracker.values(), ["first"]);
	tracker.setItems(normalizeCustomItems([{ id: "a", command: "printf second" }]));
	assert.deepEqual(tracker.values(), ["first"], "the footer does not blink on a settings save");
	tracker.dispose();
});

test("a removed item's value goes with it", async () => {
	const tracker = new CustomItemsTracker({ spawn, cwd: process.cwd() });
	tracker.setItems(normalizeCustomItems([{ id: "a", command: "printf x" }, { id: "b", command: "printf y" }]));
	tracker.refresh();
	await settle(tracker);
	assert.deepEqual(tracker.values(), ["x", "y"]);
	tracker.setItems(normalizeCustomItems([{ id: "b", command: "printf y" }]));
	assert.deepEqual(tracker.values(), ["y"]);
	tracker.dispose();
});

test("the timer only runs when an item asks for one", () => {
	const scheduled: number[] = [];
	const options = {
		spawn,
		schedule: (_callback: () => void, intervalMs: number) => {
			scheduled.push(intervalMs);
			return intervalMs;
		},
		cancel: () => {},
	};

	const eventDriven = new CustomItemsTracker(options);
	eventDriven.setItems(normalizeCustomItems([{ id: "a", command: "date" }]));
	eventDriven.start();
	assert.deepEqual(scheduled, [], "no refreshInterval, no timer");

	const timed = new CustomItemsTracker(options);
	timed.setItems(normalizeCustomItems([{ id: "a", command: "date", refreshInterval: 90 }, { id: "b", command: "date", refreshInterval: 30 }]));
	timed.start();
	assert.deepEqual(scheduled, [30_000], "the tick follows the most frequent item");
});

test("the submenu explains why an item is not showing", () => {
	const settings = {
		...defaultSettings(HOME),
		customItems: normalizeCustomItems([
			{ id: "cpa", command: "cpa-quota" },
			{ id: "off", command: "date", enabled: false },
			{ id: "broken", command: "" },
		]),
	};
	assert.equal(customItemsSummary(settings), "1/3 on");
	assert.equal(customItemsSummary(defaultSettings(HOME)), "none configured");

	const rows = customItemRows(settings, [
		{ id: "cpa", enabled: true, value: "cpa 22/55", running: false },
		{ id: "off", enabled: false, running: false },
		{ id: "broken", enabled: false, running: false },
	]);
	assert.deepEqual(
		rows.map((row) => row.description),
		["cpa 22/55", "disabled", "missing command", "Ask the agent to write one; it gets the contract and the settings path."],
	);
	assert.deepEqual(
		rows.map((row) => row.label),
		["on  cpa", "off  off", "off  broken", "Add custom item…"],
	);
	assert.equal(rows[3]?.value, ADD_CUSTOM_ITEM_VALUE);
	assert.equal(customItemRows(defaultSettings(HOME)).length, 1, "with no items, adding one is the only row");
});

test("the setup prompt carries the whole contract, the path, and the request", () => {
	// This message is the only place the contract reaches the agent — there is
	// deliberately no skill — so it has to be self-sufficient: the README's
	// install path is not guessable from inside a session.
	const prompt = buildCustomItemSetupPrompt("~/.pi/agent/statusline-settings.json", "  pooled codex quota across my gateway  ");
	assert.match(prompt, /^I want a custom statusline item that shows: pooled codex quota across my gateway\n/);
	for (const needle of [
		"exactly `~/.pi/agent/statusline-settings.json`",
		"do not search for or edit any other settings file",
		"customItems",
		"stdin",
		"COLUMNS",
		"usage_remaining",
		"**remaining** headroom",
		"first line of stdout",
		"Empty output hides the item",
		"refreshInterval",
		`${DEFAULT_TIMEOUT_MS / 1000}s`,
		`${MAX_TIMEOUT_MS / 1000}s`,
		"COLUMNS=120 sh -c",
		"run `/statusline` to reload",
	]) {
		assert.ok(prompt.includes(needle), `prompt lacks ${needle}`);
	}
	assert.doesNotMatch(prompt, /skill/iu, "the contract is injected, not looked up");

	const open = buildCustomItemSetupPrompt("/tmp/s.json", "");
	assert.match(open, /^I want to add a custom statusline item\. Ask me what it should show/);
});
