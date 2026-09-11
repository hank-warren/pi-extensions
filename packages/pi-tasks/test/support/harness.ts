/**
 * The pi-tasks composition of the shared `ExtensionAPI` double.
 *
 * What it adds over `test/support/mock-pi.ts`: a scratch tasks root so no test
 * ever writes into a real agent dir, a session branch that grows as the
 * extension appends entries (pi-tasks reads its own attachment back through
 * `getBranch()`), a deterministic clock and id source so revisions and task set
 * ids are assertable, and a scriptable review UI so the decision a human would
 * make is an input to the test rather than a terminal to drive.
 *
 * The menus themselves are covered separately, as pure screen builders and
 * through the real TUI harness, so injecting the UI here does not hide them.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMockContext, createMockPi } from "../../../../test/support/mock-pi.js";
import type { TasksController } from "../../src/controller.js";
import type { ReviewOutcome } from "../../src/task-menus.js";
import tasks from "../../src/tasks.js";

export interface ReviewRequest {
	reason: string;
	baseRevision: number;
	diff: readonly string[];
	proposedDocument: string;
}

export interface TasksHarnessOptions {
	mode?: "tui" | "print" | "json";
	/** What the human does with each review, in order. Defaults to dismissing. */
	reviews?: ReviewOutcome[];
	branch?: unknown[];
	idle?: boolean;
	/**
	 * Share another harness's store, to model a second Pi session on the same
	 * task set. The owner of the directory is the one that removes it.
	 */
	root?: string;
}

export interface TasksHarness {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	controller: TasksController;
	root: string;
	branch: unknown[];
	tools: Map<string, Record<string, unknown>>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => unknown }>;
	entryRenderers: Map<string, unknown>;
	notifications: Array<{ message: string; level?: string }>;
	cards: Array<{ title: string; body: string }>;
	sentMessages: Array<{ message: unknown; options?: unknown }>;
	reviewRequests: ReviewRequest[];
	tasksMenuCalls: unknown[];
	recoveryMenuCalls: unknown[];
	emit(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
	systemPromptAddition(): Promise<string | undefined>;
	cleanup(): void;
}

export function createTasksHarness(options: TasksHarnessOptions = {}): TasksHarness {
	const borrowedRoot = options.root;
	const root = borrowedRoot ?? mkdtempSync(join(tmpdir(), "pi-tasks-test-"));
	const mock = createMockPi({ activeTools: ["get_tasks", "update_tasks", "bash"] });
	const branch: unknown[] = options.branch ? [...options.branch] : [];
	const tools = new Map<string, Record<string, unknown>>();
	const cards: Array<{ title: string; body: string }> = [];

	const rawPi = mock.rawPi as unknown as {
		appendEntry: (customType: string, data: unknown) => void;
		registerTool: (tool: Record<string, unknown>) => void;
	};
	rawPi.appendEntry = (customType, data) => {
		branch.push({ type: "custom", customType, data });
		if (customType === "pi-tasks-card") cards.push(data as { title: string; body: string });
	};
	rawPi.registerTool = (tool) => {
		tools.set(String(tool.name), tool);
	};

	const context = createMockContext({
		mode: options.mode ?? "tui",
		sessionManager: {
			getSessionId: () => "tasks-test-session",
			getSessionName: () => undefined,
			getBranch: () => [...branch],
			getEntries: () => [...branch],
			buildContextEntries: () => [],
		},
		isIdle: () => options.idle ?? true,
		hasPendingMessages: () => false,
	});

	const reviewRequests: ReviewRequest[] = [];
	const tasksMenuCalls: unknown[] = [];
	const recoveryMenuCalls: unknown[] = [];
	const reviews = [...(options.reviews ?? [])];

	let clock = 0;
	let nextId = 0;

	const pi = mock.pi as ExtensionAPI;
	const ctx = context.ctx as ExtensionContext;
	const controller = tasks(pi, {
		root,
		now: () => {
			clock += 1;
			return new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString();
		},
		newTaskSetId: () => {
			nextId += 1;
			return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
		},
		loadInteractiveUi: async () => ({
			showTaskReviewMenu: async (_ctx: unknown, menuOptions: { summary: ReviewRequest }) => {
				reviewRequests.push(menuOptions.summary);
				return reviews.shift() ?? { kind: "dismissed" as const };
			},
			showTasksMenu: async (_ctx: unknown, menuOptions: unknown) => {
				tasksMenuCalls.push(menuOptions);
			},
			showRecoveryMenu: async (_ctx: unknown, menuOptions: unknown) => {
				recoveryMenuCalls.push(menuOptions);
			},
		}),
	}) as TasksController;

	const events = mock.events as unknown as Map<
		string,
		Array<(event: Record<string, unknown>, ctx: unknown) => unknown>
	>;

	return {
		pi,
		ctx,
		controller,
		root,
		branch,
		tools,
		commands: mock.commands as never,
		entryRenderers: mock.entryRenderers,
		notifications: context.notifications,
		cards,
		sentMessages: mock.sentMessages,
		reviewRequests,
		tasksMenuCalls,
		recoveryMenuCalls,
		async emit(event, payload = {}) {
			const handlers = events.get(event) ?? [];
			return Promise.all(handlers.map((handler) => handler({ type: event, ...payload }, ctx)));
		},
		async systemPromptAddition() {
			const handlers = events.get("before_agent_start") ?? [];
			for (const handler of handlers) {
				const result = (await handler({ systemPrompt: "BASE", prompt: "" }, ctx)) as
					| { systemPrompt?: string }
					| undefined;
				if (result?.systemPrompt) return result.systemPrompt.slice("BASE\n\n".length);
			}
			return undefined;
		},
		cleanup() {
			if (!borrowedRoot) rmSync(root, { recursive: true, force: true });
		},
	};
}

/** The tool as the model calls it, through the registered definition. */
export async function callTool(
	harness: TasksHarness,
	name: string,
	params: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`tool not registered: ${name}`);
	const prepare = tool.prepareArguments as ((args: unknown) => unknown) | undefined;
	const prepared = prepare ? prepare(params) : params;
	const execute = tool.execute as (
		id: string,
		params: unknown,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ details?: unknown; isError?: boolean }>;
	const result = await execute("call-1", prepared, undefined, undefined, harness.ctx);
	return {
		payload: (result.details ?? {}) as Record<string, unknown>,
		isError: result.isError === true,
	};
}

/** A three-phase set, as the model would create one. */
export const SEED_INIT = {
	op: "init",
	label: "migration",
	phases: [
		{ name: "Schema", tasks: ["add the revision column", "backfill the default"] },
		{ name: "Migration", tasks: ["copy the rows"] },
		{ name: "Cutover", tasks: ["flip the flag"] },
	],
};
