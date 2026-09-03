import assert from "node:assert/strict";
import { test } from "node:test";
import { decideContinuation, decideTick, type TickEnvironment } from "../src/decide.js";
import type { LoopState } from "../src/state.js";

const NOW = 1_000_000;

function loop(patch: Partial<LoopState> = {}): LoopState {
	return {
		id: "loop1234",
		status: "active",
		objective: "get CI green",
		intervalMs: 300_000,
		maxTurns: 25,
		compactAt: 0.7,
		iteration: 0,
		automaticTurns: 0,
		startedAt: NOW - 60_000,
		expiresAt: NOW + 604_800_000,
		...patch,
	};
}

function env(patch: Partial<TickEnvironment> = {}): TickEnvironment {
	return {
		now: NOW,
		busy: false,
		compacting: false,
		planModeEnabled: false,
		...patch,
	};
}

test("inactive loops never poke", () => {
	assert.deepEqual(decideTick(loop({ status: "paused" }), env()), {
		action: "none",
		reason: "loop-not-active",
	});
	assert.deepEqual(decideTick(loop({ status: "stopped" }), env()), {
		action: "none",
		reason: "loop-not-active",
	});
});

test("plan mode, busy agent, and in-flight compaction all skip", () => {
	assert.deepEqual(decideTick(loop(), env({ planModeEnabled: true })), {
		action: "skip",
		reason: "plan-mode-active",
	});
	assert.deepEqual(decideTick(loop(), env({ busy: true })), {
		action: "skip",
		reason: "agent-busy",
	});
	assert.deepEqual(decideTick(loop(), env({ compacting: true })), {
		action: "skip",
		reason: "compaction-in-flight",
	});
	// Plan mode wins over busy: never inject into planning even at settle.
	assert.deepEqual(decideTick(loop(), env({ planModeEnabled: true, busy: true })), {
		action: "skip",
		reason: "plan-mode-active",
	});
});

test("an idle session with the criteria unmet pokes", () => {
	assert.deepEqual(decideTick(loop(), env()), { action: "poke", reason: "objective-stalled" });
});

test("the turn cap stops before poking, and unlimited never caps", () => {
	assert.deepEqual(decideTick(loop({ automaticTurns: 25 }), env()), {
		action: "stop",
		reason: "max-turns",
	});
	assert.equal(decideTick(loop({ automaticTurns: 24 }), env()).action, "poke");
	assert.equal(decideTick(loop({ automaticTurns: 9_999, maxTurns: null }), env()).action, "poke");
	// Delivered wakes are counted for display, and cap nothing: a settle-paced
	// loop can run its whole life without one, which is why the wake cap went.
	assert.equal(decideTick(loop({ iteration: 9_999 }), env()).action, "poke");
});

test("expiry buys one last turn, then stops", () => {
	const expired = env({ now: NOW + 700_000_000 });
	assert.deepEqual(decideTick(loop(), expired), { action: "expire", reason: "expiry-final-wake" });
	assert.deepEqual(
		decideTick(loop({ expiring: true }), expired),
		{ action: "expire", reason: "loop-expired" },
		"once that turn has been delivered, expiry stops the loop",
	);
	// Expiry outranks every hold and the cap.
	assert.equal(
		decideTick(loop({ automaticTurns: 25 }), env({ ...expired, planModeEnabled: true, busy: true }))
			.action,
		"expire",
	);
});

test("the cap counts pokes and continuations alike", () => {
	// One cap, counting every turn the loop caused, whichever driver caused it.
	assert.deepEqual(decideTick(loop({ automaticTurns: 3, maxTurns: 3 }), env()), {
		action: "stop",
		reason: "max-turns",
	});
	assert.deepEqual(decideContinuation(loop({ automaticTurns: 3, maxTurns: 3 }), env()), {
		action: "stop",
		reason: "max-turns",
	});
});

test("decideContinuation continues a settled loop and nothing else", () => {
	assert.deepEqual(decideContinuation(loop(), env()), {
		action: "continue",
		reason: "settled-idle",
	});
	assert.deepEqual(decideContinuation(loop({ status: "paused" }), env()), {
		action: "none",
		reason: "loop-not-active",
	});
});

test("decideContinuation shares the tick's hold-and-end precedence", () => {
	assert.deepEqual(decideContinuation(loop(), env({ now: NOW + 700_000_000 })), {
		action: "expire",
		reason: "expiry-final-wake",
	});
	assert.deepEqual(decideContinuation(loop(), env({ planModeEnabled: true })), {
		action: "skip",
		reason: "plan-mode-active",
	});
	assert.deepEqual(decideContinuation(loop(), env({ compacting: true })), {
		action: "skip",
		reason: "compaction-in-flight",
	});
	assert.deepEqual(decideContinuation(loop(), env({ busy: true })), {
		action: "skip",
		reason: "agent-busy",
	});
	assert.deepEqual(decideContinuation(loop({ automaticTurns: 25 }), env()), {
		action: "stop",
		reason: "max-turns",
	});
	// Expiry outranks plan mode, which outranks compaction, which outranks busy.
	assert.equal(
		decideContinuation(
			loop(),
			env({ now: NOW + 700_000_000, planModeEnabled: true, busy: true }),
		).action,
		"expire",
	);
});

test("a declared wait holds both drivers until its deadline comes due", () => {
	const waiting = loop({ waiting: { reason: "waiting for CI", resumeAt: NOW + 60_000 } });
	// Not stalled — waiting on the world. Neither driver acts.
	assert.deepEqual(decideTick(waiting, env()), { action: "skip", reason: "loop-waiting" });
	assert.deepEqual(decideContinuation(waiting, env()), { action: "skip", reason: "loop-waiting" });

	// A wait with no deadline waits until something else wakes the session.
	const openEnded = loop({ waiting: { reason: "waiting for a human" } });
	assert.deepEqual(decideTick(openEnded, env()), { action: "skip", reason: "loop-waiting" });

	// Past the deadline the wait is due: this wake is the one it asked for.
	assert.deepEqual(decideTick(waiting, env({ now: NOW + 60_001 })), {
		action: "poke",
		reason: "wait-elapsed",
	});
	assert.deepEqual(decideContinuation(waiting, env({ now: NOW + 60_001 })), {
		action: "continue",
		reason: "settled-idle",
	});
});

test("expiry and the cap still outrank a wait", () => {
	// A waiting loop that has run out of time or budget must not linger.
	const waiting = { reason: "waiting for CI", resumeAt: NOW + 60_000 };
	assert.deepEqual(decideTick(loop({ waiting }), env({ now: NOW + 700_000_000 })), {
		action: "expire",
		reason: "expiry-final-wake",
	});
	// The cap is checked after the hold, so a waiting loop keeps its wait: it is
	// not burning turns, and the deadline wake will re-evaluate it.
	assert.deepEqual(decideTick(loop({ automaticTurns: 25, waiting }), env()), {
		action: "skip",
		reason: "loop-waiting",
	});
});
