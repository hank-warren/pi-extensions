import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TasksController } from "./controller.js";
import { TASK_REQUEST, TASK_RESPONSE, object, safeId, validBinding, parseTaskSeed, type TasksRequest, type TasksResponse } from "./plan-contract.js";

/** Register before session_start so extension load order cannot lose the subscription. */
export function registerPlanBridge(pi: ExtensionAPI, controller: TasksController) {
	let context: ExtensionContext | undefined;
	let generation = 0;
	pi.events.on(TASK_REQUEST, (raw: unknown) => {
		if (!object(raw) || typeof raw.requestId !== "string" || typeof raw.sessionId !== "string") return;
		const ctx = context;
		if (!ctx || raw.sessionId !== ctx.sessionManager.getSessionId()) return;
		const epoch = generation;
		const respond = (result: Pick<TasksResponse, "data" | "error">) => {
			if (epoch !== generation || context !== ctx) return;
			pi.events.emit(TASK_RESPONSE, { version: 1, requestId: raw.requestId, sessionId: raw.sessionId, ...result });
		};
		void (async () => {
			if (raw.version !== 1) throw new Error("incompatible task bridge version");
			if (!["describe", "get", "bind", "attach"].includes(String(raw.operation))) throw new Error("unknown task bridge operation");
			if (raw.operation !== "describe" && !safeId(raw.taskSetId)) throw new Error("invalid task set id");
			if (["bind", "attach"].includes(String(raw.operation)) && !validBinding(raw.binding)) throw new Error("invalid plan binding");
			const request = { ...raw, ...(raw.tasks !== undefined ? { tasks: parseTaskSeed(raw.tasks) } : {}) } as unknown as TasksRequest;
			if (request.operation === "bind" && !request.tasks) throw new Error("bind requires reconciled task phases");
			const data = await controller.planRequest(request, ctx);
			respond({ data });
		})().catch((error: unknown) => respond({ error: { code: "tasks_unavailable", message: error instanceof Error ? error.message : String(error) } }));
	});
	return { setContext(ctx?: ExtensionContext) { generation++; context = ctx; } };
}
