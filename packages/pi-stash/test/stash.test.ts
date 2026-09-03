import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Point the extension at a path that cannot exist before it is imported, so the
// suite exercises the built-in default and never reads the developer's own
// ~/.pi/agent/pi-stash.json. Config behaviour is covered in config.test.ts.
process.env.PI_STASH_CONFIG = join(tmpdir(), "pi-stash-absent-config-fixture.json");

const { default: stashExtension } = await import("../index.ts");

type ShortcutHandler = (ctx: ExtensionContext) => Promise<void> | void;

interface Registered {
	shortcuts: Array<{ key: string; description?: string; handler: ShortcutHandler }>;
	tools: string[];
	commands: string[];
	handlers: string[];
	flags: string[];
}

function loadExtension(): Registered {
	const registered: Registered = {
		shortcuts: [],
		tools: [],
		commands: [],
		handlers: [],
		flags: [],
	};
	const pi = {
		registerShortcut: (
			key: string,
			options: { description?: string; handler: ShortcutHandler },
		) => {
			registered.shortcuts.push({ key, ...options });
		},
		registerTool: (tool: { name: string }) => registered.tools.push(tool.name),
		registerCommand: (name: string) => registered.commands.push(name),
		registerFlag: (name: string) => registered.flags.push(name),
		on: (event: string) => registered.handlers.push(event),
	} as unknown as ExtensionAPI;
	stashExtension(pi);
	return registered;
}

/**
 * A stand-in for the editor and dialog surface pi-stash touches. `select`
 * answers with whatever `respond` returns, so a test can cancel (undefined),
 * pick by index, or assert on the option list it was given.
 */
class FakeUI {
	editorText = "";
	pasted: string[] = [];
	setCalls: string[] = [];
	notifications: string[] = [];
	selectCalls: Array<{ title: string; options: string[] }> = [];
	respond: (options: string[]) => string | undefined = () => undefined;
	sent: string[] = [];

	getEditorText(): string {
		return this.editorText;
	}

	setEditorText(text: string): void {
		this.setCalls.push(text);
		this.editorText = text;
	}

	pasteToEditor(text: string): void {
		this.pasted.push(text);
		// Pi collapses large pastes to a marker; the extension must never depend
		// on the editor holding the literal text back.
		this.editorText = text.length > 200 ? "[paste #1 +many lines]" : text;
	}

	notify(message: string): void {
		this.notifications.push(message);
	}

	async select(title: string, options: string[]): Promise<string | undefined> {
		this.selectCalls.push({ title, options });
		return this.respond(options);
	}

	get ctx(): ExtensionContext {
		return { ui: this } as unknown as ExtensionContext;
	}
}

function pressShortcut(registered: Registered, ui: FakeUI): Promise<void> {
	return Promise.resolve(registered.shortcuts[0].handler(ui.ctx));
}

async function stash(registered: Registered, ui: FakeUI, text: string): Promise<void> {
	ui.editorText = text;
	await pressShortcut(registered, ui);
}

test("registers exactly one alt+s shortcut and nothing else", () => {
	const registered = loadExtension();
	assert.equal(registered.shortcuts.length, 1);
	assert.equal(registered.shortcuts[0].key, "alt+s");
	assert.match(String(registered.shortcuts[0].description), /stash/i);
	assert.deepEqual(registered.tools, []);
	assert.deepEqual(registered.commands, []);
	assert.deepEqual(registered.handlers, []);
	assert.deepEqual(registered.flags, []);
});

test("a configured key replaces the default", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-stash-key-"));
	const path = join(dir, "pi-stash.json");
	writeFileSync(path, '{ "shortcut": "ctrl+shift+p" }');
	const previous = process.env.PI_STASH_CONFIG;
	process.env.PI_STASH_CONFIG = path;
	try {
		const registered = loadExtension();
		assert.equal(registered.shortcuts.length, 1);
		assert.equal(registered.shortcuts[0].key, "ctrl+shift+p");
	} finally {
		process.env.PI_STASH_CONFIG = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an invalid config warns inside the first notification, then stops", async () => {
	// Regression: warning and action were two notify calls, so the action's
	// message replaced the warning on screen and it was never read.
	const dir = mkdtempSync(join(tmpdir(), "pi-stash-bad-"));
	const path = join(dir, "pi-stash.json");
	writeFileSync(path, '{ "shortcuts": "alt+s" }');
	const previous = process.env.PI_STASH_CONFIG;
	process.env.PI_STASH_CONFIG = path;
	try {
		const registered = loadExtension();
		assert.equal(registered.shortcuts[0].key, "alt+s");

		const ui = new FakeUI();
		await stash(registered, ui, "first draft");
		assert.equal(ui.notifications.length, 1);
		assert.match(ui.notifications[0], /unknown field: shortcuts/);
		assert.match(ui.notifications[0], /using Alt\+S/);
		// The action still reports itself in the same line.
		assert.match(ui.notifications[0], /Stashed prompt #1/);

		// Said once: the second press carries no warning.
		await stash(registered, ui, "second draft");
		assert.equal(ui.notifications.length, 2);
		assert.doesNotMatch(ui.notifications[1], /invalid config/);
	} finally {
		process.env.PI_STASH_CONFIG = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the off sentinel registers no shortcut at all", () => {
	// The point of `off` is leaving the key to its other owner, so registering
	// anything here — even an unreachable handler — would defeat it.
	const dir = mkdtempSync(join(tmpdir(), "pi-stash-off-"));
	const path = join(dir, "pi-stash.json");
	writeFileSync(path, '{ "shortcut": "off" }');
	const previous = process.env.PI_STASH_CONFIG;
	process.env.PI_STASH_CONFIG = path;
	try {
		const registered = loadExtension();
		assert.deepEqual(registered.shortcuts, []);
	} finally {
		process.env.PI_STASH_CONFIG = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stashing stores the text exactly, clears the editor, and reports the count", async () => {
	const registered = loadExtension();
	const ui = new FakeUI();
	await stash(registered, ui, "  draft with padding  ");

	assert.deepEqual(ui.setCalls, [""]);
	assert.equal(ui.editorText, "");
	assert.equal(ui.notifications.length, 1);
	assert.match(ui.notifications[0], /#1/);
	assert.match(ui.notifications[0], /1 stash held/);
	assert.doesNotMatch(ui.notifications[0], /stashs/);

	// Round-trip proves the stored text was not trimmed or normalized.
	ui.respond = (options) => options[0];
	await pressShortcut(registered, ui);
	assert.deepEqual(ui.pasted, ["  draft with padding  "]);
});

test("whitespace-only input is treated as an empty editor", async () => {
	const registered = loadExtension();
	const ui = new FakeUI();
	await stash(registered, ui, "  \n\t \n");

	// No stash created, and no selector to open: only the empty-list notice.
	assert.deepEqual(ui.setCalls, []);
	assert.deepEqual(ui.selectCalls, []);
	assert.equal(ui.notifications.length, 1);
	assert.match(ui.notifications[0], /No stashed prompts/);
	assert.equal(ui.editorText, "  \n\t \n");
});

test("with no stashes, the shortcut only notifies and leaves the editor alone", async () => {
	const registered = loadExtension();
	const ui = new FakeUI();
	await pressShortcut(registered, ui);

	assert.deepEqual(ui.setCalls, []);
	assert.deepEqual(ui.pasted, []);
	assert.deepEqual(ui.selectCalls, []);
	assert.equal(ui.editorText, "");
	assert.match(ui.notifications[0], /No stashed prompts/);
});

test("multiple stashes are listed newest first with unique options", async () => {
	const registered = loadExtension();
	const ui = new FakeUI();
	await stash(registered, ui, "first prompt");
	await stash(registered, ui, "second prompt");
	// Same text as #1: only the id prefix keeps the options distinguishable.
	await stash(registered, ui, "first prompt");

	await pressShortcut(registered, ui);
	const { options } = ui.selectCalls[0];
	assert.equal(options.length, 3);
	assert.equal(new Set(options).size, 3);
	assert.deepEqual(
		options.map((option) => option.split(" ")[0]),
		["#3", "#2", "#1"],
	);
	assert.match(options[0], /first prompt/);
	assert.match(options[1], /second prompt/);
});

test("cancelling the selector preserves every stash", async () => {
	const registered = loadExtension();
	const ui = new FakeUI();
	await stash(registered, ui, "keep me");
	await stash(registered, ui, "and me");

	ui.respond = () => undefined;
	await pressShortcut(registered, ui);
	assert.deepEqual(ui.pasted, []);
	assert.equal(ui.editorText, "");

	ui.respond = (options) => options[0];
	await pressShortcut(registered, ui);
	assert.equal(ui.selectCalls[1].options.length, 2);
});

test("selecting restores exactly one stash and never submits", async () => {
	const registered = loadExtension();
	const ui = new FakeUI();
	await stash(registered, ui, "older prompt");
	await stash(registered, ui, "newer prompt");

	// Pick the oldest, to prove selection is by option and not by recency.
	ui.respond = (options) => options[1];
	await pressShortcut(registered, ui);

	assert.deepEqual(ui.pasted, ["older prompt"]);
	// setEditorText is only ever the clear-on-stash calls: restoration must go
	// through paste handling, and nothing may be sent.
	assert.deepEqual(ui.setCalls, ["", ""]);
	assert.deepEqual(ui.sent, []);

	// The restored one is consumed; the other remains selectable.
	ui.editorText = "";
	ui.respond = (options) => options[0];
	await pressShortcut(registered, ui);
	assert.deepEqual(ui.selectCalls[1].options.map((option) => option.split(" ")[0]), ["#2"]);
	assert.deepEqual(ui.pasted, ["older prompt", "newer prompt"]);
	// "stashes", never "stashs": the counted noun is irregular.
	assert.match(ui.notifications.at(-1) ?? "", /0 stashes left/);

	// Restoring the last one empties the list.
	ui.editorText = "";
	await pressShortcut(registered, ui);
	assert.deepEqual(ui.selectCalls.length, 2);
	assert.match(ui.notifications.at(-1) ?? "", /No stashed prompts/);
});

test("a large pasted body survives stash and restore byte-for-byte", async () => {
	const registered = loadExtension();
	const ui = new FakeUI();
	const payload = Array.from({ length: 40 }, (_, i) => `line ${i}\twith\ttabs`).join("\n");

	// Pi expands the [paste #N] marker for getEditorText(), so the extension
	// sees the full body even though the editor shows a placeholder.
	await stash(registered, ui, payload);
	assert.equal(ui.editorText, "");

	ui.respond = (options) => options[0];
	await pressShortcut(registered, ui);
	assert.deepEqual(ui.pasted, [payload]);
	// Restored through paste handling, so the editor shows a marker again.
	assert.match(ui.editorText, /\[paste #1/);
});

test("the selector preview is a bounded single line", async () => {
	const registered = loadExtension();
	const ui = new FakeUI();
	await stash(registered, ui, `\n\n   ${"x".repeat(300)}   \nsecond line\n`);

	await pressShortcut(registered, ui);
	const [option] = ui.selectCalls[0].options;
	assert.ok(!option.includes("\n"));
	assert.ok(option.length < 120, `option too long: ${option.length}`);
	assert.match(option, /…/);
	assert.match(option, /5 lines/);
});

test("a fresh extension instance starts with no stashes", async () => {
	const first = loadExtension();
	const firstUI = new FakeUI();
	await stash(first, firstUI, "belongs to the first runtime");

	const second = loadExtension();
	const secondUI = new FakeUI();
	await pressShortcut(second, secondUI);
	assert.deepEqual(secondUI.selectCalls, []);
	assert.match(secondUI.notifications[0], /No stashed prompts/);
});
