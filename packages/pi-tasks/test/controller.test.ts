/**
 * The extension as a session sees it: attach, apply, propose, review, recover.
 *
 * These drive the registered tools rather than the controller's methods where
 * they can, because the schema and the normaliser are part of the contract the
 * model uses, and a test that skips them proves less than it looks like it does.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { listProposals } from "../src/proposals.js";
import { loadTaskDocument, taskDocumentPath } from "../src/store.js";
import {
	callTool,
	createTasksHarness,
	SEED_INIT,
	type TasksHarness,
	updateTasks,
} from "./support/harness.js";

const FIRST_SET = "00000000-0000-4000-8000-000000000001";

async function started(options: Parameters<typeof createTasksHarness>[0] = {}) {
	const harness = createTasksHarness(options);
	await harness.emit("session_start", { reason: "startup" });
	return harness;
}

async function seeded(options: Parameters<typeof createTasksHarness>[0] = {}) {
	const harness = await started(options);
	const result = await callTool(harness, "update_tasks", {
		mode: "apply",
		changes: [SEED_INIT],
	});
	assert.equal(result.isError, false, JSON.stringify(result.payload));
	return harness;
}

function documentText(harness: TasksHarness, taskSetId = FIRST_SET): string {
	return readFileSync(taskDocumentPath(harness.root, taskSetId), "utf8");
}

test("a fresh session is unattached, and get_tasks says so without inventing one", async (t) => {
	const harness = await started();
	t.after(harness.cleanup);
	const result = await callTool(harness, "get_tasks", {});
	assert.equal(result.payload.status, "no_task_set");
	assert.equal(result.payload.attached, false);
	assert.match(String(result.payload.message), /update_tasks/u);
	assert.equal(await harness.systemPromptAddition(), undefined);
});

test("init creates the set, attaches the session, and reports the allocated ids", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);

	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.status, "ok");
	assert.equal(read.payload.attached, true);
	assert.equal(read.payload.taskSetId, FIRST_SET);
	assert.equal(read.payload.revision, 1);
	assert.deepEqual(
		(read.payload.phases as Array<{ id: string }>).map((phase) => phase.id),
		["p1", "p2", "p3"],
	);
	assert.deepEqual(read.payload.counts, {
		total: 4,
		pending: 4,
		inProgress: 0,
		blocked: 0,
		completed: 0,
		abandoned: 0,
		open: 4,
	});
	assert.ok(existsSync(taskDocumentPath(harness.root, FIRST_SET)));
	assert.ok(existsSync(join(harness.root, FIRST_SET, "revisions", "1.md")));
	assert.equal(harness.cards[0]?.title, "Task set created");
});

test("the turn pointer names the file and the counts, and nothing else", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});
	const pointer = (await harness.systemPromptAddition()) ?? "";
	assert.match(pointer, /^\[TASKS\]/u);
	assert.match(pointer, /revision 2, 4 of 4 task\(s\) open/u);
	assert.match(pointer, /In progress: add the revision column\./u);
	assert.match(pointer, /do not edit it directly/u);
	// Pointer, not payload: the other tasks' text is not in the prompt.
	assert.equal(pointer.includes("flip the flag"), false);
});

test("progress applies immediately and bumps the revision", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const result = await updateTasks(harness, {
		mode: "apply",
		expectedRevision: 1,
		changes: [
			{ op: "start", taskId: "t1" },
			{ op: "done", taskId: "t1", summary: "added it with a backfill default" },
		],
	});
	assert.equal(result.payload.status, "applied");
	assert.equal(result.payload.revision, 2);
	assert.equal(result.payload.progressOnly, true);
	assert.deepEqual(result.payload.counts, { total: 4, open: 3, completed: 1 });
	assert.match(documentText(harness), /- \[x\] add the revision column/u);
});

test("a stale expectedRevision is refused with the current one", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});
	const stale = await updateTasks(harness, {
		mode: "apply",
		expectedRevision: 1,
		changes: [{ op: "done", taskId: "t1", summary: "s" }],
	});
	assert.equal(stale.isError, true);
	assert.equal(stale.payload.status, "stale_revision");
	assert.equal(stale.payload.currentRevision, 2);
	assert.match(String(stale.payload.message), /get_tasks/u);
});

test("init refuses to replace an attached set", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const result = await callTool(harness, "update_tasks", { mode: "apply", changes: [SEED_INIT] });
	assert.equal(result.isError, true);
	assert.equal(result.payload.status, "already_attached");
	assert.match(String(result.payload.message), /\/tasks new|\/tasks archive/u);
});

test("an accepted proposal publishes the next revision and keeps closed work", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "accepted" }] });
	t.after(harness.cleanup);
	await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "done", taskId: "t3", summary: "rows copied" }],
	});

	const result = await updateTasks(harness, {
		mode: "propose",
		reason: "drop the cutover phase; it moves to next quarter",
		changes: [
			{ op: "remove_task", taskId: "t4" },
			{ op: "remove_phase", phaseId: "p3" },
		],
	});
	assert.equal(result.payload.status, "accepted");
	assert.equal(result.payload.revision, 3);

	const read = await callTool(harness, "get_tasks", {});
	assert.deepEqual(
		(read.payload.phases as Array<{ id: string }>).map((phase) => phase.id),
		["p1", "p2"],
	);
	const migration = (read.payload.phases as Array<{ tasks: Array<Record<string, unknown>> }>)[1];
	assert.equal(migration?.tasks[0]?.status, "completed");
	assert.deepEqual(read.payload.pendingProposals, []);
});

test("the review card carries a diff this package computed, matched by id", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "cancelled" }] });
	t.after(harness.cleanup);
	await updateTasks(harness, {
		mode: "propose",
		reason: "reword the first task and add a rollback step",
		changes: [
			{ op: "edit_task", taskId: "t1", content: "add the revision column with an index" },
			{ op: "add_task", phaseId: "p2", content: "write the rollback script" },
		],
	});
	const request = harness.reviewRequests[0];
	assert.ok(request);
	assert.equal(request.baseRevision, 1);
	assert.deepEqual(request.diff, [
		'~ t1 reworded: "add the revision column" -> "add the revision column with an index"',
		'+ t5 in p2: "write the rollback script"',
	]);
	const card = harness.cards.at(-1);
	assert.equal(card?.title, "Proposed task revision");
	assert.match(card?.body ?? "", /reword the first task/u);
});

test("cancelling leaves the accepted set alone and keeps the proposal on file", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "cancelled" }] });
	t.after(harness.cleanup);
	const before = documentText(harness);
	const result = await updateTasks(harness, {
		mode: "propose",
		reason: "drop everything",
		changes: [{ op: "remove_task", taskId: "t4" }],
	});
	assert.equal(result.payload.status, "cancelled");
	assert.equal(result.payload.acceptedRevision, 1);
	assert.equal(documentText(harness), before);

	const proposals = await listProposals(harness.root, FIRST_SET);
	assert.deepEqual(proposals.map((proposal) => proposal.status), ["cancelled"]);
	const read = await callTool(harness, "get_tasks", {});
	assert.deepEqual(read.payload.pendingProposals, []);
});

test("requesting changes returns the feedback with the base, and keeps the proposal pending", async (t) => {
	const harness = await seeded({
		reviews: [{ kind: "changes_requested", feedback: "keep the migration work" }],
	});
	t.after(harness.cleanup);
	const result = await updateTasks(harness, {
		mode: "propose",
		reason: "start over",
		changes: [{ op: "remove_task", taskId: "t3" }],
	});
	assert.equal(result.payload.status, "changes_requested");
	assert.equal(result.payload.feedback, "keep the migration work");
	assert.equal(result.payload.baseRevision, 1);
	assert.match(String(result.payload.instruction), /mode "propose"/u);

	const proposals = await listProposals(harness.root, FIRST_SET);
	assert.deepEqual(proposals.map((proposal) => proposal.status), ["pending"]);
	const read = await callTool(harness, "get_tasks", {});
	assert.equal((read.payload.pendingProposals as unknown[]).length, 1);
});

test("a headless session gets pending_review, never a fabricated approval", async (t) => {
	const harness = await seeded({ mode: "print", reviews: [{ kind: "accepted" }] });
	t.after(harness.cleanup);
	const before = documentText(harness);
	const result = await updateTasks(harness, {
		mode: "propose",
		reason: "drop the cutover phase",
		changes: [{ op: "remove_task", taskId: "t4" }],
	});
	assert.equal(result.payload.status, "pending_review");
	assert.ok(result.payload.proposalId);
	assert.match(String(result.payload.message), /not approved/u);
	assert.equal(documentText(harness), before);
	assert.deepEqual(harness.reviewRequests, []);
});

test("a proposal whose base moved during review is refused and kept, not published", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	// The human takes their time; progress lands while the card is still open.
	const proposal = await updateTasks(harness, {
		mode: "propose",
		reason: "drop the cutover phase",
		changes: [{ op: "remove_task", taskId: "t4" }],
	});
	assert.equal(proposal.payload.status, "pending_review");

	await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});

	// It can never be published again, so it stops counting as awaiting review
	// rather than latching "a revision is waiting" into every later turn.
	const retired = (await listProposals(harness.root, FIRST_SET))[0];
	assert.ok(retired);
	assert.equal(retired.status, "superseded");
	assert.match(String(retired.resolutionReason), /moved past the revision it was built on/u);
	assert.deepEqual(harness.controller.pending, []);
	assert.equal((await harness.systemPromptAddition())?.includes("awaiting"), false);

	// And the card that is still in the user's hands cannot publish it.
	const accepted = await harness.controller.acceptProposal(retired, harness.ctx);
	assert.equal(accepted.isError, true);
	assert.equal(accepted.payload.status, "stale_proposal");
	assert.equal(accepted.payload.persistedStatus, "superseded");
	assert.match(documentText(harness), /- \[ \] flip the flag/u);

	// The content is retained, so the agent can re-propose it against the new base.
	const kept = (await listProposals(harness.root, FIRST_SET))[0];
	assert.equal(kept?.proposedDocument, retired.proposedDocument);
	assert.equal(kept?.reason, "drop the cutover phase");
});

test("a pending proposal survives a restart and is still waiting, not applied", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "dismissed" }, { kind: "accepted" }] });
	t.after(harness.cleanup);
	const before = documentText(harness);
	await updateTasks(harness, {
		mode: "propose",
		reason: "drop the cutover phase",
		changes: [{ op: "remove_task", taskId: "t4" }],
	});

	await harness.emit("session_shutdown", { reason: "quit" });
	await harness.emit("session_start", { reason: "startup" });

	assert.equal(harness.controller.pending.length, 1);
	assert.equal(documentText(harness), before);
	const read = await callTool(harness, "get_tasks", {});
	assert.equal((read.payload.pendingProposals as unknown[]).length, 1);
	assert.match((await harness.systemPromptAddition()) ?? "", /waiting for the user's review/u);

	// And it can still be decided, with the base it was computed against.
	const command = harness.commands.get("tasks");
	assert.ok(command);
	await command.handler("review", harness.ctx);
	assert.equal(harness.reviewRequests.at(-1)?.baseRevision, 1);
	assert.equal(harness.controller.attachedSet?.revision, 2);
});

test("reading another managed set is read-only and does not switch the attachment", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	await harness.controller.startNew(harness.ctx);
	await callTool(harness, "update_tasks", {
		mode: "apply",
		changes: [{ op: "init", phases: [{ name: "Other", tasks: ["something else"] }] }],
	});
	const second = "00000000-0000-4000-8000-000000000002";

	const read = await callTool(harness, "get_tasks", { taskSetId: FIRST_SET });
	assert.equal(read.payload.attached, false);
	assert.equal(read.payload.taskSetId, FIRST_SET);
	assert.match(String(read.payload.note), /read-only/u);

	const attached = await callTool(harness, "get_tasks", {});
	assert.equal(attached.payload.taskSetId, second);

	const wrong = await updateTasks(harness, {
		mode: "apply",
		taskSetId: FIRST_SET,
		changes: [{ op: "start", taskId: "t1" }],
	});
	assert.equal(wrong.isError, true);
	assert.equal(wrong.payload.status, "wrong_task_set");
});

test("a restarted session re-attaches from its own branch", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});
	await harness.emit("session_shutdown", { reason: "quit" });
	await harness.emit("session_start", { reason: "startup" });

	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.taskSetId, FIRST_SET);
	assert.equal(read.payload.revision, 2);
	assert.equal(harness.controller.recoveryState, undefined);
});

test("an unattached session never adopts a task set that is merely on disk", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const fresh = createTasksHarness({ root: harness.root });
	await fresh.emit("session_start", { reason: "new" });
	const read = await callTool(fresh, "get_tasks", {});
	assert.equal(read.payload.status, "no_task_set");
	assert.equal(await fresh.systemPromptAddition(), undefined);
});

test("a revision another session published is followed, not treated as a conflict", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const other = createTasksHarness({ root: harness.root, branch: harness.branch });
	await other.emit("session_start", { reason: "startup" });
	await updateTasks(other, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});

	await harness.emit("session_start", { reason: "startup" });
	assert.equal(harness.controller.recoveryState, undefined);
	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.revision, 2);
	assert.ok(
		harness.notifications.some((entry) => /advanced to revision 2 elsewhere/u.test(entry.message)),
	);
});

test("a document edited outside the package stops mutation until recovery", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const path = taskDocumentPath(harness.root, FIRST_SET);
	writeFileSync(path, readFileSync(path, "utf8").replace("flip the flag", "flip the switch"));

	await harness.emit("session_start", { reason: "startup" });
	assert.match(harness.controller.recoveryState?.reason ?? "", /modified outside this package/u);

	const refused = await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});
	assert.equal(refused.isError, true);
	assert.equal(refused.payload.status, "recovery_required");
	assert.match(String(refused.payload.message), /\/tasks recover/u);
	assert.match((await harness.systemPromptAddition()) ?? "", /needs recovery/u);

	await harness.controller.recoverAttachCurrent(harness.ctx);
	assert.equal(harness.controller.recoveryState, undefined);
	const applied = await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});
	assert.equal(applied.payload.status, "applied");
});

test("an edit made mid-session is caught before the next write builds on it", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	// No restart and no /tree: the session is live and its cached document is the
	// one it just wrote. Someone edits the file underneath it anyway.
	const path = taskDocumentPath(harness.root, FIRST_SET);
	const tampered = readFileSync(path, "utf8").replace("flip the flag", "flip the switch");
	writeFileSync(path, tampered);

	const refused = await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});
	assert.equal(refused.isError, true);
	assert.equal(refused.payload.status, "recovery_required");
	assert.equal(readFileSync(path, "utf8"), tampered);

	// The read tool reports the conflict too, rather than answering from a cache.
	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.mutationsBlocked, true);
	assert.match(String(read.payload.recovery), /modified outside this package/u);
	assert.match((await harness.systemPromptAddition()) ?? "", /needs recovery/u);
});

test("a missing document offers its snapshot, and forking it never overwrites anything", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const path = taskDocumentPath(harness.root, FIRST_SET);
	const saved = readFileSync(path, "utf8");
	writeFileSync(path, "");
	await harness.emit("session_start", { reason: "startup" });
	assert.match(harness.controller.recoveryState?.reason ?? "", /unreadable/u);
	assert.equal(harness.controller.recoveryState?.snapshotRevision, 1);

	// Put the (empty) document back the way recovery found it, then fork.
	await harness.controller.recoverForkSnapshot(harness.ctx);
	const forked = harness.controller.attachedSet;
	assert.ok(forked);
	assert.notEqual(forked.taskSetId, FIRST_SET);
	assert.equal(forked.revision, 1);
	assert.match(forked.label ?? "", /recovered/u);
	assert.equal(readFileSync(path, "utf8"), "");
	assert.equal(saved.length > 0, true);
	assert.equal(harness.controller.recoveryState, undefined);
});

test("archive refuses while work is open, then files the set and detaches", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	assert.equal(await harness.controller.archive(harness.ctx), false);
	assert.ok(harness.notifications.some((entry) => /still open/u.test(entry.message)));

	await updateTasks(harness, {
		mode: "apply",
		changes: [
			{ op: "done", taskId: "t1", summary: "done" },
			{ op: "done", taskId: "t2", summary: "done" },
			{ op: "done", taskId: "t3", summary: "done" },
			{ op: "abandon", taskId: "t4", summary: "moved to next quarter" },
		],
	});
	assert.equal(await harness.controller.archive(harness.ctx), true);
	assert.equal(harness.controller.attachedSet, undefined);

	const archived = await loadTaskDocument(taskDocumentPath(harness.root, FIRST_SET));
	assert.equal(archived.kind, "loaded");
	assert.ok(archived.kind === "loaded" && archived.loaded.document.set.archivedAt);

	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.status, "no_task_set");
});

test("/tasks new detaches without deleting the set it leaves behind", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	await harness.controller.startNew(harness.ctx);
	assert.equal(harness.controller.attachedSet, undefined);
	assert.ok(existsSync(taskDocumentPath(harness.root, FIRST_SET)));

	// And the detach survives a restart, rather than the older entry winning.
	await harness.emit("session_start", { reason: "startup" });
	assert.equal(harness.controller.attachedSet, undefined);
});

test("tree navigation re-reads the attachment for the branch it landed on", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const attachedBranch = [...harness.branch];

	// A branch that never carried a task set carries none after navigation, and
	// the previous one is not inherited.
	harness.branch.length = 0;
	await harness.emit("session_tree", { newLeafId: "entry-1" });
	assert.equal(harness.controller.attachedSet?.taskSetId, undefined);
	assert.match(harness.notifications.at(-1)?.message ?? "", /tracks no task set/u);
	assert.equal(await harness.systemPromptAddition(), undefined);

	// Navigating back to the branch that has it re-attaches, without rewinding
	// the document: the work the later turns did is still on disk.
	harness.branch.push(...attachedBranch);
	await harness.emit("session_tree", { newLeafId: "entry-2" });
	const reattached = harness.controller.attachedSet;
	assert.equal(reattached?.taskSetId, FIRST_SET);
	assert.equal(harness.controller.recoveryState, undefined);
});

test("a branch behind the document follows it rather than rewinding the file", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const behind = [...harness.branch];
	await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "done", taskId: "t1", summary: "added it" }],
	});

	harness.branch.length = 0;
	harness.branch.push(...behind);
	await harness.emit("session_tree", { newLeafId: "entry-3" });
	assert.equal(harness.controller.recoveryState, undefined);
	assert.equal(harness.controller.attachedSet?.revision, 2);
	assert.match(documentText(harness), /- \[x\] add the revision column/u);
});

test("export writes a copy and changes nothing", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const before = documentText(harness);
	const destination = join(harness.root, "exported.md");
	assert.equal(await harness.controller.exportTasks(destination, harness.ctx), true);
	assert.match(readFileSync(destination, "utf8"), /add the revision column/u);
	assert.equal(documentText(harness), before);

	// A second export to the same path refuses rather than clobbering it.
	assert.equal(await harness.controller.exportTasks(destination, harness.ctx), false);
	assert.ok(harness.notifications.some((entry) => /already exists/u.test(entry.message)));
});

test("a set archived by another session refuses further changes here", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	await updateTasks(harness, {
		mode: "apply",
		changes: [
			{ op: "done", taskId: "t1", summary: "d" },
			{ op: "done", taskId: "t2", summary: "d" },
			{ op: "done", taskId: "t3", summary: "d" },
			{ op: "done", taskId: "t4", summary: "d" },
		],
	});
	// A second session is still attached when the first one files the set away.
	const other = createTasksHarness({ root: harness.root, branch: harness.branch });
	await other.emit("session_start", { reason: "startup" });
	assert.equal(await harness.controller.archive(harness.ctx), true);

	const refused = await updateTasks(other, {
		mode: "apply",
		changes: [{ op: "reopen", taskId: "t1" }],
	});
	assert.equal(refused.isError, true);
	assert.equal(refused.payload.status, "archived");
	assert.match(String(refused.payload.message), /\/tasks new/u);
});

