import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContinuation, buildObjectivePoke } from "../src/messages.js";
import { compactContinuationMessage, compactPokeMessage } from "../src/render.js";
import type { LoopState } from "../src/state.js";

const LOOP: LoopState = {
	id: "loop1234",
	status: "active",
	objective: "get CI green",
	prompt: "check the release queue",
	intervalMs: 300_000,
	maxTurns: 25,
	compactAt: 0.7,
	iteration: 3,
	automaticTurns: 5,
	startedAt: 0,
	expiresAt: 604_800_000,
};

test("poke chips compact real pokes and distinguish stall from an elapsed wait", () => {
	assert.equal(
		compactPokeMessage(buildObjectivePoke(LOOP)),
		"*⏰ loop wake 4 · stalled · check the release queue*",
	);
	assert.equal(
		compactPokeMessage(
			buildObjectivePoke(
				{ ...LOOP, waiting: { reason: "waiting for CI", resumeAt: 1 } },
				"wait-elapsed",
			),
		),
		"*⏰ loop wake 4 · wait elapsed · check the release queue*",
	);
	assert.equal(
		compactPokeMessage(buildObjectivePoke({ ...LOOP, prompt: undefined, maxTurns: null })),
		"*⏰ loop wake 4 · stalled*",
	);
});

test("poke chips never fire on ordinary text or quoted markers without the canonical head", () => {
	assert.equal(compactPokeMessage("please wake the loop"), undefined);
	assert.equal(
		compactPokeMessage("saw this in a transcript\n\n<!-- pi-loop-poke:loop1234:4 -->"),
		undefined,
	);
});

test("continuation chips label kickoff and continue, and ignore foreign text", () => {
	const standalone: LoopState = { ...LOOP, prompt: undefined };
	assert.equal(compactContinuationMessage(buildContinuation(standalone, "kickoff")), "*⟳ loop kickoff #6*");
	assert.equal(compactContinuationMessage(buildContinuation(standalone, "continue")), "*⟳ loop continue #6*");
	assert.equal(
		compactContinuationMessage(buildContinuation(LOOP, "continue")),
		"*⟳ loop continue #6 · check the release queue*",
	);
	assert.equal(compactContinuationMessage("please continue the loop"), undefined);
	// A poke is not a continuation and must not borrow its chip.
	assert.equal(compactContinuationMessage(buildObjectivePoke(standalone)), undefined);
});
