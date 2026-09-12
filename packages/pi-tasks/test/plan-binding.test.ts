import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bindPlanTasks, reconcilePlanTasks, readBoundTasks } from "../src/plan-binding.js";
import { applyTaskChanges } from "../src/changes.js";
import { commitTaskDocument } from "../src/store.js";
import { parseTaskSeed, type TaskSeed } from "../src/plan-contract.js";
const ID = "11111111-1111-4111-8111-111111111111";
const now = "2026-01-01T00:00:00.000Z";
const seed: TaskSeed = { phases: [{ name: "Build", tasks: [{ content: "one" }, { content: "two" }] }] };
async function setup(t: { after(fn: () => unknown): void }) {
	const root = await mkdtemp(join(tmpdir(), "plan-bind-")); t.after(() => rm(root, { recursive: true, force: true }));
	const input = { root, taskSetId: ID, binding: { planId: ID, specRevision: 1, digest: "a".repeat(64) }, tasks: seed, now, signal: new AbortController().signal };
	const loaded = await bindPlanTasks(input);
	return { input, loaded };
}
test("binding retries preserve allocated IDs and intervening progress; conflicting reuse refuses", async (t) => {
	const { input, loaded } = await setup(t);
	const applied = applyTaskChanges(loaded.document.set, [{ op: "done", taskId: "t1", summary: "verified" }], { now, hasExistingSet: true });
	assert.ok(applied.ok);
	await commitTaskDocument({ root: input.root, taskSetId: ID, document: { ...loaded.document, set: applied.result.set }, expectedDigest: loaded.digest, now });
	const retry = await bindPlanTasks(input);
	assert.equal(retry.document.set.revision, 2);
	assert.equal(retry.document.set.phases[0].tasks[0].status, "completed");
	assert.equal(retry.document.set.phases[0].tasks[1].id, "t2");
	await assert.rejects(bindPlanTasks({ ...input, tasks: { phases: [{ name: "Build", tasks: [{ content: "different" }] }] } }), /conflicting/u);
});
test("closed work requires explicit reopen and retains its completion history", async (t) => {
	const { input, loaded } = await setup(t);
	const closed = applyTaskChanges(loaded.document.set, [{ op: "done", taskId: "t1", summary: "tested" }], { now, hasExistingSet: true });
	assert.ok(closed.ok);
	const change = { phases: [{ id: "p1", name: "Build", tasks: [{ id: "t1", content: "changed scope" }] }] };
	assert.throws(() => reconcilePlanTasks(closed.result.set, change, now), /explicitly reopen/u);
	const reopened = reconcilePlanTasks(closed.result.set, { phases: [{ ...change.phases[0], tasks: [{ ...change.phases[0].tasks[0], reopen: true }] }] }, now);
	assert.equal(reopened.phases[0].tasks[0].status, "pending");
	assert.equal(reopened.phases[0].tasks[0].completionHistory?.[0].summary, "tested");
	assert.equal(reopened.removedTasks[0].id, "t2");
	assert.equal(reopened.nextTaskId, 3);
	assert.ok(input.root);
});
test("stale task revisions and externally restored old snapshots cannot bind", async (t) => {
	const { input, loaded } = await setup(t);
	const old = await readFile(loaded.path, "utf8");
	await assert.rejects(bindPlanTasks({ ...input, binding: { ...input.binding, specRevision: 2 }, tasks: { ...seed, expectedTaskRevision: 0 } }), /stale tasks/u);
	await bindPlanTasks({ ...input, binding: { ...input.binding, specRevision: 2 }, tasks: { ...seed, expectedTaskRevision: 1 } });
	await writeFile(loaded.path, old);
	await assert.rejects(readBoundTasks(input.root, ID), /behind retained history/u);
});
test("duplicate identities and caller-chosen unknown identities are refused", async (t) => {
	const { loaded } = await setup(t);
	assert.throws(() => parseTaskSeed({ phases: [{ id: "p1", name: "x", tasks: [{ id: "t1", content: "x" }, { id: "t1", content: "y" }] }] }), /duplicate/u);
	assert.throws(() => reconcilePlanTasks(loaded.document.set, { phases: [{ id: "p99", name: "x", tasks: [] }] }, now), /unknown phase/u);
});
