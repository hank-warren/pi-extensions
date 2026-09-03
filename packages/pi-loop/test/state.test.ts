import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAN_MODE_ENTER_EXIT_SEQUENCE } from "./fixtures/plan-mode-sequences.js";
import {
	LOOP_STATE_ENTRY_TYPE,
	type LoopState,
	normalizeLoopState,
	PLAN_MODE_STATE_ENTRY_TYPE,
	readPlanModeEnabled,
	restoreLoopState,
} from "../src/state.js";

const VALID: LoopState = {
	id: "abc12345",
	status: "active",
	prompt: "check the queue",
	intervalMs: 300_000,
	maxTurns: 25,
	compactAt: 0.7,
	iteration: 3,
	automaticTurns: 5,
	startedAt: 1_000,
	expiresAt: 2_000,
	lastWakeAt: 1_500,
};

function entry(customType: string, data: unknown) {
	return { type: "custom", customType, data };
}

test("normalizeLoopState round-trips a valid state and fails closed on garbage", () => {
	assert.deepEqual(normalizeLoopState(structuredClone(VALID)), VALID);
	const promptless: Partial<LoopState> = { ...VALID };
	delete promptless.prompt;
	delete promptless.lastWakeAt;
	assert.deepEqual(normalizeLoopState(promptless), promptless);
	assert.deepEqual(normalizeLoopState({ ...VALID, maxTurns: null })?.maxTurns, null);
	assert.deepEqual(normalizeLoopState({ ...VALID, compactAt: null })?.compactAt, null);

	for (const bad of [
		undefined,
		null,
		"loop",
		[],
		{},
		{ ...VALID, id: "" },
		{ ...VALID, id: "has space" },
		{ ...VALID, id: "has:colon" },
		{ ...VALID, status: "running" },
		{ ...VALID, prompt: "   " },
		{ ...VALID, intervalMs: 0 },
		{ ...VALID, intervalMs: "5m" },
		{ ...VALID, maxTurns: 0 },
		{ ...VALID, compactAt: 1.5 },
		{ ...VALID, iteration: -1 },
		{ ...VALID, automaticTurns: -1 },
		{ ...VALID, automaticTurns: "many" },
		{ ...VALID, startedAt: Number.NaN },
		{ ...VALID, expiresAt: "soon" },
		{ ...VALID, lastWakeAt: -5 },
	]) {
		assert.equal(normalizeLoopState(bad), undefined, JSON.stringify(bad));
	}
});

test("a loop persisted with the two caps restores under the single one", () => {
	// A live session upgrading mid-loop must keep its loop. The wake cap and
	// the turn cap collapsed into `maxTurns`, so an in-flight loop keeps the
	// tighter of the two it was already running under rather than being widened
	// or dropped as unparsable; its wake counter survives for display only.
	const { maxTurns: _maxTurns, ...rest } = VALID;
	const twoCaps: Record<string, unknown> = { ...rest, maxIterations: 5, maxAutomaticTurns: 25 };
	assert.equal(normalizeLoopState(twoCaps)?.maxTurns, 5);
	assert.equal(normalizeLoopState(twoCaps)?.iteration, VALID.iteration);
	assert.equal(normalizeLoopState({ ...twoCaps, maxIterations: null })?.maxTurns, 25);
	assert.equal(normalizeLoopState({ ...twoCaps, maxIterations: 0 }), undefined);

	// Older still: no turn counter and no turn cap at all.
	const preSplit: Record<string, unknown> = { ...rest, maxIterations: 25 };
	delete preSplit.automaticTurns;
	const restored = normalizeLoopState(preSplit);
	assert.equal(restored?.automaticTurns, 0);
	assert.equal(restored?.maxTurns, 25);
});

test("restoreLoopState reads the newest loop-state entry, fail-open", () => {
	const older = { ...VALID, iteration: 1 };
	const branch = [
		entry(LOOP_STATE_ENTRY_TYPE, { loop: older }),
		entry("unrelated", { x: 1 }),
		{ type: "user", data: {} },
		entry(LOOP_STATE_ENTRY_TYPE, { loop: VALID }),
	];
	assert.deepEqual(restoreLoopState(branch), VALID);
	assert.equal(restoreLoopState([]), undefined);
	assert.equal(restoreLoopState([entry(LOOP_STATE_ENTRY_TYPE, { loop: { broken: true } })]), undefined);
	assert.equal(restoreLoopState([entry(LOOP_STATE_ENTRY_TYPE, "not-a-record")]), undefined);
});

test("readPlanModeEnabled is true only for a well-formed enabled entry", () => {
	assert.equal(readPlanModeEnabled([entry(PLAN_MODE_STATE_ENTRY_TYPE, { enabled: true })]), true);
	assert.equal(readPlanModeEnabled([entry(PLAN_MODE_STATE_ENTRY_TYPE, { enabled: false })]), false);
	assert.equal(readPlanModeEnabled([entry(PLAN_MODE_STATE_ENTRY_TYPE, { enabled: "yes" })]), false);
	assert.equal(readPlanModeEnabled([]), false);
	// Newest entry wins: pi-plan-mode's real enter-then-exit sequence, mirrored
	// from its producer contract test.
	assert.equal(readPlanModeEnabled(PLAN_MODE_ENTER_EXIT_SEQUENCE), false);
	assert.equal(readPlanModeEnabled(PLAN_MODE_ENTER_EXIT_SEQUENCE.slice(0, 1)), true);
});
