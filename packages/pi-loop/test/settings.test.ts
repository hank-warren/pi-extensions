import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_LOOP_SETTINGS,
	normalizeLoopSettings,
	readLoopSettings,
	saveLoopSettings,
} from "../src/settings.js";

test("normalizeLoopSettings applies defaults and tolerates unknown fields", () => {
	assert.deepEqual(normalizeLoopSettings({}), DEFAULT_LOOP_SETTINGS);
	assert.deepEqual(normalizeLoopSettings({ futureOption: 1 }), DEFAULT_LOOP_SETTINGS);
	assert.deepEqual(normalizeLoopSettings({ maxTurns: null })?.maxTurns, null);
	assert.deepEqual(normalizeLoopSettings({ maxTurns: 60 })?.maxTurns, 60);
	assert.deepEqual(
		normalizeLoopSettings({ compaction: { threshold: 0.5 } })?.compaction,
		{ ...DEFAULT_LOOP_SETTINGS.compaction, threshold: 0.5 },
	);
	// Removed legacy keys are tolerated as unknown fields, not validated.
	assert.deepEqual(normalizeLoopSettings({ pokePreamble: 5 }), DEFAULT_LOOP_SETTINGS);
	// inlineInvocation went with the inline `/loop` token it controlled. A file
	// still carrying it — in any shape — loads, ignored, rather than failing a
	// user's whole settings file for a switch that no longer exists.
	assert.deepEqual(normalizeLoopSettings({ inlineInvocation: true }), DEFAULT_LOOP_SETTINGS);
	assert.deepEqual(normalizeLoopSettings({ inlineInvocation: "yes" }), DEFAULT_LOOP_SETTINGS);
	// Turns are unlimited by default: the expiry and the no-progress breaker are
	// the real bounds, and a turn budget stops a loop mid-work with nothing decided.
	assert.equal(DEFAULT_LOOP_SETTINGS.maxTurns, null);
	assert.equal(normalizeLoopSettings({})?.maxTurns, null);
	assert.equal(normalizeLoopSettings({})?.defaultInterval, "10m");
	assert.equal(normalizeLoopSettings({ defaultInterval: "30m" })?.defaultInterval, "30m");
	// postCompactContinuation was removed with the continuation itself: a file
	// in the wild still carrying it (in any shape) loads, ignored.
	assert.deepEqual(
		normalizeLoopSettings({ compaction: { postCompactContinuation: true } }),
		DEFAULT_LOOP_SETTINGS,
	);
	assert.deepEqual(
		normalizeLoopSettings({ compaction: { postCompactContinuation: "yes" } }),
		DEFAULT_LOOP_SETTINGS,
	);
});

test("normalizeLoopSettings fails closed on invalid values", () => {
	for (const bad of [
		null,
		"settings",
		{ maxTurns: 0 },
		{ maxTurns: 1.5 },
		{ maxTurns: "lots" },
		// A legacy cap key is adopted, not ignored, so an invalid one still fails
		// the file closed exactly as it did when the key was current.
		{ maxIterations: 0 },
		{ automaticTurns: 1.5 },
		{ maxLoopDuration: "week" },
		{ maxLoopDuration: 7 },
		{ compaction: "on" },
		{ compaction: { threshold: 0 } },
		{ compaction: { threshold: 1 } },
		{ compaction: { enabled: "yes" } },
		{ compaction: { instructions: "" } },
		{ defaultInterval: "soon" },
		{ defaultInterval: 600000 },
	]) {
		assert.equal(normalizeLoopSettings(bad), undefined, JSON.stringify(bad));
	}
});

test("readLoopSettings distinguishes missing, loaded, and invalid files", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-loop-settings-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "pi-loop.json");

	const missing = readLoopSettings(path);
	assert.equal(missing.kind, "missing");
	assert.deepEqual(missing.settings, DEFAULT_LOOP_SETTINGS);

	writeFileSync(path, JSON.stringify({ maxTurns: 10 }));
	const loaded = readLoopSettings(path);
	assert.equal(loaded.kind, "loaded");
	assert.equal(loaded.settings.maxTurns, 10);

	writeFileSync(path, "{broken");
	const invalid = readLoopSettings(path);
	assert.equal(invalid.kind, "invalid");
	assert.deepEqual(invalid.settings, DEFAULT_LOOP_SETTINGS);

	writeFileSync(path, JSON.stringify({ maxTurns: -1 }));
	assert.equal(readLoopSettings(path).kind, "invalid");

	// A pre-removal file loads cleanly, keeping every other setting.
	writeFileSync(
		path,
		JSON.stringify({ maxTurns: 10, compaction: { postCompactContinuation: true, threshold: 0.5 } }),
	);
	const legacy = readLoopSettings(path);
	assert.equal(legacy.kind, "loaded");
	assert.equal(legacy.settings.maxTurns, 10);
	assert.equal(legacy.settings.compaction.threshold, 0.5);
});

test("a file written before the caps collapsed keeps the tighter of them", (t) => {
	// The two caps `maxTurns` replaced counted different things, and a settings
	// file in the wild still names them. Rewriting your settings to keep a cap
	// you already chose is not a trade worth asking for, so the smaller of the
	// two — the bound the loops were already running under — is adopted.
	const directory = mkdtempSync(join(tmpdir(), "pi-loop-legacy-caps-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "pi-loop.json");

	assert.equal(normalizeLoopSettings({ maxIterations: 10, automaticTurns: 40 })?.maxTurns, 10);
	assert.equal(normalizeLoopSettings({ maxIterations: 40, automaticTurns: 10 })?.maxTurns, 10);
	assert.equal(normalizeLoopSettings({ automaticTurns: 40 })?.maxTurns, 40);
	assert.equal(normalizeLoopSettings({ maxIterations: null, automaticTurns: 40 })?.maxTurns, 40);
	assert.equal(normalizeLoopSettings({ maxIterations: null, automaticTurns: null })?.maxTurns, null);
	// An explicit maxTurns is the answer; the superseded keys are then ignored.
	assert.equal(normalizeLoopSettings({ maxTurns: 5, maxIterations: 40 })?.maxTurns, 5);

	writeFileSync(path, JSON.stringify({ maxIterations: 10, automaticTurns: 40, future: 1 }));
	const loaded = readLoopSettings(path);
	assert.equal(loaded.kind, "loaded");
	assert.equal(loaded.settings.maxTurns, 10);

	// Saving migrates the file: unknown fields survive, superseded caps do not,
	// because two numbers where only one applies is worse than a rename.
	saveLoopSettings(loaded.settings, path);
	const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	assert.equal(saved.maxTurns, 10);
	assert.equal("maxIterations" in saved, false);
	assert.equal("automaticTurns" in saved, false);
	assert.equal(saved.future, 1);
});

test("saveLoopSettings writes atomically and preserves unknown fields", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-loop-settings-save-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "pi-loop.json");
	writeFileSync(
		path,
		JSON.stringify({
			future: { keep: true },
			maxTurns: 10,
			inlineInvocation: true,
			compaction: { threshold: 0.5, futureNested: "keep", postCompactContinuation: true },
		}),
	);

	saveLoopSettings(
		{
			...structuredClone(DEFAULT_LOOP_SETTINGS),
			maxTurns: 40,
			compaction: { ...DEFAULT_LOOP_SETTINGS.compaction, threshold: 0.6 },
		},
		path,
	);

	// A removed setting is dropped on save rather than preserved: keeping a
	// switch that controls nothing is worse than losing it.
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		future: { keep: true },
		maxTurns: 40,
		noProgressTurns: 3,
		maxLoopDuration: "7d",
		defaultInterval: "10m",
		compaction: {
			futureNested: "keep",
			// Removed, so preserved verbatim rather than rewritten.
			postCompactContinuation: true,
			enabled: true,
			threshold: 0.6,
			instructions: null,
		},
	});

	// Refuses to save over an unrecognizable file.
	writeFileSync(path, "{broken");
	assert.throws(() => saveLoopSettings(structuredClone(DEFAULT_LOOP_SETTINGS), path));
});
