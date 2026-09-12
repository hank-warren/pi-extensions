/**
 * Approval binds to bytes, and every completion path asks the same question.
 *
 * The failure this guards against is the quiet one: a session reports a plan
 * implemented when nobody in that session ever agreed to the plan it actually
 * implemented — because the state entry predates managed approval, or because the
 * file changed after the user said yes. Both read as "unknown", which is
 * deliberately not "approved", and the way out of either is a decision a person
 * makes rather than a tool authorising itself.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { evaluatePlanApproval } from "../src/plan-approval.js";
import { readPlanFile, writePlanFile } from "../src/plan-file.js";
import {
	digestOf,
	planRevisionsRoot,
	readPlanManifest,
	readPlanSnapshot,
} from "../src/revision-store.js";
import type { PlanModeState } from "../src/state.js";
import {
	callTool,
	createRevisionHarness,
	FIRST_PLAN,
	implementPlan,
	type RevisionHarness,
	runPlanCommand,
} from "./support/revision-harness.js";

const DIGEST = digestOf("# Plan\n");
const OTHER = digestOf("# Other\n");

function stateOf(harness: RevisionHarness) {
	const state = harness.state();
	assert.ok(state);
	return state as Record<string, unknown>;
}

function planPath(harness: RevisionHarness): string {
	return String(stateOf(harness).planPath);
}

function implementedTool(harness: RevisionHarness) {
	const execute = harness.tools.get("plan_implemented")?.execute as (
		...args: unknown[]
	) => Promise<unknown>;
	assert.ok(execute);
	return execute;
}

test("approval is a digest comparison, and every other state is named", () => {
	const base: PlanModeState = { enabled: false, awaitingAction: false, planPath: "/tmp/plan.md" };
	assert.deepEqual(evaluatePlanApproval({ enabled: false, awaitingAction: false }, DIGEST), {
		kind: "none",
	});
	assert.deepEqual(evaluatePlanApproval(base, undefined), { kind: "missing" });
	assert.deepEqual(evaluatePlanApproval(base, DIGEST), { kind: "unknown" });
	assert.deepEqual(evaluatePlanApproval({ ...base, approvedDigest: DIGEST }, DIGEST), {
		kind: "approved",
		digest: DIGEST,
	});
	assert.deepEqual(evaluatePlanApproval({ ...base, approvedDigest: OTHER }, DIGEST), {
		kind: "stale",
		approvedDigest: OTHER,
		currentDigest: DIGEST,
	});
	assert.deepEqual(
		evaluatePlanApproval({ ...base, enabled: true, awaitingAction: true }, DIGEST),
		{ kind: "proposed" },
	);
	assert.deepEqual(evaluatePlanApproval({ ...base, enabled: true }, DIGEST), { kind: "drafting" });
	assert.deepEqual(
		evaluatePlanApproval(
			{
				...base,
				revision: {
					revisionId: "00000000-0000-4000-8000-000000000001",
					baseRevision: 1,
					baseDigest: DIGEST,
					instructions: "x",
					startedAt: "",
					paused: "waiting",
				},
			},
			DIGEST,
		),
		{ kind: "revising", paused: "waiting" },
	);
});

test("a state entry from before managed approval is unverified, not approved", async (t) => {
	const harness = createRevisionHarness({
		branch: [
			{
				type: "custom",
				customType: "plan-mode-state",
				// Exactly what an earlier version wrote: no schemaVersion, no digest.
				data: { enabled: false, awaitingAction: false, planPath: "PLACEHOLDER" },
			},
		],
	});
	t.after(harness.cleanup);
	// The branch entry has to name the real per-session path, which depends on the
	// scratch agent dir the harness just created.
	const { planFilePathForSession } = await import("../src/plan-file.js");
	const path = planFilePathForSession("revision-test-session");
	(harness.branch[0] as { data: { planPath: string } }).data.planPath = path;
	await writePlanFile(path, FIRST_PLAN);

	await harness.emit("session_start", { reason: "resume" });
	assert.equal(harness.statuses.get("plan-mode"), "▶ plan · unverified → /plan");

	const prompt = (await harness.systemPromptAddition()) ?? "";
	assert.match(prompt, /no record of the exact plan bytes that were approved/u);
	assert.match(prompt, /Confirm the plan file/u);

	await assert.rejects(
		implementedTool(harness)("call", {}, undefined, undefined, harness.ctx),
		/no record of the exact plan bytes/u,
	);
	// And the plan file is still exactly where it was: an unknown approval
	// preserves the plan rather than discarding it.
	assert.equal(await readPlanFile(path), `${FIRST_PLAN}\n`);
});

test("confirming the plan file records the approval and its history, then completion works", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);
	// Somebody edited the plan after it was approved.
	await writePlanFile(planPath(harness), "# Hand-edited plan");
	await runPlanCommand(harness, "done");
	assert.match(harness.notifications.at(-1)?.message ?? "", /changed after it was approved/u);
	assert.equal(stateOf(harness).planPath, planPath(harness), "nothing was archived");

	// The /plan menu is where that is resolved.
	await runPlanCommand(harness, "");
	const menu = harness.activeMenuCalls.at(-1) as {
		approvalNotice?: string;
		confirmPlan?: () => Promise<void>;
	};
	assert.match(String(menu.approvalNotice), /changed after it was approved/u);
	await menu.confirmPlan?.();

	const state = stateOf(harness);
	assert.equal(state.approvedDigest, digestOf("# Hand-edited plan\n"));
	assert.equal(state.specRevision, 2, "the confirmed bytes are recorded as a revision");
	assert.equal(
		await readPlanSnapshot(planRevisionsRoot(), String(state.planId), 2),
		"# Hand-edited plan\n",
	);
	assert.equal(harness.statuses.get("plan-mode"), "▶ plan · implementing");

	await runPlanCommand(harness, "done");
	assert.match(harness.notifications.at(-1)?.message ?? "", /Plan implemented/u);
	assert.equal(stateOf(harness).planPath, undefined);
});

test("an external edit invalidates approval at the next turn boundary", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);
	assert.equal(harness.statuses.get("plan-mode"), "▶ plan · implementing");

	const before = (await harness.systemPromptAddition()) ?? "";
	assert.ok(!before.includes("changed after it was approved"));

	await writePlanFile(planPath(harness), "# Someone else rewrote this");
	const after = (await harness.systemPromptAddition()) ?? "";
	// The very next turn tells the model the truth, and the footer tells the user.
	assert.match(after, /changed after it was approved/u);
	assert.match(after, /update_plan/u);
	assert.equal(harness.statuses.get("plan-mode"), "▶ plan · unverified → /plan");
});

test("every completion entry point shares the one guarded path", async (t) => {
	for (const finish of ["tool", "command", "menu"] as const) {
		const harness = createRevisionHarness();
		try {
			await implementPlan(harness);
			await writePlanFile(planPath(harness), "# Changed after approval");
			const plansDirectory = join(planPath(harness), "..");
			const before = await readFile(planPath(harness), "utf8");

			if (finish === "tool") {
				await assert.rejects(
					implementedTool(harness)("call", {}, undefined, undefined, harness.ctx),
					/changed after it was approved/u,
					finish,
				);
			} else if (finish === "command") {
				await runPlanCommand(harness, "done");
				assert.match(harness.notifications.at(-1)?.message ?? "", /changed after it was approved/u);
			} else {
				await runPlanCommand(harness, "");
				const menu = harness.activeMenuCalls.at(-1) as { done?: () => Promise<unknown> };
				await menu.done?.();
				assert.match(harness.notifications.at(-1)?.message ?? "", /changed after it was approved/u);
			}
			// Nothing was archived by any of them.
			assert.equal(stateOf(harness).planPath, planPath(harness), finish);
			assert.equal(await readFile(planPath(harness), "utf8"), before, finish);
			const archives = (await readdir(plansDirectory)).filter((name) => /\.\d+\.md$/u.test(name));
			assert.deepEqual(archives, [], finish);
		} finally {
			harness.cleanup();
		}
	}
});

test("plan_implemented still takes no arguments", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	const tool = harness.tools.get("plan_implemented");
	assert.deepEqual(tool?.parameters, {
		type: "object",
		additionalProperties: false,
		properties: {},
	});
	await implementPlan(harness);
	const result = await callTool(harness, "plan_implemented", {});
	assert.equal(result.isError, false);
});

test("clearing the active plan keeps the recorded revision history", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);
	const planId = String(stateOf(harness).planId);
	assert.equal((await readPlanManifest(planRevisionsRoot(), planId)).kind, "loaded");

	await runPlanCommand(harness, "exit");
	const state = stateOf(harness);
	assert.equal(state.planPath, undefined);
	// The session's pointer and its inherited approval go; the record does not.
	assert.equal(state.planId, undefined);
	assert.equal(state.approvedDigest, undefined);
	assert.equal(state.specRevision, undefined);
	assert.equal((await readPlanManifest(planRevisionsRoot(), planId)).kind, "loaded");
	assert.equal(await readPlanSnapshot(planRevisionsRoot(), planId, 1), `${FIRST_PLAN}\n`);
});

test("finishing one plan does not leave its approval behind for the next", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);
	const firstPlanId = String(stateOf(harness).planId);
	await runPlanCommand(harness, "done");
	const cleared = stateOf(harness);
	assert.equal(cleared.approvedDigest, undefined);
	assert.equal(cleared.planId, undefined);

	// A second plan in the same session starts from nothing inherited.
	await runPlanCommand(harness, "start");
	await callTool(harness, "plan_mode_complete", { plan: "# A different plan" });
	const second = stateOf(harness);
	assert.equal(second.approvedDigest, undefined);
	assert.equal(second.planId, undefined);
	assert.notEqual(second.planPath, undefined);
	// The first plan's history is still its own.
	assert.equal(await readPlanSnapshot(planRevisionsRoot(), firstPlanId, 1), `${FIRST_PLAN}\n`);
});
