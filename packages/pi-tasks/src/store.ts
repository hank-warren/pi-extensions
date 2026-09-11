/**
 * Durable storage for task sets.
 *
 * Layout, under `<agentDir>/tasks/<taskSetId>/`:
 *
 *   tasks.md              the accepted current document
 *   revisions/<n>.md      the immutable snapshot of every accepted revision
 *   revisions/orphan-*.md a snapshot an interrupted transaction prepared and
 *                         never published — retained, never accepted history
 *   proposals/<id>.json   candidate revisions awaiting review
 *   tasks.lock            the cross-process lock directory (proper-lockfile)
 *
 * Three layers of protection, each covering what the others cannot:
 *
 *   1. An in-process queue per path, so two tool calls in one session cannot
 *      interleave a read-modify-write. Pi's own `withFileMutationQueue` is the
 *      same idea for the same reason, and is likewise in-process only.
 *   2. `proper-lockfile` around the whole read-validate-write window, so two
 *      *cooperating* Pi sessions serialise against each other.
 *   3. A SHA-256 digest of the bytes the change was computed from, rechecked
 *      under the lock immediately before the write.
 *
 * What that is not: a compare-and-swap against a writer that ignores the lock.
 * An editor that rewrites `tasks.md` between the digest check and the rename
 * wins, and nothing on a POSIX filesystem stops it. The digest turns that into
 * a *detected* conflict at the next read instead of a silent merge, and every
 * accepted revision is still on disk under `revisions/`. This package makes no
 * stronger promise than that.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { lock } from "proper-lockfile";
import { parseTaskDocument, serializeTaskDocument, type TaskDocument } from "./markdown.js";

const TASKS_DIRECTORY = "tasks";
const DOCUMENT_NAME = "tasks.md";
const REVISIONS_DIRECTORY = "revisions";
const PROPOSALS_DIRECTORY = "proposals";
const LOCK_NAME = "tasks.lock";

/** Refused outright rather than truncated: a bigger file is a broken file. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

/** Long enough for a cooperating session to finish one commit. */
const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = { retries: 8, factor: 1.6, minTimeout: 20, maxTimeout: 400 } as const;

const TASK_SET_ID_RE = /^[0-9a-zA-Z][0-9a-zA-Z._-]{0,63}$/u;

export function isSafeTaskSetId(taskSetId: string): boolean {
	return TASK_SET_ID_RE.test(taskSetId) && !taskSetId.includes("..");
}

export function newTaskSetId(): string {
	return randomUUID();
}

export function tasksRootDirectory(): string {
	return join(getAgentDir(), TASKS_DIRECTORY);
}

export function taskSetDirectory(root: string, taskSetId: string): string {
	if (!isSafeTaskSetId(taskSetId)) throw new Error(`unsafe task set id: ${taskSetId}`);
	return join(root, taskSetId);
}

export function taskDocumentPath(root: string, taskSetId: string): string {
	return join(taskSetDirectory(root, taskSetId), DOCUMENT_NAME);
}

export function revisionsDirectory(root: string, taskSetId: string): string {
	return join(taskSetDirectory(root, taskSetId), REVISIONS_DIRECTORY);
}

export function proposalsDirectory(root: string, taskSetId: string): string {
	return join(taskSetDirectory(root, taskSetId), PROPOSALS_DIRECTORY);
}

export function digestOf(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface LoadedDocument {
	document: TaskDocument;
	/** The exact bytes on disk, so a later write can prove nothing moved. */
	raw: string;
	digest: string;
	path: string;
}

export type LoadResult =
	| { kind: "loaded"; loaded: LoadedDocument }
	| { kind: "missing" }
	| { kind: "invalid"; reason: string };

/**
 * Always reads from disk. Nothing is cached across calls: the point of a file
 * store is that another session — or a person — may have moved it.
 *
 * `expectedTaskSetId` is the identity the *caller* asked for. A document whose
 * metadata names a different set is refused rather than returned: it was read
 * from one directory and would otherwise be written back to another, which
 * turns a tampered or mis-copied file into a redirect of every later write.
 */
export async function loadTaskDocument(
	path: string,
	expectedTaskSetId?: string,
): Promise<LoadResult> {
	let raw: string;
	try {
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stats = await handle.stat();
			if (!stats.isFile()) return { kind: "invalid", reason: "task document is not a regular file" };
			if (stats.size > MAX_DOCUMENT_BYTES) {
				return {
					kind: "invalid",
					reason: `task document exceeds ${MAX_DOCUMENT_BYTES} bytes`,
				};
			}
			raw = await handle.readFile({ encoding: "utf8" });
		} finally {
			await handle.close().catch(() => undefined);
		}
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { kind: "missing" };
		if (code === "ELOOP") return { kind: "invalid", reason: "task document is a symlink" };
		return { kind: "invalid", reason: describe(error) };
	}
	const parsed = parseTaskDocument(raw);
	if (!parsed.ok) return { kind: "invalid", reason: parsed.error };
	if (expectedTaskSetId !== undefined && parsed.document.set.taskSetId !== expectedTaskSetId) {
		return {
			kind: "invalid",
			reason: `the document at ${path} claims task set ${parsed.document.set.taskSetId}, but ${expectedTaskSetId} was requested`,
		};
	}
	return {
		kind: "loaded",
		loaded: { document: parsed.document, raw, digest: digestOf(raw), path },
	};
}

/**
 * The newest accepted snapshot on disk, or undefined when there is none.
 *
 * Only `<n>.md` counts. An `orphan-` file is a prepared snapshot that was never
 * published, so offering it as recovered history would be exactly the "infer
 * approval from orphan bytes" mistake.
 */
export async function latestSnapshot(
	root: string,
	taskSetId: string,
): Promise<{ revision: number; path: string } | undefined> {
	const directory = revisionsDirectory(root, taskSetId);
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return undefined;
	}
	let best: { revision: number; path: string } | undefined;
	for (const name of names) {
		const match = /^(\d+)\.md$/u.exec(name);
		if (!match) continue;
		const revision = Number(match[1]);
		if (!Number.isSafeInteger(revision)) continue;
		if (!best || revision > best.revision) best = { revision, path: join(directory, name) };
	}
	return best;
}

export function snapshotPath(root: string, taskSetId: string, revision: number): string {
	return join(revisionsDirectory(root, taskSetId), `${revision}.md`);
}

/** Whether the live document is byte-identical to the snapshot of its own revision. */
export async function matchesOwnSnapshot(
	root: string,
	taskSetId: string,
	revision: number,
	digest: string,
): Promise<boolean> {
	try {
		const snapshot = await readFile(snapshotPath(root, taskSetId, revision), "utf8");
		return digestOf(snapshot) === digest;
	} catch {
		return false;
	}
}

export interface CommitInput {
	root: string;
	/**
	 * The identity the caller is authorised to write. Every path is derived from
	 * this, and the document must agree with it.
	 */
	taskSetId: string;
	/** The document to write, with its revision *not* yet incremented. */
	document: TaskDocument;
	/**
	 * The digest the change was computed from. `undefined` means "there must be
	 * no document yet" — the first commit of a new set.
	 */
	expectedDigest: string | undefined;
	now: string;
	/**
	 * Cancels the commit *before* anything is written. Checked once the lock is
	 * held and never again: past that point the publication has begun and there
	 * is no honest way to take it back.
	 */
	signal?: AbortSignal;
}

export type CommitResult =
	| {
			kind: "committed";
			revision: number;
			digest: string;
			raw: string;
			path: string;
			/** Set when an interrupted transaction's prepared snapshot was retained aside. */
			retainedOrphanSnapshot?: string;
		}
	| { kind: "conflict"; reason: string }
	| { kind: "cancelled"; reason: string }
	| { kind: "failed"; reason: string };

/**
 * Publish one accepted revision.
 *
 * Ordering is deliberate: the immutable snapshot lands first, then the live
 * document is replaced by an atomic rename. The reverse order would leave an
 * accepted revision with no record of itself.
 *
 * That order has one window: a crash, a full disk, or a stolen stale lock
 * between the two leaves `revisions/<n+1>.md` on disk while `tasks.md` is still
 * at `n`. Such a snapshot was *prepared*, never accepted — accepted history is
 * exactly the revisions the live document has reached — and `resolvePrepared`
 * below is what keeps that window from wedging the set forever. It never reads
 * approval out of those bytes: it either finds them identical to what this call
 * is already authorised to publish (a plain idempotent resume) or moves them
 * aside under an `orphan-` name, so nothing is destroyed and the next write can
 * make progress.
 */
export async function commitTaskDocument(input: CommitInput): Promise<CommitResult> {
	const { root, taskSetId, document, expectedDigest, now, signal } = input;
	if (!isSafeTaskSetId(taskSetId)) {
		return { kind: "failed", reason: `unsafe task set id: ${taskSetId}` };
	}
	// Writes are derived from the identity the caller asked for, never from the
	// document's own metadata, so a tampered document cannot redirect them.
	if (document.set.taskSetId !== taskSetId) {
		return {
			kind: "failed",
			reason: `refusing to write a document for ${document.set.taskSetId} into task set ${taskSetId}`,
		};
	}
	const path = taskDocumentPath(root, taskSetId);
	return serializePath(path, async () => {
		const directory = taskSetDirectory(root, taskSetId);
		await mkdir(join(directory, REVISIONS_DIRECTORY), { recursive: true });
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lock(path, {
				realpath: false,
				lockfilePath: join(directory, LOCK_NAME),
				stale: LOCK_STALE_MS,
				retries: LOCK_RETRIES,
			});
		} catch (error: unknown) {
			return {
				kind: "conflict",
				reason: `another process is holding the task lock for ${taskSetId} (${describe(error)})`,
			};
		}
		try {
			// The one cancellation point. Before this line nothing has been written,
			// so a turn the user interrupted while queued behind the lock can still
			// stop cleanly; after it, publication has started.
			if (signal?.aborted) {
				return { kind: "cancelled", reason: "the turn was interrupted before anything was written" };
			}
			const current = await loadTaskDocument(path, taskSetId);
			if (expectedDigest === undefined && current.kind !== "missing") {
				return {
					kind: "conflict",
					reason: "a task document already exists for this id",
				};
			}
			if (expectedDigest !== undefined) {
				if (current.kind === "missing") {
					return { kind: "conflict", reason: "the task document is gone" };
				}
				if (current.kind === "invalid") {
					return { kind: "conflict", reason: `the task document is unreadable: ${current.reason}` };
				}
				if (current.loaded.digest !== expectedDigest) {
					return {
						kind: "conflict",
						reason: `the task document changed since it was read (now revision ${current.loaded.document.set.revision})`,
					};
				}
			}

			const next: TaskDocument = {
				set: { ...document.set, revision: document.set.revision + 1, updatedAt: now },
				extras: document.extras,
			};
			const raw = serializeTaskDocument(next);
			if (Buffer.byteLength(raw, "utf8") > MAX_DOCUMENT_BYTES) {
				return { kind: "failed", reason: `task document exceeds ${MAX_DOCUMENT_BYTES} bytes` };
			}
			const liveRevision =
				current.kind === "loaded" ? current.loaded.document.set.revision : undefined;
			const prepared = await publishSnapshot(root, taskSetId, next.set.revision, raw, liveRevision);
			if (prepared.kind !== "ok") return prepared.result;
			await writeAtomically(path, raw);
			return {
				kind: "committed",
				revision: next.set.revision,
				digest: digestOf(raw),
				raw,
				path,
				...(prepared.retainedOrphan ? { retainedOrphanSnapshot: prepared.retainedOrphan } : {}),
			};
		} catch (error: unknown) {
			return { kind: "failed", reason: describe(error) };
		} finally {
			await release?.().catch(() => undefined);
		}
	});
}

/**
 * Write the revision's immutable snapshot, resolving the prepared-but-never-
 * published snapshot an interrupted transaction can leave behind.
 *
 * `wx` is what makes this safe: the only way to reach the EEXIST branch is that
 * a file for this revision already exists. Three cases, and only one of them
 * touches anything:
 *
 *   - the revision is at or below the live document's revision: it is accepted
 *     history, and nothing here may disturb it. Refuse.
 *   - the bytes are identical to what this call is already publishing: a resume
 *     of our own interrupted transaction. Continue to the rename; no approval is
 *     being inferred, because the caller authorised exactly these bytes.
 *   - anything else: a prepared snapshot for a revision the live document never
 *     reached, so it was never accepted. Move it aside under an `orphan-` name
 *     — retained, never deleted — and publish ours.
 */
async function publishSnapshot(
	root: string,
	taskSetId: string,
	revision: number,
	raw: string,
	liveRevision: number | undefined,
): Promise<{ kind: "ok"; retainedOrphan?: string } | { kind: "stop"; result: CommitResult }> {
	const target = snapshotPath(root, taskSetId, revision);
	try {
		await writeFile(target, raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
		return { kind: "ok" };
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			return { kind: "stop", result: { kind: "failed", reason: describe(error) } };
		}
	}
	if (liveRevision !== undefined && revision <= liveRevision) {
		return {
			kind: "stop",
			result: {
				kind: "conflict",
				reason: `revision ${revision} is already accepted history for ${taskSetId}`,
			},
		};
	}
	let existing: string;
	try {
		existing = await readFile(target, "utf8");
	} catch (error: unknown) {
		return { kind: "stop", result: { kind: "failed", reason: describe(error) } };
	}
	if (existing === raw) return { kind: "ok" };
	const orphan = join(
		revisionsDirectory(root, taskSetId),
		`orphan-${revision}.${Date.now()}.${randomUUID()}.md`,
	);
	try {
		await rename(target, orphan);
		await writeFile(target, raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error: unknown) {
		return { kind: "stop", result: { kind: "failed", reason: describe(error) } };
	}
	return { kind: "ok", retainedOrphan: orphan };
}

/**
 * Same-directory temp file, fsync, rename. The fsync is what makes the rename
 * meaningful after a power loss: without it the rename can be durable while the
 * bytes it points at are not.
 */
export async function writeAtomically(path: string, contents: string): Promise<void> {
	const directory = join(path, "..");
	await mkdir(directory, { recursive: true });
	const temporaryPath = join(directory, `.tasks.${process.pid}.${randomUUID()}.tmp`);
	try {
		const handle = await open(temporaryPath, "wx", 0o600);
		try {
			await handle.writeFile(contents, { encoding: "utf8" });
			await handle.sync();
		} finally {
			await handle.close().catch(() => undefined);
		}
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}


const pathQueues = new Map<string, Promise<unknown>>();

/**
 * One in-flight mutation per path inside this process. The lock above covers
 * other processes; this covers the far more common case of two tool calls in
 * the same session, where a shared lock would be re-entrant per process and
 * would not serialise anything.
 */
function serializePath<T>(path: string, work: () => Promise<T>): Promise<T> {
	const previous = pathQueues.get(path) ?? Promise.resolve();
	const run = previous.then(work, work);
	const settled = run.then(
		() => undefined,
		() => undefined,
	);
	pathQueues.set(path, settled);
	void settled.then(() => {
		if (pathQueues.get(path) === settled) pathQueues.delete(path);
	});
	return run;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
