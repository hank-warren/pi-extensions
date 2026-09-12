import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TASK_REQUEST, TASK_RESPONSE, TASK_TIMEOUT_MS, object, validTaskView, safeId, revision, type TasksRequest, type TasksData } from "./plan-contract.js";

/** One reply subscription per request, installed before emit and always removed. */
export function createTasksClient(pi: ExtensionAPI, timeoutMs = TASK_TIMEOUT_MS) {
	const pending = new Set<() => void>();
	return {
		present: () => pi.getAllTools().some((tool) => tool.name === "get_tasks"),
		close() { for (const cancel of [...pending]) cancel(); },
		request(ctx: ExtensionContext, input: Omit<TasksRequest, "version" | "requestId" | "sessionId">, signal?: AbortSignal): Promise<TasksData> {
			const request: TasksRequest = { ...input, version: 1, requestId: randomUUID(), sessionId: ctx.sessionManager.getSessionId() ?? "" };
			return new Promise((resolve, reject) => {
				let settled = false;
				let unsubscribe = () => {};
				let timer: ReturnType<typeof setTimeout> | undefined;
				const cancel = () => finish(new Error("task request cancelled by session/workflow change"));
				const finish = (error?: Error, data?: TasksData) => {
					if (settled) return; settled = true;
					if (timer) clearTimeout(timer);
					unsubscribe(); signal?.removeEventListener("abort", cancel); pending.delete(cancel);
					if (error) reject(error); else resolve(data!);
				};
				unsubscribe = pi.events.on(TASK_RESPONSE, (raw: unknown) => {
					if (!object(raw) || raw.requestId !== request.requestId || raw.sessionId !== request.sessionId) return;
					if (raw.version !== 1) return finish(new Error("incompatible task provider response"));
					if (object(raw.error)) return finish(new Error(String(raw.error.message ?? "task provider refused request")));
					if (!object(raw.data) || raw.data.version !== 1 || (raw.data.set !== undefined && !validTaskView(raw.data.set)) || (raw.data.diff !== undefined && typeof raw.data.diff !== "string")) return finish(new Error("invalid task provider response"));
					if (raw.data.set !== undefined && raw.data.set.taskSetId !== request.taskSetId) return finish(new Error("task response belongs to another set"));
					const a = raw.data.attachment;
					if (a !== undefined && (!object(a) || !safeId(a.taskSetId) || a.taskSetId !== request.taskSetId || !revision(a.revision) || typeof a.digest !== "string" || !/^[a-f0-9]{64}$/u.test(a.digest) || typeof a.recordedAt !== "string" || !raw.data.set || a.revision !== raw.data.set.revision)) return finish(new Error("invalid task attachment response"));
					finish(undefined, raw.data as unknown as TasksData);
				});
				pending.add(cancel); signal?.addEventListener("abort", cancel, { once: true });
				if (signal?.aborted) return cancel();
				timer = setTimeout(() => finish(new Error("task provider timed out; no binding or completion was acknowledged")), timeoutMs);
				try { pi.events.emit(TASK_REQUEST, request); } catch (e) { finish(e instanceof Error ? e : new Error(String(e))); }
			});
		},
	};
}
