/**
 * Multi-question tab cycling.
 *
 * Key map under test (rpiv parity): Tab / Right cycle forward, Shift+Tab / Left
 * cycle back, both wrapping; `n` opens the note editor because Tab is taken.
 *
 * The subtle requirement is that cycling must NOT be reachable while a text
 * field owns the keyboard — otherwise a stray Tab teleports the user to another
 * question and strands their half-typed answer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { QuestionnaireSession } from "../questionnaire.ts";
import type { AskUserParams, QuestionnaireResult } from "../tool/schema.ts";
import { QuestionnaireDialog } from "../view/dialog.ts";

const KITTY = { shiftTab: "\x1b[9;2u", tab: "\x1b[9u" } as const;
const CSI_SHIFT_TAB = "\x1b[Z";

function params(count: number): AskUserParams {
	return {
		questions: Array.from({ length: count }, (_, i) => ({
			question: `Question ${i + 1}?`,
			header: `H${i + 1}`,
			options: [
				{ label: `A${i + 1}`, description: "first" },
				{ label: `B${i + 1}`, description: "second" },
			],
		})),
	};
}

function harness(count = 3) {
	const results: QuestionnaireResult[] = [];
	const session = new QuestionnaireSession(params(count));
	const dialog = new QuestionnaireDialog({ session, done: (r) => results.push(r) });
	return {
		session,
		dialog,
		results,
		type: (text: string) => {
			for (const ch of text) dialog.handleInput(ch);
		},
	};
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("tab moves forward through questions and wraps", () => {
	const h = harness(3);
	assert.equal(h.session.questionIndex, 0);
	h.dialog.handleInput("\t");
	assert.equal(h.session.questionIndex, 1);
	h.dialog.handleInput("\t");
	assert.equal(h.session.questionIndex, 2);
	h.dialog.handleInput("\t");
	assert.equal(h.session.questionIndex, 0, "tab wraps past the last question");
});

test("shift+tab moves back and wraps, in both encodings", () => {
	for (const key of [CSI_SHIFT_TAB, KITTY.shiftTab]) {
		const h = harness(3);
		h.dialog.handleInput(key);
		assert.equal(h.session.questionIndex, 2, `${JSON.stringify(key)} must wrap backwards`);
		h.dialog.handleInput(key);
		assert.equal(h.session.questionIndex, 1);
	}
});

test("arrow left and right cycle questions too", () => {
	const h = harness(3);
	h.dialog.handleInput("\x1b[C");
	assert.equal(h.session.questionIndex, 1);
	h.dialog.handleInput("\x1b[D");
	assert.equal(h.session.questionIndex, 0);
});

test("kitty-encoded tab cycles", () => {
	const h = harness(3);
	h.dialog.handleInput(KITTY.tab);
	assert.equal(h.session.questionIndex, 1);
});

test("answering jumps to the next unanswered question", () => {
	const h = harness(3);
	h.dialog.handleInput("1"); // answer Q1
	assert.equal(h.session.questionIndex, 1);
	assert.equal(h.results.length, 0, "not done until every question is answered");
});

test("the dialog submits only once every question is answered", () => {
	const h = harness(3);
	h.dialog.handleInput("1");
	h.dialog.handleInput("1");
	assert.equal(h.results.length, 0);
	h.dialog.handleInput("1");
	assert.equal(h.results.length, 1, "the last answer submits");
	assert.equal(h.results[0].cancelled, false);
	assert.deepEqual(
		h.results[0].answers.map((a) => [a.questionIndex, a.answer]),
		[
			[0, "A1"],
			[1, "A2"],
			[2, "A3"],
		],
	);
});

test("cycling back and re-answering replaces that question's answer", () => {
	const h = harness(2);
	h.dialog.handleInput("1"); // Q1 = A1, cursor -> Q2
	h.dialog.handleInput("\t"); // back to Q1 (wraps)
	assert.equal(h.session.questionIndex, 0);
	h.dialog.handleInput("2"); // Q1 = B1
	assert.equal(h.results.length, 0, "Q2 is still unanswered");
	h.dialog.handleInput("1"); // answer Q2 -> submit
	assert.deepEqual(
		h.results[0].answers.map((a) => [a.questionIndex, a.answer]),
		[
			[0, "B1"],
			[1, "A2"],
		],
		"the revisited answer is replaced, not duplicated",
	);
});

test("per-question highlight survives cycling away and back", () => {
	const h = harness(2);
	h.dialog.handleInput("\x1b[B"); // move highlight to option 2 on Q1
	h.dialog.handleInput("\t");
	h.dialog.handleInput("\t"); // wrap back to Q1
	h.dialog.handleInput("\r"); // confirm the highlight
	assert.equal(h.session.answerAt(0)?.answer, "B1", "highlight must be per-question state");
});

test("tab is inert while the note editor is open", () => {
	const h = harness(3);
	h.dialog.handleInput("n");
	h.type("a note");
	h.dialog.handleInput("\t"); // means "back to options", never "next question"
	assert.equal(h.session.questionIndex, 0, "must not leave the question mid-note");
});

test("tab is inert while typing a custom answer", () => {
	const h = harness(3);
	h.dialog.handleInput("3"); // sentinel row
	h.type("custom");
	h.dialog.handleInput("\t");
	assert.equal(h.session.questionIndex, 0, "must not strand a half-typed answer");
	assert.ok(h.dialog.isTypingCustom());
});

test("a single-question dialog does not treat tab as cycling", () => {
	const h = harness(1);
	h.dialog.handleInput("\t");
	assert.equal(h.session.questionIndex, 0);
	assert.equal(h.results.length, 0);
});

test("esc declines from any question, keeping answers already given", () => {
	const h = harness(3);
	h.dialog.handleInput("1");
	h.dialog.handleInput("\t");
	h.dialog.handleInput("\x1b");
	assert.equal(h.results.length, 1);
	assert.equal(h.results[0].cancelled, true);
	assert.equal(h.results[0].answers.length, 1, "the answer given before declining is preserved");
});

test("the tab strip shows progress and marks the current question", () => {
	const h = harness(3);
	const before = strip(h.dialog.render(80).join("\n"));
	assert.match(before, /▸ H1/, "current question is marked");
	assert.match(before, /○ H2/, "unanswered questions are marked");
	h.dialog.handleInput("1");
	const after = strip(h.dialog.render(80).join("\n"));
	assert.match(after, /✓ H1/, "answered questions are ticked");
	assert.match(after, /▸ H2/);
});

test("the cycling hint appears only when there is more than one question", () => {
	assert.match(strip(harness(3).dialog.render(80).join("\n")), /tab next · shift\+tab prev/);
	assert.doesNotMatch(strip(harness(1).dialog.render(80).join("\n")), /tab next/);
});

test("the note hint advertises n rather than tab", () => {
	const out = strip(harness(2).dialog.render(80).join("\n"));
	assert.match(out, /n add note/);
	assert.doesNotMatch(out, /tab add note/);
});

test("notes are recorded per question while cycling", () => {
	const h = harness(2);
	h.dialog.handleInput("n");
	h.type("first note");
	h.dialog.handleInput("\r"); // submits Q1 with the note, advances to Q2
	h.dialog.handleInput("1");
	const answers = h.results[0].answers;
	assert.equal(answers[0].notes, "first note");
	assert.equal(answers[1].notes, undefined);
});

test("multi-question rendering stays rectangular", () => {
	const h = harness(4);
	for (const line of h.dialog.render(90)) {
		assert.equal(strip(line).length > 0, true);
	}
	const widths = new Set(h.dialog.render(90).map((l) => strip(l).length));
	assert.equal(widths.size, 1, `all lines must share one width, got ${[...widths].join(",")}`);
});
