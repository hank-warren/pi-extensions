import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext } from "../../../test/support/mock-pi.js";
import { createPlanActionController } from "../src/plan-action-controller.js";

test("stale Plan actions do not load interactive UI", async () => {
	let interactiveLoads = 0;
	const controller = createPlanActionController({
		loadInteractiveUi: async () => {
			interactiveLoads += 1;
			return {} as never;
		},
		getState: () => ({ enabled: false, awaitingAction: false }),
		captureLifecycle: () => ({
			signal: new AbortController().signal,
			isCurrent: () => false,
		}),
		statusText: () => "off",
		planPathLine: () => undefined,
		getExportDestination: () => ({ configuredPath: "plan.md", resolvedPath: "/tmp/plan.md" }),
		show: () => undefined,
		finalize: () => undefined,
		implementHere: () => undefined,
		implementFresh: () => undefined,
		exportPlan: async () => false,
		hasPendingRevision: () => false,
		reviewRevision: () => undefined,
		cancelRevision: () => undefined,
		stay: () => undefined,
		exitReady: () => undefined,
	});
	const context = createMockContext({ hasUI: true });

	await controller.showCurrent(context.ctx);
	await controller.showReady(context.ctx);

	assert.equal(interactiveLoads, 0);
});

/**
 * Herdr. The ready-plan menu opens after the drafting turn settles, so from
 * Herdr's side the turn is over and the pane reads `idle` while it is actually
 * waiting on a human to choose implement / export / discard. The controller
 * brackets the menu with `onReadyBlocked`, and the clear must survive however
 * the menu closes — a throw that skipped it would leave the pane "blocked"
 * forever.
 */
function readyController(showReadyPlanMenu: () => Promise<void>, onReadyBlocked: (active: boolean) => void) {
	return createPlanActionController({
		loadInteractiveUi: async () => ({ showReadyPlanMenu }) as never,
		getState: () => ({ enabled: true, awaitingAction: true }),
		captureLifecycle: () => ({ signal: new AbortController().signal, isCurrent: () => true }),
		statusText: () => "ready",
		planPathLine: () => undefined,
		getExportDestination: () => ({ configuredPath: "plan.md", resolvedPath: "/tmp/plan.md" }),
		show: () => undefined,
		finalize: () => undefined,
		implementHere: () => undefined,
		implementFresh: () => undefined,
		exportPlan: async () => false,
		hasPendingRevision: () => false,
		reviewRevision: () => undefined,
		cancelRevision: () => undefined,
		stay: () => undefined,
		exitReady: () => undefined,
		onReadyBlocked,
	});
}

test("the ready menu reports blocked while open and clears when it closes", async () => {
	const blocked: boolean[] = [];
	let release: (() => void) | undefined;
	const controller = readyController(
		() => new Promise<void>((resolve) => (release = resolve)),
		(active) => blocked.push(active),
	);
	const context = createMockContext({ hasUI: true });

	const pending = controller.showReady(context.ctx);
	await Promise.resolve();
	while (release === undefined) await Promise.resolve();
	assert.deepEqual(blocked, [true], "blocked while the menu is open");
	release();
	await pending;
	assert.deepEqual(blocked, [true, false], "cleared once the menu closes");
});

test("the ready menu clears blocked even when the menu throws", async () => {
	const blocked: boolean[] = [];
	const controller = readyController(
		async () => {
			throw new Error("stale context");
		},
		(active) => blocked.push(active),
	);
	const context = createMockContext({ hasUI: true });

	await assert.rejects(controller.showReady(context.ctx), /stale context/);
	assert.deepEqual(blocked, [true, false]);
});

test("a stale ready menu never reports blocked", async () => {
	const blocked: boolean[] = [];
	const controller = createPlanActionController({
		loadInteractiveUi: async () => ({}) as never,
		getState: () => ({ enabled: true, awaitingAction: true }),
		captureLifecycle: () => ({ signal: new AbortController().signal, isCurrent: () => false }),
		statusText: () => "ready",
		planPathLine: () => undefined,
		getExportDestination: () => ({ configuredPath: "plan.md", resolvedPath: "/tmp/plan.md" }),
		show: () => undefined,
		finalize: () => undefined,
		implementHere: () => undefined,
		implementFresh: () => undefined,
		exportPlan: async () => false,
		hasPendingRevision: () => false,
		reviewRevision: () => undefined,
		cancelRevision: () => undefined,
		stay: () => undefined,
		exitReady: () => undefined,
		onReadyBlocked: (active) => blocked.push(active),
	});

	await controller.showReady(createMockContext({ hasUI: true }).ctx);
	assert.deepEqual(blocked, []);
});
