/**
 * The loop-shaped composition of the shared `ExtensionAPI` double.
 *
 * The double itself lives in `test/support/mock-pi.ts`; this file adds what only
 * pi-loop needs — a `LoopController` on a scratch agent dir, a session branch
 * that grows as the extension appends entries (pi-loop reads its own entries
 * back through `sessionManager.getBranch()`), and the flat recorder shapes its
 * assertions are written against.
 *
 * Every recorder below is a *stable* array or map, deliberately: a test that
 * spreads this harness (`{ ...harness, controller }`) would snapshot a getter
 * once and then assert against a frozen copy for the rest of the case.
 *
 * The engine tests keep their own richer harness: this one records instead of
 * simulating, so a test can assert what the extension *asked* Pi to do.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMockContext, createMockPi } from "../../../../test/support/mock-pi.js";
import { LoopController } from "../../src/loop.js";

type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;

export interface LoopHarnessOptions {
	branch?: unknown[];
	idle?: boolean;
	activeTools?: string[];
	/**
	 * The session mode. Defaults to `tui`; a router test uses `print` so the
	 * menus degrade to notifications instead of trying to paint a terminal.
	 */
	mode?: "tui" | "print" | "json";
}

export function createLoopHarness(options: LoopHarnessOptions = {}) {
	const mock = createMockPi({
		activeTools: options.activeTools ?? ["loop_complete", "loop_wait", "bash"],
	});
	const branch: unknown[] = options.branch ?? [];
	const tools = new Map<string, Record<string, unknown>>();
	const sentUserMessages: string[] = [];
	const sentMessages: Array<Record<string, unknown>> = [];
	const notifications: Array<{ message: string; type?: string }> = [];

	const rawPi = mock.rawPi as unknown as {
		appendEntry: (customType: string, data: unknown) => void;
		registerTool: (tool: Record<string, unknown>) => void;
		sendUserMessage: (text: string) => void;
		sendMessage: (message: Record<string, unknown>) => void;
	};
	rawPi.appendEntry = (customType, data) => {
		branch.push({ type: "custom", customType, data });
	};
	rawPi.registerTool = (tool) => {
		tools.set(String(tool.name), tool);
	};
	rawPi.sendUserMessage = (text) => {
		sentUserMessages.push(text);
	};
	rawPi.sendMessage = (message) => {
		sentMessages.push(message);
	};

	const flags = { idle: options.idle ?? true };
	const context = createMockContext({
		mode: options.mode ?? "tui",
		sessionManager: {
			getSessionId: () => "loop-test-session",
			getSessionName: () => undefined,
			getBranch: () => [...branch],
			getEntries: () => [...branch],
			buildContextEntries: () => [],
		},
		isIdle: () => flags.idle,
		hasPendingMessages: () => false,
		getContextUsage: () => undefined,
		compact: () => {},
	});
	const notifier = (context.ctx as unknown as { ui: { notify: (m: string, t?: string) => void } })
		.ui;
	const shared = notifier.notify.bind(notifier);
	notifier.notify = (message: string, type?: string) => {
		shared(message, type);
		notifications.push({ message, type });
	};

	const pi = mock.pi as ExtensionAPI;
	const ctx = context.ctx as ExtensionContext;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-loop-mock-"));
	const controller = new LoopController(pi, {
		settingsPath: join(agentDir, "pi-loop.json"),
		// Never write a ledger into the real agent dir from a test.
		agentDir,
	});
	controller.onSessionStart(ctx);

	return {
		pi,
		ctx,
		controller,
		/** The scratch agent dir: ledgers land here, never in the real one. */
		agentDir,
		events: mock.events as unknown as Map<string, Handler[]>,
		tools,
		commands: mock.commands,
		entryRenderers: mock.entryRenderers,
		branch,
		flags,
		sentUserMessages,
		sentMessages,
		notifications,
		emit: (event: string, payload: Record<string, unknown> = {}) =>
			mock.events.get(event)?.map((handler) => handler({ type: event, ...payload }, ctx)),
		cleanup: () => {
			controller.onSessionShutdown();
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}
