import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { QuestionnaireSession } from "../questionnaire.ts";
import type { AskUserParams, QuestionnaireResult } from "../tool/schema.ts";
import { QuestionnaireDialog } from "../view/dialog.ts";

const choice = (i: number) => ({
	question: `Question ${i}?`, header: `Header${i}`,
	options: [{ label: `A${i}`, description: "first" }, { label: `B${i}`, description: "second" }],
});
const text = (i: number) => ({ mode: "text" as const, header: `Text${i}`, question: `Explain ${i}?` });
const ESC = "\x1b", ENTER = "\r", END = "\x1b[F", HOME = "\x1b[H";
const strip = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
function harness(params: AskUserParams) {
	const results: QuestionnaireResult[] = [];
	const session = new QuestionnaireSession(params);
	const dialog = new QuestionnaireDialog({ session, done: (r) => results.push(r) });
	return { session, dialog, results, keys: (...keys: string[]) => keys.forEach((key) => dialog.handleInput(key)),
		render: (width = 80) => strip(dialog.render(width).join("\n")) };
}

test("a >4 mixed round auto-submits once with legacy defaults", () => {
	const h = harness({ questions: [choice(1), text(2), { ...choice(3), multiSelect: true }, text(4), choice(5), text(6)] });
	h.keys("2", "free text", ENTER, "1", "2", ENTER, "four", ENTER, "1");
	assert.equal(h.results.length, 0);
	h.keys("six", ENTER, ENTER, "changed after done");
	assert.equal(h.results.length, 1);
	assert.deepEqual(h.results[0].answers.map((a) => a.answer), ["B1", "free text", "A3, B3", "four", "A5", "six"]);
	assert.deepEqual(h.results[0].answers.map((a) => a.questionIndex), [0, 1, 2, 3, 4, 5]);
	assert.equal(h.results[0].answers[1].custom, true);
	assert.equal(h.session.answerAt(5)?.answer, "six", "late input must not mutate the submitted result");
});

test("large-round overview pages and jumps to any question without selecting option digits", () => {
	const h = harness({ questions: Array.from({ length: 123 }, (_, i) => choice(i + 1)) });
	h.keys("o", END);
	assert.match(h.render(), /123\. ○ Header123/);
	h.keys(HOME, "\x1b[6~");
	assert.match(h.render(), /Question 9\?/);
	h.keys("\x1b[5~");
	assert.match(h.render(), /Question 1\?/);
	h.keys("g", "120", ENTER, ENTER);
	assert.equal(h.session.questionIndex, 119);
	assert.equal(h.session.answeredCount(), 0);
	h.keys("2");
	assert.equal(h.session.answerAt(119)?.answer, "B120");
});

test("invalid jumps stay in the jump field; Escape unwinds then cancels", () => {
	const h = harness({ questions: [choice(1), choice(2)] });
	h.keys("o", "g", "999", ENTER);
	assert.match(h.render(), /Question number/);
	h.keys(ESC);
	assert.doesNotMatch(h.render(), /Question number/);
	assert.equal(h.results.length, 0);
	h.keys(ESC);
	assert.equal(h.results[0].cancelled, true);
});

test("the current tab remains visible near the end of a large round at narrow widths", () => {
	const h = harness({ questions: Array.from({ length: 100 }, (_, i) => choice(i + 1)) });
	h.session.goTo(98);
	for (const width of [16, 20, 24, 40, 80]) {
		const lines = h.dialog.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) === width), `rectangle at ${width}`);
		assert.match(strip(lines.slice(1, 5).join("\n")), /Header99/, `current header at ${width}`);
	}
	for (const width of [1, 2, 3, 4, 5, 10]) {
		assert.ok(h.dialog.render(width).every((line) => visibleWidth(line) <= width));
	}
});

test("review waits for an explicit Submit round selection, and rejects incomplete submission", () => {
	const h = harness({ reviewBeforeSubmit: true, questions: [choice(1), text(2)] });
	h.keys("o", END, ENTER);
	assert.equal(h.results.length, 0);
	h.keys(HOME, ENTER, "1"); // editing from overview returns to review
	assert.match(h.render(), /Review round/);
	h.keys("g", "2", ENTER, ENTER, "answer", ENTER);
	assert.equal(h.results.length, 0);
	assert.match(h.render(), /2\/2 answered/);
	h.keys(ENTER, " revised", ENTER); // revisit text and preserve the saved input
	assert.equal(h.session.answerAt(1)?.answer, "answer revised");
	h.keys(END, ENTER, ENTER);
	assert.equal(h.results.length, 1);
	assert.equal(h.results[0].cancelled, false);
});

test("review handles notes, multi-select parts and custom text without stale or repeated answers", () => {
	const h = harness({ reviewBeforeSubmit: true, questions: [{ ...choice(1), multiSelect: true }, choice(2)] });
	h.keys("1", "3", "n", "original note", ENTER, "custom", ENTER, "2");
	assert.equal(h.results.length, 0);
	h.keys(HOME);
	assert.match(h.render(), /✓ A1/);
	assert.match(h.render(), /✓ custom/);
	assert.match(h.render(), /Note: original note/);
	h.keys(ENTER, "n", "!", "\t", "n", ENTER); // note is seeded once, not duplicated
	assert.match(h.render(), /custom/); // editing sentinel reuses prior text
	h.keys(" revised", ENTER);
	assert.deepEqual(h.session.answerAt(0)?.selected, ["A1", "custom revised"]);
	assert.equal(h.session.answerAt(0)?.notes, "original note!");
	h.keys(ENTER, "3", "1", "2", ENTER); // replace selection; remove custom sentinel and A1
	assert.deepEqual(h.session.answerAt(0)?.selected, ["B1"]);
	assert.equal(h.session.answerAt(0)?.custom, false);
	assert.equal(h.session.answerAt(0)?.notes, "original note!");
	h.keys(ENTER, "n");
	for (const _ of "original note!") h.keys("\x7f");
	h.keys(ENTER); // explicitly clearing a note is different from confirming unchanged
	assert.equal(h.session.answerAt(0)?.notes, undefined);
	h.keys(END, ENTER);
	assert.deepEqual(h.results[0].answers.map((a) => a.answer), ["B1", "B2"]);
	assert.equal(h.results[0].answers.length, 2);
});

test("Tab out of a note draft preserves the saved note when a choice is confirmed", () => {
	for (const multiSelect of [false, true]) {
		const h = harness({ reviewBeforeSubmit: true, questions: [{ ...choice(1), multiSelect }] });
		if (multiSelect) h.keys("1");
		h.keys("n", "saved note", ENTER, ENTER, "n", " draft", "\t", ENTER);
		assert.equal(h.session.answerAt(0)?.notes, "saved note", "unsubmitted draft must not erase or replace the saved note");
		h.keys(ENTER, "n");
		assert.match(h.render(), /saved note draft/);
		assert.doesNotMatch(h.render(), /saved note draftsaved note/, "reopening must not seed the retained draft twice");
		h.keys(ENTER);
		assert.equal(h.session.answerAt(0)?.notes, "saved note draft");
		h.keys(END, ENTER);
		assert.equal(h.results[0].answers[0].notes, "saved note draft");
	}
});

test("backing out of a custom answer does not carry an uncommitted note into a choice", () => {
	const h = harness({ reviewBeforeSubmit: true, questions: [choice(1)] });
	h.keys("n", "saved note", ENTER, ENTER, "\x1b[B", "\x1b[B", "n", " draft", ENTER);
	assert.ok(h.dialog.isTypingCustom());
	h.keys(ESC, "1");
	assert.equal(h.session.answerAt(0)?.notes, "saved note");
	h.keys(ENTER, "n");
	assert.match(h.render(), /saved note/);
	assert.doesNotMatch(h.render(), /saved note draft/);
});

test("cancel during final review preserves committed answers without marking submitted", () => {
	const h = harness({ reviewBeforeSubmit: true, questions: [text(1)] });
	h.keys("committed", ENTER, ESC);
	assert.equal(h.results[0].cancelled, true);
	assert.equal(h.results[0].answers[0].answer, "committed");
});

test("cancelling an edit preserves the prior answer and not the draft", () => {
	const h = harness({ reviewBeforeSubmit: true, questions: [text(1), choice(2)] });
	h.keys("committed", ENTER, "o", HOME, ENTER, " draft", ESC);
	assert.match(h.render(), /Answer: committed/);
	assert.doesNotMatch(h.render(), /draft/);
	h.keys(ESC);
	assert.equal(h.results[0].answers[0].answer, "committed");
	assert.equal(h.results[0].answers.length, 1);
});
