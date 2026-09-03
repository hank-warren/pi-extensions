/**
 * Preview pane: markdown shown below the options while an option carrying a
 * `preview` field is highlighted (docs/specs/pi-ask-user-question.md §6.2).
 *
 * Stacked rather than side-by-side, so the box invariant from
 * dialog-render.test.ts still applies and is re-asserted here with previews in
 * play — a preview is arbitrary model-authored text and is the most likely
 * thing to blow out the layout.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { QuestionnaireSession } from "../questionnaire.ts";
import type { AskUserParams, QuestionnaireResult } from "../tool/schema.ts";
import { QuestionnaireDialog } from "../view/dialog.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function params(preview?: string, second?: string): AskUserParams {
	return {
		questions: [
			{
				question: "Which layout?",
				header: "Layout",
				options: [
					{ label: "Compact", description: "Dense", ...(preview ? { preview } : {}) },
					{ label: "Roomy", description: "Airy", ...(second ? { preview: second } : {}) },
				],
			},
		],
	};
}

function dialog(p: AskUserParams) {
	const results: QuestionnaireResult[] = [];
	const session = new QuestionnaireSession(p);
	const d = new QuestionnaireDialog({ session, done: (r) => results.push(r) });
	return { d, session, results };
}

/** Inner rule rows are all `─` between the box pipes; the border rows use ┌ └. */
function ruleRows(lines: string[]): number {
	return lines.filter((l) => /^│\s*─+\s*│$/.test(strip(l))).length;
}

test("no preview field means no preview pane", () => {
	const { d } = dialog(params());
	assert.equal(ruleRows(d.render(70)), 0, "no preview rules should be drawn");
});

test("a preview is delimited by exactly two rules", () => {
	const { d } = dialog(params("some preview"));
	assert.equal(ruleRows(d.render(70)), 2);
});

test("a highlighted option's preview renders below the options", () => {
	const { d } = dialog(params("# Mockup\n\nheader line here"));
	const out = strip(d.render(70).join("\n"));
	assert.match(out, /Mockup/);
	assert.match(out, /header line here/);
});

test("the preview follows the highlight", () => {
	const { d } = dialog(params("FIRST PREVIEW", "SECOND PREVIEW"));
	assert.match(strip(d.render(70).join("\n")), /FIRST PREVIEW/);
	d.handleInput("\x1b[B");
	const out = strip(d.render(70).join("\n"));
	assert.match(out, /SECOND PREVIEW/);
	assert.doesNotMatch(out, /FIRST PREVIEW/);
});

test("moving to an option without a preview hides the pane", () => {
	const { d } = dialog(params("ONLY ON FIRST"));
	assert.match(strip(d.render(70).join("\n")), /ONLY ON FIRST/);
	d.handleInput("\x1b[B");
	assert.doesNotMatch(strip(d.render(70).join("\n")), /ONLY ON FIRST/);
});

test("the box stays rectangular with a preview, including long lines", () => {
	const long = ["```", "x".repeat(400), "```", "tail"].join("\n");
	for (const width of [40, 70, 120]) {
		const { d } = dialog(params(long));
		for (const line of d.render(width)) {
			assert.equal(visibleWidth(strip(line)), width, `preview broke the box at ${width}`);
		}
	}
});

test("a very long preview is clipped with a count rather than pushing options off screen", () => {
	const { d } = dialog(params(Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")));
	const out = strip(d.render(70).join("\n"));
	assert.match(out, /more lines/, "clipping must be signposted");
	assert.match(out, /1\. Compact/, "the options must remain visible");
});

test("the chosen option's preview reaches the result", () => {
	const { d, results } = dialog(params("MOCKUP TEXT"));
	d.handleInput("1");
	assert.equal(results[0].answers[0].preview, "MOCKUP TEXT");
});

test("choosing an option without a preview records none", () => {
	const { d, results } = dialog(params("ONLY ON FIRST"));
	d.handleInput("2");
	assert.equal(results[0].answers[0].preview, undefined);
});

test("a typed custom answer never carries a preview", () => {
	const { d, results } = dialog(params("ONLY ON FIRST"));
	d.handleInput("3");
	for (const ch of "my own idea") d.handleInput(ch);
	d.handleInput("\r");
	assert.equal(results[0].answers[0].custom, true);
	assert.equal(results[0].answers[0].preview, undefined);
});

test("the sentinel row shows no preview pane", () => {
	const { d } = dialog(params("ONLY ON FIRST"));
	d.handleInput("\x1b[B");
	d.handleInput("\x1b[B"); // highlight "Type something."
	assert.doesNotMatch(strip(d.render(70).join("\n")), /ONLY ON FIRST/);
});

test("a throwing markdown theme degrades to plain text instead of killing the dialog", () => {
	// pi's getMarkdownTheme() returns lazily-bound functions that throw
	// "Theme not initialized" until initTheme() has run. A throw inside
	// render() would take down the whole overlay, not just the preview.
	const hostile = new Proxy(
		{},
		{
			get: () => () => {
				throw new Error("Theme not initialized. Call initTheme() first.");
			},
		},
	) as never;
	const session = new QuestionnaireSession(params("**bold** preview text"));
	const d = new QuestionnaireDialog({ session, done: () => {}, markdownTheme: hostile });
	let lines: string[] = [];
	assert.doesNotThrow(() => {
		lines = d.render(70);
	});
	assert.match(strip(lines.join("\n")), /preview text/, "content must still be shown");
	assert.equal(ruleRows(lines), 2, "the pane must still be delimited");
});
