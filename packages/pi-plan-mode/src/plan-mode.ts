import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { completePlanArguments } from "./command.js";
import {
	normalizePlanModeCompletion,
	PLAN_MODE_COMPLETE_PARAMS,
	PLAN_MODE_COMPLETE_TOOL_NAME,
	planModeCompleted,
	renderPlanModeCompletion,
} from "./completion-tool.js";
import { isStaleExtensionContextError, onAgentSettled } from "./extension-runtime.js";
import {
	formatImplementationHandoff,
	startFreshImplementationFromState,
} from "./fresh-implementation.js";
import { createLifecycle, type LifecycleScope } from "./lifecycle.js";
import { deletePlanFile, planFilePathForSession, readPlanFile, writePlanFile } from "./plan-file.js";
import { createPlanActionController } from "./plan-action-controller.js";
import { createPlanExportController } from "./plan-export-controller.js";
import {
	clearPlanModeUi,
	planModeStatusText as formatPlanModeStatusText,
	registerPlanModeCardRenderer,
	showPlanModePlan,
	showStoredPlan,
	updatePlanModeUi,
} from "./presentation.js";
import {
	ASK_USER_QUESTION_TOOL,
	buildActivePlanPointer,
	buildPlanModePrompt,
	PLAN_MODE_QUESTION_TOOL,
} from "./prompt.js";
import {
	answerPlanModeQuestions,
	normalizePlanModeQuestionParams,
	PLAN_MODE_QUESTION_PARAMS,
	PLAN_MODE_QUESTION_TOOL_NAME,
	planModeQuestionCancelled,
} from "./question-tool.js";
import {
	awaitPlanModeSettingsWrites,
	type PlanModeSettings,
	planModeSettingsPath,
	readPlanModeSettings,
} from "./settings.js";
import { createSettingsWatcher } from "./settings-watch.js";
import { type PlanModeState, restorePlanModeState } from "./state.js";

const STATE_ENTRY_TYPE = "plan-mode-state";
const ASK_USER_AVAILABILITY_EVENT = "hank:ask-user:availability";
/**
 * Plan mode's entire enforcement surface. Everything else — bash, subagents,
 * MCP, and other extension tools — is left to the session's normal permission
 * layer (for example @hank-warren/pi-auto-permissions), so Plan mode never
 * mutates the active tool set and never fights other extensions for it.
 * Checklist tools (a `todo` extension, for example) are deliberately not
 * blocked: a task list is ephemeral planning scratch, and the planning prompt
 * already steers the model away from execution-progress tooling. (`update_plan`
 * was once listed here; it was a pre-1.0 upstream tool that no longer exists.)
 */
const BLOCKED_TOOLS = new Set(["edit", "write"]);
/** Long enough to collapse one save's burst of filesystem events into one read. */
const SETTINGS_RELOAD_DEBOUNCE_MS = 75;

/**
 * Which question tool the prompt may name this turn, read from the tool set
 * the model will actually see.
 *
 * `null` means neither is active — a headless run, where both interactive
 * tools are deliberately stripped. Naming one there would send the model after
 * a tool it cannot call, so the prompt switches to asking in plain text.
 */
function preferredQuestionTool(pi: ExtensionAPI): string | null {
	const active = pi.getActiveTools();
	if (active.includes(ASK_USER_QUESTION_TOOL)) return ASK_USER_QUESTION_TOOL;
	if (active.includes(PLAN_MODE_QUESTION_TOOL)) return PLAN_MODE_QUESTION_TOOL;
	return null;
}

type InteractiveUi = typeof import("./interactive-ui.js");

interface PlanModeDependencies {
	readSettings?(): ReturnType<typeof readPlanModeSettings>;
	settingsPath?: string;
	loadInteractiveUi?(): Promise<InteractiveUi>;
}

export default function planMode(pi: ExtensionAPI, dependencies: PlanModeDependencies = {}) {
	let interactiveUiPromise: Promise<InteractiveUi> | undefined;
	const loadInteractiveUi = () => {
		if (dependencies.loadInteractiveUi) return dependencies.loadInteractiveUi();
		if (!interactiveUiPromise) {
			interactiveUiPromise = import("./interactive-ui.js").catch((error) => {
				interactiveUiPromise = undefined;
				throw error;
			});
		}
		return interactiveUiPromise;
	};
	let state: PlanModeState = { enabled: false, awaitingAction: false };
	let settings: PlanModeSettings = {};
	let sessionPlanPath: string | undefined;
	let readyPresentationNonce = 0;
	let pendingReadyNonce: number | undefined;
	let latestCommandContext: ExtensionCommandContext | undefined;
	let refreshStateBeforeFirstAgentStart = false;
	const lifecycle = createLifecycle();
	let settingsWatcher: ReturnType<typeof createSettingsWatcher> | undefined;
	let planToolsActivated = false;
	let currentHasUI = false;
	let globalQuestionAvailable = false;
	const persistState = () => pi.appendEntry<PlanModeState>(STATE_ENTRY_TYPE, state);

	const reconcilePlanToolSurface = (hasUI: boolean, availability?: boolean) => {
		currentHasUI = hasUI;
		const active = pi.getActiveTools();
		globalQuestionAvailable = availability ?? (hasUI && active.includes(ASK_USER_QUESTION_TOOL));
		const wanted = new Set(active);
		const completeWanted = planToolsActivated;
		const fallbackWanted = planToolsActivated && hasUI && !globalQuestionAvailable;
		if (completeWanted) wanted.add(PLAN_MODE_COMPLETE_TOOL_NAME);
		else wanted.delete(PLAN_MODE_COMPLETE_TOOL_NAME);
		if (fallbackWanted) wanted.add(PLAN_MODE_QUESTION_TOOL);
		else wanted.delete(PLAN_MODE_QUESTION_TOOL);
		const next = [...wanted];
		if (next.length !== active.length || next.some((name, index) => name !== active[index])) {
			pi.setActiveTools(next);
		}
	};
	const activatePlanTools = (hasUI: boolean) => {
		planToolsActivated = true;
		reconcilePlanToolSurface(hasUI);
	};

	registerPlanModeCardRenderer(pi);
	pi.events.on(ASK_USER_AVAILABILITY_EVENT, (payload: unknown) => {
		const available =
			typeof payload === "object" && payload !== null &&
			typeof (payload as { available?: unknown }).available === "boolean"
				? (payload as { available: boolean }).available
				: undefined;
		if (available !== undefined) reconcilePlanToolSurface(currentHasUI, available);
	});
	const planExports = createPlanExportController({
		getState: () => state,
		getSettings: () => settings,
		finishReady: (ctx) => {
			void exitPlanMode(ctx, { keepPlanFile: true });
		},
	});
	const planActions = createPlanActionController({
		loadInteractiveUi,
		getState: () => state,
		captureLifecycle: () => lifecycle.capture(),
		statusText: planStatusText,
		planPathLine: () => (state.planPath ? `Plan file: ${state.planPath}` : undefined),
		getExportDestination: (ctx) => planExports.getDestination(ctx),
		show: (ctx) => showStoredPlan(pi, ctx, state),
		finalize: requestFinalPlan,
		implementHere: startImplementation,
		implementFresh: startFreshImplementation,
		exportPlan: (ctx, path, signal, isCurrent) => planExports.export(path, ctx, signal, isCurrent),
		stay: updateUi,
		exitReady: (ctx) => {
			// Same had-plan branching as the /plan exit command: the menu must not
			// claim a plan was discarded when none was ever completed.
			const text =
				state.planPath !== undefined
					? "Plan mode disabled. Proposed plan discarded."
					: "Plan mode disabled.";
			void exitAndNotify(ctx, text);
		},
	});

	pi.registerFlag("plan", {
		description: "Start in Plan mode",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: PLAN_MODE_QUESTION_TOOL_NAME,
		label: "Plan question",
		description:
			"Ask the user one to three Plan-mode clarification questions with meaningful options, then wait for the answer. Only available while Plan mode is active.",
		// Kept, now that the tool is staged: this guidance reaches the model only
		// in a session that has actually entered Plan mode.
		promptSnippet: "Ask user decision questions while Plan mode is active",
		promptGuidelines: [
			"In Plan mode, use plan_mode_question for important preferences, tradeoffs, or assumptions that cannot be discovered from read-only exploration.",
		],
		parameters: PLAN_MODE_QUESTION_PARAMS,
		async execute(_toolCallId, params: unknown, signal, _onUpdate, ctx) {
			if (!state.enabled) {
				return planModeQuestionCancelled(
					[],
					"plan_mode_inactive",
					"Error: plan_mode_question is only available while Plan mode is active.",
				);
			}

			const parsed = normalizePlanModeQuestionParams(params);
			if (!parsed.ok) {
				return planModeQuestionCancelled([], "invalid_input", `Error: ${parsed.error}`);
			}

			if (!ctx.hasUI) {
				return planModeQuestionCancelled(
					parsed.questions,
					"ui_unavailable",
					"Unable to ask Plan-mode questions because interactive UI is not available.",
				);
			}

			const menu = lifecycle.capture();
			const questionSignal = signal ? AbortSignal.any([signal, menu.signal]) : menu.signal;
			return answerPlanModeQuestions(
				parsed.questions,
				ctx,
				{ isCurrent: menu.isCurrent, isEnabled: () => state.enabled },
				questionSignal,
			);
		},
	});

	pi.registerTool({
		name: PLAN_MODE_COMPLETE_TOOL_NAME,
		label: "Complete plan",
		description:
			"Submit the complete decision-ready implementation plan for user review. Only available while Plan mode is active, and must be the final standalone action.",
		promptSnippet: "Submit the final Plan-mode implementation plan",
		promptGuidelines: [
			"Call plan_mode_complete alone as the final action only after the implementation plan is decision-complete.",
		],
		parameters: PLAN_MODE_COMPLETE_PARAMS,
		renderResult: renderPlanModeCompletion,
		async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				throw new Error("plan_mode_complete is only available while Plan mode is active");
			}
			const parsed = normalizePlanModeCompletion(params);
			if (!parsed.ok) throw new Error(parsed.error);

			const planPath = await acceptCompletedPlan(parsed.plan, ctx);
			return planModeCompleted(parsed.plan, planPath);
		},
	});

	// Registered tools remain available for transcript replay; the active set is
	// narrowed at session_start rather than here, because Pi refuses action
	// methods (getActiveTools/setActiveTools) during extension loading.

	pi.registerCommand("plan", {
		description: "Enter or manage Plan mode",
		getArgumentCompletions: completePlanArguments,
		handler: async (args, ctx) => {
			latestCommandContext = ctx;
			const prompt = args.trim();
			const command = prompt.toLowerCase();
			if (command === "start") {
				if (state.enabled) {
					ctx.ui.notify("Plan mode is already active.", "info");
					return;
				}
				enterPlanMode(ctx);
				notifyEnabled(ctx);
				return;
			}
			if (command === "show") {
				await showStoredPlan(pi, ctx, state);
				return;
			}
			if (command === "finalize") {
				requestFinalPlan(ctx);
				return;
			}
			if (command === "implement") {
				if (!(await currentPlan())) {
					ctx.ui.notify("No completed plan is available to implement.", "warning");
					return;
				}
				await startImplementation(ctx);
				return;
			}
			const exportMatch = /^export(?:\s+([\s\S]+))?$/iu.exec(prompt);
			if (exportMatch) {
				const menu = lifecycle.capture();
				await planExports.export(exportMatch[1], ctx, menu.signal, menu.isCurrent);
				return;
			}
			if (command === "exit" || command === "off") {
				const hadPlan = state.planPath !== undefined;
				const notification = state.enabled
					? hadPlan
						? "Plan mode disabled. Proposed plan discarded."
						: "Plan mode disabled."
					: hadPlan
						? "Active implementation plan cleared."
						: "Plan mode disabled.";
				await exitAndNotify(ctx, notification);
				return;
			}
			if (prompt) {
				enterPlanModeWithPrompt(prompt, ctx);
				return;
			}
			if (!ctx.hasUI) {
				throw new Error(
					"The interactive /plan menu is unavailable in print and JSON modes. Use /plan start or /plan <prompt>.",
				);
			}
			if (!state.enabled && state.planPath) {
				await showActivePlanMenu(ctx);
				return;
			}
			if (!state.enabled) {
				await showLaunchMenu(ctx);
				return;
			}
			await planActions.showCurrent(ctx);
		},
	});

	const readRuntimeSettings = () =>
		dependencies.readSettings?.() ?? readPlanModeSettings(dependencies.settingsPath);

	/**
	 * `ctx` present means this is the session-start load: problems are reported
	 * and anything unusable falls back to defaults.
	 *
	 * `ctx` absent means a watch-triggered reload, which keeps the last good
	 * settings when the file no longer parses. A hand-edit is observed the moment
	 * the editor touches the file, so an invalid read is usually a half-written
	 * save rather than intent — discarding a working export path for it, with no
	 * `ctx` to explain why, would be worse than waiting for the next write. A
	 * genuinely broken file is still reported at the next session start.
	 */
	const loadPlanModeSettings = async (session: LifecycleScope, ctx?: ExtensionContext) => {
		const loaded = await readRuntimeSettings();
		if (!session.isCurrent()) return;
		if (loaded.kind === "invalid" && !ctx) return;
		settings = loaded.kind === "loaded" ? loaded.settings : {};
		if (!ctx) return;
		if (loaded.kind === "invalid") {
			ctx.ui.notify(`pi-plan-mode settings ignored: ${loaded.reason}`, "warning");
		}
	};

	const stopPlanModeSettingsWatch = () => {
		settingsWatcher?.stop();
		settingsWatcher = undefined;
	};

	/** An injected reader is the only source there is, so it is never watched. */
	const startPlanModeSettingsWatch = (session: LifecycleScope) => {
		stopPlanModeSettingsWatch();
		if (dependencies.readSettings) return;
		settingsWatcher = createSettingsWatcher({
			path: dependencies.settingsPath ?? planModeSettingsPath(),
			debounceMs: SETTINGS_RELOAD_DEBOUNCE_MS,
			onChange: () => void loadPlanModeSettings(session),
		});
		settingsWatcher.start();
	};

	pi.on("session_start", async (event, ctx) => {
		const session = lifecycle.nextSession("Plan-mode session replaced");
		planToolsActivated = false;
		currentHasUI = ctx.hasUI;
		reconcilePlanToolSurface(ctx.hasUI);
		refreshStateBeforeFirstAgentStart = event.reason === "new";
		pendingReadyNonce = undefined;
		latestCommandContext = undefined;
		settings = {};
		sessionPlanPath = resolveSessionPlanPath(ctx);
		restoreState(ctx);
		await loadPlanModeSettings(session, ctx);
		if (!session.isCurrent()) return;
		startPlanModeSettingsWatch(session);
		const persistFlagActivation = pi.getFlag("plan") === true && !state.enabled;
		if (persistFlagActivation) {
			state = { ...state, enabled: true, awaitingAction: state.planPath !== undefined };
		}
		if (persistFlagActivation) persistState();
		if (state.enabled) activatePlanTools(ctx.hasUI);
		updateUi(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// No re-arm: nothing may become current again until a session_start.
		lifecycle.endSession("Plan-mode session shut down");
		stopPlanModeSettingsWatch();
		pendingReadyNonce = undefined;
		latestCommandContext = undefined;
		refreshStateBeforeFirstAgentStart = false;
		await awaitPlanModeSettingsWrites(dependencies.settingsPath);
		persistState();
		clearUi(ctx);
	});

	/**
	 * The complete enforcement surface: two static built-in names. Plan mode
	 * does not classify, inspect, or filter any other tool.
	 */
	pi.on("tool_call", async (event) => {
		if (!state.enabled) return;
		if (!BLOCKED_TOOLS.has(event.toolName)) return;
		return {
			block: true,
			reason: `Plan mode blocks '${event.toolName}' because planning must not mutate files. Finish the plan with plan_mode_complete, then implement.`,
		};
	});

	pi.on("before_agent_start", (event, ctx) => {
		currentHasUI = ctx.hasUI;
		if (refreshStateBeforeFirstAgentStart) {
			refreshStateBeforeFirstAgentStart = false;
			restoreState(ctx);
			updateUi(ctx);
		}
		if (state.enabled && state.awaitingAction) {
			// A new turn supersedes the previous ready plan: revision feedback
			// re-opens planning until another plan_mode_complete arrives.
			pendingReadyNonce = undefined;
			setState(ctx, { awaitingAction: false });
		}
		if (state.enabled && !planToolsActivated) activatePlanTools(ctx.hasUI);
		else reconcilePlanToolSurface(ctx.hasUI);
		// A headless run has no legitimate question tool, whatever the active set
		// still says: pi-ask-user-question strips its own tool on this same hook,
		// and hook order between the two packages is not ours to depend on.
		const questionTool = ctx.hasUI ? preferredQuestionTool(pi) : null;
		if (state.enabled) {
			return { systemPrompt: `${event.systemPrompt}\n\n${buildPlanModePrompt(questionTool)}` };
		}
		// Pointer, not payload: an active plan costs one line of context no matter
		// how large the plan is, and survives compaction for free.
		if (state.planPath) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${buildActivePlanPointer(state.planPath)}`,
			};
		}
	});

	onAgentSettled(pi, async (_event, ctx) => {
		const nonce = pendingReadyNonce;
		if (nonce === undefined || nonce !== readyPresentationNonce) return;
		if (!state.enabled || !state.awaitingAction) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

		pendingReadyNonce = undefined;
		try {
			if (ctx.hasUI) await planActions.showReady(latestCommandContext ?? ctx);
		} catch (error: unknown) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	});

	function enterPlanMode(ctx: ExtensionContext) {
		lifecycle.nextWorkflow();
		activatePlanTools(ctx.hasUI);
		setState(ctx, { enabled: true, awaitingAction: false });
	}

	function enterPlanModeWithPrompt(prompt: string, ctx: ExtensionContext) {
		const previousState = state;
		const wasEnabled = state.enabled;
		enterPlanMode(ctx);
		if (!wasEnabled) notifyEnabled(ctx);
		sendOrRevert(prompt, ctx, previousState);
	}

	async function exitPlanMode(ctx: ExtensionContext, options: { keepPlanFile?: boolean } = {}) {
		lifecycle.nextWorkflow();
		const planPath = state.planPath;
		pendingReadyNonce = undefined;
		setState(ctx, { enabled: false, planPath: undefined, awaitingAction: false });
		if (planPath && !options.keepPlanFile) await deletePlanFile(planPath);
	}

	/** Leaves Plan mode and reports it in one step, for menus and /plan alike. */
	function exitAndNotify(
		ctx: ExtensionContext,
		text: string,
		options: { keepPlanFile?: boolean } = {},
	) {
		return exitPlanMode(ctx, options).then(() => ctx.ui.notify(text, "info"));
	}

	function notifyEnabled(ctx: ExtensionContext) {
		ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
	}

	/** State moves as one: what is remembered, what is persisted, what is shown. */
	function setState(ctx: ExtensionContext, patch: Partial<PlanModeState>) {
		state = { ...state, ...patch };
		persistState();
		updateUi(ctx);
	}

	/**
	 * Sends the message a state change exists to produce, and puts the previous
	 * state back when the session refuses it: a mode switch the model was never
	 * told about is worse than no switch at all.
	 */
	function sendOrRevert(message: string, ctx: ExtensionContext, previousState: PlanModeState) {
		if (sendPlanModeUserMessage(message, ctx)) return;
		setState(ctx, previousState);
	}

	function sendPlanModeUserMessage(message: string, ctx: ExtensionContext) {
		try {
			if (ctx.isIdle()) pi.sendUserMessage(message);
			else pi.sendUserMessage(message, { deliverAs: "followUp" });
			return true;
		} catch (error: unknown) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Unable to send Plan-mode message: ${detail}`, "error");
			return false;
		}
	}

	/**
	 * Writes the durable plan file and marks the plan ready. A write failure
	 * keeps Plan mode active rather than silently losing the plan.
	 */
	async function acceptCompletedPlan(plan: string, ctx: ExtensionContext): Promise<string> {
		const planPath = sessionPlanPath ?? resolveSessionPlanPath(ctx);
		try {
			await writePlanFile(planPath, plan);
		} catch (error: unknown) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Unable to save the plan to ${planPath}: ${detail}`);
		}
		sessionPlanPath = planPath;
		pendingReadyNonce = ++readyPresentationNonce;
		setState(ctx, { planPath, awaitingAction: true });
		showPlanModePlan(pi, ctx, "Proposed Plan", plan);
		return planPath;
	}

	async function currentPlan() {
		return state.planPath ? await readPlanFile(state.planPath) : undefined;
	}

	function requestFinalPlan(ctx: ExtensionContext) {
		if (!state.enabled) {
			ctx.ui.notify("Plan mode is not active. Use /plan first.", "warning");
			return;
		}
		// Same rule as the prompt: a headless run has no question tool to name.
		const questionTool = ctx.hasUI ? preferredQuestionTool(pi) : null;
		sendPlanModeUserMessage(
			`Finalize the current implementation plan now. If any material decision remains, ${
				questionTool === null ? "ask it in plain text" : `use ${questionTool}`
			} instead. Otherwise call plan_mode_complete alone as your final action with the complete decision-ready plan.`,
			ctx,
		);
	}

	async function startFreshImplementation(ctx: ExtensionContext, menuIsCurrent: () => boolean) {
		await startFreshImplementationFromState(ctx, {
			getState: () => state,
			menuIsCurrent,
			stateEntryType: STATE_ENTRY_TYPE,
		});
	}

	async function startImplementation(ctx: ExtensionContext) {
		const planPath = state.planPath;
		const plan = await currentPlan();
		if (!planPath || !plan) {
			ctx.ui.notify("No completed plan is available to implement.", "warning");
			return;
		}

		lifecycle.nextWorkflow();
		const previousState = state;
		pendingReadyNonce = undefined;
		setState(ctx, { enabled: false, awaitingAction: false, planPath });
		sendOrRevert(formatImplementationHandoff(planPath), ctx, previousState);
	}

	async function showLaunchMenu(ctx: ExtensionContext) {
		const menu = lifecycle.capture();
		if (!menu.isCurrent() || menu.signal.aborted) return;
		const ui = await loadInteractiveUi();
		if (!menu.isCurrent() || menu.signal.aborted) return;
		await ui.showPlanLaunchMenu(ctx, {
			statusText: "Status: Off.",
			signal: menu.signal,
			isCurrent: menu.isCurrent,
			start: (signal) => {
				if (signal.aborted || !menu.isCurrent()) return;
				enterPlanMode(ctx);
				notifyEnabled(ctx);
			},
			settings: (signal) => showSettings(ctx, signal, menu.isCurrent),
		});
	}

	async function showActivePlanMenu(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify(planStatusText(), "info");
			return;
		}
		const menu = lifecycle.capture();
		if (!menu.isCurrent() || menu.signal.aborted) return;
		const ui = await loadInteractiveUi();
		if (!menu.isCurrent() || menu.signal.aborted) return;
		await ui.showActiveImplementationMenu(ctx, {
			statusText: planStatusText(),
			...(state.planPath ? { planPathLine: `Plan file: ${state.planPath}` } : {}),
			getExportDestination: () => planExports.getDestination(ctx),
			signal: menu.signal,
			isCurrent: menu.isCurrent,
			show: () => showStoredPlan(pi, ctx, state),
			exportPlan: (path, signal) => planExports.export(path, ctx, signal, menu.isCurrent),
			settings: (signal) => showSettings(ctx, signal, menu.isCurrent),
			startNew: () => {
				enterPlanMode(ctx);
				notifyEnabled(ctx);
			},
			clear: () => {
				void exitAndNotify(ctx, "Active implementation plan cleared.");
			},
		});
	}

	async function showSettings(
		ctx: ExtensionContext,
		signal: AbortSignal,
		isCurrent: () => boolean,
	) {
		if (!isCurrent() || signal.aborted) return false;
		const ui = await loadInteractiveUi();
		if (!isCurrent() || signal.aborted) return false;
		const result = await ui.showPlanModeSettings(ctx, {
			signal,
			isCurrent,
			settingsPath: dependencies.settingsPath,
			onSaved: (saved) => {
				if (isCurrent()) settings = saved;
			},
			...(dependencies.readSettings
				? { readSettings: async () => dependencies.readSettings?.() ?? { kind: "missing" } }
				: {}),
		});
		return result.kind === "closed" && "reason" in result && result.reason === "close";
	}

	function resolveSessionPlanPath(ctx: ExtensionContext) {
		try {
			return planFilePathForSession(ctx.sessionManager.getSessionId());
		} catch {
			return planFilePathForSession(undefined);
		}
	}

	function restoreState(ctx: ExtensionContext) {
		state = restorePlanModeState(ctx.sessionManager.getBranch(), STATE_ENTRY_TYPE);
	}

	function updateUi(ctx: ExtensionContext) {
		updatePlanModeUi(ctx, state);
	}

	function clearUi(ctx: ExtensionContext) {
		clearPlanModeUi(ctx);
	}

	function planStatusText() {
		return formatPlanModeStatusText(state);
	}
}

export { completePlanArguments } from "./command.js";
export { planFilePathForSession, plansDirectory } from "./plan-file.js";
export { buildActivePlanPointer, buildPlanModePrompt } from "./prompt.js";
export { normalizePlanModeQuestionParams } from "./question-tool.js";
export { normalizePlanModeSettings, readPlanModeSettings } from "./settings.js";
