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

type ToolExecute = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: unknown,
) => Promise<{ content: Array<{ text: string }>; details: { success?: boolean; command?: string } }>;

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

// The guarded bash renderer decorates Pi's native one, which reads the global
// theme rather than the one it is handed.
initTheme();

const PRELOAD_CONFIG_ENV = process.env.PI_AUTO_PERMISSIONS_CONFIG;

const GUARDIAN_MODEL = { provider: "guardian", id: "reviewer-1", api: "anthropic", contextWindow: 200_000 };

const GUARDED_RULE = {
	pattern: "^git push",
	level: "guarded",
	group: "git",
	label: "Git push",
};
const CONVENTION_RULE = {
	pattern: "^npm install",
	level: "convention",
	group: "npm",
	label: "Package install",
	message: "Use npm ci in this repository.",
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

/**
 * The theme the guarded bash `renderCall` receives. Permissive because the
 * native renderer this one decorates may reach for any theme helper; every one
 * of them here answers with the text it was handed, so a rendered row is
 * readable as plain strings.
 */
const RENDER_THEME = new Proxy(
	{},
	{
		get(_target, property) {
			if (property === "fg") return (_role: string, text: string) => text;
			return (...args: unknown[]) => args.find((value) => typeof value === "string") ?? "";
		},
	},
);

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
function answerOptionSelector(
	factory: unknown,
	harness: Harness,
	onPrompt?: (harness: Harness) => void,
): unknown {
	const selector = createCustomSelectorHarness(factory, 100);
	const rendered = selector.render(100);
	harness.prompts.push(rendered);
	onPrompt?.(harness);
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
	standingApprovals: 6,
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
	/** Runs while an approval prompt is on screen, before it is answered. */
	onPrompt?: (harness: Harness) => void;
}

interface Harness {
	configPath: string;
	denialLogPath: string;
	standingApprovalsPath: string;
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
	customCalls: number;
	/** Every `context.invalidate` the guarded bash renderer was asked to run. */
	invalidations: string[];
	sessionStart(): Promise<void>;
	sessionShutdown(): Promise<void>;
	toolCall(command: string, toolCallId?: string): Promise<BlockResult>;
	requestOverride(command: string, reason: string): ReturnType<ToolExecute>;
	settingsCommand(args?: string): Promise<void>;
	renderToolRow(toolCallId: string, command: string): string[];
	denials(): DenialLine[];
	standingApprovals(): Array<{ gate: { label: string; group: string }; command: string; reason: string; project: string }>;
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
	const script = options.completeSimple ?? (() => assistantResponse(verdictText("approve", "scripted")));

	const invalidations: string[] = [];
	const toolRowState = new Map<string, Record<string, unknown>>();

	const mock = createMockPi({ activeTools: ["bash"], allTools: [builtinTool("bash")] });
	const harness: Harness = {
		configPath,
		denialLogPath: join(dir, "denials.jsonl"),
		standingApprovalsPath: join(dir, "standing-approvals.jsonl"),
		mock,
		context: undefined as never,
		calls,
		denied,
		displays,
		prompts,
		answers,
		branch,
		customCalls: 0,
		invalidations,
		ctx: undefined as never,
		async sessionStart() {
			await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, harness.ctx);
		},
		async sessionShutdown() {
			await mock.events.get("session_shutdown")?.[0]?.({}, harness.ctx);
		},
		async toolCall(command: string, toolCallId = "call-1") {
			const handler = mock.events.get("tool_call")?.[0] as EventHandler | undefined;
			assert.ok(handler, "the extension registers a tool_call handler");
			return (await handler({ toolName: "bash", toolCallId, input: { command } }, harness.ctx)) as BlockResult;
		},
		requestOverride(command: string, reason: string) {
			const execute = mock.tools.find((tool) => tool.name === "request_override")?.execute as
				| ToolExecute
				| undefined;
			assert.ok(execute, "request_override must be registered");
			return execute("override-1", { command, reason }, undefined, undefined, harness.ctx);
		},
		async settingsCommand(args = "") {
			const command = mock.commands.get("auto-permissions");
			assert.ok(command, "the extension registers /auto-permissions");
			await command.handler(args, harness.ctx);
		},
		renderToolRow(toolCallId: string, command: string) {
			const tool = mock.tools.find((candidate) => candidate.name === "bash");
			assert.ok(tool, "toolRow placement registers a guarded bash tool");
			const renderCall = tool.renderCall as (
				args: unknown,
				theme: unknown,
				context: unknown,
			) => { render(width: number): string[] };
			const state = toolRowState.get(toolCallId) ?? {};
			toolRowState.set(toolCallId, state);
			const component = renderCall({ command }, RENDER_THEME, {
				toolCallId,
				state,
				invalidate: () => invalidations.push(toolCallId),
			});
			return component.render(120);
		},
		denials() {
			if (!existsSync(harness.denialLogPath)) return [];
			return readFileSync(harness.denialLogPath, "utf8")
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line) as DenialLine);
		},
		standingApprovals() {
			if (!existsSync(harness.standingApprovalsPath)) return [];
			return readFileSync(harness.standingApprovalsPath, "utf8")
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line));
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
			buildContextEntries: () => [],
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
			return answerOptionSelector(factory, harness, options.onPrompt);
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
	await withExtension({ rules: [GUARDED_RULE, CONVENTION_RULE] }, async (harness) => {
		await harness.sessionStart();

		assert.equal(await harness.toolCall("echo hello"), undefined);
		assert.deepEqual(harness.calls, [], "no rule matched, so nothing was reviewed");
		assert.deepEqual(harness.denied, []);
		assert.deepEqual(harness.denials(), []);
		assert.deepEqual(harness.displays, []);
	});
});

test("2 · a deny rule wins over convention and guarded rules that matched earlier in config order", async () => {
	const rules = [
		{ pattern: "danger", level: "guarded", group: "first", label: "Guarded first" },
		{ pattern: "danger", level: "convention", group: "second", label: "Convention second", message: "Use the wrapper." },
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

test("3 · a convention block activates request_override, and an allowed override lets the same command through", async () => {
	await withExtension({ rules: [CONVENTION_RULE] }, async (harness) => {
		await harness.sessionStart();
		assert.deepEqual(harness.mock.setActiveToolsCalls, [], "the override tool stays out of the active set until it is useful");

		const blocked = await harness.toolCall("npm install left-pad");
		assert.ok(blocked?.block);
		assert.match(blocked.reason, /^Convention violation: Package install/u);
		assert.match(blocked.reason, /Use npm ci in this repository\./u);
		assert.match(blocked.reason, /call `request_override` with the exact command/u);
		assert.equal(harness.denied.length, 1);
		assert.equal(harness.denied[0].decisionSource, "convention");
		assert.deepEqual(harness.mock.setActiveToolsCalls, [["bash", "request_override"]]);
		assert.deepEqual(harness.calls, [], "a convention rule never reaches the guardian");

		harness.answers.push("Allow for this session");
		const granted = await harness.requestOverride("npm install left-pad", "vendored package, npm ci cannot see it");
		assert.equal(granted.details.success, true);
		assert.equal(granted.details.command, "npm install left-pad");
		assert.match(harness.prompts[0].join("\n"), /Convention override: Package install/u);

		assert.equal(await harness.toolCall("npm install left-pad"), undefined);
		assert.equal(harness.denied.length, 1, "the allowed command records no second denial");
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

test("9 · in a loop session a revise verdict comes back as one bounded block instead of a prompt", async () => {
	const previous = { active: process.env.PI_LOOP_ACTIVE, id: process.env.PI_LOOP_ID };
	process.env.PI_LOOP_ACTIVE = "1";
	process.env.PI_LOOP_ID = "loop-42";
	try {
		await withExtension(
			{
				rules: [GUARDED_RULE],
				completeSimple: () => assistantResponse(verdictText("revise", "push to a branch, not main")),
			},
			async (harness) => {
				await harness.sessionStart();

				const result = await harness.toolCall("git push origin main");
				assert.ok(result?.block);
				assert.match(result.reason, /this session is running an unattended \/loop/u);
				assert.match(result.reason, /push to a branch, not main/u);
				assert.match(result.reason, /revision rounds? remains?/u);
				assert.match(result.reason, /Do not split, obfuscate, or re-route the command/u);
				assert.equal(harness.customCalls, 0, "an unattended loop is never asked to answer a modal");
				assert.equal(harness.denied.length, 1);
				assert.equal(harness.denied[0].decisionSource, "loop");
				assert.equal(harness.denied[0].verdict, "revise");
				assert.equal(harness.denials()[0].decisionSource, "loop");
			},
		);
	} finally {
		if (previous.active === undefined) delete process.env.PI_LOOP_ACTIVE;
		else process.env.PI_LOOP_ACTIVE = previous.active;
		if (previous.id === undefined) delete process.env.PI_LOOP_ID;
		else process.env.PI_LOOP_ID = previous.id;
	}
});

test("10 · a reviewer that throws asks the user, and blocks outright in a loop session", async () => {
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

	const previous = process.env.PI_LOOP_ACTIVE;
	process.env.PI_LOOP_ACTIVE = "1";
	try {
		await withExtension(
			{
				rules: [GUARDED_RULE],
				completeSimple: () => {
					throw new Error("reviewer offline");
				},
			},
			async (harness) => {
				await harness.sessionStart();

				const result = await harness.toolCall("git push origin main");
				assert.ok(result?.block);
				assert.match(result.reason, /^Git push could not be reviewed \(reviewer offline\)/u);
				assert.match(result.reason, /call loop_wait naming the reviewer failure/u);
				assert.equal(harness.customCalls, 0);
				assert.equal(harness.denied[0].decisionSource, "review_failure");
				assert.equal(harness.denials()[0].decisionSource, "review_failure");
			},
		);
	} finally {
		if (previous === undefined) delete process.env.PI_LOOP_ACTIVE;
		else process.env.PI_LOOP_ACTIVE = previous;
	}
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

test("12 · a second guarded command in the same turn shows queued before it shows waiting", async () => {
	let releaseFirst: (() => void) | undefined;
	let firstCalled: (() => void) | undefined;
	const firstReached = new Promise<void>((resolve) => {
		firstCalled = resolve;
	});
	await withExtension(
		{
			rules: [GUARDED_RULE],
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
			releaseFirst?.();

			assert.equal(await first, undefined);
			assert.equal(await second, undefined);
			assert.deepEqual(harness.displays.map((display) => display.state), [
				"waiting",
				"queued",
				"approved",
				"waiting",
				"approved",
			]);
			assert.equal(harness.calls.length, 2, "the queue serializes the reviews, it does not drop one");
		},
	);
});

test("13 · a SAFE prefilter approves without a full review, and a failing prefilter falls through to one", async () => {
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
			completeSimple: () => assistantResponse("SAFE"),
		},
		async (harness) => {
			await harness.sessionStart();

			assert.equal(await harness.toolCall("git push origin main"), undefined);
			assert.equal(harness.calls.length, 1, "SAFE short-circuits the full review");
			assert.match(harness.calls[0].envelope, /PREFILTER MODE/u);
			assert.equal(harness.calls[0].options.reasoning, "minimal");
			assert.deepEqual(harness.displays, [
				{ state: "waiting", detail: undefined },
				{ state: "approved", detail: "prefilter" },
			]);
		},
	);

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
			completeSimple: (_call, index) => {
				if (index === 0) throw new Error("prefilter offline");
				return assistantResponse(verdictText("approve", "reviewed in full"));
			},
		},
		async (harness) => {
			await harness.sessionStart();

			assert.equal(await harness.toolCall("git push origin main"), undefined);
			assert.equal(harness.calls.length, 2, "a prefilter that cannot answer falls closed into the full review");
			assert.doesNotMatch(harness.calls[1].envelope, /PREFILTER MODE/u);
			assert.equal(harness.displays.at(-1)?.detail, "reviewed in full");
		},
	);
});

test("14 · session_shutdown then session_start discards the lineage and restores the session's decisions", async () => {
	await withExtension(
		{
			rules: [GUARDED_RULE, CONVENTION_RULE],
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
			harness.branch.push(
				{
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
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "request_override",
						details: { success: true, command: "npm install left-pad" },
					},
				},
			);
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

			assert.equal(
				await harness.toolCall("npm install left-pad", "call-4"),
				undefined,
				"the session's granted convention overrides are rebuilt from the branch",
			);
			assert.deepEqual(harness.denied, []);
		},
	);
});

/**
 * Stage A2: the surfaces the widget-placement cases above do not reach — the
 * tool-row renderer, the standing-approval ledger, and the `/auto-permissions`
 * command.
 */

const SETUP_HANDOFF = "Use the auto-permissions-setup skill to set up my Auto Permissions policy.";
const ALLOW_STANDING = "Allow and stop asking about comparable commands";

function stripAnsi(lines: readonly string[]): string {
	return lines.join("\n").replace(/\u001b\[[0-9;]*m/gu, "");
}

test("15 · toolRow placement renders every guardian status under the bash call, and clears it on cancel", async () => {
	const controller = new AbortController();
	let releaseFirst: (() => void) | undefined;
	let firstCalled: (() => void) | undefined;
	const firstReached = new Promise<void>((resolve) => {
		firstCalled = resolve;
	});
	let askUserRow = "";
	await withExtension(
		{
			rules: [GUARDED_RULE],
			config: { ui: { placement: "toolRow" } },
			signal: controller.signal,
			onPrompt: (harness) => {
				askUserRow = stripAnsi(harness.renderToolRow("call-3", "git push origin qa"));
			},
			completeSimple: (_call, index) => {
				if (index === 1) return assistantResponse(verdictText("revise", "push to a branch, not main"));
				if (index === 2) return assistantResponse(verdictText("ask_user", "force push rewrites history"));
				if (index === 3) {
					controller.abort();
					return assistantResponse(verdictText("approve", "too late"));
				}
				return new Promise((resolve) => {
					releaseFirst = () => resolve(assistantResponse(verdictText("approve", "the user asked for this push")));
					firstCalled?.();
				});
			},
		},
		async (harness) => {
			await harness.sessionStart();
			assert.ok(
				harness.mock.tools.some((tool) => tool.name === "bash"),
				"toolRow placement re-registers bash so the review status can render in its row",
			);

			// Priming the row is what registers its invalidator, exactly as Pi
			// rendering the call for the first time would.
			assert.doesNotMatch(
				stripAnsi(harness.renderToolRow("call-1", "git push origin main")),
				/guardian running/u,
				"an un-reviewed call renders the native row alone",
			);

			const first = harness.toolCall("git push origin main", "call-1");
			await firstReached;
			assert.deepEqual(harness.invalidations, ["call-1"], "the row is repainted when its state changes");
			assert.match(
				stripAnsi(harness.renderToolRow("call-1", "git push origin main")),
				/◌ guardian running · Git push · guardian\/reviewer-1/u,
			);

			// A second guarded command while the first review holds the queue: the
			// row must say it is queued, in the same words the widget uses, and
			// not fall through to the blocked branch.
			const second = harness.toolCall("git push origin dev", "call-2");
			assert.match(
				stripAnsi(harness.renderToolRow("call-2", "git push origin dev")),
				/⋯ queued behind another review · Git push/u,
			);

			releaseFirst?.();
			assert.equal(await first, undefined);
			const approved = stripAnsi(harness.renderToolRow("call-1", "git push origin main"));
			assert.match(approved, /✓ approved · Git push/u);
			assert.match(approved, /the user asked for this push/u);
			assert.match(approved, /\$ git push origin main/u, "the native call render is kept above the status");

			const revised = await second;
			assert.ok(revised?.block);
			const reviseRow = stripAnsi(harness.renderToolRow("call-2", "git push origin dev"));
			assert.match(reviseRow, /↻ revision requested · Git push/u);
			assert.match(reviseRow, /push to a branch, not main/u);

			harness.answers.push("Block");
			const asked = await harness.toolCall("git push origin qa", "call-3");
			assert.deepEqual(asked, { block: true, reason: "Blocked by user" });
			assert.match(askUserRow, /\? approval required · Git push/u);
			assert.match(
				stripAnsi(harness.renderToolRow("call-3", "git push origin qa")),
				/✗ blocked · Git push/u,
			);

			// Cancellation is the path that takes the row away again.
			const cancelled = await harness.toolCall("git push origin hotfix", "call-4");
			assert.deepEqual(cancelled, { block: true, reason: "Auto Permissions review cancelled" });
			assert.doesNotMatch(
				stripAnsi(harness.renderToolRow("call-4", "git push origin hotfix")),
				/guardian running|approved|blocked/u,
			);

			assert.deepEqual(harness.displays, [], "with a tool row there is nothing above the editor");
		},
	);
});

test("16 · a standing approval is written to the ledger, kept out of the session entry, and reloaded at session_start", async () => {
	await withExtension(
		{
			rules: [GUARDED_RULE],
			completeSimple: (_call, index) =>
				assistantResponse(
					index === 0
						? verdictText("ask_user", "force push rewrites history")
						: verdictText("approve", "covered by the standing approval"),
				),
		},
		async (harness) => {
			await harness.sessionStart();

			harness.answers.push(ALLOW_STANDING);
			assert.equal(await harness.toolCall("git push --force origin main", "call-1"), undefined);

			const ledger = harness.standingApprovals();
			assert.equal(ledger.length, 1);
			assert.deepEqual(ledger[0].gate, { label: "Git push", group: "git" });
			assert.equal(ledger[0].command, "git push --force origin main");
			assert.equal(ledger[0].reason, "force push rewrites history");
			assert.deepEqual(
				harness.overrideEntries().at(-1)?.overrides,
				[],
				"ledger-backed approvals are not duplicated into the session entry",
			);

			assert.equal(await harness.toolCall("git push --force origin dev", "call-2"), undefined);
			assert.match(
				harness.calls[1].envelope,
				/USER \(standing permission override, granted \d{4}-\d{2}-\d{2} in .*\): allowed gated command \\"git push --force origin main\\"/u,
			);

			await harness.sessionShutdown();
			await harness.sessionStart();
			assert.equal(await harness.toolCall("git push --force origin qa", "call-3"), undefined);
			assert.match(
				harness.calls[2].envelope,
				/USER \(standing permission override/u,
			);
		},
	);

	// The other half of the invariant: an infrastructure failure is not a
	// guardian judgment, so it never offers to stop asking.
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
			await harness.toolCall("git push origin main");
			assert.doesNotMatch(harness.prompts[0].join("\n"), /stop asking about comparable commands/u);
			assert.deepEqual(harness.standingApprovals(), []);
		},
	);
});

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

test("22 · the settings menu reverts a failed save and revokes a standing approval", async () => {
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

	let settingsPhase = false;
	await withExtension(
		{
			rules: [GUARDED_RULE],
			completeSimple: (_call, index) =>
				assistantResponse(
					index === 0
						? verdictText("ask_user", "force push rewrites history")
						: verdictText("approve", "covered by the standing approval"),
				),
			custom: async (factory, harness) => {
				if (!settingsPhase) return answerOptionSelector(factory, harness);
				settingsPhase = false;
				const menu = buildMenuComponent(factory, () => {});
				for (let row = 0; row < MENU_ROW.standingApprovals; row += 1) menu.handleInput(KEY_DOWN);
				menu.handleInput(KEY_ENTER);
				assert.match(menu.render(100).join("\n"), /Standing approvals/u);
				menu.handleInput(KEY_ENTER);
				assert.match(menu.render(100).join("\n"), /Revoke standing approval\?/u);
				menu.handleInput(KEY_ENTER); // "Revoke"
				return undefined;
			},
		},
		async (harness) => {
			await harness.sessionStart();

			harness.answers.push(ALLOW_STANDING);
			assert.equal(await harness.toolCall("git push --force origin main", "call-1"), undefined);
			assert.equal(harness.standingApprovals().length, 1);

			assert.equal(await harness.toolCall("git push --force origin dev", "call-2"), undefined);
			const lineageSessionId = harness.calls[1].options.sessionId;
			assert.match(harness.calls[1].envelope, /USER \(standing permission override/u);

			settingsPhase = true;
			await harness.settingsCommand();
			assert.deepEqual(harness.standingApprovals(), [], "the ledger entry is gone");
			assert.equal(harness.context.notifications.at(-1)?.message, "Standing approval revoked.");

			assert.equal(await harness.toolCall("git push --force origin qa", "call-3"), undefined);
			assert.doesNotMatch(
				harness.calls[2].envelope,
				/USER \(standing permission override/u,
				"the revoked approval stops being evidence",
			);
			assert.notEqual(
				harness.calls[2].options.sessionId,
				lineageSessionId,
				"the reviewer conversation that saw the approval is not continued",
			);
		},
	);
});
