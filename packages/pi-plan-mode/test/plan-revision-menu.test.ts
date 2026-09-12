/**
 * The revision review card: the screens as pure builders, and one pass through
 * the real menu runtime.
 *
 * The builders carry the contract — exactly which decisions a human is offered —
 * and pinning them here is cheap and impossible through a terminal. The
 * drive-through at the bottom is the other half: it proves the card really
 * resolves to a decision rather than only looking right on paper, and that
 * closing it is not one.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext } from "../../../test/support/mock-pi.js";
import { showActiveImplementationMenu } from "../src/active-implementation-menu.js";
import { showPlanModeMenu, showReadyPlanMenu } from "../src/plan-action-menus.js";
import {
	planRevisionDiffScreen,
	planRevisionProposedScreen,
	planRevisionReviewScreen,
	type PlanRevisionSummary,
	showPlanRevisionMenu,
} from "../src/plan-revision-menu.js";

const SUMMARY: PlanRevisionSummary = {
	instructions: "change the deployment approach but keep the migration work",
	changeSummary: "replaced blue/green with a rolling restart; the migration steps are unchanged",
	baseRevision: 3,
	diff: ["-2. Deploy with blue/green.", "+2. Deploy with a rolling restart."],
	added: 1,
	removed: 1,
	proposedPlan: "# Deploy\n\n2. Deploy with a rolling restart.\n",
};

test("the review card offers exactly accept, request changes, and cancel", () => {
	const screen = planRevisionReviewScreen(SUMMARY);
	assert.deepEqual(
		screen.items.map((item) => item.id),
		["accept", "feedback", "diff", "proposed", "cancel"],
	);
	// The three decisions are real actions; the other two only navigate.
	assert.equal(screen.items.find((item) => item.id === "accept")?.action, "accept");
	assert.equal(screen.items.find((item) => item.id === "cancel")?.action, "cancel");
	assert.equal(screen.items.find((item) => item.id === "feedback")?.to, "feedback");
	assert.equal(screen.items.find((item) => item.id === "diff")?.to, "diff");
	const lines = screen.lines?.join("\n") ?? "";
	assert.match(lines, /change the deployment approach/u);
	// The agent's account is labelled as the agent's, beside the computed change.
	assert.match(lines, /Agent summary: replaced blue\/green/u);
	assert.match(lines, /1 line\(s\) added, 1 line\(s\) removed against revision 3/u);
	assert.match(lines, /Implementation stays paused/u);
});

test("a conflict found while computing the revision is shown on the card", () => {
	const lines = planRevisionReviewScreen({
		...SUMMARY,
		conflict: "the plan file does not match recorded revision 3",
	}).lines?.join("\n");
	assert.match(lines ?? "", /does not match recorded revision 3/u);
});

test("the change is shown as a diff and the plan as the plan", () => {
	assert.deepEqual(planRevisionDiffScreen(SUMMARY).format, { kind: "diff" });
	assert.equal(planRevisionDiffScreen(SUMMARY).content, SUMMARY.diff.join("\n"));
	assert.deepEqual(planRevisionProposedScreen(SUMMARY).format, {
		kind: "code",
		language: "markdown",
	});
	assert.equal(planRevisionProposedScreen(SUMMARY).content, SUMMARY.proposedPlan);
});

test("no card item edits a plan; update_plan owns that", () => {
	const labels = planRevisionReviewScreen(SUMMARY).items.map((item) => item.label.toLowerCase());
	for (const forbidden of ["edit plan", "edit the plan", "open in editor", "revise"]) {
		assert.equal(labels.includes(forbidden), false, forbidden);
	}
});

test("the card resolves to a decision through the real menu runtime", async () => {
	for (const [choice, expected] of [
		["Accept revision", { kind: "accepted" }],
		["Cancel revision", { kind: "cancelled" }],
	] as const) {
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			select: async (_title: string, options: string[]) =>
				options.find((option) => option.startsWith(choice)),
		});
		assert.deepEqual(
			await showPlanRevisionMenu(context.ctx, { summary: SUMMARY }),
			expected,
			choice,
		);
	}
});

test("closing the card without choosing is not an approval", async () => {
	const context = createMockContext({ mode: "tui", hasUI: true, select: async () => undefined });
	assert.deepEqual(await showPlanRevisionMenu(context.ctx, { summary: SUMMARY }), {
		kind: "dismissed",
	});
});

test("a mode that cannot render a card reports unavailable rather than deciding", async () => {
	const context = createMockContext({ mode: "print", hasUI: false });
	assert.deepEqual(await showPlanRevisionMenu(context.ctx, { summary: SUMMARY }), {
		kind: "unavailable",
	});
});

/** The rows a menu offered and the frame it rendered, as a human would see them. */
async function offered(
	open: (ctx: never) => Promise<unknown>,
): Promise<{ options: string[]; frame: string }> {
	let options: string[] = [];
	let frame = "";
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async (title: string, rows: string[]) => {
			options = rows;
			frame = title;
			return undefined;
		},
	});
	await open(context.ctx as never);
	return { options, frame };
}

async function offeredOptions(open: (ctx: never) => Promise<unknown>): Promise<string[]> {
	return (await offered(open)).options;
}

test("/plan during a revision offers the revision's controls, not drafting's", async () => {
	const base = {
		statusText: "A revision of the approved plan is in progress (base revision 3).",
		planPathLine: "Plan file: /tmp/plan.md",
		getExportDestination: () => ({ configuredPath: "PLAN.md", resolvedPath: "/tmp/PLAN.md" }),
		signal: new AbortController().signal,
		isCurrent: () => true,
		show: () => undefined,
		finalize: () => undefined,
		implementHere: () => undefined,
		implementFresh: () => undefined,
		exportPlan: async () => false,
		reviewRevision: () => undefined,
		cancelRevision: () => undefined,
		stay: () => undefined,
		exit: () => undefined,
	};
	const options = await offeredOptions((ctx) =>
		showPlanModeMenu(ctx, {
			...base,
			hasReadyPlan: false,
			managedPlan: true,
			hasOpenRevision: true,
			hasPendingRevision: true,
		}),
	);
	assert.deepEqual(options, [
		"Show the current plan",
		"Review the proposed revision",
		"Cancel the revision",
		"Keep revising",
	]);
	// "Request final plan" would ask for a plan_mode_complete that is refused
	// while a revision is open, and "Exit Plan mode" would discard the approved
	// plan the revision exists to change.
	assert.equal(options.includes("Request final plan"), false);
	assert.equal(options.includes("Discard plan and exit"), false);
});

test("an agreed managed plan is never offered a discard, in either menu shape", async () => {
	// The state an accepted or cancelled revision leaves behind, and the same state
	// one turn later once `awaitingAction` has cleared. Both used to offer an item
	// that deleted the agreed plan file and called it discarding a proposal.
	const base = {
		statusText: "The agreed plan at spec revision 3 is current and paused.",
		planPathLine: "Plan file: /tmp/plan.md",
		getExportDestination: () => ({ configuredPath: "PLAN.md", resolvedPath: "/tmp/PLAN.md" }),
		signal: new AbortController().signal,
		isCurrent: () => true,
		show: () => undefined,
		finalize: () => undefined,
		implementHere: () => undefined,
		implementFresh: () => undefined,
		exportPlan: async () => false,
		reviewRevision: () => undefined,
		cancelRevision: () => undefined,
		stay: () => undefined,
		exit: () => undefined,
		hasOpenRevision: false,
		hasPendingRevision: false,
	};
	for (const hasReadyPlan of [true, false]) {
		const managed = await offered((ctx) =>
			showPlanModeMenu(ctx, { ...base, managedPlan: true, hasReadyPlan }),
		);
		assert.equal(
			managed.options.includes("Discard plan and exit"),
			false,
			`ready=${hasReadyPlan}: an agreed plan must not be offered a discard`,
		);
		assert.ok(
			managed.options.some((option) => option.startsWith("Leave the plan paused")),
			managed.options.join(" | "),
		);
		assert.match(managed.frame, /Nothing is discarded and nothing is implemented/u);
		if (hasReadyPlan) {
			// The standing line must stop promising that the next completed plan
			// supersedes this one: for a managed plan that call is refused.
			assert.match(managed.frame, /becomes a revision you accept or cancel/u);
			assert.ok(!/the next completed plan supersedes/u.test(managed.frame));
		}
	}

	// An unmanaged first draft keeps the original, accurate wording.
	const draft = await offered((ctx) =>
		showPlanModeMenu(ctx, { ...base, managedPlan: false, hasReadyPlan: true }),
	);
	assert.ok(draft.options.includes("Discard plan and exit"));
	assert.match(draft.frame, /the next completed plan supersedes this one/u);
});

test("the post-accept ready card names the agreed revision, not a proposal", async () => {
	const base = {
		getExportDestination: () => ({ configuredPath: "PLAN.md", resolvedPath: "/tmp/PLAN.md" }),
		signal: new AbortController().signal,
		isCurrent: () => true,
		implementHere: () => undefined,
		implementFresh: () => undefined,
		exportPlan: async () => false,
		stay: () => undefined,
		exit: () => undefined,
	};
	const managed = await offered((ctx) =>
		showReadyPlanMenu(ctx, { ...base, managedPlan: true, specRevision: 4 }),
	);
	assert.match(managed.frame, /spec revision 4 is current/u);
	assert.equal(managed.options.includes("Discard plan and exit"), false);

	const draft = await offered((ctx) => showReadyPlanMenu(ctx, base));
	assert.match(draft.frame, /Proposed plan ready/u);
	assert.ok(draft.options.includes("Discard plan and exit"));
});

test("an unverified implementing plan offers confirmation and withholds completion", async () => {
	const base = {
		statusText: "An implementation plan is active, but its approval cannot be verified.",
		getExportDestination: () => ({ configuredPath: "PLAN.md", resolvedPath: "/tmp/PLAN.md" }),
		signal: new AbortController().signal,
		isCurrent: () => true,
		show: () => undefined,
		exportPlan: async () => false,
		settings: async () => true,
		confirmPlan: () => undefined,
		done: () => undefined,
		startNew: () => undefined,
		clear: () => undefined,
	};
	const verified = await offered((ctx) => showActiveImplementationMenu(ctx, base));
	assert.equal(verified.options.includes("Confirm the plan file"), false);
	assert.ok(verified.options.includes("Mark as implemented"));
	assert.ok(!verified.frame.includes("Unavailable until the plan file is confirmed"));

	const unverified = await offered((ctx) =>
		showActiveImplementationMenu(ctx, {
			...base,
			approvalNotice: "The plan file changed after it was approved.",
			canConfirm: true,
		}),
	);
	// The resolution is offered, and the two paths that would claim the plan was
	// implemented as agreed say why they are unavailable until it is taken.
	assert.ok(unverified.options.includes("Confirm the plan file"));
	assert.match(unverified.frame, /Mark as implemented/u);
	assert.equal(
		(unverified.frame.match(/Unavailable until the plan file is confirmed/gu) ?? []).length,
		2,
		"both completion paths are withheld, each saying why",
	);
	// Discarding is still available: it claims nothing. Matched by prefix because
	// the renderer truncates a long row to the frame width.
	assert.ok(
		unverified.options.some((option) => option.startsWith("Clear active implementation")),
		unverified.options.join(" | "),
	);

	// A plan file that cannot be read is unverified too, and Confirm cannot help:
	// it records the bytes on disk, and there are none to record. Offering it would
	// be an invitation to "the plan file could not be read".
	const missing = await offered((ctx) =>
		showActiveImplementationMenu(ctx, {
			...base,
			approvalNotice: "The plan file could not be read.",
			canConfirm: false,
		}),
	);
	assert.equal(missing.options.includes("Confirm the plan file"), false);
	assert.match(missing.frame, /Mark as implemented/u);
	assert.ok(
		missing.options.some((option) => option.startsWith("Clear active implementation")),
		missing.options.join(" | "),
	);
});
