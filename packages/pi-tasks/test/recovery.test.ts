/**
 * Recovery as the session sees it: what the tools say while a conflict is
 * unresolved, what the commands are allowed to do, and what survives.
 *
 * The store's own guarantees are pinned in `store.test.ts`. These are the
 * controller-level halves of the same rules, because the ways a user actually
 * reaches them — `get_tasks`, `/tasks review`, `/tasks recover`, export — each
 * had their own way of stepping around the gate.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { listProposals } from "../src/proposals.js";
import { findRecoverySnapshot, snapshotPath, taskDocumentPath } from "../src/store.js";
import {
	callTool,
	createTasksHarness,
	SEED_INIT,
	type TasksHarness,
	updateTasks,
} from "./support/harness.js";

const FIRST_SET = "00000000-0000-4000-8000-000000000001";

async function seeded(options: Parameters<typeof createTasksHarness>[0] = {}) {
	const harness = createTasksHarness(options);
	await harness.emit("session_start", { reason: "startup" });
	const created = await callTool(harness, "update_tasks", { mode: "apply", changes: [SEED_INIT] });
	assert.equal(created.isError, false, JSON.stringify(created.payload));
	return harness;
}

function documentText(harness: TasksHarness): string {
	return readFileSync(taskDocumentPath(harness.root, FIRST_SET), "utf8");
}

function snapshotNames(harness: TasksHarness): string[] {
	return readdirSync(join(harness.root, FIRST_SET, "revisions"))
		.filter((name) => /^\d+\.md$/u.test(name))
		.sort();
}

function runCommand(harness: TasksHarness, args: string): Promise<void> {
	const command = harness.commands.get("tasks");
	assert.ok(command);
	return command.handler(args, harness.ctx) as Promise<void>;
}

// ------------------------------------------------------------- get_tasks (3)

test("an attached session whose document vanished says recover, never 'create a new one'", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	rmSync(taskDocumentPath(harness.root, FIRST_SET));
	await harness.emit("session_start", { reason: "startup" });

	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.status, "recovery_required");
	assert.equal(read.payload.attached, true);
	assert.equal(read.payload.taskSetId, FIRST_SET);
	assert.equal(read.payload.recordedRevision, 1);
	assert.equal(read.payload.mutationsBlocked, true);
	assert.equal(read.payload.recoverySnapshotRevision, 1);
	const instruction = String(read.payload.recoveryInstruction);
	assert.match(instruction, /\/tasks recover/u);
	// It must forbid the two escapes that strand a recoverable set, and must not
	// contain the invitation the old reply led with.
	assert.match(instruction, /do not create a replacement set with init/iu);
	assert.match(instruction, /do not detach/iu);
	assert.equal(/create one with update_tasks/iu.test(instruction), false);
	assert.equal(
		/create one with update_tasks/iu.test(JSON.stringify(read.payload)),
		false,
		"the whole reply, not just the instruction, must not invite a replacement set",
	);
});

test("a corrupt document reports recovery, and init is refused as recovery too", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	writeFileSync(taskDocumentPath(harness.root, FIRST_SET), "this is not a task document\n");
	await harness.emit("session_start", { reason: "startup" });

	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.status, "recovery_required");
	assert.match(String(read.payload.recovery), /unreadable/u);

	// The agent that follows the instruction gets a consistent answer rather
	// than "already attached", which used to send it looking for a way to
	// replace a set whose snapshots were still on disk.
	const refused = await callTool(harness, "update_tasks", { mode: "apply", changes: [SEED_INIT] });
	assert.equal(refused.isError, true);
	assert.equal(refused.payload.status, "recovery_required");
	assert.equal(refused.payload.taskSetId, FIRST_SET);
	assert.match(String(refused.payload.message), /\/tasks recover/u);
	// The set is still all there.
	assert.deepEqual(snapshotNames(harness), ["1.md"]);
});

test("a document naming another set is a conflict, not an adoption", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const foreign = documentText(harness).replace(FIRST_SET, "00000000-0000-4000-8000-000000000042");
	writeFileSync(taskDocumentPath(harness.root, FIRST_SET), foreign);
	await harness.emit("session_start", { reason: "startup" });

	assert.ok(harness.controller.recoveryState);
	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.status, "recovery_required");
	// Identity is checked on this path exactly as on every other managed read,
	// so the foreign id never reaches the session's pointer or its report.
	assert.equal(read.payload.taskSetId, FIRST_SET);
	assert.equal(harness.controller.attachedSet, undefined);
});

test("a genuinely unattached session still says so", async (t) => {
	const harness = createTasksHarness();
	t.after(harness.cleanup);
	await harness.emit("session_start", { reason: "startup" });
	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.status, "no_task_set");
	assert.equal(read.payload.attached, false);
	assert.match(String(read.payload.message), /init/u);

	// And an explicit new set is still allowed: recovery guards an attachment,
	// it does not ban creation.
	const created = await callTool(harness, "update_tasks", { mode: "apply", changes: [SEED_INIT] });
	assert.equal(created.payload.status, "applied");
});

// ------------------------------------------------- acceptance under recovery

const PROPOSE = {
	mode: "propose",
	reason: "drop the cutover phase",
	changes: [{ op: "remove_task", taskId: "t4" }],
} as const;

test("a rollback to the proposal's own base cannot slip past the recovery gate", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "dismissed" }] });
	t.after(harness.cleanup);
	const base = documentText(harness);
	await updateTasks(harness, PROPOSE);
	const pending = (await listProposals(harness.root, FIRST_SET))[0];
	assert.ok(pending);

	// Progress moves the set on, then the document is restored to exactly the
	// bytes the proposal was built against. The digest check alone would be
	// satisfied by that restore, which is precisely why it is not the only gate.
	await updateTasks(harness, { mode: "apply", changes: [{ op: "start", taskId: "t1" }] });
	writeFileSync(taskDocumentPath(harness.root, FIRST_SET), base);

	const refused = await harness.controller.acceptProposal(pending, harness.ctx);
	assert.equal(refused.isError, true);
	assert.equal(refused.payload.status, "recovery_required");
	assert.equal(refused.payload.mutationsBlocked, true);
	assert.equal(documentText(harness), base, "nothing was published");
	// The candidate is kept, unapproved.
	assert.equal((await listProposals(harness.root, FIRST_SET))[0]?.status !== "accepted", true);
});

test("/tasks review refuses to open a card it could not act on", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "dismissed" }, { kind: "accepted" }] });
	t.after(harness.cleanup);
	await updateTasks(harness, PROPOSE);
	const before = documentText(harness);

	writeFileSync(
		taskDocumentPath(harness.root, FIRST_SET),
		before.replace("flip the flag", "flip the switch"),
	);
	await harness.emit("session_start", { reason: "startup" });

	const cardsBefore = harness.reviewRequests.length;
	await runCommand(harness, "review");
	assert.equal(harness.reviewRequests.length, cardsBefore, "no card may be offered");
	assert.match(harness.notifications.at(-1)?.message ?? "", /needs recovery/u);
	assert.match(harness.notifications.at(-1)?.message ?? "", /kept on file/u);
});

test("a card opened before the conflict cannot publish through it", async (t) => {
	let harness: TasksHarness | undefined;
	harness = await seeded({
		onReview: async () => {
			// The conflict appears while the human is reading the card.
			const path = taskDocumentPath(harness?.root ?? "", FIRST_SET);
			writeFileSync(path, readFileSync(path, "utf8").replace("flip the flag", "flip the switch"));
			return { kind: "accepted" };
		},
	});
	t.after(() => harness?.cleanup());
	const before = documentText(harness);

	const result = await updateTasks(harness, PROPOSE);
	assert.equal(result.isError, true);
	assert.equal(result.payload.status, "recovery_required");
	assert.equal(documentText(harness), before.replace("flip the flag", "flip the switch"));
	assert.deepEqual(snapshotNames(harness), ["1.md"], "no revision was published");
});

test("acceptance is refused while the document is unreadable, not just diverged", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "dismissed" }] });
	t.after(harness.cleanup);
	await updateTasks(harness, PROPOSE);
	const pending = (await listProposals(harness.root, FIRST_SET))[0];
	assert.ok(pending);

	rmSync(taskDocumentPath(harness.root, FIRST_SET));
	await harness.emit("session_start", { reason: "startup" });

	const refused = await harness.controller.acceptProposal(pending, harness.ctx);
	assert.equal(refused.isError, true);
	assert.equal(refused.payload.status, "recovery_required");
	assert.equal(existsSync(taskDocumentPath(harness.root, FIRST_SET)), false);
});

// --------------------------------------------- rollback, ABA, reconciliation

test("history above the document blocks until a human accounts for it, then moves on", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const path = taskDocumentPath(harness.root, FIRST_SET);
	const revisionOne = readFileSync(snapshotPath(harness.root, FIRST_SET, 1), "utf8");

	await updateTasks(harness, { mode: "apply", changes: [{ op: "start", taskId: "t1" }] });
	const revisionTwo = readFileSync(snapshotPath(harness.root, FIRST_SET, 2), "utf8");

	// The user restores revision 1 over the live document. The recorded digest
	// still matches revision 2, so this is detected; but even the A-B-A shape,
	// where the restored bytes are ones this session has recorded, is caught
	// because history on disk runs above the document.
	writeFileSync(path, revisionOne);
	await harness.emit("session_start", { reason: "startup" });
	assert.match(harness.controller.recoveryState?.reason ?? "", /history recorded up to revision 2/u);
	assert.equal(harness.controller.recoveryState?.historyAhead, 2);

	const refused = await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t2" }],
	});
	assert.equal(refused.payload.status, "recovery_required");

	// The explicit decision. Afterwards the session must actually be able to
	// work again — a reconciliation that re-blocks on the next read is not one.
	await harness.controller.recoverAttachCurrent(harness.ctx);
	assert.equal(harness.controller.recoveryState, undefined);
	assert.match(harness.notifications.at(-1)?.message ?? "", /up to 2 stay on disk/u);

	const applied = await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t2" }],
	});
	assert.equal(applied.payload.status, "applied");
	assert.equal(applied.payload.revision, 3, "numbered above the history it was told about");

	// Revision 2 is exactly where it was, and revision 1 too.
	assert.equal(readFileSync(snapshotPath(harness.root, FIRST_SET, 2), "utf8"), revisionTwo);
	assert.equal(readFileSync(snapshotPath(harness.root, FIRST_SET, 1), "utf8"), revisionOne);
	assert.deepEqual(snapshotNames(harness), ["1.md", "2.md", "3.md"]);

	// And it stays unblocked across a restart.
	await harness.emit("session_start", { reason: "startup" });
	assert.equal(harness.controller.recoveryState, undefined);
});

test("recovery offers the newest snapshot that parses, and forking never changes one", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	await updateTasks(harness, { mode: "apply", changes: [{ op: "start", taskId: "t1" }] });
	const revisionOne = readFileSync(snapshotPath(harness.root, FIRST_SET, 1), "utf8");

	// The newest snapshot is unreadable and the live document is gone.
	const corrupt = "# Tasks\n\ntruncated\n";
	writeFileSync(snapshotPath(harness.root, FIRST_SET, 2), corrupt);
	rmSync(taskDocumentPath(harness.root, FIRST_SET));
	await harness.emit("session_start", { reason: "startup" });
	assert.equal(harness.controller.recoveryState?.snapshotRevision, 1, "stepped past the corrupt one");

	await harness.controller.recoverForkSnapshot(harness.ctx);
	const forked = harness.controller.attachedSet;
	assert.ok(forked);
	assert.notEqual(forked.taskSetId, FIRST_SET);
	// Both snapshots of the original set are untouched, corrupt one included.
	assert.equal(readFileSync(snapshotPath(harness.root, FIRST_SET, 1), "utf8"), revisionOne);
	assert.equal(readFileSync(snapshotPath(harness.root, FIRST_SET, 2), "utf8"), corrupt);
});

test("a fork from an unverified snapshot says so rather than calling it accepted", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	// A snapshot with no preparation record: what an older build left behind.
	const legacy = readFileSync(snapshotPath(harness.root, FIRST_SET, 1), "utf8").replace(
		'"revision":1',
		'"revision":4',
	);
	writeFileSync(snapshotPath(harness.root, FIRST_SET, 4), legacy);
	rmSync(taskDocumentPath(harness.root, FIRST_SET));
	await harness.emit("session_start", { reason: "startup" });

	assert.equal(await findRecoverySnapshot(harness.root, FIRST_SET).then((c) => c?.certainty), "unverified");
	await harness.controller.recoverForkSnapshot(harness.ctx);
	assert.match(harness.notifications.at(-1)?.message ?? "", /cannot prove it published/u);
	assert.equal(readFileSync(snapshotPath(harness.root, FIRST_SET, 4), "utf8"), legacy);
});

// ------------------------------------------------------------------- export

test("export refuses during recovery instead of publishing a stale copy", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const destination = join(harness.root, "exported.md");
	writeFileSync(
		taskDocumentPath(harness.root, FIRST_SET),
		documentText(harness).replace("flip the flag", "flip the switch"),
	);
	await harness.emit("session_start", { reason: "startup" });

	assert.equal(await harness.controller.exportTasks(destination, harness.ctx), false);
	assert.match(harness.notifications.at(-1)?.message ?? "", /needs recovery/u);
	assert.equal(existsSync(destination), false, "no file claiming to be the current list");
});

test("export never replaces a destination that appears while it is working", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const destination = join(harness.root, "exported.md");
	const squatter = "someone else's notes\n";
	writeFileSync(destination, squatter);

	assert.equal(await harness.controller.exportTasks(destination, harness.ctx), false);
	assert.equal(readFileSync(destination, "utf8"), squatter, "its bytes are unchanged");
	assert.match(harness.notifications.at(-1)?.message ?? "", /already exists/u);
});
