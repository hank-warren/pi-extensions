/**
 * The `tool_call` decision pipeline, driven through a mock `ExtensionAPI`.
 *
 * Every other test in this package covers one pure module. This one covers the
 * wiring in `index.ts`: which gate wins when several match, when the guardian
 * is called at all, what the agent is told, what lands on `pi.events` and in
 * the denial log, and which review-display states the user sees on the way.
 *
 * The guardian is scripted through `ctx.modelRegistry.runtime.completeSimple`
 * (the seam `guardian-transport.ts` resolves), the config lives in a temp file
 * named by `PI_AUTO_PERMISSIONS_CONFIG`, and approval prompts are answered by
 * driving the real `OptionSelector` the extension renders through
 * `ctx.ui.custom`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import autoPermissionsExtension from "../index.ts";
import { builtinTool, createCustomSelectorHarness, createMockContext, createMockPi } from "../../../test/support/mock-pi.ts";

type EventHandler = (...args: unknown[]) => unknown;

type BlockResult = { block: true; reason: string } | undefined;

interface DeniedEvent {
	tool: string;
	command: string;
	gate: string;
	group: string;
	verdict: "revise" | "block";
	reason: string;
	decisionSource: string;
}

interface DenialLine {
	tool: string;
	gate: { label: string; group: string };
	command: string;
	verdict: string;
	reason: string;
	decisionSource: string;
}

/** One dispatch through the guardian transport seam. */
interface GuardianCall {
	model: { provider: string; id: string };
	request: { systemPrompt: string; messages: Array<{ content: Array<{ text?: string }> }> };
	options: { sessionId: string; reasoning: string };
	/** The envelope text of the last user message — what the reviewer is asked about. */
	envelope: string;
}

type GuardianScript = (call: GuardianCall, index: number) => unknown;

/** One `ctx.ui.setWidget` call, decoded back into the state the user sees. */
interface Display {
	state: string;
	detail?: string;
}

// The pi-tui components the settings and approval dialogs render read the
// global theme rather than the one they are handed.
initTheme();

const PRELOAD_CONFIG_ENV = process.env.PI_AUTO_PERMISSIONS_CONFIG;

const GUARDIAN_MODEL = { provider: "guardian", id: "reviewer-1", api: "anthropic", contextWindow: 200_000 };

const GUARDED_RULE = {
	pattern: "^git push",
	level: "guarded",
	group: "git",
	label: "Git push",
};

function verdictText(decision: "approve" | "revise" | "ask_user", reason: string): string {
	return JSON.stringify({ decision, reason });
}

function assistantResponse(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 10, output: 4 },
		timestamp: Date.now(),
	};
}

/** Everything the widget renderer needs, with colour reduced to plain text. */
const PLAIN_THEME = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
};

function decodeDisplay(value: unknown): Display {
	if (value === undefined) return { state: "cleared", detail: undefined };
	assert.equal(typeof value, "function", "the review widget is registered as a factory");
	const component = (value as (tui: unknown, theme: unknown) => {
		render(width: number): string[];
		dispose?(): void;
	})({ requestRender() {}, terminal: { rows: 24 } }, PLAIN_THEME);
	const lines = component.render(200);
	component.dispose?.();
	const head = lines[0] ?? "";
	const summary = head.match(/· (\d+) commands ·/u);
	if (summary) {
		const count = (pattern: RegExp) => head.match(pattern)?.[1] ?? "0";
		return {
			state: "summary",
			detail: `waiting ${count(/[✶✸✻✽] (\d+) waiting for /u)} · queued ${count(/⋯ (\d+) queued/u)} · asking ${count(/\? (\d+) waiting for your approval/u)}`,
		};
	}
	const state = head.includes("⋯ queued behind another review")
		? "queued"
		: head.includes("? waiting for your approval")
			? "ask_user"
			: /[✶✸✻✽] waiting for /u.test(head)
				? "waiting"
				: head.includes("✓ approved")
					? "approved"
					: head.includes("↻ revision requested")
						? "revise"
						: head.includes("✗ blocked")
							? "blocked"
							: `unrecognized(${head})`;
	return { state, detail: lines[1] };
}

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const KEY_DOWN = "\u001b[B";
const KEY_ENTER = "\r";

/** The digit hotkey whose row carries `label`, so tests answer by option text. */
function digitForLabel(rendered: readonly string[], label: string): string {
	const pattern = new RegExp(`^\\s*(?:→\\s*)?(\\d)\\.\\s+${escapeForRegExp(label)}\\s*$`, "u");
	for (const line of rendered) {
		const match = line.match(pattern);
		if (match) return match[1];
	}
	assert.fail(`no option labelled "${label}" in:\n${rendered.join("\n")}`);
}

/**
 * Answer one `OptionSelector` prompt with the harness's next queued option
 * label, recording what it rendered. Shared with the tests that install their
 * own `custom` driver for a *different* dialog and still want the approval
 * prompt answered the usual way.
 */
function answerOptionSelector(factory: unknown, harness: Harness): unknown {
	const selector = createCustomSelectorHarness(factory, 100);
	const rendered = selector.render(100);
	harness.prompts.push(rendered);
	const answer = harness.answers.shift();
	selector.handleInput(answer === undefined ? "\u001b" : digitForLabel(rendered, answer));
	return selector.result;
}

/**
 * Build the `/auto-permissions` settings dialog the way Pi would, so a test can
 * drive the real `SettingsList` (which reads pi-tui's global keybindings, so
 * raw escape sequences reach it).
 */
function buildMenuComponent(
	factory: unknown,
	done: () => void,
): { render(width: number): string[]; handleInput(data: string): void } {
	return (factory as (...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void })(
		{ requestRender() {}, terminal: { rows: 24 } },
		PLAIN_THEME,
		{ matches: () => false, getKeys: () => [] },
		done,
	);
}

/** The settings rows `buildSettingItems` produces, in order. */
const MENU_ROW = {
	enabled: 0,
	reviewerModel: 1,
	thinkingLevel: 2,
	timeout: 3,
	systemPrompt: 4,
	recentDenials: 5,
} as const;

/** Resolve with the promise's value, or the sentinel while it is still pending. */
function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | "still pending"> {
	return Promise.race([
		promise,
		new Promise<"still pending">((resolve) => {
			const timer = setTimeout(() => resolve("still pending"), ms);
			timer.unref?.();
		}),
	]);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

interface SetupOptions {
	rules?: unknown[];
	/** Merged over the base config object before it is written. */
	config?: Record<string, unknown>;
	hasUI?: boolean;
	projectTrusted?: boolean;
	/** Lines written to `<cwd>/.pi/trusted-ops`. */
	trustedOps?: string[];
	signal?: AbortSignal;
	completeSimple?: GuardianScript;
	/** Replaces the OptionSelector driver, for prompts that are not selectors. */
	custom?: (factory: unknown, harness: Harness) => Promise<unknown>;
}

interface Harness {
	configPath: string;
	denialLogPath: string;
	mock: ReturnType<typeof createMockPi>;
	context: ReturnType<typeof createMockContext>;
	ctx: never;
	calls: GuardianCall[];
	denied: DeniedEvent[];
	displays: Display[];
	prompts: string[][];
	/** Option labels answered, in order; a missing answer cancels the prompt. */
	answers: string[];
	branch: unknown[];
	/** What `buildContextEntries` returns: the evidence the guardian is built from. */
	contextEntries: unknown[];
	customCalls: number;
	sessionStart(): Promise<void>;
	sessionShutdown(): Promise<void>;
	toolCall(command: string, toolCallId?: string, parentToolCallId?: string): Promise<BlockResult>;
	/** Deliver an assistant message to `message_end`, as Pi does before running its tool calls. */
	assistantMessage(calls: Array<{ id: string; command: string; name?: string }>): Promise<void>;
	turnEnd(): Promise<void>;
	/** Report a tool call finished, as Pi does when a codemode script ends. */
	toolExecutionEnd(toolCallId: string): Promise<void>;
	settingsCommand(args?: string): Promise<void>;
	denials(): DenialLine[];
	overrideEntries(): Array<{ seq: number; overrides: Array<Record<string, unknown>> }>;
}

async function withExtension(options: SetupOptions, run: (harness: Harness) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-ap-config-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-ap-cwd-"));
	const configPath = join(dir, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			reviewer: { provider: GUARDIAN_MODEL.provider, model: GUARDIAN_MODEL.id, timeoutMs: 30_000 },
			rules: options.rules ?? [],
			usageLog: { enabled: false },
			...options.config,
		}),
	);
	if (options.trustedOps) {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "trusted-ops"), `${options.trustedOps.join("\n")}\n`);
	}
	process.env.PI_AUTO_PERMISSIONS_CONFIG = configPath;

	const calls: GuardianCall[] = [];
	const denied: DeniedEvent[] = [];
	const displays: Display[] = [];
	const prompts: string[][] = [];
	const answers: string[] = [];
	const branch: unknown[] = [];
	const contextEntries: unknown[] = [];
	const script = options.completeSimple ?? (() => assistantResponse(verdictText("approve", "scripted")));

	const mock = createMockPi({ activeTools: ["bash"], allTools: [builtinTool("bash")] });
	const harness: Harness = {
		configPath,
		denialLogPath: join(dir, "denials.jsonl"),
		mock,
		context: undefined as never,
		calls,
		denied,
		displays,
		prompts,
		answers,
		branch,
		contextEntries,
		customCalls: 0,
		ctx: undefined as never,
		async sessionStart() {
			await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, harness.ctx);
		},
		async sessionShutdown() {
			await mock.events.get("session_shutdown")?.[0]?.({}, harness.ctx);
		},
		async toolCall(command: string, toolCallId = "call-1", parentToolCallId?: string) {
			const handler = mock.events.get("tool_call")?.[0] as EventHandler | undefined;
			assert.ok(handler, "the extension registers a tool_call handler");
			return (await handler(
				{ toolName: "bash", toolCallId, input: { command }, ...(parentToolCallId ? { parentToolCallId } : {}) },
				harness.ctx,
			)) as BlockResult;
		},
		async assistantMessage(calls) {
			const message = {
				role: "assistant",
				content: calls.map((call) => ({
					type: "toolCall",
					id: call.id,
					name: call.name ?? "bash",
					arguments: { command: call.command },
				})),
			};
			for (const handler of mock.events.get("message_end") ?? []) await handler({ type: "message_end", message }, harness.ctx);
		},
		async turnEnd() {
			for (const handler of mock.events.get("turn_end") ?? []) await handler({ type: "turn_end" }, harness.ctx);
		},
		async toolExecutionEnd(toolCallId: string) {
			for (const handler of mock.events.get("tool_execution_end") ?? []) {
				await handler({ type: "tool_execution_end", toolCallId, toolName: "codemode", isError: false }, harness.ctx);
			}
		},
		async settingsCommand(args = "") {
			const command = mock.commands.get("auto-permissions");
			assert.ok(command, "the extension registers /auto-permissions");
			await command.handler(args, harness.ctx);
		},
		denials() {
			if (!existsSync(harness.denialLogPath)) return [];
			return readFileSync(harness.denialLogPath, "utf8")
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line) as DenialLine);
		},
		overrideEntries() {
			return mock.entries
				.filter((entry) => entry.customType === "auto-permissions-overrides")
				.map((entry) => entry.data as { seq: number; overrides: Array<Record<string, unknown>> });
		},
	};

	const context = createMockContext({
		cwd,
		mode: "tui",
		hasUI: options.hasUI ?? true,
		models: [GUARDIAN_MODEL],
		providers: { [GUARDIAN_MODEL.provider]: { id: GUARDIAN_MODEL.provider } },
		isProjectTrusted: () => options.projectTrusted === true,
		...(options.signal ? { signal: options.signal } : {}),
		sessionManager: {
			getSessionId: () => "main-session",
			getSessionName: () => undefined,
			getBranch: () => branch,
			getEntries: () => branch,
			buildContextEntries: () => contextEntries,
		},
		completeSimple: (...args: unknown[]) => {
			const [model, request, callOptions] = args as [
				GuardianCall["model"],
				GuardianCall["request"],
				GuardianCall["options"],
			];
			const lastMessage = request.messages[request.messages.length - 1];
			const call: GuardianCall = {
				model,
				request,
				options: callOptions,
				envelope: lastMessage?.content?.map((part) => part.text ?? "").join("\n") ?? "",
			};
			calls.push(call);
			return script(call, calls.length - 1);
		},
		custom: async (factory: unknown) => {
			harness.customCalls += 1;
			if (options.custom) return options.custom(factory, harness);
			return answerOptionSelector(factory, harness);
		},
	});
	harness.context = context;
	harness.ctx = context.ctx;

	// Record the sequence of review-display states: the widget factory holds the
	// state in a closure, so it is decoded by rendering it here rather than kept
	// as a parallel copy that could drift from what the user sees.
	const ui = (context.ctx as unknown as {
		ui: { setWidget: (key: string, value: unknown, opts?: unknown) => void };
	}).ui;
	const setWidget = ui.setWidget.bind(ui);
	ui.setWidget = (key: string, value: unknown, opts?: unknown) => {
		displays.push(decodeDisplay(value));
		setWidget(key, value, opts);
	};

	mock.eventBus.on("auto-permissions:denied", (data) => denied.push(data as DeniedEvent));
	autoPermissionsExtension(mock.pi);

	try {
		await run(harness);
	} finally {
		await harness.sessionShutdown();
		if (PRELOAD_CONFIG_ENV === undefined) delete process.env.PI_AUTO_PERMISSIONS_CONFIG;
		else process.env.PI_AUTO_PERMISSIONS_CONFIG = PRELOAD_CONFIG_ENV;
		rmSync(dir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
}

test("1 · a command no rule matches runs without calling the reviewer", async () => {
	await withExtension({ rules: [GUARDED_RULE] }, async (harness) => {
		await harness.sessionStart();

		assert.equal(await harness.toolCall("echo hello"), undefined);
		assert.deepEqual(harness.calls, [], "no rule matched, so nothing was reviewed");
		assert.deepEqual(harness.denied, []);
		assert.deepEqual(harness.denials(), []);
		assert.deepEqual(harness.displays, []);
	});
});

test("2 · a deny rule wins over a guarded rule that matched earlier in config order", async () => {
	const rules = [
		{ pattern: "danger", level: "guarded", group: "first", label: "Guarded first" },
		{ pattern: "danger", level: "deny", group: "third", label: "Deny last", message: "Never run this." },
	];
	await withExtension({ rules }, async (harness) => {
		await harness.sessionStart();

		const result = await harness.toolCall("echo danger");
		assert.ok(result?.block);
		assert.match(result.reason, /^Blocked by policy: Deny last/u);
		assert.match(result.reason, /Never run this\./u);
		assert.match(result.reason, /This is a deny rule/u);
		assert.deepEqual(harness.calls, [], "a deny rule never reaches the guardian");
		assert.equal(harness.denied.length, 1);
		assert.equal(harness.denied[0].decisionSource, "deny");
		assert.equal(harness.denied[0].gate, "Deny last");
		assert.equal(harness.denied[0].verdict, "block");
		const denials = harness.denials();
		assert.equal(denials.length, 1);
		assert.equal(denials[0].decisionSource, "deny");
		assert.equal(denials[0].gate.label, "Deny last");
		assert.equal(denials[0].reason, "Never run this.");
	});
});

test("3 · a legacy convention rule blocks as deny without review, and trusted-ops cannot lift it", async () => {
	const rules = [{
		pattern: "^npm install",
		level: "convention",
		group: "npm",
		label: "Package install",
		message: "Use npm ci in this repository.",
	}];
	await withExtension({ rules, trustedOps: ["npm"], projectTrusted: true }, async (harness) => {
		await harness.sessionStart();

		const blocked = await harness.toolCall("npm install left-pad");
		assert.ok(blocked?.block);
		assert.match(blocked.reason, /^Blocked by policy: Package install/u);
		assert.match(blocked.reason, /This is a deny rule/u);
		assert.equal(harness.denied.length, 1);
		assert.equal(harness.denied[0].decisionSource, "deny");
		assert.deepEqual(harness.calls, [], "a legacy convention rule never reaches the guardian");
		assert.deepEqual(harness.mock.setActiveToolsCalls, []);
		assert.equal(harness.mock.tools.some((tool) => tool.name === "request_override"), false);
	});
});

test("4 · a guarded command the guardian approves runs, after exactly one review carrying the gate label", async () => {
	await withExtension(
		{
			rules: [GUARDED_RULE],
			completeSimple: () => assistantResponse(verdictText("approve", "the user asked for this push")),
		},
		async (harness) => {
			await harness.sessionStart();

			assert.equal(await harness.toolCall("git push origin main"), undefined);
			assert.equal(harness.calls.length, 1);
			assert.match(harness.calls[0].envelope, /"gate": "Git push"/u);
			assert.match(harness.calls[0].envelope, /"group": "git"/u);
			assert.match(harness.calls[0].envelope, /git push origin main/u);
			assert.deepEqual(harness.denied, []);
			assert.deepEqual(harness.denials(), []);
			assert.deepEqual(harness.displays, [
				{ state: "waiting", detail: undefined },
				{ state: "approved", detail: "the user asked for this push" },
			]);
		},
	);
});

test("5 · a revise verdict blocks with the reviewer's reason and a guardian decision source", async () => {
	await withExtension(
		{
			rules: [GUARDED_RULE],
			completeSimple: () => assistantResponse(verdictText("revise", "push to a branch, not main")),
		},
		async (harness) => {
			await harness.sessionStart();

			const result = await harness.toolCall("git push origin main");
			assert.ok(result?.block);
			assert.match(result.reason, /^Auto Permissions requested revision: push to a branch, not main/u);
			assert.match(result.reason, /Revise the command and try again\./u);
			assert.equal(harness.customCalls, 0, "a revise verdict never opens a prompt");
			assert.equal(harness.denied.length, 1);
			assert.equal(harness.denied[0].decisionSource, "guardian");
			assert.equal(harness.denied[0].verdict, "revise");
			assert.equal(harness.denied[0].reason, "push to a branch, not main");
			assert.equal(harness.denials()[0].decisionSource, "guardian");
			assert.deepEqual(harness.displays.map((display) => display.state), ["waiting", "revise"]);
		},
	);
});

test("6 · an ask_user verdict with no interactive user blocks and says so", async () => {
	await withExtension(
		{
			rules: [GUARDED_RULE],
			hasUI: false,
			completeSimple: () => assistantResponse(verdictText("ask_user", "force push rewrites history")),
		},
		async (harness) => {
			await harness.sessionStart();

			const result = await harness.toolCall("git push --force origin main");
			assert.ok(result?.block);
			assert.match(result.reason, /^Git push requires user approval: force push rewrites history/u);
			assert.match(result.reason, /This session has no interactive user to ask\./u);
			assert.equal(harness.customCalls, 0);
			assert.equal(harness.denied.length, 1);
			assert.equal(harness.denied[0].decisionSource, "guardian");
			assert.equal(harness.denied[0].verdict, "block");
			assert.equal(harness.denials()[0].reason, "force push rewrites history");
		},
	);
});

test("7 · an ask_user verdict prompts: Allow runs the command and records an override, Block stops it", async () => {
	await withExtension(
		{
			rules: [GUARDED_RULE],
			completeSimple: () => assistantResponse(verdictText("ask_user", "force push rewrites history")),
		},
		async (harness) => {
			await harness.sessionStart();

			harness.answers.push("Allow");
			assert.equal(await harness.toolCall("git push --force origin main", "call-1"), undefined);
			assert.equal(harness.customCalls, 1);
			assert.match(harness.prompts[0].join("\n"), /Git push — Auto Permissions needs approval/u);
			assert.match(harness.prompts[0].join("\n"), /force push rewrites history/u);
			assert.equal(harness.denied.length, 0, "an allowed command is not a denial");
			const afterAllow = harness.overrideEntries();
			assert.equal(afterAllow.length, 1);
			assert.deepEqual(
				afterAllow[0].overrides.map((override) => [override.command, override.choice]),
				[["git push --force origin main", "allow"]],
			);
			assert.deepEqual(harness.displays.map((display) => display.state), ["waiting", "ask_user", "approved"]);

			harness.answers.push("Block");
			const blocked = await harness.toolCall("git push --force origin release", "call-2");
			assert.deepEqual(blocked, { block: true, reason: "Blocked by user" });
			assert.equal(harness.denied.length, 1);
			assert.equal(harness.denied[0].decisionSource, "user");
			assert.equal(harness.denied[0].reason, "force push rewrites history");
			assert.equal(harness.denials()[0].decisionSource, "user");
			assert.equal(harness.overrideEntries().length, 2, "the block is recorded as override evidence too");
		},
	);
});

test("8 · reviewAllShell reviews an unmatched command under the generic gate, unless the project trusts that group", async () => {
	await withExtension(
		{
			rules: [GUARDED_RULE],
			config: { reviewAllShell: true },
			completeSimple: () => assistantResponse(verdictText("approve", "harmless")),
		},
		async (harness) => {
			await harness.sessionStart();

			assert.equal(await harness.toolCall("echo hello"), undefined);
			assert.equal(harness.calls.length, 1);
			assert.match(harness.calls[0].envelope, /"gate": "shell command"/u);
			assert.match(harness.calls[0].envelope, /"group": "all-shell"/u);
		},
	);

	await withExtension(
		{
			rules: [GUARDED_RULE],
			config: { reviewAllShell: true },
			projectTrusted: true,
			trustedOps: ["all-shell"],
			completeSimple: () => assistantResponse(verdictText("approve", "harmless")),
		},
		async (harness) => {
			await harness.sessionStart();

			assert.equal(await harness.toolCall("echo hello"), undefined);
			assert.deepEqual(harness.calls, [], "a trusted all-shell group is not re-captured by the blanket gate");
			assert.deepEqual(harness.displays, []);
		},
	);
});

test("10 · a reviewer that throws asks the user", async () => {
	await withExtension(
		{
			rules: [GUARDED_RULE],
			completeSimple: () => {
				throw new Error("reviewer offline");
			},
		},
		async (harness) => {
			await harness.sessionStart();

			harness.answers.push("Block");
			const result = await harness.toolCall("git push origin main");
			assert.deepEqual(result, { block: true, reason: "Blocked by user" });
			assert.equal(harness.customCalls, 1);
			assert.match(harness.prompts[0].join("\n"), /Automatic review failed: reviewer offline/u);
			assert.equal(harness.denied.length, 1);
			assert.equal(harness.denied[0].decisionSource, "review_failure");
			assert.match(harness.denied[0].reason, /^Automatic review failed: reviewer offline/u);
			assert.equal(harness.denials()[0].decisionSource, "review_failure");
			assert.deepEqual(harness.displays.map((display) => display.state), ["waiting", "ask_user", "blocked"]);
		},
	);
});

test("11 · a turn aborted while the reviewer is answering is cancelled, not denied", async () => {
	const controller = new AbortController();
	await withExtension(
		{
			rules: [GUARDED_RULE],
			signal: controller.signal,
			// The verdict arrives, but the turn was abandoned while it was in
			// flight: the post-await cancellation check must discard it.
			completeSimple: () => {
				controller.abort();
				return assistantResponse(verdictText("approve", "too late"));
			},
		},
		async (harness) => {
			await harness.sessionStart();

			const result = await harness.toolCall("git push origin main");
			assert.deepEqual(result, { block: true, reason: "Auto Permissions review cancelled" });
			assert.equal(harness.calls.length, 1);
			assert.deepEqual(harness.denied, [], "a cancelled review is not a denial");
			assert.deepEqual(harness.denials(), []);
			assert.equal(existsSync(harness.denialLogPath), false);
			assert.deepEqual(harness.displays.map((display) => display.state), ["waiting", "cleared"]);
		},
	);
});

test("12 · with reviewConcurrency 1, a second guarded command waits queued and is reviewed after the first", async () => {
	let releaseFirst: (() => void) | undefined;
	let firstCalled: (() => void) | undefined;
	const firstReached = new Promise<void>((resolve) => {
		firstCalled = resolve;
	});
	await withExtension(
		{
			rules: [GUARDED_RULE],
			config: { reviewConcurrency: 1 },
			completeSimple: (_call, index) => {
				const response = assistantResponse(verdictText("approve", `ok ${index}`));
				if (index > 0) return response;
				return new Promise((resolve) => {
					releaseFirst = () => resolve(response);
					firstCalled?.();
				});
			},
		},
		async (harness) => {
			await harness.sessionStart();

			const first = harness.toolCall("git push origin main", "call-1");
			await firstReached;
			const second = harness.toolCall("git push origin dev", "call-2");
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(harness.calls.length, 1, "the second review waits for the only slot");
			assert.deepEqual(harness.displays, [
				{ state: "waiting", detail: undefined },
				{ state: "summary", detail: "waiting 1 · queued 1 · asking 0" },
			]);
			releaseFirst?.();

			assert.equal(await first, undefined);
			assert.equal(await second, undefined);
			assert.equal(harness.calls.length, 2, "the limiter serializes the reviews, it does not drop one");
			assert.deepEqual(harness.displays.at(-1), { state: "approved", detail: "ok 1" });
		},
	);
});

test("13 · a legacy reviewer.prefilter key is ignored", async () => {
	await withExtension(
		{
			rules: [GUARDED_RULE],
			config: {
				reviewer: {
					provider: GUARDIAN_MODEL.provider,
					model: GUARDIAN_MODEL.id,
					timeoutMs: 30_000,
					prefilter: true,
				},
			},
			completeSimple: () => assistantResponse(verdictText("approve", "reviewed in full")),
		},
		async (harness) => {
			await harness.sessionStart();

			assert.equal(await harness.toolCall("git push origin main"), undefined);
			assert.equal(harness.calls.length, 1, "exactly one full review, no prefilter pass");
			assert.doesNotMatch(harness.calls[0].envelope, /PREFILTER MODE/u);
			assert.equal(harness.calls[0].options.reasoning, "low");
		},
	);
});

test("14 · session_shutdown then session_start discards the lineage and restores the session's decisions", async () => {
	await withExtension(
		{
			rules: [GUARDED_RULE],
			completeSimple: () => assistantResponse(verdictText("approve", "fine")),
		},
		async (harness) => {
			await harness.sessionStart();

			assert.equal(await harness.toolCall("git push origin main", "call-1"), undefined);
			assert.equal(await harness.toolCall("git push origin dev", "call-2"), undefined);
			const lineageSessionId = harness.calls[0].options.sessionId;
			assert.equal(
				harness.calls[1].options.sessionId,
				lineageSessionId,
				"a second review inside one session continues the same reviewer conversation",
			);

			await harness.sessionShutdown();
			harness.branch.push({
				type: "custom",
				customType: "auto-permissions-overrides",
				data: {
					seq: 4,
					overrides: [
						{
							seq: 3,
							gateLabel: "Git push",
							command: "git push --force origin main",
							reviewerReason: "force push rewrites history",
							choice: "allow",
						},
					],
				},
			});
			await harness.sessionStart();

			assert.equal(await harness.toolCall("git push origin main", "call-3"), undefined);
			assert.notEqual(
				harness.calls[2].options.sessionId,
				lineageSessionId,
				"the reviewer lineage does not survive a session boundary",
			);
			assert.match(
				harness.calls[2].envelope,
				/USER \(permission override\): allowed gated command \\"git push --force origin main\\"/u,
			);
			assert.deepEqual(harness.denied, []);
		},
	);
});

/**
 * Stage A2: the surface the cases above do not reach — the
 * `/auto-permissions` command.
 */

const SETUP_HANDOFF = "Use the auto-permissions-setup skill to set up my Auto Permissions policy.";

test("17 · /auto-permissions refuses to open over an invalid config, opens over a valid one, and hands setup to the skill", async () => {
	await withExtension({ rules: [GUARDED_RULE] }, async (harness) => {
		await harness.sessionStart();
		writeFileSync(harness.configPath, "{ not json");

		await harness.settingsCommand();
		assert.equal(harness.customCalls, 0, "a config we cannot validate is never opened for editing");
		const notification = harness.context.notifications.at(-1);
		assert.equal(notification?.level, "warning");
		assert.match(notification?.message ?? "", /^Auto Permissions config error: /u);
		assert.match(notification?.message ?? "", /\u2014 fix .*config\.json first$/u);
	});

	await withExtension(
		{
			rules: [GUARDED_RULE],
			custom: async (factory) => {
				// Build the menu the way Pi would, then close it immediately.
				(factory as (...args: unknown[]) => unknown)(
					{ requestRender() {}, terminal: { rows: 24 } },
					PLAIN_THEME,
					{ matches: () => false, getKeys: () => [] },
					() => {},
				);
				return undefined;
			},
		},
		async (harness) => {
			await harness.sessionStart();
			const before = readFileSync(harness.configPath, "utf8");

			await harness.settingsCommand();
			assert.equal(harness.customCalls, 1);
			assert.deepEqual(harness.context.notifications, []);
			assert.equal(readFileSync(harness.configPath, "utf8"), before, "opening the menu writes nothing");
		},
	);

	await withExtension({ rules: [GUARDED_RULE] }, async (harness) => {
		await harness.sessionStart();

		await harness.settingsCommand("setup");
		assert.equal(harness.customCalls, 0);
		assert.deepEqual(
			harness.mock.sentUserMessages.map((sent) => sent.text),
			[SETUP_HANDOFF],
		);
	});
});

test("18 · allow on retry closes the settings dialog before it dispatches the retry", async () => {
	const timeline: string[] = [];
	let settingsPhase = false;
	await withExtension(
		{
			rules: [GUARDED_RULE],
			completeSimple: () => assistantResponse(verdictText("ask_user", "force push rewrites history")),
			custom: async (factory, harness) => {
				if (!settingsPhase) {
					timeline.push("approval prompt");
					return answerOptionSelector(factory, harness);
				}
				settingsPhase = false;
				const menu = buildMenuComponent(factory, () => timeline.push("settings dialog closed"));
				for (let row = 0; row < MENU_ROW.recentDenials; row += 1) menu.handleInput(KEY_DOWN);
				menu.handleInput(KEY_ENTER);
				assert.match(menu.render(100).join("\n"), /Recent denials/u);
				menu.handleInput(KEY_ENTER);
				assert.match(menu.render(100).join("\n"), /Allow on retry\?/u);
				menu.handleInput(KEY_ENTER);
				return undefined;
			},
		},
		async (harness) => {
			await harness.sessionStart();

			// A denial to allow on retry, produced the way the canary produced it:
			// a guarded command the user blocked at the prompt.
			harness.answers.push("Block");
			assert.deepEqual(await harness.toolCall("git push --force origin main", "call-1"), {
				block: true,
				reason: "Blocked by user",
			});
			assert.equal(harness.denials().length, 1);

			// Only the retry sequence is being ordered, so start the log here.
			timeline.length = 0;
			const rawPi = harness.mock.rawPi;
			const sendUserMessage = rawPi.sendUserMessage.bind(rawPi);
			rawPi.sendUserMessage = (text: string, messageOptions?: unknown) => {
				timeline.push("retry message");
				sendUserMessage(text, messageOptions);
			};

			settingsPhase = true;
			harness.answers.push("Allow");
			await harness.settingsCommand();
			assert.deepEqual(
				harness.overrideEntries().at(-1)?.overrides.map((override) => [override.command, override.choice]),
				[
					["git push --force origin main", "block"],
					["git push --force origin main", "allow"],
				],
				"the retry override is recorded alongside the block it overrides",
			);

			await harness.toolCall("git push --force origin main", "call-2");

			assert.deepEqual(
				timeline,
				["settings dialog closed", "retry message", "approval prompt"],
				"the retry must not be dispatched into a session that still has the settings dialog open",
			);
			assert.equal(
				harness.customCalls,
				3,
				"the block prompt, the settings dialog and the retry prompt — never two dialogs at once",
			);
			assert.deepEqual(
				harness.mock.sentUserMessages.map((sent) => sent.text),
				[
					"Auto Permissions: I reviewed the denied command in /auto-permissions and allowed it on retry:\n\n  git push --force origin main\n\nYou may run this exact command again; a session override now authorizes it.",
				],
			);
			assert.equal(
				harness.context.notifications.at(-1)?.message,
				"Override added for the exact command; the agent may retry it.",
			);
		},
	);
});

test("19 · aborting the lifecycle or the turn releases a command waiting in the review queue", async () => {
	for (const abortWith of ["lifecycle", "turn"] as const) {
		const controller = new AbortController();
		let releaseFirst: (() => void) | undefined;
		let firstCalled: (() => void) | undefined;
		const firstReached = new Promise<void>((resolve) => {
			firstCalled = resolve;
		});
		await withExtension(
			{
				rules: [GUARDED_RULE],
				config: { reviewConcurrency: 1 },
				signal: controller.signal,
				completeSimple: (_call, index) => {
					const response = assistantResponse(verdictText("approve", "fine"));
					if (index > 0) return response;
					return new Promise((resolve) => {
						releaseFirst = () => resolve(response);
						firstCalled?.();
					});
				},
			},
			async (harness) => {
				await harness.sessionStart();

				const first = harness.toolCall("git push origin main", "call-1");
				await firstReached;
				const second = harness.toolCall("git push origin dev", "call-2");

				if (abortWith === "lifecycle") await harness.sessionShutdown();
				else controller.abort();

				assert.deepEqual(
					await settledWithin(second, 250),
					{ block: true, reason: "Auto Permissions review cancelled" },
					`the ${abortWith} signal must release the queued command instead of stranding it`,
				);
				assert.equal(harness.calls.length, 1, "a released queue waiter never reaches the guardian");
				assert.deepEqual(harness.denied, [], "a cancelled review is not a denial");
				assert.deepEqual(harness.denials(), []);

				releaseFirst?.();
				assert.deepEqual(await first, { block: true, reason: "Auto Permissions review cancelled" });
			},
		);
	}
});

test("20 · aborting the lifecycle or the turn releases an open approval prompt", async () => {
	for (const abortWith of ["lifecycle", "turn"] as const) {
		const controller = new AbortController();
		let promptReleased = false;
		await withExtension(
			{
				rules: [GUARDED_RULE],
				// Present but never aborted in the lifecycle case, so `promptSignal`
				// is a composite in both and each run pins one of its members.
				signal: controller.signal,
				completeSimple: () => assistantResponse(verdictText("ask_user", "force push rewrites history")),
				custom: async (factory, harness) => {
					const selector = createCustomSelectorHarness(factory, 100);
					void selector.resultPromise.then(() => {
						promptReleased = true;
					});
					if (abortWith === "lifecycle") await harness.sessionShutdown();
					else controller.abort();
					await Promise.resolve();
					return selector.result;
				},
			},
			async (harness) => {
				await harness.sessionStart();

				const result = await harness.toolCall("git push --force origin main");
				assert.ok(
					promptReleased,
					`the ${abortWith} signal must release the approval prompt instead of leaving the turn hung`,
				);
				assert.deepEqual(result, { block: true, reason: "Auto Permissions review cancelled" });
				assert.deepEqual(harness.denied, [], "an abandoned prompt is not a user block");
				assert.deepEqual(harness.denials(), []);
				if (abortWith === "turn") {
					assert.equal(harness.displays.at(-1)?.state, "cleared", "the widget goes with the cancelled turn");
				}
			},
		);
	}
});

test("21 · the review widget clears itself after ui.resultDisplayMs, and a shutdown cancels that timer", async () => {
	await withExtension(
		{
			rules: [GUARDED_RULE],
			config: { ui: { resultDisplayMs: 60 } },
			completeSimple: () => assistantResponse(verdictText("approve", "fine")),
		},
		async (harness) => {
			await harness.sessionStart();

			assert.equal(await harness.toolCall("git push origin main"), undefined);
			assert.deepEqual(
				harness.displays.map((display) => display.state),
				["waiting", "approved"],
				"settling shows the result; the clear is the timer's job",
			);

			await waitFor(() => harness.displays.at(-1)?.state === "cleared");
			assert.deepEqual(harness.displays.map((display) => display.state), ["waiting", "approved", "cleared"]);
		},
	);

	await withExtension(
		{
			rules: [GUARDED_RULE],
			config: { ui: { resultDisplayMs: 60 } },
			completeSimple: () => assistantResponse(verdictText("approve", "fine")),
		},
		async (harness) => {
			await harness.sessionStart();

			assert.equal(await harness.toolCall("git push origin main"), undefined);
			await harness.sessionShutdown();
			assert.deepEqual(harness.displays.map((display) => display.state), ["waiting", "approved", "cleared"]);

			await new Promise((resolve) => setTimeout(resolve, 200));
			assert.deepEqual(
				harness.displays.map((display) => display.state),
				["waiting", "approved", "cleared"],
				"the pending auto-clear went with the session; nothing writes the widget afterwards",
			);
		},
	);
});

test("22 · the settings menu reverts a failed save", async () => {
	await withExtension(
		{
			rules: [GUARDED_RULE],
			custom: async (factory, harness) => {
				const pristine = readFileSync(harness.configPath, "utf8");
				const menu = buildMenuComponent(factory, () => {});
				// The file becomes unparsable underneath the open menu, so the
				// writer refuses rather than clobbering it.
				writeFileSync(harness.configPath, "{ not json");
				menu.handleInput(KEY_ENTER); // Enabled: on -> off, save fails
				writeFileSync(harness.configPath, pristine);
				for (let row = MENU_ROW.enabled; row < MENU_ROW.thinkingLevel; row += 1) menu.handleInput(KEY_DOWN);
				menu.handleInput(KEY_ENTER); // Thinking level: low -> medium, save succeeds
				return undefined;
			},
		},
		async (harness) => {
			await harness.sessionStart();
			await harness.settingsCommand();

			const warning = harness.context.notifications.find((notification) =>
				notification.message.startsWith("Could not save Auto Permissions settings:"),
			);
			assert.equal(warning?.level, "warning");

			const saved = JSON.parse(readFileSync(harness.configPath, "utf8"));
			assert.equal(saved.reviewer.reasoningEffort, "medium", "the second edit was saved");
			assert.equal(
				saved.enabled,
				undefined,
				"the failed edit was reverted: a still-disabled `settings` would have written enabled: false",
			);
		},
	);
});

/**
 * Parallel reviews: guardian calls overlap up to `reviewConcurrency`, while
 * verdicts are applied, and the user asked, one command at a time.
 */

/** The action under review, without the evidence that may quote other commands. */
function proposedAction(call: GuardianCall): string {
	return call.envelope.split("<LATEST_PROPOSED_ACTION>")[1] ?? "";
}

test("23 · guarded commands pending together are reviewed at once, and the next review continues the lineage one of them committed", async () => {
	const releases: Array<() => void> = [];
	let secondReached: (() => void) | undefined;
	const bothInFlight = new Promise<void>((resolve) => {
		secondReached = resolve;
	});
	await withExtension(
		{
			rules: [GUARDED_RULE],
			completeSimple: (_call, index) => {
				const response = assistantResponse(verdictText("approve", `ok ${index}`));
				if (index >= 2) return response;
				if (index === 1) secondReached?.();
				return new Promise((resolve) => releases.push(() => resolve(response)));
			},
		},
		async (harness) => {
			await harness.sessionStart();

			const first = harness.toolCall("git push origin main", "call-1");
			const second = harness.toolCall("git push origin dev", "call-2");
			assert.notEqual(await settledWithin(bothInFlight, 1000), "still pending", "the second review does not wait for the first");
			assert.deepEqual(harness.displays.at(-1), { state: "summary", detail: "waiting 2 · queued 0 · asking 0" });
			for (const release of releases) release();

			assert.equal(await first, undefined);
			assert.equal(await second, undefined);
			assert.equal(await harness.toolCall("git push origin feature", "call-3"), undefined);
			assert.equal(harness.calls.length, 3);
			assert.ok(
				[harness.calls[0].options.sessionId, harness.calls[1].options.sessionId].includes(harness.calls[2].options.sessionId),
				"exactly one of the concurrent reviews extended the lineage, and the next review built on it",
			);
			assert.match(harness.calls[2].envelope, /<EVIDENCE mode="delta">/u);
		},
	);
});

test("24 · bash calls a codemode script makes are gated like model-issued ones", async () => {
	const rules = [
		GUARDED_RULE,
		{ pattern: "^rm -rf /", level: "deny", group: "delete", label: "Root delete", message: "Never." },
	];
	await withExtension(
		{ rules, completeSimple: () => assistantResponse(verdictText("approve", "scripted")) },
		async (harness) => {
			await harness.sessionStart();

			const denied = await harness.toolCall("rm -rf /", "code-1/1", "code-1");
			assert.ok(denied?.block);
			assert.match(denied.reason, /^Blocked by policy: Root delete/u);
			assert.equal(harness.calls.length, 0);

			assert.equal(await harness.toolCall("git push origin main", "code-1/2", "code-1"), undefined);
			assert.equal(harness.calls.length, 1);
			assert.match(proposedAction(harness.calls[0]), /git push origin main/u);
		},
	);
});

test("25 · a verdict that waited behind another command's prompt is reviewed again with the user's answer", async () => {
	let releaseSecond: (() => void) | undefined;
	let openPrompts = 0;
	let maxOpenPrompts = 0;
	await withExtension(
		{
			rules: [GUARDED_RULE],
			completeSimple: (call, index) => {
				if (proposedAction(call).includes("--force")) {
					return assistantResponse(verdictText("ask_user", "force push rewrites history"));
				}
				const response = assistantResponse(verdictText("approve", `ok ${index}`));
				if (index !== 1) return response;
				return new Promise((resolve) => {
					releaseSecond = () => resolve(response);
				});
			},
			custom: async (factory, harness) => {
				openPrompts += 1;
				maxOpenPrompts = Math.max(maxOpenPrompts, openPrompts);
				releaseSecond?.();
				// Answer only once the second verdict is waiting for the decision slot.
				await waitFor(() =>
					harness.displays.some((display) => display.detail === "waiting 0 · queued 1 · asking 1"));
				const result = answerOptionSelector(factory, harness);
				openPrompts -= 1;
				return result;
			},
		},
		async (harness) => {
			await harness.sessionStart();

			harness.answers.push("Block");
			const forced = harness.toolCall("git push --force origin main", "call-1");
			const plain = harness.toolCall("git push origin dev", "call-2");

			assert.deepEqual(await forced, { block: true, reason: "Blocked by user" });
			assert.equal(await plain, undefined);
			assert.equal(maxOpenPrompts, 1, "never two approval prompts at once");
			assert.equal(harness.calls.length, 3, "the stale approval was reviewed again");
			assert.match(proposedAction(harness.calls[2]), /git push origin dev/u);
			assert.match(harness.calls[2].envelope, /USER \(permission override\)/u);
		},
	);
});

test("25b · a verdict still stale after its reviews is reviewed a last time holding the decision slot, so no prompt is answered meanwhile", async () => {
	let harnessRef: Harness | undefined;
	const releaseDev: Array<() => void> = [];
	const forced: Array<Promise<BlockResult>> = [];
	let devReviews = 0;
	let openPrompts = 0;
	let maxOpenPrompts = 0;
	await withExtension(
		{
			rules: [GUARDED_RULE],
			completeSimple: (call) => {
				const action = proposedAction(call);
				if (action.includes("--force")) return assistantResponse(verdictText("ask_user", "force push rewrites history"));
				if (!action.includes("origin dev")) return assistantResponse(verdictText("approve", "seed"));
				devReviews += 1;
				const n = devReviews;
				// Each later review of `dev` brings another command whose prompt competes for the slot.
				if (n === 2) forced.push(harnessRef!.toolCall("git push --force origin two", "call-two"));
				if (n === 3) forced.push(harnessRef!.toolCall("git push --force origin three", "call-three"));
				return new Promise((resolve) => releaseDev.push(() => resolve(assistantResponse(verdictText("approve", `dev ok ${n}`)))));
			},
			custom: async (factory, harness) => {
				openPrompts += 1;
				maxOpenPrompts = Math.max(maxOpenPrompts, openPrompts);
				const prompt = harness.prompts.length + 1;
				if (prompt === 1) {
					// Let dev's first verdict arrive and queue behind this prompt, so the answer makes it stale.
					await waitFor(() => releaseDev.length === 1);
					releaseDev[0]();
					await waitFor(() =>
						harness.displays.some((display) => display.detail === "waiting 0 · queued 1 · asking 1"));
				}
				const result = answerOptionSelector(factory, harness);
				// Dev's second review ran while this prompt was open, so this answer makes it stale too.
				if (prompt === 2) releaseDev[1]();
				openPrompts -= 1;
				return result;
			},
		},
		async (harness) => {
			harnessRef = harness;
			await harness.sessionStart();
			assert.equal(await harness.toolCall("git push origin seed", "call-seed"), undefined);

			harness.answers.push("Block", "Block", "Block");
			forced.push(harness.toolCall("git push --force origin one", "call-one"));
			const dev = harness.toolCall("git push origin dev", "call-dev");

			await waitFor(() => devReviews === 3);
			assert.equal(devReviews, 3, "dev was reviewed a third time");
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(harness.prompts.length, 2, "no prompt opens while dev's last review holds the decision slot");
			releaseDev[2]();

			assert.equal(await dev, undefined);
			for (const result of await Promise.all(forced)) assert.deepEqual(result, { block: true, reason: "Blocked by user" });
			assert.equal(harness.prompts.length, 3);
			assert.equal(maxOpenPrompts, 1, "never two approval prompts at once");
			assert.equal(devReviews, 3, "the last review is applied without a fourth");
		},
	);
});

test("26 · later bash calls in one assistant message are reviewed while Pi is still on the first", async () => {
	let allReached: (() => void) | undefined;
	const threeInFlight = new Promise<void>((resolve) => {
		allReached = resolve;
	});
	await withExtension(
		{
			rules: [GUARDED_RULE],
			completeSimple: (_call, index) => {
				const response = assistantResponse(verdictText("approve", `ok ${index}`));
				if (index >= 3) return response;
				if (index === 2) allReached?.();
				return threeInFlight.then(() => response);
			},
		},
		async (harness) => {
			await harness.sessionStart();

			await harness.assistantMessage([
				{ id: "call-1", command: "git push origin a" },
				{ id: "call-2", command: "echo not guarded" },
				{ id: "call-3", command: "git push origin b" },
				{ id: "call-4", command: "git push origin c" },
			]);
			const first = harness.toolCall("git push origin a", "call-1");
			assert.equal(
				await settledWithin(first, 1000),
				undefined,
				"the first call's review completes only because its siblings' reviews started alongside it",
			);
			assert.equal(harness.calls.length, 3, "the unguarded sibling is not reviewed");

			assert.equal(await harness.toolCall("echo not guarded", "call-2"), undefined);
			assert.equal(await harness.toolCall("git push origin b", "call-3"), undefined);
			assert.equal(harness.calls.length, 3, "call-3 took the review started early");

			// Changed by another handler before it reached this one: reviewed afresh.
			assert.equal(await harness.toolCall("git push origin c --tags", "call-4"), undefined);
			assert.equal(harness.calls.length, 4);
			assert.match(proposedAction(harness.calls[3]), /git push origin c --tags/u);
			assert.deepEqual(harness.displays.at(-1), { state: "approved", detail: "ok 3" });
		},
	);
});

test("27 · an early review whose call never arrives is dropped at turn_end, row and all", async () => {
	await withExtension(
		{
			rules: [GUARDED_RULE],
			config: { ui: { resultDisplayMs: 40 } },
			completeSimple: (_call, index) => assistantResponse(verdictText("approve", `ok ${index}`)),
		},
		async (harness) => {
			await harness.sessionStart();

			await harness.assistantMessage([
				{ id: "call-1", command: "git push origin a" },
				{ id: "call-2", command: "git push origin b" },
			]);
			assert.equal(await harness.toolCall("git push origin a", "call-1"), undefined);
			assert.equal(harness.calls.length, 2);
			assert.deepEqual(harness.displays.at(-1), { state: "queued", detail: undefined }, "call-2's verdict waits for its call");

			await harness.turnEnd();
			assert.notDeepEqual(harness.displays.at(-1), { state: "queued", detail: undefined });
			// What remains is call-1's own result, which clears on its timer.
			await waitFor(() => harness.displays.at(-1)?.state === "cleared");
			assert.deepEqual(harness.displays.at(-1), { state: "cleared", detail: undefined });
			assert.deepEqual(harness.denied, []);
		},
	);
});

test("28 · reviewConcurrency 1 reviews nothing early", async () => {
	await withExtension(
		{
			rules: [GUARDED_RULE],
			config: { reviewConcurrency: 1 },
			completeSimple: () => assistantResponse(verdictText("approve", "fine")),
		},
		async (harness) => {
			await harness.sessionStart();

			await harness.assistantMessage([
				{ id: "call-1", command: "git push origin a" },
				{ id: "call-2", command: "git push origin b" },
			]);
			assert.equal(await harness.toolCall("git push origin a", "call-1"), undefined);
			assert.equal(harness.calls.length, 1);
		},
	);
});

test("29 · an early-reviewed call that arrives no longer guarded runs unreviewed and drops its row", async () => {
	await withExtension(
		{
			rules: [GUARDED_RULE],
			config: { ui: { resultDisplayMs: 40 } },
			completeSimple: (_call, index) => assistantResponse(verdictText("approve", `ok ${index}`)),
		},
		async (harness) => {
			await harness.sessionStart();

			await harness.assistantMessage([
				{ id: "call-1", command: "git push origin a" },
				{ id: "call-2", command: "git push origin b" },
			]);
			assert.equal(await harness.toolCall("git push origin a", "call-1"), undefined);
			assert.deepEqual(harness.displays.at(-1), { state: "queued", detail: undefined });

			assert.equal(await harness.toolCall("echo rewritten", "call-2"), undefined);
			assert.equal(harness.calls.length, 2, "nothing new is reviewed");
			await waitFor(() => harness.displays.at(-1)?.state === "cleared");
			assert.deepEqual(harness.displays.at(-1), { state: "cleared", detail: undefined });
		},
	);
});

/**
 * A codemode script that ends (returns, throws, times out, is aborted) leaves
 * its unfinished bash calls behind; Pi hands them an already-aborted signal,
 * so they can never run. Their reviews and prompts must not outlive the script.
 */

test("30 · when a codemode script ends, its call under review is released at once, and the late verdict is ignored", async () => {
	let releaseReview: (() => void) | undefined;
	await withExtension(
		{
			rules: [GUARDED_RULE],
			completeSimple: () => new Promise((resolve) => {
				releaseReview = () => resolve(assistantResponse(verdictText("approve", "too late")));
			}),
		},
		async (harness) => {
			await harness.sessionStart();

			const orphan = harness.toolCall("git push origin main", "code-1/1", "code-1");
			await waitFor(() => releaseReview !== undefined);
			await harness.toolExecutionEnd("code-1");

			assert.deepEqual(
				await settledWithin(orphan, 250),
				{ block: true, reason: "Auto Permissions review cancelled" },
				"released at once, without waiting for the guardian to answer",
			);
			releaseReview?.();
			assert.deepEqual(harness.denied, [], "an abandoned call is not a denial");
			assert.deepEqual(harness.displays.at(-1), { state: "cleared", detail: undefined });
		},
	);
});

test("31 · when a codemode script ends, an approval prompt for one of its calls closes by itself", async () => {
	let promptReleased = false;
	await withExtension(
		{
			rules: [GUARDED_RULE],
			completeSimple: () => assistantResponse(verdictText("ask_user", "force push rewrites history")),
			custom: async (factory, harness) => {
				const selector = createCustomSelectorHarness(factory, 100);
				void selector.resultPromise.then(() => {
					promptReleased = true;
				});
				await harness.toolExecutionEnd("code-1");
				await Promise.resolve();
				return selector.result;
			},
		},
		async (harness) => {
			await harness.sessionStart();

			const result = await harness.toolCall("git push --force origin main", "code-1/1", "code-1");
			assert.ok(promptReleased, "the prompt is released instead of waiting for an answer that can change nothing");
			assert.deepEqual(result, { block: true, reason: "Auto Permissions review cancelled" });
			assert.deepEqual(harness.denied, []);
			assert.deepEqual(harness.denials(), []);
		},
	);
});

test("32 · a script's queued calls are dropped unreviewed when it ends, and another script's calls are untouched", async () => {
	let releaseFirst: (() => void) | undefined;
	await withExtension(
		{
			rules: [GUARDED_RULE],
			config: { reviewConcurrency: 1 },
			completeSimple: (_call, index) => {
				const response = assistantResponse(verdictText("approve", `ok ${index}`));
				if (index > 0) return response;
				return new Promise((resolve) => {
					releaseFirst = () => resolve(response);
				});
			},
		},
		async (harness) => {
			await harness.sessionStart();

			const other = harness.toolCall("git push origin other", "code-2/1", "code-2");
			await waitFor(() => releaseFirst !== undefined);
			const queued = harness.toolCall("git push origin main", "code-1/1", "code-1");
			await new Promise((resolve) => setImmediate(resolve));

			await harness.toolExecutionEnd("code-1");
			assert.deepEqual(
				await settledWithin(queued, 250),
				{ block: true, reason: "Auto Permissions review cancelled" },
				"the ended script's call leaves the slot queue at once",
			);
			releaseFirst?.();
			assert.equal(await other, undefined, "code-2 is still running, so its call is reviewed and applied");
			assert.equal(harness.calls.length, 1, "the dropped call never reached the guardian");
		},
	);
});

test("33 · a call whose script had already ended by the time its tool_call arrives is never reviewed", async () => {
	await withExtension(
		{ rules: [GUARDED_RULE], completeSimple: () => assistantResponse(verdictText("approve", "fine")) },
		async (harness) => {
			await harness.sessionStart();

			await harness.toolExecutionEnd("code-1");
			assert.deepEqual(
				await harness.toolCall("git push origin main", "code-1/1", "code-1"),
				{ block: true, reason: "Auto Permissions review cancelled" },
			);
			assert.equal(harness.calls.length, 0);

			// The record is per turn: a later turn reusing the id is reviewed normally.
			await harness.turnEnd();
			assert.equal(await harness.toolCall("git push origin main", "code-1/2", "code-1"), undefined);
			assert.equal(harness.calls.length, 1);
		},
	);
});

test("34 · a call from a codemode script is reviewed with the script, under the script-evidence policy", async () => {
	const script = 'await tools.bash({ command: "git push origin main" });';
	await withExtension(
		{ rules: [GUARDED_RULE], completeSimple: () => assistantResponse(verdictText("approve", "fine")) },
		async (harness) => {
			await harness.sessionStart();
			harness.contextEntries.push(
				{ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "push main" }] } },
				{
					type: "message",
					id: "a1",
					message: { role: "assistant", content: [{ type: "toolCall", id: "code-1", name: "codemode", arguments: { code: script } }] },
				},
			);

			assert.equal(await harness.toolCall("git push origin main", "code-1/1", "code-1"), undefined);
			const [call] = harness.calls;
			assert.ok(call.envelope.includes(JSON.stringify({ source: "assistant", evidence: `SCRIPT codemode [code-1]:\n${script}` })));
			assert.match(proposedAction(call), /"issuedByScript": "code-1"/u);
			assert.match(call.request.systemPrompt, /^SCRIPT RECORDS$/mu);

			// A model-issued call carries no script link.
			assert.equal(await harness.toolCall("git push origin main", "call-9"), undefined);
			assert.doesNotMatch(proposedAction(harness.calls[1]), /issuedByScript/u);
		},
	);
});
