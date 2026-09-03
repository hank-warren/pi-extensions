import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	DEFAULT_SHORTCUT,
	SHORTCUT_OFF,
	formatShortcut,
	loadStashConfig,
	parseStashConfig,
} from "../config.ts";

/** Write `body` to a scratch config file and return its path. */
function configFile(body: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-stash-config-"));
	const path = join(dir, "pi-stash.json");
	writeFileSync(path, body);
	test.after(() => rmSync(dir, { recursive: true, force: true }));
	return path;
}

test("the default key avoids every built-in pi keybinding", () => {
	// Not an arbitrary constant: ctrl+s collided with two built-ins at once
	// (app.models.save and app.session.toggleSort), which is what moved it here.
	assert.equal(DEFAULT_SHORTCUT, "alt+s");
});

test("an absent config file yields the default", () => {
	const missing = join(tmpdir(), "pi-stash-definitely-absent.json");
	assert.deepEqual(loadStashConfig(missing), { shortcut: DEFAULT_SHORTCUT });
});

test("a configured shortcut is normalized to lowercase and trimmed", () => {
	assert.deepEqual(parseStashConfig({ shortcut: "  Ctrl+Shift+P  " }), {
		shortcut: "ctrl+shift+p",
	});
});

test("an empty object keeps the default, so a config can set nothing", () => {
	assert.deepEqual(parseStashConfig({}), { shortcut: DEFAULT_SHORTCUT });
});

test("the off sentinel survives parsing so the caller can skip registration", () => {
	assert.deepEqual(parseStashConfig({ shortcut: SHORTCUT_OFF }), { shortcut: "off" });
});

test("unknown fields are rejected rather than silently ignored", () => {
	// A typo in the one field that exists must not look like success.
	assert.throws(() => parseStashConfig({ shortcuts: "alt+s" }), /unknown field: shortcuts/);
});

test("a non-object config is rejected", () => {
	assert.throws(() => parseStashConfig("alt+s"), /must be an object/);
	assert.throws(() => parseStashConfig(["alt+s"]), /must be an object/);
	assert.throws(() => parseStashConfig(null), /must be an object/);
});

test("a blank shortcut is rejected", () => {
	assert.throws(() => parseStashConfig({ shortcut: "   " }), /non-empty string/);
	assert.throws(() => parseStashConfig({ shortcut: 42 }), /non-empty string/);
});

test("malformed json falls back to the default and reports the problem", () => {
	// Loading must never throw: a broken preference file is not a reason for the
	// extension to fail to load.
	const path = configFile("{ not json");
	const config = loadStashConfig(path);
	assert.equal(config.shortcut, DEFAULT_SHORTCUT);
	assert.match(String(config.problem), /pi-stash\.json/);
});

test("a rejected value falls back to the default and reports the problem", () => {
	const path = configFile('{ "shortcut": "" }');
	const config = loadStashConfig(path);
	assert.equal(config.shortcut, DEFAULT_SHORTCUT);
	assert.match(String(config.problem), /non-empty string/);
});

test("a valid file is read from disk", () => {
	const path = configFile('{ "shortcut": "ctrl+shift+p" }');
	assert.deepEqual(loadStashConfig(path), { shortcut: "ctrl+shift+p" });
});

test("shortcuts are formatted the way a footer would render them", () => {
	assert.equal(formatShortcut("alt+s"), "Alt+S");
	assert.equal(formatShortcut("ctrl+shift+p"), "Ctrl+Shift+P");
});
