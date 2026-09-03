import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support/mock-pi.js";
import planMode from "../src/plan-mode.js";
import { PLAN_MODE_SETTINGS_FILE } from "../src/settings.js";
import { createSettingsWatcher } from "../src/settings-watch.js";

const PLAN = "# Watched plan\n\nOne step.";

/**
 * The hermetic preload's scratch agent dir (`test/support/hermetic.ts`). Every
 * helper below repoints `PI_CODING_AGENT_DIR` at a temp dir it then deletes, and
 * puts this back afterwards, so a case that runs outside a helper never inherits
 * a path that no longer exists.
 */
const PRELOAD_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

/**
 * The watch resolves its directory from getAgentDir(), so every test needs its
 * own agent directory or they observe each other's writes. The export cwd is
 * separate, so a settings edit can never be mistaken for a plan file landing.
 */
async function withAgentDir<T>(
	run: (fixture: { settingsPath: string; cwd: string }) => Promise<T>,
): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-watch-"));
	const cwd = await mkdtemp(join(tmpdir(), "pi-plan-mode-watch-cwd-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		return await run({ settingsPath: join(directory, PLAN_MODE_SETTINGS_FILE), cwd });
	} finally {
		process.env.PI_CODING_AGENT_DIR = PRELOAD_AGENT_DIR;
		await rm(directory, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
}

function settingsText(contents: unknown) {
	return typeof contents === "string" ? contents : JSON.stringify(contents);
}

function writeSettings(settingsPath: string, contents: unknown) {
	return writeFile(settingsPath, settingsText(contents), "utf8");
}

/** For bursts: two synchronous writes cannot drift apart in wall-clock time. */
function writeSettingsSync(settingsPath: string, contents: unknown) {
	writeFileSync(settingsPath, settingsText(contents), "utf8");
}

/**
 * Long enough to cover an inotify delivery plus the 75 ms reload debounce, with
 * room to spare on a loaded CI runner. Reloads leave no observable trace of
 * their own, so waiting is the only synchronisation available.
 */
const SETTLE_MS = 400;
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

/**
 * Settings have no read surface, so every assertion here goes through the
 * destination a pathless `/plan export` resolves at action time.
 */
async function assertExportsTo(
	mock: ReturnType<typeof createMockPi>,
	context: ReturnType<typeof createMockContext>,
	cwd: string,
	expected: string,
	message?: string,
) {
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(complete);
	await complete("complete", { plan: PLAN }, undefined, undefined, context.ctx);
	await mock.commands.get("plan")?.handler("export", context.ctx);
	assert.equal(await readFile(join(cwd, expected), "utf8"), `${PLAN}\n`, message);
	assert.match(context.notifications.at(-1)?.message ?? "", /Plan exported to/i);
}

async function startSession(mock: ReturnType<typeof createMockPi>, ctx: unknown) {
	await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, ctx);
}

test("a hand-edited settings file applies without restarting the session", async () => {
	await withAgentDir(async ({ settingsPath, cwd }) => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext({ cwd, hasUI: true });
		await startSession(mock, context.ctx);

		await writeSettings(settingsPath, { defaultPlanExportPath: "edited.md" });
		await settle();

		await assertExportsTo(mock, context, cwd, "edited.md");
	});
});

/**
 * A menu save lands through a temp file and an atomic rename, which replaces the
 * inode. A watch bound to the file itself goes deaf after the first save, so the
 * watch is on the directory; this pins that the second edit still arrives.
 */
test("the watch survives repeated saves", async () => {
	await withAgentDir(async ({ settingsPath, cwd }) => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext({ cwd, hasUI: true });
		await startSession(mock, context.ctx);

		await writeSettings(settingsPath, { defaultPlanExportPath: "first.md" });
		await settle();
		await writeSettings(settingsPath, { defaultPlanExportPath: "second.md" });
		await settle();

		await assertExportsTo(mock, context, cwd, "second.md", "the second edit must also apply");
	});
});

/**
 * A hand-edit is observed the moment the editor touches the file, so a partial
 * write is the common invalid read. Discarding working settings for it — with no
 * context to report the problem through — would be worse than waiting for the
 * next write.
 */
test("an unparseable mid-session edit keeps the last good settings", async () => {
	await withAgentDir(async ({ settingsPath, cwd }) => {
		await writeSettings(settingsPath, { defaultPlanExportPath: "good.md" });
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext({ cwd, hasUI: true });
		await startSession(mock, context.ctx);

		await writeSettings(settingsPath, '{"defaultPlanExportPath": "half');
		await settle();

		await assertExportsTo(mock, context, cwd, "good.md");
		assert.deepEqual(
			context.notifications.filter((entry) => entry.message.includes("settings ignored")),
			[],
			"a reload has no context to warn through; the next session start reports it",
		);
	});
});

/**
 * The other half of that rule: at session start there *is* a context to report
 * through, so an unusable file is named once and the defaults take over. The
 * mid-session case above pins the silence; this one pins the warning, so a
 * dropped `ctx` at the session-start load site cannot pass unnoticed.
 */
test("an invalid settings file is reported once at session start", async () => {
	await withAgentDir(async ({ settingsPath, cwd }) => {
		await writeSettings(settingsPath, '{"defaultPlanExportPath": "half');
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext({ cwd, hasUI: true });
		await startSession(mock, context.ctx);

		assert.equal(
			context.notifications.filter((entry) => /pi-plan-mode settings ignored/.test(entry.message))
				.length,
			1,
			"the session start names the unusable file exactly once",
		);
		await assertExportsTo(mock, context, cwd, "PLAN.md", "an unusable file leaves the defaults");
	});
});

test("deleting the settings file restores the defaults", async () => {
	await withAgentDir(async ({ settingsPath, cwd }) => {
		await writeSettings(settingsPath, { defaultPlanExportPath: "configured.md" });
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext({ cwd, hasUI: true });
		await startSession(mock, context.ctx);

		await rm(settingsPath);
		await settle();

		await assertExportsTo(mock, context, cwd, "PLAN.md");
	});
});

/**
 * A leaked watcher has no behavioural surface — the reload is generation-guarded
 * too, so a stale watch could never change anything — which leaves the kernel
 * resource itself as the only thing to assert. Linux exposes libuv's inotify
 * watch descriptors, so count them; elsewhere there is nothing to look at.
 */
const HAS_INOTIFY_FDINFO = existsSync("/proc/self/fdinfo");

function inotifyWatchCount() {
	let count = 0;
	for (const fd of readdirSync("/proc/self/fd")) {
		try {
			if (readlinkSync(`/proc/self/fd/${fd}`) !== "anon_inode:inotify") continue;
			count += readFileSync(`/proc/self/fdinfo/${fd}`, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("inotify wd:")).length;
		} catch {
			// The fd went away between listing and reading; it is not ours.
		}
	}
	return count;
}

test("session shutdown stops the watch", { skip: !HAS_INOTIFY_FDINFO }, async () => {
	await withAgentDir(async ({ cwd }) => {
		const baseline = inotifyWatchCount();
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext({ cwd, hasUI: true });
		await startSession(mock, context.ctx);
		assert.equal(inotifyWatchCount(), baseline + 1, "a live session watches its settings directory");

		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		assert.equal(inotifyWatchCount(), baseline, "a shut-down session must not still be watching");
	});
});

/**
 * Generous next to an inotify dispatch and still well under `SETTLE_MS`, so the
 * module cases below are decided by the watcher's logic rather than by how
 * loaded the runner is: a burst written in one tick is inside it, and a settle
 * is outside.
 */
const WATCHER_DEBOUNCE_MS = 150;

/**
 * The module below is what the integration cases above exercise through the
 * extension; these pin its own contract directly, where a missed event or a
 * leaked timer is visible without a plan file in the way.
 */
async function withWatchedFile<T>(
	run: (fixture: {
		path: string;
		changes: () => number;
		watcher: ReturnType<typeof createSettingsWatcher>;
	}) => Promise<T>,
): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-watcher-"));
	const path = join(directory, PLAN_MODE_SETTINGS_FILE);
	let changes = 0;
	const watcher = createSettingsWatcher({
		path,
		debounceMs: WATCHER_DEBOUNCE_MS,
		onChange: () => {
			changes += 1;
		},
	});
	try {
		return await run({ path, changes: () => changes, watcher });
	} finally {
		watcher.stop();
		await rm(directory, { recursive: true, force: true });
	}
}

test("the watcher collapses one save's events into a single change", async () => {
	await withWatchedFile(async ({ path, changes, watcher }) => {
		watcher.start();
		writeSettingsSync(path, { defaultPlanExportPath: "one.md" });
		writeSettingsSync(path, { defaultPlanExportPath: "two.md" });
		await settle();
		assert.equal(changes(), 1, "a burst of events is one reload");

		await writeSettings(path, { defaultPlanExportPath: "three.md" });
		await settle();
		assert.equal(changes(), 2, "a later save is still seen");
	});
});

test("the watcher ignores a named entry that is not its file", async () => {
	await withWatchedFile(async ({ path, changes, watcher }) => {
		watcher.start();
		await writeSettings(join(dirname(path), "other.json"), { defaultPlanExportPath: "other.md" });
		await settle();
		assert.equal(changes(), 0);
	});
});

test("stopping cancels a reload that has not fired yet", async () => {
	await withWatchedFile(async ({ path, changes, watcher }) => {
		watcher.start();
		await writeSettings(path, { defaultPlanExportPath: "discarded.md" });
		// Longer than an inotify dispatch, far shorter than the debounce: the
		// reload timer is armed and has not fired, which is the state `stop()` has
		// to cancel. Without this wait the case can pass because no timer was ever
		// armed — the opposite of what it claims to prove.
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(changes(), 0, "the debounce must not have elapsed yet");

		watcher.stop();
		await settle();
		assert.equal(changes(), 0, "a stopped watcher must not reload afterwards");
	});
});

test("an unwatchable directory costs the live reload and nothing else", async () => {
	const missing = join(tmpdir(), "pi-plan-mode-watcher-missing", PLAN_MODE_SETTINGS_FILE);
	let changes = 0;
	const watcher = createSettingsWatcher({
		path: missing,
		debounceMs: 25,
		onChange: () => {
			changes += 1;
		},
	});
	assert.doesNotThrow(() => watcher.start());
	watcher.stop();
	assert.equal(changes, 0);
});

test("an injected settings reader is never watched", async () => {
	await withAgentDir(async ({ settingsPath, cwd }) => {
		const baseline = HAS_INOTIFY_FDINFO ? inotifyWatchCount() : 0;
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi, {
			settingsPath,
			readSettings: async () => ({ kind: "loaded" as const, settings: {} }),
		});
		const context = createMockContext({ cwd, hasUI: true });
		await startSession(mock, context.ctx);

		// The destination assertion below holds either way, because the injected
		// reader outranks the file; only the watch descriptor shows whether the
		// guard that skips the watch is still there.
		if (HAS_INOTIFY_FDINFO) {
			assert.equal(inotifyWatchCount(), baseline, "an injected reader opens no watch");
		}

		await writeSettings(settingsPath, { defaultPlanExportPath: "ignored.md" });
		await settle();

		await assertExportsTo(
			mock,
			context,
			cwd,
			"PLAN.md",
			"the injected reader stays the only source",
		);
	});
});
