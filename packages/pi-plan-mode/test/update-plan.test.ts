/**
 * `update_plan`, end to end through the registered tool.
 *
 * The behaviour this package exists to guarantee is that a conversational "change
 * the plan" becomes two tool calls and one human decision — never an instruction
 * to edit Markdown, never a command to type, and never an approval nobody gave.
 * So every case here goes through the tool as the model would call it, and checks
 * what landed on disk and in session state afterwards.
 *
 * Two invariants get their own cases because they are the ones that would
 * deadlock or mislead rather than merely fail: the review card runs inside the
 * tool call and must never wait on this session's own idle state, and a decision
 * that arrives after the turn it belongs to is not a decision.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { readPlanFile, writePlanFile } from "../src/plan-file.js";
import {
	digestOf,
	listPendingPlanProposals,
	listPlanProposals,
	planRevisionsRoot,
	readPlanManifest,
	readPlanSnapshot,
} from "../src/revision-store.js";
import { normalizeUpdatePlan, UPDATE_PLAN_PARAMS } from "../src/update-plan-tool.js";
import {
	callTool,
	createRevisionHarness,
	draftPlan,
	FIRST_PLAN,
	implementPlan,
	REVISED_PLAN,
	type RevisionHarness,
	runPlanCommand,
} from "./support/revision-harness.js";

const INSTRUCTIONS = "change the deployment approach but keep the migration work";
const SUMMARY = "replaced blue/green with a rolling restart; the migration steps are unchanged";

function planPath(harness: RevisionHarness): string {
	const state = harness.state();
	return String(state?.planPath);
}

function stateOf(harness: RevisionHarness) {
	const state = harness.state();
	assert.ok(state, "expected persisted plan state");
	return state as {
		enabled: boolean;
		awaitingAction: boolean;
		planPath?: string;
		planId?: string;
		specRevision?: number;
		currentDigest?: string;
		approvedDigest?: string;
		revision?: { revisionId: string; baseRevision: number; proposalId?: string; paused?: string };
	};
}

async function begin(
	harness: RevisionHarness,
	overrides: Record<string, unknown> = {},
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
	return callTool(harness, "update_plan", {
		action: "begin",
		expectedRevision: 0,
		instructions: INSTRUCTIONS,
		...overrides,
	});
}

/**
 * The recovery door: `/plan` opens the revision menu, and "Review the proposed
 * revision" reopens the card. Deliberately not the normal path — the normal path
 * is the card that opened from the tool call itself.
 */
async function reopenReview(harness: RevisionHarness): Promise<void> {
	await runPlanCommand(harness, "");
	const menu = harness.planMenuCalls.at(-1) as {
		hasPendingRevision?: boolean;
		reviewRevision?: () => Promise<void>;
	};
	assert.equal(menu.hasPendingRevision, true, "the menu must offer the waiting review");
	await menu.reviewRevision?.();
}

async function propose(
	harness: RevisionHarness,
	overrides: Record<string, unknown> = {},
	signal?: AbortSignal,
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
	const revision = stateOf(harness).revision;
	assert.ok(revision, "expected an open revision transaction");
	return callTool(
		harness,
		"update_plan",
		{
			action: "propose",
			revisionId: revision.revisionId,
			expectedRevision: revision.baseRevision,
			plan: REVISED_PLAN,
			changeSummary: SUMMARY,
			...overrides,
		},
		signal,
	);
}

test("the tool is registered under exactly one name, with a flat two-action schema", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	assert.ok(harness.tools.has("update_plan"));
	for (const absent of ["plan_revision_start", "revise_plan", "plan_edit"]) {
		assert.equal(harness.tools.has(absent), false, absent);
	}
	assert.deepEqual(UPDATE_PLAN_PARAMS.properties.action.enum, ["begin", "propose"]);
	assert.deepEqual(Object.keys(UPDATE_PLAN_PARAMS.properties), [
		"action",
		"expectedRevision",
		"instructions",
		"revisionId",
		"plan",
		"changeSummary",
	]);
	const tool = harness.tools.get("update_plan");
	assert.match(String(tool?.description), /action "begin"/u);
	const guidelines = (tool?.promptGuidelines as string[]).join(" ");
	assert.match(guidelines, /never tell the user to edit the plan file themselves/u);
	// The final-standalone-action convention belongs to propose, not to begin.
	assert.match(guidelines, /Action "propose" is the closing one: call it alone as the final action/u);
});

test("the discriminated shape is validated by branch, with correctable refusals", () => {
	assert.deepEqual(normalizeUpdatePlan({ action: "nope", expectedRevision: 1 }), {
		ok: false,
		error: 'action must be "begin" or "propose"',
	});
	const missingRevision = normalizeUpdatePlan({ action: "begin", instructions: "x" });
	assert.equal(missingRevision.ok, false);
	if (missingRevision.ok === false) assert.match(missingRevision.error, /expectedRevision/u);

	const missingInstructions = normalizeUpdatePlan({ action: "begin", expectedRevision: 1 });
	assert.equal(missingInstructions.ok, false);
	if (missingInstructions.ok === false) assert.match(missingInstructions.error, /instructions/u);

	const missingPlan = normalizeUpdatePlan({
		action: "propose",
		expectedRevision: 1,
		revisionId: "r",
		changeSummary: "s",
	});
	assert.equal(missingPlan.ok, false);
	if (missingPlan.ok === false) assert.match(missingPlan.error, /requires plan/u);

	// Enum and id values arrive with trailing whitespace often enough to matter.
	assert.deepEqual(
		normalizeUpdatePlan({ action: "begin\n", expectedRevision: 0, instructions: " do it " }),
		{ ok: true, input: { action: "begin", expectedRevision: 0, instructions: "do it" } },
	);
});

test("without a plan, the tool says where plans come from instead of inventing one", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await harness.emit("session_start", { reason: "resume" });
	const result = await begin(harness);
	assert.equal(result.isError, true);
	assert.equal(result.payload.status, "no_plan");
	assert.match(String(result.payload.message), /start one with \/plan/u);

	await runPlanCommand(harness, "start");
	const drafting = await begin(harness);
	assert.equal(drafting.payload.status, "no_plan");
	assert.match(String(drafting.payload.message), /submit it with plan_mode_complete/u);
});

test("begin opens a transaction, gives the plan a history, and pauses mutation", async (t) => {
	const harness = createRevisionHarness({ activeTools: ["read", "edit"] });
	t.after(harness.cleanup);
	await implementPlan(harness);
	const approvedDigest = stateOf(harness).approvedDigest;
	assert.equal(approvedDigest, digestOf(`${FIRST_PLAN}\n`));

	const result = await begin(harness, { expectedRevision: 1 });
	assert.equal(result.isError, false, JSON.stringify(result.payload));
	assert.equal(result.payload.status, "revision_started");
	assert.equal(result.payload.baseRevision, 1);
	assert.equal(result.payload.baseDigest, approvedDigest);
	assert.equal(result.payload.planPath, planPath(harness));
	assert.match(String(result.payload.instruction), /action "propose"/u);

	const state = stateOf(harness);
	assert.equal(state.enabled, true, "planning rules are back");
	assert.equal(state.revision?.revisionId, result.payload.revisionId);
	assert.equal(state.approvedDigest, approvedDigest, "the approved baseline is retained");
	assert.equal(harness.statuses.get("plan-mode"), "◆ plan · revising");

	// The enforcement surface: from the next tool call, files are off limits, and
	// the refusal names the call that finishes the revision.
	const blocked = (await harness.emit("tool_call", { toolName: "edit" }))[0] as
		| { block?: boolean; reason?: string }
		| undefined;
	assert.equal(blocked?.block, true);
	assert.match(String(blocked?.reason), /update_plan action "propose"/u);

	// The plan file is untouched by opening a revision.
	assert.equal(await readPlanFile(planPath(harness)), `${FIRST_PLAN}\n`);
});

test("a second begin on the same base records the extra request, not a second transaction", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);
	const first = await begin(harness, { expectedRevision: 1 });
	const again = await begin(harness, {
		expectedRevision: 1,
		instructions: "also drop the feature flag",
	});
	assert.equal(again.payload.status, "revision_in_progress");
	assert.equal(again.payload.revisionId, first.payload.revisionId);
	assert.match(String(again.payload.recordedInstructions), /Also: also drop the feature flag/u);
	assert.match(String(again.payload.recordedInstructions), /change the deployment approach/u);
});

test("a stale expectedRevision is refused rather than rebased", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);
	const result = await begin(harness, { expectedRevision: 7 });
	assert.equal(result.isError, true);
	assert.equal(result.payload.status, "stale_revision");
	assert.equal(result.payload.currentRevision, 1);
	assert.equal(stateOf(harness).revision, undefined, "no transaction was opened");
});

test("a plan with no managed history is revised from revision 0", async (t) => {
	// A plan carried in from before managed revisions has no manifest. Its current
	// bytes become revision 1 when the revision opens — assigned then, never in
	// bulk at session start.
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await draftPlan(harness);
	assert.equal(stateOf(harness).specRevision, undefined);

	const result = await begin(harness, { expectedRevision: 0 });
	assert.equal(result.isError, false, JSON.stringify(result.payload));
	assert.equal(result.payload.baseRevision, 1);
	const manifest = await readPlanManifest(planRevisionsRoot(), String(result.payload.planId));
	assert.equal(manifest.kind, "loaded");
	if (manifest.kind !== "loaded") return;
	assert.equal(manifest.manifest.specRevision, 1);
	assert.equal(await readPlanSnapshot(planRevisionsRoot(), manifest.manifest.planId, 1), `${FIRST_PLAN}\n`);
});

test("plan_mode_complete refuses a revision and names the call that works", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);
	const started = await begin(harness, { expectedRevision: 1 });

	const complete = harness.tools.get("plan_mode_complete")?.execute as (
		...args: unknown[]
	) => Promise<unknown>;
	await assert.rejects(
		complete("call", { plan: REVISED_PLAN }, undefined, undefined, harness.ctx),
		(error: Error) =>
			/cannot finalize a revision/u.test(error.message) &&
			error.message.includes(String(started.payload.revisionId)),
	);
	// Refused, not half-applied: the plan file is unchanged and the transaction
	// is still the thing to finish.
	assert.equal(await readPlanFile(planPath(harness)), `${FIRST_PLAN}\n`);
	assert.equal(stateOf(harness).revision?.revisionId, started.payload.revisionId);
});

test("propose needs an open transaction, its own id, and its own base", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);

	const orphan = await callTool(harness, "update_plan", {
		action: "propose",
		revisionId: "00000000-0000-4000-8000-00000000ffff",
		expectedRevision: 1,
		plan: REVISED_PLAN,
		changeSummary: SUMMARY,
	});
	assert.equal(orphan.payload.status, "no_revision");
	assert.match(String(orphan.payload.message), /action "begin" first/u);

	await begin(harness, { expectedRevision: 1 });
	const wrongId = await propose(harness, { revisionId: "00000000-0000-4000-8000-00000000ffff" });
	assert.equal(wrongId.payload.status, "wrong_revision");
	const wrongBase = await propose(harness, { expectedRevision: 99 });
	assert.equal(wrongBase.payload.status, "stale_revision");
	assert.equal(harness.reviewRequests.length, 0, "nothing was put in front of the user");
});

test("a plan edited after the revision opened is a conflict, and begin is the way back", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);
	await begin(harness, { expectedRevision: 1 });
	await writePlanFile(planPath(harness), "# Edited by hand while the revision was open");

	const result = await propose(harness);
	assert.equal(result.isError, true);
	assert.equal(result.payload.status, "conflict");
	assert.match(String(result.payload.message), /action "begin" again/u);

	// Re-opening bases the revision on the bytes that are actually there, and says
	// that the document is no longer the recorded revision.
	const reopened = await begin(harness, { expectedRevision: 1 });
	assert.equal(reopened.payload.status, "revision_started");
	assert.match(String(reopened.payload.conflict), /changed outside Plan mode/u);
	assert.equal(
		reopened.payload.baseDigest,
		digestOf("# Edited by hand while the revision was open\n"),
	);
});

test("proposing shows the computed diff and the review decides, in the same call", async (t) => {
	const harness = createRevisionHarness({ reviews: [{ kind: "accepted" }] });
	t.after(harness.cleanup);
	await implementPlan(harness);
	await begin(harness, { expectedRevision: 1 });
	const result = await propose(harness);

	assert.equal(result.isError, false, JSON.stringify(result.payload));
	assert.equal(result.payload.status, "accepted");
	assert.equal(result.payload.revision, 2);
	// The card carried the diff this package computed, not the model's summary.
	const card = harness.reviewRequests.at(-1);
	assert.equal(card?.instructions, INSTRUCTIONS);
	assert.equal(card?.changeSummary, SUMMARY);
	assert.ok(card?.diff.some((line) => line.startsWith("-2. Deploy with blue/green.")));
	assert.ok(card?.diff.some((line) => line.startsWith("+2. Deploy with a rolling restart.")));
	assert.equal(harness.waitForIdleCalls, 0, "a tool must never wait on its own session");

	// Published: the file, the snapshot and the history all agree.
	assert.equal(await readPlanFile(planPath(harness)), `${REVISED_PLAN}\n`);
	const state = stateOf(harness);
	assert.equal(state.specRevision, 2);
	assert.equal(state.currentDigest, digestOf(`${REVISED_PLAN}\n`));
	assert.equal(await readPlanSnapshot(planRevisionsRoot(), String(state.planId), 1), `${FIRST_PLAN}\n`);
	assert.equal(await readPlanSnapshot(planRevisionsRoot(), String(state.planId), 2), `${REVISED_PLAN}\n`);

	// Current but not approved: the user is choosing what happens next, and the
	// tool result tells the model to stop rather than implement.
	assert.equal(state.approvedDigest, undefined);
	assert.equal(state.revision, undefined);
	assert.equal(state.enabled, true);
	assert.equal(state.awaitingAction, true);
	assert.match(String(result.payload.message), /not yet approved for implementation/u);
	assert.equal(harness.statuses.get("plan-mode"), "◆ plan · ready → /plan");
	assert.ok(harness.cards.some((entry) => entry.title === "Plan revision 2"));
});

test("accepting then implementing approves exactly the accepted bytes", async (t) => {
	const harness = createRevisionHarness({ reviews: [{ kind: "accepted" }] });
	t.after(harness.cleanup);
	await implementPlan(harness);
	await begin(harness, { expectedRevision: 1 });
	await propose(harness);
	await runPlanCommand(harness, "implement");

	const state = stateOf(harness);
	assert.equal(state.approvedDigest, digestOf(`${REVISED_PLAN}\n`));
	assert.equal(state.enabled, false);
	assert.equal(harness.statuses.get("plan-mode"), "▶ plan · implementing");
	// And completion is allowed again, through the tool the model owns.
	const implemented = harness.tools.get("plan_implemented")?.execute as (
		...args: unknown[]
	) => Promise<unknown>;
	await implemented("call", {}, undefined, undefined, harness.ctx);
	assert.equal(stateOf(harness).planPath, undefined);
});

test("requesting changes returns the feedback with the ids needed to try again", async (t) => {
	const harness = createRevisionHarness({
		reviews: [{ kind: "changes_requested", feedback: "keep blue/green, change only the flag" }],
	});
	t.after(harness.cleanup);
	await implementPlan(harness);
	const started = await begin(harness, { expectedRevision: 1 });
	const result = await propose(harness);

	assert.equal(result.payload.status, "changes_requested");
	assert.equal(result.payload.revisionId, started.payload.revisionId);
	assert.equal(result.payload.feedback, "keep blue/green, change only the flag");
	assert.match(String(result.payload.instruction), /action "propose"/u);
	// Nothing was published, and the transaction is still the one to finish.
	assert.equal(await readPlanFile(planPath(harness)), `${FIRST_PLAN}\n`);
	assert.equal(stateOf(harness).revision?.revisionId, started.payload.revisionId);
});

test("a corrected proposal retires its predecessor without deleting it", async (t) => {
	const harness = createRevisionHarness({
		reviews: [{ kind: "changes_requested", feedback: "keep blue/green" }, { kind: "dismissed" }],
	});
	t.after(harness.cleanup);
	await implementPlan(harness);
	await begin(harness, { expectedRevision: 1 });
	const first = await propose(harness);
	const second = await propose(harness, { plan: `${REVISED_PLAN}\n\n## Rollback\n\n- flip back.` });
	assert.equal(second.payload.status, "pending_review");

	const planId = String(stateOf(harness).planId);
	const all = await listPlanProposals(planRevisionsRoot(), planId);
	assert.equal(all.length, 2);
	const retired = all.find((entry) => entry.proposalId === first.payload.proposalId);
	assert.equal(retired?.status, "superseded");
	assert.equal(retired?.supersededBy, second.payload.proposalId);
	assert.ok(retired?.proposedPlan.length, "the rejected draft is kept on file");
	const pending = await listPendingPlanProposals(planRevisionsRoot(), planId);
	assert.deepEqual(
		pending.map((entry) => entry.proposalId),
		[second.payload.proposalId],
	);
});

test("cancelling keeps the approved plan and its approval, and pauses execution", async (t) => {
	const harness = createRevisionHarness({ reviews: [{ kind: "cancelled" }] });
	t.after(harness.cleanup);
	await implementPlan(harness);
	const approvedDigest = stateOf(harness).approvedDigest;
	await begin(harness, { expectedRevision: 1 });
	const result = await propose(harness);

	assert.equal(result.payload.status, "cancelled");
	assert.match(String(result.payload.message), /do not resume on your own/u);
	assert.equal(await readPlanFile(planPath(harness)), `${FIRST_PLAN}\n`);
	const state = stateOf(harness);
	assert.equal(state.revision, undefined);
	assert.equal(state.approvedDigest, approvedDigest, "approval survives a cancelled revision");
	// Paused, not resumed: the user picks up from the same menu a ready plan opens.
	assert.equal(state.enabled, true);
	assert.equal(state.awaitingAction, true);
	const planId = String(state.planId);
	const proposals = await listPlanProposals(planRevisionsRoot(), planId);
	assert.equal(proposals.at(-1)?.status, "cancelled");
});

test("a proposal identical to the plan on disk is a no-op that keeps approval", async (t) => {
	const harness = createRevisionHarness({ reviews: [{ kind: "accepted" }] });
	t.after(harness.cleanup);
	await implementPlan(harness);
	const approvedDigest = stateOf(harness).approvedDigest;
	await begin(harness, { expectedRevision: 1 });
	const result = await propose(harness, { plan: FIRST_PLAN });

	assert.equal(result.isError, false, JSON.stringify(result.payload));
	assert.equal(result.payload.status, "unchanged");
	assert.equal(harness.reviewRequests.length, 0, "nothing to review");
	const state = stateOf(harness);
	assert.equal(state.revision, undefined);
	assert.equal(state.approvedDigest, approvedDigest);
	assert.equal(state.specRevision, 1, "no revision was consumed");
	assert.equal(await readPlanSnapshot(planRevisionsRoot(), String(state.planId), 2), undefined);
});

test("a closed card is not a decision: the candidate waits and nothing is approved", async (t) => {
	const harness = createRevisionHarness({ reviews: [{ kind: "dismissed" }] });
	t.after(harness.cleanup);
	await implementPlan(harness);
	await begin(harness, { expectedRevision: 1 });
	const result = await propose(harness);

	assert.equal(result.payload.status, "pending_review");
	assert.match(String(result.payload.message), /\/plan reopens it/u);
	assert.equal(await readPlanFile(planPath(harness)), `${FIRST_PLAN}\n`);
	const state = stateOf(harness);
	assert.equal(state.revision?.proposalId, result.payload.proposalId);
	assert.match(String(state.revision?.paused), /implementation stays paused/u);
	assert.equal(harness.statuses.get("plan-mode"), "◆ plan · revision ready → /plan");
});

test("a headless session never fabricates an approval", async (t) => {
	const harness = createRevisionHarness({ mode: "print", hasUI: false });
	t.after(harness.cleanup);
	await implementPlan(harness);
	await begin(harness, { expectedRevision: 1 });
	const result = await propose(harness);

	assert.equal(result.payload.status, "pending_review");
	assert.match(String(result.payload.message), /cannot show a review card/u);
	assert.equal(harness.reviewRequests.length, 0);
	assert.equal(await readPlanFile(planPath(harness)), `${FIRST_PLAN}\n`);
});

test("the review card is opened with the tool's own abort signal", async (t) => {
	// Esc has to close the card, which means the tool call's signal has to reach
	// it rather than being dropped at the tool boundary.
	const controller = new AbortController();
	const harness = createRevisionHarness({
		onReview: async () => {
			controller.abort();
			return { kind: "accepted" };
		},
	});
	t.after(harness.cleanup);
	await implementPlan(harness);
	await begin(harness, { expectedRevision: 1 });
	const result = await propose(harness, {}, controller.signal);

	assert.equal(harness.reviewSignals.at(-1)?.aborted, true);
	// A decision that arrives after the turn was interrupted is not a decision.
	assert.equal(result.payload.status, "pending_review");
	assert.equal(await readPlanFile(planPath(harness)), `${FIRST_PLAN}\n`);
});

test("a candidate whose stored bytes no longer match is refused, and kept", async (t) => {
	const harness = createRevisionHarness({ reviews: [{ kind: "dismissed" }, { kind: "accepted" }] });
	t.after(harness.cleanup);
	await implementPlan(harness);
	await begin(harness, { expectedRevision: 1 });
	const pending = await propose(harness);
	const planId = String(stateOf(harness).planId);
	const proposalPath = `${planRevisionsRoot()}/${planId}/proposals/${String(pending.payload.proposalId)}.json`;
	const stored = JSON.parse(await readFile(proposalPath, "utf8")) as Record<string, unknown>;
	await writeFile(proposalPath, JSON.stringify({ ...stored, proposedPlan: "# Something else\n" }));

	await reopenReview(harness);
	// The card in hand disagreed with the directory, so nothing was published and
	// the candidate is still on file to be re-proposed.
	assert.equal(await readPlanFile(planPath(harness)), `${FIRST_PLAN}\n`);
	assert.match(
		harness.notifications.at(-1)?.message ?? "",
		/no longer matches the one under review|could not be re-read/u,
	);
	assert.equal((await listPlanProposals(planRevisionsRoot(), planId)).length, 1);
});

test("a plan that moved while the card was open makes the candidate stale, not published", async (t) => {
	// The decisive case for "progress during review": the user says accept, but the
	// bytes the candidate was computed against are no longer the bytes on disk.
	// Publishing anyway would silently discard whatever landed in between.
	const harness = createRevisionHarness({
		onReview: async () => {
			await writePlanFile(planPath(harness), "# Changed while the card was open");
			return { kind: "accepted" };
		},
	});
	t.after(harness.cleanup);
	await implementPlan(harness);
	await begin(harness, { expectedRevision: 1 });
	const result = await propose(harness);

	assert.equal(result.isError, true);
	assert.equal(result.payload.status, "stale_proposal");
	assert.match(String(result.payload.message), /still on file/u);
	assert.equal(await readPlanFile(planPath(harness)), "# Changed while the card was open\n");
	const state = stateOf(harness);
	assert.equal(state.specRevision, 1, "no revision was published");
	// The work is kept so the agent can refresh it rather than redo it.
	const pending = await listPendingPlanProposals(planRevisionsRoot(), String(state.planId));
	assert.deepEqual(
		pending.map((entry) => entry.proposalId),
		[result.payload.proposalId],
	);
});

test("the prompt tells the model to finish a revision with propose, not complete", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);

	const implementing = await harness.systemPromptAddition();
	assert.match(implementing ?? "", /\[APPROVED PLAN\]/u);
	assert.match(implementing ?? "", /spec revision 1/u);
	assert.match(implementing ?? "", /update_plan with action "begin"/u);
	assert.match(implementing ?? "", /Never edit this file with edit or write/u);

	const started = await begin(harness, { expectedRevision: 1 });
	const revising = (await harness.systemPromptAddition()) ?? "";
	assert.match(revising, /\[PLAN MODE ACTIVE\]/u);
	assert.match(revising, /## This revision/u);
	assert.ok(revising.includes(String(started.payload.revisionId)));
	assert.match(revising, /The user asked for: change the deployment approach/u);
	assert.match(revising, /Do not call plan_mode_complete/u);
	// The non-mutation rules are the same ones that produced the plan.
	assert.match(revising, /Do not perform mutating actions/u);
});

test("/plan reopens a waiting revision and sends feedback the agent did not ask for", async (t) => {
	const harness = createRevisionHarness({
		reviews: [{ kind: "dismissed" }, { kind: "changes_requested", feedback: "keep blue/green" }],
	});
	t.after(harness.cleanup);
	await implementPlan(harness);
	const started = await begin(harness, { expectedRevision: 1 });
	await propose(harness);

	await reopenReview(harness);
	assert.equal(harness.reviewRequests.length, 2, "the card reopened");
	const sent = harness.sentUserMessages.at(-1)?.text ?? "";
	assert.match(sent, /asked for changes: keep blue\/green/u);
	assert.ok(sent.includes(String(started.payload.revisionId)));
	assert.equal(harness.notifications.at(-1)?.message, "Feedback sent to the agent.");
});

test("/plan can cancel a revision that was never proposed", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);
	await begin(harness, { expectedRevision: 1 });
	// The menu is injected, so drive the item the controller wired to it.
	const menu = harness.planMenuCalls.at(-1);
	assert.equal(menu, undefined, "no menu yet");
	await runPlanCommand(harness, "");
	const opened = harness.planMenuCalls.at(-1) as {
		hasOpenRevision?: boolean;
		hasPendingRevision?: boolean;
		cancelRevision?: () => Promise<void>;
	};
	assert.equal(opened.hasOpenRevision, true);
	assert.equal(opened.hasPendingRevision, false);
	await opened.cancelRevision?.();

	assert.equal(stateOf(harness).revision, undefined);
	assert.equal(await readPlanFile(planPath(harness)), `${FIRST_PLAN}\n`);
	assert.match(harness.notifications.at(-1)?.message ?? "", /revision cancelled/iu);
});

test("an open revision blocks both finishing and resuming implementation", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);
	const started = await begin(harness, { expectedRevision: 1 });
	const implemented = harness.tools.get("plan_implemented")?.execute as (
		...args: unknown[]
	) => Promise<unknown>;
	await assert.rejects(
		implemented("call", {}, undefined, undefined, harness.ctx),
		/only available while an approved plan is being implemented/u,
	);

	// `/plan implement` is the only door that reaches implementation during a
	// revision, and taking it would approve bytes the user is still changing.
	await runPlanCommand(harness, "implement");
	assert.match(harness.notifications.at(-1)?.message ?? "", /Accept or cancel it from \/plan/u);
	const state = stateOf(harness);
	assert.equal(state.revision?.revisionId, started.payload.revisionId);
	assert.equal(state.enabled, true);
});

test("a restart restores the open revision and finds its waiting candidate", async (t) => {
	const harness = createRevisionHarness({ reviews: [{ kind: "dismissed" }] });
	t.after(harness.cleanup);
	await implementPlan(harness);
	const started = await begin(harness, { expectedRevision: 1 });
	const proposed = await propose(harness);

	// The same branch, a new session: Plan mode restores its state from entries.
	await harness.emit("session_start", { reason: "resume" });
	const state = stateOf(harness);
	assert.equal(state.revision?.revisionId, started.payload.revisionId);
	assert.equal(state.revision?.proposalId, proposed.payload.proposalId);
	assert.equal(harness.statuses.get("plan-mode"), "◆ plan · revision ready → /plan");
	assert.ok(
		harness.notifications.some((entry) => /still waiting for review/u.test(entry.message)),
		harness.notifications.map((entry) => entry.message).join(" | "),
	);
});
