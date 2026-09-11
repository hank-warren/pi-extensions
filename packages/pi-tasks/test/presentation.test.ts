/**
 * The widget, the footer, and the status sentence.
 *
 * One formatter feeds the first two, which is the whole point of the file: when
 * each surface formatted its own, pi-loop shipped a loop that read as "waiting"
 * below and "running" above. Every case below therefore asserts the phase once
 * and then checks that both surfaces came from it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTaskChanges } from "../src/changes.js";
import { createTaskSet, type TaskSet } from "../src/model.js";
import {
	formatTaskSetMarkdown,
	tasksStatusText,
	tasksView,
	updateTasksUi,
} from "../src/presentation.js";
import { createMockContext } from "../../../test/support/mock-pi.js";

const NOW = "2026-01-01T00:00:00.000Z";

function seed(): TaskSet {
	const created = applyTaskChanges(
		createTaskSet("set-1", NOW),
		[
			{
				op: "init",
				phases: [
					{ name: "Schema", tasks: ["add the column", "backfill"] },
					{ name: "Cutover", tasks: ["flip the flag"] },
				],
			},
		],
		{ now: NOW, hasExistingSet: false },
	);
	assert.ok(created.ok);
	return created.result.set;
}

function change(set: TaskSet, ...changes: Parameters<typeof applyTaskChanges>[1]): TaskSet {
	const result = applyTaskChanges(set, changes, { now: NOW, hasExistingSet: true });
	assert.ok(result.ok, result.ok ? "" : result.error);
	return result.result.set;
}

test("no task set means no footer and no widget at all", () => {
	assert.equal(tasksView({ pendingReview: false }), undefined);
	const context = createMockContext({ mode: "tui" });
	updateTasksUi(context.ctx, { pendingReview: false });
	assert.equal(context.statuses.get("pi-tasks"), undefined);
	assert.equal(context.widgets.get("pi-tasks"), undefined);
});

test("a tracked set reports progress in both sizes, from one view", () => {
	const set = change(seed(), { op: "done", taskId: "t1", summary: "s" });
	const view = tasksView({ set, pendingReview: false });
	assert.equal(view?.phase, "tracking");
	assert.equal(view?.footer, "☰ tasks · 1/3 done");

	const context = createMockContext({ mode: "tui" });
	updateTasksUi(context.ctx, { set, pendingReview: false });
	assert.equal(context.statuses.get("pi-tasks"), view?.footer);
	assert.ok(context.widgets.get("pi-tasks"));
});

test("the in-progress task is what the surfaces lead with", () => {
	const set = change(seed(), { op: "start", taskId: "t3" });
	const view = tasksView({ set, pendingReview: false });
	assert.equal(view?.phase, "working");
	assert.equal(view?.footer, "▶ tasks · 0/3 done · flip the flag");
	assert.match(view?.hint ?? "", /In progress: flip the flag/u);
});

test("a long task title is elided rather than allowed to run off the footer", () => {
	const base = seed();
	const long = change(base, {
		op: "add_task",
		phaseId: "p1",
		content: "reconcile every historical row against the new schema before the cutover window",
	});
	const started = change(long, { op: "start", taskId: "t4" });
	const view = tasksView({ set: started, pendingReview: false });
	assert.ok((view?.footer.length ?? 0) < 80, view?.footer);
	assert.match(view?.footer ?? "", /…$/u);
});

test("a pending review takes over both surfaces, in the decision tone", () => {
	const view = tasksView({ set: seed(), pendingReview: true });
	assert.equal(view?.phase, "review");
	assert.equal(view?.tone, "accent");
	assert.match(view?.footer ?? "", /revision awaiting review/u);
	assert.match(view?.hint ?? "", /Accept, request changes, or cancel/u);
});

test("a conflict outranks everything, including a pending review", () => {
	const view = tasksView({
		set: seed(),
		pendingReview: true,
		blocked: "the document was modified outside this package",
	});
	assert.equal(view?.phase, "blocked");
	assert.match(view?.footer ?? "", /needs recovery/u);
	assert.match(view?.hint ?? "", /\/tasks recover/u);
});

test("an all-closed set says so instead of claiming progress", () => {
	let set = seed();
	set = change(set, { op: "done", taskId: "t1", summary: "s" });
	set = change(set, { op: "done", taskId: "t2", summary: "s" });
	set = change(set, { op: "abandon", taskId: "t3", summary: "not needed" });
	const view = tasksView({ set, pendingReview: false });
	assert.equal(view?.phase, "done");
	assert.match(view?.footer ?? "", /all closed/u);
	assert.match(tasksStatusText({ set, pendingReview: false }), /1 abandoned/u);
});

test("the status sentence carries what the one-line surfaces cannot", () => {
	const set = change(seed(), { op: "block", taskId: "t1", blocker: "waiting on the dump" });
	const text = tasksStatusText({ set, pendingReview: true });
	assert.match(text, /Task set set-1 at revision 0/u);
	assert.match(text, /1 blocked/u);
	assert.match(text, /awaiting review/u);
});

test("the rendered list shows ids, states and the evidence behind a closed task", () => {
	let set = change(seed(), { op: "done", taskId: "t1", summary: "added with a default" });
	set = change(set, { op: "block", taskId: "t2", blocker: "waiting on the dump" });
	const markdown = formatTaskSetMarkdown(set);
	assert.match(markdown, /- \[x\] `t1` add the column — completed: added with a default/u);
	assert.match(markdown, /- \[!\] `t2` backfill — blocked: waiting on the dump/u);
	assert.match(markdown, /\*\*Schema\*\* \(p1\)/u);
});

test("a host without a component widget still gets the footer", () => {
	const context = createMockContext({ mode: "tui" });
	(context.ctx as unknown as { ui: { setWidget: () => void } }).ui.setWidget = () => {
		throw new Error("this host has no component widgets");
	};
	assert.doesNotThrow(() => updateTasksUi(context.ctx, { set: seed(), pendingReview: false }));
	assert.match(context.statuses.get("pi-tasks") ?? "", /tasks/u);
});
