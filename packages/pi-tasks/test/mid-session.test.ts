/**
 * Three things that only go wrong *after* a session has started: a document
 * that disappears mid-turn, a store that can no longer account for a document
 * nobody touched, and slow work landing on an attachment that has since gone.
 *
 * Every case here deliberately avoids re-emitting `session_start`. The
 * session-start path was already correct; the bugs these pin all lived in the
 * refresh path that runs on every read, write and turn boundary, and a test
 * that restarts the session cannot see them.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { snapshotPath, taskDocumentPath } from "../src/store.js";
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

function documentPath(harness: TasksHarness): string {
	return taskDocumentPath(harness.root, FIRST_SET);
}

function preparationRecords(harness: TasksHarness): string[] {
	return readdirSync(join(harness.root, FIRST_SET, "revisions")).filter((name) =>
		name.startsWith("pending-"),
	);
}

// ------------------------------------------------ correction 2: truthful reads

test("a document deleted mid-session stops being reported as the current list", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	// No session_start after this: the failure has to be caught by the ordinary
	// refresh that every get_tasks already performs.
	rmSync(documentPath(harness));

	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.status, "recovery_required");
	assert.equal(read.isError, true);
	assert.equal(read.payload.attached, true);
	assert.equal(read.payload.taskSetId, FIRST_SET);
	assert.equal(read.payload.mutationsBlocked, true);
	// The cached list must not be presented as current: no phases, no digest, and
	// nothing the agent could quote back into an update_tasks call.
	assert.equal(read.payload.phases, undefined);
	assert.equal(read.payload.digest, undefined);
	assert.equal(read.payload.updateRequires, undefined);
	assert.equal(read.payload.counts, undefined);
	assert.match(String(read.payload.recoveryInstruction), /\/tasks recover/u);
});

test("a document corrupted mid-session is reported the same way", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	writeFileSync(documentPath(harness), "this is no longer a task document\n");

	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.status, "recovery_required");
	assert.match(String(read.payload.recovery), /unreadable/u);
	assert.equal(read.payload.phases, undefined);
	assert.equal(read.payload.updateRequires, undefined);

	// And the widget agrees with the tool rather than still showing the old list.
	assert.equal(harness.controller.attachedSet, undefined);
	assert.ok(harness.controller.recoveryState);
});

// -------------------------------------- correction 2: generation safety

test("a detach during a slow refresh cannot latch recovery onto an empty session", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	rmSync(documentPath(harness));

	// Deterministic by construction: the refresh has already captured the
	// attachment and is parked on its first awaited read, and `recordDetached`
	// runs synchronously, so the detach always lands inside the window.
	const refreshing = harness.controller.refreshFromDisk(harness.ctx);
	await harness.controller.startNew(harness.ctx);
	await refreshing;

	assert.equal(harness.controller.attachedSet, undefined);
	assert.equal(
		harness.controller.recoveryState,
		undefined,
		"a session with no task set must not inherit another attachment's conflict",
	);

	// The session is genuinely usable again: a detached session that had latched
	// recovery answered recovery_required to every batch, init included.
	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.status, "no_task_set");
	const created = await callTool(harness, "update_tasks", { mode: "apply", changes: [SEED_INIT] });
	assert.equal(created.payload.status, "applied");
});

test("a detach during a slow refresh cannot adopt a document into the new state", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);

	// The document is fine here; what is under test is the adopt path assigning
	// loaded state and proposals after the attachment it read for has gone.
	const refreshing = harness.controller.refreshFromDisk(harness.ctx);
	await harness.controller.startNew(harness.ctx);
	await refreshing;

	assert.equal(harness.controller.attachedSet, undefined, "no document adopted into an empty session");
	assert.deepEqual(harness.controller.pending, []);
	assert.equal(harness.controller.recoveryState, undefined);

	// The session is usable: a fresh set can be created straight away.
	const created = await callTool(harness, "update_tasks", { mode: "apply", changes: [SEED_INIT] });
	assert.equal(created.payload.status, "applied");
});

// ------------------------- correction 3: reachable unaccountable-history recovery

/** Lose the evidence for the live revision, leaving the document and pointer. */
function loseHistoryFor(harness: TasksHarness, revision: number): void {
	rmSync(snapshotPath(harness.root, FIRST_SET, revision));
	for (const name of preparationRecords(harness)) {
		if (name.startsWith(`pending-${revision}-`)) {
			rmSync(join(harness.root, FIRST_SET, "revisions", name));
		}
	}
}

test("a set whose history was lost reports recovery and recovers without being abandoned", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const documentBefore = readFileSync(documentPath(harness), "utf8");

	// A selective restore, a copy between machines, or a tidy-up of the files the
	// README says accumulate: the document and the session pointer survive, the
	// evidence that this package published them does not.
	loseHistoryFor(harness, 1);

	// The read reports it rather than answering ok with a list it cannot vouch for.
	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.status, "recovery_required");
	assert.match(String(read.payload.recovery), /no record of publishing revision 1/u);
	assert.match(String(read.payload.recoveryInstruction), /\/tasks recover/u);
	assert.equal(/create a replacement set/iu.test(String(read.payload.recoveryInstruction)), true);

    // A write reports the same thing, with advice that can actually succeed.
	const refused = await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});
	assert.equal(refused.isError, true);
	assert.equal(refused.payload.status, "recovery_required");

	// It survives a turn boundary rather than being cleared by the next refresh
	// just because the digest still matches the pointer.
	await harness.emit("before_agent_start", { systemPrompt: "BASE" });
	assert.ok(harness.controller.recoveryState);
	assert.equal(harness.controller.recoveryState?.unaccountable, true);

	// ...and a restart.
	await harness.emit("session_start", { reason: "startup" });
	assert.ok(harness.controller.recoveryState);

	// /tasks recover is offered, and attach is the decision.
	await harness.controller.recoverAttachCurrent(harness.ctx);
	assert.equal(harness.controller.recoveryState, undefined);

	// The set was neither abandoned nor replaced: same id, same tasks, and the
	// next change publishes on top of it.
	assert.equal(harness.controller.attachedSet?.taskSetId, FIRST_SET);
	const applied = await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});
	assert.equal(applied.payload.status, "applied");
	assert.equal(applied.payload.revision, 2);
	assert.equal(readFileSync(documentPath(harness), "utf8").startsWith("# Tasks"), true);
	assert.notEqual(readFileSync(documentPath(harness), "utf8"), documentBefore);
});

// --------------------------- correction 4: authorization scoped to exact state

test("attach authorizes the document it was shown, not every later surprise", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	loseHistoryFor(harness, 1);
	await harness.controller.recoverAttachCurrent(harness.ctx);

	// The authorization is spent by the publication it enabled.
	const applied = await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});
	assert.equal(applied.payload.status, "applied");
	assert.equal(applied.payload.revision, 2);

	// A *second*, later loss is a new situation. Before this correction the
	// earlier attach was still in force and the write sailed through.
	loseHistoryFor(harness, 2);
	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.status, "recovery_required", "a new loss needs a new decision");
	const refused = await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "done", taskId: "t1", summary: "s" }],
	});
	assert.equal(refused.payload.status, "recovery_required");

	// And the second decision works exactly like the first.
	await harness.controller.recoverAttachCurrent(harness.ctx);
	const second = await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "done", taskId: "t1", summary: "added the column" }],
	});
	assert.equal(second.payload.status, "applied");
	assert.equal(second.payload.revision, 3);
});

test("an authorization does not cover a different document", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	loseHistoryFor(harness, 1);
	await harness.controller.recoverAttachCurrent(harness.ctx);

	// Same set, same revision, different bytes than the ones that were accounted
	// for: outside the authorization, so it is a conflict again.
	const path = documentPath(harness);
	writeFileSync(path, readFileSync(path, "utf8").replace("flip the flag", "flip the switch"));
	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.status, "recovery_required");
});

// ------------------------------------------- correction 5: honest card wording

test("the approval card does not promise a revision number the store may not use", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "dismissed" }] });
	t.after(harness.cleanup);
	await updateTasks(harness, {
		mode: "propose",
		reason: "drop the cutover phase",
		changes: [{ op: "remove_task", taskId: "t4" }],
	});

	const card = harness.cards.at(-1);
	assert.equal(card?.title, "Proposed task revision");
	assert.match(card?.body ?? "", /the next accepted revision/u);
	// The base is still named; the promise of `base + 1` is not, because a gap
	// from an interrupted publication makes that number wrong.
	assert.match(card?.body ?? "", /Against revision 1\b/u);
	assert.equal(/publishes revision \d/u.test(card?.body ?? ""), false);
	assert.equal((card?.body ?? "").includes("revision 2"), false);
});

// ------ the unaccountable mapper must not contaminate a replacement session

/**
 * Reach the mapper for real.
 *
 * `adopt` and the store answer the same accountability question from different
 * evidence, and there is one state where they legitimately disagree: a
 * numbered snapshot holding bytes that are not the live document's, with the
 * preparation record still matching. `isPublishedRevision` accepts it on the
 * record, so classification says "same" and the write proceeds; the store's
 * `repairMissingSnapshot` sees a snapshot that disagrees and returns
 * `unaccountable`. That is what drives `update_tasks` into the mapper through
 * its ordinary production path rather than by calling it directly.
 */
function makeSnapshotDisagree(harness: TasksHarness): void {
	const snapshot = snapshotPath(harness.root, FIRST_SET, 1);
	writeFileSync(snapshot, readFileSync(snapshot, "utf8").replace("flip the flag", "flip the fla9"));
}

test("a detach inside the unaccountable mapper leaves no recovery on the new session", async (t) => {
	let harness: TasksHarness | undefined;
	let detached = false;
	harness = await seeded({
		// Runs while the mapper is suspended on its snapshot walk — the exact
		// window in which the session can be replaced underneath it.
		onSnapshotWalk: async () => {
			if (detached || !harness?.controller.attachedSet) return;
			detached = true;
			await harness.controller.startNew(harness.ctx);
		},
	});
	t.after(() => harness?.cleanup());
	makeSnapshotDisagree(harness);

	const refused = await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});

	assert.equal(detached, true, "the race must actually have been run");
	// The outcome still describes the commit that really happened: this call was
	// refused, and saying anything else would be a lie about the caller's write.
	assert.equal(refused.isError, true);
	assert.equal(refused.payload.status, "recovery_required");

	// But none of it may stick to the session that replaced the attachment.
	assert.equal(harness.controller.attachedSet, undefined);
	assert.equal(
		harness.controller.recoveryState,
		undefined,
		"a session with no task set must not inherit another set's conflict",
	);
	assert.equal(harness.controller.uiState.blocked, undefined, "no blocked widget/footer");
	assert.equal(
		await harness.systemPromptAddition(),
		undefined,
		"no per-turn recovery pointer for a set this session does not own",
	);

	// And the session is genuinely usable: a latched recovery used to make every
	// non-init batch answer recovery_required while get_tasks said no_task_set.
	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.status, "no_task_set");
	const created = await callTool(harness, "update_tasks", { mode: "apply", changes: [SEED_INIT] });
	assert.equal(created.payload.status, "applied");
});

test("without a detach the same mapper does record recovery on its own session", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	makeSnapshotDisagree(harness);

	const refused = await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});

	// The control for the test above: same path, nobody detaches, so the mapper
	// does write its conclusion onto the session it belongs to. Without this, a
	// guard that simply never recorded anything would pass the detach test.
	assert.equal(refused.payload.status, "recovery_required");
	assert.equal(harness.controller.recoveryState?.unaccountable, true);
	assert.equal(harness.controller.recoveryState?.documentRevision, 1);
	assert.equal(harness.controller.attachedSet?.taskSetId, FIRST_SET);
	assert.equal(harness.controller.uiState.blocked !== undefined, true, "the widget shows it");
	// Deliberately not asserted here: what the *next* turn refresh does with this
	// state. In this particular corner the read side accepts the document on its
	// preparation record while the write side refuses it, so a refresh clears the
	// recovery again. That disagreement is a separately recorded P2 and is not in
	// this pass's scope; asserting either way here would be claiming a verdict on
	// it.
});
