/**
 * The plan lives on disk, so session state carries only a pointer to it and
 * the ready-for-action flag. Plan mode holds no session-global state of its
 * own: thinking level and model are session settings it never touches.
 */
export interface PlanModeState {
	enabled: boolean;
	/** Absolute path to the durable plan file, once a plan has been written. */
	planPath?: string;
	/** A completed plan is waiting for the user to choose how to proceed. */
	awaitingAction: boolean;
}

type SessionEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
};

export function restorePlanModeState(entries: unknown[], stateEntryType: string): PlanModeState {
	const entry = newestStateEntry(entries, stateEntryType);
	if (!isRecord(entry?.data)) return { enabled: false, awaitingAction: false };

	const enabled = entry.data.enabled === true;
	const planPath = absolutePath(entry.data.planPath);
	return {
		enabled,
		planPath,
		awaitingAction: enabled && entry.data.awaitingAction === true && planPath !== undefined,
	};
}

function newestStateEntry(entries: unknown[], stateEntryType: string): SessionEntry | undefined {
	const branch = entries as SessionEntry[];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const candidate = branch[index];
		if (candidate?.type === "custom" && candidate.customType === stateEntryType) return candidate;
	}
	return undefined;
}

/**
 * Persisted paths are only trusted when they are absolute and free of NUL, so
 * malformed state can never redirect a read or a delete to a relative target.
 */
function absolutePath(value: unknown) {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (!normalized || normalized.includes("\0") || !normalized.startsWith("/")) return undefined;
	return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
