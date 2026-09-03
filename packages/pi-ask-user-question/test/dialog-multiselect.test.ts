/**
 * Multi-select dialog behavior.
 *
 * The mechanic lives in `OptionSelector` (pi-permission-selector) and is tested
 * there in isolation. What is dialog-specific, and therefore tested here, is
 * how the checked set meets the questionnaire: the sentinel row APPENDING a
 * typed value to the ticks rather than replacing them, Esc unwinding one layer
 * with the ticks intact, and tab cycling staying out of the way.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { QuestionnaireSession } from "../questionnaire.ts";
import type { AskUserParams, QuestionnaireResult } from "../tool/schema.ts";
import { QuestionnaireDialog } from "../view/dialog.ts";

const params: AskUserParams = {
	questions: [
		{
			question: "Which packages should change?",
			header: "Packages",
			multiSelect: true,
			options: [
				{ label: "pi-stats", description: "dashboard" },
				{ label: "pi-statusline", description: "footer" },
				{ label: "pi-plan-mode", description: "planning" },
			],
		},
	],
};

/** Question 1 multi-select, question 2 single-select, so tabs are in play. */
const mixedParams: AskUserParams = {
	questions: [
		params.questions[0],
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

function harness(p: AskUserParams = params) {
	const results: QuestionnaireResult[] = [];
	const session = new QuestionnaireSession(p);
	const dialog = new QuestionnaireDialog({ session, done: (r) => results.push(r) });
	return {
		dialog,
		session,
		results,
		type: (text: string) => {
			for (const ch of text) dialog.handleInput(ch);
		},
		lines: (width = 80) => dialog.render(width).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")),
	};
}

test("digits toggle rows instead of answering", () => {
	const h = harness();
	h.dialog.handleInput("1");
	h.dialog.handleInput("3");
	assert.equal(h.results.length, 0, "a digit must never complete a multi-select question");
	const rendered = h.lines().join("\n");
	assert.match(rendered, /\[x\] 1\. pi-stats/);
	assert.match(rendered, /\[ \] 2\. pi-statusline/);
	assert.match(rendered, /\[x\] 3\. pi-plan-mode/);
});

test("space toggles the highlighted row", () => {
	const h = harness();
	h.dialog.handleInput("\x1b[B");
	h.dialog.handleInput(" ");
	assert.match(h.lines().join("\n"), /\[x\] 2\. pi-statusline/);
});

test("enter submits the checked options joined in list order", () => {
	const h = harness();
	h.dialog.handleInput("3");
	h.dialog.handleInput("1");
	h.dialog.handleInput("\r");
	assert.equal(h.results.length, 1);
	const [answer] = h.results[0].answers;
	assert.equal(answer.answer, "pi-stats, pi-plan-mode");
	assert.deepEqual(answer.selected, ["pi-stats", "pi-plan-mode"]);
	assert.equal(answer.custom, false);
});

test("enter with nothing checked is inert", () => {
	const h = harness();
	h.dialog.handleInput("\r");
	assert.equal(h.results.length, 0);
});

test("checking the sentinel opens free text with the other ticks preserved", () => {
	const h = harness();
	h.dialog.handleInput("1");
	h.dialog.handleInput("4"); // the appended "Type something." row
	h.dialog.handleInput("\r");
	assert.equal(h.results.length, 0, "the sentinel must not complete the question");
	assert.ok(h.dialog.isTypingCustom());
});

test("committed text is appended to the checked labels, not substituted for them", () => {
	const h = harness();
	h.dialog.handleInput("1");
	h.dialog.handleInput("3");
	h.dialog.handleInput("4");
	h.dialog.handleInput("\r");
	h.type("and also the docs site");
	h.dialog.handleInput("\r");
	const [answer] = h.results[0].answers;
	assert.equal(answer.answer, "pi-stats, pi-plan-mode, and also the docs site");
	assert.equal(answer.custom, true, "a typed value among the parts marks the answer custom");
	assert.deepEqual(answer.selected, ["pi-stats", "pi-plan-mode", "and also the docs site"]);
});

test("the sentinel alone yields just the typed answer", () => {
	const h = harness();
	h.dialog.handleInput("4");
	h.dialog.handleInput("\r");
	h.type("something else entirely");
	h.dialog.handleInput("\r");
	const [answer] = h.results[0].answers;
	assert.equal(answer.answer, "something else entirely");
	assert.equal(answer.custom, true);
});

test("esc from the free-text field returns to the list with every tick intact", () => {
	const h = harness();
	h.dialog.handleInput("1");
	h.dialog.handleInput("3");
	h.dialog.handleInput("4");
	h.dialog.handleInput("\r");
	h.type("never mind");
	h.dialog.handleInput("\x1b");
	assert.equal(h.results.length, 0, "one esc unwinds one layer");
	assert.ok(!h.dialog.isTypingCustom());
	const rendered = h.lines().join("\n");
	assert.match(rendered, /\[x\] 1\. pi-stats/);
	assert.match(rendered, /\[x\] 3\. pi-plan-mode/);
	h.dialog.handleInput("4"); // untick the sentinel
	h.dialog.handleInput("\r");
	assert.equal(h.results[0].answers[0].answer, "pi-stats, pi-plan-mode");
});

test("the note key attaches a note to the whole multi-select answer", () => {
	const h = harness();
	h.dialog.handleInput("1");
	h.dialog.handleInput("n");
	h.type("stats first");
	h.dialog.handleInput("\r");
	const [answer] = h.results[0].answers;
	assert.equal(answer.answer, "pi-stats");
	assert.equal(answer.notes, "stats first");
});

test("submitting advances to the next unanswered tab rather than finishing", () => {
	const h = harness(mixedParams);
	h.dialog.handleInput("1");
	h.dialog.handleInput("\r");
	assert.equal(h.results.length, 0, "one of two questions answered");
	assert.equal(h.session.questionIndex, 1, "the dialog jumps to the gap");
	h.dialog.handleInput("2");
	assert.equal(h.results.length, 1);
	assert.deepEqual(
		h.results[0].answers.map((a) => a.answer),
		["pi-stats", "SQLite"],
	);
});

test("tab cycles questions and never fires while the free-text field is open", () => {
	const h = harness(mixedParams);
	h.dialog.handleInput("\t");
	assert.equal(h.session.questionIndex, 1);
	h.dialog.handleInput("\x1b[Z");
	assert.equal(h.session.questionIndex, 0);
	h.dialog.handleInput("4");
	h.dialog.handleInput("\r");
	assert.ok(h.dialog.isTypingCustom());
	h.dialog.handleInput("\t");
	assert.equal(h.session.questionIndex, 0, "tab must not strand a half-typed answer");
	assert.ok(h.dialog.isTypingCustom());
});

test("revisiting an answered multi-select question replaces its answer", () => {
	const h = harness(mixedParams);
	h.dialog.handleInput("1");
	h.dialog.handleInput("\r"); // answers Q1, jumps to Q2
	h.dialog.handleInput("\x1b[Z"); // back to Q1
	h.dialog.handleInput("1"); // untick pi-stats
	h.dialog.handleInput("2"); // tick pi-statusline
	h.dialog.handleInput("\r");
	assert.equal(h.session.answerAt(0)?.answer, "pi-statusline");
	assert.equal(h.results.length, 0, "Q2 is still unanswered");
});

test("a single-select question in the same call is untouched", () => {
	const h = harness(mixedParams);
	h.dialog.handleInput("\t");
	const rendered = h.lines().join("\n");
	assert.ok(!rendered.includes("[ ]"), "no checkboxes on a single-select tab");
	assert.match(rendered, /1-9 select/);
	h.dialog.handleInput("1");
	assert.equal(h.session.answerAt(1)?.answer, "Postgres", "a digit still commits instantly");
});

test("the hint line reports the live checked count", () => {
	const h = harness();
	assert.match(h.lines().join("\n"), /enter confirm \(0\)/);
	h.dialog.handleInput("1");
	h.dialog.handleInput("2");
	assert.match(h.lines().join("\n"), /enter confirm \(2\)/);
});
