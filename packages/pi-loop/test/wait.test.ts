import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createLoopWait,
	LoopWaitTimer,
	MAX_WAIT_DELAY_MS,
	MIN_WAIT_DELAY_MS,
	normalizeLoopWait,
	resolveWaitDelay,
} from "../src/wait.js";

test("the wait delay is clamped at both ends and the clamp is reported", () => {
	// Below the floor a wait is polling, which is what the tool replaces.
	assert.deepEqual(resolveWaitDelay(5_000), {
		requestedMs: 5_000,
		effectiveMs: MIN_WAIT_DELAY_MS,
		clamped: true,
	});
	// Above the ceiling it stops being a wait; the heartbeat covers that.
	assert.deepEqual(resolveWaitDelay(86_400_000), {
		requestedMs: 86_400_000,
		effectiveMs: MAX_WAIT_DELAY_MS,
		clamped: true,
	});
	assert.deepEqual(resolveWaitDelay(600_000), {
		requestedMs: 600_000,
		effectiveMs: 600_000,
		clamped: false,
	});
	// Omitted: quiet until something else wakes the session.
	assert.deepEqual(resolveWaitDelay(undefined), { clamped: false });
	assert.deepEqual(resolveWaitDelay(Number.NaN), { clamped: false });
});

test("createLoopWait turns a delay into a deadline, or no deadline at all", () => {
	assert.deepEqual(createLoopWait("waiting for CI", 600_000, 1_000), {
		reason: "waiting for CI",
		resumeAt: 601_000,
	});
	assert.deepEqual(createLoopWait("waiting for CI", undefined, 1_000), {
		reason: "waiting for CI",
	});
	assert.equal(createLoopWait("waiting for CI", 1, 1_000).resumeAt, 1_000 + MIN_WAIT_DELAY_MS);
});

test("normalizeLoopWait fails closed", () => {
	assert.deepEqual(normalizeLoopWait({ reason: " CI " }), { reason: "CI" });
	assert.deepEqual(normalizeLoopWait({ reason: "CI", resumeAt: 5 }), { reason: "CI", resumeAt: 5 });
	for (const bad of [
		undefined,
		null,
		"waiting",
		[],
		{},
		{ reason: "" },
		{ reason: "   " },
		{ reason: "x".repeat(1_001) },
		{ reason: "CI", resumeAt: -1 },
		{ reason: "CI", resumeAt: "soon" },
		{ reason: "CI", resumeAt: 1.5 },
	]) {
		assert.equal(normalizeLoopWait(bad), undefined, JSON.stringify(bad));
	}
});

test("the wait timer is generation-guarded: a cleared wait never fires", async () => {
	const timer = new LoopWaitTimer();
	let fired = 0;
	timer.schedule(Date.now() + 5, () => {
		fired += 1;
	});
	timer.clear();
	// Rescheduling after a clear must not resurrect the first callback either.
	timer.schedule(Date.now() + 5, () => {
		fired += 10;
	});
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(fired, 10, "only the live generation fired");
});

test("a deadline already in the past fires immediately, not never", async () => {
	const timer = new LoopWaitTimer();
	let fired = false;
	timer.schedule(Date.now() - 60_000, () => {
		fired = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(fired, true);
});
