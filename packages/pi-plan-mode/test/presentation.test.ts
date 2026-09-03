/**
 * The status language, in one place.
 *
 * The footer and the widget render from one view for a reason: when each
 * formatted its own, they drifted. The sibling extension shipped a loop that
 * read "waiting" in the footer and "running" above the editor, which is the
 * same bug this file exists to prevent between "ready" and "implementing".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { planModeStatusText, planModeView } from "../src/presentation.js";
import type { PlanModeState } from "../src/state.js";

const state = (overrides: Partial<PlanModeState> = {}): PlanModeState => ({
	enabled: false,
	awaitingAction: false,
	...overrides,
});

test("every plan state has exactly one line, in the family's glyph vocabulary", () => {
	const drafting = planModeView(state({ enabled: true }));
	assert.equal(drafting?.phase, "drafting");
	assert.equal(drafting?.footer, "◆ plan · drafting");

	const ready = planModeView(state({ enabled: true, awaitingAction: true, planPath: "/p.md" }));
	assert.equal(ready?.phase, "ready");
	assert.equal(ready?.footer, "◆ plan · ready → /plan");
	// The one state that wants a decision says where to make it.
	assert.match(ready?.hint ?? "", /\/plan to implement/);

	// A stored plan with no pending action means feedback superseded it. Calling
	// that "drafting" would hide that a completed plan is being replaced.
	const revising = planModeView(state({ enabled: true, planPath: "/p.md" }));
	assert.equal(revising?.phase, "revising");
	assert.equal(revising?.footer, "◆ plan · revising");

	const implementing = planModeView(state({ planPath: "/p.md" }));
	assert.equal(implementing?.phase, "implementing");
	assert.equal(implementing?.footer, "▶ plan · implementing");
	assert.equal(implementing?.tone, "normal", "implementing is work, not a decision");

	// Off is the absence of a line, not a line saying nothing.
	assert.equal(planModeView(state()), undefined);
});

test("the widget and the footer are the same view, so they cannot disagree", () => {
	for (const s of [
		state({ enabled: true }),
		state({ enabled: true, awaitingAction: true, planPath: "/p.md" }),
		state({ enabled: true, planPath: "/p.md" }),
		state({ planPath: "/p.md" }),
	]) {
		const view = planModeView(s);
		assert.ok(view);
		// One phase, one glyph, in both sizes.
		assert.equal(view.headline.slice(0, 1), view.footer.slice(0, 1));
		assert.ok(view.hint.length > 0, `${view.phase} has no hint`);
	}
});

test("the sentence form still exists for menus and non-TUI modes", () => {
	assert.match(planModeStatusText(state({ enabled: true })), /Plan mode is active/);
	assert.match(planModeStatusText(state()), /Plan mode is off/);
});
