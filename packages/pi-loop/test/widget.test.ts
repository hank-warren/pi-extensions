import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { formatClock } from "../src/interval.js";
import type { LoopState } from "../src/state.js";
import {
	clearLoopWidget,
	LOOP_WIDGET_KEY,
	type LoopRunningView,
	loopWidgetLine,
	updateLoopWidget,
	widgetTone,
} from "../src/widget.js";

const START = 1_000_000_000_000;

const LOOP: LoopState = {
	id: "loop1234",
	status: "active",
	prompt: "check the release queue",
	intervalMs: 300_000,
	maxTurns: 25,
	compactAt: 0.7,
	iteration: 3,
	automaticTurns: 5,
	startedAt: START,
	expiresAt: START + 604_800_000,
};

function view(overrides: Partial<LoopRunningView> = {}): LoopRunningView {
	return {
		kind: "loop",
		loop: LOOP,
		wakePending: false,
		nextWakeAt: undefined,
		now: START + 7_920_000, // 2h12m in
		...overrides,
	};
}

test("the running line leads with criteria progress, not consumption", () => {
	// Turns against the cap are budget burn; criteria met are progress. The
	// interval used to lead and says the least: it is a fallback heartbeat.
	assert.equal(
		loopWidgetLine(view({ criteria: { met: 2, total: 5 } })),
		"⟳ loop 2/5 done · turn 5/25 · 2h12m · next unscheduled",
	);
	// No ledger, no progress number — the line degrades instead of inventing one.
	assert.equal(loopWidgetLine(view()), "⟳ loop turn 5/25 · 2h12m · next unscheduled");
	assert.match(loopWidgetLine(view({ wakePending: true })), /next on idle$/);
	assert.match(
		loopWidgetLine(view({ nextWakeAt: START, loop: { ...LOOP, maxTurns: null } })),
		/turn 5\/∞ · 2h12m · next \d\d:\d\d$/,
	);
});

test("states are ordered by how much they want a human", () => {
	// A waiting loop used to render as an ordinary scheduled one here while the
	// footer said it was waiting: same state, two surfaces, different stories.
	assert.equal(
		loopWidgetLine(
			view({
				loop: { ...LOOP, waiting: { reason: "CI run on PR 171", resumeAt: START + 600_000 } },
			}),
		),
		// formatClock renders local time, so the expected value has to be derived
		// rather than written down: a hardcoded HH:MM only passes in one timezone.
		`⏳ loop waiting · CI run on PR 171 · until ${formatClock(START + 600_000)}`,
	);
	assert.equal(
		loopWidgetLine(view({ loop: { ...LOOP, waiting: { reason: "a human reply" } } })),
		"⏳ loop waiting · a human reply · no deadline",
	);

	// The pause cause was in state and in /loop status, but dropped here.
	assert.equal(
		loopWidgetLine(view({ loop: { ...LOOP, status: "paused", pauseCause: "no progress" } })),
		"⏸ loop paused · no progress",
	);
	assert.equal(loopWidgetLine(view({ loop: { ...LOOP, status: "paused" } })), "⏸ loop paused");

	// Blocked outranks the ordinary line: a session stuck on a prompt is dead
	// until expiry, and showing it a next-wake time is the misleading answer.
	assert.equal(
		loopWidgetLine(view({ blockedForMs: 2_520_000, criteria: { met: 2, total: 5 } })),
		"⚠ loop blocked · no turn for 42m · a prompt may be waiting",
	);
	assert.equal(
		loopWidgetLine(view({ loop: { ...LOOP, expiring: true } })),
		"⚠ loop expiring · write your state into the ledger",
	);
	// Paused beats blocked beats waiting: most-wants-a-human first.
	assert.match(
		loopWidgetLine(
			view({
				loop: { ...LOOP, status: "paused", pauseCause: "no progress" },
				blockedForMs: 2_520_000,
			}),
		),
		/^⏸ loop paused/,
	);
});

test("planning has its own line and tone", () => {
	assert.equal(loopWidgetLine({ kind: "planning" }), "◆ loop · drafting objective");
	assert.equal(
		loopWidgetLine({ kind: "planning", proposedCriteria: 3 }),
		"◆ loop · 3 criteria proposed · approve to start",
	);
	// One criterion is a criterion. The line is read at a glance, and a plural
	// there reads as a bug in the thing reporting it.
	assert.equal(
		loopWidgetLine({ kind: "planning", proposedCriteria: 1 }),
		"◆ loop · 1 criterion proposed · approve to start",
	);
	assert.equal(widgetTone({ kind: "planning" }), "planning");
	assert.equal(widgetTone(view()), "normal");
	assert.equal(widgetTone(view({ blockedForMs: 2_520_000 })), "attention");
	assert.equal(widgetTone(view({ loop: { ...LOOP, status: "paused" } })), "attention");
	assert.equal(widgetTone(view({ loop: { ...LOOP, expiring: true } })), "attention");
});

test("updateLoopWidget renders a themed Text component and clears on stop", () => {
	const widgets = new Map<string, unknown>();
	const ui = { setWidget: (key: string, content: unknown) => widgets.set(key, content) };

	updateLoopWidget(ui, view({ criteria: { met: 2, total: 5 } }));
	const factory = widgets.get(LOOP_WIDGET_KEY) as (tui: unknown, theme: unknown) => unknown;
	assert.equal(typeof factory, "function");
	const themed: string[] = [];
	const component = factory(undefined, {
		bold: (text: string) => {
			themed.push(`bold:${text}`);
			return text;
		},
		fg: (color: string, text: string) => {
			themed.push(`${color}:${text}`);
			return text;
		},
	});
	assert.ok(component instanceof Text);
	assert.ok(themed.some((entry) => entry.startsWith("bold:⟳ loop 2/5 done")));
	assert.ok(themed.some((entry) => entry === "dim:  focus: check the release queue"));
	// A theme without helpers still renders.
	assert.ok(factory(undefined, {}) instanceof Text);

	// An attention state asks for the warning colour.
	updateLoopWidget(ui, view({ blockedForMs: 2_520_000 }));
	const blocked: string[] = [];
	(widgets.get(LOOP_WIDGET_KEY) as (tui: unknown, theme: unknown) => unknown)(undefined, {
		fg: (color: string, text: string) => {
			blocked.push(`${color}:${text}`);
			return text;
		},
	});
	assert.ok(blocked.some((entry) => entry.startsWith("warning:⚠ loop blocked")));

	updateLoopWidget(ui, view({ loop: { ...LOOP, status: "stopped" } }));
	assert.equal(widgets.get(LOOP_WIDGET_KEY), undefined);

	updateLoopWidget(ui, view());
	clearLoopWidget(ui);
	assert.equal(widgets.get(LOOP_WIDGET_KEY), undefined);

	// Hosts without setWidget (test fixtures, print mode) are a no-op.
	updateLoopWidget({}, view());
	clearLoopWidget({});
});
