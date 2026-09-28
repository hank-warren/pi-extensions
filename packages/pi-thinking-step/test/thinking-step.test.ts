import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import thinkingStepExtension, { DOWN_KEY, LEVELS, UP_KEY, type Level } from "../index.ts";

type Handler = (ctx: ExtensionContext) => Promise<void> | void;

/**
 * A fake of the slice of Pi the extension touches. `setThinkingLevel` clamps
 * like Pi's `clampThinkingLevel`: the nearest supported level above the
 * request, else the nearest below.
 */
function setup(supported: readonly Level[], initial: Level, hasUI = true) {
	const shortcuts = new Map<string, { description?: string; handler: Handler }>();
	const notifications: string[] = [];
	let level: Level = initial;
	const pi = {
		registerShortcut: (key: string, options: { description?: string; handler: Handler }) => {
			shortcuts.set(key, options);
		},
		getThinkingLevel: () => level,
		setThinkingLevel: (requested: Level) => {
			const index = LEVELS.indexOf(requested);
			level =
				LEVELS.slice(index).find((l) => supported.includes(l)) ??
				[...LEVELS.slice(0, index)].reverse().find((l) => supported.includes(l)) ??
				"off";
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI,
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionContext;
	thinkingStepExtension(pi);
	const press = async (key: string) => {
		await shortcuts.get(key)!.handler(ctx);
		return level;
	};
	return { shortcuts, notifications, press, level: () => level };
}

const DEFAULT_REASONING: Level[] = ["off", "minimal", "low", "medium", "high"];

test("registers exactly the up and down shortcuts", () => {
	const { shortcuts } = setup(LEVELS, "off");
	assert.deepEqual([...shortcuts.keys()].sort(), [DOWN_KEY, UP_KEY].sort());
});

test("steps one level at a time in each direction", async () => {
	const { press } = setup(LEVELS, "medium");
	assert.equal(await press(UP_KEY), "high");
	assert.equal(await press(UP_KEY), "xhigh");
	assert.equal(await press(DOWN_KEY), "high");
	assert.equal(await press(DOWN_KEY), "medium");
	assert.equal(await press(DOWN_KEY), "low");
});

test("stops at the model's ceiling and floor instead of wrapping", async () => {
	const top = setup(DEFAULT_REASONING, "high");
	assert.equal(await top.press(UP_KEY), "high");
	assert.deepEqual(top.notifications, ["Thinking: high (limit)"]);

	const bottom = setup(DEFAULT_REASONING, "off");
	assert.equal(await bottom.press(DOWN_KEY), "off");
	assert.deepEqual(bottom.notifications, ["Thinking: off (limit)"]);
});

test("skips levels the model does not support", async () => {
	const { press } = setup(["off", "low", "medium", "high", "max"], "low");
	assert.equal(await press(DOWN_KEY), "off");
	assert.equal(await press(UP_KEY), "low");
	assert.equal(await press(UP_KEY), "medium");
	assert.equal(await press(UP_KEY), "high");
	assert.equal(await press(UP_KEY), "max");
	assert.equal(await press(DOWN_KEY), "high");
});

test("a non-reasoning model stays off", async () => {
	const { press, notifications } = setup(["off"], "off");
	assert.equal(await press(UP_KEY), "off");
	assert.equal(await press(DOWN_KEY), "off");
	assert.deepEqual(notifications, ["Thinking: off (limit)", "Thinking: off (limit)"]);
});

test("notifies the new level, and stays silent without a UI", async () => {
	const withUI = setup(LEVELS, "low");
	await withUI.press(UP_KEY);
	assert.deepEqual(withUI.notifications, ["Thinking: medium"]);

	const headless = setup(LEVELS, "low", false);
	assert.equal(await headless.press(UP_KEY), "medium");
	assert.deepEqual(headless.notifications, []);
});
