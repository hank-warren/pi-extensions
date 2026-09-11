/**
 * Cooperating writers on opposite sides of a process boundary.
 *
 * Every other concurrency test in this package runs in one Node process, where
 * `serializePath` orders the two commits before `proper-lockfile` is ever
 * contended — so those tests pin the in-process queue and say nothing about the
 * cross-process lock. This file is the one that exercises the lock itself: two
 * real `node` processes, one temporary store, the same base digest.
 *
 * What must hold is not "the lock is fast" but "the lock is correct": exactly
 * one writer publishes, the other is refused rather than silently overwriting,
 * the published revision is a whole document from one of them and never a blend
 * of both, and the history on disk matches what was published.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { applyTaskChanges } from "../src/changes.js";
import { parseTaskDocument } from "../src/markdown.js";
import { createTaskSet } from "../src/model.js";
import { commitTaskDocument, snapshotPath, taskDocumentPath } from "../src/store.js";

const run = promisify(execFile);

const SET_ID = "00000000-0000-4000-8000-000000000001";
const WORKER = join(import.meta.dirname, "support", "commit-worker.ts");
/** `--import tsx` resolves from cwd, so the workers run from the repo root. */
const REPO_ROOT = resolve(dirname(import.meta.dirname), "..", "..");

interface WorkerResult {
	kind: string;
	label?: string;
	revision?: number;
	reason?: string;
}

/** Only finalized snapshots; preparation records share the directory. */
function snapshotNames(root: string): string[] {
	return readdirSync(join(root, SET_ID, "revisions"))
		.filter((name) => /^\d+\.md$/u.test(name))
		.sort();
}

async function commitInChildProcess(
	root: string,
	label: string,
	baseDigest?: string,
): Promise<WorkerResult> {
	const { stdout } = await run(
		process.execPath,
		["--import", "tsx", WORKER, root, SET_ID, label, ...(baseDigest ? [baseDigest] : [])],
		{ cwd: REPO_ROOT, env: { ...process.env, NODE_NO_WARNINGS: "1" } },
	);
	const line = stdout.trim().split("\n").at(-1) ?? "{}";
	return JSON.parse(line) as WorkerResult;
}

/** Seeds revision 1 and returns its digest, which is the shared base. */
async function seedStore(root: string): Promise<string> {
	const now = "2026-01-01T00:00:00.000Z";
	const created = applyTaskChanges(
		createTaskSet(SET_ID, now),
		[{ op: "init", phases: [{ name: "Schema", tasks: ["add the column", "backfill"] }] }],
		{ now, hasExistingSet: false },
	);
	assert.ok(created.ok);
	const result = await commitTaskDocument({
		root,
		taskSetId: SET_ID,
		document: { set: created.result.set, extras: [] },
		expectedDigest: undefined,
		now,
	});
	assert.equal(result.kind, "committed");
	return result.kind === "committed" ? result.digest : "";
}

test("two cooperating writers in separate processes: one publishes, one is refused", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-tasks-multiproc-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const base = await seedStore(root);

	// Both claim revision 1 as their base. Spawning a process costs enough that
	// the two can fail to overlap on a loaded machine; pinning the base makes the
	// outcome depend on the lock and the digest check rather than on scheduling,
	// which is the contract under test.
	const [left, right] = await Promise.all([
		commitInChildProcess(root, "added by the left process", base),
		commitInChildProcess(root, "added by the right process", base),
	]);

	const outcomes = [left.kind, right.kind].sort();
	assert.deepEqual(
		outcomes,
		["committed", "conflict"],
		`expected one winner and one stale loser, got ${JSON.stringify([left, right])}`,
	);
	const winner = left.kind === "committed" ? left : right;
	assert.equal(winner.revision, 2);

	// The loser lost cleanly: it was told the document moved, not that it wrote.
	const loser = left.kind === "committed" ? right : left;
	assert.match(String(loser.reason), /changed since it was read|already accepted history/u);

	// The published document is one writer's work in full, never a blend: the
	// winner's task is there, the loser's is not, and exactly one id was handed
	// out even though both processes computed one.
	const live = parseTaskDocument(readFileSync(taskDocumentPath(root, SET_ID), "utf8"));
	assert.ok(live.ok);
	assert.equal(live.document.set.revision, 2);
	const contents = live.document.set.phases.flatMap((phase) =>
		phase.tasks.map((task) => task.content),
	);
	assert.equal(contents.includes(String(winner.label)), true);
	assert.equal(contents.includes(String(loser.label)), false);
	assert.equal(live.document.set.nextTaskId, 4);

	// History matches: revision 2 exists, revision 3 does not, and the snapshot
	// is byte-identical to what is live.
	assert.equal(
		readFileSync(snapshotPath(root, SET_ID, 2), "utf8"),
		readFileSync(taskDocumentPath(root, SET_ID), "utf8"),
	);
	assert.deepEqual(
		snapshotNames(root),
		["1.md", "2.md"],
		"the refused writer must not leave a snapshot behind",
	);
});

test("across repeated cross-process races, no acknowledged commit is ever lost", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-tasks-multiproc-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	await seedStore(root);

	// No pinned base here: each worker commits against whatever it read, exactly
	// as a real session does.
	// How many of each round's two racers win is a timing question, and asserting
	// on it would make this test flaky rather than strict: when the second
	// process happens to read *after* the first one published, both legitimately
	// succeed. The invariant that does not depend on timing is the one that
	// matters — a commit that was acknowledged is on disk, exactly once, and the
	// revisions it produced form an unbroken sequence with no reuse.
	const committed: WorkerResult[] = [];
	for (let round = 0; round < 3; round += 1) {
		const results = await Promise.all([
			commitInChildProcess(root, `round ${round} left`),
			commitInChildProcess(root, `round ${round} right`),
		]);
		for (const result of results) {
			assert.match(
				result.kind,
				/^(committed|conflict)$/u,
				`round ${round}: ${JSON.stringify(results)}`,
			);
			if (result.kind === "committed") committed.push(result);
		}
		assert.ok(
			results.some((result) => result.kind === "committed"),
			`round ${round} made no progress: ${JSON.stringify(results)}`,
		);
	}

	const revisions = committed.map((result) => Number(result.revision)).sort((a, b) => a - b);
	assert.deepEqual(
		revisions,
		revisions.map((_value, index) => index + 2),
		"acknowledged revisions must be unbroken and never reused",
	);

	const live = parseTaskDocument(readFileSync(taskDocumentPath(root, SET_ID), "utf8"));
	assert.ok(live.ok);
	assert.equal(live.document.set.revision, revisions.at(-1));

	// Every acknowledged writer's task survived, each with its own id.
	const tasks = live.document.set.phases.flatMap((phase) => phase.tasks);
	for (const result of committed) {
		assert.equal(
			tasks.some((task) => task.content === result.label),
			true,
			`a commit acknowledged as revision ${result.revision} is missing from the document`,
		);
	}
	assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
	assert.deepEqual(snapshotNames(root), revisions.map((revision) => `${revision}.md`).concat("1.md").sort());
});
