/**
 * The durable store: publication ordering, conflict detection, and the limits
 * of both.
 *
 * The interesting cases are the ones a single-threaded happy path never
 * reaches: two writers racing for the same revision, a document that moved
 * between the read and the write, a file that is not a file. Each is exercised
 * against the real filesystem, because every one of them is a filesystem
 * behaviour rather than a branch in our code.
 */

import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyTaskChanges } from "../src/changes.js";
import { parseTaskDocument, serializeTaskDocument, type TaskDocument } from "../src/markdown.js";
import { createTaskSet } from "../src/model.js";
import {
	commitTaskDocument,
	digestOf,
	isSafeTaskSetId,
	findRecoverySnapshot,
	highestReservedRevision,
	loadTaskDocument,
	isPublishedRevision,
	publishExclusively,
	MAX_DOCUMENT_BYTES,
	snapshotPath,
	taskDocumentPath,
} from "../src/store.js";

const NOW = "2026-01-01T00:00:00.000Z";
const SET_ID = "00000000-0000-4000-8000-000000000001";

function scratchRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "pi-tasks-store-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function seedDocument(): TaskDocument {
	const created = applyTaskChanges(
		createTaskSet(SET_ID, NOW),
		[{ op: "init", phases: [{ name: "Schema", tasks: ["add the column", "backfill"] }] }],
		{ now: NOW, hasExistingSet: false },
	);
	assert.ok(created.ok);
	return { set: created.result.set, extras: [] };
}

async function commitSeed(root: string) {
	const result = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: seedDocument(),
		expectedDigest: undefined,
		now: NOW,
	});
	assert.equal(result.kind, "committed");
	return result;
}

test("the first commit publishes revision 1 and its immutable snapshot", async (t) => {
	const root = scratchRoot(t);
	const result = await commitSeed(root);
	assert.equal(result.kind === "committed" && result.revision, 1);

	const live = await loadTaskDocument(taskDocumentPath(root, SET_ID));
	assert.equal(live.kind, "loaded");
	assert.equal(live.kind === "loaded" && live.loaded.document.set.revision, 1);

	const snapshot = readFileSync(snapshotPath(root, SET_ID, 1), "utf8");
	assert.equal(snapshot, live.kind === "loaded" ? live.loaded.raw : "");
	assert.equal(await isPublishedRevision(root, SET_ID, 1, digestOf(snapshot)), true);
	// Provable, not assumed: the preparation record is what says so.
	assert.equal((await findRecoverySnapshot(root, SET_ID))?.certainty, "published");
});

test("a second first-commit refuses rather than replacing an existing set", async (t) => {
	const root = scratchRoot(t);
	await commitSeed(root);
	const again = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: seedDocument(),
		expectedDigest: undefined,
		now: NOW,
	});
	assert.equal(again.kind, "conflict");
	assert.match(again.kind === "conflict" ? again.reason : "", /already exists/u);
});

test("a commit against a digest that has moved is refused, and nothing is written", async (t) => {
	const root = scratchRoot(t);
	const first = await commitSeed(root);
	assert.ok(first.kind === "committed");
	const loaded = await loadTaskDocument(first.path);
	assert.ok(loaded.kind === "loaded");

	// Someone else commits in between.
	const interloper = applyTaskChanges(
		loaded.loaded.document.set,
		[{ op: "start", taskId: "t1" }],
		{ now: NOW, hasExistingSet: true },
	);
	assert.ok(interloper.ok);
	const second = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: interloper.result.set, extras: [] },
		expectedDigest: loaded.loaded.digest,
		now: NOW,
	});
	assert.equal(second.kind, "committed");

	// Our change was computed from the bytes that are now gone.
	const stale = applyTaskChanges(
		loaded.loaded.document.set,
		[{ op: "done", taskId: "t1", summary: "s" }],
		{ now: NOW, hasExistingSet: true },
	);
	assert.ok(stale.ok);
	const refused = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: stale.result.set, extras: [] },
		expectedDigest: loaded.loaded.digest,
		now: NOW,
	});
	assert.equal(refused.kind, "conflict");
	assert.match(refused.kind === "conflict" ? refused.reason : "", /changed since it was read/u);

	const live = await loadTaskDocument(first.path);
	assert.equal(live.kind === "loaded" && live.loaded.document.set.revision, 2);
	assert.equal(
		live.kind === "loaded" && live.loaded.document.set.phases[0]?.tasks[0]?.status,
		"in_progress",
	);
});

// Names the mechanism this actually exercises. Both commits run in one process,
// where `serializePath` serialises them before proper-lockfile is ever
// contended; the cross-process lock is covered by `multi-process.test.ts`.
test("two overlapping commits in one process produce one revision, not two", async (t) => {
	const root = scratchRoot(t);
	const first = await commitSeed(root);
	assert.ok(first.kind === "committed");
	const loaded = await loadTaskDocument(first.path);
	assert.ok(loaded.kind === "loaded");

	const build = (summary: string) => {
		const applied = applyTaskChanges(
			loaded.loaded.document.set,
			[{ op: "done", taskId: "t1", summary }],
			{ now: NOW, hasExistingSet: true },
		);
		assert.ok(applied.ok);
		return { set: applied.result.set, extras: [] };
	};

	const [left, right] = await Promise.all([
		commitTaskDocument({
			root,
			taskSetId: SET_ID,
			document: build("left"),
			expectedDigest: loaded.loaded.digest,
			now: NOW,
		}),
		commitTaskDocument({
			root,
			taskSetId: SET_ID,
			document: build("right"),
			expectedDigest: loaded.loaded.digest,
			now: NOW,
		}),
	]);
	const kinds = [left.kind, right.kind].sort();
	assert.deepEqual(kinds, ["committed", "conflict"]);

	const live = await loadTaskDocument(first.path);
	assert.equal(live.kind === "loaded" && live.loaded.document.set.revision, 2);
	assert.equal(await findRecoverySnapshot(root, SET_ID).then((entry) => entry?.revision), 2);
});

test("an oversized document is refused on the way in and on the way out", async (t) => {
	const root = scratchRoot(t);
	const path = taskDocumentPath(root, SET_ID);
	mkdirSync(join(root, SET_ID), { recursive: true });
	writeFileSync(path, "x".repeat(MAX_DOCUMENT_BYTES + 1));
	const loaded = await loadTaskDocument(path);
	assert.equal(loaded.kind, "invalid");
	assert.match(loaded.kind === "invalid" ? loaded.reason : "", /exceeds/u);
});

test("a symlink where the document should be is refused, never followed", async (t) => {
	const root = scratchRoot(t);
	const target = join(root, "elsewhere.md");
	writeFileSync(target, "# not the task document\n");
	mkdirSync(join(root, SET_ID), { recursive: true });
	symlinkSync(target, taskDocumentPath(root, SET_ID));
	const loaded = await loadTaskDocument(taskDocumentPath(root, SET_ID));
	assert.equal(loaded.kind, "invalid");
});

test("a document nobody wrote is invalid rather than missing", async (t) => {
	const root = scratchRoot(t);
	mkdirSync(join(root, SET_ID), { recursive: true });
	writeFileSync(taskDocumentPath(root, SET_ID), "just some notes\n");
	const loaded = await loadTaskDocument(taskDocumentPath(root, SET_ID));
	assert.equal(loaded.kind, "invalid");
	assert.match(loaded.kind === "invalid" ? loaded.reason : "", /metadata/u);
});

test("an absent document is missing, not an error", async (t) => {
	const root = scratchRoot(t);
	assert.equal((await loadTaskDocument(taskDocumentPath(root, SET_ID))).kind, "missing");
	assert.equal(await findRecoverySnapshot(root, SET_ID), undefined);
});

test("a document edited outside the package no longer matches its own snapshot", async (t) => {
	const root = scratchRoot(t);
	const first = await commitSeed(root);
	assert.ok(first.kind === "committed");
	const tampered = readFileSync(first.path, "utf8").replace("add the column", "add a column");
	writeFileSync(first.path, tampered);
	assert.equal(await isPublishedRevision(root, SET_ID, 1, digestOf(tampered)), false);
	// The snapshot itself is untouched, which is what recovery offers back.
	const snapshot = parseTaskDocument(readFileSync(snapshotPath(root, SET_ID, 1), "utf8"));
	assert.ok(snapshot.ok);
	assert.equal(snapshot.document.set.phases[0]?.tasks[0]?.content, "add the column");
});

/**
 * Fault injection for the window between publication and finalization: the
 * live document is renamed into place and the process dies before the snapshot
 * is linked. Reproduced by publishing normally and then deleting the snapshot,
 * which leaves exactly the on-disk state that crash produces.
 */
function loseSnapshotOf(root: string, revision: number): string {
	const path = snapshotPath(root, SET_ID, revision);
	const bytes = readFileSync(path, "utf8");
	rmSync(path);
	return bytes;
}

test("a publication interrupted before its snapshot is finished from the preparation record", async (t) => {
	const root = scratchRoot(t);
	const first = await commitSeed(root);
	assert.ok(first.kind === "committed");
	const lost = loseSnapshotOf(root, 1);
	assert.equal(existsSync(snapshotPath(root, SET_ID, 1)), false);

	// The live document still holds revision 1, and the preparation record still
	// says this package prepared exactly those bytes for it — which is the only
	// evidence that authorises writing the history entry back.
	const loaded = await loadTaskDocument(first.path);
	assert.ok(loaded.kind === "loaded");
	assert.equal(await isPublishedRevision(root, SET_ID, 1, loaded.loaded.digest), true);

	const next = applyTaskChanges(loaded.loaded.document.set, [{ op: "start", taskId: "t1" }], {
		now: NOW,
		hasExistingSet: true,
	});
	assert.ok(next.ok);
	const resumed = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: next.result.set, extras: [] },
		expectedDigest: loaded.loaded.digest,
		now: NOW,
	});
	assert.equal(resumed.kind, "committed");
	assert.equal(resumed.kind === "committed" && resumed.repairedRevision, 1);
	// Revision 1's history is back, byte-identical, and the new revision is its
	// own number rather than a second set of bytes for an existing one.
	assert.equal(readFileSync(snapshotPath(root, SET_ID, 1), "utf8"), lost);
	assert.equal(resumed.kind === "committed" && resumed.revision, 2);
	assert.equal(resumed.kind === "committed" && resumed.historyPending, undefined);
});

test("an unexplained live document is never repaired into history", async (t) => {
	const root = scratchRoot(t);
	const first = await commitSeed(root);
	assert.ok(first.kind === "committed");
	loseSnapshotOf(root, 1);

	// Same revision number, bytes this package never prepared. Being parseable is
	// not evidence of anything, so nothing is written and nothing is displaced.
	const foreign = readFileSync(first.path, "utf8").replace("add the column", "add a column");
	writeFileSync(first.path, foreign);
	const loaded = await loadTaskDocument(first.path);
	assert.ok(loaded.kind === "loaded");
	assert.equal(await isPublishedRevision(root, SET_ID, 1, loaded.loaded.digest), false);

	const next = applyTaskChanges(loaded.loaded.document.set, [{ op: "start", taskId: "t1" }], {
		now: NOW,
		hasExistingSet: true,
	});
	assert.ok(next.ok);
	const refused = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: next.result.set, extras: [] },
		expectedDigest: loaded.loaded.digest,
		now: NOW,
	});
	assert.equal(refused.kind, "conflict");
	assert.match(refused.kind === "conflict" ? refused.reason : "", /no record of publishing those bytes/u);
	assert.equal(existsSync(snapshotPath(root, SET_ID, 1)), false);
});

test("a snapshot disagreeing with the live document blocks rather than being displaced", async (t) => {
	const root = scratchRoot(t);
	const first = await commitSeed(root);
	assert.ok(first.kind === "committed");
	const accepted = readFileSync(snapshotPath(root, SET_ID, 1), "utf8");

	// The live document claims revision 1 with bytes that are not what 1.md holds.
	const foreign = accepted.replace("add the column", "add a column");
	writeFileSync(first.path, foreign);
	const loaded = await loadTaskDocument(first.path);
	assert.ok(loaded.kind === "loaded");
	const next = applyTaskChanges(loaded.loaded.document.set, [{ op: "start", taskId: "t1" }], {
		now: NOW,
		hasExistingSet: true,
	});
	assert.ok(next.ok);
	const refused = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: next.result.set, extras: [] },
		expectedDigest: loaded.loaded.digest,
		now: NOW,
	});
	assert.equal(refused.kind, "conflict");
	assert.match(refused.kind === "conflict" ? refused.reason : "", /holds different bytes/u);
	assert.equal(readFileSync(snapshotPath(root, SET_ID, 1), "utf8"), accepted);
});

test("a restored older document never costs the history published above it", async (t) => {
	const root = scratchRoot(t);
	await commitSeed(root);
	const path = taskDocumentPath(root, SET_ID);

	// Publish up to revision 3.
	for (const change of [{ op: "start", taskId: "t1" }, { op: "done", taskId: "t1", summary: "s" }] as const) {
		const loaded = await loadTaskDocument(path);
		assert.ok(loaded.kind === "loaded");
		const applied = applyTaskChanges(loaded.loaded.document.set, [change], {
			now: NOW,
			hasExistingSet: true,
		});
		assert.ok(applied.ok);
		const result = await commitTaskDocument({
			root,
			taskSetId: SET_ID,
			document: { set: applied.result.set, extras: [] },
			expectedDigest: loaded.loaded.digest,
			now: NOW,
		});
		assert.equal(result.kind, "committed");
	}
	const three = readFileSync(snapshotPath(root, SET_ID, 3), "utf8");

	// The user restores revision 2 over the live document — a backup, or a plain
	// `cp revisions/2.md tasks.md`. The old code called 3.md "not accepted"
	// because the live document was behind it, and renamed it aside.
	const two = readFileSync(snapshotPath(root, SET_ID, 2), "utf8");
	writeFileSync(path, two);
	const restored = await loadTaskDocument(path);
	assert.ok(restored.kind === "loaded");
	assert.equal(restored.loaded.document.set.revision, 2);

	const next = applyTaskChanges(
		restored.loaded.document.set,
		[{ op: "block", taskId: "t1", blocker: "waiting on the dump" }],
		{ now: NOW, hasExistingSet: true },
	);
	assert.ok(next.ok, next.ok ? "" : next.error);
	const published = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: next.result.set, extras: [] },
		expectedDigest: restored.loaded.digest,
		now: NOW,
	});

	// The new publication takes the next unused number, and revision 3 is exactly
	// where it was: same bytes, same name, still addressable.
	assert.equal(published.kind, "committed");
	assert.equal(published.kind === "committed" && published.revision, 4);
	assert.equal(readFileSync(snapshotPath(root, SET_ID, 3), "utf8"), three);
	assert.equal(readFileSync(snapshotPath(root, SET_ID, 2), "utf8"), two);
	assert.deepEqual(
		readdirSync(join(root, SET_ID, "revisions")).filter((name) => /^\d+\.md$/u.test(name)).sort(),
		["1.md", "2.md", "3.md", "4.md"],
	);
});

test("a number consumed by a publication that never landed is never handed out again", async (t) => {
	const root = scratchRoot(t);
	const first = await commitSeed(root);
	assert.ok(first.kind === "committed");
	const loaded = await loadTaskDocument(first.path);
	assert.ok(loaded.kind === "loaded");

	// A reservation for revision 2 whose bytes never reached the live document:
	// the crash-before-publication case. It consumed its number regardless.
	mkdirSync(join(root, SET_ID, "revisions"), { recursive: true });
	writeFileSync(
		join(root, SET_ID, "revisions", "pending-2-00000000-0000-4000-8000-000000000000.json"),
		`${JSON.stringify({ schemaVersion: 1, taskSetId: SET_ID, revision: 2, digest: "f".repeat(64), createdAt: NOW })}\n`,
	);
	assert.equal(await highestReservedRevision(root, SET_ID), 2);

	const next = applyTaskChanges(loaded.loaded.document.set, [{ op: "start", taskId: "t1" }], {
		now: NOW,
		hasExistingSet: true,
	});
	assert.ok(next.ok);
	const published = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: next.result.set, extras: [] },
		expectedDigest: loaded.loaded.digest,
		now: NOW,
	});
	assert.equal(published.kind, "committed");
	assert.equal(published.kind === "committed" && published.revision, 3, "2 was consumed, so 3 is next");
	assert.equal(existsSync(snapshotPath(root, SET_ID, 2)), false);
});

test("a malformed reservation still consumes its number", async (t) => {
	const root = scratchRoot(t);
	await commitSeed(root);
	// Unparseable beyond its number, which is all that matters for allocation.
	writeFileSync(join(root, SET_ID, "revisions", "pending-9-truncated"), "{");
	assert.equal(await highestReservedRevision(root, SET_ID), 9);

	const loaded = await loadTaskDocument(taskDocumentPath(root, SET_ID));
	assert.ok(loaded.kind === "loaded");
	const next = applyTaskChanges(loaded.loaded.document.set, [{ op: "start", taskId: "t1" }], {
		now: NOW,
		hasExistingSet: true,
	});
	assert.ok(next.ok);
	const published = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: next.result.set, extras: [] },
		expectedDigest: loaded.loaded.digest,
		now: NOW,
	});
	assert.equal(published.kind === "committed" && published.revision, 10);
});

test("an interrupted initial publication leaves its reservation and takes the next number", async (t) => {
	const root = scratchRoot(t);
	mkdirSync(join(root, SET_ID, "revisions"), { recursive: true });
	// A first attempt that reserved revision 1 and never published.
	writeFileSync(
		join(root, SET_ID, "revisions", "pending-1-00000000-0000-4000-8000-000000000000.md"),
		"# Tasks\n\nabandoned first attempt\n",
	);

	const result = await commitSeed(root);
	assert.equal(result.kind, "committed");
	assert.equal(result.kind === "committed" && result.revision, 2, "1 was consumed by the attempt");
	const live = await loadTaskDocument(taskDocumentPath(root, SET_ID));
	assert.equal(live.kind === "loaded" && live.loaded.document.set.revision, 2);
	assert.equal(existsSync(snapshotPath(root, SET_ID, 1)), false);
});

test("a legacy snapshot is preserved and reserved, but never claimed as published", async (t) => {
	const root = scratchRoot(t);
	const first = await commitSeed(root);
	assert.ok(first.kind === "committed");

	// What an older build left behind: a numbered snapshot with no preparation
	// record, so its provenance cannot be proven either way.
	const legacy = readFileSync(snapshotPath(root, SET_ID, 1), "utf8").replace(
		'"revision":1',
		'"revision":5',
	);
	writeFileSync(snapshotPath(root, SET_ID, 5), legacy);

	const candidate = await findRecoverySnapshot(root, SET_ID);
	assert.equal(candidate?.revision, 5);
	assert.equal(candidate?.certainty, "unverified", "no record, so no claim that it was published");
	assert.equal(await highestReservedRevision(root, SET_ID), 5);

	// Revision 1, which this build did publish, is reported as such.
	const one = await loadTaskDocument(snapshotPath(root, SET_ID, 1));
	assert.ok(one.kind === "loaded");
	assert.equal(await isPublishedRevision(root, SET_ID, 1, one.loaded.digest), true);
	// And the legacy file is untouched by any of this.
	assert.equal(readFileSync(snapshotPath(root, SET_ID, 5), "utf8"), legacy);
});

test("recovery steps over a corrupt newest snapshot to the newest valid one", async (t) => {
	const root = scratchRoot(t);
	await commitSeed(root);
	const path = taskDocumentPath(root, SET_ID);
	const loaded = await loadTaskDocument(path);
	assert.ok(loaded.kind === "loaded");
	const next = applyTaskChanges(loaded.loaded.document.set, [{ op: "start", taskId: "t1" }], {
		now: NOW,
		hasExistingSet: true,
	});
	assert.ok(next.ok);
	await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: next.result.set, extras: [] },
		expectedDigest: loaded.loaded.digest,
		now: NOW,
	});

	const corrupt = "# Tasks\n\ntruncated\n";
	writeFileSync(snapshotPath(root, SET_ID, 2), corrupt);
	const candidate = await findRecoverySnapshot(root, SET_ID);
	assert.equal(candidate?.revision, 1, "the newest that actually parses");
	// Stepped over, never repaired, never deleted, never renamed.
	assert.equal(readFileSync(snapshotPath(root, SET_ID, 2), "utf8"), corrupt);
});

test("a snapshot belonging to another set is not a recovery candidate", async (t) => {
	const root = scratchRoot(t);
	await commitSeed(root);
	const foreign = readFileSync(snapshotPath(root, SET_ID, 1), "utf8").replace(
		SET_ID,
		"00000000-0000-4000-8000-000000000009",
	);
	writeFileSync(snapshotPath(root, SET_ID, 7), foreign);
	const candidate = await findRecoverySnapshot(root, SET_ID);
	assert.equal(candidate?.revision, 1, "7 names another set, so it is skipped");
	assert.equal(readFileSync(snapshotPath(root, SET_ID, 7), "utf8"), foreign);
});

test("no valid candidate means recovery offers nothing rather than something broken", async (t) => {
	const root = scratchRoot(t);
	mkdirSync(join(root, SET_ID, "revisions"), { recursive: true });
	writeFileSync(snapshotPath(root, SET_ID, 1), "not a task document\n");
	assert.equal(await findRecoverySnapshot(root, SET_ID), undefined);
	assert.equal(readFileSync(snapshotPath(root, SET_ID, 1), "utf8"), "not a task document\n");
});

test("an export never replaces a destination that appears after the check", async (t) => {
	const root = scratchRoot(t);
	const destination = join(root, "exported.md");
	const squatter = "someone else's file\n";
	writeFileSync(destination, squatter);
	assert.equal(await publishExclusively(destination, "# Tasks\n"), false);
	assert.equal(readFileSync(destination, "utf8"), squatter, "its bytes are unchanged");

	const fresh = join(root, "fresh.md");
	assert.equal(await publishExclusively(fresh, "# Tasks\n"), true);
	assert.equal(readFileSync(fresh, "utf8"), "# Tasks\n");
	// No temp files left behind by either outcome.
	assert.deepEqual(
		readdirSync(root).filter((name) => name.startsWith(".tasks-export")),
		[],
	);
});

test("a commit cancelled while queued for the lock writes nothing", async (t) => {
	const root = scratchRoot(t);
	const first = await commitSeed(root);
	assert.ok(first.kind === "committed");
	const loaded = await loadTaskDocument(first.path);
	assert.ok(loaded.kind === "loaded");
	const next = applyTaskChanges(loaded.loaded.document.set, [{ op: "start", taskId: "t1" }], {
		now: NOW,
		hasExistingSet: true,
	});
	assert.ok(next.ok);

	const controller = new AbortController();
	controller.abort();
	const cancelled = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: next.result.set, extras: [] },
		expectedDigest: loaded.loaded.digest,
		now: NOW,
		signal: controller.signal,
	});
	assert.equal(cancelled.kind, "cancelled");
	assert.equal(readFileSync(first.path, "utf8"), loaded.loaded.raw);
	assert.equal(existsSync(snapshotPath(root, SET_ID, 2)), false);
});

test("a document whose metadata names another set is refused, and cannot be written into", async (t) => {
	const root = scratchRoot(t);
	const other = "00000000-0000-4000-8000-000000000002";
	await commitSeed(root);
	// The bytes of set A, placed in the directory of set B.
	mkdirSync(join(root, other), { recursive: true });
	writeFileSync(taskDocumentPath(root, other), readFileSync(taskDocumentPath(root, SET_ID), "utf8"));

	// Unqualified reads still parse it; a read that knows which set it asked for
	// refuses, because the next write would be derived from the metadata.
	assert.equal((await loadTaskDocument(taskDocumentPath(root, other))).kind, "loaded");
	const checked = await loadTaskDocument(taskDocumentPath(root, other), other);
	assert.equal(checked.kind, "invalid");
	assert.match(checked.kind === "invalid" ? checked.reason : "", /claims task set/u);

	// And a commit may not use a document that disagrees with the requested id.
	const refused = await commitTaskDocument({
		root,
		taskSetId: other,
		document: seedDocument(),
		expectedDigest: undefined,
		now: NOW,
	});
	assert.equal(refused.kind, "failed");
	assert.match(refused.kind === "failed" ? refused.reason : "", /refusing to write a document for/u);
});

test("task set ids that could escape the tasks directory are refused", () => {
	assert.equal(isSafeTaskSetId(SET_ID), true);
	for (const unsafe of ["..", "../escape", "a/b", "", ".hidden", "x".repeat(65)]) {
		assert.equal(isSafeTaskSetId(unsafe), false, unsafe);
	}
	assert.throws(() => taskDocumentPath("/tmp", "../escape"), /unsafe task set id/u);
});

test("the serialized document is what lands on disk", async (t) => {
	const root = scratchRoot(t);
	const result = await commitSeed(root);
	assert.ok(result.kind === "committed");
	const onDisk = readFileSync(result.path, "utf8");
	assert.equal(onDisk, result.raw);
	assert.equal(digestOf(onDisk), result.digest);
	const parsed = parseTaskDocument(onDisk);
	assert.ok(parsed.ok);
	assert.equal(serializeTaskDocument(parsed.document), onDisk);
});
