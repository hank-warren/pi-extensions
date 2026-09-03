import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "../../../test/support/mock-pi.js";
import { planModeCompleted } from "../src/completion-tool.js";
import { planFilePathForSession, plansDirectory } from "../src/plan-file.js";
import planMode, { buildActivePlanPointer, buildPlanModePrompt } from "../src/plan-mode.js";

type ToolExecute = (...args: unknown[]) => Promise<unknown>;

/**
 * The hermetic preload's scratch agent dir (`test/support/hermetic.ts`). Every
 * helper below repoints `PI_CODING_AGENT_DIR` at a temp dir it then deletes, and
 * puts this back afterwards, so a case that runs outside a helper never inherits
 * a path that no longer exists.
 */
const PRELOAD_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

/**
 * Every test that touches the plan file needs an isolated agent dir, because the
 * plan path is derived from getAgentDir().
 */
async function withAgentDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		return await run(directory);
	} finally {
		process.env.PI_CODING_AGENT_DIR = PRELOAD_AGENT_DIR;
		await rm(directory, { recursive: true, force: true });
	}
}

function completeTool(mock: ReturnType<typeof createMockPi>) {
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ToolExecute | undefined;
	assert.ok(execute, "plan_mode_complete must be registered");
	return execute;
}

async function startPlanning(mock: ReturnType<typeof createMockPi>, context: { ctx: never }) {
	await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
}

/**
 * The menu's exit runs `exitPlanMode(...).then(notify)` without awaiting it, so
 * the notification lands a plan-file deletion later than the command returns.
 * Polling beats a fixed sleep: it is as fast as the machine allows and does not
 * go red on a loaded runner.
 */
async function waitForNotification(
	context: ReturnType<typeof createMockContext>,
	expected: string,
) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (context.notifications.at(-1)?.message === expected) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(context.notifications.at(-1)?.message, expected);
}

test("plan-mode registers flag, tools, command, and safety hooks", () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);

	assert.ok(mock.flags.has("plan"));
	assert.deepEqual(
		mock.tools.map((tool) => tool.name).sort(),
		["plan_mode_complete", "plan_mode_question"],
		"both tools are always registered, so a historical transcript resolves either",
	);
	assert.ok(mock.commands.has("plan"));
	for (const event of ["session_start", "session_shutdown", "tool_call", "before_agent_start"]) {
		assert.ok(mock.events.has(event), `expected a ${event} handler`);
	}
});

test("Plan tools are staged and activation is monotonic for the source session", async () => {
	await withAgentDir(async () => {
		const allTools = [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("edit"),
			builtinTool("write"),
			extensionTool("subagent"),
			extensionTool("plan_mode_question"),
			extensionTool("plan_mode_complete"),
		];
		const active = [
			"read",
			"bash",
			"edit",
			"write",
			"subagent",
			"plan_mode_question",
			"plan_mode_complete",
		];
		const mock = createMockPi({ activeTools: [...active], allTools });
		planMode(mock.pi);
		const context = createMockContext({ hasUI: true, mode: "tui" });

		await startPlanning(mock, context);
		await mock.events.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, context.ctx);
		await completeTool(mock)("call", { plan: "# Plan" }, undefined, undefined, context.ctx);
		await mock.commands.get("plan")?.handler("implement", context.ctx);
		await mock.commands.get("plan")?.handler("exit", context.ctx);
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);

		const activated = [
			"read", "bash", "edit", "write", "subagent", "plan_mode_complete", "plan_mode_question",
		];
		assert.deepEqual(mock.setActiveToolsCalls, [
			["read", "bash", "edit", "write", "subagent"],
			activated,
		]);
		assert.deepEqual(mock.rawPi.getActiveTools(), activated);
	});
});

/** Active set for the preference tests; order matters for the untouched check. */
const SIBLING_TOOLS = ["read", "bash", "edit", "write", "subagent", "plan_mode_complete"];

function preferenceMock(options: { askUserQuestion: boolean }) {
	const active = [...SIBLING_TOOLS, "plan_mode_question"];
	if (options.askUserQuestion) active.push("ask_user_question");
	const mock = createMockPi({
		activeTools: active,
		allTools: active.map((name) => extensionTool(name)),
	});
	planMode(mock.pi);
	return mock;
}

async function runBeforeAgentStart(mock: ReturnType<typeof createMockPi>, ctx: never) {
	return (await mock.events.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx)) as
		| { systemPrompt?: string }
		| undefined;
}

test("plan_mode_question survives when ask_user_question is not installed", async () => {
	await withAgentDir(async () => {
		const mock = preferenceMock({ askUserQuestion: false });
		const context = createMockContext({ hasUI: true, mode: "tui" });
		await startPlanning(mock, context);
		const result = await runBeforeAgentStart(mock, context.ctx);

		assert.equal(mock.setActiveToolsCalls.length, 2, "initial staging plus one activation");
		assert.ok(mock.rawPi.getActiveTools().includes("plan_mode_question"));
		assert.match(result?.systemPrompt ?? "", /plan_mode_question/);
	});
});

test("plan_mode_question is hidden from the model when ask_user_question is present", async () => {
	await withAgentDir(async () => {
		const mock = preferenceMock({ askUserQuestion: true });
		const context = createMockContext({ hasUI: true, mode: "tui" });
		await startPlanning(mock, context);
		await runBeforeAgentStart(mock, context.ctx);

		assert.equal(mock.setActiveToolsCalls.length, 2, "initial staging plus one activation");
		assert.deepEqual(
			mock.rawPi.getActiveTools(),
			["read", "bash", "edit", "write", "subagent", "ask_user_question", "plan_mode_complete"],
			"the global question tool keeps its place and completion is appended",
		);
		assert.ok(
			mock.tools.some((tool) => tool.name === "plan_mode_question"),
			"the tool stays registered so a historical transcript still resolves it",
		);
	});
});

test("hiding plan_mode_question is idempotent across turns", async () => {
	await withAgentDir(async () => {
		const mock = preferenceMock({ askUserQuestion: true });
		const context = createMockContext({ hasUI: true, mode: "tui" });
		await startPlanning(mock, context);
		for (let turn = 0; turn < 4; turn++) await runBeforeAgentStart(mock, context.ctx);

		assert.equal(mock.setActiveToolsCalls.length, 2, "repeated turns must not rewrite the tool set");
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"read", "bash", "edit", "write", "subagent", "ask_user_question", "plan_mode_complete",
		]);
	});
});

test("the preference applies outside Plan mode too, so the prompt is never stale", async () => {
	await withAgentDir(async () => {
		const mock = preferenceMock({ askUserQuestion: true });
		const context = createMockContext();
		// No /plan: the strip is about which tools the model can see, not about mode.
		const result = await runBeforeAgentStart(mock, context.ctx);

		assert.ok(!mock.rawPi.getActiveTools().includes("plan_mode_question"));
		assert.equal(result?.systemPrompt, undefined, "no Plan-mode prompt outside Plan mode");
	});
});

test("the Plan-mode prompt names ask_user_question when it is preferred", async () => {
	await withAgentDir(async () => {
		const mock = preferenceMock({ askUserQuestion: true });
		const context = createMockContext({ hasUI: true, mode: "tui" });
		await startPlanning(mock, context);
		const result = await runBeforeAgentStart(mock, context.ctx);

		const prompt = result?.systemPrompt ?? "";
		assert.match(prompt, /ask_user_question/);
		assert.ok(!prompt.includes("plan_mode_question"), "the weaker tool must not be advertised");
	});
});

test("a headless session is told to ask in plain text, never to call a stripped tool", async () => {
	// Both interactive question tools are removed from a headless run, and
	// pi-ask-user-question strips its own on this same hook — so hook order
	// decides nothing: naming either one would send the model after a tool it
	// cannot call.
	await withAgentDir(async () => {
		const mock = preferenceMock({ askUserQuestion: true });
		const context = createMockContext({ hasUI: false });
		await startPlanning(mock, context);
		const result = await runBeforeAgentStart(mock, context.ctx);

		const prompt = result?.systemPrompt ?? "";
		assert.match(prompt, /\[PLAN MODE ACTIVE\]/);
		assert.ok(!prompt.includes("plan_mode_question"), "no stripped tool is advertised");
		assert.ok(!prompt.includes("ask_user_question"), "no stripped tool is advertised");
		assert.match(prompt, /ask in plain text/);
		// Plan mode never activates its own fallback headlessly. The global tool
		// is still listed here because only its own package strips it; the
		// composition test covers both extensions together.
		assert.ok(!mock.rawPi.getActiveTools().includes("plan_mode_question"));

		await mock.commands.get("plan")?.handler("finalize", context.ctx);
		const sent = mock.sentUserMessages.at(-1)?.text ?? "";
		assert.match(sent, /ask it in plain text/);
		assert.ok(!sent.includes("question"), "the steer names no tool either");
	});
});

test("the finalize steer names whichever question tool is preferred", async () => {
	await withAgentDir(async () => {
		for (const askUserQuestion of [false, true]) {
			const mock = preferenceMock({ askUserQuestion });
			const context = createMockContext({ hasUI: true, mode: "tui" });
			await startPlanning(mock, context);
			await mock.commands.get("plan")?.handler("finalize", context.ctx);

			const sent = mock.sentUserMessages.at(-1)?.text ?? "";
			assert.match(sent, /Finalize the current implementation plan now/);
			assert.match(sent, askUserQuestion ? /ask_user_question/ : /plan_mode_question/);
		}
	});
});

test("plan_mode_complete writes the plan file and round-trips exactly", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext();
		await startPlanning(mock, context);

		const plan = "# Migrate auth\n\n## Steps\n\n1. Read `config.ts`\n2. Ship it\n\n- [x] done";
		const result = (await completeTool(mock)(
			"call",
			{ plan },
			undefined,
			undefined,
			context.ctx,
		)) as { details?: { planPath?: string } };

		const planPath = planFilePathForSession("test-session");
		assert.equal(result.details?.planPath, planPath);
		assert.equal(await readFile(planPath, "utf8"), `${plan}\n`);
		assert.equal(context.statuses.get("plan-mode"), "◆ plan · ready → /plan");
	});
});

test("the plan file lives in the agent dir plans directory", async () => {
	await withAgentDir(async (directory) => {
		assert.equal(plansDirectory(), join(directory, "plans"));
		assert.equal(planFilePathForSession("abc-123"), join(directory, "plans", "abc-123.md"));
	});
});

test("a session id that is unusable as a filename cannot escape the plans directory", async () => {
	await withAgentDir(async (directory) => {
		const plans = join(directory, "plans");
		assert.equal(planFilePathForSession("../../escape"), join(plans, "escape.md"));
		assert.equal(planFilePathForSession("a/b"), join(plans, "a-b.md"));
		assert.ok(planFilePathForSession(undefined).startsWith(`${plans}/`));
		assert.ok(planFilePathForSession("").startsWith(`${plans}/`));
	});
});

test("before_agent_start injects the plan path, never the plan body", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext();
		await startPlanning(mock, context);

		const plan = "# Secret plan body\n\nUnmistakable-plan-content-marker";
		await completeTool(mock)("call", { plan }, undefined, undefined, context.ctx);
		await mock.commands.get("plan")?.handler("implement", context.ctx);

		const result = (await mock.events.get("before_agent_start")?.[0]?.(
			{ systemPrompt: "base" },
			context.ctx,
		)) as { systemPrompt?: string } | undefined;

		const systemPrompt = result?.systemPrompt ?? "";
		const planPath = planFilePathForSession("test-session");
		assert.ok(systemPrompt.includes(planPath), "expected the plan path in the system prompt");
		assert.ok(
			!systemPrompt.includes("Unmistakable-plan-content-marker"),
			"the plan body must never be injected into context",
		);
		// The pointer is a single line regardless of plan size.
		assert.equal(buildActivePlanPointer(planPath).split("\n").length, 1);
	});
});

test("a hand-edited plan file is what show and implementation see", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext();
		await startPlanning(mock, context);
		await completeTool(mock)("call", { plan: "# Original" }, undefined, undefined, context.ctx);

		const planPath = planFilePathForSession("test-session");
		await writeFile(planPath, "# Edited by hand\n");

		await mock.commands.get("plan")?.handler("show", context.ctx);
		const shown = mock.entries.at(-1)?.data as { plan?: string } | undefined;
		assert.match(shown?.plan ?? "", /Edited by hand/);
		assert.ok(!(shown?.plan ?? "").includes("Original"));
		assert.equal(mock.sentMessages.length, 0, "display-only plan cards stay out of model context");
	});
});

test("exit deletes the plan file", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext();
		await startPlanning(mock, context);
		await completeTool(mock)("call", { plan: "# Plan" }, undefined, undefined, context.ctx);

		const planPath = planFilePathForSession("test-session");
		await stat(planPath);

		await mock.commands.get("plan")?.handler("exit", context.ctx);
		await assert.rejects(() => stat(planPath), /ENOENT/);
		assert.equal(context.statuses.get("plan-mode"), undefined);
	});
});

test("export copies the plan and refuses to overwrite an existing target", async () => {
	await withAgentDir(async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-plan-mode-export-"));
		try {
			const mock = createMockPi({ activeTools: ["read"] });
			planMode(mock.pi);
			const context = createMockContext({ cwd, hasUI: true, mode: "tui" });
			await startPlanning(mock, context);
			await completeTool(mock)(
				"call",
				{ plan: "# Exported plan" },
				undefined,
				undefined,
				context.ctx,
			);

			// An occupied target fails closed and leaves both files untouched.
			await writeFile(join(cwd, "taken.md"), "pre-existing\n");
			await mock.commands.get("plan")?.handler("export taken.md", context.ctx);
			assert.match(context.notifications.at(-1)?.message ?? "", /already exists/);
			assert.equal(await readFile(join(cwd, "taken.md"), "utf8"), "pre-existing\n");
			assert.equal(context.statuses.get("plan-mode"), "◆ plan · ready → /plan", "a failed export keeps state");

			// A successful export of a ready plan writes the file and leaves Plan mode,
			// keeping the exported copy behind.
			await mock.commands.get("plan")?.handler("export out.md", context.ctx);
			assert.equal(await readFile(join(cwd, "out.md"), "utf8"), "# Exported plan\n");
			assert.equal(context.statuses.get("plan-mode"), undefined);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

test("edit and write are blocked while planning; other tools are not", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({
			activeTools: ["read", "bash", "subagent"],
			allTools: [builtinTool("read"), builtinTool("bash"), extensionTool("subagent")],
		});
		planMode(mock.pi);
		const context = createMockContext();
		await startPlanning(mock, context);

		const toolCall = mock.events.get("tool_call")?.[0];
		assert.ok(toolCall);

		for (const toolName of ["edit", "write"]) {
			const blocked = (await toolCall({ toolName, input: {} }, context.ctx)) as
				| { block?: boolean }
				| undefined;
			assert.equal(blocked?.block, true, `${toolName} must be blocked in Plan mode`);
		}

		// Everything else is left to the session's normal permission layer —
		// including checklist tools like todo (deliberate: planning scratch), and
		// update_plan, a pre-1.0 upstream tool that no longer exists in pi.
		for (const call of [
			{ toolName: "bash", input: { command: "rm -rf /" } },
			{ toolName: "subagent", input: { agent: "worker" } },
			{ toolName: "read", input: { path: "a.ts" } },
			{ toolName: "todo", input: { action: "create", subject: "scratch" } },
			{ toolName: "update_plan", input: {} },
		]) {
			assert.equal(await toolCall(call, context.ctx), undefined, `${call.toolName} must pass`);
		}
	});
});

test("a superseded plan is shown and described as superseded, never as current", async () => {
	await withAgentDir(async (directory) => {
		const { planModeStatusText, showStoredPlan } = await import("../src/presentation.js");
		const { writePlanFile } = await import("../src/plan-file.js");
		const planPath = join(directory, "plan.md");
		await writePlanFile(planPath, "# Old plan");
		// enabled with a stored plan but not awaitingAction = revision feedback
		// superseded the completed plan (before_agent_start cleared the flag).
		const superseded = { enabled: true, awaitingAction: false, planPath };

		assert.match(planModeStatusText(superseded), /superseded/i);
		assert.match(
			planModeStatusText({ enabled: true, awaitingAction: true, planPath }),
			/proposed plan is ready/i,
		);

		const mock = createMockPi({ activeTools: ["read"] });
		const context = createMockContext();
		await showStoredPlan(mock.pi, context.ctx, superseded);
		const shown = mock.entries.at(-1)?.data as { title?: string };
		assert.match(shown?.title ?? "", /Superseded Proposed Plan/);

		await showStoredPlan(mock.pi, context.ctx, { ...superseded, awaitingAction: true });
		const ready = mock.entries.at(-1)?.data as { title?: string };
		assert.equal(ready?.title, "Proposed Plan");
		assert.equal(mock.sentMessages.length, 0);
	});
});

test("the plan card renderer tolerates persisted data it did not write", async () => {
	// The renderer runs against whatever is on disk: an entry that predates a
	// field, a partial write, a hand-edited session file. Pi contains a throw as
	// an inline `renderer failed:` box, which is survivable but a needlessly
	// ugly way to say "this card is old".
	const { PLAN_CARD_ENTRY_TYPE, registerPlanModeCardRenderer } = await import(
		"../src/presentation.js"
	);
	const mock = createMockPi({ activeTools: ["read"] });
	registerPlanModeCardRenderer(mock.pi);
	const render = mock.entryRenderers.get(PLAN_CARD_ENTRY_TYPE) as unknown as (entry: {
		data: unknown;
	}) => unknown;
	assert.ok(render, "the renderer is registered");

	assert.ok(render({ data: { title: "Proposed Plan", plan: "# Do it" } }), "valid data renders");

	for (const data of [
		undefined,
		null,
		{},
		{ title: "only a title" },
		{ plan: "only a plan" },
		{ title: 1, plan: 2 },
		"nope",
	]) {
		assert.doesNotThrow(() => render({ data }), `threw on ${JSON.stringify(data) ?? "undefined"}`);
		const fallback = render({ data }) as { text?: string };
		assert.match(
			String(fallback.text ?? fallback),
			/Plan card unavailable/,
			"malformed data renders the fallback line",
		);
	}
});

test("blocked tools are allowed again once Plan mode exits", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext();
		await startPlanning(mock, context);
		const toolCall = mock.events.get("tool_call")?.[0];
		assert.ok(toolCall);
		assert.equal(
			((await toolCall({ toolName: "edit", input: {} }, context.ctx)) as { block?: boolean })
				?.block,
			true,
		);

		await mock.commands.get("plan")?.handler("exit", context.ctx);
		assert.equal(await toolCall({ toolName: "edit", input: {} }, context.ctx), undefined);
	});
});

test("malformed persisted Plan state fails closed", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read", "write"] });
		planMode(mock.pi);
		const malformedState = {
			type: "custom",
			customType: "plan-mode-state",
			data: {
				enabled: "yes",
				awaitingAction: 1,
				planPath: 42,
				previousThinkingLevel: "extreme",
			},
		};
		const context = createMockContext({
			sessionManager: {
				getSessionId: () => "test-session",
				getBranch: () => [malformedState],
				getEntries: () => [malformedState],
			},
		});
		await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);

		assert.equal(context.statuses.get("plan-mode"), undefined);
		assert.deepEqual(mock.setActiveToolsCalls, []);
		const toolCall = mock.events.get("tool_call")?.[0];
		assert.equal(await toolCall?.({ toolName: "edit", input: {} }, context.ctx), undefined);
	});
});

test("a relative persisted plan path is rejected", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const persisted = {
			type: "custom",
			customType: "plan-mode-state",
			data: { enabled: false, awaitingAction: false, planPath: "../../etc/passwd" },
		};
		const context = createMockContext({
			sessionManager: {
				getSessionId: () => "test-session",
				getBranch: () => [persisted],
				getEntries: () => [persisted],
			},
		});
		await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);

		const result = (await mock.events.get("before_agent_start")?.[0]?.(
			{ systemPrompt: "base" },
			context.ctx,
		)) as { systemPrompt?: string } | undefined;
		assert.equal(result, undefined, "a rejected plan path must not produce a pointer");
	});
});

test("the plan survives a resume through the persisted path", async () => {
	await withAgentDir(async () => {
		const first = createMockPi({ activeTools: ["read"] });
		planMode(first.pi);
		const context = createMockContext();
		await startPlanning(first, context);
		await completeTool(first)(
			"call",
			{ plan: "# Durable plan" },
			undefined,
			undefined,
			context.ctx,
		);
		await first.commands.get("plan")?.handler("implement", context.ctx);
		const persistedState = first.entries.at(-1);
		assert.equal(persistedState?.customType, "plan-mode-state");

		// A fresh extension instance resuming the same session branch.
		const second = createMockPi({ activeTools: ["read"] });
		planMode(second.pi);
		const resumed = createMockContext({
			sessionManager: {
				getSessionId: () => "test-session",
				getBranch: () => [{ type: "custom", ...persistedState }],
				getEntries: () => [{ type: "custom", ...persistedState }],
			},
		});
		await second.events.get("session_start")?.[0]?.({ reason: "resume" }, resumed.ctx);

		assert.equal(resumed.statuses.get("plan-mode"), "▶ plan · implementing");
		await second.commands.get("plan")?.handler("show", resumed.ctx);
		const shown = second.entries.at(-1)?.data as { plan?: string } | undefined;
		assert.match(shown?.plan ?? "", /Durable plan/);
	});
});

test("implementation handoff references the plan file instead of inlining it", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext();
		await startPlanning(mock, context);
		await completeTool(mock)(
			"call",
			{ plan: "# Plan\n\nInline-body-marker" },
			undefined,
			undefined,
			context.ctx,
		);

		await mock.commands.get("plan")?.handler("implement", context.ctx);
		const handoff = mock.sentUserMessages.at(-1)?.text ?? "";
		assert.ok(handoff.includes(planFilePathForSession("test-session")));
		assert.ok(!handoff.includes("Inline-body-marker"), "the handoff must not inline the plan");
		assert.equal(context.statuses.get("plan-mode"), "▶ plan · implementing");
	});
});

test("plan_mode_complete is rejected when Plan mode is inactive", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);

		await assert.rejects(
			() => completeTool(mock)("call", { plan: "# Plan" }, undefined, undefined, context.ctx),
			/only available while Plan mode is active/,
		);
	});
});

test("plan_mode_complete rejects empty and oversized plans", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext();
		await startPlanning(mock, context);

		await assert.rejects(
			() => completeTool(mock)("call", { plan: "   " }, undefined, undefined, context.ctx),
			/must not be empty/,
		);
		await assert.rejects(
			() =>
				completeTool(mock)(
					"call",
					{ plan: "x".repeat(50_001) },
					undefined,
					undefined,
					context.ctx,
				),
			/must not exceed/,
		);
	});
});

test("a failed plan-file write keeps Plan mode active instead of losing the plan", async () => {
	await withAgentDir(async (directory) => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext();
		await startPlanning(mock, context);

		// A regular file where the plans directory must go makes the write fail.
		await writeFile(join(directory, "plans"), "not a directory\n");

		await assert.rejects(
			() => completeTool(mock)(
				"call",
				{ plan: "# Unsaveable" },
				undefined,
				undefined,
				context.ctx,
			),
			/Unable to save the plan/,
		);
		// Still planning, so the user can retry rather than losing the work.
		assert.equal(context.statuses.get("plan-mode"), "◆ plan · drafting");
	});
});

test("a new planning turn supersedes the previous ready plan", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext();
		await startPlanning(mock, context);
		await completeTool(mock)("call", { plan: "# First" }, undefined, undefined, context.ctx);
		assert.equal(context.statuses.get("plan-mode"), "◆ plan · ready → /plan");

		await mock.events.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, context.ctx);
		assert.equal(context.statuses.get("plan-mode"), "◆ plan · revising");
	});
});

test("plan mode prompt states the mode rules without tool-policy language", () => {
	const prompt = buildPlanModePrompt();
	assert.match(prompt, /\[PLAN MODE ACTIVE\]/);
	assert.match(prompt, /do not edit files/i);
	assert.match(prompt, /plan_mode_complete/);
	assert.ok(!/allowlist/i.test(prompt), "the prompt must not describe a bash allowlist");
	assert.ok(!/Non-built-in tools are disabled/i.test(prompt));
});

test("plan mode completion result carries the plan and its path", () => {
	initTheme();
	const completed = planModeCompleted("# Plan", "/tmp/plans/s.md");
	assert.equal(completed.terminate, true);
	assert.equal(completed.details.plan, "# Plan");
	assert.equal(completed.details.planPath, "/tmp/plans/s.md");
});

/**
 * Producer side of the pi-plan-mode -> pi-loop session-entry contract.
 *
 * @hank-warren/pi-loop reads the newest `plan-mode-state` entry and skips its
 * tick while `data.enabled === true`, so that entry type, that field, and its
 * boolean-ness are a cross-package interface, not an internal detail. The
 * mirrored literal copy lives in
 * `packages/pi-loop/test/fixtures/goal-state-sequences.ts`; the two files are
 * duplicated deliberately rather than imported, because public packages may
 * not import a sibling's source (repo `AGENTS.md`, Conventions). When this
 * test changes, change that fixture in the same PR.
 */
test("plan-mode-state entry shape (pi-loop consumer contract)", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read", "write"] });
		planMode(mock.pi);
		const context = createMockContext();
		await startPlanning(mock, context);

		const entered = mock.entries.filter((entry) => entry.customType === "plan-mode-state").at(-1);
		assert.equal(entered?.customType, "plan-mode-state");
		assert.equal((entered?.data as { enabled?: unknown }).enabled, true);

		await mock.commands.get("plan")?.handler("exit", context.ctx);

		const exited = mock.entries.filter((entry) => entry.customType === "plan-mode-state").at(-1);
		assert.equal(exited?.customType, "plan-mode-state");
		assert.equal((exited?.data as { enabled?: unknown }).enabled, false);
	});
});

/**
 * Entering Plan mode and handing implementation back both exist to deliver one
 * message. When the session refuses it, the mode switch is rolled back rather
 * than left applied with nothing sent — the model would otherwise be in a mode
 * it was never told about.
 */
test("a Plan-mode message the session refuses rolls the state back", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
		const deliver = mock.rawPi.sendUserMessage.bind(mock.rawPi);
		mock.rawPi.sendUserMessage = () => {
			throw new Error("session is busy");
		};

		await mock.commands.get("plan")?.handler("draft the migration", context.ctx);

		assert.match(context.notifications.at(-1)?.message ?? "", /Unable to send.*session is busy/);
		assert.equal(context.statuses.get("plan-mode"), undefined, "Plan mode must not stay on");
		assert.equal((mock.entries.at(-1)?.data as { enabled?: unknown }).enabled, false);

		// The same rule on the way out: a refused handoff keeps the ready plan.
		mock.rawPi.sendUserMessage = deliver;
		await startPlanning(mock, context);
		await completeTool(mock)("call", { plan: "# Plan" }, undefined, undefined, context.ctx);
		mock.rawPi.sendUserMessage = () => {
			throw new Error("session is busy");
		};

		await mock.commands.get("plan")?.handler("implement", context.ctx);

		assert.equal(context.statuses.get("plan-mode"), "◆ plan · ready → /plan");
		assert.equal((mock.entries.at(-1)?.data as { enabled?: unknown }).enabled, true);
	});
});

test("--plan activates Plan mode at session start", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		mock.flags.get("plan")!.value = true;
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);

		assert.equal(context.statuses.get("plan-mode"), "◆ plan · drafting");
		assert.deepEqual(mock.setActiveToolsCalls, [["read", "plan_mode_complete"]]);
		assert.equal(mock.entries.length, 1, "the flag activation is persisted exactly once");
		assert.equal((mock.entries[0]?.data as { enabled?: unknown }).enabled, true);
	});
});

/**
 * `--plan` persists only when it is the thing that turned Plan mode on. A
 * session that resumes already planning must append nothing: `plan-mode-state`
 * is the cross-package entry pi-loop reads, so a spurious entry per session
 * start is not cosmetic.
 */
test("--plan persists nothing when the resumed session is already planning", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		mock.flags.get("plan")!.value = true;
		const persisted = {
			type: "custom",
			customType: "plan-mode-state",
			data: { enabled: true, awaitingAction: false },
		};
		const context = createMockContext({
			sessionManager: {
				getSessionId: () => "test-session",
				getBranch: () => [persisted],
				getEntries: () => [persisted],
			},
		});
		await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);

		assert.equal(context.statuses.get("plan-mode"), "◆ plan · drafting");
		assert.deepEqual(mock.entries, [], "an already-planning session appends nothing");
	});
});

test("entering Plan mode reports it, and a second /plan start says it is already on", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext();

		await startPlanning(mock, context);
		assert.match(context.notifications.at(-1)?.message ?? "", /Plan mode enabled/);

		await mock.commands.get("plan")?.handler("start", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /already active/);
	});
});

/**
 * Four states, four wordings: whether Plan mode was on decides "disabled" vs
 * "cleared", and whether a plan file exists decides whether anything was
 * discarded. Getting this wrong tells the user their plan is gone when it is
 * not — or the reverse.
 */
test("every /plan exit wording matches the state it reports", async () => {
	type Arrange = (
		mock: ReturnType<typeof createMockPi>,
		context: ReturnType<typeof createMockContext>,
	) => Promise<void>;
	const completePlan: Arrange = async (mock, context) => {
		await completeTool(mock)("call", { plan: "# Plan" }, undefined, undefined, context.ctx);
	};
	const cases: Array<{ name: string; arrange: Arrange; expected: string }> = [
		{
			name: "planning, plan completed",
			arrange: async (mock, context) => {
				await startPlanning(mock, context);
				await completePlan(mock, context);
			},
			expected: "Plan mode disabled. Proposed plan discarded.",
		},
		{
			name: "planning, nothing completed",
			arrange: async (mock, context) => {
				await startPlanning(mock, context);
			},
			expected: "Plan mode disabled.",
		},
		{
			name: "implementing an active plan",
			arrange: async (mock, context) => {
				await startPlanning(mock, context);
				await completePlan(mock, context);
				await mock.commands.get("plan")?.handler("implement", context.ctx);
			},
			expected: "Active implementation plan cleared.",
		},
		{
			name: "off, with no plan at all",
			arrange: async (mock, context) => {
				await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
			},
			expected: "Plan mode disabled.",
		},
	];

	for (const { name, arrange, expected } of cases) {
		await withAgentDir(async () => {
			const mock = createMockPi({ activeTools: ["read"] });
			planMode(mock.pi);
			const context = createMockContext();
			await arrange(mock, context);

			await mock.commands.get("plan")?.handler("exit", context.ctx);

			assert.equal(context.notifications.at(-1)?.message, expected, name);
			assert.equal(context.statuses.get("plan-mode"), undefined, name);
		});
	}
});

/** The menu's exit is the same decision, so it must produce the same wordings. */
test("the Plan menu's exit item reports what the /plan exit command would", async () => {
	for (const { label, ready, expected } of [
		{
			label: "Discard plan and exit",
			ready: true,
			expected: "Plan mode disabled. Proposed plan discarded.",
		},
		{ label: "Exit Plan mode", ready: false, expected: "Plan mode disabled." },
	]) {
		await withAgentDir(async () => {
			const mock = createMockPi({ activeTools: ["read"] });
			planMode(mock.pi);
			const context = createMockContext({
				hasUI: true,
				mode: "tui",
				select: async (_frame: string, options: string[]) =>
					options.find((option) => option.startsWith(label)),
			});
			await startPlanning(mock, context);
			if (ready) {
				await completeTool(mock)("call", { plan: "# Plan" }, undefined, undefined, context.ctx);
			}

			await mock.commands.get("plan")?.handler("", context.ctx);

			await waitForNotification(context, expected);
			assert.equal(context.statuses.get("plan-mode"), undefined, label);
		});
	}
});

test("bare /plan on an off session opens the launch menu, which can start planning", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async (_frame: string, options: string[]) =>
				options.find((option) => option.startsWith("Start Plan mode")),
		});
		await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);

		await mock.commands.get("plan")?.handler("", context.ctx);

		assert.equal(context.statuses.get("plan-mode"), "◆ plan · drafting");
		assert.match(context.notifications.at(-1)?.message ?? "", /Plan mode enabled/);
	});
});

test("the interactive /plan menu refuses to open without a UI", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext({ hasUI: false });
		await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
		const handler = mock.commands.get("plan")?.handler;
		assert.ok(handler);

		await assert.rejects(
			() => handler("", context.ctx) as Promise<unknown>,
			/unavailable in print and JSON modes/,
		);
	});
});
