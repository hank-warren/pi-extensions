/**
 * The durable half of plan revisions: what is on disk after each step, and what
 * is refused.
 *
 * The cases that matter are the ones a comment cannot settle. A publication
 * interrupted between replacing the plan file and recording its history is
 * recoverable only on evidence, so both directions are driven here: with the
 * preparation record, recovery completes it; without one, the bytes are a
 * conflict and nothing is adopted. Likewise a number consumed by a publication
 * that never landed must never be handed out again, and a lease lost mid-write
 * must stop the write rather than kill the process.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_PLAN_BYTES, readPlanFile, writePlanFile } from "../src/plan-file.js";
import {
	adoptLiveDocument,
	createLockLease,
	digestOf,
	highestReservedRevision,
	initializePlanManifest,
	isSafeManagedId,
	listPendingPlanProposals,
	listPlanProposals,
	type LockLease,
	newManagedId,
	normalizePlanText,
	type PlanProposal,
	planManifestPath,
	planProposalPath,
	planSnapshotPath,
	publishPlanRevision,
	readPlanManifest,
	readPlanProposal,
	readPlanSnapshot,
	recoverPlanRevisions,
	resolvePlanProposal,
	writePlanProposal,
} from "../src/revision-store.js";

const PLAN_ID = "00000000-0000-4000-8000-0000000000aa";
const OTHER_PLAN_ID = "00000000-0000-4000-8000-0000000000bb";
const NOW = "2026-01-01T00:00:00.000Z";

interface Fixture {
	root: string;
	planPath: string;
	cleanup(): Promise<void>;
}

async function fixture(plan = "# Plan v1"): Promise<Fixture> {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-store-"));
	const root = join(directory, "revisions");
	const planPath = join(directory, "plan.md");
	await writePlanFile(planPath, plan);
	return {
		root,
		planPath,
		cleanup: () => rm(directory, { recursive: true, force: true }),
	};
}

/**
 * Initialize from the bytes the file actually holds, which is what
 * `ensureIdentity` does in production (`readPlanFile` then initialize).
 *
 * Passing the caller's own idea of the plan text instead is the mistake the
 * exact-byte rule exists to prevent: the manifest would describe something the
 * file does not contain and every later read would call it unaccounted.
 */
async function initialized(plan = "# Plan v1") {
	const base = await fixture(plan);
	const onDisk = await readPlanFile(base.planPath);
	assert.ok(onDisk, "the fixture must have written a plan");
	const result = await initializePlanManifest({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		plan: onDisk,
		now: NOW,
		changeSummary: "the plan was approved for implementation",
	});
	assert.equal(result.kind, "initialized");
	return base;
}

test("ids are uuids and nothing else is accepted as one", () => {
	assert.ok(isSafeManagedId(newManagedId()));
	for (const bad of ["", "..", "a/b", "../escape", "0000000000000000000000000000000000000"]) {
		assert.equal(isSafeManagedId(bad), false, bad);
	}
	assert.throws(() => planSnapshotPath("/tmp", "../escape", 1), /unsafe plan id/u);
	assert.throws(() => planSnapshotPath("/tmp", PLAN_ID, 0), /unsafe plan revision/u);
	assert.throws(() => planProposalPath("/tmp", PLAN_ID, "nope"), /unsafe proposal id/u);
});

test("a digest describes the bytes the plan file actually holds", async (t) => {
	const base = await fixture("# Plan v1");
	t.after(base.cleanup);
	// `writePlanFile` appends the newline, so a digest over anything else would
	// never match the file it claims to describe.
	assert.equal(normalizePlanText("# Plan v1"), "# Plan v1\n");
	assert.equal(digestOf((await readPlanFile(base.planPath)) ?? ""), digestOf("# Plan v1\n"));
});

test("initialization records the live bytes as revision 1 and is idempotent", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);

	const loaded = await readPlanManifest(base.root, PLAN_ID);
	assert.equal(loaded.kind, "loaded");
	if (loaded.kind !== "loaded") return;
	assert.equal(loaded.manifest.specRevision, 1);
	assert.equal(loaded.manifest.currentDigest, digestOf("# Plan v1\n"));
	assert.equal(loaded.manifest.planPath, base.planPath);
	assert.deepEqual(
		loaded.manifest.history.map((record) => record.revision),
		[1],
	);
	assert.equal(await readPlanSnapshot(base.root, PLAN_ID, 1), "# Plan v1\n");
	// The plan file itself is untouched by gaining a history.
	assert.equal(await readPlanFile(base.planPath), "# Plan v1\n");

	const again = await initializePlanManifest({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		plan: "# Plan v1\n",
		now: NOW,
		changeSummary: "second call",
	});
	assert.equal(again.kind, "exists");
	if (again.kind !== "exists") return;
	assert.equal(again.manifest.history.length, 1, "a second initialization adds no history");
});

test("a manifest is refused unless it is this plan's, at a known version", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	const path = planManifestPath(base.root, PLAN_ID);
	const original = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

	await writeFile(path, JSON.stringify({ ...original, schemaVersion: 99 }));
	assert.equal((await readPlanManifest(base.root, PLAN_ID)).kind, "invalid");

	await writeFile(path, JSON.stringify({ ...original, planId: OTHER_PLAN_ID }));
	assert.equal((await readPlanManifest(base.root, PLAN_ID)).kind, "invalid");

	await writeFile(path, "{not json");
	assert.equal((await readPlanManifest(base.root, PLAN_ID)).kind, "invalid");

	assert.equal((await readPlanManifest(base.root, OTHER_PLAN_ID)).kind, "missing");
	assert.equal((await readPlanManifest(base.root, "../escape")).kind, "invalid");
});

test("publishing replaces the plan file and leaves every earlier snapshot intact", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);

	const result = await publishPlanRevision({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		baseRevision: 1,
		baseDigest: digestOf("# Plan v1\n"),
		plan: "# Plan v2",
		now: NOW,
		changeSummary: "rolling restart instead of blue/green",
		instructions: "change the deployment approach",
	});
	assert.equal(result.kind, "published");
	if (result.kind !== "published") return;
	assert.equal(result.revision, 2);
	assert.equal(result.historyPending, undefined);
	assert.equal(await readPlanFile(base.planPath), "# Plan v2\n");
	assert.equal(await readPlanSnapshot(base.root, PLAN_ID, 1), "# Plan v1\n");
	assert.equal(await readPlanSnapshot(base.root, PLAN_ID, 2), "# Plan v2\n");

	const loaded = await readPlanManifest(base.root, PLAN_ID);
	assert.equal(loaded.kind, "loaded");
	if (loaded.kind !== "loaded") return;
	assert.equal(loaded.manifest.specRevision, 2);
	assert.equal(loaded.manifest.currentDigest, result.digest);
	const record = loaded.manifest.history.at(-1);
	assert.equal(record?.baseRevision, 1);
	assert.equal(record?.instructions, "change the deployment approach");
	assert.equal(record?.replacedExternalDigest, undefined);
});

test("a base that moved under the revision is a conflict, and nothing is written", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	await writePlanFile(base.planPath, "# Edited by hand");

	const result = await publishPlanRevision({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		baseRevision: 1,
		baseDigest: digestOf("# Plan v1\n"),
		plan: "# Plan v2",
		now: NOW,
		changeSummary: "x",
	});
	assert.equal(result.kind, "conflict");
	if (result.kind !== "conflict") return;
	assert.match(result.reason, /changed after the revision was computed/u);
	assert.equal(await readPlanFile(base.planPath), "# Edited by hand\n");
	assert.equal(await readPlanSnapshot(base.root, PLAN_ID, 2), undefined);
});

test("a revision identical to the plan on disk publishes nothing", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	const result = await publishPlanRevision({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		baseRevision: 1,
		baseDigest: digestOf("# Plan v1\n"),
		plan: "# Plan v1",
		now: NOW,
		changeSummary: "x",
	});
	assert.equal(result.kind, "conflict");
	if (result.kind !== "conflict") return;
	// Not "byte-identical": the comparison normalizes line endings and the trailing
	// newline away, so claiming byte-identity would claim a check nobody ran.
	assert.match(result.reason, /already what the plan file holds/u);
	assert.ok(!/byte-identical/u.test(result.reason));
});

test("publishing over bytes the manifest cannot explain keeps them", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	await writePlanFile(base.planPath, "# Edited by hand");
	const handEdited = digestOf("# Edited by hand\n");

	// The caller computed the revision against the file as it actually is, which
	// is what reconciling a hand-edit means. The displaced bytes are preserved.
	const result = await publishPlanRevision({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		baseRevision: 1,
		baseDigest: handEdited,
		plan: "# Reconciled",
		now: NOW,
		changeSummary: "fold the hand-edit in",
	});
	assert.equal(result.kind, "published");
	if (result.kind !== "published") return;
	assert.equal(result.replacedExternalDigest, handEdited);
	assert.equal(
		await readFile(join(base.root, PLAN_ID, "external", `${handEdited}.md`), "utf8"),
		"# Edited by hand\n",
	);
	const loaded = await readPlanManifest(base.root, PLAN_ID);
	assert.equal(loaded.kind, "loaded");
	if (loaded.kind !== "loaded") return;
	assert.equal(loaded.manifest.history.at(-1)?.replacedExternalDigest, handEdited);
});

test("a plan bigger than the ceiling is refused rather than truncated", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	const huge = "#".repeat(MAX_PLAN_BYTES + 10);
	const result = await publishPlanRevision({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		baseRevision: 1,
		baseDigest: digestOf("# Plan v1\n"),
		plan: huge,
		now: NOW,
		changeSummary: "x",
	});
	assert.equal(result.kind, "failed");
	if (result.kind !== "failed") return;
	assert.match(result.reason, /exceeds/u);
	assert.equal(await readPlanFile(base.planPath), "# Plan v1\n");
});

test("an interrupted publication is completed from its preparation record", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	// Exactly what a crash between steps 2 and 3 leaves: the plan file holds the
	// new bytes, a preparation record names them for revision 2 over revision 1's
	// digest, and the manifest still says revision 1.
	const directory = join(base.root, PLAN_ID, "revisions");
	await writeFile(
		join(directory, "pending-2-token.json"),
		JSON.stringify({
			schemaVersion: 1,
			planId: PLAN_ID,
			revision: 2,
			digest: digestOf("# Plan v2\n"),
			baseDigest: digestOf("# Plan v1\n"),
			createdAt: NOW,
		}),
	);
	await writeFile(join(directory, "pending-2-token.md"), "# Plan v2\n");
	await writePlanFile(base.planPath, "# Plan v2");

	const recovered = await recoverPlanRevisions({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		now: NOW,
	});
	assert.equal(recovered.kind, "recovered");
	if (recovered.kind !== "recovered") return;
	assert.equal(recovered.revision, 2);
	assert.equal(recovered.manifest.specRevision, 2);
	assert.equal(await readPlanSnapshot(base.root, PLAN_ID, 2), "# Plan v2\n");
	// Idempotent: the second pass has nothing left to do.
	const again = await recoverPlanRevisions({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		now: NOW,
	});
	assert.equal(again.kind, "ok");
});

test("a rolled-back plan that reappears externally is a conflict, not a recovery", async (t) => {
	// The reachable sequence, no crash involved. Preparation records are never
	// deleted — they are what keeps a revision number consumed — so a record of a
	// *finished* revision outlives it. Publish D1 -> D2, roll back D2 -> D1, and
	// revision 2's record still describes D2 over D1. With only the digest and base
	// compared, any later reappearance of D2 would be reported as "revision 2 was
	// published before its history could be recorded", write the manifest backwards
	// to 2, and append a duplicate history entry — losing the one conflict signal
	// the layer is built on.
	const base = await initialized();
	t.after(base.cleanup);
	const d1 = digestOf("# Plan v1\n");
	const forward = await publishPlanRevision({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		baseRevision: 1,
		baseDigest: d1,
		plan: "# Plan v2",
		now: NOW,
		changeSummary: "go to v2",
	});
	assert.equal(forward.kind, "published");
	if (forward.kind !== "published") return;
	const rollback = await publishPlanRevision({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		baseRevision: 2,
		baseDigest: forward.digest,
		plan: "# Plan v1",
		now: NOW,
		changeSummary: "roll back to v1",
	});
	assert.equal(rollback.kind, "published");
	if (rollback.kind !== "published") return;
	assert.equal(rollback.revision, 3);
	assert.equal(rollback.digest, d1);

	// Anything outside Plan mode puts D2 back: a hand-edit, an editor undo, a copy
	// of revisions/2.md.
	await writePlanFile(base.planPath, "# Plan v2");
	const recovered = await recoverPlanRevisions({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		now: NOW,
	});
	assert.equal(recovered.kind, "conflict", "a finished revision is not evidence of an unfinished one");
	if (recovered.kind !== "conflict") return;
	assert.match(recovered.reason, /changed outside Plan mode/u);
	assert.equal(recovered.liveDigest, forward.digest);

	// The manifest did not move backwards and grew no duplicate entry.
	const manifest = await readPlanManifest(base.root, PLAN_ID);
	assert.equal(manifest.kind, "loaded");
	if (manifest.kind !== "loaded") return;
	assert.equal(manifest.manifest.specRevision, 3);
	assert.equal(manifest.manifest.currentDigest, d1);
	assert.deepEqual(
		manifest.manifest.history.map((record) => record.revision),
		[1, 2, 3],
	);
});

test("a genuinely unfinished newer publication still recovers after a rollback", async (t) => {
	// The other direction of the same predicate: monotonic must not mean inert. A
	// record *above* the recorded revision, whose bytes are live over the recorded
	// base, is a real interrupted publication and is still completed.
	const base = await initialized();
	t.after(base.cleanup);
	const d1 = digestOf("# Plan v1\n");
	const forward = await publishPlanRevision({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		baseRevision: 1,
		baseDigest: d1,
		plan: "# Plan v2",
		now: NOW,
		changeSummary: "go to v2",
	});
	assert.equal(forward.kind, "published");
	if (forward.kind !== "published") return;
	// A third publication that dies between replacing the file and recording it.
	const directory = join(base.root, PLAN_ID, "revisions");
	await writeFile(
		join(directory, "pending-9-token.json"),
		JSON.stringify({
			schemaVersion: 1,
			planId: PLAN_ID,
			revision: 9,
			digest: digestOf("# Plan v3\n"),
			baseDigest: forward.digest,
			createdAt: NOW,
		}),
	);
	await writeFile(join(directory, "pending-9-token.md"), "# Plan v3\n");
	await writePlanFile(base.planPath, "# Plan v3");

	const recovered = await recoverPlanRevisions({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		now: NOW,
	});
	assert.equal(recovered.kind, "recovered");
	if (recovered.kind !== "recovered") return;
	assert.equal(recovered.revision, 9);
	assert.equal(recovered.manifest.specRevision, 9);
	assert.equal(await readPlanSnapshot(base.root, PLAN_ID, 9), "# Plan v3\n");
});

test("an existing file without a trailing newline is accounted for as it is", async (t) => {
	// A plan written by an editor that leaves off the final newline. Normalizing it
	// into the digest would describe bytes the file does not contain, so the file
	// would read as "changed outside Plan mode" on every turn from the moment it
	// gained an identity, and its own first revision would be filed under external/.
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-store-raw-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const root = join(directory, "revisions");
	const planPath = join(directory, "plan.md");
	for (const raw of ["# Legacy plan, no newline", "# CRLF plan\r\n\r\nstep one\r\n"]) {
		await rm(root, { recursive: true, force: true });
		await writeFile(planPath, raw, "utf8");
		const onDisk = await readPlanFile(planPath);
		assert.equal(onDisk, raw, "the fixture writes the bytes verbatim");
		const initializedRaw = await initializePlanManifest({
			root,
			planId: PLAN_ID,
			planPath,
			plan: raw,
			now: NOW,
			changeSummary: "the user confirmed the plan file as approved",
		});
		assert.equal(initializedRaw.kind, "initialized", raw);
		if (initializedRaw.kind !== "initialized") return;
		assert.equal(initializedRaw.manifest.currentDigest, digestOf(raw), raw);
		assert.equal(await readPlanSnapshot(root, PLAN_ID, 1), raw, raw);
		// The decisive assertion: recovery accounts for the file, so nothing reports a
		// change nobody made and no external/ copy is taken.
		const recovery = await recoverPlanRevisions({ root, planId: PLAN_ID, planPath, now: NOW });
		assert.equal(recovery.kind, "ok", `${raw} -> ${recovery.kind}`);
		assert.equal(await readdir(join(root, PLAN_ID)).then((names) => names.includes("external")), false);
	}
});

test("bytes no record explains are a conflict, never adopted as a revision", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	await writePlanFile(base.planPath, "# Who wrote this");

	const result = await recoverPlanRevisions({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		now: NOW,
	});
	assert.equal(result.kind, "conflict");
	if (result.kind !== "conflict") return;
	assert.match(result.reason, /changed outside Plan mode/u);
	assert.equal(result.manifest.specRevision, 1, "the recorded revision is unchanged");
	assert.equal(result.liveDigest, digestOf("# Who wrote this\n"));
	// Nothing was written: no snapshot 2, and the manifest still says 1.
	assert.equal(await readPlanSnapshot(base.root, PLAN_ID, 2), undefined);
});

test("a reservation whose bytes never landed is left alone and keeps its number", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	const directory = join(base.root, PLAN_ID, "revisions");
	await writeFile(
		join(directory, "pending-2-token.json"),
		JSON.stringify({
			schemaVersion: 1,
			planId: PLAN_ID,
			revision: 2,
			digest: digestOf("# Never published\n"),
			baseDigest: digestOf("# Plan v1\n"),
			createdAt: NOW,
		}),
	);
	await writeFile(join(directory, "pending-2-token.md"), "# Never published\n");

	// The plan file still matches the manifest, so nothing happened and nothing
	// needs recovering.
	const recovery = await recoverPlanRevisions({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		now: NOW,
	});
	assert.equal(recovery.kind, "ok");
	assert.equal(await highestReservedRevision(base.root, PLAN_ID), 2);

	// The next real publication takes 3: reusing 2 would put two contents on one
	// revision number.
	const published = await publishPlanRevision({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		baseRevision: 1,
		baseDigest: digestOf("# Plan v1\n"),
		plan: "# Plan v3",
		now: NOW,
		changeSummary: "x",
	});
	assert.equal(published.kind, "published");
	if (published.kind !== "published") return;
	assert.equal(published.revision, 3);
	assert.equal(await readPlanSnapshot(base.root, PLAN_ID, 2), undefined);
});

test("a missing plan file makes recovery unreadable rather than silently fine", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	await rm(base.planPath);
	const result = await recoverPlanRevisions({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		now: NOW,
	});
	assert.equal(result.kind, "unreadable");
	const unmanaged = await recoverPlanRevisions({
		root: base.root,
		planId: OTHER_PLAN_ID,
		planPath: base.planPath,
		now: NOW,
	});
	assert.equal(unmanaged.kind, "unmanaged");
});

test("adopting the live document records it without rewriting it", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	await writePlanFile(base.planPath, "# Confirmed by hand");

	const adopted = await adoptLiveDocument({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		now: NOW,
		changeSummary: "the user confirmed the plan file as approved",
	});
	assert.equal(adopted.kind, "adopted");
	if (adopted.kind !== "adopted") return;
	assert.equal(adopted.revision, 2);
	assert.equal(adopted.digest, digestOf("# Confirmed by hand\n"));
	assert.equal(await readPlanFile(base.planPath), "# Confirmed by hand\n");
	assert.equal(await readPlanSnapshot(base.root, PLAN_ID, 2), "# Confirmed by hand\n");

	const again = await adoptLiveDocument({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		now: NOW,
		changeSummary: "x",
	});
	assert.equal(again.kind, "unchanged");
});

test("two cooperating writers on one plan: one publishes, the other is refused", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	const request = (plan: string) =>
		publishPlanRevision({
			root: base.root,
			planId: PLAN_ID,
			planPath: base.planPath,
			baseRevision: 1,
			baseDigest: digestOf("# Plan v1\n"),
			plan,
			now: NOW,
			changeSummary: plan,
		});
	const [left, right] = await Promise.all([request("# From session A"), request("# From session B")]);
	const kinds = [left.kind, right.kind].sort();
	assert.deepEqual(kinds, ["conflict", "published"], `${left.kind} / ${right.kind}`);
	const winner = left.kind === "published" ? left : right;
	if (winner.kind !== "published") return;
	assert.equal(winner.revision, 2);
	// Exactly one set of bytes won, and it is the one on disk.
	assert.equal(await readPlanFile(base.planPath), await readPlanSnapshot(base.root, PLAN_ID, 2));
	assert.equal(await readPlanSnapshot(base.root, PLAN_ID, 3), undefined);
});

/** A lease that reports itself lost as soon as the publication reaches `phase`. */
function leaseLostAt(phase: string): LockLease {
	const lease = createLockLease();
	return {
		onCompromised: lease.onCompromised,
		isLost: lease.isLost,
		lostReason: lease.lostReason,
		observe(reached) {
			if (reached === phase) lease.onCompromised(new Error("the lockfile was reclaimed"));
		},
	};
}

test("a lease lost before the plan file is replaced stops the publication", async (t) => {
	for (const phase of ["acquired", "validated", "prepared"]) {
		const base = await initialized();
		t.after(base.cleanup);
		const result = await publishPlanRevision({
			root: base.root,
			planId: PLAN_ID,
			planPath: base.planPath,
			baseRevision: 1,
			baseDigest: digestOf("# Plan v1\n"),
			plan: "# Plan v2",
			now: NOW,
			changeSummary: "x",
			lease: leaseLostAt(phase),
		});
		assert.equal(result.kind, "conflict", phase);
		if (result.kind !== "conflict") return;
		assert.match(result.reason, /lost before the revision was published/u);
		assert.equal(await readPlanFile(base.planPath), "# Plan v1\n", phase);
	}
});

test("a lease lost after the plan file is replaced reports it instead of pretending", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	const result = await publishPlanRevision({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		baseRevision: 1,
		baseDigest: digestOf("# Plan v1\n"),
		plan: "# Plan v2",
		now: NOW,
		changeSummary: "x",
		lease: leaseLostAt("published"),
	});
	assert.equal(result.kind, "published");
	if (result.kind !== "published") return;
	assert.match(result.lockCompromised ?? "", /must not be retried/u);
	assert.match(result.historyPending ?? "", /before its history could be recorded/u);
	assert.equal(await readPlanFile(base.planPath), "# Plan v2\n");
	// The reservation is still there, so the next session recovers the history.
	const names = await readdir(join(base.root, PLAN_ID, "revisions"));
	assert.ok(names.some((name) => name.startsWith("pending-2-")), names.join(", "));
	const recovered = await recoverPlanRevisions({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		now: NOW,
	});
	assert.equal(recovered.kind, "recovered");
});

test("a cancelled publication writes nothing at all", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	const controller = new AbortController();
	controller.abort();
	const result = await publishPlanRevision({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		baseRevision: 1,
		baseDigest: digestOf("# Plan v1\n"),
		plan: "# Plan v2",
		now: NOW,
		changeSummary: "x",
		signal: controller.signal,
	});
	assert.equal(result.kind, "cancelled");
	assert.equal(await readPlanFile(base.planPath), "# Plan v1\n");
	assert.equal(await highestReservedRevision(base.root, PLAN_ID), 1);
});

function proposal(overrides: Partial<PlanProposal> = {}): PlanProposal {
	return {
		schemaVersion: 1,
		proposalId: "00000000-0000-4000-8000-0000000000c1",
		planId: PLAN_ID,
		revisionId: "00000000-0000-4000-8000-0000000000d1",
		status: "pending",
		instructions: "change the deployment approach",
		changeSummary: "rolling restart instead of blue/green",
		baseRevision: 1,
		baseDigest: digestOf("# Plan v1\n"),
		createdAt: NOW,
		proposedPlan: "# Plan v2\n",
		diff: ["-2. Deploy with blue/green.", "+2. Deploy with a rolling restart."],
		...overrides,
	};
}

test("a proposal round-trips, and one that disagrees with its filename is refused", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	const candidate = proposal();
	await writePlanProposal(base.root, candidate);
	assert.deepEqual(await readPlanProposal(base.root, PLAN_ID, candidate.proposalId), candidate);
	assert.equal(await readPlanProposal(base.root, OTHER_PLAN_ID, candidate.proposalId), undefined);
	assert.equal(await readPlanProposal(base.root, PLAN_ID, "not-an-id"), undefined);

	// A record claiming another plan, stored under this one, must not be usable:
	// it could otherwise redirect a publication.
	await writeFile(
		planProposalPath(base.root, PLAN_ID, candidate.proposalId),
		JSON.stringify({ ...candidate, planId: OTHER_PLAN_ID }),
	);
	assert.equal(await readPlanProposal(base.root, PLAN_ID, candidate.proposalId), undefined);
});

test("resolving a proposal keeps its content and takes it out of pending", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	const first = proposal();
	const second = proposal({
		proposalId: "00000000-0000-4000-8000-0000000000c2",
		createdAt: "2026-01-01T00:00:01.000Z",
		proposedPlan: "# Plan v2b\n",
	});
	await writePlanProposal(base.root, first);
	await writePlanProposal(base.root, second);
	assert.equal((await listPendingPlanProposals(base.root, PLAN_ID)).length, 2);

	await resolvePlanProposal(base.root, first, "superseded", NOW, {
		supersededBy: second.proposalId,
		resolutionReason: "a corrected proposal replaced it",
	});
	const pending = await listPendingPlanProposals(base.root, PLAN_ID);
	assert.deepEqual(
		pending.map((entry) => entry.proposalId),
		[second.proposalId],
	);
	const retired = await readPlanProposal(base.root, PLAN_ID, first.proposalId);
	assert.equal(retired?.status, "superseded");
	assert.equal(retired?.supersededBy, second.proposalId);
	// Retired is not deleted: the content the user asked to change is still there.
	assert.equal(retired?.proposedPlan, first.proposedPlan);
	assert.equal((await listPlanProposals(base.root, PLAN_ID)).length, 2);
});

test("a proposal whose stored plan is unparseable or empty is not a proposal", async (t) => {
	const base = await initialized();
	t.after(base.cleanup);
	const candidate = proposal();
	await writePlanProposal(base.root, candidate);
	for (const broken of [
		{ ...candidate, proposedPlan: "" },
		{ ...candidate, baseDigest: "nope" },
		{ ...candidate, status: "approved" },
		{ ...candidate, schemaVersion: 2 },
	]) {
		await writeFile(
			planProposalPath(base.root, PLAN_ID, candidate.proposalId),
			JSON.stringify(broken),
		);
		assert.equal(
			await readPlanProposal(base.root, PLAN_ID, candidate.proposalId),
			undefined,
			JSON.stringify(broken).slice(0, 60),
		);
	}
});

/**
 * Replace `fs.promises.open` for the duration of `run`, whatever happens inside
 * it. Patched through the CJS object and re-synced into the (frozen) ESM
 * namespace, exactly as `finish-implementation.test.ts` does for `link`.
 */
async function withOpen<T>(replacement: typeof fs.promises.open, run: () => Promise<T>): Promise<T> {
	const fsp = fs.promises as { open: typeof fs.promises.open };
	const real = fs.promises.open;
	fsp.open = replacement;
	syncBuiltinESMExports();
	try {
		return await run();
	} finally {
		fsp.open = real;
		syncBuiltinESMExports();
	}
}

test("a preparation record that cannot be written publishes nothing", async (t) => {
	// The record is the only thing that can later prove these bytes were this
	// package's to publish, so it is written and fsynced *before* the live document
	// is replaced. A failure at that point must therefore leave no publication at
	// all — not a live document whose provenance nothing can account for.
	const base = await initialized();
	t.after(base.cleanup);
	const real = fs.promises.open;
	const refusing: typeof fs.promises.open = async (path, ...rest) => {
		const name = String(path);
		if (name.includes("pending-") && name.endsWith(".json")) {
			throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
		}
		return real(path, ...(rest as []));
	};

	const result = await withOpen(refusing, () =>
		publishPlanRevision({
			root: base.root,
			planId: PLAN_ID,
			planPath: base.planPath,
			baseRevision: 1,
			baseDigest: digestOf("# Plan v1\n"),
			plan: "# Plan v2",
			now: NOW,
			changeSummary: "x",
		}),
	);

	assert.equal(result.kind, "failed");
	if (result.kind !== "failed") return;
	assert.match(result.reason, /ENOSPC/u);
	// Nothing was published and nothing is half-prepared: the live document still
	// holds revision 1, no snapshot exists for 2, and the manifest has not moved.
	assert.equal(await readPlanFile(base.planPath), "# Plan v1\n");
	assert.equal(await readPlanSnapshot(base.root, PLAN_ID, 2), undefined);
	const manifest = await readPlanManifest(base.root, PLAN_ID);
	assert.equal(manifest.kind, "loaded");
	if (manifest.kind !== "loaded") return;
	assert.equal(manifest.manifest.specRevision, 1);
	assert.equal(manifest.manifest.currentDigest, digestOf("# Plan v1\n"));
	// And the half-written pair is cleaned up, so nothing can later be mistaken for
	// evidence of a publication that never happened.
	const names = await readdir(join(base.root, PLAN_ID, "revisions"));
	assert.deepEqual(
		names.filter((name) => name.startsWith("pending-2-")),
		[],
		names.join(", "),
	);

	// Recovery agrees: there is nothing to recover.
	const recovery = await recoverPlanRevisions({
		root: base.root,
		planId: PLAN_ID,
		planPath: base.planPath,
		now: NOW,
	});
	assert.equal(recovery.kind, "ok");
});
