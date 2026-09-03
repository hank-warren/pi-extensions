/**
 * Behavior tests for the composable OptionSelector.
 *
 * These pin the parity that justifies the component's existence: digit
 * hotkeys, Tab-to-comment, and Esc must behave exactly as the monkey patch
 * does, so a dialog rendered via ctx.ui.custom() feels identical to a patched
 * ctx.ui.select dialog.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMENT_CURSOR, isCharKey } from "../keys.ts";
import { OptionSelector, type OptionSelectorOptions, type SelectorOption } from "../selector.ts";

const OPTIONS: SelectorOption[] = [
	{ value: "allow", label: "Allow" },
	{ value: "block", label: "Block" },
	{ value: "always", label: "Always allow" },
];

interface Harness {
	selector: OptionSelector;
	selected: Array<{ value: string; comment?: string }>;
	submitted: Array<{ values: string[]; comment?: string }>;
	cancelled: number;
	renders: number;
}

function harness(overrides: Partial<OptionSelectorOptions> = {}): Harness {
	const state: Harness = {
		selector: null as never,
		selected: [],
		submitted: [],
		cancelled: 0,
		renders: 0,
	};
	state.selector = new OptionSelector({
		title: "Bash — Auto Permissions needs approval",
		options: OPTIONS,
		onSelect: (option, comment) => state.selected.push({ value: option.value, comment }),
		onSubmit: (options, comment) =>
			state.submitted.push({ values: options.map((o) => o.value), comment }),
		onCancel: () => {
			state.cancelled += 1;
		},
		requestRender: () => {
			state.renders += 1;
		},
		...overrides,
	});
	return state;
}

/** Multi-select harness; the note key is `n` so digits stay free for toggling. */
function multi(overrides: Partial<OptionSelectorOptions> = {}): Harness {
	return harness({ multiSelect: true, ...overrides });
}

const plain = (lines: string[]): string[] => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

test("digit hotkeys select instantly and return the option value", () => {
	const h = harness();
	h.selector.handleInput("2");
	assert.deepEqual(h.selected, [{ value: "block", comment: undefined }]);
});

test("digit beyond the option count is inert", () => {
	const h = harness();
	h.selector.handleInput("9");
	assert.deepEqual(h.selected, []);
});

test("arrows move the highlight and enter confirms it", () => {
	const h = harness();
	h.selector.handleInput("\x1b[B");
	h.selector.handleInput("\x1b[B");
	h.selector.handleInput("\r");
	assert.deepEqual(h.selected, [{ value: "always", comment: undefined }]);
});

test("arrow navigation clamps at both ends", () => {
	const h = harness();
	h.selector.handleInput("\x1b[A");
	assert.equal(h.selector.getSelected()?.value, "allow");
	for (let i = 0; i < 10; i++) h.selector.handleInput("\x1b[B");
	assert.equal(h.selector.getSelected()?.value, "always");
});

test("esc cancels from navigation mode", () => {
	const h = harness();
	h.selector.handleInput("\x1b");
	assert.equal(h.cancelled, 1);
	assert.deepEqual(h.selected, []);
});

test("tab opens comment mode; enter delivers option plus trimmed note", () => {
	const h = harness();
	h.selector.handleInput("\t");
	assert.ok(h.selector.isCommenting());
	for (const ch of "  too risky  ") h.selector.handleInput(ch);
	h.selector.handleInput("\r");
	assert.deepEqual(h.selected, [{ value: "allow", comment: "too risky" }]);
});

test("digits typed in comment mode are literal text, not hotkeys", () => {
	const h = harness();
	h.selector.handleInput("\t");
	for (const ch of "step 2") h.selector.handleInput(ch);
	h.selector.handleInput("\r");
	assert.deepEqual(h.selected, [{ value: "allow", comment: "step 2" }]);
});

test("esc in comment mode discards the note without cancelling the dialog", () => {
	const h = harness();
	h.selector.handleInput("\t");
	for (const ch of "oops") h.selector.handleInput(ch);
	h.selector.handleInput("\x1b");
	assert.equal(h.cancelled, 0, "esc must unwind comment mode before the dialog");
	assert.ok(!h.selector.isCommenting());
	h.selector.handleInput("\r");
	assert.deepEqual(h.selected, [{ value: "allow", comment: undefined }]);
});

test("an empty note submits the option with no comment", () => {
	const h = harness();
	h.selector.handleInput("\t");
	h.selector.handleInput("   ");
	h.selector.handleInput("\r");
	assert.deepEqual(h.selected, [{ value: "allow", comment: undefined }]);
});

test("comment applies to the option highlighted when tab was pressed", () => {
	const h = harness();
	h.selector.handleInput("\x1b[B");
	h.selector.handleInput("\t");
	for (const ch of "note") h.selector.handleInput(ch);
	h.selector.handleInput("\r");
	assert.deepEqual(h.selected, [{ value: "block", comment: "note" }]);
});

test("allowComment:false makes tab inert", () => {
	const h = harness({ allowComment: false });
	h.selector.handleInput("\t");
	assert.ok(!h.selector.isCommenting());
});

test("digitHotkeys:false leaves digits inert and drops the number prefix", () => {
	const h = harness({ digitHotkeys: false });
	h.selector.handleInput("2");
	assert.deepEqual(h.selected, []);
	assert.ok(!h.selector.render(80).some((l) => l.includes("1. Allow")));
});

test("render numbers the options and marks the selection", () => {
	const h = harness();
	const lines = h.selector.render(80).join("\n");
	assert.match(lines, /→ 1\. Allow/);
	assert.match(lines, /2\. Block/);
	assert.match(lines, /1-9 select/);
});

test("render shows the inline note with a cursor on the selected row", () => {
	const h = harness();
	h.selector.handleInput("\t");
	for (const ch of "hmm") h.selector.handleInput(ch);
	const lines = h.selector.render(80).join("\n");
	assert.ok(lines.includes(`1. Allow, hmm${COMMENT_CURSOR}`));
	assert.match(lines, /enter submit/);
});

test("render requests are issued for navigation and typing", () => {
	const h = harness();
	const before = h.renders;
	h.selector.handleInput("\x1b[B");
	h.selector.handleInput("\t");
	h.selector.handleInput("x");
	assert.ok(h.renders >= before + 3, "each visible change should request a repaint");
});

test("the default comment trigger stays Tab so approval prompts are unchanged", () => {
	const h = harness();
	h.selector.handleInput("\t");
	assert.ok(h.selector.isCommenting(), "Tab must remain the approval-prompt note key");
	assert.match(h.selector.render(80).join("\n"), /enter submit/);
});

test("a custom comment trigger replaces Tab and leaves Tab unconsumed", () => {
	const h = harness({ commentTrigger: isCharKey("n"), commentKeyHint: "n" });
	h.selector.handleInput("\t");
	assert.ok(!h.selector.isCommenting(), "Tab must not open notes when overridden");
	assert.deepEqual(h.selected, [], "and Tab must not select anything either");
	h.selector.handleInput("n");
	assert.ok(h.selector.isCommenting(), "the override key must open notes");
});

test("the custom trigger honours kitty encodings and case", () => {
	for (const key of ["n", "N", "\x1b[110u"]) {
		const h = harness({ commentTrigger: isCharKey("n"), commentKeyHint: "n" });
		h.selector.handleInput(key);
		assert.ok(h.selector.isCommenting(), `${JSON.stringify(key)} must open notes`);
	}
});

test("the hint line names the configured comment key", () => {
	const h = harness({ commentTrigger: isCharKey("n"), commentKeyHint: "n" });
	assert.match(h.selector.render(80).join("\n"), /n add note/);
});

test("a long note wraps instead of overflowing the row", () => {
	const h = harness();
	h.selector.handleInput("\t");
	for (const ch of "this is a very long note that will certainly not fit on one row of a narrow dialog")
		h.selector.handleInput(ch);
	const lines = h.selector.render(50).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
	for (const line of lines) {
		assert.ok(line.length <= 50, `line overflows 50 cols: ${JSON.stringify(line)}`);
	}
	assert.ok(lines.join("\n").includes("▌"), "the caret must survive wrapping");
});

test("wrapped note continuation lines are indented under the row", () => {
	const h = harness();
	h.selector.handleInput("\t");
	for (const ch of "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj") h.selector.handleInput(ch);
	const lines = h.selector.render(40).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
	const continuation = lines.findIndex((l) => l.startsWith("     ") && l.trim().length > 0);
	assert.ok(continuation > 0, "expected an indented continuation line");
});

test("a long option label wraps too", () => {
	const h = harness({
		options: [
			{ value: "long", label: "An option label that is quite a lot longer than the dialog is wide" },
			{ value: "b", label: "Short" },
		],
	});
	const lines = h.selector.render(40).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
	for (const line of lines) assert.ok(line.length <= 40, `overflow: ${JSON.stringify(line)}`);
});

test("short rows are unchanged by wrapping", () => {
	const h = harness();
	const lines = h.selector.render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
	assert.ok(lines.some((l) => l === "→ 1. Allow"), "a short selected row must render exactly as before");
});

// ---------------------------------------------------------------------------
// Multi-select mode
// ---------------------------------------------------------------------------

test("space toggles the highlighted row", () => {
	const h = multi();
	h.selector.handleInput(" ");
	assert.deepEqual(h.selector.getChecked().map((o) => o.value), ["allow"]);
	h.selector.handleInput(" ");
	assert.deepEqual(h.selector.getChecked(), [], "space is a toggle, not a latch");
});

test("a digit toggles its row and moves the highlight without committing", () => {
	const h = multi();
	h.selector.handleInput("3");
	assert.deepEqual(h.selector.getChecked().map((o) => o.value), ["always"]);
	assert.equal(h.selector.getSelected()?.value, "always", "the digit also moves the highlight");
	assert.deepEqual(h.submitted, [], "a digit must never end a multi-select question");
	assert.deepEqual(h.selected, [], "onSelect is not the multi-select path");
});

test("enter submits the checked options in list order", () => {
	const h = multi();
	h.selector.handleInput("3");
	h.selector.handleInput("1");
	h.selector.handleInput("\r");
	assert.deepEqual(h.submitted, [{ values: ["allow", "always"], comment: undefined }]);
});

test("enter with nothing checked is inert", () => {
	const h = multi();
	h.selector.handleInput("\r");
	assert.deepEqual(h.submitted, []);
	assert.deepEqual(h.selected, []);
});

test("checkbox glyphs render between the pointer and the ordinal", () => {
	const h = multi();
	h.selector.handleInput("2");
	const lines = plain(h.selector.render(80));
	assert.ok(lines.includes("  [ ] 1. Allow"), `unchecked row missing: ${JSON.stringify(lines)}`);
	assert.ok(lines.includes("→ [x] 2. Block"), `checked row missing: ${JSON.stringify(lines)}`);
});

test("wrapped rows and descriptions indent under the label with a checkbox present", () => {
	const h = multi({
		options: [
			{
				value: "long",
				label: "An option label that is quite a lot longer than this dialog is wide",
				description: "and a description that also needs to sit under the label",
			},
			{ value: "b", label: "Short" },
		],
	});
	const lines = plain(h.selector.render(44));
	for (const line of lines) assert.ok(line.length <= 44, `overflow: ${JSON.stringify(line)}`);
	// "→ [x] 1. " is nine columns wide, so continuations and descriptions align there.
	const continuation = lines.find((l) => l.startsWith("         ") && l.trim().length > 0);
	assert.ok(continuation, `expected a nine-column indent: ${JSON.stringify(lines)}`);
	// The description wraps as well, so assert on its rows rather than on one
	// phrase surviving intact on a single line.
	const descriptionRows = lines.filter((l) => l.includes("description") || l.includes("needs to sit"));
	assert.ok(descriptionRows.length > 0, `expected description rows: ${JSON.stringify(lines)}`);
	for (const row of descriptionRows) {
		assert.ok(row.startsWith("         "), `the description must clear the checkbox too: ${JSON.stringify(row)}`);
	}
});

test("a long description wraps instead of being truncated", () => {
	const description =
		"run the full migration in one window, rehearse the rollback beforehand, and freeze the schema until the analytics warehouse has caught up with the primary";
	const h = harness({
		options: [
			{ value: "long", label: "Cut over", description },
			{ value: "b", label: "Wait" },
		],
	});
	const lines = plain(h.selector.render(48));
	for (const line of lines) {
		assert.ok(line.length <= 48, `overflow: ${JSON.stringify(line)}`);
		assert.ok(!line.endsWith("…"), `truncated: ${JSON.stringify(line)}`);
	}
	const rendered = lines.join("\n");
	for (const word of description.split(" ")) {
		assert.ok(rendered.includes(word), `missing word "${word}" in: ${JSON.stringify(lines)}`);
	}
	// "→ 1. " is five columns wide, so every description row clears it.
	const descriptionRows = lines.filter((l) => l.trim() && description.includes(l.trim().split(" ")[0]));
	assert.ok(descriptionRows.length > 1, `expected several wrapped rows: ${JSON.stringify(lines)}`);
	for (const row of descriptionRows) {
		assert.ok(row.startsWith("     "), `continuation lost its indent: ${JSON.stringify(row)}`);
	}
});

test("the hint shows the live checked count", () => {
	const h = multi();
	assert.match(plain(h.selector.render(80)).join("\n"), /space\/1-9 toggle · ↑↓ move · enter confirm \(0\)/);
	h.selector.handleInput("1");
	h.selector.handleInput("2");
	assert.match(plain(h.selector.render(80)).join("\n"), /enter confirm \(2\)/);
});

test("a note typed in comment mode arrives as the submit comment", () => {
	const h = multi({ commentTrigger: isCharKey("n"), commentKeyHint: "n" });
	h.selector.handleInput("1");
	h.selector.handleInput("n");
	for (const ch of "  both of these  ") h.selector.handleInput(ch);
	h.selector.handleInput("\r");
	assert.deepEqual(h.submitted, [{ values: ["allow"], comment: "both of these" }]);
});

test("esc cancels from multi-select navigation mode", () => {
	const h = multi();
	h.selector.handleInput("1");
	h.selector.handleInput("\x1b");
	assert.equal(h.cancelled, 1);
	assert.deepEqual(h.submitted, []);
});

test("space in comment mode is literal text, not a toggle", () => {
	const h = multi({ commentTrigger: isCharKey("n"), commentKeyHint: "n" });
	h.selector.handleInput("1");
	h.selector.handleInput("n");
	for (const ch of "two words") h.selector.handleInput(ch);
	h.selector.handleInput("\r");
	assert.deepEqual(h.submitted, [{ values: ["allow"], comment: "two words" }]);
});

test("single-select mode is untouched by the new options", () => {
	const h = harness();
	h.selector.handleInput(" ");
	assert.deepEqual(h.selector.getChecked(), [], "space checks nothing outside multi-select");
	assert.deepEqual(h.selected, [], "and space never selects");
	h.selector.handleInput("2");
	assert.deepEqual(h.selected, [{ value: "block", comment: undefined }], "digits still commit");
	const lines = plain(h.selector.render(80));
	assert.ok(lines.includes("  1. Allow"), `unchanged single-select row: ${JSON.stringify(lines)}`);
	assert.ok(!lines.some((l) => l.includes("[ ]") || l.includes("[x]")), "no checkboxes leak in");
	assert.match(lines.join("\n"), /1-9 select · ↑↓ move · enter confirm/);
});
