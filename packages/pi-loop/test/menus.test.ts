/**
 * The menu screens, as pure builders.
 *
 * Every lifecycle control a loop has now lives in a menu, so the set of items
 * each screen offers *is* the surface — there is no typed subcommand left to
 * fall back on if one goes missing. Pinning the item ids is cheap here and
 * impossible through a terminal.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLoopCommand } from "../src/command.js";
import {
	HOW_LOOPS_WORK_LINES,
	loopLaunchScreen,
	loopPlanningScreen,
} from "../src/loop-launch-menu.js";
import {
	loopCadenceScreen,
	loopFocusScreen,
	type LoopManagerView,
	loopManagerScreen,
	loopStatusScreen,
} from "../src/loop-manager-menu.js";

const ACTIVE: LoopManagerView = {
	status: "active",
	headline: "⟳ loop 1/3 done · turn 4/∞ · 2m · next 18:38",
	statusLines: ["Status: active", "Interval: every 10m"],
	interval: "10m",
};

test("the launch menu is the front door: plan, settings, and an explanation", () => {
	const screen = loopLaunchScreen();
	assert.deepEqual(
		screen.items.map((item) => item.id),
		["start-planning", "settings", "how"],
	);
	assert.equal(screen.lines?.[0], "Status: Off.");
	// Starting a loop is never one keystroke from here: the first item opens a
	// drafting conversation, and the approval card is what starts anything.
	const start = screen.items.find((item) => item.id === "start-planning");
	assert.equal(start?.action, "start-planning");
	assert.match(start?.description ?? "", /until you approve/i);
});

test("How loops work explains what bounds a loop, now that turns do not", () => {
	const text = HOW_LOOPS_WORK_LINES.join("\n");
	assert.match(text, /settl/i);
	assert.match(text, /ground rules/i);
	assert.match(text, /expiry/i);
	assert.match(text, /no-progress breaker/i);
	assert.match(text, /Nothing caps the turns by default/);
});

test("the planning menu can ask for the proposal and can walk away", () => {
	const screen = loopPlanningScreen();
	assert.deepEqual(
		screen.items.map((item) => item.id),
		["request-proposal", "cancel", "settings", "how"],
	);
});

test("the manager offers Pause only while active and Resume only while paused", () => {
	const active = loopManagerScreen(ACTIVE).items.map((item) => item.id);
	assert.deepEqual(active, ["status", "pause", "focus", "cadence", "stop", "settings"]);

	const paused = loopManagerScreen({
		...ACTIVE,
		status: "paused",
		headline: "⏸ loop paused · paused by user",
	}).items.map((item) => item.id);
	assert.deepEqual(paused, ["status", "resume", "focus", "cadence", "stop", "settings"]);

	// An item that silently does nothing is the failure a menu invites, so the
	// two are mutually exclusive by construction rather than by a guard inside
	// the handler.
	assert.equal(active.includes("resume"), false);
	assert.equal(paused.includes("pause"), false);
});

test("the manager renders the same headline as the footer, and the full state behind it", () => {
	const screen = loopManagerScreen(ACTIVE);
	assert.equal(screen.title, "Loop · active");
	assert.deepEqual(screen.lines, [ACTIVE.headline]);
	assert.deepEqual(loopStatusScreen(ACTIVE).lines, ACTIVE.statusLines);
	// The cadence is on the item that edits it: a user should not have to open
	// the editor to find out what it currently is.
	assert.match(
		screen.items.find((item) => item.id === "cadence")?.description ?? "",
		/every 10m/,
	);
});

test("the focus and cadence editors show the current value and where it applies", () => {
	assert.match(loopFocusScreen(ACTIVE).lines?.join("\n") ?? "", /No focus set/);
	assert.match(
		loopFocusScreen({ ...ACTIVE, focus: "keep the diff small" }).lines?.join("\n") ?? "",
		/Currently: keep the diff small/,
	);
	assert.equal(loopFocusScreen(ACTIVE).action, "set-focus");
	assert.equal(loopCadenceScreen(ACTIVE).action, "set-cadence");
	assert.match(loopCadenceScreen(ACTIVE).lines?.join("\n") ?? "", /settles/);
});

test("the /loop grammar is a menu and a planning seed, and nothing else", () => {
	assert.deepEqual(parseLoopCommand(""), { kind: "menu" });
	assert.deepEqual(parseLoopCommand("   "), { kind: "menu" });
	assert.deepEqual(parseLoopCommand("get CI green"), { kind: "seed", text: "get CI green" });
	// The old subcommands and the old start grammar are words now. That is the
	// price of one way in, and it must be a *seed*, never a silent no-op.
	for (const removed of ["status", "pause", "resume", "stop", "settings", "5m fix the tests"]) {
		assert.deepEqual(parseLoopCommand(removed), { kind: "seed", text: removed });
	}
});
