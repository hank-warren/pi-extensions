import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanModeState } from "./state.js";
import { createTasksClient } from "./tasks-client.js";
import { parseTaskSeed, sameBinding, type TaskSeed, type PlanBinding, type TaskView } from "./plan-contract.js";

interface Options {
	getState(): PlanModeState;
	setState(ctx: ExtensionContext, patch: Partial<PlanModeState>): void;
	capture(): { signal: AbortSignal; isCurrent(): boolean };
}
export function createTaskIntegration(pi: ExtensionAPI, options: Options) {
	const client = createTasksClient(pi);
	function binding(state: PlanModeState): PlanBinding {
		if (!state.planId || !state.specRevision || !state.currentDigest) throw new Error("plan has no recorded revision to bind");
		return { planId: state.planId, specRevision: state.specRevision, digest: state.currentDigest };
	}
	function check() {
		const state = options.getState();
		if (state.taskBindingError) throw new Error(state.taskBindingError);
		if (state.taskTracking && !client.present()) throw new Error("This plan is bound to tasks, but its task provider is unavailable. Restore it; missing tasks are not completed tasks.");
		return state;
	}
	async function preview(ctx: ExtensionContext, seed: TaskSeed | undefined) {
		const state = check();
		if (!state.taskTracking && !client.present()) {
			if (seed) throw new Error("Task seed supplied, but no compatible task provider is loaded");
			return undefined;
		}
		if (!seed) throw new Error("Reconcile tasks as well as the plan: provide tasks.phases (IDs for retained work) and expectedTaskRevision from update_plan begin, even when unchanged.");
		const tasks = parseTaskSeed(seed);
		const scope = options.capture();
		const id = state.taskTracking?.taskSetId ?? state.planId;
		if (!id) throw new Error("plan identity required before task preview");
		await client.request(ctx, { operation: "describe" }, scope.signal);
		const data = await client.request(ctx, { operation: "get", taskSetId: id, tasks }, scope.signal);
		if (!scope.isCurrent()) throw new Error("session changed during task preview");
		if (data.set && data.set.binding?.planId !== state.planId) throw new Error("task set belongs to another plan");
		if (state.taskTracking && !data.set && !(state.taskTracking.pending && (state.taskTracking.seed.expectedTaskRevision ?? 0) === 0)) throw new Error("bound task document is missing; recover it, do not initialize a replacement");
		return { tasks, taskDiff: data.diff ?? "No task changes" };
	}
	async function describe(ctx: ExtensionContext) {
		const state = check();
		if (!state.taskTracking && !client.present()) return { tracking: "unbound", note: "pi-tasks is not loaded; this plan works independently." };
		const scope = options.capture();
		await client.request(ctx, { operation: "describe" }, scope.signal);
		const id = state.taskTracking?.taskSetId ?? state.planId;
		if (!id) return { tracking: "available", expectedTaskRevision: 0 };
		const data = await client.request(ctx, { operation: "get", taskSetId: id }, scope.signal);
		if (!scope.isCurrent()) throw new Error("session changed during task read");
		if (state.taskTracking && !data.set && !(state.taskTracking.pending && (state.taskTracking.seed.expectedTaskRevision ?? 0) === 0)) throw new Error("bound task document is missing");
		return { tracking: "available", expectedTaskRevision: data.set?.revision ?? 0, ...(data.set ? { tasks: data.set } : {}) };
	}
	async function bind(ctx: ExtensionContext, seed: TaskSeed): Promise<void> {
		const state = check();
		const scope = options.capture();
		const expected = binding(state);
		const taskSetId = state.taskTracking?.taskSetId ?? expected.planId;
		const tasks = parseTaskSeed(seed);
		// Durable blocked state BEFORE the request. Lost acknowledgement or shutdown
		// can never leave a ready/implementing session claiming a completed bind.
		options.setState(ctx, { taskTracking: { taskSetId, seed: tasks, pending: true } });
		const data = await client.request(ctx, { operation: "bind", taskSetId, binding: expected, tasks }, scope.signal);
		if (!scope.isCurrent()) throw new Error("binding may be durable, but the initiating session moved on");
		if (!data.set || !sameBinding(data.set.binding, expected)) throw new Error("binding acknowledgement does not match this plan revision");
		options.setState(ctx, { taskTracking: { taskSetId, seed: tasks, pending: false } });
	}
	async function verify(ctx: ExtensionContext, state = check(), attach = false): Promise<TaskView | undefined> {
		if (state.taskBindingError) throw new Error(state.taskBindingError);
		if (!state.taskTracking) return undefined;
		if (state.taskTracking.pending) throw new Error("Plan/task binding is pending. Retry the explicit implementation choice or revise the plan/tasks; do not start work.");
		const scope = options.capture();
		const expected = binding(state);
		const data = await client.request(ctx, { operation: attach ? "attach" : "get", taskSetId: state.taskTracking.taskSetId, ...(attach ? { binding: expected } : {}) }, scope.signal);
		if (!scope.isCurrent()) throw new Error("session changed during task validation");
		if (!data.set || !sameBinding(data.set.binding, expected)) throw new Error("Task binding no longer matches the plan. Call update_plan begin and reconcile both before implementing or completing.");
		return data.set;
	}
	async function beforeImplement(ctx: ExtensionContext) {
		const state = check();
		if (!state.taskTracking && client.present()) throw new Error("A compatible task provider is loaded. Use update_plan begin/propose with a structured task seed before tracked implementation.");
		if (state.taskTracking?.pending) await bind(ctx, state.taskTracking.seed);
		await verify(ctx, options.getState(), true);
	}
	async function completion(ctx: ExtensionContext) {
		const set = await verify(ctx);
		if (!set) return;
		const counts = taskCounts(set);
		if (counts.open) throw new Error(`Plan has ${counts.open} unfinished task(s), ${counts.completed} completed and ${counts.abandoned} explicitly abandoned. Finish or revise the remaining work before plan_implemented.`);
	}
	async function attachment(ctx: ExtensionContext) {
		const state = check();
		if (!state.taskTracking) return undefined;
		const scope = options.capture();
		const data = await client.request(ctx, { operation: "get", taskSetId: state.taskTracking.taskSetId }, scope.signal);
		if (!scope.isCurrent() || !data.set || !sameBinding(data.set.binding, binding(state)) || !data.attachment) throw new Error("task handoff snapshot could not be validated");
		return data.attachment;
	}
	return { close: client.close, present: client.present, preview, describe, bind, verify, beforeImplement, completion, attachment };
}
export function taskCounts(set: TaskView) {
	const tasks = set.phases.flatMap((p) => p.tasks);
	return { open: tasks.filter((t) => !["completed", "abandoned"].includes(t.status)).length, completed: tasks.filter((t) => t.status === "completed").length, abandoned: tasks.filter((t) => t.status === "abandoned").length };
}
