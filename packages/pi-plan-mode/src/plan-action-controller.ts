import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanExportDestination } from "./plan-export.js";
import type { PlanModeState } from "./state.js";

type InteractiveUi = typeof import("./interactive-ui.js");

interface MenuLifecycle {
	signal: AbortSignal;
	isCurrent(): boolean;
}

interface PlanActionControllerOptions {
	loadInteractiveUi(): Promise<InteractiveUi>;
	getState(): PlanModeState;
	captureLifecycle(): MenuLifecycle;
	statusText(): string;
	planPathLine(): string | undefined;
	/** A proposed revision is waiting for a decision. */
	hasPendingRevision(): boolean;
	reviewRevision(ctx: ExtensionContext): void | Promise<void>;
	cancelRevision(ctx: ExtensionContext): void | Promise<void>;
	getExportDestination(ctx: ExtensionContext): PlanExportDestination;
	show(ctx: ExtensionContext): void | Promise<void>;
	finalize(ctx: ExtensionContext): void;
	implementHere(ctx: ExtensionContext): void | Promise<void>;
	implementFresh(ctx: ExtensionContext, isCurrent: () => boolean): void | Promise<void>;
	exportPlan(
		ctx: ExtensionContext,
		path: string,
		signal: AbortSignal,
		isCurrent: () => boolean,
	): Promise<boolean>;
	stay(ctx: ExtensionContext): void;
	exitReady(ctx: ExtensionContext): void;
	/**
	 * Called with `true` while the ready-plan menu is open and `false` once it
	 * closes, however it closes. plan-mode.ts forwards this to Herdr: the menu
	 * opens after the turn settles, so without it a supervising agent in another
	 * pane reads "idle" while the pane is actually waiting on a human to choose.
	 */
	onReadyBlocked?(active: boolean): void;
}

export function createPlanActionController(options: PlanActionControllerOptions) {
	const freshAction = (ctx: ExtensionContext, lifecycle: MenuLifecycle, signal: AbortSignal) =>
		options.implementFresh(ctx, () => lifecycle.isCurrent() && !signal.aborted);

	return {
		async showCurrent(ctx: ExtensionContext) {
			if (!ctx.hasUI) {
				ctx.ui.notify(options.statusText(), "info");
				return;
			}
			const lifecycle = options.captureLifecycle();
			if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
			const ui = await options.loadInteractiveUi();
			if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
			await ui.showPlanModeMenu(ctx, {
				statusText: options.statusText(),
				hasReadyPlan: options.getState().awaitingAction,
				// Managed identity, not approval: accepting a revision clears the approval
				// while the plan stays very much agreed.
				managedPlan: options.getState().planId !== undefined,
				hasOpenRevision: options.getState().revision !== undefined,
				hasPendingRevision: options.hasPendingRevision(),
				planPathLine: options.planPathLine(),
				getExportDestination: () => options.getExportDestination(ctx),
				...lifecycle,
				show: () => options.show(ctx),
				finalize: () => options.finalize(ctx),
				implementHere: () => options.implementHere(ctx),
				implementFresh: (signal) => freshAction(ctx, lifecycle, signal),
				exportPlan: (path, signal) => options.exportPlan(ctx, path, signal, lifecycle.isCurrent),
				reviewRevision: () => options.reviewRevision(ctx),
				cancelRevision: () => options.cancelRevision(ctx),
				stay: () => options.stay(ctx),
				exit: () => options.exitReady(ctx),
			});
		},
		async showReady(ctx: ExtensionContext) {
			const lifecycle = options.captureLifecycle();
			if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
			const ui = await options.loadInteractiveUi();
			if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
			options.onReadyBlocked?.(true);
			try {
				await ui.showReadyPlanMenu(ctx, {
					...lifecycle,
					planPathLine: options.planPathLine(),
					managedPlan: options.getState().planId !== undefined,
					...(options.getState().specRevision !== undefined
						? { specRevision: options.getState().specRevision }
						: {}),
					getExportDestination: () => options.getExportDestination(ctx),
					implementHere: () => options.implementHere(ctx),
					implementFresh: (signal) => freshAction(ctx, lifecycle, signal),
					exportPlan: (path, signal) => options.exportPlan(ctx, path, signal, lifecycle.isCurrent),
					stay: () => undefined,
					exit: () => options.exitReady(ctx),
				});
			} finally {
				options.onReadyBlocked?.(false);
			}
		},
	};
}
