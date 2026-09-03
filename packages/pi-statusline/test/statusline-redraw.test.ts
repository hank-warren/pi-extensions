import assert from "node:assert/strict";
import { test } from "node:test";
import { TuiAltScreen, type Terminal, visibleWidth } from "@earendil-works/pi-tui";
import {
	DEFAULT_IDLE_INTERVAL_MS,
	DEFAULT_MIN_GAP_MS,
	DEFAULT_ROW_REFRESH_INTERVAL_MS,
	FullRedrawScheduler,
	type RedrawTarget,
} from "../redraw.ts";

interface FakeTarget extends RedrawTarget {
	mode: string;
	forced: number;
	unforced: number;
}

function fakeTarget(mode: string): FakeTarget {
	return {
		mode,
		forced: 0,
		unforced: 0,
		requestRender(force?: boolean): void {
			if (force) this.forced += 1;
			else this.unforced += 1;
		},
	};
}

class FakeTerminal implements Terminal {
	readonly columns = 20;
	readonly rows = 2;
	readonly kittyProtocolActive = false;
	readonly writes: string[] = [];

	start(): void {}
	stop(): void {}
	drainInput(): Promise<void> {
		return Promise.resolve();
	}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

interface Harness {
	scheduler: FullRedrawScheduler;
	tick: (intervalMs: number) => void;
	advance: (ms: number) => void;
	scheduled: number;
	cancelled: number;
	intervals: number[];
}

function harness(
	options: { minGapMs?: number; rowRefreshIntervalMs?: number; idleIntervalMs?: number } = {},
): Harness {
	let now = 1_000;
	let nextHandle = 0;
	const callbacks = new Map<number, { callback: () => void; intervalMs: number }>();
	const state = {
		scheduled: 0,
		cancelled: 0,
		intervals: [] as number[],
		tick: (intervalMs: number) => {
			for (const scheduled of callbacks.values()) {
				if (scheduled.intervalMs === intervalMs) scheduled.callback();
			}
		},
		advance: (ms: number) => {
			now += ms;
		},
	};
	const scheduler = new FullRedrawScheduler({
		...options,
		now: () => now,
		schedule: (callback, intervalMs) => {
			const handle = nextHandle++;
			callbacks.set(handle, { callback, intervalMs });
			state.scheduled += 1;
			state.intervals.push(intervalMs);
			return handle;
		},
		cancel: (handle) => {
			callbacks.delete(handle as number);
			state.cancelled += 1;
		},
	});
	return Object.assign(state, { scheduler }) as Harness;
}

test("request forces a full redraw in fullscreen mode", () => {
	const h = harness();
	const target = fakeTarget("fullscreen");
	h.scheduler.attach(target);

	assert.equal(h.scheduler.request(), true);
	assert.equal(target.forced, 1);
	assert.equal(target.unforced, 0);
});

test("request is a no-op in regular mode", () => {
	const h = harness();
	const target = fakeTarget("regular");
	h.scheduler.attach(target);

	assert.equal(h.scheduler.request(), false);
	assert.equal(target.forced, 0);
});

test("request follows runtime tui mode switches", () => {
	const h = harness({ minGapMs: 0 });
	const target = fakeTarget("regular");
	h.scheduler.attach(target);

	assert.equal(h.scheduler.request(), false);
	target.mode = "fullscreen";
	assert.equal(h.scheduler.request(), true);
	target.mode = "regular";
	assert.equal(h.scheduler.request(), false);
	assert.equal(target.forced, 1);
});

test("request is throttled to the minimum gap", () => {
	const h = harness({ minGapMs: 5_000 });
	const target = fakeTarget("fullscreen");
	h.scheduler.attach(target);

	assert.equal(h.scheduler.request(), true);
	h.advance(4_999);
	assert.equal(h.scheduler.request(), false);
	h.advance(1);
	assert.equal(h.scheduler.request(), true);
	assert.equal(target.forced, 2);
});

test("decorate makes footer bytes change without changing visible contents", () => {
	const h = harness();
	const target = fakeTarget("fullscreen");
	h.scheduler.attach(target);
	const source = ["first", "second"];

	const first = h.scheduler.decorate(source);
	const samePhase = h.scheduler.decorate(source);
	h.scheduler.requestRowRefresh();
	const second = h.scheduler.decorate(source);
	h.scheduler.requestRowRefresh();
	const third = h.scheduler.decorate(source);
	const empty = h.scheduler.decorate([""]);

	assert.deepEqual(first, samePhase);
	assert.notDeepEqual(first, second);
	assert.deepEqual(first, third);
	assert.deepEqual(first.map(visibleWidth), source.map(visibleWidth));
	assert.deepEqual(second.map(visibleWidth), source.map(visibleWidth));
	assert.equal(visibleWidth(empty[0] ?? ""), 0);
	assert.ok(first.every((line, index) => line.endsWith(source[index] ?? "")));
	assert.ok(second.every((line, index) => line.endsWith(source[index] ?? "")));
});

test("decorated rows are re-emitted by Pi's fullscreen differential renderer", () => {
	const terminal = new FakeTerminal();
	const tui = new TuiAltScreen(terminal);
	const scheduler = new FullRedrawScheduler({ rowRefreshIntervalMs: 60_000, idleIntervalMs: 60_000 });
	scheduler.attach(tui);
	tui.setLayoutRoot({
		render: () => scheduler.decorate(["footer"]),
		invalidate(): void {},
	});

	try {
		tui.start();
		tui.renderNow(true);
		terminal.writes.length = 0;

		tui.renderNow();
		const unchangedFrame = terminal.writes.join("");
		terminal.writes.length = 0;
		scheduler.requestRowRefresh();
		tui.renderNow();
		const repairedFrame = terminal.writes.join("");

		assert.doesNotMatch(unchangedFrame, /\x1b\[1;1H\x1b\[2K/);
		assert.match(repairedFrame, /\x1b\[1;1H\x1b\[2K/);
	} finally {
		scheduler.detach();
		tui.stop({ preserveScreen: true });
	}
});

test("decorate is inert outside fullscreen mode", () => {
	const h = harness();
	const target = fakeTarget("regular");
	const source = ["status"];
	h.scheduler.attach(target);

	assert.equal(h.scheduler.decorate(source), source);
});

test("row refresh advances the marker and requests a normal render", () => {
	const h = harness();
	const target = fakeTarget("fullscreen");
	h.scheduler.attach(target);
	const before = h.scheduler.decorate(["status"]);

	assert.equal(h.scheduler.requestRowRefresh(), true);
	const after = h.scheduler.decorate(["status"]);
	assert.notDeepEqual(before, after);
	assert.equal(target.unforced, 1);
	assert.equal(target.forced, 0);
});

test("ordinary renders keep footer bytes stable between repair ticks", () => {
	const h = harness();
	const target = fakeTarget("fullscreen");
	h.scheduler.attach(target);

	const first = h.scheduler.decorate(["status"]);
	h.advance(10_000);
	const second = h.scheduler.decorate(["status"]);
	assert.deepEqual(first, second);
	assert.equal(target.unforced, 0);
});

test("row refresh is a no-op in regular mode", () => {
	const h = harness();
	const target = fakeTarget("regular");
	h.scheduler.attach(target);

	assert.equal(h.scheduler.requestRowRefresh(), false);
	assert.equal(target.unforced, 0);
});

test("idle sweeps request targeted and full redraws without agent activity", () => {
	const rowInterval = 1_000;
	const fullInterval = 30_000;
	const h = harness({ minGapMs: 0, rowRefreshIntervalMs: rowInterval, idleIntervalMs: fullInterval });
	const target = fakeTarget("fullscreen");
	h.scheduler.attach(target);

	h.tick(rowInterval);
	h.tick(fullInterval);
	assert.equal(target.unforced, 1);
	assert.equal(target.forced, 1);
});

test("requests are no-ops before attach and after detach", () => {
	const h = harness({ minGapMs: 0 });
	const target = fakeTarget("fullscreen");

	assert.equal(h.scheduler.request(), false);
	assert.equal(h.scheduler.requestRowRefresh(), false);
	h.scheduler.attach(target);
	assert.equal(h.scheduler.request(), true);
	assert.equal(h.scheduler.requestRowRefresh(), true);
	h.scheduler.detach();
	assert.equal(h.scheduler.request(), false);
	assert.equal(h.scheduler.requestRowRefresh(), false);
	assert.equal(target.forced, 1);
	assert.equal(target.unforced, 1);
});

test("attach replaces both previous repair sweeps", () => {
	const h = harness();
	h.scheduler.attach(fakeTarget("fullscreen"));
	h.scheduler.attach(fakeTarget("fullscreen"));

	assert.equal(h.scheduled, 4);
	assert.equal(h.cancelled, 2);
});

test("detach is idempotent", () => {
	const h = harness();
	h.scheduler.attach(fakeTarget("fullscreen"));
	h.scheduler.detach();
	h.scheduler.detach();

	assert.equal(h.cancelled, 2);
});

test("attach schedules the targeted and full redraw cadences", () => {
	const h = harness({ rowRefreshIntervalMs: 750, idleIntervalMs: 25_000 });
	h.scheduler.attach(fakeTarget("fullscreen"));

	assert.deepEqual(h.intervals, [750, 25_000]);
});

test("defaults keep targeted repair prompt and forced redraws rare", () => {
	assert.ok(DEFAULT_ROW_REFRESH_INTERVAL_MS >= 250);
	assert.ok(DEFAULT_MIN_GAP_MS >= 1_000);
	assert.ok(DEFAULT_IDLE_INTERVAL_MS >= DEFAULT_MIN_GAP_MS);
	assert.ok(DEFAULT_IDLE_INTERVAL_MS > DEFAULT_ROW_REFRESH_INTERVAL_MS);
});
