/**
 * Feedback, replacement, and what happens to the candidate that was replaced.
 *
 * "Request changes → propose again" is the plan's normal revision loop, so the
 * predecessor has to be retired by it. Left pending, it would be the candidate
 * `/tasks review` reopens — the exact content the user asked to change — and it
 * would keep telling every later turn's system prompt that a revision is
 * awaiting review, with Cancel the only way out.
 *
 * Retired does not mean deleted. Every case below checks both directions: the
 * obsolete candidate can no longer be published or reopened, and its content is
 * still on disk to read or re-propose.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { listPendingProposals, listProposals } from "../src/proposals.js";
import { taskDocumentPath } from "../src/store.js";
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

const FIRST_DRAFT = {
	mode: "propose",
	reason: "drop everything after the schema phase",
	changes: [
		{ op: "remove_task", taskId: "t3" },
		{ op: "remove_task", taskId: "t4" },
	],
} as const;

const CORRECTED = {
	mode: "propose",
	reason: "keep the migration work; drop only the cutover phase",
	changes: [{ op: "remove_task", taskId: "t4" }],
} as const;

function runCommand(harness: TasksHarness, args: string): Promise<void> {
	const command = harness.commands.get("tasks");
	assert.ok(command);
	return command.handler(args, harness.ctx) as Promise<void>;
}

test("a corrected proposal replaces its predecessor durably, keeping its content", async (t) => {
	const harness = await seeded({
		reviews: [{ kind: "changes_requested", feedback: "keep the migration work" }, { kind: "dismissed" }],
	});
	t.after(harness.cleanup);

	const first = await updateTasks(harness, FIRST_DRAFT);
	assert.equal(first.payload.status, "changes_requested");
	const second = await updateTasks(harness, CORRECTED);
	assert.equal(second.payload.status, "pending_review");

	const all = await listProposals(harness.root, FIRST_SET);
	assert.equal(all.length, 2);
	const replaced = all.find((entry) => entry.proposalId === first.payload.proposalId);
	const replacement = all.find((entry) => entry.proposalId === second.payload.proposalId);
	assert.equal(replaced?.status, "superseded");
	assert.equal(replaced?.supersededBy, replacement?.proposalId);
	assert.equal(replacement?.status, "pending");
	// The rejected draft is retired, not erased.
	assert.equal(replaced?.reason, FIRST_DRAFT.reason);
	assert.ok(replaced?.proposedDocument.length);
});

test("after a replacement, /tasks review reopens the corrected candidate", async (t) => {
	const harness = await seeded({
		reviews: [
			{ kind: "changes_requested", feedback: "keep the migration work" },
			{ kind: "dismissed" },
			{ kind: "accepted" },
		],
	});
	t.after(harness.cleanup);
	await updateTasks(harness, FIRST_DRAFT);
	const second = await updateTasks(harness, CORRECTED);
	assert.equal(second.payload.status, "pending_review");

	await runCommand(harness, "review");
	// The third review is the one /tasks review opened: it must be the corrected
	// draft, never the one the user rejected.
	assert.equal(harness.reviewRequests.at(-1)?.reason, CORRECTED.reason);
	assert.equal(harness.controller.attachedSet?.revision, 2);

	// The corrected draft removed only t4; the rejected one would also have
	// removed t3, so this is what distinguishes "published the right thing".
	const tasks = harness.controller.attachedSet?.phases.flatMap((phase) =>
		phase.tasks.map((task) => task.id),
	);
	assert.deepEqual(tasks, ["t1", "t2", "t3"]);
});

test("accepting a replacement leaves no pending state latched behind it", async (t) => {
	const harness = await seeded({
		reviews: [{ kind: "changes_requested", feedback: "keep the migration work" }, { kind: "accepted" }],
	});
	t.after(harness.cleanup);
	await updateTasks(harness, FIRST_DRAFT);
	const accepted = await updateTasks(harness, CORRECTED);
	assert.equal(accepted.payload.status, "accepted");

	assert.deepEqual(await listPendingProposals(harness.root, FIRST_SET), []);
	assert.deepEqual(harness.controller.pending, []);
	// The sentence that would otherwise appear in every later turn is gone.
	const pointer = (await harness.systemPromptAddition()) ?? "";
	assert.equal(pointer.includes("waiting for the user's review"), false);
	const read = await callTool(harness, "get_tasks", {});
	assert.deepEqual(read.payload.pendingProposals, []);
});

test("a card from the replaced round cannot publish what the user rejected", async (t) => {
	const harness = await seeded({
		reviews: [{ kind: "changes_requested", feedback: "keep the migration work" }, { kind: "dismissed" }],
	});
	t.after(harness.cleanup);
	const first = await updateTasks(harness, FIRST_DRAFT);
	const rejectedDraft = (await listProposals(harness.root, FIRST_SET)).find(
		(entry) => entry.proposalId === first.payload.proposalId,
	);
	assert.ok(rejectedDraft);
	await updateTasks(harness, CORRECTED);
	const before = documentText(harness);

	// The user still has the old card on screen and picks Accept on it.
	const refused = await harness.controller.acceptProposal(rejectedDraft, harness.ctx);
	assert.equal(refused.isError, true);
	assert.equal(refused.payload.status, "stale_proposal");
	assert.equal(refused.payload.persistedStatus, "superseded");
	assert.ok(refused.payload.supersededBy);
	assert.equal(documentText(harness), before);
});

test("a replacement survives a restart, and the restart picks the right candidate", async (t) => {
	const harness = await seeded({
		reviews: [
			{ kind: "changes_requested", feedback: "keep the migration work" },
			{ kind: "dismissed" },
			{ kind: "accepted" },
		],
	});
	t.after(harness.cleanup);
	await updateTasks(harness, FIRST_DRAFT);
	await updateTasks(harness, CORRECTED);

	await harness.emit("session_shutdown", { reason: "quit" });
	await harness.emit("session_start", { reason: "startup" });

	assert.equal(harness.controller.pending.length, 1);
	assert.equal(harness.controller.pending[0]?.reason, CORRECTED.reason);
	await runCommand(harness, "review");
	assert.equal(harness.reviewRequests.at(-1)?.reason, CORRECTED.reason);
	assert.equal(harness.controller.attachedSet?.revision, 2);
});

test("two pending candidates left by an interrupted transition converge on the newer one", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "dismissed" }, { kind: "dismissed" }] });
	t.after(harness.cleanup);

	// Simulate the crash window: the replacement was published and the process
	// died before the predecessor could be retired. Writing both directly is the
	// only way to reach that state, because the controller never leaves it.
	const { writeProposal } = await import("../src/proposals.js");
	const base = harness.controller.attachedSet;
	assert.ok(base);
	const first = await updateTasks(harness, FIRST_DRAFT);
	const stored = (await listProposals(harness.root, FIRST_SET))[0];
	assert.ok(stored);
	await writeProposal(harness.root, {
		...stored,
		proposalId: "11111111-1111-4111-8111-111111111111",
		createdAt: "2026-06-01T00:00:00.000Z",
		reason: "the replacement that was published before the crash",
	});
	assert.equal((await listPendingProposals(harness.root, FIRST_SET)).length, 2);

	// Any read converges: the newest wins, the other is retired with its content.
	await callTool(harness, "get_tasks", {});
	assert.equal(harness.controller.pending.length, 1);
	assert.equal(harness.controller.pending[0]?.proposalId, "11111111-1111-4111-8111-111111111111");
	const retired = (await listProposals(harness.root, FIRST_SET)).find(
		(entry) => entry.proposalId === first.payload.proposalId,
	);
	assert.equal(retired?.status, "superseded");
	assert.ok(retired?.proposedDocument.length);
});

test("an obsolete candidate never blocks the prompt or the widget forever", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "dismissed" }] });
	t.after(harness.cleanup);
	await updateTasks(harness, CORRECTED);
	assert.match((await harness.systemPromptAddition()) ?? "", /waiting for the user's review/u);

	// Ordinary progress moves the base past the candidate. It can never be
	// published again, so it stops driving the review state.
	await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});
	assert.deepEqual(harness.controller.pending, []);
	const pointer = (await harness.systemPromptAddition()) ?? "";
	assert.equal(pointer.includes("waiting for the user's review"), false);
	assert.equal(harness.controller.uiState.pendingReview, false);

	// And it is still there to read, so nothing the agent drafted is lost.
	const kept = (await listProposals(harness.root, FIRST_SET))[0];
	assert.equal(kept?.status, "superseded");
	assert.equal(kept?.reason, CORRECTED.reason);
});
