import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PLANS_DIRECTORY = "plans";
const MAX_PLAN_BYTES = 1024 * 1024;

/**
 * The durable plan file is the plan. Session state stores only its path, so a
 * plan survives compaction, resume, and hand-editing without ever being copied
 * into model context.
 */
export function plansDirectory() {
	return join(getAgentDir(), PLANS_DIRECTORY);
}

/**
 * Session ids come from Pi and are normally uuid-like, but they reach a
 * filesystem path here: constrain them to a safe basename so a hostile or
 * unusual id cannot escape the plans directory.
 */
export function planFilePathForSession(sessionId: string | undefined) {
	return join(plansDirectory(), `${safeSessionSegment(sessionId)}.md`);
}

function safeSessionSegment(sessionId: string | undefined) {
	const normalized = (sessionId ?? "").trim().replace(/[^\w.-]/gu, "-");
	const trimmed = normalized.replace(/^[.-]+/u, "").slice(0, 128);
	// In-memory sessions have no id; fall back to a stable per-process name so
	// the plan still persists for the lifetime of the session.
	return trimmed || `session-${process.pid}`;
}

/**
 * Atomic same-directory temp + rename, matching how settings are published, so
 * a concurrent reader never observes a partially written plan.
 */
export async function writePlanFile(path: string, plan: string): Promise<void> {
	const contents = plan.endsWith("\n") ? plan : `${plan}\n`;
	if (Buffer.byteLength(contents, "utf8") > MAX_PLAN_BYTES) {
		throw new Error(`plan exceeds ${MAX_PLAN_BYTES} bytes`);
	}
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

/**
 * Always read from disk. The user may hand-edit the plan while implementation
 * is under way, and that edit must be what the agent and every command see.
 */
export async function readPlanFile(path: string): Promise<string | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	} catch {
		return undefined;
	}
	try {
		const stats = await handle.stat();
		if (!stats.isFile() || stats.size > MAX_PLAN_BYTES) return undefined;
		const contents = await handle.readFile({ encoding: "utf8" });
		return contents.trim() ? contents : undefined;
	} catch {
		return undefined;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

export async function deletePlanFile(path: string): Promise<void> {
	await unlink(path).catch(() => undefined);
}
