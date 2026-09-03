import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const PLAN_MODE_SETTINGS_FILE = "pi-plan-mode.json";
const MAX_SETTINGS_BYTES = 64 * 1024;
export const DEFAULT_PLAN_EXPORT_PATH = "PLAN.md";
const MAX_PLAN_EXPORT_PATH_LENGTH = 4096;

export interface PlanModeSettings {
	defaultPlanExportPath?: string;
}
export interface PlanModeSettingsPatch {
	defaultPlanExportPath?: string | null;
}
export interface UpdatePlanModeSettingsOptions {
	settingsPath?: string;
	signal?: AbortSignal;
	beforeRename?: (temporaryPath: string, settingsPath: string) => Promise<void>;
}
export type PlanModeSettingsLoadResult =
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "loaded"; settings: PlanModeSettings };

type SettingsDocument = Record<string, unknown>;
type SettingsSnapshot = {
	result: PlanModeSettingsLoadResult;
	document?: SettingsDocument;
};

const mutationQueues = new Map<string, Promise<void>>();

export function planModeSettingsPath() {
	return join(getAgentDir(), PLAN_MODE_SETTINGS_FILE);
}

/**
 * Unknown top-level keys are tolerated and preserved on save. Settings removed
 * over time (defaultPlanTools, bashPolicy, safeSubcommands,
 * implementationPlanRetention, thinkingLevel) therefore keep an existing file
 * valid instead of failing it closed on upgrade.
 */
export function normalizePlanModeSettings(value: unknown): PlanModeSettings | undefined {
	if (!isSettingsDocument(value)) return undefined;
	const settings: PlanModeSettings = {};
	if (Object.hasOwn(value, "defaultPlanExportPath")) {
		const defaultPlanExportPath = normalizePlanExportPath(
			Reflect.get(value, "defaultPlanExportPath"),
		);
		if (!defaultPlanExportPath) return undefined;
		settings.defaultPlanExportPath = defaultPlanExportPath;
	}
	return settings;
}

function normalizePlanExportPath(value: unknown) {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (
		!normalized ||
		normalized.length > MAX_PLAN_EXPORT_PATH_LENGTH ||
		!/[^@\s]/u.test(normalized) ||
		[...normalized].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
		})
	) {
		return undefined;
	}
	return normalized;
}

export async function readPlanModeSettings(
	settingsPath = planModeSettingsPath(),
): Promise<PlanModeSettingsLoadResult> {
	await awaitPlanModeSettingsWrites(settingsPath);
	return (await readSettingsSnapshot(settingsPath)).result;
}

export function updatePlanModeSettings(
	patch: PlanModeSettingsPatch,
	options: UpdatePlanModeSettingsOptions = {},
): Promise<PlanModeSettings> {
	const settingsPath = options.settingsPath ?? planModeSettingsPath();
	return enqueueMutation(settingsPath, async () => {
		options.signal?.throwIfAborted();
		const current = await readSettingsDocumentForUpdate(settingsPath);
		const updated: SettingsDocument = { ...current };
		if (patch.defaultPlanExportPath === null) delete updated.defaultPlanExportPath;
		else if (patch.defaultPlanExportPath !== undefined) {
			updated.defaultPlanExportPath = patch.defaultPlanExportPath;
		}
		const settings = normalizePlanModeSettings(updated);
		if (!settings) throw invalidSettingsError(settingsPath, "invalid settings shape");
		await publishSettings(settingsPath, updated, options.signal, options.beforeRename);
		return settings;
	});
}

export async function awaitPlanModeSettingsWrites(
	settingsPath = planModeSettingsPath(),
): Promise<void> {
	await mutationQueues.get(settingsPath);
}

function enqueueMutation<T>(settingsPath: string, mutation: () => Promise<T>): Promise<T> {
	const previous = mutationQueues.get(settingsPath) ?? Promise.resolve();
	const result = previous.then(mutation, mutation);
	const settled = result.then(
		() => undefined,
		() => undefined,
	);
	mutationQueues.set(settingsPath, settled);
	void settled.finally(() => {
		if (mutationQueues.get(settingsPath) === settled) mutationQueues.delete(settingsPath);
	});
	return result;
}

async function readSettingsDocumentForUpdate(settingsPath: string): Promise<SettingsDocument> {
	const snapshot = await readSettingsSnapshot(settingsPath);
	if (snapshot.result.kind === "invalid") {
		throw invalidSettingsError(settingsPath, snapshot.result.reason);
	}
	return snapshot.result.kind === "loaded" ? (snapshot.document ?? {}) : {};
}

async function readSettingsSnapshot(settingsPath: string): Promise<SettingsSnapshot> {
	let contents: string;
	try {
		contents = await readSettingsContents(settingsPath);
	} catch (error: unknown) {
		if (isNodeError(error) && error.code === "ENOENT") return { result: { kind: "missing" } };
		return { result: { kind: "invalid", reason: safeReadError(error) } };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents) as unknown;
	} catch {
		return { result: { kind: "invalid", reason: "invalid JSON" } };
	}
	const settings = normalizePlanModeSettings(parsed);
	if (!settings || !isSettingsDocument(parsed)) {
		return { result: { kind: "invalid", reason: "invalid settings shape" } };
	}
	return { document: parsed, result: { kind: "loaded", settings } };
}

async function readSettingsContents(settingsPath: string): Promise<string> {
	const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
	const handle = await open(settingsPath, flags);
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error("settings path is not a regular file");
		if (stats.size > MAX_SETTINGS_BYTES) {
			throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
		}
		const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
		let offset = 0;
		while (offset < buffer.byteLength) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > MAX_SETTINGS_BYTES) {
			throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
		}
		try {
			return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				buffer.subarray(0, offset),
			);
		} catch {
			throw new Error("settings file is not valid UTF-8");
		}
	} finally {
		await handle.close();
	}
}

async function publishSettings(
	settingsPath: string,
	document: SettingsDocument,
	signal?: AbortSignal,
	beforeRename?: (temporaryPath: string, settingsPath: string) => Promise<void>,
): Promise<void> {
	signal?.throwIfAborted();
	const contents = `${JSON.stringify(document, null, 2)}\n`;
	if (Buffer.byteLength(contents, "utf8") > MAX_SETTINGS_BYTES) {
		throw new Error(`settings document exceeds ${MAX_SETTINGS_BYTES} bytes`);
	}
	const directory = dirname(settingsPath);
	await mkdir(directory, { recursive: true });
	signal?.throwIfAborted();
	const temporaryPath = join(
		directory,
		`.${basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		await writeFile(temporaryPath, contents, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
			signal,
		});
		await beforeRename?.(temporaryPath, settingsPath);
		signal?.throwIfAborted();
		await rename(temporaryPath, settingsPath);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

function isSettingsDocument(value: unknown): value is SettingsDocument {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSettingsError(settingsPath: string, reason: string) {
	return new Error(`pi-plan-mode settings at ${settingsPath} are invalid: ${reason}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function safeReadError(error: unknown) {
	if (isNodeError(error) && error.code === "ELOOP") return "settings path is not a regular file";
	return error instanceof Error ? error.message : String(error);
}

export function configuredPlanExportPath(settings: PlanModeSettings) {
	return settings.defaultPlanExportPath ?? DEFAULT_PLAN_EXPORT_PATH;
}
