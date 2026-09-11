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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("two concurrent writers on the same base produce one revision, not two", async (t) => {
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
			document: build("left"),
			expectedDigest: loaded.loaded.digest,
			now: NOW,
		}),
		commitTaskDocument({
			root,
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
