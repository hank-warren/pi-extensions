/**
 * What happens when the turn, or the session, goes away while a review is open.
 *
 * The review card is opened from inside the tool call, which is what makes the
 * flow conversational — and which is exactly why the tool's own abort has to
 * reach it. `Esc` ends the turn; a card that keeps owning the input after that,
 * and can still publish a revision into a turn nobody is waiting on, is the
 * failure this file exists to prevent.
 *
 * The other half is the late answer. A decision that arrives after the session
 * was replaced, or after this session moved to a different task set, is not a
 * decision: acting on it would write one set's content through another set's
 * attachment. Every case below asserts both halves — nothing was published, and
 * the proposal is still on file and still unapproved.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { listProposals } from "../src/proposals.js";
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

const PROPOSE = {
	mode: "propose",
	reason: "drop the cutover phase",
	changes: [{ op: "remove_task", taskId: "t4" }],
} as const;

test("a turn interrupted before the card opens neither publishes nor asks", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "accepted" }] });
	t.after(harness.cleanup);
	const before = documentText(harness);
	const controller = new AbortController();
	controller.abort();

	const result = await updateTasks(harness, PROPOSE, controller.signal);
	assert.equal(result.payload.status, "cancelled");
	assert.deepEqual(harness.reviewRequests, [], "no card may be shown for an aborted turn");
	assert.equal(documentText(harness), before);
	assert.deepEqual(await listProposals(harness.root, FIRST_SET), []);
});

test("an apply interrupted before the write leaves the task set untouched", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const before = documentText(harness);
	const controller = new AbortController();
	controller.abort();

	const result = await updateTasks(
		harness,
		{ mode: "apply", changes: [{ op: "start", taskId: "t1" }] },
		controller.signal,
	);
	assert.equal(result.payload.status, "cancelled");
	assert.equal(documentText(harness), before);
});

test("the card is opened with a signal that Esc aborts", async (t) => {
	const controller = new AbortController();
	const harness = await seeded({
		onReview: () => {
			// Mid-dialog interrupt: the turn ends while the human is still reading.
			controller.abort();
			return { kind: "dismissed" };
		},
	});
	t.after(harness.cleanup);

	const result = await updateTasks(harness, PROPOSE, controller.signal);
	assert.equal(result.payload.status, "pending_review");
	// The menu really was handed a signal, and that signal really does fire:
	// without this the card would keep owning the input after the turn ended.
	const signal = harness.reviewSignals[0];
	assert.ok(signal, "the review must be opened with a cancellation signal");
	assert.equal(signal.aborted, true);
});

test("an acceptance that arrives after the turn was interrupted does not publish", async (t) => {
	const controller = new AbortController();
	const harness = await seeded({
		onReview: () => {
			// The user pressed Esc, and only then chose Accept on the orphaned card.
			controller.abort();
			return { kind: "accepted" };
		},
	});
	t.after(harness.cleanup);
	const before = documentText(harness);

	const result = await updateTasks(harness, PROPOSE, controller.signal);
	assert.equal(result.payload.status, "pending_review");
	assert.equal(documentText(harness), before, "an aborted review must not publish a revision");
	// The work is not lost: the candidate is on file and still unapproved.
	assert.deepEqual(
		(await listProposals(harness.root, FIRST_SET)).map((entry) => entry.status),
		["pending"],
	);
});

test("an acceptance that arrives after the session was replaced does not publish", async (t) => {
	let harness: TasksHarness | undefined;
	harness = await seeded({
		onReview: async () => {
			// Pi replaced the session while the card was up.
			await harness?.emit("session_start", { reason: "resume" });
			return { kind: "accepted" };
		},
	});
	t.after(() => harness?.cleanup());
	const before = documentText(harness);

	const result = await updateTasks(harness, PROPOSE);
	assert.equal(result.payload.status, "pending_review");
	assert.equal(documentText(harness), before);
	assert.deepEqual(
		(await listProposals(harness.root, FIRST_SET)).map((entry) => entry.status),
		["pending"],
	);
});

test("an acceptance that arrives after this session moved to another set does not publish", async (t) => {
	let harness: TasksHarness | undefined;
	harness = await seeded({
		onReview: async () => {
			// `/tasks new` while the card was up: the session now owns nothing, and
			// the decision belongs to an attachment that is gone.
			await harness?.controller.startNew(harness.ctx);
			return { kind: "accepted" };
		},
	});
	t.after(() => harness?.cleanup());
	const before = documentText(harness);

	const result = await updateTasks(harness, PROPOSE);
	assert.equal(result.payload.status, "pending_review");
	assert.equal(documentText(harness), before);
	assert.equal(harness.controller.attachedSet, undefined);
});

test("a dismissed review keeps its content, and /tasks review can still decide it", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "dismissed" }, { kind: "accepted" }] });
	t.after(harness.cleanup);

	const dismissed = await updateTasks(harness, PROPOSE);
	assert.equal(dismissed.payload.status, "pending_review");
	const saved = (await listProposals(harness.root, FIRST_SET))[0];
	assert.equal(saved?.status, "pending");

	const command = harness.commands.get("tasks");
	assert.ok(command);
	await command.handler("review", harness.ctx);
	assert.equal(harness.controller.attachedSet?.revision, 2);
	assert.deepEqual(
		(await listProposals(harness.root, FIRST_SET)).map((entry) => entry.status),
		["accepted"],
	);
});

test("acceptProposal refuses outright once its own scope is stale", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "dismissed" }] });
	t.after(harness.cleanup);
	await updateTasks(harness, PROPOSE);
	const pending = (await listProposals(harness.root, FIRST_SET))[0];
	assert.ok(pending);
	const before = documentText(harness);

	// The session is replaced, then a leftover card tries to publish.
	await harness.emit("session_shutdown", { reason: "quit" });
	const refused = await harness.controller.acceptProposal(pending, harness.ctx);
	assert.equal(refused.isError, true);
	assert.equal(refused.payload.status, "cancelled");
	assert.equal(documentText(harness), before);
});
