/**
 * The batch engine's rules, which are the product.
 *
 * Every refusal here was chosen over a convenience, so each one is pinned with
 * the reason it exists: a task list that quietly demotes, reopens, or discards
 * is worse than no task list, because it is believed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTaskChanges, isProgressOnlyBatch, type TaskChange } from "../src/changes.js";
import { createTaskSet, findTask, type TaskSet } from "../src/model.js";

const NOW = "2026-01-01T00:00:00.000Z";

function seed(): TaskSet {
	const created = applyTaskChanges(createTaskSet("set-1", NOW), [initChange()], {
		now: NOW,
		hasExistingSet: false,
	});
	assert.ok(created.ok, created.ok ? "" : created.error);
	return created.result.set;
}

function initChange(): TaskChange {
	return {
		op: "init",
		label: "migration",
		phases: [
			{ name: "Schema", tasks: ["add the column", "backfill"] },
			{ name: "Cutover", tasks: ["flip the flag"] },
		],
	};
}

function apply(set: TaskSet, changes: TaskChange[]) {
	return applyTaskChanges(set, changes, { now: NOW, hasExistingSet: true });
}

test("init allocates every id and leaves nothing for the caller to invent", () => {
	const set = seed();
	assert.deepEqual(
		set.phases.map((phase) => phase.id),
		["p1", "p2"],
	);
	assert.deepEqual(
		set.phases.flatMap((phase) => phase.tasks.map((task) => task.id)),
		["t1", "t2", "t3"],
	);
	assert.equal(set.nextPhaseId, 3);
	assert.equal(set.nextTaskId, 4);
	assert.ok(set.phases.flatMap((phase) => phase.tasks).every((task) => task.status === "pending"));
});

test("init refuses to replace a set that already exists", () => {
	const result = applyTaskChanges(seed(), [initChange()], { now: NOW, hasExistingSet: true });
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.error, /already attached/);
});

test("init must be alone in its batch", () => {
	const result = applyTaskChanges(createTaskSet("set-1", NOW), [initChange(), { op: "start", taskId: "t1" }], {
		now: NOW,
		hasExistingSet: false,
	});
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.error, /only change/);
});

test("a second start refuses rather than demoting the first task", () => {
	const started = apply(seed(), [{ op: "start", taskId: "t1" }]);
	assert.ok(started.ok);
	const second = apply(started.result.set, [{ op: "start", taskId: "t2" }]);
	assert.equal(second.ok, false);
	assert.match(second.ok ? "" : second.error, /t1 is already in progress/);
	// The first task is untouched: a refused batch changes nothing at all.
	assert.equal(findTask(started.result.set, "t1")?.task.status, "in_progress");
	assert.equal(findTask(started.result.set, "t2")?.task.status, "pending");
});

test("done records the summary as evidence and refuses an empty one", () => {
	const empty = apply(seed(), [{ op: "done", taskId: "t1", summary: "  " }]);
	assert.equal(empty.ok, false);
	assert.match(empty.ok ? "" : empty.error, /summary must not be empty/);

	const done = apply(seed(), [{ op: "done", taskId: "t1", summary: "added it with a default" }]);
	assert.ok(done.ok);
	const task = findTask(done.result.set, "t1")?.task;
	assert.equal(task?.status, "completed");
	assert.equal(task?.completion?.summary, "added it with a default");
	assert.equal(task?.completion?.recordedAt, NOW);
});

test("a closed task cannot be re-closed, restarted, or blocked without reopen", () => {
	const done = apply(seed(), [{ op: "done", taskId: "t1", summary: "done" }]);
	assert.ok(done.ok);
	for (const change of [
		{ op: "done", taskId: "t1", summary: "again" },
		{ op: "start", taskId: "t1" },
		{ op: "block", taskId: "t1", blocker: "waiting" },
		{ op: "abandon", taskId: "t1", summary: "never mind" },
	] as TaskChange[]) {
		const result = apply(done.result.set, [change]);
		assert.equal(result.ok, false, `${change.op} should refuse a completed task`);
		assert.match(result.ok ? "" : result.error, /reopen/);
	}
});

test("reopen keeps the completion as history rather than dropping it", () => {
	const done = apply(seed(), [{ op: "done", taskId: "t1", summary: "first pass" }]);
	assert.ok(done.ok);
	const reopened = apply(done.result.set, [{ op: "reopen", taskId: "t1" }]);
	assert.ok(reopened.ok);
	const task = findTask(reopened.result.set, "t1")?.task;
	assert.equal(task?.status, "pending");
	assert.equal(task?.completion, undefined);
	assert.deepEqual(task?.completionHistory?.map((entry) => entry.summary), ["first pass"]);
});

test("a scope-changing edit to a closed task needs the reopen in the same batch", () => {
	const done = apply(seed(), [{ op: "done", taskId: "t1", summary: "done" }]);
	assert.ok(done.ok);

	const refused = apply(done.result.set, [
		{ op: "edit_task", taskId: "t1", content: "add the column and an index" },
	]);
	assert.equal(refused.ok, false);
	assert.match(refused.ok ? "" : refused.error, /explicit reopen in the same batch/);

	const together = apply(done.result.set, [
		{ op: "reopen", taskId: "t1" },
		{ op: "edit_task", taskId: "t1", content: "add the column and an index" },
	]);
	assert.ok(together.ok);
	assert.equal(findTask(together.result.set, "t1")?.task.status, "pending");
});

test("labelOnly keeps a completion, and cannot be claimed after a reopen in the same batch", () => {
	const done = apply(seed(), [{ op: "done", taskId: "t1", summary: "done" }]);
	assert.ok(done.ok);
	const reworded = apply(done.result.set, [
		{ op: "edit_task", taskId: "t1", content: "add the `revision` column", labelOnly: true },
	]);
	assert.ok(reworded.ok);
	const task = findTask(reworded.result.set, "t1")?.task;
	assert.equal(task?.status, "completed");
	assert.equal(task?.completion?.summary, "done");

	const laundered = apply(done.result.set, [
		{ op: "reopen", taskId: "t1" },
		{ op: "edit_task", taskId: "t1", content: "do something else", labelOnly: true },
	]);
	assert.equal(laundered.ok, false);
	assert.match(laundered.ok ? "" : laundered.error, /drop labelOnly/);
});

test("unblock returns to pending, never straight back to in progress", () => {
	const blocked = apply(seed(), [
		{ op: "start", taskId: "t1" },
		{ op: "block", taskId: "t1", blocker: "waiting on review" },
	]);
	assert.ok(blocked.ok);
	assert.equal(findTask(blocked.result.set, "t1")?.task.blocker, "waiting on review");
	const unblocked = apply(blocked.result.set, [{ op: "unblock", taskId: "t1" }]);
	assert.ok(unblocked.ok);
	assert.equal(findTask(unblocked.result.set, "t1")?.task.status, "pending");
	assert.equal(findTask(unblocked.result.set, "t1")?.task.blocker, undefined);
});

test("a batch is atomic: one bad change discards the whole thing", () => {
	const base = seed();
	const result = apply(base, [
		{ op: "start", taskId: "t1" },
		{ op: "done", taskId: "t9", summary: "no such task" },
	]);
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.error, /change 2 \(done\): unknown task id: t9/);
	// The input set is never mutated, so the caller can safely retry against it.
	assert.equal(findTask(base, "t1")?.task.status, "pending");
});

test("remove_phase refuses to take tasks with it, and removal never reuses an id", () => {
	const base = seed();
	const refused = apply(base, [{ op: "remove_phase", phaseId: "p2" }]);
	assert.equal(refused.ok, false);
	assert.match(refused.ok ? "" : refused.error, /still holds 1 task/);

	const emptied = apply(base, [
		{ op: "remove_task", taskId: "t3" },
		{ op: "remove_phase", phaseId: "p2" },
		{ op: "add_task", phaseId: "p1", content: "a replacement" },
	]);
	assert.ok(emptied.ok);
	assert.deepEqual(emptied.result.set.removedTasks.map((entry) => entry.id), ["t3"]);
	assert.deepEqual(emptied.result.set.removedPhases.map((entry) => entry.id), ["p2"]);
	assert.deepEqual(emptied.result.allocatedTasks.map((task) => task.id), ["t4"]);
});

test("a removed task keeps the completion it was closed with", () => {
	const done = apply(seed(), [{ op: "done", taskId: "t3", summary: "shipped" }]);
	assert.ok(done.ok);
	const removed = apply(done.result.set, [{ op: "remove_task", taskId: "t3" }]);
	assert.ok(removed.ok);
	assert.equal(removed.result.set.removedTasks[0]?.completion?.summary, "shipped");
	assert.equal(removed.result.set.removedTasks[0]?.status, "completed");
});

test("move_task keeps identity and status while changing phase", () => {
	const started = apply(seed(), [{ op: "start", taskId: "t3" }]);
	assert.ok(started.ok);
	const moved = apply(started.result.set, [
		{ op: "move_task", taskId: "t3", phaseId: "p1", beforeTaskId: "t1" },
	]);
	assert.ok(moved.ok);
	assert.deepEqual(
		moved.result.set.phases[0]?.tasks.map((task) => task.id),
		["t3", "t1", "t2"],
	);
	assert.equal(findTask(moved.result.set, "t3")?.task.status, "in_progress");
});

test("an unknown id in a move leaves the task where it was", () => {
	const base = seed();
	const result = apply(base, [{ op: "move_task", taskId: "t3", phaseId: "p1", beforeTaskId: "t9" }]);
	assert.equal(result.ok, false);
	assert.equal(base.phases[1]?.tasks.map((task) => task.id).join(), "t3");
});

test("content with a comment delimiter is refused rather than escaped", () => {
	const result = apply(seed(), [{ op: "add_task", phaseId: "p1", content: "fix <!-- this -->" }]);
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.error, /HTML comment delimiter/);
});

test("progress-only batches are distinguishable from scope changes", () => {
	assert.equal(
		isProgressOnlyBatch([
			{ op: "start", taskId: "t1" },
			{ op: "done", taskId: "t1", summary: "s" },
		]),
		true,
	);
	assert.equal(
		isProgressOnlyBatch([{ op: "edit_task", taskId: "t1", content: "x", labelOnly: true }]),
		true,
	);
	assert.equal(isProgressOnlyBatch([{ op: "add_task", phaseId: "p1", content: "x" }]), false);
	assert.equal(isProgressOnlyBatch([{ op: "edit_task", taskId: "t1", content: "x" }]), false);
});
