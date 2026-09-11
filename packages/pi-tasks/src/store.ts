/**
 * Durable storage for task sets.
 *
 * Layout, under `<agentDir>/tasks/<taskSetId>/`:
 *
 *   tasks.md                       the accepted current document
 *   revisions/<n>.md               the snapshot of revision n
 *   revisions/pending-<n>-<id>.md   candidate bytes prepared for revision n
 *   revisions/pending-<n>-<id>.json the preparation record for those bytes
 *   proposals/<id>.json            candidate revisions awaiting review
 *   tasks.lock                     the cross-process lock directory
 *
 * ## How a revision becomes history
 *
 * Publication is the atomic rename of `tasks.md`, and nothing else. The
 * ordering around it is what makes the numbered snapshots trustworthy:
 *
 *   1. reserve + prepare: `pending-<n>-<id>.json` records identity, revision
 *      and the exact digest; `pending-<n>-<id>.md` holds the bytes.
 *   2. publish: `tasks.md` is replaced by rename. The document's own
 *      `revision` field is the durable record that n happened — it is written
 *      by the same atomic operation, so there is no window where publication
 *      is real but unrecorded.
 *   3. finalize: the prepared bytes are `link`ed to `revisions/<n>.md`.
 *
 * Because step 3 follows step 2, a `<n>.md` this package created always means
 * "published". No numbered snapshot is ever renamed aside, overwritten, or
 * given different bytes, for any reason: revision numbers are allocated past
 * everything ever reserved, so a number is never reused and gaps are normal.
 *
 * The one inconsistent state is a crash between 2 and 3: published, with the
 * snapshot missing. It is repaired only against the preparation record — same
 * identity, same revision, same digest as the live bytes — which is evidence
 * this package published exactly those bytes. A live document that merely
 * parses is never evidence of anything.
 *
 * Snapshots written by earlier versions of this package (before `pending-`
 * existed) have no preparation record, so they cannot be proven to have been
 * published. They are preserved and their numbers stay reserved, but recovery
 * offers them as *unverified* candidates rather than as accepted truth.
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
 * published revision this package recorded is still on disk under
 * `revisions/`. This package makes no stronger promise than that.
 *
 * Durability is fsync-on-the-file before rename. The containing directory is
 * not fsynced, so a power loss can still lose a rename the kernel had not
 * flushed; what is promised is ordering and no-clobber, not crash-proofing a
 * filesystem that reorders directory entries.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { lock } from "proper-lockfile";
import { parseTaskDocument, serializeTaskDocument, type TaskDocument } from "./markdown.js";

const TASKS_DIRECTORY = "tasks";
const DOCUMENT_NAME = "tasks.md";
const REVISIONS_DIRECTORY = "revisions";
const PROPOSALS_DIRECTORY = "proposals";
const LOCK_NAME = "tasks.lock";

/** `<n>.md` — a snapshot, numbered. */
const SNAPSHOT_RE = /^(\d+)\.md$/u;
/**
 * Anything beginning `pending-<digits>` reserves that number, however malformed
 * the rest of the name is. Reservations are read conservatively on purpose: a
 * number that might have been used must never be handed out again.
 */
const RESERVATION_RE = /^pending-(\d+)/u;
const PREPARATION_RECORD_VERSION = 1;
/** A preparation record is a handful of fields; anything larger is not one. */
const MAX_RECORD_BYTES = 8 * 1024;

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

export function snapshotPath(root: string, taskSetId: string, revision: number): string {
	return join(revisionsDirectory(root, taskSetId), `${revision}.md`);
}

/** What this package recorded when it prepared a revision's bytes. */
export interface PreparationRecord {
	schemaVersion: typeof PREPARATION_RECORD_VERSION;
	taskSetId: string;
	revision: number;
	digest: string;
	createdAt: string;
}

async function revisionEntries(root: string, taskSetId: string): Promise<string[]> {
	try {
		return await readdir(revisionsDirectory(root, taskSetId));
	} catch {
		return [];
	}
}

/**
 * The highest revision number this set has ever *consumed*, counting both
 * finalized snapshots and every reservation — including reservations whose
 * bytes never reached the live document, and names too malformed to parse
 * beyond their number.
 *
 * Allocation reads this, not the live document. A publication that crashed
 * before finalizing, or was rolled back afterwards, still consumed its number:
 * handing it out again is what would put two contents on one revision.
 */
export async function highestReservedRevision(root: string, taskSetId: string): Promise<number> {
	let highest = 0;
	for (const name of await revisionEntries(root, taskSetId)) {
		const match = SNAPSHOT_RE.exec(name) ?? RESERVATION_RE.exec(name);
		if (!match) continue;
		const revision = Number(match[1]);
		if (Number.isSafeInteger(revision) && revision > highest) highest = revision;
	}
	return highest;
}

/**
 * The highest number that has a snapshot or a reservation *above* a given live
 * revision, or undefined when history does not run ahead of it.
 *
 * A set whose history runs ahead of its live document is ambiguous: either a
 * publication was interrupted, or the document was restored over work that had
 * already been published, possibly by another session. Those are not
 * distinguishable from the bytes, so neither is assumed — the caller surfaces
 * it and waits for a human to choose.
 */
export async function historyAheadOf(
	root: string,
	taskSetId: string,
	liveRevision: number,
): Promise<number | undefined> {
	const highest = await highestReservedRevision(root, taskSetId);
	return highest > liveRevision ? highest : undefined;
}

async function readPreparationRecord(path: string): Promise<PreparationRecord | undefined> {
	let raw: string;
	try {
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stats = await handle.stat();
			if (!stats.isFile() || stats.size > MAX_RECORD_BYTES) return undefined;
			raw = await handle.readFile({ encoding: "utf8" });
		} finally {
			await handle.close().catch(() => undefined);
		}
	} catch {
		return undefined;
	}
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		if (value.schemaVersion !== PREPARATION_RECORD_VERSION) return undefined;
		if (typeof value.taskSetId !== "string" || !value.taskSetId) return undefined;
		if (!Number.isSafeInteger(value.revision)) return undefined;
		if (typeof value.digest !== "string" || !/^[0-9a-f]{64}$/u.test(value.digest)) return undefined;
		return {
			schemaVersion: PREPARATION_RECORD_VERSION,
			taskSetId: value.taskSetId,
			revision: value.revision as number,
			digest: value.digest,
			createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
		};
	} catch {
		return undefined;
	}
}

/**
 * Whether this package durably recorded preparing exactly these bytes, for
 * exactly this revision of exactly this set.
 *
 * This is the only evidence that authorises repairing a missing snapshot. It
 * is deliberately narrow: a live document that parses, or a snapshot that
 * happens to exist, proves nothing about who wrote it.
 */
export async function hasPreparationEvidence(
	root: string,
	taskSetId: string,
	revision: number,
	digest: string,
): Promise<boolean> {
	const directory = revisionsDirectory(root, taskSetId);
	for (const name of await revisionEntries(root, taskSetId)) {
		const match = RESERVATION_RE.exec(name);
		if (!match || Number(match[1]) !== revision || !name.endsWith(".json")) continue;
		const record = await readPreparationRecord(join(directory, name));
		if (record?.taskSetId === taskSetId && record.revision === revision && record.digest === digest) {
			return true;
		}
	}
	return false;
}

/**
 * Whether a revision with these bytes was published by this package.
 *
 * Either the finalized snapshot holds them, or this package recorded preparing
 * them and the live document is currently holding exactly those bytes — which
 * can only be true if the publishing rename happened. The second case is the
 * crash window between publication and finalization; treating it as published
 * is what stops that window looking like an outside edit and blocking the very
 * write that would repair it.
 */
export async function isPublishedRevision(
	root: string,
	taskSetId: string,
	revision: number,
	digest: string,
): Promise<boolean> {
	try {
		const snapshot = await readFile(snapshotPath(root, taskSetId, revision), "utf8");
		if (digestOf(snapshot) === digest) return true;
	} catch {
		// No finalized snapshot; the preparation record is the remaining evidence.
	}
	return hasPreparationEvidence(root, taskSetId, revision, digest);
}

/** How much this package can say about a snapshot it is offering back. */
export type SnapshotCertainty = "published" | "unverified";

export interface RecoveryCandidate {
	revision: number;
	path: string;
	/**
	 * `published` when a preparation record proves this package published these
	 * exact bytes. `unverified` when the snapshot predates that record keeping,
	 * or its record is missing — real content, unproven provenance.
	 */
	certainty: SnapshotCertainty;
}

/**
 * The newest snapshot that is actually usable as a recovery candidate.
 *
 * Newest *valid*, not merely highest-numbered: a corrupt, truncated,
 * wrong-identity or non-regular file is stepped over — never repaired, never
 * deleted, never renamed — and the search continues downward. Offering a file
 * that will not parse is the same as offering nothing, except that it hides the
 * snapshot below it that would have worked.
 */
export async function findRecoverySnapshot(
	root: string,
	taskSetId: string,
): Promise<RecoveryCandidate | undefined> {
	const directory = revisionsDirectory(root, taskSetId);
	const numbered: Array<{ revision: number; path: string }> = [];
	for (const name of await revisionEntries(root, taskSetId)) {
		const match = SNAPSHOT_RE.exec(name);
		if (!match) continue;
		const revision = Number(match[1]);
		if (Number.isSafeInteger(revision)) numbered.push({ revision, path: join(directory, name) });
	}
	numbered.sort((left, right) => right.revision - left.revision);
	for (const candidate of numbered) {
		const loaded = await loadTaskDocument(candidate.path, taskSetId);
		if (loaded.kind !== "loaded") continue;
		if (loaded.loaded.document.set.revision !== candidate.revision) continue;
		const published = await hasPreparationEvidence(
			root,
			taskSetId,
			candidate.revision,
			loaded.loaded.digest,
		);
		return {
			revision: candidate.revision,
			path: candidate.path,
			certainty: published ? "published" : "unverified",
		};
	}
	return undefined;
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
	/**
	 * Set when a human has explicitly accepted the live document through
	 * recovery.
	 *
	 * It changes exactly one thing: a live document this package cannot account
	 * for stops being a hard refusal. Without it, an unexplained document blocks
	 * every write, which is right for a conflict nobody has looked at and wrong
	 * for one somebody has already decided about. It never authorises writing or
	 * displacing history — the unexplained revision simply goes unrecorded, and
	 * the next publication takes a number above everything.
	 */
	liveDocumentAuthorized?: boolean;
}

export type CommitResult =
	| {
			kind: "committed";
			revision: number;
			digest: string;
			raw: string;
			path: string;
			/**
			 * Set when the revision was published but its snapshot could not be
			 * finalized. The change is live and must not be replayed; the history
			 * entry is outstanding and later mutation blocks until recovery.
			 */
			historyPending?: string;
			/** Set when this commit finished a previous interrupted publication. */
			repairedRevision?: number;
		}
	| { kind: "conflict"; reason: string }
	| { kind: "cancelled"; reason: string }
	| { kind: "failed"; reason: string };

/**
 * Publish one revision: reserve, prepare, publish, finalize.
 *
 * Everything here runs under the lock, and the only step that changes what the
 * set *is* is the rename in `writeAtomically`. Before it, nothing has happened
 * and the call can still be cancelled or refused. After it, the change is real
 * — a later failure is reported as published-with-history-pending, never as an
 * ordinary failure that would invite the caller to try the same mutation again.
 */
export async function commitTaskDocument(input: CommitInput): Promise<CommitResult> {
	const { root, taskSetId, document, expectedDigest, now, signal, liveDocumentAuthorized } = input;
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

			// Finish a publication that was interrupted before its snapshot landed,
			// but only on evidence this package published exactly these bytes.
			let repairedRevision: number | undefined;
			if (current.kind === "loaded") {
				const repair = await repairMissingSnapshot(root, taskSetId, current.loaded);
				if (repair.kind === "failed") return repair.result;
				if (repair.kind === "unaccountable" && !liveDocumentAuthorized) {
					return { kind: "conflict", reason: repair.reason };
				}
				if (repair.kind === "repaired") repairedRevision = repair.revision;
			}

			// Past everything ever reserved, never merely past the live document: a
			// number consumed by an interrupted or rolled-back publication stays
			// consumed. Gaps are normal; a reused number would not be.
			const reserved = await highestReservedRevision(root, taskSetId);
			const revision = Math.max(document.set.revision, reserved) + 1;
			const next: TaskDocument = {
				set: { ...document.set, revision, updatedAt: now },
				extras: document.extras,
			};
			const raw = serializeTaskDocument(next);
			if (Buffer.byteLength(raw, "utf8") > MAX_DOCUMENT_BYTES) {
				return { kind: "failed", reason: `task document exceeds ${MAX_DOCUMENT_BYTES} bytes` };
			}
			const digest = digestOf(raw);
			const prepared = await prepareRevision(root, taskSetId, revision, raw, digest, now);
			if (prepared.kind !== "ok") return prepared.result;

			// The publication boundary. Nothing below may report "not applied".
			await writeAtomically(path, raw);

			const finalized = await finalizeRevision(root, taskSetId, revision, prepared.candidatePath);
			return {
				kind: "committed",
				revision,
				digest,
				raw,
				path,
				...(finalized ? {} : { historyPending: `revision ${revision} was published, but its history entry under revisions/ could not be written` }),
				...(repairedRevision !== undefined ? { repairedRevision } : {}),
			};
		} catch (error: unknown) {
			return { kind: "failed", reason: describe(error) };
		} finally {
			await release?.().catch(() => undefined);
		}
	});
}

/**
 * Reserve a revision number and write the candidate bytes beside a record of
 * what they are.
 *
 * The record lands before the bytes and is never removed. It is both halves of
 * the contract: the number is consumed from this moment, whatever happens next,
 * and if the publication is interrupted the record is the only thing that can
 * later prove these bytes were this package's to publish.
 */
async function prepareRevision(
	root: string,
	taskSetId: string,
	revision: number,
	raw: string,
	digest: string,
	now: string,
): Promise<{ kind: "ok"; candidatePath: string } | { kind: "stop"; result: CommitResult }> {
	const directory = revisionsDirectory(root, taskSetId);
	const token = randomUUID();
	const record: PreparationRecord = {
		schemaVersion: PREPARATION_RECORD_VERSION,
		taskSetId,
		revision,
		digest,
		createdAt: now,
	};
	const candidatePath = join(directory, `pending-${revision}-${token}.md`);
	try {
		await writeFile(join(directory, `pending-${revision}-${token}.json`), `${JSON.stringify(record)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		await writeFile(candidatePath, raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error: unknown) {
		return { kind: "stop", result: { kind: "failed", reason: describe(error) } };
	}
	return { kind: "ok", candidatePath };
}

/**
 * Give the published bytes their permanent name.
 *
 * `link`, not `rename`: link fails when the target exists instead of replacing
 * it, so even a number that should be impossible to collide with cannot cost a
 * snapshot. Returns whether history was recorded; the caller has already
 * published either way and must say so rather than report a failure.
 */
async function finalizeRevision(
	root: string,
	taskSetId: string,
	revision: number,
	candidatePath: string,
): Promise<boolean> {
	try {
		await link(candidatePath, snapshotPath(root, taskSetId, revision));
	} catch {
		return false;
	}
	// The bytes now live under their permanent name; the candidate copy is
	// redundant. The preparation record stays, so the number stays reserved.
	await rm(candidatePath, { force: true }).catch(() => undefined);
	return true;
}

/**
 * Finish a publication that was interrupted between the live rename and the
 * snapshot, when — and only when — this package can prove that is what
 * happened.
 *
 * The proof is a preparation record naming this set, this revision, and the
 * digest the live document currently holds. Those bytes can only have reached
 * `tasks.md` through the publishing rename, so the revision is real and its
 * history entry is simply missing. Anything less is refused: an unexplained
 * live document, a record that disagrees, or a snapshot already holding other
 * bytes all return `recovery_required` and touch nothing.
 */
async function repairMissingSnapshot(
	root: string,
	taskSetId: string,
	live: LoadedDocument,
): Promise<
	| { kind: "none" }
	| { kind: "repaired"; revision: number }
	| { kind: "unaccountable"; reason: string }
	| { kind: "failed"; result: CommitResult }
> {
	const revision = live.document.set.revision;
	const target = snapshotPath(root, taskSetId, revision);
	try {
		const existing = await readFile(target, "utf8");
		if (digestOf(existing) === live.digest) return { kind: "none" };
		// Two documents claim the same revision. The snapshot is not touched and
		// nothing is repaired; the number is already reserved, so whatever is
		// published next is numbered above it either way.
		return {
			kind: "unaccountable",
			reason: `revisions/${revision}.md holds different bytes than the live document claims for revision ${revision}; recovery must account for this before anything is written`,
		};
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return { kind: "failed", result: { kind: "failed", reason: describe(error) } };
		}
	}
	if (!(await hasPreparationEvidence(root, taskSetId, revision, live.digest))) {
		return {
			kind: "unaccountable",
			reason: `the live document claims revision ${revision}, but this package has no record of publishing those bytes; recovery must account for this before anything is written`,
		};
	}
	try {
		await writeFile(target, live.raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error: unknown) {
		return { kind: "failed", result: { kind: "failed", reason: describe(error) } };
	}
	return { kind: "repaired", revision };
}

/**
 * Publish a file to a destination that must not already exist.
 *
 * A stat-then-write cannot promise that: the destination can appear in
 * between, and the write replaces it. Writing a temp file and `link`ing it into
 * place makes the no-overwrite check and the publication the same operation —
 * the kernel refuses the link if anything is there. Used for exports, which
 * promise never to clobber; managed documents use `writeAtomically`, which is
 * replacement by design.
 */
export async function publishExclusively(path: string, contents: string): Promise<boolean> {
	const directory = join(path, "..");
	await mkdir(directory, { recursive: true });
	const temporaryPath = join(directory, `.tasks-export.${process.pid}.${randomUUID()}.tmp`);
	try {
		const handle = await open(temporaryPath, "wx", 0o600);
		try {
			await handle.writeFile(contents, { encoding: "utf8" });
			await handle.sync();
		} finally {
			await handle.close().catch(() => undefined);
		}
		try {
			await link(temporaryPath, path);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
		return true;
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
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
