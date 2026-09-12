/**
 * The guards that decide whether implementation may continue, and which call a
 * change to the plan has to go through.
 *
 * Each case here is a route a user or a model can actually take, not a unit of a
 * predicate: typed commands, the tools as the model calls them, tree navigation,
 * and two mutating tool calls inside one turn. That matters because every bug
 * these cover was a *reachability* bug — a correct refusal that the early return
 * above it made unreachable, a correct digest check that nothing consulted
 * between turns, a correct revision route the prompt never named.
 */

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { readPlanFile, writePlanFile } from "../src/plan-file.js";
import {
	approvalRecoveryInstruction,
	canConfirmPlanFile,
	completionRefusal,
	managedCompletionRefusal,
	mutationRefusal,
} from "../src/plan-approval.js";
import {
	digestOf,
	listPlanProposals,
	planRevisionsRoot,
	readPlanManifest,
	readPlanSnapshot,
} from "../src/revision-store.js";
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
const SUMMARY = "rolling restart instead of blue/green; migration untouched";

function stateOf(harness: RevisionHarness) {
	const state = harness.state();
	assert.ok(state, "expected persisted plan state");
	return state as Record<string, unknown>;
}

function planPath(harness: RevisionHarness): string {
	return String(stateOf(harness).planPath);
}

function toolExecute(harness: RevisionHarness, name: string) {
	const execute = harness.tools.get(name)?.execute as (...args: unknown[]) => Promise<unknown>;
	assert.ok(execute, `${name} must be registered`);
	return execute;
}

async function beginRevision(harness: RevisionHarness, expectedRevision: number) {
	const result = await callTool(harness, "update_plan", {
		action: "begin",
		expectedRevision,
		instructions: INSTRUCTIONS,
	});
	assert.equal(result.isError, false, JSON.stringify(result.payload));
	return result;
}

async function proposeRevision(harness: RevisionHarness, plan = REVISED_PLAN) {
	const open = stateOf(harness).revision as { revisionId: string; baseRevision: number };
	return callTool(harness, "update_plan", {
		action: "propose",
		revisionId: open.revisionId,
		expectedRevision: open.baseRevision,
		plan,
		changeSummary: SUMMARY,
	});
}

/** The block decision `tool_call` returned, or undefined when it allowed the call. */
async function toolCall(harness: RevisionHarness, toolName: string) {
	const results = await harness.emit("tool_call", { toolName });
	return results[0] as { block?: boolean; reason?: string } | undefined;
}

// --------------------------------------------------------------- managed route

test("the managed-completion predicate answers by state, not by caller", () => {
	// Shared by the tool wrapper and by the write it calls, so the refusal cannot
	// be reached around. Spelled out here because both call sites pass `state`.
	assert.equal(
		managedCompletionRefusal({ enabled: true, awaitingAction: false }),
		undefined,
		"a first draft is what plan_mode_complete is for",
	);
	assert.equal(
		managedCompletionRefusal({ enabled: true, awaitingAction: true, planPath: "/tmp/p.md" }),
		undefined,
		"a plan with no managed history yet is still a first draft",
	);
	const managed = managedCompletionRefusal({
		enabled: true,
		awaitingAction: true,
		planPath: "/tmp/p.md",
		planId: "00000000-0000-4000-8000-000000000001",
		specRevision: 3,
	});
	assert.match(String(managed), /action "begin" and expectedRevision 3/u);
	const revising = managedCompletionRefusal({
		enabled: true,
		awaitingAction: false,
		planPath: "/tmp/p.md",
		planId: "00000000-0000-4000-8000-000000000001",
		specRevision: 3,
		revision: {
			revisionId: "00000000-0000-4000-8000-000000000002",
			baseRevision: 3,
			baseDigest: "a".repeat(64),
			instructions: "x",
			startedAt: "",
		},
	});
	assert.match(String(revising), /action "propose", revisionId "00000000-0000-4000-8000-000000000002"/u);
});

test("after an accepted revision, plan_mode_complete refuses and nothing is replaced", async (t) => {
	const harness = createRevisionHarness({ reviews: [{ kind: "accepted" }] });
	t.after(harness.cleanup);
	await implementPlan(harness);
	await beginRevision(harness, 1);
	const accepted = await proposeRevision(harness);
	assert.equal(accepted.payload.status, "accepted");
	const planId = String(stateOf(harness).planId);

	// The state an accepted revision leaves: Plan mode on, a plan ready, and a
	// managed identity behind it. This is where a "looks good, tweak X" reply used
	// to rewrite the file from model memory with no base, no diff and no review.
	await assert.rejects(
		toolExecute(harness, "plan_mode_complete")(
			"call",
			{ plan: "# Rewritten from memory" },
			undefined,
			undefined,
			harness.ctx,
		),
		/cannot replace a plan that already exists.*action "begin" and expectedRevision 2/su,
	);
	assert.equal(await readPlanFile(planPath(harness)), `${REVISED_PLAN}\n`, "live bytes preserved");
	const state = stateOf(harness);
	assert.equal(state.planId, planId, "identity preserved");
	assert.equal(state.specRevision, 2);
	const manifest = await readPlanManifest(planRevisionsRoot(), planId);
	assert.equal(manifest.kind, "loaded");
	if (manifest.kind !== "loaded") return;
	assert.equal(manifest.manifest.specRevision, 2, "history preserved");
	assert.equal(manifest.manifest.currentDigest, digestOf(`${REVISED_PLAN}\n`));
});

test("after a cancelled revision, plan_mode_complete still refuses", async (t) => {
	const harness = createRevisionHarness({ reviews: [{ kind: "cancelled" }] });
	t.after(harness.cleanup);
	await implementPlan(harness);
	await beginRevision(harness, 1);
	const cancelled = await proposeRevision(harness);
	assert.equal(cancelled.payload.status, "cancelled");

	await assert.rejects(
		toolExecute(harness, "plan_mode_complete")(
			"call",
			{ plan: "# Rewritten from memory" },
			undefined,
			undefined,
			harness.ctx,
		),
		/cannot replace a plan that already exists/u,
	);
	assert.equal(await readPlanFile(planPath(harness)), `${FIRST_PLAN}\n`);
	assert.equal(stateOf(harness).specRevision, 1);
});

test("a first draft still completes normally, and a second plan after done does too", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	// First draft: no identity, so no refusal.
	await draftPlan(harness);
	assert.equal(await readPlanFile(planPath(harness)), `${FIRST_PLAN}\n`);
	assert.equal(stateOf(harness).planId, undefined);

	// Implementing gives it an identity; finishing clears it again, so the next
	// plan in the session is a first draft once more.
	await runPlanCommand(harness, "implement");
	assert.equal(typeof stateOf(harness).planId, "string");
	await runPlanCommand(harness, "done");
	assert.equal(stateOf(harness).planId, undefined);

	await runPlanCommand(harness, "start");
	const second = await callTool(harness, "plan_mode_complete", { plan: "# A different plan" });
	assert.equal(second.isError, false, JSON.stringify(second.payload));
	assert.equal(await readPlanFile(planPath(harness)), "# A different plan\n");
});

test("the ready prompt over a managed plan names begin, not plan_mode_complete", async (t) => {
	const harness = createRevisionHarness({ reviews: [{ kind: "accepted" }] });
	t.after(harness.cleanup);
	await implementPlan(harness);
	await beginRevision(harness, 1);
	await proposeRevision(harness);

	const prompt = (await harness.systemPromptAddition()) ?? "";
	assert.match(prompt, /## This plan already exists/u);
	assert.match(prompt, /update_plan with action "begin" and expectedRevision 2/u);
	assert.match(prompt, /Do not call plan_mode_complete/u);
	// The ending must not still say a requested change finishes in the refused call.
	assert.ok(
		!/call plan_mode_complete alone as your final action/u.test(prompt),
		"the drafting ending leaked into a managed plan's prompt",
	);

	// And the one other place the route is named to the model — the refusal it gets
	// for trying to edit while Plan mode is on — agrees with the prompt.
	const blocked = await toolCall(harness, "edit");
	assert.equal(blocked?.block, true);
	assert.match(String(blocked?.reason), /This plan already exists/u);
	assert.match(String(blocked?.reason), /action "begin" and expectedRevision 2/u);
	assert.ok(!/plan_mode_complete/u.test(String(blocked?.reason)));
});

// ------------------------------------------------------- finalize / done / exit

test("/plan finalize names the call that will be accepted in each state", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);

	// A first draft: unchanged wording.
	await draftPlan(harness);
	await runPlanCommand(harness, "finalize");
	assert.match(
		harness.sentUserMessages.at(-1)?.text ?? "",
		/call plan_mode_complete alone as your final action/u,
	);

	// A managed plan with no revision open: begin.
	await runPlanCommand(harness, "implement");
	await runPlanCommand(harness, "start");
	await runPlanCommand(harness, "finalize");
	const managed = harness.sentUserMessages.at(-1)?.text ?? "";
	assert.match(managed, /action "begin" and expectedRevision 1/u);
	assert.match(managed, /Do not call plan_mode_complete/u);

	// A revision in progress: propose, with this transaction's identity.
	const started = await beginRevision(harness, 1);
	await runPlanCommand(harness, "finalize");
	const revising = harness.sentUserMessages.at(-1)?.text ?? "";
	assert.ok(revising.includes(String(started.payload.revisionId)), revising);
	assert.match(revising, /action "propose"/u);
	assert.match(revising, /refused while this revision is open/u);
});

/**
 * Exit over an agreed managed plan, in all three states a revision leaves behind
 * and one turn later, through the typed command and through the menu item.
 *
 * This is the shape of the defect: the guard used to fire only while a transaction
 * was *open*, and resolving one (accept or cancel) leaves Plan mode on with the
 * plan attached — the same state an unmanaged draft occupies. So exit fell through
 * to "Plan mode disabled. Proposed plan discarded." and deleted the document the
 * user had agreed to, from a menu item labelled as discarding a proposal.
 */
const MANAGED_EXIT_CASES = [
	{ name: "with an open revision", resolve: "open" },
	{ name: "after accepting a revision", resolve: "accept" },
	{ name: "after cancelling a revision", resolve: "cancel" },
	{ name: "a turn after accepting, once awaitingAction has cleared", resolve: "accept-then-turn" },
] as const;

for (const scenario of MANAGED_EXIT_CASES) {
	for (const route of ["command", "menu"] as const) {
		test(`${route} exit ${scenario.name} keeps the agreed plan attached and paused`, async (t) => {
			const reviews =
				scenario.resolve === "accept" || scenario.resolve === "accept-then-turn"
					? [{ kind: "accepted" as const }]
					: scenario.resolve === "cancel"
						? [{ kind: "cancelled" as const }]
						: [{ kind: "dismissed" as const }];
			const harness = createRevisionHarness({ reviews });
			t.after(harness.cleanup);
			await implementPlan(harness);
			await beginRevision(harness, 1);
			await proposeRevision(harness);
			if (scenario.resolve === "accept-then-turn") {
				// The turn boundary clears `awaitingAction`, which is where the state stops
				// looking "ready" and started looking like a superseded draft.
				await harness.systemPromptAddition();
				assert.equal(stateOf(harness).awaitingAction, false);
			}
			const path = planPath(harness);
			const planId = String(stateOf(harness).planId);
			const expectedRevision = scenario.resolve === "open" || scenario.resolve === "cancel" ? 1 : 2;
			const expectedPlan = expectedRevision === 1 ? `${FIRST_PLAN}\n` : `${REVISED_PLAN}\n`;

			if (route === "command") {
				await runPlanCommand(harness, "exit");
			} else {
				await runPlanCommand(harness, "");
				const menu = harness.planMenuCalls.at(-1) as {
					managedPlan?: boolean;
					exit?: () => void;
				};
				assert.equal(menu.managedPlan, true, "the menu must know this is an agreed plan");
				menu.exit?.();
				// `exitReady` is fire-and-forget, so let the state write land.
				for (let attempt = 0; attempt < 50 && stateOf(harness).revision !== undefined; attempt += 1) {
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			// The agreed document is still there, unchanged.
			assert.equal(await readPlanFile(path), expectedPlan, scenario.name);
			const message = harness.notifications.at(-1)?.message ?? "";
			assert.ok(
				!/Proposed plan discarded/u.test(message),
				`${route}/${scenario.name}: an agreed plan must not be called a discarded draft`,
			);
			assert.match(message, /stays attached and paused/u);
			assert.match(message, /nothing was discarded and nothing is being implemented/u);
			// Every route the message offers exists from this state.
			assert.match(message, /Run \/plan to implement it here, start a fresh implementation session, or export it/u);

			// Attached and paused: Plan mode is on, the plan is tracked, no transaction is
			// open, and nothing claims an implementation or a completion happened.
			const state = stateOf(harness);
			assert.equal(state.planPath, path);
			assert.equal(state.planId, planId);
			assert.equal(state.specRevision, expectedRevision);
			assert.equal(state.enabled, true);
			assert.equal(state.awaitingAction, true, "back at the managed ready decision");
			assert.equal(state.revision, undefined);
			assert.equal(state.archivePath, undefined, "nothing was marked implemented");
			assert.equal(harness.statuses.get("plan-mode"), `◆ plan · agreed r${expectedRevision} → /plan`);

			// History is retained, and any candidate is retired rather than left pending or
			// deleted.
			assert.equal((await readPlanManifest(planRevisionsRoot(), planId)).kind, "loaded");
			assert.equal(await readPlanSnapshot(planRevisionsRoot(), planId, 1), `${FIRST_PLAN}\n`);
			const proposals = await listPlanProposals(planRevisionsRoot(), planId);
			assert.equal(proposals.length, 1);
			assert.ok(proposals[0]?.proposedPlan.length, "the candidate content is kept");
			assert.notEqual(proposals[0]?.status, "pending", "no candidate is left waiting");

			// And the routes the message named are the ones the menu actually offers.
			await runPlanCommand(harness, "");
			const reopened = harness.planMenuCalls.at(-1) as {
				hasReadyPlan?: boolean;
				implementHere?: unknown;
				implementFresh?: unknown;
			};
			assert.equal(reopened.hasReadyPlan, true);
			assert.equal(typeof reopened.implementHere, "function");
			assert.equal(typeof reopened.implementFresh, "function");
		});
	}
}

test("exit while implementing still clears the active plan", async (t) => {
	// The long-standing explicit clear, untouched by the managed-planning rule: this
	// state is implementing, not planning, and clearing is what exit has always meant
	// there.
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);
	const path = planPath(harness);
	assert.equal(stateOf(harness).enabled, false);

	await runPlanCommand(harness, "exit");
	assert.equal(harness.notifications.at(-1)?.message, "Active implementation plan cleared.");
	assert.equal(await readPlanFile(path), undefined);
	assert.equal(stateOf(harness).planPath, undefined);
});

test("/plan exit on an ordinary proposed draft still deletes it", async (t) => {
	// The pre-existing meaning of exit, unchanged: a draft nobody approved is
	// discarded, and the wording says so.
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await draftPlan(harness);
	const path = planPath(harness);
	await runPlanCommand(harness, "exit");
	assert.equal(await readPlanFile(path), undefined);
	assert.equal(harness.notifications.at(-1)?.message, "Plan mode disabled. Proposed plan discarded.");
});

test("the revision refusal reaches every completion entry point", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);
	await beginRevision(harness, 1);

	// The predicate itself, and then both doors that used to shadow it.
	assert.match(String(completionRefusal({ kind: "revising" })), /A plan revision is in progress/u);
	await assert.rejects(
		toolExecute(harness, "plan_implemented")("call", {}, undefined, undefined, harness.ctx),
		/A plan revision is in progress/u,
	);
	await runPlanCommand(harness, "done");
	assert.match(harness.notifications.at(-1)?.message ?? "", /A plan revision is in progress/u);
	assert.ok(
		!harness.notifications.some((entry) => entry.message === "No plan is being implemented."),
		"the old message claimed there was no plan while holding a revision of one",
	);
	assert.notEqual(stateOf(harness).planPath, undefined);
});

// ----------------------------------------------------------- branch navigation

test("tree navigation re-reads which plan the selected branch approved", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await draftPlan(harness);
	// A branch recorded before the user approved anything.
	const beforeApproval = [...harness.branch];
	await runPlanCommand(harness, "implement");
	const approved = [...harness.branch];
	const path = planPath(harness);
	const approvedDigest = stateOf(harness).approvedDigest;
	assert.equal(approvedDigest, digestOf(`${FIRST_PLAN}\n`));
	assert.equal(harness.statuses.get("plan-mode"), "▶ plan · implementing");

	// Navigate back to the pre-approval branch. The file is unchanged, so only the
	// branch can say whether this conversation ever approved it.
	harness.viewBranch(beforeApproval);
	await harness.emit("session_tree", { newLeafId: "pre", oldLeafId: "post" });
	assert.equal(harness.statuses.get("plan-mode"), "◆ plan · ready → /plan");
	await runPlanCommand(harness, "done");
	assert.match(harness.notifications.at(-1)?.message ?? "", /No plan is being implemented/u);
	assert.equal(await readPlanFile(path), `${FIRST_PLAN}\n`, "no source or plan rewind");

	// An unrelated branch that never had a plan.
	harness.viewBranch([]);
	await harness.emit("session_tree", { newLeafId: "other", oldLeafId: "pre" });
	assert.equal(harness.statuses.get("plan-mode"), undefined);
	assert.match(harness.notifications.at(-1)?.message ?? "", /tracks no plan/u);
	await assert.rejects(
		toolExecute(harness, "plan_implemented")("call", {}, undefined, undefined, harness.ctx),
		/only available while an approved plan is being implemented/u,
	);
	assert.equal(await readPlanFile(path), `${FIRST_PLAN}\n`);

	// Back to the approved branch: the exact digest it recorded is what applies.
	harness.viewBranch(approved);
	await harness.emit("session_tree", { newLeafId: "post", oldLeafId: "other" });
	assert.equal(harness.statuses.get("plan-mode"), "▶ plan · implementing");
	await writePlanFile(path, "# Edited while another branch was selected");
	await harness.emit("session_tree", { newLeafId: "post", oldLeafId: "post" });
	assert.equal(
		harness.statuses.get("plan-mode"),
		"▶ plan · unverified → /plan",
		"the recorded digest is compared against the file, not assumed",
	);
});

test("a revision open on another branch cannot act on the branch that replaced it", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);
	const implementing = [...harness.branch];
	const started = await beginRevision(harness, 1);
	assert.equal(harness.statuses.get("plan-mode"), "◆ plan · revising");

	harness.viewBranch(implementing);
	await harness.emit("session_tree", { newLeafId: "impl", oldLeafId: "rev" });
	// The branch that knows nothing about the revision reports none, and the model
	// cannot propose against a transaction this branch never opened.
	assert.equal(stateOf(harness).revision, undefined);
	const orphan = await callTool(harness, "update_plan", {
		action: "propose",
		revisionId: String(started.payload.revisionId),
		expectedRevision: 1,
		plan: REVISED_PLAN,
		changeSummary: SUMMARY,
	});
	assert.equal(orphan.payload.status, "no_revision");
	assert.equal(harness.statuses.get("plan-mode"), "▶ plan · implementing");
});

// ------------------------------------------------------- per-mutation guard

test("the mutation refusal is silent about states that are already refused", () => {
	assert.equal(mutationRefusal("edit", { kind: "approved", digest: "a".repeat(64) }), undefined);
	assert.equal(mutationRefusal("edit", { kind: "none" }), undefined);
	assert.match(String(mutationRefusal("edit", { kind: "unknown" })), /no record of the exact plan bytes/u);
	assert.match(
		String(mutationRefusal("write", { kind: "stale", approvedDigest: "a".repeat(64), currentDigest: "b".repeat(64) })),
		/changed after it was approved/u,
	);
});

test("a plan changed mid-turn blocks the next mutating call, with no turn boundary", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);
	// One turn starts; the model is implementing the plan it was given.
	await harness.systemPromptAddition();
	assert.equal(await toolCall(harness, "edit"), undefined, "an approved plan may be edited");
	assert.equal(await toolCall(harness, "read"), undefined, "read-only tools are never judged");

	// Something outside Plan mode rewrites the plan, mid-turn. No `before_agent_start`
	// runs between these two calls, which is exactly the window a turn-boundary-only
	// check could not see.
	await writePlanFile(planPath(harness), "# Someone rewrote the plan mid-turn");

	const blocked = await toolCall(harness, "edit");
	assert.equal(blocked?.block, true, "the next mutation must be refused");
	assert.match(String(blocked?.reason), /not the plan that was approved/u);
	assert.match(String(blocked?.reason), /changed after it was approved/u);
	assert.match(String(blocked?.reason), /update_plan with action "begin"/u);
	// The refusal the model saw and the footer the user sees agree.
	assert.equal(harness.statuses.get("plan-mode"), "▶ plan · unverified → /plan");
	assert.equal(await toolCall(harness, "read"), undefined, "still only mutating tools");

	// Confirming the file is a human decision, and it unblocks the same call.
	await runPlanCommand(harness, "");
	const menu = harness.activeMenuCalls.at(-1) as { confirmPlan?: () => Promise<void> };
	await menu.confirmPlan?.();
	assert.equal(await toolCall(harness, "edit"), undefined, "approved again, so allowed again");
});

test("an implementation whose approval was never recorded cannot mutate either", async (t) => {
	// `state.enabled` is false here, which is what used to be taken as "implement
	// freely". An unverified plan at turn start must not licence mutations.
	const { planFilePathForSession } = await import("../src/plan-file.js");
	const harness = createRevisionHarness({
		branch: [
			{
				type: "custom",
				customType: "plan-mode-state",
				data: { enabled: false, awaitingAction: false, planPath: "PLACEHOLDER" },
			},
		],
	});
	t.after(harness.cleanup);
	const path = planFilePathForSession("revision-test-session");
	(harness.branch[0] as { data: { planPath: string } }).data.planPath = path;
	await writePlanFile(path, FIRST_PLAN);
	await harness.emit("session_start", { reason: "resume" });
	assert.equal(harness.statuses.get("plan-mode"), "▶ plan · unverified → /plan");

	const blocked = await toolCall(harness, "write");
	assert.equal(blocked?.block, true);
	assert.match(String(blocked?.reason), /no record of the exact plan bytes that were approved/u);
	assert.equal(await toolCall(harness, "bash"), undefined, "bash is not classified here");
});

test("a session with no plan at all is not policed", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await harness.emit("session_start", { reason: "resume" });
	assert.equal(await toolCall(harness, "edit"), undefined);
	assert.equal(await toolCall(harness, "write"), undefined);
});

// ------------------------------------------------------ approval recovery routes

test("recovery guidance names only routes that exist in the mode it addresses", () => {
	const stale = { kind: "stale", approvedDigest: "a".repeat(64), currentDigest: "b".repeat(64) } as const;
	const interactive = String(approvalRecoveryInstruction(stale, { interactive: true }));
	assert.match(interactive, /update_plan with action "begin"/u);
	assert.match(interactive, /Confirm the plan file/u);

	// No menu in print/JSON mode, and "confirm" is not a subcommand: typing it would
	// turn Plan mode on over an implementing plan and forward the word to the model.
	const headless = String(approvalRecoveryInstruction(stale, { interactive: false }));
	assert.ok(!/Confirm the plan file/u.test(headless), headless);
	assert.match(headless, /no interactive review/u);
	assert.match(headless, /\/plan implement/u);
	// The existing command, framed as the user's action and never the model's.
	assert.match(headless, /they can re-approve/u);
	assert.match(headless, /Do not treat either as done until they have acted/u);

	// A file that cannot be read gets its own answer: begin refuses for it and
	// Confirm has no bytes to record, so neither is offered.
	for (const mode of [{ interactive: true }, { interactive: false }]) {
		const missing = String(approvalRecoveryInstruction({ kind: "missing" }, mode));
		assert.match(missing, /restore the plan file/u);
		assert.match(missing, /\/plan exit/u);
		assert.ok(!/action "begin"/u.test(missing), missing);
		assert.ok(!/Confirm the plan file/u.test(missing), missing);
	}

	// Nothing to say about a plan whose approval is intact.
	assert.equal(approvalRecoveryInstruction({ kind: "approved", digest: "a".repeat(64) }, { interactive: true }), undefined);
	// Only the two states that record bytes can be confirmed.
	assert.equal(canConfirmPlanFile({ kind: "missing" }), false);
	assert.equal(canConfirmPlanFile({ kind: "unknown" }), true);
	assert.equal(canConfirmPlanFile(stale), true);
});

test("a headless session is never pointed at the interactive menu", async (t) => {
	const harness = createRevisionHarness({ mode: "print", hasUI: false });
	t.after(harness.cleanup);
	await implementPlan(harness);
	await writePlanFile(planPath(harness), "# Changed after approval");

	// The turn boundary, the mutation guard and the completion gate all speak to the
	// same session, so all three have to name the same reachable route.
	const prompt = (await harness.systemPromptAddition()) ?? "";
	assert.match(prompt, /\/plan implement/u);
	assert.ok(!/Confirm the plan file/u.test(prompt), prompt);
	assert.match(prompt, /do not treat it as approved on your own/u);

	const blocked = await toolCall(harness, "edit");
	assert.equal(blocked?.block, true);
	assert.match(String(blocked?.reason), /\/plan implement/u);
	assert.ok(!/Confirm the plan file/u.test(String(blocked?.reason)));

	await assert.rejects(
		toolExecute(harness, "plan_implemented")("call", {}, undefined, undefined, harness.ctx),
		(error: Error) =>
			/\/plan implement/u.test(error.message) && !/Confirm the plan file/u.test(error.message),
	);

	// And that route works without a UI: it re-approves the bytes on disk and
	// restarts implementation from them.
	await runPlanCommand(harness, "implement");
	assert.equal(stateOf(harness).approvedDigest, digestOf("# Changed after approval\n"));
	assert.equal(await toolCall(harness, "edit"), undefined, "approved again, so allowed again");
});

test("a plan file that cannot be read is told to restore or clear, not to confirm", async (t) => {
	const harness = createRevisionHarness();
	t.after(harness.cleanup);
	await implementPlan(harness);
	const path = planPath(harness);
	const planId = String(stateOf(harness).planId);
	await rm(path);

	// Both guarded surfaces refuse, and neither offers a route that needs the bytes.
	const blocked = await toolCall(harness, "write");
	assert.equal(blocked?.block, true);
	assert.match(String(blocked?.reason), /could not be read/u);
	assert.match(String(blocked?.reason), /restore the plan file/u);
	assert.ok(!/Confirm the plan file/u.test(String(blocked?.reason)));

	await assert.rejects(
		toolExecute(harness, "plan_implemented")("call", {}, undefined, undefined, harness.ctx),
		/restore the plan file/u,
	);

	// The menu withholds Confirm, because confirming has no bytes to record, and the
	// status line names the routes that do work.
	await runPlanCommand(harness, "");
	const menu = harness.activeMenuCalls.at(-1) as {
		canConfirm?: boolean;
		statusText?: string;
	};
	assert.equal(menu.canConfirm, false);
	assert.match(String(menu.statusText), /restore the plan file/u);
	assert.match(String(menu.statusText), /\/plan exit/u);

	// Nothing was deleted on this package's behalf: the history is still there.
	assert.equal((await readPlanManifest(planRevisionsRoot(), planId)).kind, "loaded");
	assert.equal(await readPlanSnapshot(planRevisionsRoot(), planId, 1), `${FIRST_PLAN}\n`);
});
