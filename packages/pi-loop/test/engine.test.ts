import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LoopController, STALL_ATTENTION_MS } from "../src/loop.js";
import { loopWidgetLine } from "../src/widget.js";
import { extractContinuationMarker, extractPokeMarker } from "../src/markers.js";
import { LOOP_STATE_ENTRY_TYPE, type LoopState, PLAN_MODE_STATE_ENTRY_TYPE } from "../src/state.js";

const TICK_MS = 25;

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until `predicate` holds, polling rather than sleeping a fixed span.
 *
 * The engine's timers fire on `TICK_MS` boundaries, so `await wait(TICK_MS * 3)`
 * followed by "the timer did this" is a bet that the host schedules them
 * promptly. Under the suite's process-per-file concurrency that bet lost about
 * one run in five. Polling asserts the same thing without the deadline, and it
 * asserts something stronger than a sleep that may have covered no tick at all:
 * the assertions after it run at a point where the awaited effect has landed.
 *
 * A case whose claim *is* the elapsed span — "no poke while busy", "a paused
 * loop never ticks", "the replaced loop's timer is inert" — keeps its fixed
 * wait, because there the waiting is the test.
 */
async function waitFor(
	predicate: () => boolean,
	description: string,
	{ timeoutMs = 2_000, stepMs = 5 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(`timed out after ${timeoutMs}ms waiting for: ${description}`);
		}
		await wait(stepMs);
	}
}

interface HarnessOptions {
	branch?: unknown[];
	idle?: boolean;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
	/** Make ctx.compact throw synchronously, as a torn-down runner does. */
	compactError?: Error;
	/** How many sendUserMessage calls Pi refuses before accepting again. */
	sendFailures?: number;
	/** The session's active tool set, as pi.getActiveTools() reports it. */
	activeTools?: string[];
	/** A controllable clock, for spans no test can wait out in real time. */
	now?: () => number;
	/** Grace for the final expiry turn to start; shortened so tests can wait it out. */
	expiryTurnGraceMs?: number;
}

function createHarness(options: HarnessOptions = {}) {
	const sentUserMessages: Array<{ text: string; options?: unknown }> = [];
	const sentMessages: Array<{ message: Record<string, unknown>; options?: unknown }> = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses: Array<string | undefined> = [];
	const compactCalls: Array<{
		customInstructions?: string;
		onComplete?: (result: unknown) => void;
		onError?: (error: Error) => void;
	}> = [];
	const branch: unknown[] = options.branch ?? [];
	const flags = {
		idle: options.idle ?? true,
		pendingMessages: false,
		compacting: false,
		sendFailures: options.sendFailures ?? 0,
		activeTools: options.activeTools ?? ["loop_complete", "loop_wait", "bash"],
	};
	const usage = { value: options.contextUsage };

	const pi = {
		// Refuses like the real Pi: a prompt submitted while the agent streams
		// without deliverAs, or any prompt submitted during a compaction, is
		// rejected rather than silently recorded.
		sendUserMessage: (text: string, messageOptions?: { deliverAs?: string }) => {
			if (flags.compacting) {
				throw new Error("Cannot submit a prompt while compaction is in progress.");
			}
			if (!flags.idle && messageOptions?.deliverAs === undefined) {
				throw new Error("Agent is already processing a prompt");
			}
			if (flags.sendFailures > 0) {
				flags.sendFailures -= 1;
				throw new Error("delivery refused");
			}
			sentUserMessages.push({ text, ...(messageOptions === undefined ? {} : { options: messageOptions }) });
		},
		sendMessage: (message: Record<string, unknown>, messageOptions?: unknown) => {
			sentMessages.push({
				message,
				...(messageOptions === undefined ? {} : { options: messageOptions }),
			});
		},
		getActiveTools: () => flags.activeTools,
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ customType, data });
			branch.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		mode: "tui",
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
		},
		sessionManager: { getBranch: () => [...branch] },
		isIdle: () => flags.idle,
		hasPendingMessages: () => flags.pendingMessages,
		getContextUsage: () => usage.value,
		compact: (compactOptions: (typeof compactCalls)[number]) => {
			if (options.compactError) throw options.compactError;
			flags.compacting = true;
			compactCalls.push(compactOptions);
		},
	};

	const settingsDir = mkdtempSync(join(tmpdir(), "pi-loop-engine-"));
	const controller = new LoopController(pi, {
		settingsPath: join(settingsDir, "pi-loop.json"),
		// Never write a ledger into the real agent dir from a test.
		agentDir: settingsDir,
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.expiryTurnGraceMs === undefined ? {} : { expiryTurnGraceMs: options.expiryTurnGraceMs }),
	});

	return {
		controller,
		rawPi: pi as unknown as Record<string, unknown>,
		ctx: ctx as never,
		rawCtx: ctx,
		flags,
		usage,
		branch,
		sentUserMessages,
		sentMessages,
		settingsDir,
		entries,
		notifications,
		compactCalls,
		/** Pi finishes the compaction and only then accepts prompts again. */
		completeCompaction: (result: unknown = {}, index = 0) => {
			flags.compacting = false;
			compactCalls[index]?.onComplete?.(result);
		},
		failCompaction: (error: Error, index = 0) => {
			flags.compacting = false;
			compactCalls[index]?.onError?.(error);
		},
		cleanup: () => {
			controller.onSessionShutdown();
			rmSync(settingsDir, { recursive: true, force: true });
		},
	};
}

function assistantToolCall(name = "bash") {
	return { role: "assistant", content: [{ type: "toolCall", name }] };
}

function assistantText(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function startArgs(patch: Record<string, unknown> = {}) {
	return {
		kind: "start" as const,
		requestedMs: TICK_MS,
		intervalMs: TICK_MS,
		clamped: false,
		prompt: "check the queue",
		...patch,
	};
}

test("start -> tick -> poke: message carries the marker and state persists", async (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	assert.equal(h.entries.at(-1)?.customType, LOOP_STATE_ENTRY_TYPE);
	assert.equal(h.sentUserMessages.length, 1, "only the immediate kickoff so far");
	assert.equal(extractPokeMarker(h.sentUserMessages[0]?.text ?? ""), undefined);

	await waitFor(
		() => h.sentUserMessages.some((message) => extractPokeMarker(message.text)),
		"the fallback poke to be delivered",
	);
	const poke = h.sentUserMessages.find((message) => extractPokeMarker(message.text));
	assert.ok(poke, "fallback poke delivered");
	const marker = extractPokeMarker(poke.text);
	assert.ok(marker, "poke has a provenance marker");
	assert.equal(marker.iteration, 1);
	assert.match(poke.text, /completion criteria are not met/);
	// Slim by contract: the objective reaches the model through the system
	// append, never through the tail message.
	assert.doesNotMatch(poke.text, /check the queue/);
	assert.ok((h.controller.state?.iteration ?? 0) >= 1);
});

test("starting with no objective is refused", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	const result = h.controller.startLoop(h.ctx, startArgs({ prompt: undefined }));
	assert.equal(h.controller.state, undefined, "no loop created");
	// The refusal is returned, not notified: the /loop command renders it as a
	// toast and the fresh-session launch renders the same text where it can.
	assert.equal(result.ok, false);
	assert.ok(!result.ok && result.message.includes("needs something to work on"));
	assert.deepEqual(h.notifications, []);
});

test("the trailing text becomes the loop's objective", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	const loop = h.controller.state;
	assert.equal(loop?.objective, "check the queue");
	assert.equal(loop?.prompt, undefined, "and never also a per-wake focus");
	assert.ok(h.notifications.some((n) => n.message.includes("working its objective")));
});

test("a standalone loop kicks off immediately and stops on loop_complete", async (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());

	const first = h.sentUserMessages[0];
	assert.ok(first, "the first working turn fires at start, not one interval later");
	assert.match(first.text, /Loop started\. Begin working the loop objective/);
	assert.ok(extractContinuationMarker(first.text), "kickoff carries a continuation marker");
	// Slim for the same reason the pokes are: the objective reaches the model
	// through this loop's own byte-stable system append.
	assert.doesNotMatch(first.text, /check the queue/);
	assert.equal(h.controller.state?.automaticTurns, 1);
	assert.equal(h.controller.state?.iteration, 0, "a continuation is not a wake");

	h.controller.completeLoop("queue drained");
	assert.equal(h.controller.state?.status, "stopped");
	assert.ok(h.notifications.some((n) => n.message.includes("completion criteria met")));
});

test("the settled boundary continues a standalone loop without any timer", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	// An interval far beyond the test's lifetime: only the settle can pace this.
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	assert.equal(h.sentUserMessages.length, 1, "kickoff");

	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.sentUserMessages.length, 2, "the settle dispatched a continuation");
	const continuation = h.sentUserMessages[1];
	assert.ok(continuation);
	assert.match(continuation.text, /Automatic loop continuation #2/);
	assert.equal(h.controller.state?.automaticTurns, 2);
	assert.equal(h.controller.state?.iteration, 0, "no wake was ever delivered");
});

test("a settle with no recorded intent never continues on its own", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	h.controller.onAgentSettled(h.ctx);
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.sentUserMessages.length, 1, "only the kickoff; settling is not a schedule");
});

test("a continuation Pi refuses is retried at the next settle", (t) => {
	const h = createHarness({ sendFailures: 1 });
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	assert.equal(h.sentUserMessages.length, 0, "the kickoff was refused");
	assert.ok(h.notifications.some((n) => n.message.includes("could not continue the loop")));
	assert.equal(h.controller.state?.automaticTurns, 0, "a refused send never counts a turn");

	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.sentUserMessages.length, 1, "the retained intent delivered at the next settle");
	assert.equal(h.controller.state?.automaticTurns, 1);
});

test("the turn cap stops a settle-paced loop no wake counter would ever bound", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	h.controller.state = { ...(h.controller.state as LoopState), maxTurns: 2 };

	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.sentUserMessages.length, 2);
	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.sentUserMessages.length, 2, "the cap stops the chain");
	assert.equal(h.controller.state?.status, "stopped");
	assert.equal(h.controller.state?.iteration, 0, "and not one wake was delivered");
	assert.ok(h.notifications.some((n) => n.message.includes("2-turn cap")));
});

test("consecutive no-op fallback wakes back the heartbeat off, and work resets it", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	const loop = h.controller.state;
	assert.ok(loop);
	assert.equal(h.controller.fallbackDelayMs(loop), TICK_MS, "no backoff at rest");

	// Drive the wake explicitly rather than sleeping past an unknown number of
	// timer fires. Sleeping three intervals raced the dead-delivery breaker:
	// three loop messages with no agent_start between them is exactly the
	// "something is refusing every request" signal, and the pause it triggers
	// clears runOrigin — so the backoff this test is about never ran, and the
	// failure looked like a backoff bug rather than a test that outran the
	// engine. Each delivery here is followed by the run it caused, which is
	// what a live session does.
	h.controller.onAgentStart(h.ctx); // the kickoff continuation produced a run
	h.controller.runTick(h.ctx); // exactly one fallback wake
	assert.ok(
		h.sentUserMessages.some((message) => extractPokeMarker(message.text)),
		"the fallback delivered a poke",
	);
	h.controller.onAgentStart(h.ctx); // ...which produced a run
	// That run was tool-free: nothing happened.
	h.controller.onAgentEnd(h.ctx, [assistantText("nothing to do")]);
	assert.equal(h.controller.noOpStreak, 1);
	assert.equal(h.controller.fallbackDelayMs(h.controller.state as LoopState), TICK_MS * 2);

	h.controller.noOpStreak = 9;
	assert.equal(
		h.controller.fallbackDelayMs(h.controller.state as LoopState),
		TICK_MS * 4,
		"capped at 4x the base interval",
	);

	// A turn that used a tool is progress, whatever caused it.
	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	assert.equal(h.controller.noOpStreak, 0);
});

test("a user-driven no-op turn never counts toward the backoff", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	// Retire the kickoff run so no loop-caused run is in flight.
	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	h.controller.noOpStreak = 2;
	// This agent_end belongs to the user: the loop is not the thing spinning.
	h.controller.onAgentEnd(h.ctx, [assistantText("hello")]);
	assert.equal(h.controller.noOpStreak, 0);
});

test("busy at tick coalesces into one wake delivered at agent_settled", async (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	assert.equal(h.sentUserMessages.length, 1, "the kickoff went out while idle");

	// Now busy: every tick that lands coalesces into one pending wake.
	h.flags.idle = false;
	await waitFor(() => h.controller.lastDecision?.reason === "agent-busy", "a tick to land while busy");
	assert.equal(h.sentUserMessages.length, 1, "no poke while busy");

	h.flags.idle = true;
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.sentUserMessages.length, 2, "exactly one coalesced poke at settle");
	assert.ok(extractPokeMarker(h.sentUserMessages[1]?.text ?? ""), "and it is a poke");
});

test("plan mode skips without consuming an iteration and recovers after exit", async (t) => {
	const planEntry = { type: "custom", customType: PLAN_MODE_STATE_ENTRY_TYPE, data: { enabled: true } };
	const h = createHarness({ branch: [planEntry] });
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	await waitFor(
		() => h.controller.lastDecision?.reason === "plan-mode-active",
		"a tick to land while Plan mode owns the session",
	);
	assert.equal(h.sentUserMessages.length, 0, "not even the kickoff enters a planning turn");
	assert.equal(h.controller.state?.iteration, 0);

	h.branch.push({ type: "custom", customType: PLAN_MODE_STATE_ENTRY_TYPE, data: { enabled: false } });
	await waitFor(() => h.sentUserMessages.length >= 1, "the loop to resume after plan mode exits");
});

test("the --max turn cap stops the loop with a notice", async (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	// One turn: the kickoff continuation spends it, so the first fallback wake
	// finds the cap reached and stops instead of poking.
	h.controller.startLoop(h.ctx, startArgs({ maxTurns: 1 }));
	await waitFor(() => h.controller.state?.status === "stopped", "the cap to stop the loop");
	const pokes = h.sentUserMessages.filter((message) => extractPokeMarker(message.text));
	assert.equal(pokes.length, 0, "the cap was already spent by the kickoff turn");
	assert.ok(h.notifications.some((n) => n.message.includes("1-turn cap")));
});

test("threshold compaction fires with loop instructions and holds the pending wake", async (t) => {
	const h = createHarness({
		contextUsage: { tokens: 80_000, contextWindow: 100_000, percent: 80 },
	});
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	h.sentUserMessages.length = 0; // drop the kickoff; this test is about wakes
	// Compaction outranks wake delivery at the settled boundary.
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.compactCalls.length, 1, "proactive compaction triggered");
	const call = h.compactCalls[0];
	assert.ok(call);
	assert.match(call.customInstructions ?? "", /check the queue/);
	assert.match(call.customInstructions ?? "", /re-derive the current status/i);

	// A tick during compaction coalesces instead of poking.
	await waitFor(
		() => h.controller.lastDecision?.reason === "compaction-in-flight",
		"a tick to land during the compaction",
	);
	assert.equal(h.sentUserMessages.length, 0, "poke held during compaction");

	// Completion releases the held wake: with usage back under the threshold,
	// the nudged settle delivers exactly the one coalesced poke.
	assert.equal(h.controller.compacting, true);
	h.usage.value = { tokens: 10_000, contextWindow: 100_000, percent: 10 };
	h.completeCompaction();
	assert.equal(h.controller.compacting, false);
	assert.equal(h.sentUserMessages.length, 1, "held poke delivered after compaction");
});

test("a failed compaction clears the flag and releases the held wake", async (t) => {
	const h = createHarness({
		contextUsage: { tokens: 80_000, contextWindow: 100_000, percent: 80 },
	});
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	h.sentUserMessages.length = 0; // drop the kickoff; this test is about wakes
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.compactCalls.length, 1);

	await waitFor(
		() => h.controller.lastDecision?.reason === "compaction-in-flight",
		"the wake to be held by the in-flight compaction",
	);

	// The compaction fails: without the onError nudge the loop would sit with
	// no timer and no delivery path until an unrelated settle.
	h.usage.value = { tokens: 10_000, contextWindow: 100_000, percent: 10 };
	h.failCompaction(new Error("summarizer exploded"));
	assert.equal(h.controller.compacting, false);
	assert.ok(h.notifications.some((n) => n.message.includes("compaction failed")));
	assert.equal(h.sentUserMessages.length, 1, "held poke delivered after the failure");
});

test("a compaction that throws synchronously does not wedge the loop", async (t) => {
	const h = createHarness({
		contextUsage: { tokens: 80_000, contextWindow: 100_000, percent: 80 },
		compactError: new Error("extension runner is not active"),
	});
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.controller.compacting, false, "compacting reset on a synchronous throw");
	assert.ok(h.notifications.some((n) => n.message.includes("compaction could not start")));

	await waitFor(
		() => h.sentUserMessages.length >= 1,
		"ticks to keep poking instead of skipping forever",
	);
});

test("restore re-arms an active loop and drops an expired one", async (t) => {
	const now = Date.now();
	const activeState = {
		id: "restored1",
		status: "active",
		objective: "keep going",
		intervalMs: TICK_MS,
		maxIterations: 25,
		compactAt: null,
		iteration: 2,
		startedAt: now - 1000,
		expiresAt: now + 60_000,
	};
	const h = createHarness({
		branch: [{ type: "custom", customType: LOOP_STATE_ENTRY_TYPE, data: { loop: activeState } }],
	});
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	assert.equal(h.controller.state?.id, "restored1");
	await waitFor(() => h.sentUserMessages.length >= 1, "the restored loop to tick again");

	const expired = createHarness({
		branch: [
			{
				type: "custom",
				customType: LOOP_STATE_ENTRY_TYPE,
				data: { loop: { ...activeState, id: "expired1", expiresAt: now - 1 } },
			},
		],
	});
	t.after(expired.cleanup);
	expired.controller.onSessionStart(expired.ctx);
	assert.equal(expired.controller.state?.status, "stopped");
	assert.ok(expired.notifications.some((n) => n.message.includes("expired")));
});

test("replacing a loop drops the pending wake of the loop it replaced", async (t) => {
	const h = createHarness({ idle: false });
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	await waitFor(
		() => h.controller.lastDecision?.reason === "agent-busy",
		"a tick to land while busy, leaving a pending wake",
	);

	// Replace the loop while the wake is pending.
	h.controller.startLoop(h.ctx, startArgs({ prompt: "the new loop" }));
	const replacement = h.controller.state?.id;
	assert.ok(replacement);
	h.flags.idle = true;
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.sentUserMessages.length, 1, "only the replacement's own kickoff goes out");
	assert.deepEqual(
		extractContinuationMarker(h.sentUserMessages[0]?.text ?? ""),
		{ loopId: replacement, turn: 1 },
		"the stale wake was dropped with the loop it belonged to",
	);
});

test("pause and resume control the timer; stop clears the widget", async (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	h.controller.pauseLoop(h.ctx);
	h.sentUserMessages.length = 0; // drop the kickoff
	await wait(TICK_MS * 3);
	assert.equal(h.sentUserMessages.length, 0, "paused loop never ticks");

	h.controller.resumeLoop(h.ctx);
	await waitFor(() => h.sentUserMessages.length >= 1, "the resumed loop to work again");

	h.controller.stopLoop(h.ctx);
	assert.equal(h.controller.state?.status, "stopped");
});

test("a settle with no pending wake and no intent never pokes off-schedule", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	h.sentUserMessages.length = 0; // the kickoff already went out
	h.controller.onAgentSettled(h.ctx);
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.sentUserMessages.length, 0);
	assert.equal(h.controller.state?.iteration, 0);
	assert.equal(h.controller.state?.status, "active");
});

test("session_shutdown stops a scheduled tick from firing", async (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	h.controller.onSessionShutdown();
	h.sentUserMessages.length = 0; // the kickoff already went out
	await wait(TICK_MS * 4);
	assert.equal(h.sentUserMessages.length, 0, "the timer was cleared");
	assert.equal(h.controller.state?.iteration, 0);
});

test("a refused poke re-arms without burning an iteration", async (t) => {
	// Two refusals: the kickoff continuation, then the first poke.
	const h = createHarness({ sendFailures: 2 });
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	await waitFor(
		() => h.sentUserMessages.some((message) => extractPokeMarker(message.text)),
		"the retried poke to be delivered after the refusals",
	);
	assert.ok(
		h.notifications.some((n) => n.message.includes("could not deliver a wake")),
		"the refusal is reported, not swallowed",
	);
	const pokes = h.sentUserMessages.filter((message) => extractPokeMarker(message.text));
	assert.ok(pokes.length >= 1, "the loop retried at the next interval");
	// The cap counts delivered pokes only.
	assert.equal(h.controller.state?.iteration, pokes.length);
});

/**
 * `nextWakeAt` means "a wake is scheduled at this clock time". The timer
 * callback cleared `this.timer` but not `nextWakeAt`, so after a fire that does
 * not reschedule — a busy or compacting session coalesces into `wakePending`
 * instead — the field kept naming a time that had already passed. The widget
 * hides that because it gives `wakePending` precedence, but `/loop status`
 * printed both lines and they contradict each other.
 */
test("a fire that coalesces into a pending wake leaves no stale Next wake line", async (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());

	const scheduled = h.controller.statusLines(h.ctx);
	assert.ok(
		scheduled.some((line) => line.startsWith("Next fallback wake:")),
		"a genuinely scheduled wake is still reported",
	);

	h.flags.idle = false; // busy: decideTick -> skip -> wakePending, no reschedule
	await waitFor(
		() => h.controller.statusLines(h.ctx).some((line) => line.includes("wake is pending")),
		"a tick to land while busy and leave the wake pending",
	);

	const lines = h.controller.statusLines(h.ctx);
	assert.ok(
		lines.some((line) => line.includes("wake is pending")),
		"the pending wake is reported",
	);
	assert.equal(
		lines.find((line) => line.startsWith("Next fallback wake:")),
		undefined,
		"no clock time is claimed while the wake is waiting on an idle boundary",
	);
});

test("a wake still scheduled after a poke reports its clock time", async (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	await waitFor(
		() => h.sentUserMessages.some((message) => extractPokeMarker(message.text)),
		"the poke to be delivered",
	);
	const lines = h.controller.statusLines(h.ctx);
	assert.ok(
		lines.some((line) => line.startsWith("Next fallback wake:")),
		"deliverPoke re-arms the timer, so a clock time is correct here",
	);
});

test("a standalone loop writes its ledger, anchors the objective, and echoes criteria", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(
		h.ctx,
		startArgs({ prompt: "get CI green. then cut a release.", intervalMs: 3_600_000, requestedMs: 3_600_000 }),
	);

	const ledger = h.controller.ledger;
	assert.ok(ledger, "the ledger was created");
	assert.equal(ledger.dir, join(h.settingsDir, "loop", h.controller.state?.id ?? ""));
	assert.deepEqual(
		h.controller.criteria()?.map((criterion) => criterion.description),
		["get CI green.", "then cut a release."],
	);
	assert.ok(readFileSync(ledger.progress, "utf8").includes("## Failed approaches and why"));
	assert.ok(
		h.notifications.some((n) => n.message.includes("Completion criteria (2)")),
		"the user sees what loop_complete will demand",
	);

	// The anchor is a stored message, not a turn: sendMessage with no
	// triggerTurn at an idle boundary.
	const anchor = h.sentMessages[0];
	assert.ok(anchor, "the objective was anchored in the transcript");
	assert.equal(anchor.message.customType, "loop-objective");
	assert.match(String(anchor.message.content), /<loop_objective>/);
	assert.match(String(anchor.message.content), /get CI green/);
	assert.match(String(anchor.message.content), /<loop_id>/);
	assert.deepEqual(anchor.options, {}, "no deliverAs at idle: it is appended, not steered");
	// Rules live in the system append, which exists only on active turns; the
	// anchor repeats the objective data alone.
	assert.doesNotMatch(String(anchor.message.content), /Loop-mode rules/);
});

test("a restored loop keeps the criteria on disk instead of re-deriving them", (t) => {
	// criteria.json is what loop_complete answers for and what the user saw
	// echoed at start. Re-deriving it on every restore would discard a set
	// approved with the draft and reset the passes flips the loop had earned.
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(
		h.ctx,
		startArgs({ prompt: "get CI green. then cut a release.", intervalMs: 3_600_000, requestedMs: 3_600_000 }),
	);
	const ledger = h.controller.ledger;
	assert.ok(ledger);
	writeFileSync(
		ledger.criteria,
		JSON.stringify([{ id: "c1", description: "CI is green on main", check: "", passes: true }]),
		"utf8",
	);

	h.controller.onSessionStart(h.ctx);
	assert.deepEqual(h.controller.criteria(), [
		{ id: "c1", description: "CI is green on main", check: "", passes: true },
	]);

	// A ledger whose criteria file is unreadable falls back to the split, so a
	// restore never leaves the loop with no criteria at all.
	writeFileSync(ledger.criteria, "{not json", "utf8");
	h.controller.onSessionStart(h.ctx);
	assert.deepEqual(
		h.controller.criteria()?.map((criterion) => criterion.description),
		["get CI green.", "then cut a release."],
	);
});

test("a busy session queues the anchor instead of steering the running turn", (t) => {
	const h = createHarness({ idle: false });
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	assert.deepEqual(h.sentMessages[0]?.options, { deliverAs: "nextTurn" });
});

test("a compaction re-anchors the loop at the next settle with carried next actions", (t) => {
	const h = createHarness({
		contextUsage: { tokens: 80_000, contextWindow: 100_000, percent: 80 },
	});
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	const sentBefore = h.sentUserMessages.length;

	// The kickoff turn ends and the settle compacts instead of continuing.
	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.compactCalls.length, 1, "compaction outranks the continuation");
	assert.match(h.compactCalls[0]?.customInstructions ?? "", /durable ledger/);
	assert.equal(h.sentUserMessages.length, sentBefore, "nothing delivered while compacting");

	h.usage.value = { tokens: 10_000, contextWindow: 100_000, percent: 10 };
	h.completeCompaction({
		summary: "Did some work.\n\nNext 1-3 actions:\n- rerun the failing test\n- open the PR\n",
	});

	const reanchor = h.sentUserMessages.at(-1);
	assert.ok(reanchor, "the loop re-anchors itself instead of going quiet until a wake");
	assert.match(reanchor.text, /conversation was compacted mid-loop/);
	assert.match(reanchor.text, /PROGRESS\.md/);
	assert.match(reanchor.text, /criteria\.json/);
	assert.match(reanchor.text, /Carried next actions: rerun the failing test; open the PR/);
	// Pointer-sized: the objective still comes from the system append.
	assert.doesNotMatch(reanchor.text, /check the queue/);
});

test("a re-anchor supersedes an ordinary continuation already queued", (t) => {
	const h = createHarness({
		contextUsage: { tokens: 80_000, contextWindow: 100_000, percent: 80 },
	});
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	// An intent is recorded, then a compaction happens before it is dispatched.
	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	h.controller.onAgentSettled(h.ctx);
	h.usage.value = { tokens: 10_000, contextWindow: 100_000, percent: 10 };
	h.completeCompaction({ summary: "no next actions here" });

	const delivered = h.sentUserMessages.at(-1);
	assert.match(delivered?.text ?? "", /compacted mid-loop/);
	assert.doesNotMatch(delivered?.text ?? "", /Carried next actions/);
});

test("an unwritable ledger warns once and the loop still runs", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	chmodSync(h.settingsDir, 0o500);
	try {
		h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	} finally {
		// Restore before the harness cleanup runs, which removes the directory.
		chmodSync(h.settingsDir, 0o755);
	}

	assert.equal(h.controller.ledger, undefined);
	assert.equal(
		h.notifications.filter((n) => n.message.includes("could not write its ledger")).length,
		1,
		"warned exactly once",
	);
	assert.equal(h.controller.state?.status, "active", "the loop runs without a ledger");
	assert.equal(h.sentUserMessages.length, 1, "and still kicks off");
	assert.equal(h.sentMessages.length, 0, "no anchor without a ledger path to name");
});

test("loop_wait holds continuations, keeps the loop active, and wakes at its deadline", async (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	const sentAfterKickoff = h.sentUserMessages.length;

	const resolved = h.controller.enterWait("waiting for the CI run to finish", 1_000);
	assert.deepEqual(resolved, {
		requestedMs: 1_000,
		effectiveMs: 60_000,
		clamped: true,
	}, "sub-minute waits clamp, and the clamp is reported back to the model");
	assert.equal(h.controller.state?.status, "active", "waiting is not paused");
	assert.equal(h.controller.state?.waiting?.reason, "waiting for the CI run to finish");

	// The settle that would normally continue the loop does nothing now.
	h.controller.onAgentEnd(h.ctx, [assistantToolCall("loop_wait")]);
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.sentUserMessages.length, sentAfterKickoff, "no continuation while waiting");

	// Nor does the fallback heartbeat, which stays armed rather than coalescing.
	await waitFor(
		() => h.controller.lastDecision?.reason === "loop-waiting",
		"a tick to land while the loop is waiting",
	);
	assert.equal(h.sentUserMessages.length, sentAfterKickoff, "no poke while waiting");

	// Deadline reached: the wake it asked for, counted against the wake cap.
	h.controller.state = {
		...(h.controller.state as LoopState),
		waiting: { reason: "waiting for the CI run to finish", resumeAt: Date.now() - 1 },
	};
	h.controller.runTick(h.ctx);
	const wake = h.sentUserMessages.at(-1);
	assert.match(wake?.text ?? "", /wait you asked for has elapsed/);
	assert.match(wake?.text ?? "", /Elapsed wait: waiting for the CI run to finish/);
	assert.equal(h.controller.state?.waiting, undefined, "the wake consumed the wait");
	assert.equal(h.controller.state?.iteration, 1, "a wait wake counts: a re-arming model cannot run forever");
});

test("a wait cancelled by a user message surfaces its reason once, then never again", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	h.controller.enterWait("waiting for the deploy to finish", 600_000);

	// A user turn: no loop-caused run is in flight when it ends.
	h.controller.onAgentEnd(h.ctx, [assistantText("ok, do it differently")]);
	assert.equal(h.controller.state?.waiting, undefined, "the user outranks the wait");
	assert.equal(h.controller.state?.cancelledWaitReason, "waiting for the deploy to finish");

	h.controller.onAgentSettled(h.ctx);
	const continuation = h.sentUserMessages.at(-1);
	assert.match(
		continuation?.text ?? "",
		/Previous wait \(cancelled\): waiting for the deploy to finish/,
		"the hint rides along instead of being lost — there is no cancel tool",
	);
});

test("the no-progress breaker pauses a repeating loop and keeps it configured", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));

	for (let turn = 0; turn < 2; turn += 1) {
		h.controller.onAgentEnd(h.ctx, [assistantText("Here is what I would do next.")]);
		h.controller.onAgentSettled(h.ctx);
		assert.equal(h.controller.state?.status, "active", `turn ${turn} is not yet a stall`);
	}
	h.controller.onAgentEnd(h.ctx, [assistantText("Here is what I would do next.")]);

	assert.equal(h.controller.state?.status, "paused");
	assert.equal(h.controller.state?.pauseCause, "no progress");
	assert.ok(h.notifications.some((n) => n.message.includes("same answer and called no tools")));
	assert.equal(h.controller.state?.objective, "check the queue", "still configured, not stopped");

	// Resuming starts a fresh safety epoch, so the stale counters cannot trip it again.
	h.controller.resumeLoop(h.ctx);
	assert.equal(h.controller.state?.status, "active");
	assert.equal(h.controller.state?.toolFreeRepeatCount, 0);
	assert.equal(h.controller.state?.pauseCause, undefined);
});

test("a turn that called loop_wait, or any tool, never counts as no progress", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));

	for (let turn = 0; turn < 5; turn += 1) {
		h.controller.onAgentEnd(h.ctx, [
			assistantText("Waiting on the deploy."),
			assistantToolCall("loop_wait"),
		]);
	}
	assert.equal(h.controller.state?.status, "active", "declaring a wait is a decision, not a stall");
	assert.equal(h.controller.state?.toolFreeRepeatCount, 0);
});

test("user input resets the breaker's epoch", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	h.controller.onAgentEnd(h.ctx, [assistantText("Same answer.")]);
	h.controller.onAgentSettled(h.ctx);
	h.controller.onAgentEnd(h.ctx, [assistantText("Same answer.")]);
	assert.equal(h.controller.state?.toolFreeRepeatCount, 2);

	// A settle with no continuation in flight, then a user-driven turn.
	h.controller.onAgentSettled(h.ctx);
	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	h.controller.onAgentEnd(h.ctx, [assistantText("Same answer.")]);
	assert.equal(h.controller.state?.toolFreeRepeatCount, 0, "the user has seen it and chosen to go on");
});

test("a usage limit pauses the loop instead of retrying into an exhausted quota", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	h.controller.onAgentEnd(h.ctx, [
		{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 you have used all your included usage" },
	]);
	assert.equal(h.controller.state?.status, "paused");
	assert.equal(h.controller.state?.pauseCause, "usage limit reached");
});

test("a transient provider error just continues", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	const before = h.sentUserMessages.length;
	h.controller.onAgentEnd(h.ctx, [
		{ role: "assistant", content: [], stopReason: "error", errorMessage: "503 service unavailable" },
	]);
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.controller.state?.status, "active");
	assert.equal(h.sentUserMessages.length, before + 1, "the continuation is the retry");
});

test("a context overflow compacts before continuing, whatever the usage gauge says", (t) => {
	const h = createHarness({
		// Far below the threshold: only the failed request knows it overflowed.
		contextUsage: { tokens: 1_000, contextWindow: 100_000, percent: 1 },
	});
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	h.controller.onAgentEnd(h.ctx, [
		{
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "context_length_exceeded: input exceeds the context window",
		},
	]);
	assert.ok(h.notifications.some((n) => n.message.includes("overflowed the context window")));

	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.compactCalls.length, 1, "compaction is the answer, not another oversized retry");
	h.completeCompaction({ summary: "Next actions:\n- retry the failing step" });
	assert.match(h.sentUserMessages.at(-1)?.text ?? "", /compacted mid-loop/);
});

test("an interrupted loop turn pauses instead of being immediately re-sent", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	// Esc during the kickoff turn the loop itself dispatched.
	h.controller.onAgentEnd(h.ctx, [{ role: "assistant", content: [], stopReason: "aborted" }]);
	assert.equal(h.controller.state?.status, "paused");
	assert.equal(h.controller.state?.pauseCause, "interrupted");
});

test("a wait restored from a session entry re-arms its deadline", async (t) => {
	const now = Date.now();
	const activeState = {
		id: "restored2",
		status: "active",
		objective: "keep going",
		intervalMs: 3_600_000,
		maxTurns: 25,
		compactAt: null,
		iteration: 0,
		automaticTurns: 0,
		startedAt: now - 1000,
		expiresAt: now + 600_000,
		waiting: { reason: "waiting for the deploy", resumeAt: now - 1 },
	};
	const h = createHarness({
		branch: [{ type: "custom", customType: LOOP_STATE_ENTRY_TYPE, data: { loop: activeState } }],
	});
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	assert.equal(h.controller.state?.id, "restored2");

	await waitFor(
		() => /wait you asked for has elapsed/.test(h.sentUserMessages.at(-1)?.text ?? ""),
		"the elapsed wait to wake the restored loop",
	);
});

test("expiry buys one final turn to write the state down, then stops", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	// Wind the loop up to its expiry.
	h.controller.state = { ...(h.controller.state as LoopState), expiresAt: Date.now() - 1 };
	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	h.controller.onAgentSettled(h.ctx);

	const finalWake = h.sentUserMessages.at(-1);
	assert.match(finalWake?.text ?? "", /reached its expiry and is stopping after this turn/);
	assert.match(finalWake?.text ?? "", /PROGRESS\.md/);
	assert.match(finalWake?.text ?? "", /do not claim completion/);
	assert.equal(h.controller.state?.status, "active", "still active for exactly that turn");
	assert.equal(h.controller.state?.expiring, true);
	assert.ok(h.notifications.some((n) => n.message.includes("one final turn")));

	// That turn ends: no continuation is queued behind it, and the settle stops.
	const delivered = h.sentUserMessages.length;
	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.sentUserMessages.length, delivered, "the final turn is the last one");
	assert.equal(h.controller.state?.status, "stopped");
	assert.ok(h.notifications.some((n) => n.message.includes("loop expired")));
});

test("a per-loop --expires overrides the settings default and is echoed", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	const startedAt = Date.now();
	h.controller.startLoop(h.ctx, startArgs({ expiresInMs: 10_800_000 }));
	const expiresAt = h.controller.state?.expiresAt ?? 0;
	assert.ok(
		Math.abs(expiresAt - (startedAt + 10_800_000)) < 5_000,
		"the loop expires in 3h, not the 7d default",
	);
	assert.ok(h.notifications.some((n) => n.message.includes("Expires in 3h")));
});

test("an expiry wake Pi refuses stops the loop rather than leaving it past its deadline", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	h.controller.state = { ...(h.controller.state as LoopState), expiresAt: Date.now() - 1 };
	h.flags.sendFailures = 1;
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.controller.state?.status, "stopped");
	assert.ok(h.notifications.some((n) => n.message.includes("could not deliver the expiry wake")));
});

test("consecutive LOOP_OK wakes back the heartbeat off; real work resets it", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);

	// A fallback wake answered with the acknowledgement: the wake was wasted,
	// and unlike a prose "nothing to do" the engine can tell.
	h.controller.runTick(h.ctx);
	h.controller.onAgentEnd(h.ctx, [assistantText("LOOP_OK")]);
	assert.equal(h.controller.noOpStreak, 1);
	h.controller.runTick(h.ctx);
	h.controller.onAgentEnd(h.ctx, [assistantText("LOOP_OK · queue still empty")]);
	assert.equal(h.controller.noOpStreak, 2);
	assert.equal(h.controller.fallbackDelayMs(h.controller.state as LoopState), 3_600_000 * 4, "capped");

	// An acknowledgement counts even when the model used a tool to check.
	h.controller.runTick(h.ctx);
	h.controller.onAgentEnd(h.ctx, [assistantToolCall(), assistantText("LOOP_OK")]);
	assert.equal(h.controller.noOpStreak, 3, "looking and finding nothing is still nothing");

	// Actual work resets it.
	h.controller.runTick(h.ctx);
	h.controller.onAgentEnd(h.ctx, [assistantToolCall(), assistantText("Fixed the failing test.")]);
	assert.equal(h.controller.noOpStreak, 0);
});

test("the wake asks for the acknowledgement it acts on", (t) => {
	// The protocol only works if the poke actually requests it; this pins the
	// two halves together.
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	h.controller.runTick(h.ctx);
	assert.match(h.sentUserMessages.at(-1)?.text ?? "", /reply LOOP_OK and stop/);
});

/**
 * The restore shim. A loop persisted before 0.6.0 may carry no objective of
 * its own: it delegated "is the work done" to a goal in an extension that no
 * longer exists here. The only session that can still reach this code is one
 * persisted before 0.6.0 and resumed after it, having never been restored
 * under 0.5.0 — where it would already have been converted.
 */
test("a restored pre-0.6.0 loop adopts its focus text as the objective", (t) => {
	const now = Date.now();
	const h = createHarness({
		branch: [
			{
				type: "custom",
				customType: LOOP_STATE_ENTRY_TYPE,
				data: {
					loop: {
						id: "bound001",
						status: "active",
						prompt: "keep the release moving",
						intervalMs: 3_600_000,
						maxTurns: 25,
						compactAt: null,
						iteration: 2,
						automaticTurns: 2,
						startedAt: now - 1000,
						expiresAt: now + 600_000,
					},
				},
			},
		],
	});
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);

	assert.equal(h.controller.state?.status, "active");
	assert.equal(h.controller.state?.objective, "keep the release moving");
	assert.equal(h.controller.state?.prompt, undefined, "the focus became the objective's job");
	assert.ok(h.notifications.some((n) => n.message.includes("works its focus text directly")));
});

test("a restored pre-0.6.0 loop with nothing to adopt pauses and says so", (t) => {
	const now = Date.now();
	const bare = createHarness({
		branch: [
			{
				type: "custom",
				customType: LOOP_STATE_ENTRY_TYPE,
				data: {
					loop: {
						id: "bound003",
						status: "active",
						intervalMs: 3_600_000,
						maxTurns: 25,
						compactAt: null,
						iteration: 0,
						automaticTurns: 0,
						startedAt: now - 1000,
						expiresAt: now + 600_000,
					},
				},
			},
		],
	});
	t.after(bare.cleanup);
	bare.controller.onSessionStart(bare.ctx);
	assert.equal(bare.controller.state?.status, "paused");
	assert.equal(bare.controller.state?.pauseCause, "loop with no objective");
	assert.ok(
		bare.notifications.some((n) => n.message.includes("run /loop to plan and approve a new one")),
		"the pause names the way out",
	);
	assert.equal(bare.sentUserMessages.length, 0, "and nothing is dispatched");
});

test("a session with no loop_complete tool refuses to start a loop", (t) => {
	// Restricted tool sets (--tools, --no-tools, a policy) silently remove the
	// only way a standalone loop can end itself. Found by the live canary:
	// the loop worked, finished, updated its ledger, and was then told to keep
	// working every turn until it hit its cap.
	const h = createHarness({ activeTools: ["bash", "read"] });
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	const result = h.controller.startLoop(h.ctx, startArgs());
	assert.equal(h.controller.state, undefined, "no loop is created");
	assert.ok(!result.ok && result.message.includes("no loop_complete tool"));
	assert.equal(h.sentUserMessages.length, 0);
});

test("losing the loop_complete tool mid-loop pauses instead of spinning", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	h.flags.activeTools = ["bash"];
	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	assert.equal(h.controller.state?.status, "paused");
	assert.equal(h.controller.state?.pauseCause, "loop_complete unavailable");
});

test("a host that cannot report its tools is not treated as missing them", (t) => {
	// Fail open: absence of evidence is not evidence of absence.
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.flags.activeTools = [];
	(h.rawPi as { getActiveTools?: unknown }).getActiveTools = () => {
		throw new Error("not supported");
	};
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	assert.equal(h.controller.state?.status, "active");
});

test("deliveries that never become turns pause the loop", (t) => {
	// Found by the live canary: with no API key every run failed before its
	// first token, so agent_end never fired, nothing classified the failure,
	// and the heartbeat poked once a minute until the wake cap.
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	// The kickoff was delivered; no agent_start ever follows.
	assert.equal(h.controller.state?.status, "active");
	h.controller.runTick(h.ctx);
	assert.equal(h.controller.state?.status, "active", "one dead delivery is not a verdict");
	h.controller.runTick(h.ctx);
	h.controller.runTick(h.ctx);
	assert.equal(h.controller.state?.status, "paused");
	assert.equal(h.controller.state?.pauseCause, "deliveries produce no turns");
	assert.ok(h.notifications.some((n) => n.message.includes("produced no turn at all")));
});

test("a run that actually starts clears the dead-delivery count", (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());
	h.controller.runTick(h.ctx);
	h.controller.runTick(h.ctx);
	// Pi picks the message up this time.
	h.controller.onAgentStart(h.ctx);
	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	h.controller.runTick(h.ctx);
	h.controller.runTick(h.ctx);
	assert.equal(h.controller.state?.status, "active", "the streak restarted from zero");
});

test("a run left open past the stall threshold reports as blocked, not as scheduled", async (t) => {
	// The failure this exists for: a session waiting on a modal prompt is
	// `busy`, and busy makes every continuation and every fallback tick skip.
	// No turn completes, so the cap never trips and the no-progress breaker
	// (which counts turns) never fires. Expiry is the only thing left, seven
	// days later, while the widget shows a cheerful next-wake time throughout.
	let clock = 1_000_000_000_000;
	const h = createHarness({ now: () => clock });
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs());

	// A run starts and never ends, exactly as it would behind a permission prompt.
	h.controller.onAgentStart(h.ctx);
	h.flags.idle = false;
	await wait(TICK_MS * 3);
	assert.equal(
		(h.controller.widgetView() as { blockedForMs?: number } | undefined)?.blockedForMs,
		undefined,
		"ordinary busy work is not a stall",
	);

	// Past the threshold, the same open run is reported.
	clock += STALL_ATTENTION_MS + 60_000;
	await waitFor(
		() =>
			(h.controller.widgetView() as { blockedForMs?: number } | undefined)?.blockedForMs !==
			undefined,
		"the open run to be reported as blocked",
	);
	const view = h.controller.widgetView() as { blockedForMs?: number } | undefined;
	assert.ok(
		view?.blockedForMs !== undefined && view.blockedForMs >= STALL_ATTENTION_MS,
		"a run open past the threshold is reported as blocked",
	);
	assert.match(loopWidgetLine(view as never), /^⚠ loop blocked · no turn for \d+m · a prompt may be waiting$/);

	// A completed turn is proof the session was never blocked on a human.
	h.controller.onAgentEnd(h.ctx, []);
	assert.equal(
		(h.controller.widgetView() as { blockedForMs?: number } | undefined)?.blockedForMs,
		undefined,
		"a completed turn clears the attention state",
	);
});

/**
 * The expiry watchdog.
 *
 * Expiry used to be noticed only when something else woke the loop — a
 * fallback wake or an idle settle — so a loop with a long interval that went
 * quiet stayed "active" indefinitely past its deadline, and its objective kept
 * being injected into every turn. The watchdog is armed for the exact
 * `expiresAt` instead, independently of the fallback timer.
 */
test("an idle loop expires on its own deadline, not on the fallback interval", async (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	// A fallback wake an hour away: only the watchdog can end this loop.
	h.controller.startLoop(
		h.ctx,
		startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000, expiresInMs: 40 }),
	);
	const delivered = h.sentUserMessages.length;

	await waitFor(
		() => h.sentUserMessages.length > delivered,
		"the expiry wake to fire without a settle",
	);
	const finalWake = h.sentUserMessages.at(-1);
	assert.match(finalWake?.text ?? "", /reached its expiry and is stopping after this turn/);
	assert.equal(h.controller.state?.expiring, true);
});

test("expiry while Plan mode owns the session stops deterministically", async (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(
		h.ctx,
		startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000, expiresInMs: 40 }),
	);
	const delivered = h.sentUserMessages.length;
	h.branch.push({
		type: "custom",
		customType: PLAN_MODE_STATE_ENTRY_TYPE,
		data: { enabled: true },
	});

	await waitFor(() => h.controller.state?.status === "stopped", "the watchdog to stop the loop");
	assert.equal(h.sentUserMessages.length, delivered, "nothing is injected into Plan mode");
	assert.equal(h.controller.state?.terminalReason, "loop expired while Plan mode was active");
	assert.ok(h.notifications.some((n) => n.message.includes("Plan mode")));
});

test("expiry during a busy turn stops instead of queueing a wake behind it", async (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(
		h.ctx,
		startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000, expiresInMs: 40 }),
	);
	const delivered = h.sentUserMessages.length;
	h.flags.idle = false;

	await waitFor(() => h.controller.state?.status === "stopped", "the watchdog to stop the loop");
	assert.equal(h.sentUserMessages.length, delivered);
	assert.equal(h.controller.state?.terminalReason, "loop expired while the agent was busy");
});

test("a stopped or replaced loop's watchdog can never fire against newer state", async (t) => {
	const h = createHarness();
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(
		h.ctx,
		startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000, expiresInMs: 40 }),
	);
	const firstId = h.controller.state?.id;
	// Replace it with a loop that is nowhere near its deadline.
	h.controller.startLoop(
		h.ctx,
		startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000, expiresInMs: 3_600_000 }),
	);
	const secondId = h.controller.state?.id;
	assert.notEqual(firstId, secondId);
	const delivered = h.sentUserMessages.length;

	await wait(160);
	assert.equal(h.controller.state?.id, secondId);
	assert.equal(h.controller.state?.status, "active", "the replaced loop's timer is inert");
	assert.equal(h.controller.state?.expiring, undefined);
	assert.equal(h.sentUserMessages.length, delivered);
});

test("an expiry wake that never becomes a turn still stops the loop", async (t) => {
	// `sendUserMessage` is fire-and-forget: Pi accepts the call and swallows an
	// asynchronous delivery failure, so a clean return proves nothing. Without
	// this guard the loop sits active past its deadline with every timer
	// cleared, injecting its objective into a session that will never wake.
	const h = createHarness({ expiryTurnGraceMs: 40 });
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	h.controller.state = { ...(h.controller.state as LoopState), expiresAt: Date.now() - 1 };
	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.controller.state?.expiring, true, "the final wake went out");
	assert.equal(h.controller.state?.status, "active");

	await waitFor(
		() => h.controller.state?.status === "stopped",
		"the grace guard to stop a final turn that never started",
	);
	assert.equal(h.controller.state?.terminalReason, "the final expiry turn never started");
});

test("a final expiry turn that does start is left alone by the guard", async (t) => {
	const h = createHarness({ expiryTurnGraceMs: 40 });
	t.after(h.cleanup);
	h.controller.onSessionStart(h.ctx);
	h.controller.startLoop(h.ctx, startArgs({ intervalMs: 3_600_000, requestedMs: 3_600_000 }));
	h.controller.state = { ...(h.controller.state as LoopState), expiresAt: Date.now() - 1 };
	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	h.controller.onAgentSettled(h.ctx);
	// The run Pi started from that wake.
	h.controller.onAgentStart(h.ctx);

	await wait(140);
	assert.equal(h.controller.state?.status, "active", "a long final turn is not cut short");
	// It ends the ordinary way, at the settle after the turn.
	h.controller.onAgentEnd(h.ctx, [assistantToolCall()]);
	h.controller.onAgentSettled(h.ctx);
	assert.equal(h.controller.state?.status, "stopped");
});
