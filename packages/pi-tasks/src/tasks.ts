/**
 * The extension: registration, session lifecycle, and the `/tasks` router.
 *
 * Everything with state lives in `TasksController`; this file is the wiring
 * that connects Pi's events to it. It is deliberately thin, because the parts
 * worth testing are the parts that are not about Pi.
 *
 * One ordering note. The prompt pointer is added in `before_agent_start`, but
 * the attachment it describes is settled in `session_start`, which is async: a
 * document read has to finish before the first turn can describe it. Pi awaits
 * `session_start` handlers, so by the time a prompt is built the controller has
 * either an attachment or a recovery state, and never a half-loaded one.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { completeTasksArguments, parseTasksCommand } from "./command.js";
import { TasksController, type TasksControllerDependencies } from "./controller.js";
import { createSessionGuard } from "./session-guard.js";
import { registerTasksCardRenderer, tasksStatusText } from "./presentation.js";
import { buildTasksPointer, buildTasksRecoveryPointer } from "./prompt.js";
import { registerGetTasksTool, registerUpdateTasksTool } from "./tools.js";

type InteractiveUi = typeof import("./interactive-ui.js");

export default function tasks(pi: ExtensionAPI, dependencies: TasksControllerDependencies = {}) {
	const controller = new TasksController(pi, dependencies);
	const menuGuard = createSessionGuard();
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

	registerTasksCardRenderer(pi);
	registerGetTasksTool(pi, controller);
	registerUpdateTasksTool(pi, controller);

	pi.registerCommand("tasks", {
		description: "Inspect, manage, or recover the phased task set",
		getArgumentCompletions: completeTasksArguments,
		handler: async (args, ctx) => {
			const command = parseTasksCommand(args);
			switch (command.kind) {
				case "show":
					await controller.showTasks(ctx);
					return;
				case "review":
					await controller.reviewPending(ctx);
					return;
				case "new":
					await controller.startNew(ctx);
					return;
				case "archive":
					await controller.archive(ctx);
					return;
				case "recover":
					await showRecovery(ctx);
					return;
				case "export":
					if (!command.path) {
						ctx.ui.notify("Give a path to export to, for example /tasks export ./tasks.md", "warning");
						return;
					}
					await controller.exportTasks(command.path, ctx);
					return;
				case "unknown":
					ctx.ui.notify(
						`Unknown /tasks subcommand: ${command.input}. Try show, review, new, archive, export, or recover.`,
						"warning",
					);
					return;
				default:
					await showMenu(ctx);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		menuGuard.nextSession("pi-tasks session replaced");
		await controller.onSessionStart(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		menuGuard.endSession("pi-tasks session shut down");
		controller.onSessionShutdown(ctx);
	});

	// `/tree` moves the branch without starting a session, so the attachment is
	// re-read here or it silently belongs to a branch the user left.
	pi.on("session_tree", async (_event, ctx) => {
		menuGuard.nextAttachment();
		await controller.onSessionTree(ctx);
	});

	// The turn boundary is the third place the document is re-read (the other two
	// are every get_tasks and every update_tasks). It is what makes the pointer
	// the model sees describe the file as it is now, and what turns an outside
	// edit into a refusal at the start of the turn rather than after a write has
	// already been built on top of it.
	pi.on("before_agent_start", async (event, ctx) => {
		await controller.refreshFromDisk(ctx);
		const recovery = controller.recoveryState;
		if (recovery) {
			return { systemPrompt: `${event.systemPrompt}\n\n${buildTasksRecoveryPointer(recovery.reason)}` };
		}
		const facts = controller.pointerFacts();
		if (!facts) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildTasksPointer(facts)}` };
	});

	async function showMenu(ctx: ExtensionCommandContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify(tasksStatusText(controller.uiState), "info");
			return;
		}
		const scope = menuGuard.capture();
		if (!scope.isCurrent() || scope.signal.aborted) return;
		const ui = await loadInteractiveUi();
		if (!scope.isCurrent() || scope.signal.aborted) return;
		const set = controller.attachedSet;
		const openTasks = set
			? set.phases
					.flatMap((phase) => phase.tasks)
					.filter((task) => task.status !== "completed" && task.status !== "abandoned").length
			: 0;
		await ui.showTasksMenu(ctx, {
			state: {
				statusText: tasksStatusText(controller.uiState),
				...(controller.attachedPath ? { documentPath: controller.attachedPath } : {}),
				hasSet: set !== undefined,
				hasPendingReview: controller.pending.length > 0,
				needsRecovery: controller.recoveryState !== undefined,
				openTasks,
			},
			exportPlaceholder: "./tasks.md",
			signal: scope.signal,
			isCurrent: scope.isCurrent,
			show: () => controller.showTasks(ctx),
			review: () => controller.reviewPending(ctx),
			recover: () => showRecovery(ctx),
			archive: async () => {
				await controller.archive(ctx);
			},
			startNew: () => controller.startNew(ctx),
			exportTasks: (path) => controller.exportTasks(path, ctx),
		});
	}

	async function showRecovery(ctx: ExtensionContext) {
		const recovery = controller.recoveryState;
		if (!recovery) {
			ctx.ui.notify("The task set is consistent; there is nothing to recover.", "info");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(
				`The task set needs recovery (${recovery.reason}), which needs an interactive session.`,
				"warning",
			);
			return;
		}
		const scope = menuGuard.capture();
		if (!scope.isCurrent() || scope.signal.aborted) return;
		const ui = await loadInteractiveUi();
		if (!scope.isCurrent() || scope.signal.aborted) return;
		await ui.showRecoveryMenu(ctx, {
			state: {
				reason: recovery.reason,
				...(recovery.documentRevision !== undefined
					? { documentRevision: recovery.documentRevision }
					: {}),
				...(recovery.recordedRevision !== undefined
					? { recordedRevision: recovery.recordedRevision }
					: {}),
				...(recovery.snapshotRevision !== undefined
					? { snapshotRevision: recovery.snapshotRevision }
					: {}),
			},
			signal: scope.signal,
			isCurrent: scope.isCurrent,
			attach: () => controller.recoverAttachCurrent(ctx),
			fork: () => controller.recoverForkSnapshot(ctx),
			detach: () => controller.recoverDetach(ctx),
		});
	}

	return controller;
}

export { completeTasksArguments, parseTasksCommand } from "./command.js";
export { TasksController } from "./controller.js";
export { tasksRootDirectory } from "./store.js";
