import assert from "node:assert/strict";
import test from "node:test";
import {
	cacheReadHitRate,
	CacheCelebrationController,
	qualifyingCacheHitPercent,
	triggerCacheCelebrationForMessage,
} from "../cache-celebration.ts";

interface ControllerHarness {
	controller: CacheCelebrationController;
	advance(ms: number): void;
	tick(): void;
	renders: number;
	scheduled: number;
	cancelled: number;
	intervals: number[];
	activeTimers(): number;
}

function controllerHarness(): ControllerHarness {
	let now = 0;
	let nextHandle = 0;
	const callbacks = new Map<number, () => void>();
	const state = {
		renders: 0,
		scheduled: 0,
		cancelled: 0,
		intervals: [] as number[],
		advance(ms: number): void {
			now += ms;
		},
		tick(): void {
			for (const callback of [...callbacks.values()]) callback();
		},
		activeTimers(): number {
			return callbacks.size;
		},
	};
	const controller = new CacheCelebrationController(
		() => {
			state.renders += 1;
		},
		{
			now: () => now,
			schedule: (callback, intervalMs) => {
				const handle = nextHandle++;
				callbacks.set(handle, callback);
				state.scheduled += 1;
				state.intervals.push(intervalMs);
				return handle;
			},
			cancel: (handle) => {
				callbacks.delete(handle as number);
				state.cancelled += 1;
			},
		},
	);
	return Object.assign(state, { controller }) as ControllerHarness;
}

test("cacheReadHitRate evaluates each response over prompt-cache candidates", () => {
	assert.equal(cacheReadHitRate({ input: 11, cacheRead: 89, cacheWrite: 0 }), 0.89);
	assert.equal(cacheReadHitRate({ input: 10, cacheRead: 90, cacheWrite: 0 }), 0.9);
	assert.equal(cacheReadHitRate({ input: 4, cacheRead: 96, cacheWrite: 0 }), 0.96);
	assert.equal(cacheReadHitRate({ input: 0, cacheRead: 90, cacheWrite: 10 }), 0.9);
	assert.equal(cacheReadHitRate({ input: 0, cacheRead: 90, cacheWrite: 11 }), 90 / 101);
	assert.equal(cacheReadHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
});

test("qualifyingCacheHitPercent includes exactly 96% and rounds only the badge", () => {
	assert.equal(qualifyingCacheHitPercent({ input: 10, cacheRead: 90, cacheWrite: 0 }), null);
	assert.equal(qualifyingCacheHitPercent({ input: 5, cacheRead: 95, cacheWrite: 0 }), null);
	// 95.95% rounds to a 96 badge but must not qualify: the gate is the raw ratio.
	assert.equal(qualifyingCacheHitPercent({ input: 405, cacheRead: 9595, cacheWrite: 0 }), null);
	assert.equal(qualifyingCacheHitPercent({ input: 4, cacheRead: 96, cacheWrite: 0 }), 96);
	assert.equal(qualifyingCacheHitPercent({ input: 3, cacheRead: 97, cacheWrite: 0 }), 97);
	assert.equal(qualifyingCacheHitPercent({ input: 9, cacheRead: 961, cacheWrite: 30 }), 96);
	assert.equal(qualifyingCacheHitPercent({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
});

test("controller starts, advances frames, expires, and restores the footer", () => {
	const h = controllerHarness();
	h.controller.start(96);

	assert.deepEqual(h.controller.snapshot(), { percent: 96, frame: 0 });
	assert.equal(h.renders, 1);
	assert.equal(h.activeTimers(), 1);
	assert.deepEqual(h.intervals, [60]);

	h.advance(60);
	h.tick();
	assert.deepEqual(h.controller.snapshot(), { percent: 96, frame: 1 });
	assert.equal(h.renders, 2);

	h.advance(1_940);
	h.tick();
	assert.equal(h.controller.snapshot(), undefined);
	assert.equal(h.activeTimers(), 0);
	assert.equal(h.cancelled, 1);
	assert.equal(h.renders, 3);
});

test("controller retrigger restarts frame zero with the new percentage", () => {
	const h = controllerHarness();
	h.controller.start(91);
	h.advance(120);
	h.tick();
	assert.deepEqual(h.controller.snapshot(), { percent: 91, frame: 2 });

	h.controller.start(99);
	assert.deepEqual(h.controller.snapshot(), { percent: 99, frame: 0 });
	assert.equal(h.scheduled, 2);
	assert.equal(h.cancelled, 1);
	assert.equal(h.activeTimers(), 1);

	h.advance(60);
	h.tick();
	assert.deepEqual(h.controller.snapshot(), { percent: 99, frame: 1 });
});

test("footer detach cleanup is idempotent and leaks no animation timers", () => {
	const h = controllerHarness();
	h.controller.start(95);
	h.controller.dispose();
	h.controller.dispose();

	assert.equal(h.controller.snapshot(), undefined);
	assert.equal(h.activeTimers(), 0);
	assert.equal(h.cancelled, 1);
});

test("turn-end message integration triggers only qualifying assistant usage", () => {
	const percentages: number[] = [];
	const target = { start: (percent: number) => percentages.push(percent) };

	assert.equal(triggerCacheCelebrationForMessage({ role: "assistant", usage: { input: 4, cacheRead: 96, cacheWrite: 0 } }, target), true);
	assert.equal(triggerCacheCelebrationForMessage({ role: "assistant", usage: { input: 11, cacheRead: 89, cacheWrite: 0 } }, target), false);
	assert.equal(triggerCacheCelebrationForMessage({ role: "assistant", usage: { input: 5, cacheRead: 95, cacheWrite: 0 } }, target), false);
	assert.equal(triggerCacheCelebrationForMessage({ role: "assistant", usage: { input: 405, cacheRead: 9595, cacheWrite: 0 } }, target), false);
	assert.equal(triggerCacheCelebrationForMessage({ role: "assistant", usage: { input: 0, cacheRead: 0, cacheWrite: 0 } }, target), false);
	assert.equal(triggerCacheCelebrationForMessage({ role: "toolResult", usage: { input: 0, cacheRead: 100, cacheWrite: 0 } }, target), false);
	assert.deepEqual(percentages, [96]);
});
