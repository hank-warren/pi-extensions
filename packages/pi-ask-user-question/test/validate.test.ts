import assert from "node:assert/strict";
import { test } from "node:test";
import type { AskUserParams } from "../tool/schema.ts";
import { validateParams } from "../tool/validate.ts";

const ok = (): AskUserParams => ({
	questions: [
		{
			question: "Which database?",
			header: "Database",
			options: [
				{ label: "Postgres", description: "Relational, strong consistency" },
				{ label: "SQLite", description: "Embedded, zero ops" },
			],
		},
	],
});

test("a well-formed questionnaire validates", () => {
	assert.equal(validateParams(ok()), undefined);
});

test("zero questions is rejected", () => {
	assert.equal(validateParams({ questions: [] })?.code, "bad_question_count");
});

test("up to four questions are accepted", () => {
	for (const count of [1, 2, 3, 4]) {
		const params = ok();
		while (params.questions.length < count) {
			params.questions.push({ ...params.questions[0], header: `Q${params.questions.length}` });
		}
		assert.equal(validateParams(params), undefined, `${count} questions must validate`);
	}
});

test("more than four questions is rejected", () => {
	const params = ok();
	while (params.questions.length < 5) {
		params.questions.push({ ...params.questions[0], header: `Q${params.questions.length}` });
	}
	assert.equal(validateParams(params)?.code, "bad_question_count");
});

test("fewer than two options is rejected", () => {
	const params = ok();
	params.questions[0].options = [{ label: "Only", description: "one" }];
	assert.equal(validateParams(params)?.code, "bad_option_count");
});

test("more than four options is rejected", () => {
	const params = ok();
	params.questions[0].options = Array.from({ length: 5 }, (_, i) => ({
		label: `Option ${i}`,
		description: "d",
	}));
	assert.equal(validateParams(params)?.code, "bad_option_count");
});

const withOptions = (count: number, multiSelect?: boolean): AskUserParams => {
	const params = ok();
	params.questions[0].options = Array.from({ length: count }, (_, i) => ({
		label: `Option ${i}`,
		description: "d",
	}));
	if (multiSelect !== undefined) params.questions[0].multiSelect = multiSelect;
	return params;
};

test("a multi-select question accepts up to six options", () => {
	for (const count of [2, 3, 4, 5, 6]) {
		assert.equal(validateParams(withOptions(count, true)), undefined, `${count} must validate`);
	}
});

test("a multi-select question rejects seven options", () => {
	assert.equal(validateParams(withOptions(7, true))?.code, "bad_option_count");
});

test("the larger cap does not leak into single-select questions", () => {
	assert.equal(validateParams(withOptions(5))?.code, "bad_option_count");
	assert.equal(validateParams(withOptions(5, false))?.code, "bad_option_count");
});

test("the option-count message names the mode and its range", () => {
	assert.match(validateParams(withOptions(5))!.message, /2-4 entries for a single-select question/);
	assert.match(validateParams(withOptions(7, true))!.message, /2-6 entries for a multi-select question/);
});

test("preview is allowed alongside multiSelect", () => {
	const params = withOptions(6, true);
	params.questions[0].options[0].preview = "```ts\nconst a = 1;\n```";
	assert.equal(validateParams(params), undefined);
});

test("a header over 16 characters is rejected", () => {
	const params = ok();
	params.questions[0].header = "x".repeat(17);
	const error = validateParams(params);
	assert.equal(error?.code, "header_too_long");
	assert.match(error!.message, /17 characters/);
});

test("a header of exactly 16 characters is accepted", () => {
	const params = ok();
	params.questions[0].header = "x".repeat(16);
	assert.equal(validateParams(params), undefined);
});

test("a long label is accepted", () => {
	const params = ok();
	params.questions[0].options[0].label = "x".repeat(200);
	assert.equal(validateParams(params), undefined);
});

test("an empty or whitespace-only label is rejected", () => {
	for (const label of ["", "   "]) {
		const params = ok();
		params.questions[0].options[0].label = label;
		assert.equal(validateParams(params)?.code, "empty_label", `expected ${JSON.stringify(label)} to be rejected`);
	}
});

test("reserved labels are rejected in any casing or spacing", () => {
	for (const label of ["Other", "OTHER", " other ", "Type something.", "type something"]) {
		const params = ok();
		params.questions[0].options[0].label = label;
		assert.equal(validateParams(params)?.code, "reserved_label", `expected ${label} to be reserved`);
	}
});

test("duplicate labels within a question are rejected", () => {
	const params = ok();
	params.questions[0].options[1].label = "postgres";
	assert.equal(validateParams(params)?.code, "duplicate_label");
});

test("empty question text and empty headers are rejected", () => {
	const blankQuestion = ok();
	blankQuestion.questions[0].question = "   ";
	assert.equal(validateParams(blankQuestion)?.code, "empty_question");

	const blankHeader = ok();
	blankHeader.questions[0].header = "";
	assert.equal(validateParams(blankHeader)?.code, "empty_question");
});

test("validation never throws on malformed input", () => {
	assert.doesNotThrow(() => validateParams({} as AskUserParams));
	assert.doesNotThrow(() => validateParams({ questions: [{}] } as unknown as AskUserParams));
});
