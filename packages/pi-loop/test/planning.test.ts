import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProposal, renderProposalCard } from "../src/planning.js";

const DEFAULTS = { intervalMs: 600_000, maxTurns: 25, expiresInMs: 604_800_000 };

test("a proposal derives the criteria the engine will actually freeze", () => {
	// The card exists so the split is visible while it can still be changed.
	// Deriving here with the same function is what stops it describing one
	// gate while the loop freezes another.
	const proposal = buildProposal(
		[
			"- Get the flaky auth test green,",
			"  verified by npm test -- auth passing five times.",
			"- Update docs/testing.md with the root cause.",
		].join("\n"),
		DEFAULTS,
		1_000,
	);
	assert.deepEqual(
		proposal.criteria.map((criterion) => `${criterion.id}:${criterion.description}`),
		[
			"c1:Get the flaky auth test green, verified by npm test -- auth passing five times.",
			"c2:Update docs/testing.md with the root cause.",
		],
	);
	assert.equal(proposal.intervalMs, 600_000);
	assert.equal(proposal.maxTurns, 25);
	assert.equal(proposal.proposedAt, 1_000);
});

test("overrides ride on the proposal, and an unlimited cap survives", () => {
	const proposal = buildProposal("ship it, verified by npm test", DEFAULTS, 1, {
		intervalMs: 1_800_000,
		maxTurns: null,
		expiresInMs: 172_800_000,
	});
	assert.equal(proposal.intervalMs, 1_800_000);
	// null is unlimited and must not be read as "absent, use the default".
	assert.equal(proposal.maxTurns, null);
	assert.equal(proposal.expiresInMs, 172_800_000);
});

test("the card shows the objective, every criterion, the cadence and the caps", () => {
	const card = renderProposalCard(
		buildProposal("- do a\n- do b", DEFAULTS, 0, { intervalMs: 1_800_000, maxTurns: null }),
	).join("\n");
	assert.match(card, /Loop ready to start/);
	assert.match(card, /> - do a/);
	assert.match(card, /Criteria the gate will hold you to\*\* \(2\)/);
	assert.match(card, /`c1`  do a/);
	assert.match(card, /`c2`  do b/);
	assert.match(card, /every 30m/);
	// A fallback heartbeat is not a pacemaker, and the card is where that gets
	// said: it is the only place a user sets the cadence deliberately.
	assert.match(card, /the loop advances whenever the session settles/);
	assert.match(card, /Turn cap\*\* unlimited/);
	assert.match(card, /Expires\*\* 7d/);
});
