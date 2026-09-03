import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "../../../test/support/mock-pi.js";
import {
	formatImplementationHandoff,
	startFreshImplementationFromState,
	startFreshImplementationSession,
} from "../src/fresh-implementation.js";
import { planFilePathForSession } from "../src/plan-file.js";
import { showReadyPlanMenu } from "../src/plan-action-menus.js";
import planMode from "../src/plan-mode.js";

const PLAN = `# Fresh implementation plan

1. Start from the approved plan.
2. Exclude the planning conversation.`;
const STATE_ENTRY_TYPE = "plan-mode-state";
const MISSING_SETTINGS = { readSettings: async () => ({ kind: "missing" as const }) };
const IMPLEMENTATION_CHOICES = ["Implement here", "Start fresh and implement"];

/**
 * The hermetic preload's scratch agent dir (`test/support/hermetic.ts`). Every
 * helper below repoints `PI_CODING_AGENT_DIR` at a temp dir it then deletes, and
 * puts this back afterwards, so a case that runs outside a helper never inherits
 * a path that no longer exists.
 */
const PRELOAD_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

async function withAgentDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-fresh-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		return await run(directory);
	} finally {
		process.env.PI_CODING_AGENT_DIR = PRELOAD_AGENT_DIR;
		await rm(directory, { recursive: true, force: true });
	}
}

function stateEntry(data: Record<string, unknown>) {
	return { type: "custom" as const, customType: STATE_ENTRY_TYPE, data };
}

async function completePlan(mock: ReturnType<typeof createMockPi>, ctx: unknown) {
	const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(complete);
	await complete("complete", { plan: PLAN }, undefined, undefined, ctx);
}

function assertImplementationChoiceCopy(title: string, options: string[]) {
	assert.match(title, /Implement here keeps this planning conversation/i);
	assert.match(title, /Start fresh opens a new session that reads the same plan file/i);
	assert.deepEqual(
		options.filter((option) => IMPLEMENTATION_CHOICES.includes(option)),
		IMPLEMENTATION_CHOICES,
	);
	assert.ok(options.length <= 8);
}

test("ready menu presents both implementation contexts and cancels without acting", async () => {
	const context = createMockContext({ mode: "tui", hasUI: true });
	const owner = new AbortController();
	let actionCalls = 0;
	for (const cancel of ["tui.select.cancel", "\u0003"]) {
		const menuContext = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				for (const width of [24, 40, 80]) {
					const lines = harness.render(width);
					assert.ok(lines.every((line) => visibleWidth(line) <= width));
				}
				assert.match(harness.render().join("\n"), /Continue in this session/i);
				harness.handleInput("tui.select.down");
				assert.match(harness.render(40).join("\n"), /Open a new linked session/i);
				assert.match(harness.render(24).join("\n"), /Start fresh and implement/i);
				harness.handleInput(cancel);
				return harness.resultPromise;
			},
		});
		void context;
		await showReadyPlanMenu(menuContext.ctx, {
			signal: owner.signal,
			isCurrent: () => !owner.signal.aborted,
			planPathLine: "Plan file: /tmp/plans/session.md",
			getExportDestination: () => ({ configuredPath: "PLAN.md", resolvedPath: "/tmp/PLAN.md" }),
			implementHere: () => {
				actionCalls += 1;
			},
			implementFresh: () => {
				actionCalls += 1;
			},
			exportPlan: async () => {
				actionCalls += 1;
				return true;
			},
			stay: () => {
				actionCalls += 1;
			},
			exit: () => {
				actionCalls += 1;
			},
		});
		assert.equal(actionCalls, 0);
	}
});

test("automatic completion presents the ready menu without a model turn exactly once", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi, MISSING_SETTINGS);
		let menuCount = 0;
		const context = createMockContext({
			mode: "rpc",
			hasUI: true,
			select: async () => {
				menuCount += 1;
				return "Stay in Plan mode";
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		await completePlan(mock, context.ctx);
		await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);

		assert.deepEqual(mock.sentUserMessages, []);
		assert.equal(menuCount, 1);
		await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
		assert.equal(menuCount, 1);
		assert.equal(mock.sentUserMessages.length, 0);
	});
});

test("fresh selection fails closed when automatic readiness has no command context", async () => {
	await withAgentDir(async () => {
		const context = createMockContext({ mode: "rpc", hasUI: true });
		const state = {
			enabled: true,
			awaitingAction: true,
			planPath: planFilePathForSession("test-session"),
		};
		const result = await startFreshImplementationFromState(context.ctx, {
			getState: () => state,
			menuIsCurrent: () => true,
			stateEntryType: STATE_ENTRY_TYPE,
		});

		assert.equal(result.kind, "rejected");
		assert.match(context.notifications.at(-1)?.message ?? "", /reopen \/plan/i);
	});
});

test("fresh implementation links the destination to the same plan file", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi, MISSING_SETTINGS);
		const destinationEntries: Array<{ customType: string; data: unknown }> = [];
		const replacementMessages: string[] = [];
		let newSessionCalls = 0;
		let parentSession: string | undefined;
		const context = createMockContext({
			mode: "rpc",
			hasUI: true,
			model: { provider: "test-provider", id: "test-model" },
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
			sessionManager: {
				getSessionId: () => "test-session",
				getSessionFile: () => "/sessions/planning.jsonl",
				getBranch: () => [],
				getEntries: () => [],
			},
			select: async (_title: string, options: string[]) =>
				options.includes("Start fresh and implement") ? "Start fresh and implement" : undefined,
			newSession: async (options: {
				parentSession?: string;
				setup?: (sessionManager: {
					appendCustomEntry(customType: string, data: unknown): string;
				}) => Promise<void>;
				withSession?: (ctx: { sendUserMessage(message: string): Promise<void> }) => Promise<void>;
			}) => {
				newSessionCalls += 1;
				parentSession = options.parentSession;
				await options.setup?.({
					appendCustomEntry(customType, data) {
						destinationEntries.push({ customType, data });
						return "destination-state";
					},
				});
				await options.withSession?.({
					async sendUserMessage(message) {
						replacementMessages.push(message);
					},
				});
				return { cancelled: false };
			},
		});

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		await completePlan(mock, context.ctx);
		const sourceEntriesBefore = mock.entries.length;
		await mock.commands.get("plan")?.handler("", context.ctx);

		const planPath = planFilePathForSession("test-session");
		assert.equal(newSessionCalls, 1);
		assert.equal(parentSession, "/sessions/planning.jsonl");
		assert.equal(mock.entries.length, sourceEntriesBefore);
		assert.equal(mock.sentUserMessages.length, 0);
		assert.equal(destinationEntries.length, 1);
		const destinationState = destinationEntries[0]?.data as {
			enabled?: boolean;
			planPath?: string;
		};
		assert.equal(destinationState.enabled, false);
		// The destination points at the same file rather than copying the plan.
		assert.equal(destinationState.planPath, planPath);
		assert.equal(replacementMessages.length, 1);
		assert.ok(replacementMessages[0]?.includes(planPath));
		assert.ok(!replacementMessages[0]?.includes("Exclude the planning conversation"));
	});
});

test("fresh menu work stops after source session shutdown while waiting for idle", async () => {
	await withAgentDir(async () => {
		let releaseIdle!: () => void;
		let markWaiting!: () => void;
		const waiting = new Promise<void>((resolve) => {
			markWaiting = resolve;
		});
		const idleGate = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		let newSessionCalls = 0;
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi, MISSING_SETTINGS);
		const context = createMockContext({
			mode: "rpc",
			hasUI: true,
			model: { provider: "test-provider", id: "test-model" },
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
			select: async () => "Start fresh and implement",
			waitForIdle: async () => {
				markWaiting();
				await idleGate;
			},
			newSession: async () => {
				newSessionCalls += 1;
				return { cancelled: false };
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		await completePlan(mock, context.ctx);
		const pendingMenu = mock.commands.get("plan")?.handler("", context.ctx);
		await waiting;
		await mock.events.get("session_shutdown")?.[0]?.({ reason: "new" }, context.ctx);
		releaseIdle();
		await pendingMenu;

		assert.equal(newSessionCalls, 0);
		const persisted = mock.entries.at(-1)?.data as { planPath?: string };
		assert.equal(persisted.planPath, planFilePathForSession("test-session"));
	});
});

test("a fresh destination adopts its plan pointer on the first turn", async () => {
	await withAgentDir(async () => {
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi, MISSING_SETTINGS);
		const planPath = planFilePathForSession("test-session");
		const context = createMockContext({
			sessionManager: {
				getSessionId: () => "test-session",
				getSessionFile: () => "/sessions/implementation.jsonl",
				getBranch: () => entries,
				getEntries: () => entries,
			},
		});
		await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);
		assert.equal(context.statuses.get("plan-mode"), undefined);

		entries.push(stateEntry({ enabled: false, awaitingAction: false, planPath }));
		const result = (await mock.events.get("before_agent_start")?.[0]?.(
			{ prompt: formatImplementationHandoff(planPath), systemPrompt: "system" },
			context.ctx,
		)) as { systemPrompt?: string } | undefined;

		assert.equal(context.statuses.get("plan-mode"), "▶ plan · implementing");
		assert.ok(result?.systemPrompt?.includes(planPath));
		assert.deepEqual(mock.setActiveToolsCalls, []);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "edit"]);
	});
});

test("fresh replacement reports recoverable setup and kickoff failures as partial", async () => {
	for (const failure of ["setup", "kickoff"] as const) {
		let appendedState: unknown;
		let replacementMessage = "";
		const replacement = createMockContext({ mode: "rpc", hasUI: true });
		const source = createMockContext({
			mode: "rpc",
			hasUI: true,
			model: { provider: "test-provider", id: "test-model" },
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
			sessionManager: { getSessionFile: () => "/sessions/planning.jsonl" },
			newSession: async (options: {
				setup?: (sessionManager: {
					appendCustomEntry(customType: string, data: unknown): string;
				}) => Promise<void>;
				withSession?: (ctx: unknown) => Promise<void>;
			}) => {
				await options.setup?.({
					appendCustomEntry(_customType, data) {
						if (failure === "setup") throw new Error("disk\u001b[31m denied");
						appendedState = data;
						return "destination-state";
					},
				});
				await options.withSession?.({
					...(replacement.ctx as object),
					async sendUserMessage(message: string) {
						replacementMessage = message;
						if (failure === "kickoff") {
							throw new Error(`provider\u001b[31m rejected ${"x".repeat(2_000)} TAIL`);
						}
					},
				});
				return { cancelled: false };
			},
		});

		const planPath = "/tmp/plans/source-session.md";
		const result = await startFreshImplementationSession(source.ctx, {
			plan: PLAN,
			planPath,
			stateEntryType: STATE_ENTRY_TYPE,
			isCurrent: () => true,
		});

		assert.equal(result.kind, "partial");
		if (failure === "setup") {
			assert.equal(appendedState, undefined);
			assert.equal(replacementMessage, "");
			assert.equal(replacement.editorText, formatImplementationHandoff(planPath));
		} else {
			assert.ok(appendedState);
			assert.equal(replacementMessage, formatImplementationHandoff(planPath));
		}
		assert.match(
			replacement.notifications.at(-1)?.message ?? "",
			/resume the parent planning session/i,
		);
		const notification = replacement.notifications.at(-1)?.message ?? "";
		assert.equal(notification.includes("\u001b"), false);
		assert.ok(notification.length < 800);
		if (failure === "kickoff") assert.equal(notification.includes("TAIL"), false);
	}
});

test("fresh preflight and replacement cancellation preserve the source boundary", async () => {
	let newSessionCalls = 0;
	let current = true;
	const authFailure = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: { provider: "test-provider", id: "test-model" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false as const, error: "no auth" }) },
		sessionManager: { getSessionFile: () => "/sessions/planning.jsonl" },
		newSession: async () => {
			newSessionCalls += 1;
			return { cancelled: false };
		},
	});
	const request = {
		plan: PLAN,
		planPath: "/tmp/plans/source-session.md",
		stateEntryType: STATE_ENTRY_TYPE,
		isCurrent: () => current,
	};
	assert.equal((await startFreshImplementationSession(authFailure.ctx, request)).kind, "rejected");
	assert.equal(newSessionCalls, 0);

	const stale = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: { provider: "test-provider", id: "test-model" },
		waitForIdle: async () => {
			current = false;
		},
		newSession: async () => {
			newSessionCalls += 1;
			return { cancelled: false };
		},
	});
	current = true;
	assert.equal((await startFreshImplementationSession(stale.ctx, request)).kind, "stale");
	assert.equal(newSessionCalls, 0);

	const cancelled = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: { provider: "test-provider", id: "test-model" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
		sessionManager: { getSessionFile: () => "/sessions/planning.jsonl" },
		newSession: async () => {
			newSessionCalls += 1;
			return { cancelled: true };
		},
	});
	current = true;
	assert.equal((await startFreshImplementationSession(cancelled.ctx, request)).kind, "cancelled");
	assert.equal(newSessionCalls, 1);
	assert.match(cancelled.notifications.at(-1)?.message ?? "", /plan remains available/i);
});

test("ready RPC menu keeps both implementation choices understandable without descriptions", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi, MISSING_SETTINGS);
		let observedMenu: { title: string; options: string[] } | undefined;
		const context = createMockContext({
			mode: "rpc",
			hasUI: true,
			sessionManager: {
				getSessionId: () => "test-session",
				getSessionFile: () => "/sessions/planning.jsonl",
				getBranch: () => [],
				getEntries: () => [],
			},
			select: async (title: string, options: string[]) => {
				observedMenu = { title, options };
				return undefined;
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		await completePlan(mock, context.ctx);
		await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);

		assert.ok(observedMenu);
		assertImplementationChoiceCopy(observedMenu.title, observedMenu.options);
	});
});
