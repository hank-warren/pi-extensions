/**
 * The document format: lossless where it must be, strict where it must be.
 *
 * Two properties matter. Everything the model set has to survive a round trip,
 * or a status update silently discards a blocker or a completion. And anything
 * the parser cannot vouch for has to be refused, because the alternative is an
 * id collision or a counter that hands out an id twice.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTaskChanges } from "../src/changes.js";
import {
	ORPHANED_EXTRAS_HEADING,
	parseTaskDocument,
	serializeTaskDocument,
	type TaskDocument,
} from "../src/markdown.js";
import { createTaskSet, type TaskSet } from "../src/model.js";

const NOW = "2026-01-01T00:00:00.000Z";

function seed(): TaskSet {
	const created = applyTaskChanges(
		createTaskSet("set-1", NOW),
		[
			{
				op: "init",
				label: "migration",
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

function roundTrip(document: TaskDocument): TaskDocument {
	const parsed = parseTaskDocument(serializeTaskDocument(document));
	assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
	return parsed.document;
}

function parseOrThrow(text: string): TaskDocument {
	const parsed = parseTaskDocument(text);
	assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
	return parsed.document;
}

test("a set round-trips through the document byte for byte", () => {
	const document: TaskDocument = { set: seed(), extras: [] };
	const first = serializeTaskDocument(document);
	const second = serializeTaskDocument(roundTrip(document));
	assert.equal(second, first);
});

test("status, blocker, completion and superseded completions all survive", () => {
	const changed = applyTaskChanges(
		seed(),
		[
			{ op: "done", taskId: "t1", summary: "added with a default" },
			{ op: "reopen", taskId: "t1" },
			{ op: "done", taskId: "t1", summary: "added with an index too" },
			{ op: "block", taskId: "t2", blocker: "waiting on the dump" },
			{ op: "start", taskId: "t3" },
		],
		{ now: NOW, hasExistingSet: true },
	);
	assert.ok(changed.ok);
	const restored = roundTrip({ set: changed.result.set, extras: [] });
	const tasks = restored.set.phases.flatMap((phase) => phase.tasks);
	assert.equal(tasks[0]?.status, "completed");
	assert.equal(tasks[0]?.completion?.summary, "added with an index too");
	assert.deepEqual(tasks[0]?.completionHistory?.map((entry) => entry.summary), [
		"added with a default",
	]);
	assert.equal(tasks[1]?.status, "blocked");
	assert.equal(tasks[1]?.blocker, "waiting on the dump");
	assert.equal(tasks[2]?.status, "in_progress");
});

test("the markers are the five states, one character each", () => {
	const changed = applyTaskChanges(
		seed(),
		[
			{ op: "done", taskId: "t1", summary: "s" },
			{ op: "abandon", taskId: "t2", summary: "not needed" },
			{ op: "start", taskId: "t3" },
		],
		{ now: NOW, hasExistingSet: true },
	);
	assert.ok(changed.ok);
	const text = serializeTaskDocument({ set: changed.result.set, extras: [] });
	assert.match(text, /^- \[x\] add the column <!-- t1 /mu);
	assert.match(text, /^- \[-\] backfill <!-- t2 /mu);
	assert.match(text, /^- \[\/\] flip the flag <!-- t3 -->$/mu);
});

test("unrecognised lines are preserved in place across a status-only update", () => {
	const document: TaskDocument = {
		set: seed(),
		extras: [
			{ anchor: { kind: "start" }, text: "> Context the user wrote by hand." },
			{ anchor: { kind: "phase", id: "p1" }, text: "Notes about the schema phase." },
			{ anchor: { kind: "task", id: "t1" }, text: "  <!-- a stray comment -->" },
		],
	};
	const text = serializeTaskDocument(document);
	const parsed = parseTaskDocument(text);
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.document.extras, document.extras);

	const changed = applyTaskChanges(parsed.document.set, [{ op: "start", taskId: "t1" }], {
		now: NOW,
		hasExistingSet: true,
	});
	assert.ok(changed.ok);
	const after = serializeTaskDocument({ set: changed.result.set, extras: parsed.document.extras });
	assert.match(after, /> Context the user wrote by hand\./u);
	assert.match(after, /Notes about the schema phase\./u);
	assert.match(after, /<!-- a stray comment -->/u);
});

test("a note whose task is removed is retained, not silently deleted", () => {
	const document: TaskDocument = {
		set: seed(),
		extras: [
			{ anchor: { kind: "task", id: "t1" }, text: "> why this one matters" },
			{ anchor: { kind: "task", id: "t3" }, text: "> and this one" },
		],
	};
	const removed = applyTaskChanges(document.set, [{ op: "remove_task", taskId: "t1" }], {
		now: NOW,
		hasExistingSet: true,
	});
	assert.ok(removed.ok);
	const text = serializeTaskDocument({ set: removed.result.set, extras: document.extras });
	assert.match(text, /> why this one matters/u);
	assert.match(text, /> and this one/u);
	assert.equal(text.includes(ORPHANED_EXTRAS_HEADING), true);

	// It comes back as an ordinary preserved line anchored to the last live task,
	// so the placement settles instead of drifting, and the marker is structural
	// rather than an extra that would re-emit a second copy on every write.
	const parsed = parseTaskDocument(text);
	assert.ok(parsed.ok);
	assert.equal(parsed.document.extras.filter((extra) => extra.text.startsWith(">")).length, 2);
	const again = serializeTaskDocument(parsed.document);
	assert.match(again, /> why this one matters/u);
	assert.match(again, /> and this one/u);
	assert.equal(again.includes(ORPHANED_EXTRAS_HEADING), false);
	assert.equal(again, serializeTaskDocument(parseOrThrow(again)));
});

test("notes under a removed phase are retained too", () => {
	const document: TaskDocument = {
		set: seed(),
		extras: [{ anchor: { kind: "phase", id: "p2" }, text: "Cutover runbook lives in ops/." }],
	};
	const emptied = applyTaskChanges(
		document.set,
		[
			{ op: "remove_task", taskId: "t3" },
			{ op: "remove_phase", phaseId: "p2" },
		],
		{ now: NOW, hasExistingSet: true },
	);
	assert.ok(emptied.ok);
	const text = serializeTaskDocument({ set: emptied.result.set, extras: document.extras });
	assert.match(text, /Cutover runbook lives in ops\/\./u);
});

test("a document with no metadata comment is not a task document", () => {
	const parsed = parseTaskDocument("# Tasks\n\n## Schema <!-- p1 -->\n\n- [ ] x <!-- t1 -->\n");
	assert.equal(parsed.ok, false);
	assert.match(parsed.ok ? "" : parsed.error, /no pi-tasks metadata/);
});

test("a future schema version is refused rather than rewritten by an older build", () => {
	const text = serializeTaskDocument({ set: seed(), extras: [] }).replace(
		/pi-tasks:v1 \{"schemaVersion":1/u,
		'pi-tasks:v2 {"schemaVersion":2',
	);
	const parsed = parseTaskDocument(text);
	assert.equal(parsed.ok, false);
	assert.match(parsed.ok ? "" : parsed.error, /schema v2.*understands v1/u);
});

test("duplicate ids are refused in both dimensions", () => {
	const base = serializeTaskDocument({ set: seed(), extras: [] });
	const duplicateTask = base.replace("<!-- t2 -->", "<!-- t1 -->");
	assert.match(assertFails(duplicateTask), /duplicate task id: t1/u);
	const duplicatePhase = base.replace("<!-- p2 -->", "<!-- p1 -->");
	assert.match(assertFails(duplicatePhase), /duplicate phase id: p1/u);
});

test("an id ahead of its counter is refused, so an id can never be handed out twice", () => {
	const text = serializeTaskDocument({ set: seed(), extras: [] }).replace(
		"<!-- t3 -->",
		"<!-- t9 -->",
	);
	assert.match(assertFails(text), /task id t9 is ahead of nextTaskId 4/u);
});

test("an unknown status marker is refused rather than guessed", () => {
	const text = serializeTaskDocument({ set: seed(), extras: [] }).replace("- [ ] add", "- [?] add");
	assert.match(assertFails(text), /unknown status marker/u);
});

test("a second in-progress task in the file is refused", () => {
	const text = serializeTaskDocument({ set: seed(), extras: [] })
		.replace("- [ ] add the column", "- [/] add the column")
		.replace("- [ ] backfill", "- [/] backfill");
	assert.match(assertFails(text), /2 tasks in progress/u);
});

test("a blocked task with no recorded blocker is refused", () => {
	const text = serializeTaskDocument({ set: seed(), extras: [] }).replace(
		"- [ ] add the column",
		"- [!] add the column",
	);
	assert.match(assertFails(text), /blocked but records no blocker/u);
});

test("a task line before any phase is refused", () => {
	const parsed = parseTaskDocument(
		`# Tasks\n\n<!-- pi-tasks:v1 ${JSON.stringify({
			schemaVersion: 1,
			taskSetId: "set-1",
			revision: 0,
			createdAt: NOW,
			updatedAt: NOW,
			nextPhaseId: 1,
			nextTaskId: 2,
			removedTasks: [],
			removedPhases: [],
		})} -->\n\n- [ ] orphan <!-- t1 -->\n`,
	);
	assert.equal(parsed.ok, false);
	assert.match(parsed.ok ? "" : parsed.error, /before any phase/u);
});

test("an unsafe task set id in the metadata is refused", () => {
	const text = serializeTaskDocument({ set: seed(), extras: [] }).replace(
		'"taskSetId":"set-1"',
		'"taskSetId":"../escape"',
	);
	assert.match(assertFails(text), /taskSetId is missing or unsafe/u);
});

function assertFails(text: string): string {
	const parsed = parseTaskDocument(text);
	assert.equal(parsed.ok, false, "expected the document to be refused");
	return parsed.ok ? "" : parsed.error;
}
