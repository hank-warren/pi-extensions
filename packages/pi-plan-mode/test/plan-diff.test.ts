/**
 * The diff is what the user approves, so it has to be right about the one thing
 * a reviewer acts on: which lines left and which arrived.
 *
 * There is deliberately no judgement here about which changes are "material" —
 * no classifier, no heuristic. A revision that only reworded a heading and a
 * revision that deleted the verification section both render as what they are.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { describePlanDiff, diffPlanText } from "../src/plan-diff.js";

const BASE = `# Deploy

## Approach

1. Migrate the schema.
2. Deploy with blue/green.
3. Flip the flag.

## Verification

- npm test passes.`;

test("an unchanged plan is identical, whatever its trailing newlines", () => {
	for (const next of [BASE, `${BASE}\n`, `${BASE}\n\n`, BASE.replace(/\n/gu, "\r\n")]) {
		const diff = diffPlanText(BASE, next);
		assert.equal(diff.identical, true, JSON.stringify(next.slice(-4)));
		assert.deepEqual(diff.lines, []);
		assert.equal(describePlanDiff(diff), "no change");
	}
});

test("a changed line reads as one removal and one addition, in context", () => {
	const diff = diffPlanText(BASE, BASE.replace("blue/green", "a rolling restart"));
	assert.equal(diff.identical, false);
	assert.equal(diff.added, 1);
	assert.equal(diff.removed, 1);
	assert.ok(diff.lines.includes("-2. Deploy with blue/green."));
	assert.ok(diff.lines.includes("+2. Deploy with a rolling restart."));
	// Context lines are kept so the change is readable, and marked as context.
	assert.ok(diff.lines.includes(" 1. Migrate the schema."));
	assert.equal(describePlanDiff(diff), "1 line(s) added, 1 line(s) removed");
});

test("a deleted section reads as deletions, not as a rewrite", () => {
	const diff = diffPlanText(BASE, BASE.replace("\n\n## Verification\n\n- npm test passes.", ""));
	assert.equal(diff.added, 0);
	assert.equal(diff.removed, 4);
	assert.ok(diff.lines.includes("-## Verification"));
	assert.ok(diff.lines.includes("-- npm test passes."));
});

test("unchanged stretches are elided with a marker rather than printed whole", () => {
	const filler = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
	const diff = diffPlanText(`first\n${filler}\nlast`, `FIRST\n${filler}\nLAST`);
	assert.equal(diff.added, 2);
	assert.equal(diff.removed, 2);
	assert.ok(diff.lines.includes("@@"), diff.lines.join("\n"));
	assert.ok(diff.lines.length < 20, `expected elision, got ${diff.lines.length} lines`);
});

test("an output too long to read is truncated and says so", () => {
	const left = Array.from({ length: 400 }, (_, index) => `old ${index}`).join("\n");
	const right = Array.from({ length: 400 }, (_, index) => `new ${index}`).join("\n");
	const diff = diffPlanText(left, right);
	assert.equal(diff.truncated, true);
	assert.match(diff.lines.at(-1) ?? "", /diff truncated/u);
	// The counts are of the whole change, not of what fitted on the card.
	assert.equal(diff.added, 400);
	assert.equal(diff.removed, 400);
});

test("a plan too long to diff line by line still reports what moved", () => {
	const left = Array.from({ length: 1600 }, (_, index) => `# Section ${index}`).join("\n");
	const right = `${left.replace("# Section 3\n", "")}\n# Section fresh`;
	const diff = diffPlanText(left, right);
	assert.equal(diff.truncated, true);
	assert.ok(diff.lines.some((line) => line.includes("too long to diff line by line")));
	assert.ok(diff.lines.includes("+# Section fresh"));
	assert.ok(diff.lines.includes("-# Section 3"));
});
