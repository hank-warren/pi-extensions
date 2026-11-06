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

test("a custom typed answer is marked as typed", () => {
	const result = buildResponse(
		{
			answers: [{ questionIndex: 0, question: "Which database?", answer: "DuckDB", custom: true, notes: "n" }],
			cancelled: false,
		},
		params,
	);
	assert.equal(
		result.content[0].text,
		`${ENVELOPE_PREFIX} "Which database?"="DuckDB" (typed by the user). user notes: n. ${ENVELOPE_SUFFIX}`,
	);
});

test("a multi-select answer with typed text says it includes typed text", () => {
	const result = buildResponse(
		{
			answers: [
				{ questionIndex: 0, question: "Which database?", answer: "Postgres, DuckDB", custom: true, selected: ["Postgres", "DuckDB"] },
			],
			cancelled: false,
		},
		params,
	);
	assert.match(result.content[0].text, /"Postgres, DuckDB" \(includes text the user typed\)\./);
});

test("a chosen option's preview stays in details and out of the text", () => {
	const answers = [{ questionIndex: 0, question: "Which database?", answer: "Postgres", custom: false, preview: "PREVIEW_CANARY" }];
	const result = buildResponse({ answers, cancelled: false }, params);
	assert.equal(result.content[0].text, `${ENVELOPE_PREFIX} "Which database?"="Postgres". ${ENVELOPE_SUFFIX}`);
	assert.equal(result.details.answers[0].preview, "PREVIEW_CANARY");
});

test("answers given before a decline follow the decline message, in question order", () => {
	const two: AskUserParams = {
		questions: [...params.questions, { ...params.questions[0], question: "Which cache?", header: "Cache" }],
	};
	const result = buildResponse(
		{
			answers: [
				{ questionIndex: 1, question: "Which cache?", answer: "Redis", custom: false },
				{ questionIndex: 0, question: "Which database?", answer: "Postgres", custom: false, notes: "for now" },
			],
			cancelled: true,
		},
		two,
	);
	assert.equal(
		result.content[0].text,
		`${DECLINE_MESSAGE}. Before declining, the user answered: "Which database?"="Postgres". user notes: for now. "Which cache?"="Redis".`,
	);
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.answers.length, 2);
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
