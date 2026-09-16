import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { QuestionnaireSession } from "../questionnaire.ts";
import type { QuestionnaireResult } from "../tool/schema.ts";
import { QuestionnaireDialog } from "../view/dialog.ts";

function harness() {
	const results: QuestionnaireResult[] = [];
	const session = new QuestionnaireSession({ questions: [{ mode: "text", header: "Text", question: "Explain?" }] });
	const dialog = new QuestionnaireDialog({ session, done: (r) => results.push(r) });
	return { results, session, dialog, keys: (...keys: string[]) => keys.forEach((key) => dialog.handleInput(key)) };
}

test("native text has no fake options; whitespace cannot commit", () => {
	const h = harness();
	assert.deepEqual(h.session.rows(), []);
	assert.doesNotMatch(h.dialog.render(80).join("\n"), /Type something|1-9 select/);
	h.keys("   ", "\r", "\t");
	assert.equal(h.results.length, 0);
	assert.equal(h.session.answeredCount(), 0);
});

test("Pi Input edits graphemes and handles cursor movement, delete and Kitty text", () => {
	const h = harness();
	h.keys("a👨‍👩‍👧‍👦", "\x7f", "e\u0301", "\x7f", "界", "\x1b[D", "\x1b[3~", "\x1b[98u", "\r");
	assert.equal(h.results[0].answers[0].answer, "ab");
});

test("chunked paste preserves word boundaries, strips controls and does not submit until Enter", () => {
	const h = harness();
	h.keys("\x1b[200~α\r\nβ\t", "😀\x00\x07\x85\x1b[20", "1~");
	assert.equal(h.results.length, 0);
	h.keys("\r");
	assert.equal(h.results[0].answers[0].answer, "α β 😀");
});

test("text Esc unwinds an unfinished paste and subsequent Escape cancels without committing", () => {
	for (const escape of ["\x1b", "\x1b[27u"]) {
		const h = harness();
		h.keys("draft", "\x1b[200~unfinished", escape);
		assert.equal(h.results.length, 0);
		assert.match(h.dialog.render(80).join("\n"), /Question overview/);
		h.keys(escape);
		assert.equal(h.results[0].cancelled, true);
		assert.deepEqual(h.results[0].answers, []);
	}
});

test("external cancellation during text entry ignores subsequent input and aborts exactly once", () => {
	const h = harness();
	h.keys("draft", "\x1b[200~unfinished");
	h.dialog.cancel();
	h.keys("\x1b[201~\r");
	h.dialog.cancel();
	assert.equal(h.results.length, 1);
	assert.deepEqual(h.results[0], { answers: [], cancelled: true });
});

test("native text scrolls around the cursor and propagates focus at narrow widths", () => {
	const h = harness();
	h.dialog.focused = true;
	h.keys("long text ".repeat(100) + "終");
	for (const width of [16, 20, 40, 80]) {
		const lines = h.dialog.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) === width));
		assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
		assert.ok(lines.some((line) => line.includes("終")));
	}
	h.dialog.focused = false;
	assert.ok(!h.dialog.render(80).join("\n").includes(CURSOR_MARKER));
});
