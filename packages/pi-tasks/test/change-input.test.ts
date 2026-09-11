/**
 * Turning what a model sent into a change this package will run.
 *
 * The schema cannot say "done needs a summary" without a discriminated union
 * that some providers handle badly, so that check lives here. Every error names
 * the op and the field, because a model that gets "invalid input" back tends to
 * try the same call again.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeChanges } from "../src/change-input.js";

function expectError(raw: unknown): string {
	const result = normalizeChanges(raw);
	assert.equal(result.ok, false, "expected the input to be refused");
	return result.ok ? "" : result.error;
}

test("whitespace around an op is trimmed rather than rejected", () => {
	const result = normalizeChanges([{ op: " start\n", taskId: " t3 " }]);
	assert.ok(result.ok);
	assert.deepEqual(result.changes, [{ op: "start", taskId: "t3" }]);
});

test("done and abandon both insist on a summary, and say why", () => {
	assert.match(expectError([{ op: "done", taskId: "t1" }]), /done\): summary is required/u);
	assert.match(expectError([{ op: "done", taskId: "t1" }]), /what was actually done/u);
	assert.match(expectError([{ op: "abandon", taskId: "t1", summary: "  " }]), /summary is required/u);
});

test("block insists on naming what the task is waiting for", () => {
	assert.match(expectError([{ op: "block", taskId: "t1" }]), /block\): blocker is required/u);
});

test("a targeted change without its id is refused, never applied to a guess", () => {
	assert.match(expectError([{ op: "start" }]), /start\): taskId is required/u);
	assert.match(expectError([{ op: "remove_phase" }]), /remove_phase\): phaseId is required/u);
	assert.match(
		expectError([{ op: "add_task", content: "x" }]),
		/add_task\): phaseId is required/u,
	);
	assert.match(
		expectError([{ op: "move_task", taskId: "t1" }]),
		/move_task\): phaseId is required/u,
	);
});

test("an unknown op is refused with the list of real ones", () => {
	const error = expectError([{ op: "complete", taskId: "t1" }]);
	assert.match(error, /op must be one of/u);
	assert.match(error, /remove_phase/u);
});

test("the error names the position, so a long batch can be fixed", () => {
	assert.match(
		expectError([{ op: "start", taskId: "t1" }, { op: "done", taskId: "t1" }]),
		/^change 2 \(done\)/u,
	);
});

test("init carries its nested phases through with every string trimmed", () => {
	const result = normalizeChanges([
		{
			op: "init",
			label: " migration ",
			phases: [{ name: " Schema ", tasks: [" add the column ", "backfill"] }],
		},
	]);
	assert.ok(result.ok);
	assert.deepEqual(result.changes, [
		{
			op: "init",
			label: "migration",
			phases: [{ name: "Schema", tasks: ["add the column", "backfill"] }],
		},
	]);
});

test("init without phases is refused before it can create an empty set", () => {
	assert.match(expectError([{ op: "init" }]), /init\): phases is required/u);
	assert.match(
		expectError([{ op: "init", phases: [{ name: "Schema" }] }]),
		/phases\[0\]\.tasks must be an array/u,
	);
	assert.match(
		expectError([{ op: "init", phases: [{ tasks: ["x"] }] }]),
		/phases\[0\]\.name is required/u,
	);
});

test("labelOnly is only honoured when it is literally true", () => {
	const result = normalizeChanges([
		{ op: "edit_task", taskId: "t1", content: "x", labelOnly: "yes" },
		{ op: "edit_task", taskId: "t2", content: "y", labelOnly: true },
	]);
	assert.ok(result.ok);
	assert.deepEqual(result.changes[0], { op: "edit_task", taskId: "t1", content: "x" });
	assert.deepEqual(result.changes[1], {
		op: "edit_task",
		taskId: "t2",
		content: "y",
		labelOnly: true,
	});
});

test("optional ordering hints are dropped when blank rather than passed through empty", () => {
	const result = normalizeChanges([
		{ op: "add_task", phaseId: "p1", content: "x", beforeTaskId: "  " },
		{ op: "add_phase", name: "Later", beforePhaseId: "p2" },
	]);
	assert.ok(result.ok);
	assert.deepEqual(result.changes[0], { op: "add_task", phaseId: "p1", content: "x" });
	assert.deepEqual(result.changes[1], { op: "add_phase", name: "Later", beforePhaseId: "p2" });
});

test("anything that is not an array of objects is refused outright", () => {
	assert.match(expectError("start t1"), /changes must be an array/u);
	assert.match(expectError([null]), /change 1 must be an object/u);
});
