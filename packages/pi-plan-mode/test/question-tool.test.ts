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
