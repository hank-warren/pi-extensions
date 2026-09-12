import assert from "node:assert/strict";
import { test } from "node:test";
import { buildResponse, DECLINE_MESSAGE, ENVELOPE_PREFIX, ENVELOPE_SUFFIX } from "../tool/envelope.ts";
import type { AskUserParams } from "../tool/schema.ts";

const params: AskUserParams = {
	questions: [
		{
			question: "Which database?",
			header: "Database",
			options: [
				{ label: "Postgres", description: "d" },
				{ label: "SQLite", description: "d" },
			],
		},
	],
};

test("an answered questionnaire renders the pinned envelope", () => {
	const result = buildResponse(
		{
			answers: [{ questionIndex: 0, question: "Which database?", answer: "Postgres", custom: false }],
			cancelled: false,
		},
		params,
	);
	assert.equal(
		result.content[0].text,
		`${ENVELOPE_PREFIX} "Which database?"="Postgres". ${ENVELOPE_SUFFIX}`,
	);
	assert.equal(result.details.cancelled, false);
});

test("a Tab-to-comment note is appended to the answer segment", () => {
	const result = buildResponse(
		{
			answers: [
				{
					questionIndex: 0,
					question: "Which database?",
					answer: "Postgres",
					custom: false,
					notes: "but check the ops cost",
				},
			],
			cancelled: false,
		},
		params,
	);
	assert.match(result.content[0].text, /"Postgres"\. user notes: but check the ops cost\./);
});

test("cancelled collapses to the canonical decline message", () => {
	const result = buildResponse({ answers: [], cancelled: true }, params);
	assert.equal(result.content[0].text, DECLINE_MESSAGE);
	assert.equal(result.details.cancelled, true);
});

test("null and undefined outcomes decline rather than throw", () => {
	assert.equal(buildResponse(null, params).content[0].text, DECLINE_MESSAGE);
	assert.equal(buildResponse(undefined, params).content[0].text, DECLINE_MESSAGE);
});

test("a non-cancelled result with zero answers still declines", () => {
	const result = buildResponse({ answers: [], cancelled: false }, params);
	assert.equal(result.content[0].text, DECLINE_MESSAGE);
	assert.equal(result.details.cancelled, true);
});

test("error codes survive onto details for listeners", () => {
	const result = buildResponse({ answers: [], cancelled: true, error: "no_custom_ui" }, params);
	assert.equal(result.details.error, "no_custom_ui");
});

test("a custom typed answer renders like any other answer", () => {
	const result = buildResponse(
		{
			answers: [{ questionIndex: 0, question: "Which database?", answer: "DuckDB", custom: true }],
			cancelled: false,
		},
		params,
	);
	assert.match(result.content[0].text, /"Which database\?"="DuckDB"\./);
});

test("a multi-select answer renders as the joined labels", () => {
	const result = buildResponse(
		{
			answers: [
				{
					questionIndex: 0,
					question: "Which database?",
					answer: "Postgres, SQLite",
					custom: false,
					selected: ["Postgres", "SQLite"],
				},
			],
			cancelled: false,
		},
		params,
	);
	assert.equal(
		result.content[0].text,
		`${ENVELOPE_PREFIX} "Which database?"="Postgres, SQLite". ${ENVELOPE_SUFFIX}`,
	);
	assert.ok(!result.content[0].text.includes("selected preview:"), "no preview on multi-select");
});

test("a multi-select answer still takes a user note", () => {
	const result = buildResponse(
		{
			answers: [
				{
					questionIndex: 0,
					question: "Which database?",
					answer: "Postgres, SQLite",
					custom: false,
					selected: ["Postgres", "SQLite"],
					notes: "start with Postgres",
				},
			],
			cancelled: false,
		},
		params,
	);
	assert.match(result.content[0].text, /"Postgres, SQLite"\. user notes: start with Postgres\./);
});

test("partial cancellation includes committed answers and explicit unanswered questions, not approval", () => {
	const round: AskUserParams = { questions: [...params.questions, { mode: "text", header: "Why", question: "Why this choice?" }] };
	const result = buildResponse({ answers: [{ questionIndex: 0, question: "Which database?", answer: "Postgres", custom: false, notes: "not approved yet" }], cancelled: true }, round);
	assert.match(result.content[0].text, /"Which database\?"="Postgres"/);
	assert.match(result.content[0].text, /user notes: not approved yet/);
	assert.match(result.content[0].text, /Unanswered questions: 2\. "Why this choice\?"/);
	assert.match(result.content[0].text, /not approval to act/);
	assert.doesNotMatch(result.content[0].text, /You can now continue/);
	assert.equal(result.details.cancelled, true);
});

test("cancelling a fully answered review is still not submission", () => {
	const result = buildResponse({ answers: [{ questionIndex: 0, question: "Which database?", answer: "Postgres", custom: false }], cancelled: true }, params);
	assert.match(result.content[0].text, /all answered, but not submitted/);
	assert.match(result.content[0].text, /not approval to act/);
	assert.doesNotMatch(result.content[0].text, /You can now continue/);
});
