/**
 * How the dialog is mounted, not what it renders.
 *
 * The questionnaire is deliberately NOT an overlay. An overlay is composited
 * over the bottom rows of the viewport, so the transcript underneath it is
 * unreachable — the user is already scrolled to the bottom and there is
 * nothing left to scroll. Rendering in the editor area puts the dialog in the
 * normal document flow, which pushes the transcript up instead of covering it.
 *
 * That is one argument to `ctx.ui.custom()`, easy to "restore" by accident, and
 * invisible to every other test in this package — hence this one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { registerTool } from "../ask-user-question.ts";
import type { AskUserParams, QuestionnaireResult } from "../tool/schema.ts";

type Execute = (
	toolCallId: string,
	params: unknown,
	signal: unknown,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<{ content: Array<{ text: string }>; details: QuestionnaireResult }>;

const params: AskUserParams = {
	questions: [
		{
			question: "Which database?",
			header: "Database",
			options: [
				{ label: "Postgres", description: "Relational" },
				{ label: "SQLite", description: "Embedded" },
			],
		},
	],
};

/** Registers the tool against a mock pi and returns its execute plus a probe. */
function harness() {
	let execute: Execute | undefined;
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	const pi = {
		registerTool(tool: { execute: Execute }) {
			execute = tool.execute;
		},
		events: {
			emit(channel: string, payload: unknown) {
				emitted.push({ channel, payload });
			},
		},
	};
	registerTool(pi as never);
	assert.ok(execute, "registerTool must register an executable tool");

	const customCalls: unknown[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			custom(_factory: unknown, options?: unknown) {
				customCalls.push(options);
				// Decline, so the dialog is never constructed: this test is about
				// how it is mounted, not about what it does once it is up.
				return Promise.resolve({ answers: [], cancelled: true } satisfies QuestionnaireResult);
			},
		},
	};
	return { execute: execute as Execute, ctx, customCalls, emitted };
}

test("the questionnaire is mounted in the editor area, never as an overlay", async () => {
	const h = harness();
	await h.execute("call", params, undefined, undefined, h.ctx);

	assert.equal(h.customCalls.length, 1);
	assert.equal(
		h.customCalls[0],
		undefined,
		"passing overlay options would cover the bottom of the transcript with no way to scroll to it",
	);
});

test("the blocked event is still cleared once the dialog closes", async () => {
	const h = harness();
	await h.execute("call", params, undefined, undefined, h.ctx);

	const blocked = h.emitted
		.filter((e) => e.channel === "hank:ask-user:blocked")
		.map((e) => (e.payload as { active: boolean }).active);
	assert.deepEqual(blocked, [true, false]);
});

/**
 * Cancellation. A questionnaire that ignores its AbortSignal keeps the session
 * "blocked on a human" after `Esc`, after a session replacement, and after the
 * tool call it belongs to has already been abandoned.
 */
function cancellableHarness() {
	let execute: Execute | undefined;
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	const pi = {
		registerTool(tool: { execute: Execute }) {
			execute = tool.execute;
		},
		events: {
			emit(channel: string, payload: unknown) {
				emitted.push({ channel, payload });
			},
		},
	};
	registerTool(pi as never);

	let opened = 0;
	const ctx = {
		hasUI: true,
		ui: {
			custom(factory: unknown) {
				opened += 1;
				// Drive the real dialog: `done` is what the tool awaits, and the
				// abort path has to reach it through the component itself.
				return new Promise((resolve) => {
					(factory as (...args: unknown[]) => unknown)(
						{ terminal: { rows: 24 }, requestRender() {} },
						{ fg: (_c: string, text: string) => text, bold: (text: string) => text },
						{ matches: () => false, getKeys: () => [] },
						resolve,
					);
				});
			},
		},
	};
	return { execute: execute as Execute, ctx, emitted, get opened() { return opened; } };
}

test("an already-aborted call declines without ever opening the dialog", async () => {
	const h = cancellableHarness();
	const controller = new AbortController();
	controller.abort();

	const result = await h.execute("call", params, controller.signal, undefined, h.ctx);
	assert.equal(h.opened, 0, "no dialog is mounted for a call that is already gone");
	assert.equal(result.details.cancelled, true);
	assert.deepEqual(result.details.answers, []);
});

test("aborting while the dialog is open cancels it exactly once and unblocks", async () => {
	const h = cancellableHarness();
	const controller = new AbortController();

	const pending = h.execute("call", params, controller.signal, undefined, h.ctx);
	await Promise.resolve();
	assert.equal(h.opened, 1);

	controller.abort();
	controller.abort();
	const result = await pending;

	assert.equal(result.details.cancelled, true);
	const blocked = h.emitted
		.filter((event) => event.channel === "hank:ask-user:blocked")
		.map((event) => (event.payload as { active: boolean }).active);
	assert.deepEqual(blocked, [true, false], "the blocked signal is cleared exactly once");
});

test("an answered dialog is unaffected by a later abort", async () => {
	const h = cancellableHarness();
	const controller = new AbortController();
	let done: ((value: unknown) => void) | undefined;
	const ctx = {
		hasUI: true,
		ui: {
			custom(_factory: unknown) {
				return new Promise((resolve) => {
					done = resolve;
				});
			},
		},
	};

	const pending = h.execute("call", params, controller.signal, undefined, ctx);
	await Promise.resolve();
	done?.({
		answers: [
			{ questionIndex: 0, question: "Which database?", answer: "Postgres", custom: false },
		],
		cancelled: false,
	});
	const result = await pending;
	assert.equal(result.details.cancelled, false);

	// The listener must already be gone; aborting now must not throw.
	controller.abort();
});
