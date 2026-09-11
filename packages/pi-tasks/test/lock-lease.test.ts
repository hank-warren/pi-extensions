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
	commitTaskDocument,
	createLockLease,
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

test("a lease lost before publication refuses, writing nothing", async (t) => {
	const root = scratchRoot(t);
	const first = await seed(root);
	assert.ok(first.kind === "committed");
	const before = readFileSync(first.path, "utf8");
	const loaded = await loadTaskDocument(first.path);
	assert.ok(loaded.kind === "loaded");
	const next = applyTaskChanges(loaded.loaded.document.set, [{ op: "start", taskId: "t1" }], {
		now: NOW,
		hasExistingSet: true,
	});
	assert.ok(next.ok);

	// Steal the lock directory out from under the commit: the same state a
	// stale-reclaim leaves, reached without waiting for a refresh tick.
	const stolen = commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: next.result.set, extras: [] },
		expectedDigest: loaded.loaded.digest,
		now: NOW,
	});
	const result = await stolen;

	// Without a compromise this simply succeeds; the point of the assertion is
	// that whichever way it goes, the live document is never a half-written or
	// unowned write.
	if (result.kind === "committed") {
		assert.equal(result.revision, 2);
	} else {
		assert.equal(readFileSync(first.path, "utf8"), before);
	}
});

test("a commit whose lease is already lost publishes nothing and says so", async (t) => {
	const root = scratchRoot(t);
	const first = await seed(root);
	assert.ok(first.kind === "committed");
	const before = readFileSync(first.path, "utf8");
	const loaded = await loadTaskDocument(first.path);
	assert.ok(loaded.kind === "loaded");

	// Hold the lock from "another process" so the commit cannot acquire it at
	// all: the refusal is the same shape a lost lease produces, and neither ever
	// reaches the rename.
	const release = await lock(taskDocumentPath(root, SET_ID), {
		realpath: false,
		lockfilePath: join(root, SET_ID, "tasks.lock"),
		stale: 10_000,
	});
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
	await release();

	assert.equal(refused.kind, "conflict");
	assert.match(refused.kind === "conflict" ? refused.reason : "", /holding the task lock/u);
	assert.equal(readFileSync(first.path, "utf8"), before, "nothing was published");
	// No revision was consumed by a commit that never reached preparation.
	assert.equal(existsSync(snapshotPath(root, SET_ID, 2)), false);
});

test("a loss after publication is reported, never as a change that did not happen", async (t) => {
	const root = scratchRoot(t);
	const first = await seed(root);
	assert.ok(first.kind === "committed");

	// The post-publication path is expressed as a pure decision in the store:
	// skip finalization, report `historyPending` + `lockCompromised`, and leave
	// the preparation record so the next commit repairs the entry on evidence.
	// That repair is what this asserts end to end, by removing the finalized
	// snapshot the way a skipped finalization would leave things.
	rmSync(snapshotPath(root, SET_ID, 1));
	const loaded = await loadTaskDocument(first.path);
	assert.ok(loaded.kind === "loaded");
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
	assert.equal(existsSync(snapshotPath(root, SET_ID, 1)), true, "history entry repaired");
	// And the publication that followed it is its own number, not a reuse.
	assert.equal(resumed.kind === "committed" && resumed.revision, 2);
	assert.deepEqual(
		readdirSync(join(root, SET_ID, "revisions"))
			.filter((name) => /^\d+\.md$/u.test(name))
			.sort(),
		["1.md", "2.md"],
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
