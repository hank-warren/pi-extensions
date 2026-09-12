import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import planMode from "../packages/pi-plan-mode/src/plan-mode.js";
import tasks from "../packages/pi-tasks/src/tasks.js";
import { createMockPi, createMockContext } from "./support/mock-pi.js";
import type { PlanRevisionOutcome, PlanRevisionSummary } from "../packages/pi-plan-mode/src/plan-revision-menu.js";
import type { TaskSeed, TaskView } from "../packages/pi-plan-mode/src/plan-contract.js";

const seed: TaskSeed = { phases: [{ name: "Delivery", tasks: [{ content: "Migrate" }, { content: "Deploy" }] }] };
async function setup(t: { after(fn: () => unknown): void }, order: "plan-first" | "tasks-first", reviews: PlanRevisionOutcome[] = [], hasUI = true) {
	const dir = await mkdtemp(join(tmpdir(), "plan-tasks-composition-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const mock = createMockPi({ activeTools: ["read", "edit", "write", "get_tasks", "update_tasks"], allTools: ["read", "edit", "write", "get_tasks", "update_tasks"].map((name) => ({ name })) });
	let sessionId = "integration-session";
	const menus: Record<string, unknown>[] = [];
	const branch = () => mock.entries.map((e) => ({ type: "custom", ...e }));
	const context = createMockContext({ model: { provider: "test", id: "test-model" }, hasUI, mode: hasUI ? "tui" : "print", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => "/test/session.jsonl", getBranch: branch, getEntries: branch } });
	const reviewRequests: PlanRevisionSummary[] = [];
	let onReview: (() => Promise<void>) | undefined;
	const installPlan = () => planMode(mock.pi, {
		readSettings: async () => ({ kind: "missing" }),
		loadInteractiveUi: async () => ({
			showPlanRevisionMenu: async (_ctx: unknown, options: { summary: PlanRevisionSummary }) => { reviewRequests.push(options.summary); await onReview?.(); return reviews.shift() ?? { kind: "dismissed" }; },
			showReadyPlanMenu: async () => {}, showPlanModeMenu: async (_ctx: unknown, menu: Record<string, unknown>) => { menus.push(menu); }, showActiveImplementationMenu: async () => {}, showPlanLaunchMenu: async () => {},
		}) as never,
	});
	const installTasks = () => tasks(mock.pi, { loadInteractiveUi: async () => ({}) as never });
	if (order === "plan-first") { installPlan(); installTasks(); } else { installTasks(); installPlan(); }
	async function emit(event: string, payload = {}) { for (const handler of mock.events.get(event) ?? []) await handler(payload, context.ctx); }
	t.after(async () => { await emit("session_shutdown"); process.env.PI_CODING_AGENT_DIR = previous; await rm(dir, { recursive: true, force: true }); });
	await emit("session_start", { reason: "new" });
	async function tool(name: string, input: unknown) {
		const definition = mock.tools.find((x) => x.name === name)!;
		return (definition.execute as (...args: unknown[]) => Promise<{ details: Record<string, unknown>; isError?: boolean }>)("call", input, undefined, undefined, context.ctx);
	}
	const command = (args: string) => mock.commands.get("plan")!.handler(args, context.ctx);
	const planState = () => mock.entries.filter((e) => e.customType === "plan-mode-state").at(-1)!.data as Record<string, any>;
	async function initial() { await command("start"); await tool("plan_mode_complete", { plan: "# Ship\n\nMigrate then deploy. Verify tests.", tasks: seed }); await command("implement"); assert.equal(planState().enabled, false, JSON.stringify(context.notifications)); }
	async function get() { return (await tool("get_tasks", {})).details as unknown as TaskView; }
	async function progress(changes: unknown[]) { const current = await get(); return tool("update_tasks", { mode: "apply", taskSetId: current.taskSetId, expectedRevision: current.revision, changes }); }
	return { mock, context, tool, command, initial, get, progress, planState, emit, reviewRequests, menus, setSessionId(id: string) { sessionId = id; }, setReviewHook(fn: () => Promise<void>) { onReview = fn; } };
}
for (const order of ["plan-first", "tasks-first"] as const) {
	test(`${order}: initial binding, routine progress, bound scope refusal and task-aware completion`, async (t) => {
		const h = await setup(t, order);
		await h.initial();
		const set = await h.get();
		assert.equal(set.binding?.planId, h.planState().planId);
		assert.equal(set.phases[0].tasks.length, 2);
		await assert.rejects(h.tool("plan_implemented", {}), /unfinished task/u);
		const scope = await h.progress([{ op: "add_phase", name: "Oops" }]);
		assert.equal(scope.details.status, "requires_plan_revision");
		await h.progress([{ op: "done", taskId: "t1", summary: "migration verified" }]);
		await h.progress([{ op: "abandon", taskId: "t2", summary: "deployment explicitly dropped" }]);
		await h.tool("plan_implemented", {});
		assert.equal(h.planState().planPath, undefined);
	});
	test(`${order}: combined revision preserves completion evidence and requires reopening changed closed work`, async (t) => {
		const h = await setup(t, order, [{ kind: "accepted" }]);
		await h.initial();
		await h.progress([{ op: "done", taskId: "t1", summary: "tested migration" }]);
		const b = await h.tool("update_plan", { action: "begin", expectedRevision: h.planState().specRevision, instructions: "change deployment" });
		assert.equal(b.isError, undefined);
		const current = b.details.tasks as unknown as TaskView;
		assert.equal(current.phases[0].tasks[0].completion?.summary, "tested migration");
		const revised: TaskSeed = { expectedTaskRevision: current.revision, phases: [{ id: "p1", name: "Delivery", tasks: [{ id: "t1", content: "Migrate" }, { id: "t2", content: "Rolling deploy" }, { content: "Observe" }] }] };
		const result = await h.tool("update_plan", { action: "propose", revisionId: b.details.revisionId, expectedRevision: b.details.baseRevision, plan: "# Ship\n\nMigrate then rolling deploy and observe.", changeSummary: "migration unchanged", tasks: revised });
		assert.equal(result.isError, undefined, JSON.stringify(result.details));
		assert.equal(result.details.status, "accepted");
		assert.ok(h.reviewRequests[0].diff.join("\n").includes("Rolling deploy"));
		const after = await h.get();
		assert.equal(after.phases[0].tasks[0].status, "completed");
		assert.equal(after.phases[0].tasks[0].completion?.summary, "tested migration");
		assert.equal(after.phases[0].tasks[2].id, "t3");
		assert.equal(h.planState().approvedDigest, undefined);
		await h.command("implement");
		assert.equal(h.planState().enabled, false);
	});
}

test("task progress during combined review refuses the stale proposal rather than overwriting progress", async (t) => {
	const h = await setup(t, "plan-first", [{ kind: "accepted" }]);
	await h.initial();
	const b = await h.tool("update_plan", { action: "begin", expectedRevision: 1, instructions: "change plan" });
	const current = b.details.tasks as unknown as TaskView;
	h.setReviewHook(async () => { await h.progress([{ op: "done", taskId: "t1", summary: "finished while reviewing" }]); });
	const r = await h.tool("update_plan", { action: "propose", revisionId: b.details.revisionId, expectedRevision: b.details.baseRevision, plan: "# Different", changeSummary: "changed", tasks: { expectedTaskRevision: current.revision, phases: current.phases } });
	assert.equal(r.details.status, "stale_tasks");
	assert.equal(h.planState().specRevision, 1);
	assert.equal((await h.get()).phases[0].tasks[0].status, "completed");
});

test("a lost bind acknowledgement keeps implementation blocked and exact retry converges", async (t) => {
	const h = await setup(t, "plan-first", [{ kind: "accepted" }]);
	await h.initial();
	const b = await h.tool("update_plan", { action: "begin", expectedRevision: 1, instructions: "change" });
	const current = b.details.tasks as unknown as TaskView;
	const emit = h.mock.eventBus.emit;
	let bindRequest: string | undefined;
	let drop = true;
	h.mock.eventBus.emit = (channel, raw) => {
		const data = raw as Record<string, unknown>;
		if (channel === "hank:tasks:request.v1" && data.operation === "bind") bindRequest = String(data.requestId);
		if (drop && channel === "hank:tasks:response.v1" && data.requestId === bindRequest) {
			drop = false;
			emit(channel, { ...data, data: undefined, error: { code: "lost_ack", message: "binding acknowledgement unavailable" } });
		} else emit(channel, raw);
	};
	const result = await h.tool("update_plan", { action: "propose", revisionId: b.details.revisionId, expectedRevision: 1, plan: "# Revised", changeSummary: "same tasks", tasks: { expectedTaskRevision: current.revision, phases: current.phases } });
	assert.equal(result.details.status, "binding_pending");
	assert.equal(h.planState().enabled, true);
	assert.equal(h.planState().taskTracking.pending, true);
	const revision = (await h.get()).revision;
	await h.command("implement");
	assert.equal(h.planState().enabled, false);
	assert.equal(h.planState().taskTracking.pending, false);
	assert.equal((await h.get()).revision, revision, "retry does not bind twice");
});

test("provider loss cannot turn bound work into an unbound completed plan", async (t) => {
	const h = await setup(t, "tasks-first");
	await h.initial();
	h.mock.rawPi.getAllTools = () => [];
	await assert.rejects(h.tool("plan_implemented", {}), /provider is unavailable/u);
	assert.ok(h.planState().planPath);
	const begin = await h.tool("update_plan", { action: "begin", expectedRevision: 1, instructions: "revise while provider is missing" });
	assert.equal(begin.isError, true);
	assert.equal(begin.details.status, "tasks_unavailable");
	assert.ok(begin.details.revisionId, "preserve the paused transaction for recovery");
	assert.equal(h.planState().enabled, true);
});

test("initial task binding leaves unrelated standalone work intact", async (t) => {
	const h = await setup(t, "tasks-first");
	await h.tool("update_tasks", { mode: "apply", changes: [{ op: "init", phases: [{ name: "Other", tasks: ["unrelated"] }] }] });
	const standalone = await h.get();
	await h.initial();
	const bound = await h.get();
	assert.notEqual(bound.taskSetId, standalone.taskSetId);
	const old = await h.tool("get_tasks", { taskSetId: standalone.taskSetId });
	assert.equal((old.details.phases as TaskView["phases"])[0].tasks[0].content, "unrelated");
	assert.equal(old.details.attached, false);
});

test("headless combined proposal stays pending and cannot approve or bind itself", async (t) => {
	const h = await setup(t, "plan-first", [], false);
	await h.initial();
	const before = await h.get();
	const b = await h.tool("update_plan", { action: "begin", expectedRevision: 1, instructions: "change" });
	const r = await h.tool("update_plan", { action: "propose", revisionId: b.details.revisionId, expectedRevision: 1, plan: "# Changed", changeSummary: "same tasks", tasks: { expectedTaskRevision: before.revision, phases: before.phases } });
	assert.equal(r.details.status, "pending_review");
	assert.equal((await h.get()).revision, before.revision);
	assert.equal(h.planState().specRevision, 1);
});

test("a task-only scope revision creates a new spec and requires explicit reopening of closed work", async (t) => {
	const h = await setup(t, "plan-first", [{ kind: "accepted" }]);
	await h.initial();
	await h.progress([{ op: "done", taskId: "t1", summary: "original migration tested" }]);
	const b = await h.tool("update_plan", { action: "begin", expectedRevision: 1, instructions: "expand migration task" });
	const current = b.details.tasks as unknown as TaskView;
	const reconciled: TaskSeed = { expectedTaskRevision: current.revision, phases: [{ id: "p1", name: "Delivery", tasks: [{ id: "t1", content: "Migrate two schemas" }, { id: "t2", content: "Deploy" }] }] };
	const input = { action: "propose", revisionId: b.details.revisionId, expectedRevision: 1, plan: "# Ship\n\nMigrate then deploy. Verify tests.", changeSummary: "Task scope expands while prose remains the same", tasks: reconciled };
	assert.equal((await h.tool("update_plan", input)).details.status, "tasks_not_reconciled");
	reconciled.phases[0].tasks[0].reopen = true;
	assert.equal((await h.tool("update_plan", input)).details.status, "accepted");
	assert.equal(h.planState().specRevision, 2);
	const changed = (await h.get()).phases[0].tasks[0];
	assert.equal(changed.status, "pending");
	// get_tasks calls this field supersededCompletions; the bridge carries the
	// model's completionHistory so the next combined revision can reconcile it.
	const next = await h.tool("update_plan", { action: "begin", expectedRevision: 2, instructions: "inspect retained evidence" });
	assert.equal((next.details.tasks as unknown as TaskView).phases[0].tasks[0].completionHistory?.[0].summary, "original migration tested");
});

for (const outcome of [{ kind: "cancelled" }, { kind: "changes_requested", feedback: "keep deployment unchanged" }] as PlanRevisionOutcome[]) {
	test(`combined ${outcome.kind} leaves the plan/task baseline unchanged`, async (t) => {
		const h = await setup(t, "tasks-first", [outcome]);
		await h.initial();
		const before = await h.get();
		const b = await h.tool("update_plan", { action: "begin", expectedRevision: 1, instructions: "change" });
		const r = await h.tool("update_plan", { action: "propose", revisionId: b.details.revisionId, expectedRevision: 1, plan: "# Changed", changeSummary: "same tasks", tasks: { expectedTaskRevision: before.revision, phases: before.phases } });
		assert.equal(r.details.status, outcome.kind);
		assert.equal((await h.get()).revision, before.revision);
		assert.equal(h.planState().specRevision, 1);
		if (outcome.kind === "changes_requested") assert.equal(r.details.feedback, outcome.feedback);
	});
}

for (const scenario of ["success", "provider-refuses", "setup-fails", "cancelled"] as const) {
	test(`fresh combined handoff: ${scenario}`, async (t) => {
		const h = await setup(t, "tasks-first");
		await h.command("start");
		await h.tool("plan_mode_complete", { plan: "# Fresh delivery", tasks: seed });
		const sent: string[] = [];
		const destinationEntries: { customType: string; data: unknown }[] = [];
		const ctx = h.context.ctx as unknown as Record<string, unknown>;
		ctx.newSession = async (options: { setup(manager: unknown): Promise<void>; withSession(ctx: unknown): Promise<void> }) => {
			if (scenario === "cancelled") return { cancelled: true };
			await options.setup({ appendCustomEntry(customType: string, data: unknown) {
				if (scenario === "setup-fails" && customType === "pi-tasks-state") throw new Error("task setup failed");
				destinationEntries.push({ customType, data });
			} });
			h.mock.entries.splice(0, h.mock.entries.length, ...destinationEntries);
			h.setSessionId("fresh-session");
			await h.emit("session_start", { reason: "new" });
			if (scenario === "provider-refuses") h.mock.eventBus.on("hank:tasks:request.v1", (raw) => {
				const r = raw as Record<string, unknown>;
				if (r.operation === "attach") h.mock.eventBus.emit("hank:tasks:response.v1", { ...r, error: { code: "unavailable", message: "task provider unavailable in destination" } });
			});
			await options.withSession({ ...ctx, sendUserMessage: async (text: string) => { sent.push(text); } });
			return { cancelled: false };
		};
		await h.command("");
		const fresh = h.menus.at(-1)!.implementFresh as (signal: AbortSignal) => Promise<void>;
		await fresh(new AbortController().signal);
		assert.equal(sent.length, scenario === "success" ? 1 : 0);
		if (scenario === "success") {
			assert.deepEqual(destinationEntries.map((e) => e.customType), ["plan-mode-state", "pi-tasks-state"]);
			assert.equal((await h.get()).binding?.planId, h.planState().planId);
			assert.equal(h.planState().enabled, false);
		}
		if (scenario === "cancelled") {
			assert.equal(h.planState().enabled, true);
			assert.equal(destinationEntries.length, 0);
		}
	});
}

test("ordinary new sessions do not inherit the previous plan or task attachment", async (t) => {
	const h = await setup(t, "tasks-first");
	await h.initial();
	h.mock.entries.length = 0;
	h.setSessionId("unrelated-session");
	await h.emit("session_start", { reason: "new" });
	const tasks = await h.tool("get_tasks", {});
	assert.equal(tasks.details.status, "no_task_set");
	const update = await h.tool("update_plan", { action: "begin", expectedRevision: 1, instructions: "edit" });
	assert.equal(update.details.status, "no_plan");
});
