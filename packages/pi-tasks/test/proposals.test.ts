/**
 * Proposal records, and the diff the review card is built from.
 *
 * The diff is the reason a user can approve a revision at all: the model's own
 * `reason` describes what it meant to do, and this describes what it did. They
 * are allowed to disagree, and when they do, the diff is the one that counts.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyTaskChanges, type TaskChange } from "../src/changes.js";
import { serializeTaskDocument } from "../src/markdown.js";
import { createTaskSet, type TaskSet } from "../src/model.js";
import {
	diffTaskSets,
	listPendingProposals,
	listProposals,
	newProposalId,
	proposalPath,
	readProposal,
	resolveProposal,
	type TaskProposal,
	writeProposal,
} from "../src/proposals.js";
import { writeAtomically } from "../src/store.js";

const NOW = "2026-01-01T00:00:00.000Z";
const SET_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SET_ID = "00000000-0000-4000-8000-000000000002";

function seed(): TaskSet {
	const created = applyTaskChanges(
		createTaskSet(SET_ID, NOW),
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

function change(set: TaskSet, ...changes: TaskChange[]): TaskSet {
	const result = applyTaskChanges(set, changes, { now: NOW, hasExistingSet: true });
	assert.ok(result.ok, result.ok ? "" : result.error);
	return result.result.set;
}

/**
 * A real proposed document, not a placeholder: `readProposal` now refuses a
 * record whose proposed bytes do not parse as a document for the same set,
 * because that is how a tampered proposal would redirect a publication.
 */
function proposedDocumentFor(taskSetId: string): string {
	return serializeTaskDocument({ set: { ...seed(), taskSetId }, extras: [] });
}

function proposal(overrides: Partial<TaskProposal> = {}): TaskProposal {
	return {
		schemaVersion: 1,
		proposalId: newProposalId(),
		taskSetId: SET_ID,
		status: "pending",
		reason: "drop the cutover phase",
		baseRevision: 3,
		baseDigest: "a".repeat(64),
		createdAt: NOW,
		proposedDocument: proposedDocumentFor(SET_ID),
		diff: ["- t4 removed"],
		applied: ["remove_task t4"],
		...overrides,
	};
}

test("a proposal round-trips, and pending is the only state waiting for a human", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-tasks-proposals-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const pending = proposal();
	const cancelled = proposal({ reason: "something else" });
	await writeProposal(root, pending);
	await writeProposal(root, cancelled);
	await resolveProposal(root, cancelled, "cancelled", NOW);

	const restored = await readProposal(root, SET_ID, pending.proposalId);
	assert.deepEqual(restored, pending);
	assert.equal((await listProposals(root, SET_ID)).length, 2);
	assert.deepEqual(
		(await listPendingProposals(root, SET_ID)).map((entry) => entry.proposalId),
		[pending.proposalId],
	);

	// Resolving keeps the content, so nothing proposed is ever simply lost.
	const kept = await readProposal(root, SET_ID, cancelled.proposalId);
	assert.equal(kept?.status, "cancelled");
	assert.equal(kept?.resolvedAt, NOW);
	assert.equal(kept?.proposedDocument, cancelled.proposedDocument);
});

test("a proposal id that is not a uuid cannot name a path", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-tasks-proposals-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(await readProposal(root, SET_ID, "../../etc/passwd"), undefined);
	assert.equal(await readProposal(root, SET_ID, "not-a-uuid"), undefined);
});

test("a proposal that disagrees with its own filename, set, or document is refused", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-tasks-proposals-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	// The record claims a different id than the file it is stored under.
	const renamed = proposal();
	await writeProposal(root, renamed);
	const impostorId = newProposalId();
	await writeAtomically(
		proposalPath(root, SET_ID, impostorId),
		`${JSON.stringify({ ...renamed, proposalId: renamed.proposalId }, null, 2)}\n`,
	);
	assert.equal(await readProposal(root, SET_ID, impostorId), undefined);

	// The record's proposed document belongs to another task set, which is how a
	// tampered proposal would try to redirect the publication.
	const redirect = proposal({ proposedDocument: proposedDocumentFor(OTHER_SET_ID) });
	await writeProposal(root, redirect);
	assert.equal(await readProposal(root, SET_ID, redirect.proposalId), undefined);

	// The record names another task set outright.
	const foreign = proposal();
	await writeAtomically(
		proposalPath(root, SET_ID, foreign.proposalId),
		`${JSON.stringify({ ...foreign, taskSetId: OTHER_SET_ID }, null, 2)}\n`,
	);
	assert.equal(await readProposal(root, SET_ID, foreign.proposalId), undefined);

	// None of them can masquerade as pending review either.
	assert.deepEqual(await listPendingProposals(root, SET_ID), [renamed]);
});

test("an oversized or non-regular proposal is refused before it is read", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-tasks-proposals-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, SET_ID, "proposals"), { recursive: true });

	const oversizedId = newProposalId();
	writeFileSync(proposalPath(root, SET_ID, oversizedId), "x".repeat(2 * 1024 * 1024 + 1));
	assert.equal(await readProposal(root, SET_ID, oversizedId), undefined);

	const directoryId = newProposalId();
	mkdirSync(proposalPath(root, SET_ID, directoryId));
	assert.equal(await readProposal(root, SET_ID, directoryId), undefined);

	const symlinkId = newProposalId();
	const target = proposalPath(root, SET_ID, newProposalId());
	writeFileSync(target, `${JSON.stringify(proposal(), null, 2)}\n`);
	symlinkSync(target, proposalPath(root, SET_ID, symlinkId));
	assert.equal(await readProposal(root, SET_ID, symlinkId), undefined);
});

test("superseding retires a candidate without losing what it proposed", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-tasks-proposals-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const first = proposal({ reason: "drop everything" });
	const second = proposal({ reason: "drop only the cutover phase" });
	await writeProposal(root, first);
	await writeProposal(root, second);
	await resolveProposal(root, first, "superseded", NOW, {
		supersededBy: second.proposalId,
		resolutionReason: "a corrected proposal replaced it",
	});

	const retired = await readProposal(root, SET_ID, first.proposalId);
	assert.equal(retired?.status, "superseded");
	assert.equal(retired?.supersededBy, second.proposalId);
	assert.equal(retired?.resolutionReason, "a corrected proposal replaced it");
	assert.equal(retired?.proposedDocument, first.proposedDocument);
	assert.equal(retired?.reason, "drop everything");
	// Retired means "never publishable again", not "deleted".
	assert.deepEqual(
		(await listPendingProposals(root, SET_ID)).map((entry) => entry.proposalId),
		[second.proposalId],
	);
	assert.equal((await listProposals(root, SET_ID)).length, 2);
});

test("an unreadable or unknown proposal is absent, not a crash", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-tasks-proposals-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(await readProposal(root, SET_ID, newProposalId()), undefined);
	assert.deepEqual(await listProposals(root, SET_ID), []);
});

test("the diff matches by id, so a reword is a rename and keeps its history", () => {
	const base = change(seed(), { op: "done", taskId: "t1", summary: "added with a default" });
	const next = change(base, {
		op: "edit_task",
		taskId: "t1",
		content: "add the revision column",
		labelOnly: true,
	});
	assert.deepEqual(diffTaskSets(base, next), [
		'~ t1 reworded: "add the column" -> "add the revision column"',
	]);
});

test("a reopen is called out as one, because a past completion stops counting", () => {
	const base = change(seed(), { op: "done", taskId: "t1", summary: "added with a default" });
	const next = change(base, { op: "reopen", taskId: "t1" });
	const diff = diffTaskSets(base, next);
	assert.equal(diff.length, 1);
	assert.match(diff[0] ?? "", /~ t1 completed -> pending/u);
	assert.match(diff[0] ?? "", /no longer counts/u);
});

test("additions, removals, renames and moves each read as themselves", () => {
	const base = seed();
	let next = change(base, { op: "add_task", phaseId: "p1", content: "write the rollback" });
	next = change(next, { op: "rename_phase", phaseId: "p1", name: "Schema changes" });
	next = change(next, { op: "move_task", taskId: "t3", phaseId: "p1" });
	next = change(next, { op: "remove_task", taskId: "t2" });
	next = change(next, { op: "remove_phase", phaseId: "p2" });
	assert.deepEqual(diffTaskSets(base, next), [
		'~ phase p1 renamed: "Schema" -> "Schema changes"',
		'- phase p2 "Cutover" removed',
		'+ t4 in p1: "write the rollback"',
		"~ t3 moved: p2 -> p1",
		'- t2: "backfill" removed (was pending)',
	]);
});

test("a removed completed task is reported with its evidence retained", () => {
	const base = change(seed(), { op: "done", taskId: "t3", summary: "shipped" });
	const next = change(base, { op: "remove_task", taskId: "t3" });
	assert.deepEqual(diffTaskSets(base, next), [
		'- t3: "flip the flag" removed (was completed, completion retained in history)',
	]);
});

test("an identical set produces an empty diff, so a no-op proposal shows as one", () => {
	const base = seed();
	assert.deepEqual(diffTaskSets(base, base), []);
});

test("a new blocker appears on the diff, because it changes what is true of the task", () => {
	const base = seed();
	const next = change(base, { op: "block", taskId: "t1", blocker: "waiting on the dump" });
	assert.deepEqual(diffTaskSets(base, next), [
		"~ t1 pending -> blocked",
		"~ t1 blocker: waiting on the dump",
	]);
});
