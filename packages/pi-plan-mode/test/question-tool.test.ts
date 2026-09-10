import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support/mock-pi.js";
import planMode, { normalizePlanModeQuestionParams } from "../src/plan-mode.js";

test("plan_mode_question reports non-interactive cancellation", async () => {
	const mock = createMockPi();
	planMode(mock.pi);
	const execute = mock.tools[0]?.execute as
		| ((...args: unknown[]) => Promise<{ details?: { reason?: string } }>)
		| undefined;
	assert.ok(execute);
	const context = createMockContext({ hasUI: false });
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const result = await execute(
		"call-1",
		{
			questions: [
				{
					id: "scope",
					header: "Scope",
					question: "How broad?",
					options: [
						{ label: "Small", description: "Only the bug." },
						{ label: "Broad", description: "Include cleanup." },
					],
				},
			],
		},
		undefined,
		undefined,
		context.ctx,
	);
	assert.equal(result.details?.reason, "ui_unavailable");
});

test("normalizePlanModeQuestionParams validates question shape", () => {
	const result = normalizePlanModeQuestionParams({
		questions: [
			{
				id: "scope",
				header: "Scope",
				question: "How broad?",
				options: [
					{ label: "Small", description: "Only the bug." },
					{ label: "Broad", description: "Include nearby cleanup." },
				],
			},
		],
	});

	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.questions[0]?.options[1]?.label, "Broad");
	assert.deepEqual(normalizePlanModeQuestionParams({ questions: [] }), {
		ok: false,
		error: "questions must contain 1-3 items",
	});
});

const QUESTIONS = {
	questions: [
		{
			id: "scope",
			header: "Scope",
			question: "How broad?",
			options: [
				{ label: "Small", description: "Only the bug." },
				{ label: "Broad", description: "Include cleanup." },
			],
		},
	],
};

function questionTool(mock: ReturnType<typeof createMockPi>) {
	const tool = mock.tools.find((candidate) => candidate.name === "plan_mode_question");
	assert.ok(tool, "plan_mode_question must be registered");
	return tool.execute as (
		id: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ details?: { reason?: string } }>;
}

test("a call aborted before it renders never opens the selector", async () => {
	const mock = createMockPi();
	planMode(mock.pi);
	let opened = 0;
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => {
			opened += 1;
			return undefined;
		},
	});
	await mock.commands.get("plan")?.handler("start", context.ctx);

	const controller = new AbortController();
	controller.abort();
	const result = await questionTool(mock)(
		"call-1",
		QUESTIONS,
		controller.signal,
		undefined,
		context.ctx,
	);
	assert.equal(opened, 0, "an abandoned call must not take over the editor");
	assert.equal(result.details?.reason, "cancelled");
});

test("aborting while the selector is open cancels instead of hanging", async () => {
	const mock = createMockPi();
	planMode(mock.pi);
	const controller = new AbortController();
	let release: (() => void) | undefined;
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		// A selection the user never makes: only the abort can end this call.
		select: () =>
			new Promise<string | undefined>((resolve) => {
				release = () => resolve(undefined);
			}),
	});
	await mock.commands.get("plan")?.handler("start", context.ctx);

	const pending = questionTool(mock)(
		"call-1",
		QUESTIONS,
		controller.signal,
		undefined,
		context.ctx,
	);
	await Promise.resolve();
	controller.abort();
	const result = await pending;
	assert.equal(result.details?.reason, "cancelled");
	release?.();
});

test("a session replacement cancels an open question even without a tool signal", async () => {
	const mock = createMockPi();
	planMode(mock.pi);
	let release: (() => void) | undefined;
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: () =>
			new Promise<string | undefined>((resolve) => {
				release = () => resolve(undefined);
			}),
	});
	await mock.commands.get("plan")?.handler("start", context.ctx);

	const pending = questionTool(mock)("call-1", QUESTIONS, undefined, undefined, context.ctx);
	await Promise.resolve();
	// A new session replaces the one this question belongs to.
	await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);
	const result = await pending;
	assert.equal(result.details?.reason, "cancelled");
	release?.();
});

/**
 * Herdr. A child in Plan mode stuck on a question used to read as `working`
 * to a supervising agent in another pane, because only Auto Permissions told
 * Herdr it was blocked. The question tool now emits the same `herdr:blocked`
 * signal, labelled so the supervisor can tell it from an approval, and clears
 * it however the wait ends — the abort path is the one that matters, since a
 * throw that skipped the clear would leave the pane "blocked" forever.
 */
test("inside herdr, an open question reports blocked and an abort clears it", async () => {
	process.env.HERDR_ENV = "1";
	try {
		const mock = createMockPi();
		const herdr: unknown[] = [];
		mock.rawPi.events.on("herdr:blocked", (payload: unknown) => herdr.push(payload));
		planMode(mock.pi);
		const controller = new AbortController();
		let release: (() => void) | undefined;
		const context = createMockContext({
			hasUI: true,
			mode: "tui",
			select: () =>
				new Promise<string | undefined>((resolve) => {
					release = () => resolve(undefined);
				}),
		});
		await mock.commands.get("plan")?.handler("start", context.ctx);

		const pending = questionTool(mock)("call-1", QUESTIONS, controller.signal, undefined, context.ctx);
		await Promise.resolve();
		assert.deepEqual(herdr, [{ active: true, label: "plan question" }], "blocked while the selector is open");
		controller.abort();
		await pending;
		assert.deepEqual(herdr, [{ active: true, label: "plan question" }, { active: false }], "cleared on abort");
		release?.();
	} finally {
		delete process.env.HERDR_ENV;
	}
});

test("outside herdr, no herdr signal is emitted", async () => {
	delete process.env.HERDR_ENV;
	const mock = createMockPi();
	const herdr: unknown[] = [];
	mock.rawPi.events.on("herdr:blocked", (payload: unknown) => herdr.push(payload));
	planMode(mock.pi);
	const context = createMockContext({ hasUI: true, mode: "tui", select: () => Promise.resolve("1. Small — Only the bug.") });
	await mock.commands.get("plan")?.handler("start", context.ctx);
	await questionTool(mock)("call-1", QUESTIONS, undefined, undefined, context.ctx);
	assert.deepEqual(herdr, []);
});
