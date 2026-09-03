/**
 * Regression tests for the free-text (custom answer) mode key handling.
 *
 * v0.2.0 shipped raw string comparisons here (`keyData === "\x1b"`) instead of
 * the shared predicates from @hank-warren/pi-permission-selector/keys.ts. Under
 * the Kitty keyboard protocol — which Ghostty enables by default — Esc arrives
 * as `\x1b[27u`, Enter as `\x1b[13u` and Backspace as `\x1b[127u`, so every one
 * of those comparisons failed and the user was TRAPPED in the custom-answer
 * field with no way out: Esc did nothing, Enter did nothing.
 *
 * The option-list mode was unaffected because OptionSelector already used the
 * shared predicates. That asymmetry is exactly why these paths must never grow
 * their own key handling again.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { QuestionnaireSession } from "../questionnaire.ts";
import type { AskUserParams, QuestionnaireResult } from "../tool/schema.ts";
import { QuestionnaireDialog } from "../view/dialog.ts";

/** Kitty keyboard protocol (CSI-u) encodings, as Ghostty sends them. */
const KITTY = {
	escape: "\x1b[27u",
	enter: "\x1b[13u",
	backspace: "\x1b[127u",
	tab: "\x1b[9u",
} as const;

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
	return {
		dialog,
		results,
		type: (text: string) => {
			for (const ch of text) dialog.handleInput(ch);
		},
		/** Enter free-text mode via the sentinel row. */
		openCustom: () => dialog.handleInput("3"),
	};
}

test("kitty escape leaves free-text mode instead of trapping the user", () => {
	const h = harness();
	h.openCustom();
	assert.ok(h.dialog.isTypingCustom());
	h.dialog.handleInput(KITTY.escape);
	assert.ok(!h.dialog.isTypingCustom(), "kitty esc must unwind free-text mode");
	assert.equal(h.results.length, 0, "and must not decline the whole dialog");
});

test("kitty escape then kitty escape again cancels the dialog", () => {
	const h = harness();
	h.openCustom();
	h.dialog.handleInput(KITTY.escape);
	h.dialog.handleInput(KITTY.escape);
	assert.deepEqual(h.results, [{ answers: [], cancelled: true }]);
});

test("kitty enter submits a typed custom answer", () => {
	const h = harness();
	h.openCustom();
	h.type("DuckDB");
	h.dialog.handleInput(KITTY.enter);
	assert.equal(h.results.length, 1, "kitty enter must submit");
	assert.equal(h.results[0].answers[0].answer, "DuckDB");
	assert.equal(h.results[0].answers[0].custom, true);
});

test("kitty backspace edits the custom answer", () => {
	const h = harness();
	h.openCustom();
	h.type("DuckDBX");
	h.dialog.handleInput(KITTY.backspace);
	h.dialog.handleInput(KITTY.enter);
	assert.equal(h.results[0].answers[0].answer, "DuckDB");
});

test("backspace deletes a whole astral character from the custom answer", () => {
	const h = harness();
	h.openCustom();
	// `type` iterates the string, which yields code points, so this is one
	// keypress-sized chunk exactly as a terminal would deliver it.
	h.type("DuckDB \u{1F986}");
	h.dialog.handleInput(KITTY.backspace);
	h.dialog.handleInput(KITTY.enter);
	const answer = h.results[0].answers[0].answer;
	assert.equal(answer, "DuckDB", "one backspace clears the whole emoji");
	assert.ok(
		!/[\uD800-\uDFFF]/u.test(answer.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, "")),
		"a custom answer must never carry a lone surrogate to the model",
	);
});

test("kitty escape still cancels from the option list", () => {
	const h = harness();
	h.dialog.handleInput(KITTY.escape);
	assert.deepEqual(h.results, [{ answers: [], cancelled: true }]);
});

test("kitty-encoded printable characters reach the custom answer", () => {
	const h = harness();
	h.openCustom();
	// modifyOtherKeys / kitty may encode a plain printable as CSI-u.
	h.dialog.handleInput("\x1b[100u"); // 'd'
	h.dialog.handleInput(KITTY.enter);
	assert.equal(h.results[0].answers[0].answer, "d");
});

test("legacy encodings keep working alongside kitty", () => {
	const h = harness();
	h.openCustom();
	h.type("x");
	h.dialog.handleInput("\x7f");
	h.type("legacy");
	h.dialog.handleInput("\r");
	assert.equal(h.results[0].answers[0].answer, "legacy");
});

// pi-tui's Terminal re-wraps pastes in bracketed-paste markers before they
// reach handleInput. A paste chunk contains ESC, so it fails isPrintable and
// used to fall into the inert branch — pasting into the custom-answer field
// silently did nothing (the note editor was fine; handleCommentKey buffers its
// own pastes). These pin the fix: the field must consume bracketed pastes.
test("pasting into the custom-answer field inserts the pasted text", () => {
	const h = harness();
	h.openCustom();
	h.type("see: ");
	h.dialog.handleInput("\x1b[200~the logs\x1b[201~");
	h.dialog.handleInput(KITTY.enter);
	assert.equal(h.results[0].answers[0].answer, "see: the logs");
	assert.equal(h.results[0].answers[0].custom, true);
});

test("a paste spanning multiple input chunks is buffered until the end marker", () => {
	const h = harness();
	h.openCustom();
	h.dialog.handleInput("\x1b[200~first ");
	h.dialog.handleInput("second ");
	h.dialog.handleInput("third\x1b[201~");
	h.dialog.handleInput(KITTY.enter);
	assert.equal(h.results[0].answers[0].answer, "first second third");
});

test("keys inside an in-progress paste are text, not commands", () => {
	const h = harness();
	h.openCustom();
	h.dialog.handleInput("\x1b[200~not");
	// Chunks that would be Esc/Enter as keys arrive mid-paste: they are content.
	h.dialog.handleInput("\ryet \x07done");
	assert.ok(h.dialog.isTypingCustom(), "mid-paste Enter must not submit");
	assert.equal(h.results.length, 0);
	h.dialog.handleInput("\x1b[201~");
	h.dialog.handleInput(KITTY.enter);
	assert.equal(h.results[0].answers[0].answer, "not yet done", "control chars flattened, nothing executed");
});

test("multi-line pastes are flattened to a single-line answer", () => {
	const h = harness();
	h.openCustom();
	h.dialog.handleInput("\x1b[200~line1\nline2\x1b[201~");
	h.dialog.handleInput(KITTY.enter);
	assert.equal(h.results[0].answers[0].answer, "line1 line2");
});

test("input arriving after the paste end marker is handled as keys", () => {
	const h = harness();
	h.openCustom();
	// Paste and a trailing Enter in one chunk: the paste inserts, the Enter
	// submits.
	h.dialog.handleInput("\x1b[200~pasted\x1b[201~\r");
	assert.equal(h.results.length, 1, "trailing enter after the paste must submit");
	assert.equal(h.results[0].answers[0].answer, "pasted");
});

test("esc after a paste unwinds to the options and the field resets", () => {
	const h = harness();
	h.openCustom();
	h.dialog.handleInput("\x1b[200~discarded\x1b[201~");
	h.dialog.handleInput(KITTY.escape);
	assert.ok(!h.dialog.isTypingCustom());
	// Re-entering the field starts clean — no pasted residue.
	h.openCustom();
	h.type("fresh");
	h.dialog.handleInput(KITTY.enter);
	assert.equal(h.results[0].answers[0].answer, "fresh");
});

test("control sequences are never inserted as literal text", () => {
	const h = harness();
	h.openCustom();
	h.type("ok");
	// Arrow keys and other unhandled control sequences must be inert, not
	// pasted into the field as garbage.
	h.dialog.handleInput("\x1b[A");
	h.dialog.handleInput("\x1b[B");
	h.dialog.handleInput(KITTY.enter);
	assert.equal(h.results[0].answers[0].answer, "ok");
});
