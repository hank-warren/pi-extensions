/**
 * The lock lease: what happens when this process stops owning the lock it is
 * holding.
 *
 * `proper-lockfile` refreshes on a timer and reports a lost lock through
 * `onCompromised`. Its default handler throws *from inside that timer*, which
 * is an `uncaughtException`, and Pi's interactive mode turns those into
 * `process.exit(1)` — so a session that merely stalls past the stale window
 * while a cooperating session reclaims the lock would take the user's editor
 * down with it. The first test below drives the real library into that callback
 * and proves the process survives it.
 *
 * Surviving is only half of it. A commit that keeps writing after its lease is
 * gone is the concurrency hazard the lock exists to prevent, so the rest of the
 * file pins the other half: nothing is published on a lease known lost, and a
 * loss noticed after publication is reported rather than dressed up as a change
 * that did not happen.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lock } from "proper-lockfile";
import { applyTaskChanges } from "../src/changes.js";
import { createTaskSet } from "../src/model.js";
import {
	type CommitPhase,
	commitTaskDocument,
	createLockLease,
	type LockLease,
	loadTaskDocument,
	snapshotPath,
	taskDocumentPath,
} from "../src/store.js";

const NOW = "2026-01-01T00:00:00.000Z";
const SET_ID = "00000000-0000-4000-8000-000000000001";

function scratchRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "pi-tasks-lease-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

async function seed(root: string) {
	const created = applyTaskChanges(
		createTaskSet(SET_ID, NOW),
		[{ op: "init", phases: [{ name: "Schema", tasks: ["add the column", "backfill"] }] }],
		{ now: NOW, hasExistingSet: false },
	);
	assert.ok(created.ok);
	const result = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: created.result.set, extras: [] },
		expectedDigest: undefined,
		now: NOW,
	});
	assert.equal(result.kind, "committed");
	return result;
}

test("the real library's compromise callback records the loss and does not kill the process", async (t) => {
	const root = scratchRoot(t);
	const target = join(root, "held.txt");
	const lockfilePath = join(root, "held.lock");
	const lease = createLockLease();

	// Any uncaught exception here would be the crash this handler exists to
	// prevent, so it is captured for the duration rather than left to the runner.
	const uncaught: unknown[] = [];
	const onUncaught = (error: unknown) => uncaught.push(error);
	const existing = process.listeners("uncaughtException");
	for (const listener of existing) process.off("uncaughtException", listener);
	process.on("uncaughtException", onUncaught);
	t.after(() => {
		process.off("uncaughtException", onUncaught);
		for (const listener of existing) process.on("uncaughtException", listener);
	});

	const release = await lock(target, {
		realpath: false,
		lockfilePath,
		// `stale/2` is the refresh interval and the library floors it at 1000 ms,
		// so this is the shortest tick obtainable: production uses 5 s.
		stale: 2_000,
		update: 1_000,
		onCompromised: lease.onCompromised,
	});
	assert.equal(lease.isLost(), false);

	// Exactly what a cooperating session's stale-reclaim does to this process.
	rmSync(lockfilePath, { recursive: true, force: true });
	for (let waited = 0; waited < 4_000 && !lease.isLost(); waited += 100) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	assert.equal(lease.isLost(), true, "the loss must be observable, not swallowed");
	assert.ok(lease.lostReason());
	assert.deepEqual(uncaught, [], "the default handler would have thrown from the refresh timer");
	await release().catch(() => undefined);
});

/**
 * A lease that loses itself at a named commit boundary.
 *
 * Keyed to *where the commit is*, not to how many times `isLost()` has been
 * read: a counting stub silently stops testing what it claims the moment a
 * check is added or removed, which is exactly the failure mode these tests
 * exist to catch.
 */
function leaseLostAt(phase: CommitPhase | "start"): LockLease {
	const lease = createLockLease();
	const lose = () => lease.onCompromised(new Error(`lock lost at ${phase}`));
	if (phase === "start") lose();
	return {
		...lease,
		observe(reached: CommitPhase) {
			if (reached === phase) lose();
		},
	};
}

async function nextRevisionOf(root: string) {
	const loaded = await loadTaskDocument(taskDocumentPath(root, SET_ID), SET_ID);
	assert.ok(loaded.kind === "loaded");
	const next = applyTaskChanges(loaded.loaded.document.set, [{ op: "start", taskId: "t1" }], {
		now: NOW,
		hasExistingSet: true,
	});
	assert.ok(next.ok);
	return { loaded: loaded.loaded, document: { set: next.result.set, extras: [] } };
}

test("a lease already lost when the commit starts publishes nothing", async (t) => {
	const root = scratchRoot(t);
	const first = await seed(root);
	assert.ok(first.kind === "committed");
	const before = readFileSync(first.path, "utf8");
	const { loaded, document } = await nextRevisionOf(root);

	const refused = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document,
		expectedDigest: loaded.digest,
		now: NOW,
		lease: leaseLostAt("start"),
	});

	assert.equal(refused.kind, "conflict");
	assert.match(
		refused.kind === "conflict" ? refused.reason : "",
		/lost before the change was published/u,
	);
	assert.equal(readFileSync(first.path, "utf8"), before, "the live document is untouched");
	assert.equal(existsSync(snapshotPath(root, SET_ID, 2)), false, "no accepted snapshot");
	// Refused before `prepareRevision`, so no number was consumed either.
	assert.deepEqual(
		readdirSync(join(root, SET_ID, "revisions")).filter((name) => name.startsWith("pending-2-")),
		[],
	);
});

test("a lease lost after validation, before preparation, publishes nothing", async (t) => {
	const root = scratchRoot(t);
	const first = await seed(root);
	assert.ok(first.kind === "committed");
	const before = readFileSync(first.path, "utf8");
	const { loaded, document } = await nextRevisionOf(root);

	const refused = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document,
		expectedDigest: loaded.digest,
		now: NOW,
		lease: leaseLostAt("validated"),
	});

	assert.equal(refused.kind, "conflict");
	assert.match(
		refused.kind === "conflict" ? refused.reason : "",
		/lost before the change was published/u,
	);
	assert.equal(readFileSync(first.path, "utf8"), before);
	assert.equal(existsSync(snapshotPath(root, SET_ID, 2)), false);
});

test("a lease lost after preparation but before the rename publishes nothing", async (t) => {
	const root = scratchRoot(t);
	const first = await seed(root);
	assert.ok(first.kind === "committed");
	const before = readFileSync(first.path, "utf8");
	const { loaded, document } = await nextRevisionOf(root);

	const refused = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document,
		expectedDigest: loaded.digest,
		now: NOW,
		lease: leaseLostAt("prepared"),
	});

	// The candidate bytes exist by now; the rename is what must not happen.
	assert.equal(refused.kind, "conflict");
	assert.match(
		refused.kind === "conflict" ? refused.reason : "",
		/lost before the change was published/u,
	);
	assert.equal(readFileSync(first.path, "utf8"), before, "the rename did not happen");
	assert.equal(existsSync(snapshotPath(root, SET_ID, 2)), false, "nothing became history");
	// The reservation stands, which is what reservations are for: the number is
	// consumed and the next publication goes above it rather than reusing it.
	assert.equal(
		readdirSync(join(root, SET_ID, "revisions")).filter((name) => name.startsWith("pending-2-"))
			.length > 0,
		true,
		"the reserved revision stays consumed",
	);
});

test("a lease lost after the rename reports a published change, not a failed one", async (t) => {
	const root = scratchRoot(t);
	const first = await seed(root);
	assert.ok(first.kind === "committed");
	const { loaded, document } = await nextRevisionOf(root);

	const published = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document,
		expectedDigest: loaded.digest,
		now: NOW,
		lease: leaseLostAt("published"),
	});

	// The rename happened, so the only honest answer is that it happened.
	assert.equal(published.kind, "committed");
	assert.equal(published.kind === "committed" && published.revision, 2);
	assert.match(
		published.kind === "committed" ? (published.historyPending ?? "") : "",
		/task lock was lost before its history entry could be written/u,
	);
	assert.match(
		published.kind === "committed" ? (published.lockCompromised ?? "") : "",
		/must not be retried/u,
	);

	// Finalization was skipped rather than run without a lease.
	const live = await loadTaskDocument(taskDocumentPath(root, SET_ID), SET_ID);
	assert.ok(live.kind === "loaded");
	assert.equal(live.loaded.document.set.revision, 2, "the live document is at the new revision");
	assert.equal(existsSync(snapshotPath(root, SET_ID, 2)), false, "no history entry was written");

	// And the next commit repairs that entry from the preparation record rather
	// than replaying the change: revision 2 is recorded, and 3 is a new number.
	const follow = await nextRevisionOf(root);
	const repaired = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: follow.document,
		expectedDigest: follow.loaded.digest,
		now: NOW,
	});
	assert.equal(repaired.kind, "committed");
	assert.equal(repaired.kind === "committed" && repaired.repairedRevision, 2);
	assert.equal(repaired.kind === "committed" && repaired.revision, 3);
	assert.equal(existsSync(snapshotPath(root, SET_ID, 2)), true);
	assert.deepEqual(
		readdirSync(join(root, SET_ID, "revisions"))
			.filter((name) => /^\d+\.md$/u.test(name))
			.sort(),
		["1.md", "2.md", "3.md"],
	);
});

test("the lease records the first loss and never un-loses itself", () => {
	const lease = createLockLease();
	assert.equal(lease.isLost(), false);
	assert.equal(lease.lostReason(), undefined);

	assert.doesNotThrow(() => lease.onCompromised(new Error("lock is compromised")));
	assert.equal(lease.isLost(), true);
	assert.match(String(lease.lostReason()), /lock is compromised/u);

	// A second report does not overwrite the first cause, and nothing flips back.
	lease.onCompromised(new Error("something later"));
	assert.match(String(lease.lostReason()), /lock is compromised/u);
	assert.equal(lease.isLost(), true);
});
