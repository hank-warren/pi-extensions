/**
 * What the extension registers, and where `/loop` sends you.
 *
 * The removals are the point of this file. A tool the model can call to start
 * a self-continuing loop, and a command grammar that starts one from a single
 * unreviewed line, are both gone — and "gone" is only true if nothing
 * re-registers them, which no other test would notice.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import loop, { REQUEST_PROPOSAL_MESSAGE } from "../src/index.js";
import { createLoopHarness } from "./support/mock-pi.js";

/**
 * The extension as the host loads it, driven through its own controller —
 * never the harness's spare one, which would let a router test pass against a
 * loop the extension does not have.
 */
function load(options: Parameters<typeof createLoopHarness>[0] = {}) {
	const harness = createLoopHarness({ mode: "print", ...options });
	const controller = loop(harness.pi, {
		settingsPath: `${harness.agentDir}/pi-loop.json`,
		agentDir: harness.agentDir,
	});
	controller.onSessionStart(harness.ctx);
	return { ...harness, controller, cleanup: () => {
		controller.onSessionShutdown();
		harness.cleanup();
	} };
}

test("no tool can start a loop", (t) => {
	const harness = load();
	t.after(harness.cleanup);
	assert.deepEqual(
		[...harness.tools.keys()].sort(),
		["loop_complete", "loop_progress", "loop_propose", "loop_wait"],
		"loop_start is gone; approving the card is the only start",
	);
	// The tools that remain are all things a *running* loop needs, plus the one
	// that asks the user for permission to have one.
	assert.equal(harness.tools.has("loop_start"), false);
});

test("/loop with text opens planning and says the first thing", (t) => {
	const harness = load();
	t.after(harness.cleanup);
	const command = harness.commands.get("loop");
	assert.ok(command);
	command.handler("get CI green on main", harness.ctx);

	assert.equal(harness.controller.planning.active, true);
	assert.deepEqual(harness.sentUserMessages, ["get CI green on main"]);
	// Planning, not starting: nothing exists to run yet.
	assert.equal(harness.controller.state, undefined);
});

test("the old subcommands are words now, not silent no-ops", (t) => {
	const harness = load();
	t.after(harness.cleanup);
	const command = harness.commands.get("loop");
	command?.handler("status", harness.ctx);
	// `/loop status` used to print the status. It seeds planning instead, which
	// is visible and recoverable; silently doing nothing would not be.
	assert.deepEqual(harness.sentUserMessages, ["status"]);
	assert.equal(harness.controller.planning.active, true);
});

test("bare /loop routes by state, and never starts anything", async (t) => {
	const harness = load();
	t.after(harness.cleanup);
	const command = harness.commands.get("loop");
	assert.ok(command);

	// Off: the launch surface. In print mode that is a notification.
	await command.handler("", harness.ctx);
	assert.match(harness.notifications.at(-1)?.message ?? "", /No loop in this session/);
	assert.equal(harness.controller.planning.active, false);

	// Planning open: the planning surface.
	harness.controller.beginPlanning();
	await command.handler("", harness.ctx);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Loop planning is open/);

	// A draft awaiting approval: the card, and only the card.
	harness.controller.propose("- ship it, verified by npm test");
	await command.handler("", harness.ctx);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Approve it from a TUI session/);
	assert.equal(harness.controller.state, undefined);
});

test("a running loop owns the session: /loop <text> manages instead of drafting", async (t) => {
	const harness = load();
	t.after(harness.cleanup);
	harness.pi.setActiveTools([
		...harness.pi.getActiveTools(),
		"loop_complete", "loop_progress", "loop_wait",
	]);
	const started = harness.controller.startLoop(harness.ctx, {
		kind: "start",
		requestedMs: 600_000,
		intervalMs: 600_000,
		clamped: false,
		prompt: "- ship it, verified by npm test",
	});
	assert.ok(started.ok);
	const before = harness.sentUserMessages.length;

	await harness.commands.get("loop")?.handler("something else entirely", harness.ctx);
	assert.equal(
		harness.sentUserMessages.length,
		before,
		"the text is not dispatched into a running loop's conversation",
	);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Status: active/);
});

test("the planning menu's proposal request names the tool and the ground rules", () => {
	assert.match(REQUEST_PROPOSAL_MESSAGE, /loop_propose/);
	assert.match(REQUEST_PROPOSAL_MESSAGE, /ground rules/i);
	// It asks; it does not insist. A draft with a hole in it should produce a
	// question, not a proposal nobody can approve honestly.
	assert.match(REQUEST_PROPOSAL_MESSAGE, /ask me that one question/i);
});

/**
 * Tool staging. Every loop tool stays *registered* (a historical transcript
 * still resolves it), but a session that has never touched /loop should not
 * pay for four Loop-only schemas in its cached prompt prefix.
 */
const LOOP_TOOLS = ["loop_propose", "loop_complete", "loop_progress", "loop_wait"];

function loopToolsIn(harness: ReturnType<typeof load>): string[] {
	return harness.pi.getActiveTools().filter((name: string) => LOOP_TOOLS.includes(name));
}

test("a fresh session advertises no loop tools at all", (t) => {
	const harness = load({ activeTools: ["bash", "read"] });
	t.after(harness.cleanup);
	assert.deepEqual(loopToolsIn(harness), []);
	// Registration is untouched: only the active set narrowed.
	for (const name of LOOP_TOOLS) assert.ok(harness.tools.has(name), `${name} stays registered`);
	assert.deepEqual(harness.pi.getActiveTools(), ["bash", "read"], "siblings are preserved");
});

test("planning exposes loop_propose, and only loop_propose", async (t) => {
	const harness = load({ activeTools: ["bash"] });
	t.after(harness.cleanup);
	await harness.commands.get("loop")?.handler("get CI green on main", harness.ctx);
	assert.deepEqual(loopToolsIn(harness), ["loop_propose"]);
	assert.ok(harness.pi.getActiveTools().includes("bash"));
});

test("a proposal exposes the tools a running loop actually needs", async (t) => {
	const harness = load({ activeTools: ["bash"] });
	t.after(harness.cleanup);
	await harness.commands.get("loop")?.handler("ship it", harness.ctx);
	const propose = harness.tools.get("loop_propose") as {
		execute(
			id: string,
			params: Record<string, unknown>,
			signal: undefined,
			onUpdate: undefined,
			ctx: unknown,
		): Promise<unknown>;
	};
	await propose.execute(
		"call-1",
		{ objective: "- ship it, verified by npm test" },
		undefined,
		undefined,
		harness.ctx,
	);

	assert.deepEqual(loopToolsIn(harness).sort(), [...LOOP_TOOLS].sort());
	// Monotonic: a second proposal must not rewrite or drop anything.
	await propose.execute(
		"call-2",
		{ objective: "- ship it again, verified by npm test" },
		undefined,
		undefined,
		harness.ctx,
	);
	assert.deepEqual(loopToolsIn(harness).sort(), [...LOOP_TOOLS].sort());
});

test("a restored PAUSED loop gets its runtime tools back when it is resumed", (t) => {
	const harness = createLoopHarness({ mode: "print", activeTools: ["bash"] });
	t.after(harness.cleanup);
	const controller = loop(harness.pi, {
		settingsPath: `${harness.agentDir}/pi-loop.json`,
		agentDir: harness.agentDir,
	});
	t.after(() => controller.onSessionShutdown());

	harness.pi.setActiveTools([...harness.pi.getActiveTools(), "loop_complete"]);
	const started = controller.startLoop(harness.ctx, {
		kind: "start",
		requestedMs: 600_000,
		intervalMs: 600_000,
		clamped: false,
		prompt: "- keep it green, verified by npm test",
	});
	assert.ok(started.ok);
	// The user pauses, and the session ends with a paused loop on disk.
	controller.pauseLoop(harness.ctx);
	assert.equal(controller.state?.status, "paused");

	// A new session restores it. A paused loop is not active, so the runtime
	// tools are correctly narrowed out of the cached prefix.
	harness.pi.setActiveTools(["bash"]);
	const sessionStart = harness.events.get("session_start")?.[0];
	assert.ok(sessionStart);
	sessionStart({ reason: "resume" }, harness.ctx);
	assert.deepEqual(loopToolsIn({ pi: harness.pi } as never), []);

	// The user resumes from the /loop manager. `resumeLoop` cannot reach the
	// activation closure, so the turn it dispatches is what must restore them.
	controller.resumeLoop(harness.ctx);
	assert.equal(controller.state?.status, "active");
	harness.emit("before_agent_start", { systemPrompt: "base" });

	assert.deepEqual(
		loopToolsIn({ pi: harness.pi } as never).sort(),
		["loop_complete", "loop_progress", "loop_wait"],
		"a resumed loop can finish, record progress and wait",
	);
	assert.ok(harness.pi.getActiveTools().includes("bash"), "siblings are preserved");
});

test("a restored active loop gets its runtime tools back before the first turn", (t) => {
	const harness = createLoopHarness({ mode: "print", activeTools: ["bash"] });
	t.after(harness.cleanup);
	const controller = loop(harness.pi, {
		settingsPath: `${harness.agentDir}/pi-loop.json`,
		agentDir: harness.agentDir,
	});
	t.after(() => controller.onSessionShutdown());

	// Build an active loop, persist it, and restore it in the same harness the
	// way a resumed session would.
	harness.pi.setActiveTools([...harness.pi.getActiveTools(), "loop_complete"]);
	const started = controller.startLoop(harness.ctx, {
		kind: "start",
		requestedMs: 600_000,
		intervalMs: 600_000,
		clamped: false,
		prompt: "- keep it green, verified by npm test",
	});
	assert.ok(started.ok);
	harness.pi.setActiveTools(["bash"]);

	const sessionStart = harness.events.get("session_start")?.[0];
	assert.ok(sessionStart);
	sessionStart({ reason: "resume" }, harness.ctx);

	assert.deepEqual(
		loopToolsIn({ pi: harness.pi } as never).sort(),
		["loop_complete", "loop_progress", "loop_wait"],
		"a restored loop can finish, record progress and wait",
	);
});
