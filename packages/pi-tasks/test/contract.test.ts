/**
 * The contract an existing-set batch has to satisfy, and the three places where
 * trusting the wrong input would be expensive.
 *
 * Identity and expected revision are required for anything but `init`. The
 * digest recheck under the lock already prevents a lost update, so this is not
 * about data loss: it is about the agent's *intent*. A batch composed against
 * revision 3 and quietly applied to revision 4 is a batch that was never
 * reviewed against the world it landed in, and nobody finds out.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { serializeTaskDocument } from "../src/markdown.js";
import { listProposals, writeProposal } from "../src/proposals.js";
import { digestOf, taskDocumentPath } from "../src/store.js";
import {
	callTool,
	createTasksHarness,
	currentIdentity,
	SEED_INIT,
	type TasksHarness,
	updateTasks,
} from "./support/harness.js";

const FIRST_SET = "00000000-0000-4000-8000-000000000001";
const OTHER_SET = "00000000-0000-4000-8000-000000000099";

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

test("an existing-set batch without taskSetId is refused, and names the one to use", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const before = documentText(harness);

	const refused = await callTool(harness, "update_tasks", {
		mode: "apply",
		expectedRevision: 1,
		changes: [{ op: "start", taskId: "t1" }],
	});
	assert.equal(refused.isError, true);
	assert.equal(refused.payload.status, "missing_identity");
	assert.equal(refused.payload.taskSetId, FIRST_SET);
	assert.match(String(refused.payload.message), /get_tasks/u);
	assert.equal(documentText(harness), before);
});

test("an existing-set batch without expectedRevision is refused, not rebased", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const before = documentText(harness);

	const refused = await callTool(harness, "update_tasks", {
		mode: "apply",
		taskSetId: FIRST_SET,
		changes: [{ op: "start", taskId: "t1" }],
	});
	assert.equal(refused.isError, true);
	assert.equal(refused.payload.status, "missing_expected_revision");
	assert.equal(refused.payload.currentRevision, 1);
	assert.match(String(refused.payload.message), /refused instead of rebased/u);
	assert.equal(documentText(harness), before);
});

test("a proposal without identity is refused before any candidate is written", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const refused = await callTool(harness, "update_tasks", {
		mode: "propose",
		reason: "drop the cutover phase",
		changes: [{ op: "remove_task", taskId: "t4" }],
	});
	assert.equal(refused.payload.status, "missing_identity");
	assert.deepEqual(await listProposals(harness.root, FIRST_SET), []);
	assert.deepEqual(harness.reviewRequests, []);
});

test("init needs neither, because it is what allocates them", async (t) => {
	const harness = createTasksHarness();
	t.after(harness.cleanup);
	await harness.emit("session_start", { reason: "startup" });
	const created = await callTool(harness, "update_tasks", { mode: "apply", changes: [SEED_INIT] });
	assert.equal(created.payload.status, "applied");
	assert.equal(created.payload.taskSetId, FIRST_SET);
});

test("get_tasks reports exactly what the next update_tasks has to quote back", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const read = await callTool(harness, "get_tasks", {});
	assert.deepEqual(read.payload.updateRequires, { taskSetId: FIRST_SET, expectedRevision: 1 });

	const applied = await callTool(harness, "update_tasks", {
		...(read.payload.updateRequires as Record<string, unknown>),
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});
	assert.equal(applied.payload.status, "applied");
});

test("a tampered proposal cannot redirect publication into another task set", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "dismissed" }] });
	t.after(harness.cleanup);
	await updateTasks(harness, {
		mode: "propose",
		reason: "drop the cutover phase",
		changes: [{ op: "remove_task", taskId: "t4" }],
	});
	const pending = (await listProposals(harness.root, FIRST_SET))[0];
	assert.ok(pending);
	const before = documentText(harness);

	// A second managed set, which the tampered proposal will try to overwrite.
	const victimDocument = before.replace(FIRST_SET, OTHER_SET);
	mkdirSync(join(harness.root, OTHER_SET), { recursive: true });
	writeFileSync(taskDocumentPath(harness.root, OTHER_SET), victimDocument);

	// The proposal's own bytes now claim the other set. Accepting it must not
	// write there, and must not be publishable at all.
	await writeProposal(harness.root, {
		...pending,
		proposedDocument: pending.proposedDocument.replace(FIRST_SET, OTHER_SET),
	});
	const refused = await harness.controller.acceptProposal(pending, harness.ctx);
	assert.equal(refused.isError, true);
	assert.equal(refused.payload.status, "invalid_proposal");
	// Neither the set it named nor the set it came from was touched.
	assert.equal(readFileSync(taskDocumentPath(harness.root, OTHER_SET), "utf8"), victimDocument);
	assert.equal(documentText(harness), before);
});

test("a proposal whose stored bytes changed under the card is refused", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "dismissed" }] });
	t.after(harness.cleanup);
	await updateTasks(harness, {
		mode: "propose",
		reason: "drop the cutover phase",
		changes: [{ op: "remove_task", taskId: "t4" }],
	});
	const pending = (await listProposals(harness.root, FIRST_SET))[0];
	assert.ok(pending);
	const before = documentText(harness);

	// Same id and status, different proposed content than the card in hand.
	const attached = harness.controller.attachedSet;
	assert.ok(attached);
	const tampered = serializeTaskDocument({
		set: { ...attached, label: "not what was reviewed" },
		extras: [],
	});
	await writeProposal(harness.root, { ...pending, proposedDocument: tampered });

	const refused = await harness.controller.acceptProposal(pending, harness.ctx);
	assert.equal(refused.isError, true);
	assert.equal(refused.payload.status, "stale_proposal");
	assert.match(String(refused.payload.message), /no longer matches the one under review/u);
	assert.equal(documentText(harness), before);
});

test("a durable attachment write failure is reported, not swallowed", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	// A real failure mode: the session refuses the entry after the revision is
	// already on disk, so the document and this session's pointer disagree.
	(harness.pi as unknown as { appendEntry: (type: string, data: unknown) => void }).appendEntry =
		() => {
			throw new Error("session is read-only");
		};

	const applied = await updateTasks(harness, {
		mode: "apply",
		changes: [{ op: "start", taskId: "t1" }],
	});
	assert.equal(applied.payload.status, "applied");
	assert.equal(applied.payload.revision, 2);
	// The warning rides out on the tool result and on the next read...
	assert.match(String(applied.payload.attachmentWarning), /session is read-only/u);
	assert.match(String(applied.payload.attachmentWarning), /\/tasks recover/u);
	// ...and the user is told, rather than left to discover it after a restart.
	assert.ok(
		harness.notifications.some(
			(entry) => entry.level === "error" && /could not record that pointer/u.test(entry.message),
		),
	);
	const read = await callTool(harness, "get_tasks", {});
	assert.match(String(read.payload.attachmentWarning), /session is read-only/u);
});

test("a recovery fork drops the plan binding it inherited", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);

	// Nothing in layer 1 sets a binding, so it is written into the snapshot by
	// hand: the point is what the fork does with one, not how it got there.
	const set = harness.controller.attachedSet;
	assert.ok(set);
	const bound = serializeTaskDocument({
		set: {
			...set,
			binding: { planId: "plan-7", specRevision: 4, digest: digestOf("the reviewed plan") },
		},
		extras: [],
	});
	writeFileSync(join(harness.root, FIRST_SET, "revisions", "1.md"), bound);
	writeFileSync(taskDocumentPath(harness.root, FIRST_SET), "");
	await harness.emit("session_start", { reason: "startup" });
	assert.ok(harness.controller.recoveryState);

	await harness.controller.recoverForkSnapshot(harness.ctx);
	const forked = harness.controller.attachedSet;
	assert.ok(forked);
	assert.notEqual(forked.taskSetId, FIRST_SET);
	// The fork is a new set that no plan ever bound; carrying the claim across
	// would let it answer for a plan revision it was never reviewed against.
	assert.equal(forked.binding, undefined);
	assert.match(forked.label ?? "", /recovered/u);
	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.binding, undefined);
});

test("the identity a batch must carry is the attached one, and only that one", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	const identity = currentIdentity(harness);
	assert.deepEqual(identity, { taskSetId: FIRST_SET, expectedRevision: 1 });

	const wrong = await callTool(harness, "update_tasks", {
		mode: "apply",
		taskSetId: OTHER_SET,
		expectedRevision: 1,
		changes: [{ op: "start", taskId: "t1" }],
	});
	assert.equal(wrong.isError, true);
	assert.equal(wrong.payload.status, "wrong_task_set");
});
