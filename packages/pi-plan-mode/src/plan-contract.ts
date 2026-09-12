/** Versioned inter-extension data only. Kept byte-identical in both packages. */
export const TASK_REQUEST = "hank:tasks:request.v1";
export const TASK_RESPONSE = "hank:tasks:response.v1";
export const TASK_STATUS = "hank:tasks:status.v1";
export const TASK_PROTOCOL = 1;
export const TASK_TIMEOUT_MS = 5_000;
export interface PlanBinding { planId: string; specRevision: number; digest: string }
export interface TaskSeed {
	expectedTaskRevision?: number;
	phases: { id?: string; name: string; tasks: { id?: string; content: string; reopen?: boolean }[] }[];
}
export interface BoundTaskRef { taskSetId: string }
export interface TaskView {
	taskSetId: string;
	revision: number;
	binding?: PlanBinding;
	phases: { id: string; name: string; tasks: {
		id: string; content: string; status: "pending" | "in_progress" | "blocked" | "completed" | "abandoned";
		blocker?: string; completion?: { summary: string; recordedAt: string };
		completionHistory?: { summary: string; recordedAt: string }[];
	}[] }[];
}
export interface TasksRequest {
	version: 1; requestId: string; sessionId: string;
	operation: "describe" | "get" | "bind" | "attach";
	taskSetId?: string; binding?: PlanBinding; tasks?: TaskSeed;
}
export interface TaskAttachment { taskSetId: string; revision: number; digest: string; recordedAt: string }
export interface TasksData { version: 1; set?: TaskView; diff?: string; attachment?: TaskAttachment }
export interface TasksResponse {
	version: 1; requestId: string; sessionId: string;
	data?: TasksData; error?: { code: string; message: string };
}
export const TASK_SEED_SCHEMA = {
	type: "object", additionalProperties: false, required: ["phases"],
	properties: {
		expectedTaskRevision: { type: "integer", minimum: 0 },
		phases: { type: "array", maxItems: 100, items: {
			type: "object", additionalProperties: false, required: ["name", "tasks"],
			properties: { id: { type: "string" }, name: { type: "string", minLength: 1, maxLength: 200 },
				tasks: { type: "array", maxItems: 200, items: {
					type: "object", additionalProperties: false, required: ["content"],
					properties: { id: { type: "string" }, content: { type: "string", minLength: 1, maxLength: 2000 }, reopen: { type: "boolean" } },
				} },
			},
		} },
	},
} as const;
export function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function safeId(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}
export function revision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function validBinding(value: unknown): value is PlanBinding {
	return object(value) && safeId(value.planId) && revision(value.specRevision) && value.specRevision > 0 &&
		typeof value.digest === "string" && /^[a-f0-9]{64}$/u.test(value.digest);
}
export function sameBinding(a: PlanBinding | undefined, b: PlanBinding | undefined): boolean {
	return !!a && !!b && a.planId === b.planId && a.specRevision === b.specRevision && a.digest === b.digest;
}
function text(value: unknown, max: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\r\n\0]|<!--|-->/u.test(value);
}
/** Validate persisted and model-authored seeds too, not only tool JSON Schema. */
export function parseTaskSeed(value: unknown): TaskSeed {
	if (!object(value) || !Array.isArray(value.phases) || value.phases.length > 100 ||
		(value.expectedTaskRevision !== undefined && !revision(value.expectedTaskRevision))) throw new Error("tasks requires phases and a non-negative expectedTaskRevision");
	const ids = new Set<string>();
	const id = (value: unknown, prefix: string) => {
		if (value === undefined) return undefined;
		if (typeof value !== "string" || !new RegExp(`^${prefix}[1-9][0-9]*$`, "u").test(value) || ids.has(value)) throw new Error("duplicate or invalid task/phase id");
		ids.add(value); return value;
	};
	return {
		...(value.expectedTaskRevision !== undefined ? { expectedTaskRevision: value.expectedTaskRevision as number } : {}),
		phases: value.phases.map((p) => {
			if (!object(p) || !text(p.name, 200) || !Array.isArray(p.tasks) || p.tasks.length > 200) throw new Error("invalid task phase");
			const phaseId = id(p.id, "p");
			return { ...(phaseId ? { id: phaseId } : {}), name: p.name.trim(), tasks: p.tasks.map((t) => {
				if (!object(t) || !text(t.content, 2000) || (t.reopen !== undefined && typeof t.reopen !== "boolean")) throw new Error("invalid task seed item");
				const taskId = id(t.id, "t");
				return { ...(taskId ? { id: taskId } : {}), content: t.content.trim(), ...(t.reopen !== undefined ? { reopen: t.reopen } : {}) };
			}) };
		}),
	};
}
export function validTaskView(value: unknown): value is TaskView {
	if (!object(value) || !safeId(value.taskSetId) || !revision(value.revision) || !validBinding(value.binding)) return false;
	try {
		parseTaskSeed(value);
		return Array.isArray(value.phases) && value.phases.every((p) => object(p) && typeof p.id === "string" && Array.isArray(p.tasks) && p.tasks.every((t) => object(t) && typeof t.id === "string" && ["pending", "in_progress", "blocked", "completed", "abandoned"].includes(String(t.status))));
	} catch { return false; }
}
