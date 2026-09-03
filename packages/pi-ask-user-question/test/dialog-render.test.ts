/**
 * Rendering invariants for the dialog box.
 *
 * Both bugs these cover shipped to a real user:
 *
 * - 0.2.0: lines were unpadded and unframed, so pi's overlay compositing let
 *   the transcript show through and the dialog rendered interleaved with chat.
 * - 0.2.1: the custom-answer field never wrapped, so a long typed answer ran
 *   past the right border and off the screen "forever".
 *
 * The invariant that kills both classes at once: EVERY rendered line is
 * exactly the width the host gave us. Assert that, not the pixel layout.
 *
 * (The dialog is no longer an overlay — it renders in the editor area so the
 * transcript is pushed up rather than covered — but the invariant is the same
 * one and is what keeps the box a rectangle.)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { QuestionnaireSession } from "../questionnaire.ts";
import type { AskUserParams, QuestionnaireResult } from "../tool/schema.ts";
import { QuestionnaireDialog } from "../view/dialog.ts";

const params: AskUserParams = {
	questions: [
		{
			question: "Which database should we use for the analytics workload?",
			header: "Database",
			options: [
				{ label: "Postgres", description: "Relational, strong consistency" },
				{ label: "SQLite", description: "Embedded, zero ops" },
			],
		},
	],
};

function dialog() {
	const results: QuestionnaireResult[] = [];
	const d = new QuestionnaireDialog({
		session: new QuestionnaireSession(params),
		done: (r) => results.push(r),
	});
	return {
		d,
		results,
		type: (text: string) => {
			for (const ch of text) d.handleInput(ch);
		},
	};
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Every line must be exactly `width` columns — no more, no less. */
function assertRectangular(lines: string[], width: number, context: string) {
	for (const [i, line] of lines.entries()) {
		assert.equal(
			visibleWidth(strip(line)),
			width,
			`${context}: line ${i} is ${visibleWidth(strip(line))} cols, expected ${width}: ${JSON.stringify(strip(line))}`,
		);
	}
}

test("the option list renders as a perfect rectangle at several widths", () => {
	for (const width of [40, 60, 80, 120, 200]) {
		const { d } = dialog();
		assertRectangular(d.render(width), width, `option list @${width}`);
	}
});

test("long labels and descriptions wrap without breaking the box at any width", () => {
	// The label cap is gone and descriptions wrap, so the only thing standing
	// between authored prose and a broken border is the renderer itself.
	const verbose: AskUserParams = {
		questions: [
			{
				question: "Which migration strategy should we commit to for the analytics warehouse?",
				header: "Migration",
				options: [
					{
						label: "L".repeat(150),
						description: "D".repeat(250),
					},
					{
						label: "cut over in one window with a rehearsed rollback plan and a frozen schema",
						description:
							"every word of this description must survive rendering, because wrapping is the contract now: nothing authored is discarded, and the box clamp is only ever a backstop against a single unbreakable token.",
					},
				],
			},
		],
	};
	for (const width of [40, 60, 80, 120, 200]) {
		const d = new QuestionnaireDialog({ session: new QuestionnaireSession(verbose), done: () => {} });
		assertRectangular(d.render(width), width, `verbose question @${width}`);
	}
});

test("a long custom answer wraps instead of running past the border", () => {
	const { d, type } = dialog();
	d.handleInput("3");
	type("x".repeat(300));
	const lines = d.render(80);
	assertRectangular(lines, 80, "long custom answer");
	assert.ok(lines.length > 8, "a 300-char answer must occupy several wrapped rows");
});

test("a long answer with spaces wraps on word boundaries and stays rectangular", () => {
	const { d, type } = dialog();
	d.handleInput("3");
	type("the quick brown fox jumps over the lazy dog and keeps on running well past the edge");
	assertRectangular(d.render(64), 64, "word-wrapped answer");
});

test("the custom field stays rectangular as it grows character by character", () => {
	const { d } = dialog();
	d.handleInput("3");
	for (let i = 0; i < 220; i++) {
		d.handleInput("a");
		if (i % 17 === 0) assertRectangular(d.render(50), 50, `growing field @${i}`);
	}
});

test("an empty custom field still renders a caret row", () => {
	const { d } = dialog();
	d.handleInput("3");
	const lines = d.render(80).map(strip);
	assertRectangular(d.render(80), 80, "empty field");
	assert.ok(lines.some((l) => l.includes("▌")), "caret must be visible when the field is empty");
});

test("narrow terminals still produce a valid box", () => {
	for (const width of [20, 24, 30]) {
		const { d, type } = dialog();
		d.handleInput("3");
		type("some reasonably long answer text");
		assertRectangular(d.render(width), width, `narrow @${width}`);
	}
});

test("an over-long single line is clamped rather than breaking the border", () => {
	// A pathological option label must not be able to blow out the box.
	const wide: AskUserParams = {
		questions: [
			{
				question: "Q?",
				header: "H",
				options: [
					{ label: "L".repeat(200), description: "D".repeat(200) },
					{ label: "short", description: "d" },
				],
			},
		],
	};
	const d = new QuestionnaireDialog({ session: new QuestionnaireSession(wide), done: () => {} });
	assertRectangular(d.render(70), 70, "pathological label");
});

test("the box fills the given width by default so nothing shows through beside it", () => {
	const { d } = dialog();
	const lines = d.render(150);
	assert.equal(visibleWidth(strip(lines[0])), 150, "default must fill the width it is given");
});

test("maxWidth still caps the box when a caller asks for it", () => {
	const capped = new QuestionnaireDialog({
		session: new QuestionnaireSession(params),
		done: () => {},
		maxWidth: 60,
	});
	assertRectangular(capped.render(150), 60, "explicit maxWidth");
});

test("checkbox rows honour the same rectangle invariant", () => {
	const multi: AskUserParams = {
		questions: [
			{
				question: "Which packages should change before the release goes out?",
				header: "Packages",
				multiSelect: true,
				options: [
					{ label: "pi-stats", description: "all-time token usage dashboard" },
					{ label: "pi-statusline", description: "compact footer statusline" },
					{ label: "pi-plan-mode", description: "plan mode and its integrations" },
					{ label: "L".repeat(120), description: "D".repeat(120) },
				],
			},
		],
	};
	for (const width of [24, 40, 80, 150]) {
		const d = new QuestionnaireDialog({ session: new QuestionnaireSession(multi), done: () => {} });
		assertRectangular(d.render(width), width, `unchecked checkboxes @${width}`);
		for (const key of ["1", "2", "5"]) d.handleInput(key);
		assertRectangular(d.render(width), width, `checked checkboxes @${width}`);
	}
});
