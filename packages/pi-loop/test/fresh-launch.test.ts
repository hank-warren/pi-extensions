/**
 * The build/install split, and the fresh-session launch it exists for.
 *
 * `startLoop` used to be one indivisible pass: construct the state and make
 * this session the one running it. These tests pin the halves apart, because
 * the whole point of the split is that building must be safe in a session
 * that is about to hand the loop away.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startLoopInFreshSession } from "../src/fresh-launch.js";
import { LoopController } from "../src/loop.js";
import { ledgerPaths } from "../src/ledger.js";
import { LOOP_STATE_ENTRY_TYPE } from "../src/state.js";
import { createLoopHarness } from "./support/mock-pi.js";

const START = {
	kind: "start" as const,
	requestedMs: 600_000,
	intervalMs: 600_000,
	clamped: false,
	maxTurns: 25,
	expiresInMs: 604_800_000,
	prompt: "- do the work, verified by npm test\n- and prove it, verified by the output",
};

test("buildLoop constructs a loop without installing it in the calling session", () => {
	const harness = createLoopHarness();
	try {
		const entriesBefore = harness.branch.length;
		const result = harness.controller.buildLoop(START);
		assert.ok(result.ok, "build succeeded");
		assert.equal(result.built.loop.status, "active");
		assert.equal(result.built.loop.objective, START.prompt);
		assert.deepEqual(
			result.built.criteria.map((criterion) => criterion.id),
			["c1", "c2"],
		);

		// Nothing about the calling session changed: no live loop, no persisted
		// state, no ledger on disk, no kickoff, no widget chatter.
		assert.equal(harness.controller.state, undefined, "no loop was installed");
		assert.equal(harness.branch.length, entriesBefore, "nothing was persisted");
		assert.equal(harness.sentMessages.length, 0, "no anchor was sent");
		assert.equal(harness.sentUserMessages.length, 0, "no kickoff was dispatched");
		assert.deepEqual(harness.notifications, [], "no start notice was shown");
		assert.equal(
			existsSync(ledgerPaths(result.built.loop.id, harness.agentDir).dir),
			false,
			"no ledger was created",
		);
	} finally {
		harness.cleanup();
	}
});

test("installLoop is the half that makes a session run the loop", () => {
	const harness = createLoopHarness();
	try {
		const built = harness.controller.buildLoop(START);
		assert.ok(built.ok);
		const result = harness.controller.installLoop(harness.ctx, built.built);
		assert.ok(result.ok);
		assert.equal(harness.controller.state?.id, built.built.loop.id);
		assert.ok(
			harness.branch.some(
				(entry) => (entry as { customType?: string }).customType === LOOP_STATE_ENTRY_TYPE,
			),
			"the loop was persisted",
		);
		assert.ok(harness.sentMessages.length > 0, "the objective was anchored");
	} finally {
		harness.cleanup();
	}
});

test("the fresh launch calls newSession and installs the built state there", async () => {
	const harness = createLoopHarness();
	try {
		const built = harness.controller.buildLoop(START);
		assert.ok(built.ok);

		let freshController: LoopController | undefined;
		const appended: Array<{ customType: string; data: unknown }> = [];
		let setupRan = false;
		let withSessionRan = false;

		const ctx = {
			...(harness.ctx as unknown as Record<string, unknown>),
			mode: "tui",
			ui: harness.ctx.ui,
			waitForIdle: async () => {},
			sessionManager: {
				getBranch: () => [...harness.branch],
				getSessionFile: () => "/tmp/parent-session.jsonl",
			},
			// The double runs the real sequence: setup appends to the new session's
			// branch, the new session starts (which is where pi-loop's ordinary
			// restore path runs), then withSession gets the replacement context.
			newSession: async (options: {
				setup?: (sessionManager: unknown) => Promise<void>;
				withSession?: (replacement: unknown) => Promise<void>;
			}) => {
				setupRan = true;
				await options.setup?.({
					appendCustomEntry: (customType: string, data: unknown) => {
						appended.push({ customType, data });
						harness.branch.push({ type: "custom", customType, data });
					},
				});
				// The new session boots with its *own* controller — Pi builds a fresh
				// extension instance per session — and restores whatever setup left
				// behind. Using a second controller here is the point: a canary caught
				// the launching session trying to kick the loop off through its own
				// instance, which no longer held the loop, so the loop crossed
				// correctly and then sat idle until its first fallback wake.
				freshController = new LoopController(harness.pi, {
					settingsPath: join(harness.agentDir, "pi-loop.json"),
					agentDir: harness.agentDir,
				});
				freshController.onSessionStart(harness.ctx);
				withSessionRan = true;
				await options.withSession?.(harness.ctx);
				return { cancelled: false };
			},
		} as unknown as ExtensionContext;

		const result = await startLoopInFreshSession(ctx, {
			built: built.built,
			prepareLedger: () => harness.controller.prepareLedgerFor(built.built),
		});

		assert.deepEqual(result, { kind: "started" });
		assert.ok(setupRan, "newSession was called with a setup step");
		assert.ok(withSessionRan, "newSession ran its withSession step");

		// The state crossed as the same entry `persist` writes, so the new
		// session needs no special case to pick it up — plus the handoff flag,
		// which is what carries the kickoff across the instance boundary.
		assert.deepEqual(
			appended.map((entry) => entry.customType),
			[LOOP_STATE_ENTRY_TYPE],
		);
		assert.deepEqual(appended[0]?.data, { loop: { ...built.built.loop, handoff: true } });

		// And it is genuinely installed over there: restored by the new session's
		// own controller, working, with the handoff consumed exactly once.
		assert.equal(freshController?.state?.id, built.built.loop.id);
		assert.equal(freshController?.state?.status, "active");
		assert.equal(freshController?.state?.handoff, undefined, "the handoff is consumed");
		assert.ok(
			harness.sentMessages.some(
				(message) =>
					(message.details as { loopId?: string } | undefined)?.loopId === built.built.loop.id,
			),
			"the new session anchored the objective",
		);
		assert.ok(
			harness.sentUserMessages.some((text) => text.startsWith("Loop started.")),
			"the new session dispatched the first turn instead of idling until a fallback wake",
		);

		// The approved criteria were on disk before the new session restored, so
		// it is held to the gate the user saw rather than a re-derived one.
		const paths = ledgerPaths(built.built.loop.id, harness.agentDir);
		assert.deepEqual(
			JSON.parse(readFileSync(paths.criteria, "utf8")).map(
				(criterion: { id: string }) => criterion.id,
			),
			["c1", "c2"],
		);
	} finally {
		harness.cleanup();
	}
});

test("a context with no newSession is refused rather than silently starting here", async () => {
	const harness = createLoopHarness();
	try {
		const built = harness.controller.buildLoop(START);
		assert.ok(built.ok);
		const result = await startLoopInFreshSession(harness.ctx, {
			built: built.built,
			prepareLedger: () => undefined,
		});
		assert.equal(result.kind, "rejected");
		assert.equal(harness.controller.state, undefined, "nothing was installed here");
	} finally {
		harness.cleanup();
	}
});
