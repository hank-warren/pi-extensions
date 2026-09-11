/**
 * One commit, in its own process.
 *
 * The in-process queue in `store.ts` serialises two commits in the same Node
 * process before `proper-lockfile` is ever contended, which means a test that
 * races two promises proves the queue and nothing about the lock. This script
 * exists so a test can put real cooperating writers on opposite sides of a
 * process boundary, where the lock is the only thing keeping them apart.
 *
 * Invoked as: node --import tsx commit-worker.ts <root> <taskSetId> <label> [baseDigest]
 * Prints one JSON line describing what the commit did, and exits 0 either way —
 * a refused commit is a result, not a failure of the worker.
 *
 * `baseDigest` pins the revision the commit claims to be built on. Without it
 * the worker simply commits against whatever it read, which is what a real
 * session does; with it, two workers are guaranteed to be claiming the same
 * base whether or not their reads actually overlapped, so a test can assert one
 * winner and one stale loser without depending on process scheduling.
 *
 * The change is `add_task`, which is the one op that stays legal however many
 * times the store has already moved: a lifecycle op would start failing on its
 * own rules after the first round and hide whatever the lock was doing.
 */

import { applyTaskChanges } from "../../src/changes.js";
import { commitTaskDocument, loadTaskDocument, taskDocumentPath } from "../../src/store.js";

async function main(): Promise<void> {
	const [root, taskSetId, label, baseDigest] = process.argv.slice(2);
	if (!root || !taskSetId || !label) throw new Error("usage: <root> <taskSetId> <label>");

	const loaded = await loadTaskDocument(taskDocumentPath(root, taskSetId), taskSetId);
	if (loaded.kind !== "loaded") {
		process.stdout.write(`${JSON.stringify({ kind: "unreadable" })}\n`);
		return;
	}
	const applied = applyTaskChanges(
		loaded.loaded.document.set,
		[{ op: "add_task", phaseId: "p1", content: label }],
		{ now: new Date().toISOString(), hasExistingSet: true },
	);
	if (!applied.ok) {
		process.stdout.write(`${JSON.stringify({ kind: "rejected", reason: applied.error })}\n`);
		return;
	}
	const result = await commitTaskDocument({
		root,
		taskSetId,
		document: { set: applied.result.set, extras: loaded.loaded.document.extras },
		expectedDigest: baseDigest || loaded.loaded.digest,
		now: new Date().toISOString(),
	});
	process.stdout.write(
		`${JSON.stringify({
			kind: result.kind,
			label,
			...(result.kind === "committed" ? { revision: result.revision } : {}),
			...("reason" in result ? { reason: result.reason } : {}),
		})}\n`,
	);
}

await main();
