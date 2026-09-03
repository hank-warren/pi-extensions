/**
 * Tests for the pure key predicates and comment-mode state machine in
 * `keys.ts`. These began life as the logic half of the retired
 * `ExtensionSelectorComponent` monkey-patch tests; the component-level
 * behavior is covered by `selector.test.ts` against `OptionSelector`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import {
	consumePasteChunk,
	digitIndex,
	handleCommentKey,
	idleCommentState,
	isPreNumbered,
	isPrintable,
	isSpaceKey,
	numberLabel,
	removeLastCharacter,
	sanitizePaste,
} from "../keys.ts";

test("digitIndex maps digit hotkeys to option indices", () => {
	assert.equal(digitIndex("1", 3), 0);
	assert.equal(digitIndex("3", 3), 2);
	assert.equal(digitIndex("9", 9), 8);
	assert.equal(digitIndex("0", 3), undefined);
	assert.equal(digitIndex("4", 3), undefined, "out of range");
	assert.equal(digitIndex("a", 3), undefined);
	assert.equal(digitIndex("\x1b[A", 3), undefined, "escape sequences are not digits");
	assert.equal(digitIndex("12", 3), undefined, "multi-char chunks are not hotkeys");
});

test("isPrintable accepts text chunks and rejects control input", () => {
	assert.equal(isPrintable("a"), true);
	assert.equal(isPrintable("check the logs"), true, "pasted chunks are printable");
	assert.equal(isPrintable("é"), true);
	assert.equal(isPrintable(""), false);
	assert.equal(isPrintable("\x1b[B"), false);
	assert.equal(isPrintable("\x7f"), false);
	assert.equal(isPrintable("\t"), false);
});

test("numberLabel numbers only the first nine options", () => {
	assert.equal(numberLabel("Allow", 0), "1. Allow");
	assert.equal(numberLabel("Block", 1), "2. Block");
	assert.equal(numberLabel("Ninth", 8), "9. Ninth");
	assert.equal(numberLabel("Tenth", 9), "   Tenth");
});

test("isSpaceKey matches plain and Kitty encodings only", () => {
	assert.equal(isSpaceKey(" "), true);
	assert.equal(isSpaceKey("\x1b[32u"), true, "kitty CSI-u space");
	assert.equal(isSpaceKey("\t"), false);
	assert.equal(isSpaceKey("\r"), false);
	assert.equal(isSpaceKey("\n"), false);
	assert.equal(isSpaceKey("\x1b[A"), false);
	assert.equal(isSpaceKey("\x1b[B"), false);
	assert.equal(isSpaceKey("  "), false, "a pasted run of spaces is not a toggle");
	assert.equal(isSpaceKey("a"), false);
});

test("isPreNumbered detects caller-supplied ordinal prefixes", () => {
	assert.equal(isPreNumbered(["1. Allow — run it", "2. Block — refuse"]), true);
	assert.equal(isPreNumbered(["1. Only"]), true);
	assert.equal(isPreNumbered(["Allow", "Block"]), false);
	assert.equal(isPreNumbered(["1. Allow", "Block"]), false, "every option must be numbered");
	assert.equal(isPreNumbered(["2. Allow", "1. Block"]), false, "prefixes must match position");
	assert.equal(isPreNumbered(["1.Allow", "2.Block"]), false, "requires the trailing space");
	assert.equal(isPreNumbered([]), false);
});

test("comment state machine: typing, backspace, digits as text", () => {
	const state = { active: true, text: "" };
	let result = handleCommentKey(state, "c");
	assert.deepEqual(result, { state: { active: true, text: "c" }, action: "render" });
	result = handleCommentKey(result.state, "heck logs 1");
	assert.equal(result.state.text, "check logs 1", "digits are literal text in comment mode");
	result = handleCommentKey(result.state, "\x7f");
	assert.equal(result.state.text, "check logs ");
	result = handleCommentKey(result.state, "\x1b[A");
	assert.equal(result.action, "none", "arrows are inert in comment mode");
});

test("comment state machine: backspace deletes a whole astral character", () => {
	// `slice(0, -1)` drops one UTF-16 code unit, which splits a surrogate pair
	// and leaves an ill-formed string behind. A note is ordinary prose; emoji in
	// one are routine.
	const emoji = handleCommentKey({ active: true, text: "ship it \u{1F389}" }, "\x7f");
	assert.equal(emoji.state.text, "ship it ");
	assert.ok(isWellFormed(emoji.state.text), "backspace must never leave a lone surrogate");

	const only = handleCommentKey({ active: true, text: "\u{1F44D}" }, "\x7f");
	assert.equal(only.state.text, "", "one keypress clears a one-character note");

	// Interior astral characters must survive a backspace aimed at the tail.
	const interior = handleCommentKey({ active: true, text: "a\u{1F389}b" }, "\x7f");
	assert.equal(interior.state.text, "a\u{1F389}");
	assert.ok(isWellFormed(interior.state.text));

	assert.equal(handleCommentKey({ active: true, text: "" }, "\x7f").state.text, "");
});

test("removeLastCharacter is code-point aware", () => {
	assert.equal(removeLastCharacter(""), "");
	assert.equal(removeLastCharacter("a"), "");
	assert.equal(removeLastCharacter("\u{1F389}"), "");
	assert.equal(removeLastCharacter("ab\u{1F389}"), "ab");
	assert.equal(removeLastCharacter("\u{1F389}z"), "\u{1F389}");
	// BMP text is untouched: one unit is one character there.
	assert.equal(removeLastCharacter("\u65E5\u672C\u8A9E"), "\u65E5\u672C");
	// A pre-existing lone surrogate is still removable rather than sticky.
	assert.equal(removeLastCharacter("a\uD83C"), "a");
});

function isWellFormed(text: string): boolean {
	return !/[\uD800-\uDFFF]/u.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ""));
}

test("comment state machine: tab preserves text, esc discards, enter submits trimmed", () => {
	const typed = handleCommentKey({ active: true, text: "" }, "note ");
	const tabbed = handleCommentKey(typed.state, "\t");
	assert.deepEqual(tabbed, { state: { active: false, text: "note " }, action: "render" });

	const escaped = handleCommentKey({ active: true, text: "note" }, "\x1b");
	assert.deepEqual(escaped, { state: idleCommentState(), action: "render" });

	const submitted = handleCommentKey({ active: true, text: "  check the logs  " }, "\r");
	assert.equal(submitted.action, "submit");
	assert.equal((submitted as { comment: string }).comment, "check the logs");
	const empty = handleCommentKey({ active: true, text: "   " }, "\n");
	assert.equal((empty as { comment: string }).comment, "", "whitespace-only note trims to empty");
});

test("sanitizePaste flattens to single-line printable text", () => {
	assert.equal(sanitizePaste("check\nthe\r\nlogs\tafter"), "check the logs after");
	assert.equal(sanitizePaste("plain text"), "plain text");
	assert.equal(sanitizePaste("ctrl\x07chars\x00gone"), "ctrlcharsgone");
});

test("consumePasteChunk: non-paste input returns undefined", () => {
	assert.equal(consumePasteChunk(undefined, "a"), undefined);
	assert.equal(consumePasteChunk(undefined, "\x1b[27u"), undefined, "kitty Esc is not a paste");
	assert.equal(consumePasteChunk(undefined, "\x1b[A"), undefined, "arrows are not pastes");
});

test("consumePasteChunk: single-chunk paste completes with sanitized text", () => {
	assert.deepEqual(consumePasteChunk(undefined, "\x1b[200~line1\nline2\x1b[201~"), { text: "line1 line2" });
});

test("consumePasteChunk: markers spanning chunks buffer until the end marker", () => {
	let result = consumePasteChunk(undefined, "\x1b[200~first ");
	assert.deepEqual(result, { buffer: "first " });
	result = consumePasteChunk(result?.buffer, "second");
	assert.deepEqual(result, { buffer: "first second" });
	result = consumePasteChunk(result?.buffer, " third\x1b[201~");
	assert.deepEqual(result, { text: "first second third" });
});

test("consumePasteChunk: input after the end marker comes back as rest", () => {
	assert.deepEqual(consumePasteChunk(undefined, "\x1b[200~pasted\x1b[201~\r"), { text: "pasted", rest: "\r" });
});

test("comment state machine: single-chunk bracketed paste appends text", () => {
	const state = { active: true, text: "see: " };
	const result = handleCommentKey(state, "\x1b[200~the logs\x1b[201~");
	assert.equal(result.action, "render");
	assert.deepEqual(result.state, { active: true, text: "see: the logs" });
});

test("comment state machine: paste spanning multiple chunks", () => {
	let result = handleCommentKey({ active: true, text: "" }, "\x1b[200~first ");
	assert.equal(result.action, "none", "buffering until end marker");
	result = handleCommentKey(result.state, "second ");
	assert.equal(result.action, "none");
	result = handleCommentKey(result.state, "third\x1b[201~");
	assert.equal(result.action, "render");
	assert.deepEqual(result.state, { active: true, text: "first second third" });
});

test("comment state machine: multi-line paste is flattened; trailing input after paste is processed", () => {
	const multiline = handleCommentKey({ active: true, text: "" }, "\x1b[200~line1\nline2\x1b[201~");
	assert.deepEqual(multiline.state, { active: true, text: "line1 line2" });
	const withTrailing = handleCommentKey({ active: true, text: "" }, "\x1b[200~note\x1b[201~!");
	assert.deepEqual(withTrailing.state, { active: true, text: "note!" }, "printable remainder appended");
});

test("comment state machine: Kitty keyboard protocol encodings", () => {
	setKittyProtocolActive(true);
	try {
		const escaped = handleCommentKey({ active: true, text: "note" }, "\x1b[27u");
		assert.deepEqual(escaped, { state: idleCommentState(), action: "render" }, "kitty Esc discards");

		const submitted = handleCommentKey({ active: true, text: "note" }, "\x1b[13u");
		assert.equal(submitted.action, "submit", "kitty Enter submits");
		assert.equal((submitted as { comment: string }).comment, "note");

		const erased = handleCommentKey({ active: true, text: "ab" }, "\x1b[127u");
		assert.deepEqual(erased.state, { active: true, text: "a" }, "kitty Backspace deletes");

		const tabbed = handleCommentKey({ active: true, text: "keep" }, "\x1b[9u");
		assert.deepEqual(tabbed, { state: { active: false, text: "keep" }, action: "render" }, "kitty Tab toggles");

		const typed = handleCommentKey({ active: true, text: "" }, "\x1b[97u");
		assert.deepEqual(typed.state, { active: true, text: "a" }, "kitty CSI-u printable decodes");
	} finally {
		setKittyProtocolActive(false);
	}
});
