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
				planPathLine: options.planPathLine(),
				getExportDestination: () => options.getExportDestination(ctx),
				...lifecycle,
				show: () => options.show(ctx),
				finalize: () => options.finalize(ctx),
				implementHere: () => options.implementHere(ctx),
				implementFresh: (signal) => freshAction(ctx, lifecycle, signal),
				exportPlan: (path, signal) => options.exportPlan(ctx, path, signal, lifecycle.isCurrent),
				stay: () => options.stay(ctx),
				exit: () => options.exitReady(ctx),
			});
		},
		async showReady(ctx: ExtensionContext) {
			const lifecycle = options.captureLifecycle();
			if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
			const ui = await options.loadInteractiveUi();
			if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
			await ui.showReadyPlanMenu(ctx, {
				...lifecycle,
				planPathLine: options.planPathLine(),
				getExportDestination: () => options.getExportDestination(ctx),
				implementHere: () => options.implementHere(ctx),
				implementFresh: (signal) => freshAction(ctx, lifecycle, signal),
				exportPlan: (path, signal) => options.exportPlan(ctx, path, signal, lifecycle.isCurrent),
				stay: () => undefined,
				exit: () => options.exitReady(ctx),
			});
		},
	};
}
