import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	link,
	lstat,
	mkdir,
	open,
	readdir,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PLANS_DIRECTORY = "plans";
/** Refused outright rather than truncated: a bigger plan file is a broken one. */
export const MAX_PLAN_BYTES = 1024 * 1024;

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
export function writePlanFile(path: string, plan: string): Promise<void> {
	return serializeSlot(path, () => writeNow(path, plan));
}

async function writeNow(path: string, plan: string): Promise<void> {
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

const MAX_ARCHIVE_ATTEMPTS = 1000;

function splitArchiveStem(path: string) {
	const extension = extname(path);
	return { stem: path.slice(0, path.length - extension.length), extension };
}

/**
 * The newest archive of a live slot, by number, or undefined when there is
 * none. Derived from disk rather than from session state because the session
 * that archived the plan may not be this one: a fresh implementation session
 * shares its parent's slot, and when it finishes, the parent's pointer names
 * a file that has moved. The parent cannot read the child's entries, but it
 * can read the directory.
 */
export async function latestArchiveFor(path: string): Promise<string | undefined> {
	const { stem, extension } = splitArchiveStem(path);
	const directory = dirname(path);
	const prefix = `${basename(stem)}.`;
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return undefined;
	}
	let best: { n: number; name: string } | undefined;
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(extension)) continue;
		const middle = name.slice(prefix.length, name.length - extension.length);
		if (!/^[1-9]\d*$/u.test(middle)) continue;
		const n = Number(middle);
		if (!best || n > best.n) best = { n, name };
	}
	return best ? join(directory, best.name) : undefined;
}

/**
 * One in-flight archive per live slot. The archive is link-then-unlink, and
 * between those two calls a `writePlanFile` to the same slot would rename a
 * new inode into the pathname the unlink is about to remove — the archive
 * would hold the old plan and the new one would be gone. Chaining every
 * archive of a path behind the previous one, and every write behind any
 * archive, closes that window for everything this module does; the inode
 * check below covers a writer that is not this module.
 */
const slotQueues = new Map<string, Promise<unknown>>();

function serializeSlot<T>(path: string, work: () => Promise<T>): Promise<T> {
	const previous = slotQueues.get(path) ?? Promise.resolve();
	const run = previous.then(work, work);
	const settled = run.then(
		() => undefined,
		() => undefined,
	);
	slotQueues.set(path, settled);
	void settled.then(() => {
		if (slotQueues.get(path) === settled) slotQueues.delete(path);
	});
	return run;
}

/**
 * Move a finished or superseded plan out of the way without losing it:
 * `plans/<session-id>.md` becomes `plans/<session-id>.<n>.md` at the first
 * free `n`, so the history of a session that plans several times sits next to
 * its live plan. Returns the archive path, or undefined when there was
 * nothing to archive.
 *
 * `link` + `unlink` rather than `rename`: `link` fails on an existing target
 * where `rename` silently replaces it, so two archives can never land on the
 * same number. The source is only unlinked when it is still the inode that
 * was linked — a plan written into the slot by someone else in the meantime
 * is left where it is and reported, never deleted. A symlink is refused
 * outright: `link` would archive the symlink, not the plan behind it, and an
 * archive that changes when its target changes is not a record.
 */
export function archivePlanFile(path: string): Promise<string | undefined> {
	return serializeSlot(path, () => archiveNow(path));
}

async function archiveNow(path: string): Promise<string | undefined> {
	let source: Awaited<ReturnType<typeof lstat>>;
	try {
		source = await lstat(path);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (source.isSymbolicLink()) throw new Error(`refusing to archive a symlink: ${path}`);
	if (!source.isFile()) throw new Error(`refusing to archive a non-file: ${path}`);

	const { stem, extension } = splitArchiveStem(path);
	for (let attempt = 1; attempt <= MAX_ARCHIVE_ATTEMPTS; attempt += 1) {
		const target = `${stem}.${attempt}${extension}`;
		try {
			await link(path, target);
		} catch (error: unknown) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST") continue;
			if (code === "ENOENT") return undefined;
			throw error;
		}
		const still = await stat(path).catch(() => undefined);
		if (still && (still.ino !== source.ino || still.dev !== source.dev)) {
			throw new Error(
				`plan at ${path} was replaced while it was being archived; the previous plan is at ${target} and the new one is untouched`,
			);
		}
		try {
			await unlink(path);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return target;
	}
	throw new Error(`no free archive name for ${path} after ${MAX_ARCHIVE_ATTEMPTS} attempts`);
}
