/**
 * Ground rules, end to end: propose → proposal → card → approval screen →
 * loop state → the per-turn system append → a fresh-session handoff.
 *
 * They are the one thing a user can fix *before* a loop runs unattended, and
 * every one of those hops is a place they could be silently dropped. The
 * hop that matters most is the last: a loop handed to a fresh session carries
 * only its state, so a constraint that does not persist is a constraint the
 * loop that actually runs never sees.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { loopApprovalScreen } from "../src/loop-action-menus.js";
import { buildLoopObjectivePrompt } from "../src/objective.js";
import { buildProposal, MAX_GROUND_RULES, renderProposalCard } from "../src/planning.js";
import { LOOP_PROPOSAL_ENTRY_TYPE } from "../src/presentation.js";
import { registerLoopProposeTool } from "../src/propose-tool.js";
import { normalizeLoopState } from "../src/state.js";
import { createLoopHarness } from "./support/mock-pi.js";

const DEFAULTS = { intervalMs: 600_000, maxTurns: null, expiresInMs: 604_800_000 };
const RULES = ["never touch production", "never force-push"];

test("ground rules reach the card and the approval screen", () => {
	const proposal = buildProposal("- ship it, verified by npm test", DEFAULTS, 0, {
		groundRules: RULES,
	});
	assert.deepEqual(proposal.groundRules, RULES);

	const card = renderProposalCard(proposal).join("\n");
	assert.match(card, /Ground rules the loop must never violate\*\* \(2\)/);
	assert.match(card, /- never touch production/);
	// They are constraints, not criteria: the criteria section must not grow.
	assert.match(card, /Criteria the gate will hold you to\*\* \(1\)/);
	assert.equal(proposal.criteria.length, 1);

	assert.match(loopApprovalScreen(proposal).lines?.join("\n") ?? "", /2 ground rules/);
	// No rules, no section and no count — an empty heading is worse than none.
	const bare = buildProposal("- ship it", DEFAULTS, 0);
	assert.equal(bare.groundRules, undefined);
	assert.equal(renderProposalCard(bare).join("\n").includes("Ground rules"), false);
	assert.equal(loopApprovalScreen(bare).lines?.join("\n").includes("ground rule"), false);
});

test("drafted rules are trimmed and bounded rather than refused", () => {
	// A malformed list must not cost the whole draft: the card is where the
	// user reviews them, so normalizing beats refusing.
	const proposal = buildProposal("ship it", DEFAULTS, 0, {
		groundRules: ["  keep it reversible  ", "", "   ", ...Array(20).fill("x")],
	});
	assert.equal(proposal.groundRules?.[0], "keep it reversible");
	assert.equal(proposal.groundRules?.length, MAX_GROUND_RULES);
	assert.equal(buildProposal("ship it", DEFAULTS, 0, { groundRules: ["", " "] }).groundRules, undefined);
});

test("loop_propose accepts ground rules and reports them", async () => {
	const harness = createLoopHarness();
	try {
		registerLoopProposeTool(harness.pi, harness.controller);
		harness.controller.beginPlanning();
		const tool = harness.tools.get("loop_propose") as {
			execute(
				id: string,
				params: Record<string, unknown>,
				signal: undefined,
				onUpdate: undefined,
				ctx: unknown,
			): Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
		};
		const result = await tool.execute(
			"call-1",
			{ objective: "- ship it, verified by npm test", ground_rules: RULES },
			undefined,
			undefined,
			harness.ctx,
		);
		assert.equal(result.details.groundRules, 2);
		assert.match(result.content.map((part) => part.text).join("\n"), /2 ground rules/);
		const card = harness.branch.find(
			(entry) => (entry as { customType?: string }).customType === LOOP_PROPOSAL_ENTRY_TYPE,
		) as { data?: { markdown?: string } } | undefined;
		assert.match(String(card?.data?.markdown), /never force-push/);
		assert.deepEqual(harness.controller.planning.proposal?.groundRules, RULES);
	} finally {
		harness.cleanup();
	}
});

test("an approved loop carries its ground rules into state and into every turn", (t) => {
	const harness = createLoopHarness();
	t.after(harness.cleanup);
	const started = harness.controller.startLoop(harness.ctx, {
		kind: "start",
		requestedMs: 600_000,
		intervalMs: 600_000,
		clamped: false,
		prompt: "- ship it, verified by npm test",
		groundRules: RULES,
	});
	assert.ok(started.ok);
	assert.deepEqual(started.loop.groundRules, RULES);

	const append = buildLoopObjectivePrompt(started.loop, harness.controller.ledger);
	assert.match(append ?? "", /Ground rules \(hard constraints, never violate\):/);
	assert.match(append ?? "", /- never touch production/);
	// A constraint the loop can talk itself out of is not a constraint.
	assert.match(append ?? "", /call loop_wait/);

	// The handoff path: state is all that crosses to a fresh session.
	const replayed = normalizeLoopState(JSON.parse(JSON.stringify(started.loop)) as unknown);
	assert.deepEqual(replayed?.groundRules, RULES);
	assert.equal(
		buildLoopObjectivePrompt(replayed!, harness.controller.ledger),
		append,
		"a restored loop reproduces the append byte-for-byte, cache included",
	);
});

test("a persisted ground-rule list fails closed on the shapes that are not one", () => {
	const base = {
		id: "loop1234",
		status: "active",
		objective: "ship it",
		intervalMs: 600_000,
		maxTurns: null,
		compactAt: null,
		iteration: 0,
		automaticTurns: 0,
		startedAt: 0,
		expiresAt: 1,
	};
	assert.equal(normalizeLoopState({ ...base, groundRules: "never force-push" }), undefined);
	assert.equal(normalizeLoopState({ ...base, groundRules: [1] }), undefined);
	// Empty survives as absent, so an approved loop with no rules and a
	// restored one are the same state.
	assert.equal(normalizeLoopState({ ...base, groundRules: [] })?.groundRules, undefined);
	assert.deepEqual(normalizeLoopState({ ...base, groundRules: ["  a  "] })?.groundRules, ["a"]);
});
