import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { completePlanArguments } from "./command.js";
import { createTaskIntegration, taskCounts } from "./task-integration.js";
import { TASK_STATUS, object, revision as validTaskRevision, validBinding, sameBinding } from "./plan-contract.js";
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
import {
	PLAN_IMPLEMENTED_DESCRIPTION,
	PLAN_IMPLEMENTED_GUIDELINE,
	PLAN_IMPLEMENTED_PARAMS,
	PLAN_IMPLEMENTED_TOOL_NAME,
	planImplementedResult,
} from "./implemented-tool.js";
import {
	archivePlanFile,
	deletePlanFile,
	latestArchiveFor,
	planFilePathForSession,
	readPlanFile,
	writePlanFile,
} from "./plan-file.js";
import { createPlanActionController } from "./plan-action-controller.js";
import {
	approvalRecoveryInstruction,
	canConfirmPlanFile,
	completionRefusal,
	type PlanApproval,
	evaluatePlanApproval,
	managedCompletionRefusal,
	mutationRefusal,
	REVISION_IN_PROGRESS_REFUSAL,
} from "./plan-approval.js";
import { createPlanExportController } from "./plan-export-controller.js";
import { createPlanRevisionController } from "./plan-revision-controller.js";
import {
	clearPlanModeUi,
	planModeStatusText as formatPlanModeStatusText,
	registerPlanModeCardRenderer,
	showPlanModePlan,
	showStoredPlan,
	type PlanModeViewDetail,
	updatePlanModeUi,
} from "./presentation.js";
import {
	ASK_USER_QUESTION_TOOL,
	buildActivePlanPointer,
	buildPlanModePrompt,
	PLAN_MODE_QUESTION_TOOL,
} from "./prompt.js";
import {
	normalizeUpdatePlan,
	UPDATE_PLAN_DESCRIPTION,
	UPDATE_PLAN_GUIDELINES,
	UPDATE_PLAN_PARAMS,
	UPDATE_PLAN_SNIPPET,
	UPDATE_PLAN_TOOL_NAME,
	updatePlanFailure,
	updatePlanToolResult,
} from "./update-plan-tool.js";
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
import { PLAN_STATE_SCHEMA_VERSION, type PlanModeState, restorePlanModeState } from "./state.js";

const STATE_ENTRY_TYPE = "plan-mode-state";
const ASK_USER_AVAILABILITY_EVENT = "hank:ask-user:availability";
/** Label Herdr shows while `plan_mode_question` waits; distinguishes it from an approval. */
export const HERDR_BLOCKED_LABEL = "plan question";
/**
 * Label Herdr shows while the "Proposed plan ready. What next?" menu waits.
 * That menu opens after the drafting turn settles, so without a signal Herdr
 * reported the pane idle while it was waiting on a human to pick implement /
 * export / discard. A distinct label lets a supervisor tell "plan awaiting a
 * decision" from a mid-draft question.
 */
export const HERDR_READY_BLOCKED_LABEL = "plan ready";

/**
 * Tell Herdr this pane is waiting on a human, so a supervising agent in another
 * pane sees the block instead of reading a stalled turn as progress. Same
 * contract as pi-auto-permissions' `setHerdrBlocked`, duplicated rather than
 * imported so Plan mode has no dependency on the permissions engine. No-op
 * outside Herdr.
 */
function setHerdrBlocked(pi: ExtensionAPI, active: boolean, label: string): void {
	if (process.env.HERDR_ENV !== "1") return;
	pi.events.emit("herdr:blocked", active ? { active: true, label } : { active: false });
}
/**
 * Plan mode's entire enforcement surface. Everything else — bash, subagents,
 * MCP, and other extension tools — is left to the session's normal permission
 * layer (for example @hank-warren/pi-auto-permissions), so Plan mode never
 * mutates the active tool set and never fights other extensions for it.
 * Checklist tools (a `todo` extension, for example) are deliberately not
 * blocked: a task list is ephemeral planning scratch, and the planning prompt
 * already steers the model away from execution-progress tooling.
 *
 * This is also the enforcement surface for a revision: `update_plan(begin)`
 * re-enables Plan mode, so from the next tool call onward the model cannot edit
 * files while it is changing the plan. Work already in flight when begin lands
 * is not undone — a tool call that has started has started.
 *
 * The same set is what the implementation-time digest guard judges, so "which
 * tools does Plan mode consider a mutation" has one answer and one spelling.
 * Bash is not in it on purpose: Plan mode cannot tell which command writes, and
 * that classification belongs to the session's permission layer.
 */
const MUTATING_TOOLS = new Set(["edit", "write"]);
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
	/** The revision store root. Defaults to `<agentDir>/plans/.revisions`. */
	revisionsRoot?(): string;
	now?(): string;
	newId?(): string;
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
	/**
	 * Staged like the planning tools: added when implementation starts and never
	 * removed for the rest of the session, so "done" costs a pointer-line change
	 * and nothing more. The tool refuses to run when no plan is active.
	 */
	let implementedToolActivated = false;
	/**
	 * Staged alongside the others, as soon as a plan file exists: `update_plan` is
	 * the only way a ready or implementing plan changes, so it has to be in the
	 * tool set before the first turn that could want it.
	 */
	let updatePlanToolActivated = false;
	let currentHasUI = false;
	let globalQuestionAvailable = false;
	/**
	 * What the widget and the menus cannot derive from state alone, because it is a
	 * comparison against the file on disk. Refreshed at session start and at every
	 * turn boundary, and deliberately not persisted: it is a reading, not a fact.
	 */
	let viewDetail: PlanModeViewDetail = {};
	/**
	 * The approval the visible state was derived from.
	 *
	 * The notice alone cannot answer "is there anything the user can do about it":
	 * a missing file and a stale digest both produce a notice, and only one of them
	 * can be confirmed. The menu keys its Confirm item on this.
	 */
	let viewApproval: PlanApproval = { kind: "none" };
	const persistState = () => pi.appendEntry<PlanModeState>(STATE_ENTRY_TYPE, state);

	/**
	 * The active set grows at two moments in a plan's life: entering Plan mode
	 * (the planning tools are staged) and starting implementation
	 * (plan_implemented is staged). Both already rewrite the system prompt, so
	 * neither costs a prompt-cache miss the lifecycle was not paying anyway, and
	 * staged tools are never withdrawn. The one thing that can move outside
	 * those moments is the plan_mode_question fallback, which follows
	 * ask_user_question's availability (a headless turn, or that package being
	 * installed or removed mid-session) — rare, and predating this design.
	 * Everything else here is a no-op that preserves the existing order.
	 */
	const reconcilePlanToolSurface = (hasUI: boolean, availability?: boolean) => {
		currentHasUI = hasUI;
		const active = pi.getActiveTools();
		globalQuestionAvailable = availability ?? (hasUI && active.includes(ASK_USER_QUESTION_TOOL));
		const wanted = new Set(active);
		const completeWanted = planToolsActivated;
		const fallbackWanted = planToolsActivated && hasUI && !globalQuestionAvailable;
		const implementedWanted = implementedToolActivated;
		if (completeWanted) wanted.add(PLAN_MODE_COMPLETE_TOOL_NAME);
		else wanted.delete(PLAN_MODE_COMPLETE_TOOL_NAME);
		if (fallbackWanted) wanted.add(PLAN_MODE_QUESTION_TOOL);
		else wanted.delete(PLAN_MODE_QUESTION_TOOL);
		if (implementedWanted) wanted.add(PLAN_IMPLEMENTED_TOOL_NAME);
		else wanted.delete(PLAN_IMPLEMENTED_TOOL_NAME);
		if (updatePlanToolActivated) wanted.add(UPDATE_PLAN_TOOL_NAME);
		else wanted.delete(UPDATE_PLAN_TOOL_NAME);
		const next = [...wanted];
		if (next.length !== active.length || next.some((name, index) => name !== active[index])) {
			pi.setActiveTools(next);
		}
	};
	const activatePlanTools = (hasUI: boolean) => {
		planToolsActivated = true;
		reconcilePlanToolSurface(hasUI);
	};
	const activateImplementedTool = (hasUI: boolean) => {
		implementedToolActivated = true;
		updatePlanToolActivated = true;
		reconcilePlanToolSurface(hasUI);
	};
	const activateUpdatePlanTool = (hasUI: boolean) => {
		if (updatePlanToolActivated) return;
		updatePlanToolActivated = true;
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
	let tasksUiContext: ExtensionContext | undefined;
	pi.events.on(TASK_STATUS, (raw: unknown) => {
		const ctx = tasksUiContext;
		if (!ctx || !object(raw) || raw.version !== 1 || raw.sessionId !== ctx.sessionManager.getSessionId() || raw.taskSetId !== state.taskTracking?.taskSetId || !object(raw.counts)) return;
		const expected = state.planId && state.specRevision && state.currentDigest ? { planId: state.planId, specRevision: state.specRevision, digest: state.currentDigest } : undefined;
		if (!validBinding(raw.binding) || !sameBinding(raw.binding, expected)) return;
		const { open, completed, abandoned } = raw.counts;
		if (validTaskRevision(open) && validTaskRevision(completed) && validTaskRevision(abandoned)) ctx.ui.setStatus("plan-tasks", `tasks · ${open} open · ${completed} done · ${abandoned} abandoned`);
	});
	const taskIntegration = createTaskIntegration(pi, { getState: () => state, setState: (ctx, patch) => setState(ctx, patch), capture: () => lifecycle.capture() });
	const revisions = createPlanRevisionController({
		tasks: taskIntegration,
		loadInteractiveUi,
		getState: () => state,
		setState: (ctx, patch) => setState(ctx, patch),
		capture: () => lifecycle.capture(),
		nextWorkflow: () => lifecycle.nextWorkflow(),
		markReady: (ctx, title, plan) => markPlanReady(ctx, title, plan),
		showCard: (ctx, title, body) => showPlanModePlan(pi, ctx, title, body),
		sendToAgent: (ctx, message) => {
			sendPlanModeUserMessage(message, ctx);
		},
		...(dependencies.revisionsRoot ? { root: dependencies.revisionsRoot } : {}),
		...(dependencies.now ? { now: dependencies.now } : {}),
		...(dependencies.newId ? { newId: dependencies.newId } : {}),
	});
	const planActions = createPlanActionController({
		loadInteractiveUi,
		getState: () => state,
		captureLifecycle: () => lifecycle.capture(),
		statusText: planStatusText,
		// Asks the controller, not state: a candidate written by an interrupted turn
		// exists on disk before its id reaches the session entry, and the menu item has
		// to offer the review that `reviewPendingRevision` can in fact open.
		hasPendingRevision: () => revisions.hasPendingProposal(),
		reviewRevision: (ctx) => revisions.reviewPendingRevision(ctx),
		cancelRevision: (ctx) => revisions.cancelRevision(ctx),
		planPathLine: () => (state.planPath ? `Plan file: ${state.planPath}` : undefined),
		getExportDestination: (ctx) => planExports.getDestination(ctx),
		show: (ctx) => showStoredPlan(pi, ctx, state),
		finalize: requestFinalPlan,
		implementHere: startImplementation,
		implementFresh: startFreshImplementation,
		exportPlan: (ctx, path, signal, isCurrent) => planExports.export(path, ctx, signal, isCurrent),
		stay: updateUi,
		// One exit, so the menu and the typed command cannot disagree about whether a
		// plan was a discarded draft or an agreed baseline kept.
		exitReady: (ctx) => {
			void exitPlanModeCommand(ctx);
		},
		onReadyBlocked: (active) => setHerdrBlocked(pi, active, HERDR_READY_BLOCKED_LABEL),
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
			"Ask the user one to three Plan mode clarification questions with meaningful options, then wait for the answer. Only available while Plan mode is active.",
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
					"Unable to ask Plan mode questions because interactive UI is not available.",
				);
			}

			const menu = lifecycle.capture();
			const questionSignal = signal ? AbortSignal.any([signal, menu.signal]) : menu.signal;
			return answerPlanModeQuestions(
				parsed.questions,
				ctx,
				{
					isCurrent: menu.isCurrent,
					isEnabled: () => state.enabled,
					onBlocked: (active) => setHerdrBlocked(pi, active, HERDR_BLOCKED_LABEL),
				},
				questionSignal,
			);
		},
	});

	pi.registerTool({
		name: PLAN_MODE_COMPLETE_TOOL_NAME,
		label: "Complete plan",
		description:
			"Submit the complete decision-ready implementation plan for user review. Only available while Plan mode is active, and must be the final standalone action.",
		promptSnippet: "Submit the final Plan mode implementation plan",
		promptGuidelines: [
			"Call plan_mode_complete alone as the final action only after the implementation plan is decision-complete.",
			"When get_tasks is available, include tasks.phases with the initial plan. Derive the phases and task contents from the plan; the user should not write a task list or assign IDs.",
		],
		parameters: PLAN_MODE_COMPLETE_PARAMS,
		renderResult: renderPlanModeCompletion,
		async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				throw new Error("plan_mode_complete is only available while Plan mode is active");
			}
			// A plan with managed history has a base revision and a digest behind it,
			// and plan_mode_complete has neither. Refused here *and* in the shared write
			// path below, so no other caller can reach it either.
			const managedRefusal = managedCompletionRefusal(state);
			if (managedRefusal) throw new Error(managedRefusal);
			const parsed = normalizePlanModeCompletion(params);
			if (!parsed.ok) throw new Error(parsed.error);

			if (taskIntegration.present() && !parsed.tasks) throw new Error("Provide tasks.phases with this initial plan so the user can approve the plan and task scope together.");
			if (parsed.tasks && !taskIntegration.present()) throw new Error("Task seed supplied but pi-tasks is unavailable");
			if (parsed.tasks?.phases.some((p) => p.id || p.tasks.some((t) => t.id || t.reopen))) throw new Error("Initial task seeds allocate IDs; do not provide existing IDs or reopen flags");
			const planPath = await acceptCompletedPlan(parsed.plan, ctx);
			if (parsed.tasks) {
				const scope = lifecycle.capture();
				const identity = await revisions.ensureIdentity(ctx, { ...scope, isStale: () => !scope.isCurrent() || scope.signal.aborted }, "initial plan with task seed");
				if (!scope.isCurrent() || !identity.ok) throw new Error("Initial task plan identity could not be recorded");
				await taskIntegration.preview(ctx, parsed.tasks);
				if (!scope.isCurrent()) throw new Error("session moved on during initial task preview");
				setState(ctx, { taskTracking: { taskSetId: identity.planId, seed: parsed.tasks, pending: true } });
			}
			return planModeCompleted(parsed.plan, planPath, parsed.tasks);
		},
	});

	pi.registerTool({
		name: UPDATE_PLAN_TOOL_NAME,
		label: "Update plan",
		description: UPDATE_PLAN_DESCRIPTION,
		promptSnippet: UPDATE_PLAN_SNIPPET,
		promptGuidelines: [...UPDATE_PLAN_GUIDELINES],
		parameters: UPDATE_PLAN_PARAMS,
		async execute(_toolCallId, params: unknown, signal, _onUpdate, ctx) {
			currentHasUI = ctx.hasUI;
			if (!state.planPath) {
				return updatePlanToolResult(
					updatePlanFailure(
						"no_plan",
						state.enabled
							? "No plan exists yet in this session, so there is nothing to revise. Finish the first draft and submit it with plan_mode_complete instead."
							: `No plan exists in this session. ${UPDATE_PLAN_TOOL_NAME} only revises a plan that already exists; tell the user they can start one with /plan.`,
					),
				);
			}
			const parsed = normalizeUpdatePlan(params);
			if (!parsed.ok) {
				return updatePlanToolResult(updatePlanFailure("invalid_input", parsed.error));
			}
			// Esc must close the review card, so the tool's own abort travels with the
			// call rather than being dropped at this boundary.
			const outcome =
				parsed.input.action === "begin"
					? await revisions.begin(parsed.input, ctx, signal)
					: await revisions.propose(parsed.input, ctx, signal);
			if (parsed.input.action === "begin" && !outcome.isError) {
				try { Object.assign(outcome.payload, await taskIntegration.describe(ctx)); }
				catch (error) {
					return updatePlanToolResult({ isError: true, payload: {
						...outcome.payload, status: "tasks_unavailable", message: String(error),
					} });
				}
			}
			return updatePlanToolResult(outcome);
		},
	});

	pi.registerTool({
		name: PLAN_IMPLEMENTED_TOOL_NAME,
		label: "Plan implemented",
		description: PLAN_IMPLEMENTED_DESCRIPTION,
		promptSnippet: "Mark the approved plan as implemented",
		promptGuidelines: [PLAN_IMPLEMENTED_GUIDELINE],
		parameters: PLAN_IMPLEMENTED_PARAMS,
		async execute(_toolCallId, _params: unknown, _signal, _onUpdate, ctx) {
			// A revision of an implementing plan is a plan that *is* being implemented,
			// paused. Naming it before the generic refusal is what stops the model being
			// told there is no plan while it is holding that plan's revision id.
			if (state.revision && state.planPath) throw new Error(REVISION_IN_PROGRESS_REFUSAL);
			if (state.enabled || !state.planPath) {
				throw new Error("plan_implemented is only available while an approved plan is being implemented");
			}
			// One guarded path: the tool, `/plan done` and the menu item all ask the
			// same question about the same bytes before anything is archived.
			//
			// The scope is captured *before* the gate, because the gate reads the plan
			// file and the session can be replaced across that await. Without this the
			// supersession would be invisible: `finishImplementation` advances the
			// workflow itself, so by the time it captured a scope the replacement would
			// already look current and a stale call would report success.
			const scope = lifecycle.capture();
			const refusal = await completionGate(ctx);
			if (!scope.isCurrent()) {
				throw new Error("plan_implemented was superseded: the session moved on before the plan was archived");
			}
			if (refusal) throw new Error(refusal);
			const result = await finishImplementation(ctx);
			if (result.kind === "stale") {
				throw new Error("plan_implemented was superseded: the session moved on before the plan was archived");
			}
			return planImplementedResult(result.archivePath);
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
			if (command === "done") {
				await markImplemented(ctx);
				return;
			}
			const exportMatch = /^export(?:\s+([\s\S]+))?$/iu.exec(prompt);
			if (exportMatch) {
				const menu = lifecycle.capture();
				await planExports.export(exportMatch[1], ctx, menu.signal, menu.isCurrent);
				return;
			}
			if (command === "exit" || command === "off") {
				await exitPlanModeCommand(ctx);
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
		tasksUiContext = ctx;
		const session = lifecycle.nextSession("Plan mode session replaced");
		planToolsActivated = false;
		implementedToolActivated = false;
		updatePlanToolActivated = false;
		currentHasUI = ctx.hasUI;
		reconcilePlanToolSurface(ctx.hasUI);
		refreshStateBeforeFirstAgentStart = event.reason === "new";
		pendingReadyNonce = undefined;
		latestCommandContext = undefined;
		settings = {};
		clearApprovalView();
		revisions.reset();
		sessionPlanPath = resolveSessionPlanPath(ctx);
		restoreState(ctx);
		await loadPlanModeSettings(session, ctx);
		if (!session.isCurrent()) return;
		await reconcileMissingPlan(ctx);
		if (!session.isCurrent()) return;
		// The one repair Plan mode performs on its own: finishing a revision that was
		// published before its history could be written. Everything else a divergent
		// plan file could mean is reported and left for a decision.
		await revisions.reconcileOnSessionStart(ctx, session);
		if (!session.isCurrent()) return;
		startPlanModeSettingsWatch(session);
		const persistFlagActivation = pi.getFlag("plan") === true && !state.enabled;
		if (persistFlagActivation) {
			state = { ...state, enabled: true, awaitingAction: state.planPath !== undefined };
		}
		if (persistFlagActivation) persistState();
		if (state.enabled) activatePlanTools(ctx.hasUI);
		else if (state.planPath) activateImplementedTool(ctx.hasUI);
		if (state.planPath) activateUpdatePlanTool(ctx.hasUI);
		await refreshViewDetail(session);
		if (!session.isCurrent()) return;
		updateUi(ctx);
	});

	/**
	 * Tree navigation moves which branch of the conversation is live without
	 * starting a session, and Plan mode's state — including, since managed
	 * revisions, the approval digest — lives in that branch's entries.
	 *
	 * So the selected branch is re-read here. Without it, `approvedDigest` stayed in
	 * memory across a navigation: moving to a branch recorded *before* the user
	 * approved anything left the in-memory digest matching the file, so approval
	 * read as current and completion proceeded on a branch where no approval was
	 * ever recorded. The fix is to let the branch answer, which is also what makes a
	 * branch that never had a plan report none.
	 *
	 * What is deliberately *not* done is rewinding anything on disk. Moving the
	 * conversation back does not un-write the work the later turns did: the plan file
	 * and its recorded revisions stay exactly as they are, and a plan whose bytes no
	 * longer match what this branch approved becomes unverified rather than being
	 * reverted. Old menus and in-flight waits are superseded first, so a card opened
	 * against the previous branch cannot write to this one.
	 */
	pi.on("session_tree", async (_event, ctx) => {
		lifecycle.nextWorkflow();
		const scope = lifecycle.capture();
		const previousPlanPath = state.planPath;
		pendingReadyNonce = undefined;
		clearApprovalView();
		revisions.reset();
		currentHasUI = ctx.hasUI;
		restoreState(ctx);
		await reconcileMissingPlan(ctx);
		if (!scope.isCurrent()) return;
		await revisions.reconcileOnSessionStart(ctx, scope);
		if (!scope.isCurrent()) return;
		// Staging is monotonic by design, so a branch with a plan stages what it needs
		// and a branch without one keeps tools that now refuse to run.
		if (state.enabled) activatePlanTools(ctx.hasUI);
		else if (state.planPath) activateImplementedTool(ctx.hasUI);
		if (state.planPath) activateUpdatePlanTool(ctx.hasUI);
		await refreshViewDetail(scope);
		if (!scope.isCurrent()) return;
		updateUi(ctx);
		if (previousPlanPath === state.planPath) return;
		ctx.ui.notify(
			state.planPath
				? `This branch tracks the plan at ${state.planPath}. Nothing on disk was changed.`
				: "This branch tracks no plan. The plan file and its recorded revisions were left alone.",
			"info",
		);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		tasksUiContext = undefined;
		ctx.ui.setStatus("plan-tasks", undefined);
		// No re-arm: nothing may become current again until a session_start.
		taskIntegration.close();
		lifecycle.endSession("Plan mode session shut down");
		stopPlanModeSettingsWatch();
		pendingReadyNonce = undefined;
		latestCommandContext = undefined;
		refreshStateBeforeFirstAgentStart = false;
		await awaitPlanModeSettingsWrites(dependencies.settingsPath);
		persistState();
		clearUi(ctx);
	});

	/**
	 * The complete enforcement surface, and the only place a mutating tool is
	 * judged: the same two static built-in names, for two different reasons.
	 *
	 * While planning or revising, they are blocked outright — planning must not
	 * mutate files. While *implementing*, they are allowed only if the plan on disk
	 * is still the plan the user approved. That second check is the approved plan's
	 * "validate the accepted digest at subsequent mutation calls": an edit to the
	 * plan that lands mid-turn is otherwise invisible until the next turn boundary,
	 * so the tool calls after it would carry out a plan nobody agreed to.
	 *
	 * It is not a permission system and does not grow into one. The classified set
	 * is the same `MUTATING_TOOLS` the planning block uses, read-only tools are never
	 * touched, and Bash, MCP and subagent calls are deliberately not inspected — Plan
	 * mode cannot tell which of those write, and guessing is worse than leaving it to
	 * the session's permission layer. The cost is one plan-file read per `edit`/`write`
	 * while a plan is active.
	 */
	pi.on("tool_call", async (event, ctx) => {
		if (!MUTATING_TOOLS.has(event.toolName)) return;
		if (state.enabled) {
			const revision = state.revision;
			// Three states again, and the refusal has to name the call that is accepted in
			// each: "finish with plan_mode_complete" would be advice that fails for a plan
			// that already has history, where the route is a reviewed revision.
			const route = revision
				? `Submit the revision with ${UPDATE_PLAN_TOOL_NAME} action "propose" (revisionId "${revision.revisionId}"), then implement once the user accepts it.`
				: state.planId && state.planPath
					? `This plan already exists: change it with ${UPDATE_PLAN_TOOL_NAME} action "begin" and expectedRevision ${state.specRevision ?? 0}, then action "propose", and implement once the user accepts it.`
					: "Finish the plan with plan_mode_complete, then implement.";
			return {
				block: true,
				reason: `Plan mode blocks '${event.toolName}' because planning must not mutate files. ${route}`,
			};
		}
		if (!state.planPath) return;
		const reading = await revisions.read(state);
		const refusal = mutationRefusal(event.toolName, reading.approval, guidanceMode(ctx));
		if (!refusal) {
			try { await taskIntegration.verify(ctx); } catch (error) { return { block: true, reason: String(error) }; }
			return;
		}
		// The widget and the next prompt should agree with the refusal the model just
		// received, so the reading is published rather than discarded.
		if (publishApproval(reading.approval, guidanceMode(ctx))) updateUi(ctx);
		return { block: true, reason: refusal };
	});

	/**
	 * Which recovery routes exist in the session being spoken to.
	 *
	 * `/plan` with no arguments throws in print and JSON modes, and an unrecognised
	 * argument is forwarded to the model as a planning prompt — so "run /plan and
	 * choose …" is worse than useless there. Everything that offers a way back to an
	 * approved plan asks this first.
	 */
	function guidanceMode(ctx: ExtensionContext) {
		return { interactive: ctx.hasUI };
	}

	/**
	 * Everything the first prompt of a turn needs settled before Pi snapshots
	 * the base system prompt: the state a fresh destination was seeded with,
	 * and the tools that state wants staged. Pi rebuilds the base prompt
	 * synchronously inside setActiveTools, but before_agent_start receives a
	 * snapshot taken before its handlers run — a tool staged there ships
	 * without its guideline on that turn and with it on the next, which is one
	 * more prefix change than the transition needed. The `input` event fires
	 * earlier, before that snapshot, for every prompt that reaches the model
	 * (typed, RPC, and sendUserMessage — which is how the fresh-session handoff
	 * arrives). So staging happens here, and before_agent_start only repeats
	 * it as a fallback for a host that reached it some other way.
	 */
	function settleBeforePrompt(ctx: ExtensionContext) {
		currentHasUI = ctx.hasUI;
		if (refreshStateBeforeFirstAgentStart) {
			refreshStateBeforeFirstAgentStart = false;
			restoreState(ctx);
			updateUi(ctx);
		}
		if (state.enabled && !planToolsActivated) activatePlanTools(ctx.hasUI);
		else if (!state.enabled && state.planPath && !implementedToolActivated) {
			activateImplementedTool(ctx.hasUI);
		} else reconcilePlanToolSurface(ctx.hasUI);
	}

	pi.on("input", (_event, ctx) => {
		settleBeforePrompt(ctx);
	});

	/**
	 * The turn boundary, and the one place the plan file is checked against what
	 * was approved before the model is told anything about it.
	 *
	 * Asynchronous because that check is a file read, and Pi awaits this handler —
	 * so the context line the model receives this turn reflects the file as it is
	 * now rather than as it was when the state entry was written. An external edit
	 * between turns therefore reaches the model as "approval no longer covers this
	 * file" on the very next turn, instead of silently passing for a plan nobody
	 * agreed to.
	 */
	pi.on("before_agent_start", async (event, ctx) => {
		settleBeforePrompt(ctx);
		// A revision transaction is an explicit state, not a superseded ready plan:
		// clearing awaitingAction here would be a no-op for it anyway, and the
		// transaction is what the prompt below keys on.
		if (state.enabled && state.awaitingAction) {
			// A new turn supersedes the previous ready plan: revision feedback
			// re-opens planning until another plan_mode_complete arrives.
			pendingReadyNonce = undefined;
			setState(ctx, { awaitingAction: false });
		}
		// A headless run has no legitimate question tool, whatever the active set
		// still says: pi-ask-user-question strips its own tool on this same hook,
		// and hook order between the two packages is not ours to depend on.
		const questionTool = ctx.hasUI ? preferredQuestionTool(pi) : null;
		let taskContext = "";
		if (state.taskTracking && !state.enabled) {
			try {
				const set = await taskIntegration.verify(ctx, state, true);
				if (set) {
					const counts = taskCounts(set);
					ctx.ui.setStatus("plan-tasks", `tasks · ${counts.open} open · ${counts.completed} done · ${counts.abandoned} abandoned`);
					taskContext = `\n\nThis plan is bound to task set ${set.taskSetId} at task revision ${set.revision}. Use get_tasks and update_tasks apply for routine progress. Revise scope with update_plan begin/propose, reconciling both artifacts. Completion checks current bound tasks, not this display.`;
				}
			} catch (error) {
				ctx.ui.setStatus("plan-tasks", "tasks · binding blocked");
				taskContext = `\n\nSTOP implementation: ${String(error)}. Reconcile the plan/task binding before further work or completion.`;
			}
		} else ctx.ui.setStatus("plan-tasks", undefined);
		const reading = state.planPath ? await revisions.read(state) : undefined;
		if (publishApproval(reading?.approval ?? { kind: "none" }, guidanceMode(ctx))) updateUi(ctx);
		const notice = viewDetail.approvalNotice;
		const revision = state.revision;
		if (state.enabled) {
			// Three states, three endings, and the prompt has to name the one that will
			// actually be accepted: propose while a revision is open, begin over a plan
			// that already has managed history, plan_mode_complete for a first draft.
			// Telling the model to finish in a call the tool refuses is how a user's
			// "tweak X" ends in an error instead of a reviewed revision.
			const context: Parameters<typeof buildPlanModePrompt>[1] =
				revision && state.planPath
					? {
							kind: "revision",
							planPath: state.planPath,
							revisionId: revision.revisionId,
							baseRevision: revision.baseRevision,
							instructions: revision.instructions,
							...(reading?.unaccounted ? { conflict: reading.unaccounted } : {}),
						}
					: state.planId && state.planPath
						? {
								kind: "managed",
								planPath: state.planPath,
								specRevision: reading?.revision ?? state.specRevision ?? 0,
							}
						: undefined;
			return {
				systemPrompt: `${event.systemPrompt}\n\n${buildPlanModePrompt(questionTool, context)}`,
			};
		}
		// Pointer, not payload: an active plan costs a couple of lines of context no
		// matter how large the plan is, and survives compaction for free.
		if (state.planPath) {
			const recoveryInstruction = reading
				? approvalRecoveryInstruction(reading.approval, guidanceMode(ctx))
				: undefined;
			return {
				systemPrompt: `${event.systemPrompt}${taskContext}\n\n${buildActivePlanPointer(state.planPath, {
					revision: reading?.revision ?? state.specRevision ?? 0,
					...(notice ? { approvalNotice: notice } : {}),
					...(recoveryInstruction ? { recoveryInstruction } : {}),
				})}`,
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

	/**
	 * Clearing the plan clears this session's pointer to it, and nothing else.
	 *
	 * The recorded revision history under `plans/.revisions/<planId>/` is
	 * deliberately left alone: it is the record of what was agreed and when, and a
	 * user clearing an attachment is not a user asking for that to be destroyed.
	 */
	async function exitPlanMode(ctx: ExtensionContext, options: { keepPlanFile?: boolean } = {}) {
		lifecycle.nextWorkflow();
		const planPath = state.planPath;
		pendingReadyNonce = undefined;
		clearApprovalView();
		revisions.reset();
		setState(ctx, { ...clearedManagedState(), enabled: false, planPath: undefined, awaitingAction: false });
		if (planPath && !options.keepPlanFile) await deletePlanFile(planPath);
	}

	/**
	 * Is this an agreed plan being planned over, rather than a draft?
	 *
	 * The discriminator is **managed identity**, not approval. `approvedDigest` is
	 * cleared by accepting a revision — deliberately, because the new text is current
	 * but not yet approved — so keying off it would call the plan a draft in exactly
	 * the state a revision has just been accepted in. `planId` is assigned the first
	 * time something managed happens to a plan and survives every revision outcome,
	 * which is what "this is not a first draft" actually means.
	 *
	 * Scoped to `enabled`, because `!enabled && planPath` is *implementing*, and that
	 * state already has an explicit clear with long-standing behaviour.
	 */
	function managedPlanningActive(): boolean {
		return state.enabled && state.planId !== undefined && state.planPath !== undefined;
	}

	/**
	 * `/plan exit` and `/plan off`, which mean different things in each state.
	 *
	 * The case worth spelling out is exit over an **agreed managed plan**, in any of
	 * the three states a revision leaves behind: open, accepted, cancelled. Opening a
	 * revision turns Plan mode back on and resolving one leaves it on, so the plain
	 * reading of "Plan mode is on and a plan file exists" is "a proposed draft is
	 * being discarded" — and it is not. The file holds the plan the user agreed to,
	 * and deleting it to abandon a revision of it, or to stop talking about it, throws
	 * away the baseline and says so in the wrong words.
	 *
	 * So exit over a managed plan is **not destructive and not an exit**: any open
	 * transaction is retired through the existing primitive, the live file, identity
	 * and history are kept, and the plan stays attached and paused at the managed
	 * ready decision. The notification names only routes that exist from there — the
	 * implementation actions and export that `/plan` actually offers. It deliberately
	 * does not offer a clear: no explicit clear action is reachable from managed
	 * planning (the clear lives on the active-implementation menu), and inventing a
	 * command or deleting silently are both worse than saying less.
	 *
	 * Two long-standing behaviours are untouched: exit while *implementing* still
	 * clears the active plan, and exit over an unmanaged first draft still discards
	 * it.
	 */
	async function exitPlanModeCommand(ctx: ExtensionContext) {
		const planPath = state.planPath;
		if (managedPlanningActive() && planPath) {
			const hadRevision = state.revision !== undefined;
			const paused = await revisions.pauseManagedPlan(
				ctx,
				"the user stopped revising from /plan exit",
			);
			if (!paused) return;
			ctx.ui.notify(
				`${hadRevision ? "Plan revision abandoned. " : ""}The agreed plan at ${planPath} (spec revision ${
					state.specRevision ?? 0
				}) stays attached and paused; nothing was discarded and nothing is being implemented. Run /plan to implement it here, start a fresh implementation session, or export it.`,
				"info",
			);
			return;
		}
		const hadPlan = planPath !== undefined;
		const notification = state.enabled
			? hadPlan
				? "Plan mode disabled. Proposed plan discarded."
				: "Plan mode disabled."
			: hadPlan
				? "Active implementation plan cleared."
				: "Plan mode disabled.";
		await exitAndNotify(ctx, notification);
	}

	/**
	 * The managed fields a plan takes with it when the session stops tracking one.
	 *
	 * Spelled out rather than spread, because a left-over `approvedDigest` or
	 * `planId` would let the next plan in this session inherit an approval it never
	 * received.
	 */
	function clearedManagedState(): Partial<PlanModeState> {
		return {
			schemaVersion: PLAN_STATE_SCHEMA_VERSION,
			planId: undefined,
			specRevision: undefined,
			currentDigest: undefined,
			approvedDigest: undefined,
			taskTracking: undefined,
			taskBindingError: undefined,
			revision: undefined,
		};
	}

	/**
	 * The one question every completion path asks: are these the bytes the user
	 * approved? Returns the refusal to report, or undefined when completion may
	 * proceed.
	 *
	 * It is a read, never a fix. An unknown or superseded approval is resolved by a
	 * person — through a revision, or by confirming the file in `/plan` — and never
	 * by a tool call deciding its own authorisation.
	 */
	async function completionGate(ctx: ExtensionContext): Promise<string | undefined> {
		try { await taskIntegration.completion(ctx); } catch (error) { return String(error); }
		// Named before anything is read, because both completion entry points return
		// early on `state.enabled` and an open revision always implies it: without
		// this the user hears "No plan is being implemented" about a plan that is.
		if (state.revision) return REVISION_IN_PROGRESS_REFUSAL;
		const reading = await revisions.read(state);
		const refusal = completionRefusal(reading.approval, guidanceMode(ctx));
		if (!refusal) return undefined;
		if (publishApproval(reading.approval, guidanceMode(ctx))) updateUi(ctx);
		return refusal;
	}

	/**
	 * Implementation is over: the plan file is archived beside the live slot
	 * (never deleted — it is the record of what was agreed), the pointer and
	 * widget go. plan_implemented stays staged and refuses to run. Shared by the
	 * tool, `/plan done`, the menu item, and "Start a new plan", so the
	 * session's next plan never overwrites the one it just finished.
	 *
	 * The archive is a filesystem wait, and the session can move on underneath
	 * it: a `/plan start` while it is pending opens a new workflow, and a
	 * session replacement or shutdown ends this one. The state write after the
	 * wait must not land on either. So the workflow generation is advanced first
	 * (superseding menus opened against the finished plan), the scope that
	 * results is captured, and nothing after the await touches state unless
	 * that scope is still current. Returns `stale` in that case: the archive,
	 * if it happened, is a fact on disk; the state it would have produced is
	 * not, because something newer already owns it.
	 */
	async function finishImplementation(
		ctx: ExtensionContext,
	): Promise<{ kind: "finished"; archivePath?: string } | { kind: "stale" }> {
		lifecycle.nextWorkflow();
		const scope = lifecycle.capture();
		const planPath = state.planPath;
		pendingReadyNonce = undefined;
		const archivePath = planPath ? await archivePlanFile(planPath) : undefined;
		if (!scope.isCurrent()) return { kind: "stale" };
		clearApprovalView();
		revisions.reset();
		setState(ctx, {
			...clearedManagedState(),
			enabled: false,
			planPath: undefined,
			awaitingAction: false,
			...(archivePath ? { archivePath } : {}),
		});
		return { kind: "finished", archivePath };
	}

	/**
	 * `/plan done`, the menu item, and the model's tool all end here. A failed
	 * archive (a filesystem without hard links, a permissions error, a plan
	 * replaced under us) leaves the state exactly as it was and says why; the
	 * user can export and clear by hand. Returns whether implementation ended.
	 */
	async function markImplemented(ctx: ExtensionContext): Promise<boolean> {
		if (state.revision && state.planPath) {
			ctx.ui.notify(REVISION_IN_PROGRESS_REFUSAL, "warning");
			return false;
		}
		if (state.enabled || !state.planPath) {
			ctx.ui.notify("No plan is being implemented.", "warning");
			return false;
		}
		// Captured before the gate's file read, for the same reason the tool does it:
		// a session replaced across that await must not see a success notification.
		const scope = lifecycle.capture();
		const refusal = await completionGate(ctx);
		if (!scope.isCurrent()) return false;
		if (refusal) {
			ctx.ui.notify(refusal, "warning");
			return false;
		}
		let result: Awaited<ReturnType<typeof finishImplementation>>;
		try {
			result = await finishImplementation(ctx);
		} catch (error: unknown) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Unable to archive the plan: ${detail}. The active plan is unchanged.`, "error");
			return false;
		}
		if (result.kind === "stale") return false;
		ctx.ui.notify(
			result.archivePath
				? `Plan implemented. Archived to ${result.archivePath}.`
				: "Plan implemented.",
			"info",
		);
		return true;
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
			ctx.ui.notify(`Unable to send Plan mode message: ${detail}`, "error");
			return false;
		}
	}

	/**
	 * Writes the durable plan file and marks the plan ready. A write failure
	 * keeps Plan mode active rather than silently losing the plan.
	 */
	async function acceptCompletedPlan(plan: string, ctx: ExtensionContext): Promise<string> {
		// The guard lives on the write, not only on the tool that calls it: this is
		// the one place an unreviewed plan could replace a reviewed one, and a future
		// caller must not be able to reach it by going around the tool wrapper.
		const managedRefusal = managedCompletionRefusal(state);
		if (managedRefusal) throw new Error(managedRefusal);
		const planPath = sessionPlanPath ?? resolveSessionPlanPath(ctx);
		try {
			await writePlanFile(planPath, plan);
		} catch (error: unknown) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Unable to save the plan to ${planPath}: ${detail}`);
		}
		sessionPlanPath = planPath;
		// A first draft replaces whatever this session was tracking, approval
		// included: the bytes are new, so nothing about the old plan carries over.
		setState(ctx, { ...clearedManagedState(), planPath, awaitingAction: true });
		activateUpdatePlanTool(currentHasUI);
		markPlanReady(ctx, "Proposed Plan", plan);
		return planPath;
	}

	/**
	 * Put a plan in front of the user and arm the post-settle "what next?" menu.
	 *
	 * Shared by the first draft and by every revision outcome that leaves a plan
	 * waiting for a decision, so the card and the menu can never disagree about
	 * which plan is being offered.
	 */
	function markPlanReady(ctx: ExtensionContext, title: string, plan: string) {
		pendingReadyNonce = ++readyPresentationNonce;
		showPlanModePlan(pi, ctx, title, plan);
	}

	async function currentPlan() {
		return state.planPath ? await readPlanFile(state.planPath) : undefined;
	}

	/**
	 * "Finalize now" has to name the call that will actually be accepted.
	 *
	 * While a revision is open, `plan_mode_complete` is refused and the revision
	 * prompt says so, so asking for it here would send the model at a wall the rest
	 * of the package built on purpose. A plan that already has managed history is
	 * the same situation one step earlier: the way to change it is a reviewed
	 * revision, which starts with `begin`.
	 */
	function requestFinalPlan(ctx: ExtensionContext) {
		if (!state.enabled) {
			ctx.ui.notify("Plan mode is not active. Use /plan first.", "warning");
			return;
		}
		// Same rule as the prompt: a headless run has no question tool to name.
		const questionTool = ctx.hasUI ? preferredQuestionTool(pi) : null;
		const askInstead =
			questionTool === null ? "ask it in plain text" : `use ${questionTool}`;
		const revision = state.revision;
		if (revision) {
			sendPlanModeUserMessage(
				`Finish the plan revision now. If any material decision remains, ${askInstead} instead. Otherwise call ${UPDATE_PLAN_TOOL_NAME} alone as your final action with action "propose", revisionId "${revision.revisionId}", expectedRevision ${revision.baseRevision}, the complete rewritten plan, and a changeSummary. Do not call plan_mode_complete; it is refused while this revision is open.`,
				ctx,
			);
			return;
		}
		if (state.planId !== undefined && state.planPath !== undefined) {
			sendPlanModeUserMessage(
				`This session already has an agreed plan at ${state.planPath} (spec revision ${state.specRevision ?? 0}). To change it, call ${UPDATE_PLAN_TOOL_NAME} with action "begin" and expectedRevision ${state.specRevision ?? 0}, then action "propose" with the complete rewritten plan. If any material decision remains, ${askInstead} first. Do not call plan_mode_complete; it is refused for a plan that already exists.`,
				ctx,
			);
			return;
		}
		sendPlanModeUserMessage(
			`Finalize the current implementation plan now. If any material decision remains, ${askInstead} instead. Otherwise call plan_mode_complete alone as your final action with the complete decision-ready plan.`,
			ctx,
		);
	}

	async function startFreshImplementation(ctx: ExtensionContext, menuIsCurrent: () => boolean) {
		await startFreshImplementationFromState(ctx, {
			getState: () => state,
			menuIsCurrent,
			stateEntryType: STATE_ENTRY_TYPE,
			// The same recording "Implement here" performs, for the same reason: the user
			// choosing to implement is the approval, and the destination has to inherit
			// an identity, a revision and a digest that all name the bytes it will read.
			recordApproval: async () => {
				const approval = await revisions.approveCurrentPlan(ctx, "the plan was approved for implementation in a fresh session");
				if (!approval.ok) return approval;
				try {
					await taskIntegration.beforeImplement(ctx);
					return { ...approval, taskAttachment: await taskIntegration.attachment(ctx) };
				} catch (error) { return { ok: false as const, error: String(error) }; }
			},
			validateDestination: async (replacement, destination) => {
				const reading = await revisions.read(destination);
				if (reading.approval.kind !== "approved") throw new Error("destination plan approval is stale");
				await taskIntegration.verify(replacement, destination, true);
			},
		});
	}

	async function startImplementation(ctx: ExtensionContext) {
		const planPath = state.planPath;
		// An open revision is an unresolved decision about what the plan *is*, and
		// implementing past it would both approve bytes the user is in the middle of
		// changing and orphan the candidate they were shown. `/plan implement` is the
		// only door that reaches here during a revision; the menus do not offer it.
		if (state.revision) {
			ctx.ui.notify(
				"A plan revision is in progress. Accept or cancel it from /plan before implementing.",
				"warning",
			);
			return;
		}
		const plan = await currentPlan();
		if (!planPath || !plan) {
			ctx.ui.notify("No completed plan is available to implement.", "warning");
			return;
		}

		// Choosing to implement *is* the approval, and it binds to these exact bytes:
		// every later gate compares the file against this digest rather than trusting
		// a flag. Recorded before the mode switch so an interrupted handoff cannot
		// leave an implementing session with no record of what it approved.
		const approved = await revisions.approveCurrentPlan(
			ctx,
			"the plan was approved for implementation",
		);
		if (!approved.ok) {
			ctx.ui.notify(`Unable to implement the plan: ${approved.error}`, "warning");
			return;
		}
		if (approved.warning) ctx.ui.notify(approved.warning, "warning");
		const scope = lifecycle.capture();
		try { await taskIntegration.beforeImplement(ctx); }
		catch (error) { ctx.ui.notify(`Unable to implement: ${String(error)}`, "warning"); return; }
		if (!scope.isCurrent()) return;
		const latest = await revisions.read(state);
		if (!scope.isCurrent() || !latest.digest || latest.digest !== state.approvedDigest) return;

		lifecycle.nextWorkflow();
		const previousState = state;
		pendingReadyNonce = undefined;
		clearApprovalView();
		setState(ctx, { enabled: false, awaitingAction: false, planPath, revision: undefined });
		// The same transition that rewrites the system prompt stages the tool.
		activateImplementedTool(currentHasUI);
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
		// The file may have moved since the last turn boundary, and this menu is where
		// the user would act on that, so the reading is taken now rather than reused.
		await refreshViewDetail(menu);
		if (!menu.isCurrent() || menu.signal.aborted) return;
		await ui.showActiveImplementationMenu(ctx, {
			statusText: planStatusText(),
			...(state.planPath ? { planPathLine: `Plan file: ${state.planPath}` } : {}),
			...(viewDetail.approvalNotice ? { approvalNotice: viewDetail.approvalNotice } : {}),
			canConfirm: canConfirmPlanFile(viewApproval),
			getExportDestination: () => planExports.getDestination(ctx),
			signal: menu.signal,
			isCurrent: menu.isCurrent,
			show: () => showStoredPlan(pi, ctx, state),
			exportPlan: (path, signal) => planExports.export(path, ctx, signal, menu.isCurrent),
			settings: (signal) => showSettings(ctx, signal, menu.isCurrent),
			confirmPlan: async () => {
				await revisions.confirmCurrentPlan(ctx);
				if (!menu.isCurrent()) return;
				await refreshViewDetail(menu);
				if (menu.isCurrent()) updateUi(ctx);
			},
			done: () => markImplemented(ctx),
			startNew: async () => {
				// Archive first: the next plan_mode_complete writes to the same
				// session slot, and a plan in progress is not something to
				// overwrite. A failed or superseded archive means no new plan: the
				// user is told, and the active plan stays where it was.
				if (!(await markImplemented(ctx))) return;
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

	/**
	 * A restored pointer can name a file that is no longer there. The usual
	 * cause is a fresh implementation session: it shares this session's live
	 * slot, and when it finished it archived the file — in its own entries, not
	 * ours. Rather than restore a ready plan that `/plan show` and `/plan
	 * implement` cannot read, follow the archive if one exists and clear the
	 * pointer either way, saying which happened. Runs once, at session start,
	 * before the first prompt is built.
	 */
	async function reconcileMissingPlan(ctx: ExtensionContext) {
		const planPath = state.planPath;
		if (!planPath) return;
		if ((await readPlanFile(planPath)) !== undefined) return;
		const archivePath = await latestArchiveFor(planPath);
		// The managed fields go with the pointer: an identity with no document cannot
		// be revised, and a retained approvedDigest would outlive the bytes it named.
		state = {
			schemaVersion: PLAN_STATE_SCHEMA_VERSION,
			enabled: state.enabled,
			planPath: undefined,
			awaitingAction: false,
			...(archivePath ? { archivePath } : {}),
		};
		clearApprovalView();
		revisions.reset();
		persistState();
		ctx.ui.notify(
			archivePath
				? `The plan file was archived elsewhere (implemented in another session); cleared here. The archive is at ${archivePath}.`
				: "The plan file is gone; the stored plan pointer was cleared.",
			"info",
		);
	}

	/**
	 * Re-read the plan file and decide what it means for approval.
	 *
	 * The comparison cannot come from state alone, so every surface that shows it
	 * — the widget, the footer, the `/plan` menu — refreshes through here first. The
	 * scope check is the usual one: a read that finishes after the session moved on
	 * must not write its conclusion onto whatever replaced it.
	 */
	async function refreshViewDetail(
		scope: { isCurrent(): boolean },
		mode: { interactive: boolean } = { interactive: currentHasUI },
	): Promise<void> {
		if (!state.planPath) {
			clearApprovalView();
			return;
		}
		const reading = await revisions.read(state);
		if (!scope.isCurrent()) return;
		publishApproval(reading.approval, mode);
	}

	/**
	 * Record a fresh approval reading, and refresh the UI only when what the user
	 * would see has changed.
	 *
	 * Every surface that reads the plan file goes through here — the turn boundary,
	 * the mutation guard, the completion gate, the `/plan` menu — so the footer, the
	 * status sentence, the menu's available items and the refusal the model just
	 * received cannot describe different readings of the same file. Returns whether
	 * the visible notice moved, for the callers that own the `updateUi` call.
	 */
	/** Forget the current reading, for every path that stops tracking a plan. */
	function clearApprovalView(): void {
		viewApproval = { kind: "none" };
		viewDetail = {};
	}

	function publishApproval(
		approval: PlanApproval,
		mode: { interactive: boolean } = { interactive: currentHasUI },
	): boolean {
		viewApproval = approval;
		const notice = revisions.approvalNotice(approval);
		const instruction = approvalRecoveryInstruction(approval, mode);
		const changed = notice !== viewDetail.approvalNotice;
		viewDetail = notice
			? { approvalNotice: notice, ...(instruction ? { recoveryInstruction: instruction } : {}) }
			: {};
		return changed;
	}

	function updateUi(ctx: ExtensionContext) {
		if (!state.taskTracking) ctx.ui.setStatus("plan-tasks", undefined);
		updatePlanModeUi(ctx, state, viewDetail);
	}

	function clearUi(ctx: ExtensionContext) {
		clearPlanModeUi(ctx);
	}

	function planStatusText() {
		return formatPlanModeStatusText(state, viewDetail);
	}
}

export { completePlanArguments } from "./command.js";
export { evaluatePlanApproval } from "./plan-approval.js";
export { diffPlanText } from "./plan-diff.js";
export { planFilePathForSession, plansDirectory } from "./plan-file.js";
export { buildActivePlanPointer, buildPlanModePrompt } from "./prompt.js";
export { normalizePlanModeQuestionParams } from "./question-tool.js";
export { planRevisionsRoot } from "./revision-store.js";
export { normalizePlanModeSettings, readPlanModeSettings } from "./settings.js";
export { normalizeUpdatePlan, UPDATE_PLAN_TOOL_NAME } from "./update-plan-tool.js";
