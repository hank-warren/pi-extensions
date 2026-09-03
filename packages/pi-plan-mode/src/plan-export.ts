import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { readPlanFile } from "./plan-file.js";
import { DEFAULT_PLAN_EXPORT_PATH } from "./settings.js";
import type { PlanModeState } from "./state.js";

export { DEFAULT_PLAN_EXPORT_PATH };

interface PlanExportResult {
	path: string;
}

export interface PlanExportDestination {
	configuredPath: string;
	resolvedPath: string;
}

interface PlanExportLifecycle {
	signal: AbortSignal;
	isCurrent(): boolean;
	getState?(): PlanModeState;
	finishReady?(): void;
}

/**
 * Export copies the durable plan file to a user-chosen path. The plan is read
 * from disk at export time, so a hand-edited plan exports as edited.
 */
export async function exportStoredPlan(
	state: PlanModeState,
	requestedPath: string | undefined,
	ctx: ExtensionContext,
	lifecycle?: PlanExportLifecycle,
	defaultPath = DEFAULT_PLAN_EXPORT_PATH,
) {
	const plan = state.planPath ? await readPlanFile(state.planPath) : undefined;
	if (!plan) {
		const error = new Error(
			"No completed plan is available to export. Use /plan finalize when planning is complete.",
		);
		if (!ctx.hasUI) throw error;
		ctx.ui.notify(error.message, "warning");
		return false;
	}

	const isCurrent = () =>
		!lifecycle ||
		(lifecycle.isCurrent() && (!lifecycle.getState || lifecycle.getState() === state));
	let result: PlanExportResult;
	try {
		result = await exportPlanToFile(
			plan,
			requestedPath,
			ctx.cwd,
			lifecycle?.signal,
			isCurrent,
			defaultPath,
		);
	} catch (error: unknown) {
		if (lifecycle?.signal.aborted || !isCurrent()) return false;
		if (!ctx.hasUI) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(safeNotification(`Unable to export plan: ${detail}`), "error");
		return false;
	}

	if (!isCurrent()) return false;
	const finishedReady = state.enabled && state.awaitingAction && lifecycle?.finishReady !== undefined;
	if (finishedReady) lifecycle.finishReady?.();
	const detail = finishedReady ? " Plan mode disabled." : "";
	ctx.ui.notify(safeNotification(`Plan exported to ${result.path}.${detail}`), "info");
	return true;
}

async function exportPlanToFile(
	plan: string,
	requestedPath: string | undefined,
	cwd: string,
	signal?: AbortSignal,
	isCurrent: () => boolean = () => true,
	defaultPath = DEFAULT_PLAN_EXPORT_PATH,
): Promise<PlanExportResult> {
	const path = resolvePlanExportPath(requestedPath, cwd, defaultPath);
	const contents = plan.endsWith("\n") ? plan : `${plan}\n`;
	await withFileMutationQueue(path, async () => {
		throwIfCancelled(signal, isCurrent);
		await mkdir(dirname(path), { recursive: true });
		throwIfCancelled(signal, isCurrent);
		try {
			await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
		} catch (error: unknown) {
			if (isNodeError(error) && error.code === "EEXIST") {
				throw new Error(
					`Plan export target already exists: ${path}. Choose another path or remove it first.`,
				);
			}
			throw error;
		}
	});
	return { path };
}

export function planExportDestination(defaultPath: string, cwd: string): PlanExportDestination {
	return {
		configuredPath: safeNotification(defaultPath),
		resolvedPath: safeNotification(resolvePlanExportPath(undefined, cwd, defaultPath)),
	};
}

function resolvePlanExportPath(
	requestedPath: string | undefined,
	cwd: string,
	defaultPath = DEFAULT_PLAN_EXPORT_PATH,
) {
	const rawPath = requestedPath?.trim() || defaultPath;
	const normalizedPath = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (!normalizedPath.trim()) throw new Error("Plan export path must not be empty.");
	if (normalizedPath.includes("\0")) {
		throw new Error("Plan export path must not contain NUL bytes.");
	}
	return resolve(cwd, normalizedPath);
}

function safeNotification(value: string) {
	let sanitized = "";
	for (const character of stripVTControlCharacters(value)) {
		const codePoint = character.codePointAt(0);
		sanitized +=
			codePoint !== undefined && codePoint > 0x1f && !(codePoint >= 0x7f && codePoint <= 0x9f)
				? character
				: " ";
	}
	return sanitized;
}

function throwIfCancelled(signal: AbortSignal | undefined, isCurrent: () => boolean) {
	if (!signal?.aborted && isCurrent()) return;
	throw signal?.reason instanceof Error
		? signal.reason
		: new DOMException("Plan export cancelled", "AbortError");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
