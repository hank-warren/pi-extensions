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
	latestSnapshot,
	loadTaskDocument,
	matchesOwnSnapshot,
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
	assert.equal(await matchesOwnSnapshot(root, SET_ID, 1, digestOf(snapshot)), true);
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
	assert.equal(await latestSnapshot(root, SET_ID).then((entry) => entry?.revision), 2);
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
	assert.equal(await latestSnapshot(root, SET_ID), undefined);
});

test("a document edited outside the package no longer matches its own snapshot", async (t) => {
	const root = scratchRoot(t);
	const first = await commitSeed(root);
	assert.ok(first.kind === "committed");
	const tampered = readFileSync(first.path, "utf8").replace("add the column", "add a column");
	writeFileSync(first.path, tampered);
	assert.equal(await matchesOwnSnapshot(root, SET_ID, 1, digestOf(tampered)), false);
	// The snapshot itself is untouched, which is what recovery offers back.
	const snapshot = parseTaskDocument(readFileSync(snapshotPath(root, SET_ID, 1), "utf8"));
	assert.ok(snapshot.ok);
	assert.equal(snapshot.document.set.phases[0]?.tasks[0]?.content, "add the column");
});

test("an interrupted publication resumes instead of wedging the set forever", async (t) => {
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

	// Fault injection: the snapshot for revision 2 lands and the process dies
	// before the live document is renamed into place. This is exactly the window
	// the snapshot-first order opens.
	const interrupted = serializeTaskDocument({
		set: { ...next.result.set, revision: 2, updatedAt: NOW },
		extras: [],
	});
	writeFileSync(snapshotPath(root, SET_ID, 2), interrupted);
	assert.equal((await loadTaskDocument(first.path)).kind === "loaded", true);
	assert.equal(
		(await loadTaskDocument(first.path)).kind === "loaded" &&
			((await loadTaskDocument(first.path)) as { loaded: { document: { set: { revision: number } } } })
				.loaded.document.set.revision,
		1,
	);

	// Retrying the identical write resumes: the prepared bytes are the bytes this
	// call is publishing, so it finishes the transaction rather than refusing.
	const resumed = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: next.result.set, extras: [] },
		expectedDigest: loaded.loaded.digest,
		now: NOW,
	});
	assert.equal(resumed.kind, "committed");
	assert.equal(resumed.kind === "committed" && resumed.revision, 2);
	assert.equal(resumed.kind === "committed" && resumed.retainedOrphanSnapshot, undefined);
	assert.equal(readFileSync(first.path, "utf8"), interrupted);

	// And the set keeps moving afterwards.
	const after = await loadTaskDocument(first.path);
	assert.ok(after.kind === "loaded");
	const third = applyTaskChanges(after.loaded.document.set, [{ op: "done", taskId: "t1", summary: "s" }], {
		now: NOW,
		hasExistingSet: true,
	});
	assert.ok(third.ok);
	const forward = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: third.result.set, extras: [] },
		expectedDigest: after.loaded.digest,
		now: NOW,
	});
	assert.equal(forward.kind === "committed" && forward.revision, 3);
});

test("a different interrupted snapshot is retained aside, never overwritten or accepted", async (t) => {
	const root = scratchRoot(t);
	const first = await commitSeed(root);
	assert.ok(first.kind === "committed");
	const loaded = await loadTaskDocument(first.path);
	assert.ok(loaded.kind === "loaded");

	// A prepared snapshot for revision 2 whose content is *not* what the next
	// write publishes: an abandoned transaction from some other batch.
	const abandoned = "# Tasks\n\nabandoned transaction bytes\n";
	writeFileSync(snapshotPath(root, SET_ID, 2), abandoned);

	const next = applyTaskChanges(loaded.loaded.document.set, [{ op: "start", taskId: "t1" }], {
		now: NOW,
		hasExistingSet: true,
	});
	assert.ok(next.ok);
	const result = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: next.result.set, extras: [] },
		expectedDigest: loaded.loaded.digest,
		now: NOW,
	});
	assert.equal(result.kind, "committed");
	assert.ok(result.kind === "committed" && result.retainedOrphanSnapshot);

	// The abandoned bytes are kept, under a name that can never be mistaken for
	// accepted history, and the accepted snapshot is the one just published.
	const orphanPath = result.kind === "committed" ? String(result.retainedOrphanSnapshot) : "";
	assert.match(orphanPath, /revisions\/orphan-2\./u);
	assert.equal(readFileSync(orphanPath, "utf8"), abandoned);
	assert.equal(readFileSync(snapshotPath(root, SET_ID, 2), "utf8"), readFileSync(first.path, "utf8"));
	// `latestSnapshot` never offers an orphan as recovered history.
	assert.deepEqual(await latestSnapshot(root, SET_ID), {
		revision: 2,
		path: snapshotPath(root, SET_ID, 2),
	});
});

test("an interrupted initial creation is resumable too", async (t) => {
	const root = scratchRoot(t);
	mkdirSync(join(root, SET_ID, "revisions"), { recursive: true });
	writeFileSync(snapshotPath(root, SET_ID, 1), "# Tasks\n\nabandoned first attempt\n");

	const result = await commitSeed(root);
	assert.equal(result.kind, "committed");
	assert.ok(result.kind === "committed" && result.retainedOrphanSnapshot);
	const live = await loadTaskDocument(taskDocumentPath(root, SET_ID));
	assert.equal(live.kind === "loaded" && live.loaded.document.set.revision, 1);
});

test("a snapshot that is already accepted history is never disturbed", async (t) => {
	const root = scratchRoot(t);
	const first = await commitSeed(root);
	assert.ok(first.kind === "committed");
	const accepted = readFileSync(snapshotPath(root, SET_ID, 1), "utf8");

	// A caller that tries to re-publish revision 1 over accepted history: the
	// live document is already at 1, so this is not an orphan and is refused.
	const seeded = seedDocument();
	const refused = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: { ...seeded.set, revision: 0 }, extras: [] },
		expectedDigest: digestOf(accepted),
		now: NOW,
	});
	assert.equal(refused.kind, "conflict");
	assert.match(refused.kind === "conflict" ? refused.reason : "", /already accepted history/u);
	assert.equal(readFileSync(snapshotPath(root, SET_ID, 1), "utf8"), accepted);
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
