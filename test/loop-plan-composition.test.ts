/**
 * Plan mode and Loop loaded into one session, in both load orders.
 *
 * Neither package can pin this on its own — and neither may import the other's
 * sources — so the composition lives here, outside `packages/`, where a test
 * is allowed to load both extensions the way a real host does.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import loop from "../packages/pi-loop/src/index.js";
import { LOOP_PLANNING_HINT } from "../packages/pi-loop/src/planning.js";
import askUserQuestion from "../packages/pi-ask-user-question/index.js";
import planMode from "../packages/pi-plan-mode/src/plan-mode.js";
import { createMockContext, createMockPi } from "./support/mock-pi.js";

type Order = "plan-first" | "loop-first";

/**
 * Every load gets its own scratch agent dir, and reads no environment.
 *
 * This used to pass `agentDir: process.env.PI_CODING_AGENT_DIR`, which is
 * `undefined` under `npm test` — so `LoopController` fell back to
 * `getAgentDir()` and `startLoop` wrote a real ledger into the host's
 * `~/.pi/agent/loop`, two directories per suite run, accumulating forever.
 * `scripts/test.sh` says the gate must never touch or read the host's real
 * `~/.pi`, and an env var that is usually unset is exactly what hid the fact
 * that this one did. Both paths are passed explicitly for the same reason
 * `packages/pi-loop/test/support/mock-pi.ts` passes them.
 */
function load(order: Order) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-composition-"));
	const settingsPath = join(agentDir, "pi-loop.json");
	const planSettingsPath = join(agentDir, "pi-plan-mode.json");
	const mock = createMockPi({ activeTools: ["read"] });
	let controller: ReturnType<typeof loop>;
	if (order === "plan-first") {
		planMode(mock.pi, { settingsPath: planSettingsPath });
		askUserQuestion(mock.pi);
		controller = loop(mock.pi, { agentDir, settingsPath });
	} else {
		controller = loop(mock.pi, { agentDir, settingsPath });
		askUserQuestion(mock.pi);
		planMode(mock.pi, { settingsPath: planSettingsPath });
	}
	const sessionManager = {
		getSessionId: () => `composition-${order}`,
		getSessionName: () => undefined,
		getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })),
		getEntries: () => mock.entries.map((entry) => ({ type: "custom", ...entry })),
	};
	const context = createMockContext({ hasUI: true, mode: "tui", sessionManager });
	// Both packages are shut down the way a host does it, through the event: Plan
	// mode's settings watcher is started at session_start and only stopped there,
	// so a load that never emits it leaks one directory watch per test. The loop's
	// own handler does the same call as the explicit one below, which stays
	// because it is idempotent and does not depend on that registration.
	const cleanup = async () => {
		await emitAll(mock, "session_shutdown", {}, context.ctx);
		controller.onSessionShutdown();
		rmSync(agentDir, { recursive: true, force: true });
	};
	return { mock, controller, context, agentDir, cleanup };
}

async function emitAll(
	mock: ReturnType<typeof createMockPi>,
	name: string,
	event: Record<string, unknown>,
	ctx: unknown,
) {
	for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
}

async function promptFor(mock: ReturnType<typeof createMockPi>, ctx: unknown): Promise<string> {
	let systemPrompt = "base";
	for (const handler of mock.events.get("before_agent_start") ?? []) {
		const result = (await handler({ systemPrompt }, ctx)) as { systemPrompt?: string } | undefined;
		if (result?.systemPrompt) systemPrompt = result.systemPrompt;
	}
	return systemPrompt;
}

for (const order of ["plan-first", "loop-first"] as const) {
	test(`${order}: Plan suppresses an active Loop prompt and Loop resumes after exit`, async (t) => {
		const { mock, controller, context, agentDir, cleanup } = load(order);
		t.after(cleanup);
		await emitAll(mock, "session_start", { reason: "new" }, context.ctx);
		mock.rawPi.setActiveTools([
			...mock.rawPi.getActiveTools(),
			"loop_complete",
			"loop_progress",
			"loop_wait",
		]);
		const started = controller.startLoop(context.ctx, {
			kind: "start",
			requestedMs: 600_000,
			intervalMs: 600_000,
			clamped: false,
			prompt: "- composition objective, verified by a focused test",
		});
		assert.ok(started.ok);
		// Self-policing isolation: the ledger this loop just wrote must live under
		// the scratch dir. If the default agent-dir path ever creeps back, this
		// fails here instead of silently littering the host's ~/.pi/agent/loop.
		assert.ok(controller.ledger, "the loop opened a ledger");
		assert.ok(
			controller.ledger.dir.startsWith(agentDir),
			`ledger escaped the scratch dir: ${controller.ledger.dir}`,
		);
		assert.ok(existsSync(controller.ledger.criteria), "criteria.json is under the scratch dir");
		assert.match(await promptFor(mock, context.ctx), /<loop_objective>/);

		await mock.commands.get("plan")?.handler("start", context.ctx);
		const duringPlan = await promptFor(mock, context.ctx);
		assert.match(duringPlan, /\[PLAN MODE ACTIVE\]/);
		assert.doesNotMatch(duringPlan, /<loop_objective>/);

		await mock.commands.get("plan")?.handler("exit", context.ctx);
		const resumed = await promptFor(mock, context.ctx);
		assert.doesNotMatch(resumed, /\[PLAN MODE ACTIVE\]/);
		assert.match(resumed, /<loop_objective>/);
	});

	test(`${order}: Loop planning guidance stays suppressed while Plan is active`, async (t) => {
		const { mock, context, cleanup } = load(order);
		t.after(cleanup);
		await emitAll(mock, "session_start", { reason: "new" }, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		await mock.commands.get("loop")?.handler("draft a bounded objective", context.ctx);
		const prompt = await promptFor(mock, context.ctx);
		assert.match(prompt, /\[PLAN MODE ACTIVE\]/);
		assert.ok(!prompt.includes(LOOP_PLANNING_HINT));
	});
}

test("a headless run with both packages keeps no question tool and names none", async (t) => {
	// The reviewer lane's finding: Plan mode used to pick a tool name from the
	// raw active set, so whichever package's before_agent_start ran first could
	// leave the prompt pointing at a tool the other one was about to strip.
	const { mock, context, cleanup } = load("plan-first");
	t.after(cleanup);
	const headless = createMockContext({
		hasUI: false,
		sessionManager: (context.ctx as unknown as { sessionManager: unknown }).sessionManager,
	});
	mock.rawPi.setActiveTools(["read", "bash", "ask_user_question"]);
	await emitAll(mock, "session_start", { reason: "new" }, headless.ctx);
	await mock.commands.get("plan")?.handler("start", headless.ctx);
	const prompt = await promptFor(mock, headless.ctx);

	assert.match(prompt, /\[PLAN MODE ACTIVE\]/);
	assert.ok(!prompt.includes("ask_user_question"), "the stripped global tool is not advertised");
	assert.ok(!prompt.includes("plan_mode_question"), "the inactive fallback is not advertised");
	assert.match(prompt, /ask in plain text/);
	assert.deepEqual(
		mock.rawPi.getActiveTools().filter((name) => name.endsWith("question")),
		[],
		"neither interactive question tool survives a headless run",
	);
});

test("an interactive run keeps exactly one question tool, in both load orders", async (t) => {
	for (const order of ["plan-first", "loop-first"] as const) {
		const { mock, context, cleanup } = load(order);
		t.after(cleanup);
		mock.rawPi.setActiveTools(["read", "bash", "ask_user_question"]);
		await emitAll(mock, "session_start", { reason: "new" }, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		const prompt = await promptFor(mock, context.ctx);

		assert.deepEqual(
			mock.rawPi.getActiveTools().filter((name) => name.endsWith("question")),
			["ask_user_question"],
			`${order}: the richer tool wins and the fallback stays out`,
		);
		assert.match(prompt, /ask_user_question/);
		assert.ok(!prompt.includes("plan_mode_question"), `${order}: no second question tool`);
	}
});
