/**
 * Dialog behavior tests — drive the component the way a terminal would.
 *
 * These are the tests that justify skipping snapshot rendering: everything
 * worth asserting is a key sequence producing a QuestionnaireResult.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { QuestionnaireSession } from "../questionnaire.ts";
import type { AskUserParams, QuestionnaireResult } from "../tool/schema.ts";
import { QuestionnaireDialog } from "../view/dialog.ts";

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

function harness() {
	const results: QuestionnaireResult[] = [];
	const dialog = new QuestionnaireDialog({
		session: new QuestionnaireSession(params),
		done: (result) => results.push(result),
	});
	const type = (text: string) => {
		for (const ch of text) dialog.handleInput(ch);
	};
	return { dialog, results, type };
}

test("a digit hotkey answers and completes the dialog", () => {
	const h = harness();
	h.dialog.handleInput("1");
	assert.equal(h.results.length, 1);
	assert.equal(h.results[0].answers[0].answer, "Postgres");
	assert.equal(h.results[0].cancelled, false);
});

test("esc from the option list declines", () => {
	const h = harness();
	h.dialog.handleInput("\x1b");
	assert.deepEqual(h.results, [{ answers: [], cancelled: true }]);
});

test("the note key attaches a note to the chosen option", () => {
	const h = harness();
	// `n`, not Tab: Tab cycles questions (see view/dialog.ts key map).
	h.dialog.handleInput("n");
	h.type("check ops cost");
	h.dialog.handleInput("\r");
	assert.equal(h.results[0].answers[0].answer, "Postgres");
	assert.equal(h.results[0].answers[0].notes, "check ops cost");
});

test("choosing the sentinel row opens free-text entry instead of answering", () => {
	const h = harness();
	h.dialog.handleInput("3");
	assert.ok(h.dialog.isTypingCustom());
	assert.equal(h.results.length, 0, "selecting the sentinel must not complete the dialog");
});

test("a typed custom answer completes the dialog and is marked custom", () => {
	const h = harness();
	h.dialog.handleInput("3");
	h.type("DuckDB");
	h.dialog.handleInput("\r");
	assert.equal(h.results[0].answers[0].answer, "DuckDB");
	assert.equal(h.results[0].answers[0].custom, true);
});

test("esc in free-text mode returns to the options without declining", () => {
	const h = harness();
	h.dialog.handleInput("3");
	h.type("oops");
	h.dialog.handleInput("\x1b");
	assert.equal(h.results.length, 0, "one esc must unwind only one layer");
	assert.ok(!h.dialog.isTypingCustom());
	h.dialog.handleInput("2");
	assert.equal(h.results[0].answers[0].answer, "SQLite");
});

test("an empty custom answer is not submittable", () => {
	const h = harness();
	h.dialog.handleInput("3");
	h.dialog.handleInput("\r");
	assert.equal(h.results.length, 0);
	assert.ok(h.dialog.isTypingCustom());
});

test("backspace edits the custom answer", () => {
	const h = harness();
	h.dialog.handleInput("3");
	h.type("DuckDBX");
	h.dialog.handleInput("\x7f");
	h.dialog.handleInput("\r");
	assert.equal(h.results[0].answers[0].answer, "DuckDB");
});

test("a note typed on the sentinel row survives into the custom answer", () => {
	const h = harness();
	h.dialog.handleInput("\x1b[B");
	h.dialog.handleInput("\x1b[B");
	h.dialog.handleInput("n");
	h.type("none of these fit");
	h.dialog.handleInput("\r");
	assert.ok(h.dialog.isTypingCustom(), "sentinel + note should still open free text");
	h.type("DuckDB");
	h.dialog.handleInput("\r");
	assert.equal(h.results[0].answers[0].answer, "DuckDB");
	assert.equal(h.results[0].answers[0].notes, "none of these fit");
});

test("digits typed into a custom answer are literal text", () => {
	const h = harness();
	h.dialog.handleInput("3");
	h.type("option 2 but smaller");
	h.dialog.handleInput("\r");
	assert.equal(h.results[0].answers[0].answer, "option 2 but smaller");
});

test("done fires exactly once even under extra input", () => {
	const h = harness();
	h.dialog.handleInput("1");
	h.dialog.handleInput("2");
	h.dialog.handleInput("\x1b");
	assert.equal(h.results.length, 1);
});

test("render shows the question, numbered options and the sentinel row", () => {
	const h = harness();
	const out = h.dialog.render(80).join("\n");
	assert.match(out, /Which database\?/);
	assert.match(out, /1\. Postgres/);
	assert.match(out, /3\. Type something\./);
});

test("render switches to the free-text prompt after choosing the sentinel", () => {
	const h = harness();
	h.dialog.handleInput("3");
	h.type("Duck");
	const out = h.dialog.render(80).join("\n");
	assert.match(out, /Duck▌/);
	assert.match(out, /esc back to options/);
});
