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
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	const pi = {
		registerTool(tool: { execute: Execute }) {
			execute = tool.execute;
		},
		events: {
			emit(channel: string, payload: unknown) {
				emitted.push({ channel, payload });
				for (const handler of handlers.get(channel) ?? []) handler(payload);
			},
			on(channel: string, handler: (data: unknown) => void) {
				handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
				return () => {};
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
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	const pi = {
		registerTool(tool: { execute: Execute }) {
			execute = tool.execute;
		},
		events: {
			emit(channel: string, payload: unknown) {
				emitted.push({ channel, payload });
				for (const handler of handlers.get(channel) ?? []) handler(payload);
			},
			on(channel: string, handler: (data: unknown) => void) {
				handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
				return () => {};
			},
		},
	};
	registerTool(pi as never);

	let opened = 0;
	let component: unknown;
	const ctx = {
		hasUI: true,
		ui: {
			custom(factory: unknown) {
				opened += 1;
				// Drive the real dialog: `done` is what the tool awaits, and the
				// abort path has to reach it through the component itself.
				return new Promise((resolve) => {
					component = (factory as (...args: unknown[]) => unknown)(
						{ terminal: { rows: 24 }, requestRender() {} },
						{ fg: (_c: string, text: string) => text, bold: (text: string) => text },
						{ matches: () => false, getKeys: () => [] },
						resolve,
					);
				});
			},
		},
	};
	return { execute: execute as Execute, ctx, emitted, pi, get opened() { return opened; }, get dialog() { return component as { handleInput(k: string): void }; } };
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

/**
 * Herdr. A child pi session stuck on a question used to read as `working` to
 * a supervising agent in another pane, because only Auto Permissions told
 * Herdr it was blocked. The questionnaire now emits the same `herdr:blocked`
 * signal, labelled so the supervisor can tell a question from an approval.
 */
test("inside herdr, the questionnaire reports itself as blocked on a human and clears it", async () => {
	process.env.HERDR_ENV = "1";
	try {
		const h = harness();
		await h.execute("call", params, undefined, undefined, h.ctx);
		const herdr = h.emitted.filter((e) => e.channel === "herdr:blocked").map((e) => e.payload);
		assert.deepEqual(herdr, [{ active: true, label: "question" }, { active: false }]);
	} finally {
		delete process.env.HERDR_ENV;
	}
});

test("outside herdr, no herdr signal is emitted", async () => {
	delete process.env.HERDR_ENV;
	const h = harness();
	await h.execute("call", params, undefined, undefined, h.ctx);
	assert.equal(h.emitted.filter((e) => e.channel === "herdr:blocked").length, 0);
	// The package's own event still fires either way.
	assert.equal(h.emitted.filter((e) => e.channel === "hank:ask-user:blocked").length, 2);
});

/**
 * Remote answers: a relay in the same pi process answers the open dialog by the
 * id its prompt event carried, and the tool returns what a terminal answer would.
 */
test("a remote answer settles the open dialog with the terminal's result", async () => {
	const h = cancellableHarness();
	const pending = h.execute("call", params, undefined, undefined, h.ctx);
	await Promise.resolve();

	const prompt = h.emitted.find((e) => e.channel === "hank:ask-user:prompt")?.payload as { id?: string };
	assert.ok(prompt?.id, "the prompt event names the questionnaire");

	// Wrong labels and unknown ids are dropped, never half-applied.
	answer(h, { id: prompt.id, answers: [{ choice: "MySQL" }] });
	answer(h, { id: "someone-else", answers: [{ choice: "SQLite" }] });
	answer(h, { id: prompt.id, answers: [{ choice: "SQLite", notes: " embedded is fine " }] });

	const result = await pending;
	assert.equal(result.details.cancelled, false);
	assert.deepEqual(result.details.answers, [
		{ questionIndex: 0, question: "Which database?", answer: "SQLite", custom: false, notes: "embedded is fine" },
	]);
	const closed = h.emitted.filter((e) => e.channel === "hank:ask-user:blocked").at(-1)?.payload;
	assert.deepEqual(closed, { active: false, id: prompt.id, remote: true });
});

test("a remote decline cancels like Esc", async () => {
	const h = cancellableHarness();
	const pending = h.execute("call", params, undefined, undefined, h.ctx);
	await Promise.resolve();
	const prompt = h.emitted.find((e) => e.channel === "hank:ask-user:prompt")?.payload as { id: string };
	answer(h, { id: prompt.id, cancelled: true });
	const result = await pending;
	assert.equal(result.details.cancelled, true);
});

/** Deliver a remote answer the way a relay extension would. */
function answer(h: ReturnType<typeof cancellableHarness>, payload: unknown): void {
	h.pi.events.emit("hank:ask-user:answer", payload);
}

test("a listener that answers synchronously from the prompt event is not dropped", async () => {
	const h = cancellableHarness();
	h.pi.events.on("hank:ask-user:prompt", (p: unknown) => {
		h.pi.events.emit("hank:ask-user:answer", { id: (p as { id: string }).id, answers: [{ choice: "Postgres" }] });
	});
	const result = await h.execute("call", params, undefined, undefined, h.ctx);
	assert.equal(result.details.cancelled, false);
	assert.equal(result.details.answers[0].answer, "Postgres");
});

test("a remote decline keeps answers already given in the terminal, like Esc", async () => {
	const two: AskUserParams = {
		questions: [
			params.questions[0],
			{ question: "Which cache?", header: "Cache", options: [{ label: "Redis", description: "" }, { label: "None", description: "" }] },
		],
	};
	const h = cancellableHarness();
	const pending = h.execute("call", two, undefined, undefined, h.ctx);
	await Promise.resolve();
	h.dialog.handleInput("2");
	const prompt = h.emitted.find((e) => e.channel === "hank:ask-user:prompt")?.payload as { id: string };
	answer(h, { id: prompt.id, cancelled: true });
	const result = await pending;
	assert.equal(result.details.cancelled, true);
	assert.deepEqual(result.details.answers.map((a) => a.answer), ["SQLite"]);
});
