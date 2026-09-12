/**
 * The pi-plan-mode composition of the shared `ExtensionAPI` double, for the
 * revision lifecycle.
 *
 * What it adds over `test/support/mock-pi.ts`: a scratch agent dir so no test
 * writes into a real `~/.pi`, a session branch that grows as the extension
 * appends entries (Plan mode restores its own state through `getBranch()`, which
 * is what makes a restart testable), a deterministic clock and id source so plan
 * ids, revision ids and proposal ids are assertable, and a scriptable review card
 * so the decision a human would make is an input rather than a terminal to drive.
 *
 * The review card itself is covered separately, as pure screen builders and one
 * pass through the real menu runtime, so injecting the UI here hides nothing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMockContext, createMockPi } from "../../../../test/support/mock-pi.js";
import type { PlanRevisionOutcome, PlanRevisionSummary } from "../../src/plan-revision-menu.js";
import planMode from "../../src/plan-mode.js";

export interface RevisionHarnessOptions {
	mode?: "tui" | "print" | "json";
	hasUI?: boolean;
	/** What the human does with each review, in order. Defaults to dismissing. */
	reviews?: PlanRevisionOutcome[];
	/**
	 * Takes precedence over `reviews`, for the cases where *what happens while the
	 * card is open* is the thing under test: an interrupted turn, a session
	 * replacement, an answer that arrives too late.
	 */
	onReview?: (
		summary: PlanRevisionSummary,
		index: number,
	) => PlanRevisionOutcome | Promise<PlanRevisionOutcome>;
	/**
	 * Runs synchronously inside the controller's clock, which every mutation
	 * consults before it starts writing.
	 *
	 * The one deterministic way to make something happen *between* a controller's
	 * decision and its awaited writes. `propose` stamps its candidate, writes it to
	 * disk, and only then records the id in session state — so interrupting at the
	 * stamp is how the "candidate on disk, id never persisted" boundary is reached
	 * without a timer that would only reproduce it sometimes.
	 */
	onTimestamp?: (index: number) => void;
	activeTools?: string[];
	branch?: unknown[];
	/** Share another harness's agent dir, to model a second session on one plan. */
	agentDir?: string;
	sessionId?: string;
	idle?: boolean;
}

export interface RevisionHarness {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	agentDir: string;
	branch: unknown[];
	tools: Map<string, Record<string, unknown>>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => unknown }>;
	notifications: Array<{ message: string; level?: string }>;
	statuses: Map<string, string | undefined>;
	cards: Array<{ title: string; plan: string }>;
	sentUserMessages: Array<{ text: string; options?: unknown }>;
	setActiveToolsCalls: string[][];
	reviewRequests: PlanRevisionSummary[];
	reviewSignals: Array<AbortSignal | undefined>;
	readyMenuCalls: number;
	activeMenuCalls: Array<Record<string, unknown>>;
	planMenuCalls: Array<Record<string, unknown>>;
	/** How many times anything asked the session to wait for idle. Must stay 0. */
	waitForIdleCalls: number;
	/**
	 * Make `getBranch()` report a different set of entries, as Pi's tree navigation
	 * does when the user selects another leaf.
	 *
	 * The only way to model a branch switch: Plan mode restores its state — including
	 * the approval digest — from whatever branch is selected, and there is no other
	 * seam that changes which branch that is. Pass `undefined` to go back to the
	 * growing branch this session is writing.
	 */
	viewBranch(entries: readonly unknown[] | undefined): void;
	state(): Record<string, unknown> | undefined;
	emit(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
	systemPromptAddition(): Promise<string | undefined>;
	cleanup(): void;
}

export function createRevisionHarness(options: RevisionHarnessOptions = {}): RevisionHarness {
	const borrowed = options.agentDir;
	const agentDir = borrowed ?? mkdtempSync(join(tmpdir(), "pi-plan-revision-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const mock = createMockPi({ activeTools: options.activeTools ?? ["read", "edit"] });
	const branch: unknown[] = options.branch ? [...options.branch] : [];
	const tools = new Map<string, Record<string, unknown>>();
	const cards: Array<{ title: string; plan: string }> = [];
	const rawPi = mock.rawPi as unknown as {
		appendEntry: (customType: string, data: unknown) => void;
		registerTool: (tool: Record<string, unknown>) => void;
	};
	rawPi.appendEntry = (customType, data) => {
		branch.push({ type: "custom", customType, data });
		if (customType === "plan-mode-card") cards.push(data as { title: string; plan: string });
	};
	rawPi.registerTool = (tool) => {
		tools.set(String(tool.name), tool);
	};

	let waitForIdleCalls = 0;
	let branchView: readonly unknown[] | undefined;
	const visible = () => [...(branchView ?? branch)];
	const context = createMockContext({
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? (options.mode ?? "tui") === "tui",
		isIdle: () => options.idle ?? true,
		waitForIdle: async () => {
			waitForIdleCalls += 1;
		},
		sessionManager: {
			getSessionId: () => options.sessionId ?? "revision-test-session",
			getSessionName: () => undefined,
			getSessionFile: () => "/sessions/planning.jsonl",
			getBranch: visible,
			getEntries: visible,
			buildContextEntries: () => [],
		},
	});

	const reviewRequests: PlanRevisionSummary[] = [];
	const reviewSignals: Array<AbortSignal | undefined> = [];
	const activeMenuCalls: Array<Record<string, unknown>> = [];
	const planMenuCalls: Array<Record<string, unknown>> = [];
	let readyMenuCalls = 0;
	const reviews = [...(options.reviews ?? [])];

	let clock = 0;
	let nextId = 0;

	planMode(mock.pi, {
		readSettings: async () => ({ kind: "missing" as const }),
		now: () => {
			clock += 1;
			options.onTimestamp?.(clock - 1);
			return new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString();
		},
		newId: () => {
			nextId += 1;
			return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
		},
		loadInteractiveUi: async () => ({
			showPlanRevisionMenu: async (
				_ctx: unknown,
				menuOptions: { summary: PlanRevisionSummary; signal?: AbortSignal },
			) => {
				const index = reviewRequests.length;
				reviewRequests.push(menuOptions.summary);
				reviewSignals.push(menuOptions.signal);
				if (options.onReview) return options.onReview(menuOptions.summary, index);
				return reviews.shift() ?? { kind: "dismissed" as const };
			},
			showReadyPlanMenu: async () => {
				readyMenuCalls += 1;
			},
			showActiveImplementationMenu: async (_ctx: unknown, menuOptions: Record<string, unknown>) => {
				activeMenuCalls.push(menuOptions);
			},
			showPlanModeMenu: async (_ctx: unknown, menuOptions: Record<string, unknown>) => {
				planMenuCalls.push(menuOptions);
			},
			showPlanLaunchMenu: async () => undefined,
			showPlanModeSettings: async () => ({ kind: "closed" as const, reason: "close" as const }),
		}) as never,
	});

	const events = mock.events as unknown as Map<
		string,
		Array<(event: Record<string, unknown>, ctx: unknown) => unknown>
	>;

	return {
		pi: mock.pi as ExtensionAPI,
		ctx: context.ctx as ExtensionContext,
		agentDir,
		branch,
		tools,
		commands: mock.commands as never,
		notifications: context.notifications,
		statuses: context.statuses,
		cards,
		sentUserMessages: mock.sentUserMessages,
		setActiveToolsCalls: mock.setActiveToolsCalls,
		reviewRequests,
		reviewSignals,
		get readyMenuCalls() {
			return readyMenuCalls;
		},
		activeMenuCalls,
		planMenuCalls,
		get waitForIdleCalls() {
			return waitForIdleCalls;
		},
		viewBranch(entries) {
			branchView = entries ? [...entries] : undefined;
		},
		state() {
			for (let index = branch.length - 1; index >= 0; index -= 1) {
				const entry = branch[index] as { customType?: string; data?: unknown };
				if (entry?.customType === "plan-mode-state") {
					return entry.data as Record<string, unknown>;
				}
			}
			return undefined;
		},
		async emit(event, payload = {}) {
			const handlers = events.get(event) ?? [];
			const results: unknown[] = [];
			for (const handler of handlers) {
				results.push(await handler({ type: event, ...payload }, context.ctx));
			}
			return results;
		},
		async systemPromptAddition() {
			const handlers = events.get("before_agent_start") ?? [];
			for (const handler of handlers) {
				const result = (await handler({ systemPrompt: "BASE", prompt: "" }, context.ctx)) as
					| { systemPrompt?: string }
					| undefined;
				if (result?.systemPrompt) return result.systemPrompt.slice("BASE\n\n".length);
			}
			return undefined;
		},
		cleanup() {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (!borrowed) rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

/** A tool as the model calls it, through the registered definition. */
export async function callTool(
	harness: RevisionHarness,
	name: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`tool not registered: ${name}`);
	const execute = tool.execute as (
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ details?: unknown; isError?: boolean }>;
	const result = await execute("call-1", params, signal, undefined, harness.ctx);
	return {
		payload: (result.details ?? {}) as Record<string, unknown>,
		isError: result.isError === true,
	};
}

export function runPlanCommand(harness: RevisionHarness, args: string): Promise<void> {
	const command = harness.commands.get("plan");
	if (!command) throw new Error("/plan is not registered");
	return command.handler(args, harness.ctx) as Promise<void>;
}

export const FIRST_PLAN = `# Deploy the service

## Summary

Ship it behind a flag.

## Approach

1. Run the schema migration.
2. Deploy with blue/green.
3. Flip the flag.

## Verification

- \`npm test\` passes.`;

export const REVISED_PLAN = `# Deploy the service

## Summary

Ship it behind a flag.

## Approach

1. Run the schema migration.
2. Deploy with a rolling restart.
3. Flip the flag.

## Verification

- \`npm test\` passes.`;

/** Draft and submit a first plan, exactly as the model would. */
export async function draftPlan(harness: RevisionHarness, plan = FIRST_PLAN): Promise<void> {
	await harness.emit("session_start", { reason: "resume" });
	await runPlanCommand(harness, "start");
	const result = await callTool(harness, "plan_mode_complete", { plan });
	if (result.isError) throw new Error("plan_mode_complete failed");
}

/** Draft a plan and take it into implementation, which records the approval. */
export async function implementPlan(harness: RevisionHarness, plan = FIRST_PLAN): Promise<void> {
	await draftPlan(harness, plan);
	await runPlanCommand(harness, "implement");
}
