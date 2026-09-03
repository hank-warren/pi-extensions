/**
 * Guardian reviews are serialized, and only guardian reviews.
 *
 * Two guarded commands in one assistant turn used to open two reviewer
 * conversations at once and race for the same review row. The queue exists to
 * make the second decision wait for the first to settle — including when the
 * first fails, is cancelled, or releases twice.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createReviewQueue } from "../review-queue.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("concurrent acquirers run one at a time, in order", async () => {
	const queue = createReviewQueue();
	const order: string[] = [];

	const run = async (label: string) => {
		const release = await queue.acquire();
		order.push(`${label}:start`);
		await tick();
		order.push(`${label}:end`);
		release();
	};

	await Promise.all([run("a"), run("b"), run("c")]);
	assert.deepEqual(order, [
		"a:start",
		"a:end",
		"b:start",
		"b:end",
		"c:start",
		"c:end",
	]);
});

test("the first slot is granted without waiting", async () => {
	const queue = createReviewQueue();
	let granted = false;
	const pending = queue.acquire().then((release) => {
		granted = true;
		release();
	});
	await pending;
	assert.equal(granted, true);
	assert.equal(queue.waiting, 0);
});

test("a reviewer that throws still hands the queue on", async () => {
	const queue = createReviewQueue();
	const seen: string[] = [];

	const failing = (async () => {
		const release = await queue.acquire();
		try {
			throw new Error("reviewer exploded");
		} finally {
			release();
		}
	})();

	const following = (async () => {
		const release = await queue.acquire();
		seen.push("second ran");
		release();
	})();

	await assert.rejects(() => failing, /reviewer exploded/);
	await following;
	assert.deepEqual(seen, ["second ran"]);
});

test("releasing twice is harmless and never lets two slots overlap", async () => {
	const queue = createReviewQueue();
	let active = 0;
	let overlapped = false;

	const run = async () => {
		const release = await queue.acquire();
		active += 1;
		if (active > 1) overlapped = true;
		await tick();
		active -= 1;
		release();
		release();
	};

	await Promise.all([run(), run(), run()]);
	assert.equal(overlapped, false);
});

test("waiting reports queued slots so a caller can re-check cancellation", async () => {
	const queue = createReviewQueue();
	const release = await queue.acquire();
	const queued = [queue.acquire(), queue.acquire()];
	await tick();
	assert.equal(queue.waiting, 2);
	release();
	for (const pending of queued) (await pending)();
	assert.equal(queue.waiting, 0);
});

test("busy is false when idle and true while a slot is held", async () => {
	// The caller renders a "queued" row on this, so a lone review must not see
	// a busy queue and flash one.
	const queue = createReviewQueue();
	assert.equal(queue.busy, false);
	const release = await queue.acquire();
	assert.equal(queue.busy, true);
	release();
	assert.equal(queue.busy, false);
});

test("an already-aborted signal is refused without taking the slot", async () => {
	const queue = createReviewQueue();
	const controller = new AbortController();
	controller.abort(new Error("already gone"));
	await assert.rejects(() => queue.acquire(controller.signal), /already gone/);
	assert.equal(queue.busy, false, "a refused acquire never held the queue");

	// The queue is still usable afterwards.
	const release = await queue.acquire();
	assert.equal(queue.busy, true);
	release();
});

test("an aborted waiter rejects promptly, without waiting out the holder", async () => {
	const queue = createReviewQueue();
	const release = await queue.acquire();
	const controller = new AbortController();
	const queued = queue.acquire(controller.signal);
	await tick();
	assert.equal(queue.waiting, 1);

	controller.abort(new Error("Esc"));
	// Rejects while the first slot is still held: no dependency on the holder.
	await assert.rejects(() => queued, /Esc/);
	assert.equal(queue.busy, true, "the holder still owns the queue");
	release();
});

test("an aborted waiter never lets the next one overtake the live holder", async () => {
	// The FIFO trap. The naive abort path resolves the aborted waiter's own tail
	// and throws, which hands the queue to whoever is behind it *while the first
	// command is still inside its critical section* — silently undoing the
	// mutual exclusion the queue exists to provide.
	const queue = createReviewQueue();
	const order: string[] = [];
	let active = 0;
	let overlapped = false;

	const release = await queue.acquire();
	active += 1;
	order.push("holder:start");

	const controller = new AbortController();
	const aborted = queue.acquire(controller.signal);
	const behind = queue.acquire().then((releaseBehind) => {
		active += 1;
		if (active > 1) overlapped = true;
		order.push("behind:start");
		active -= 1;
		releaseBehind();
	});
	await tick();

	controller.abort(new Error("Esc"));
	await assert.rejects(() => aborted, /Esc/);
	await tick();
	await tick();
	assert.deepEqual(order, ["holder:start"], "the queue did not advance past the live holder");

	active -= 1;
	order.push("holder:end");
	release();
	await behind;

	assert.equal(overlapped, false, "two slots were never held at once");
	assert.deepEqual(order, ["holder:start", "holder:end", "behind:start"]);
	assert.equal(queue.busy, false);
	assert.equal(queue.waiting, 0);
});

test("no abort listener survives an acquire, in either outcome", async () => {
	// A session-lifetime signal outlives many reviews; one dangling listener per
	// queued command is a leak that only shows up under the exact load this
	// queue was added to handle.
	const queue = createReviewQueue();
	const controller = new AbortController();
	const signal = controller.signal as AbortSignal & { listenerCount?: (n: string) => number };
	const count = () =>
		typeof signal.listenerCount === "function" ? signal.listenerCount("abort") : 0;
	assert.equal(count(), 0);

	// Granted immediately: the listener registered for the race is removed.
	const first = await queue.acquire(controller.signal);
	assert.equal(count(), 0, "no listener after an uncontended acquire");

	// Waited, then granted: same.
	const queued = queue.acquire(controller.signal);
	await tick();
	first();
	(await queued)();
	assert.equal(count(), 0, "no listener after a contended acquire");

	// Waited, then aborted: same.
	const holder = await queue.acquire();
	const doomed = queue.acquire(controller.signal);
	await tick();
	controller.abort(new Error("stop"));
	await assert.rejects(() => doomed, /stop/);
	assert.equal(count(), 0, "no listener after an aborted acquire");
	holder();
});
