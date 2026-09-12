/**
 * Durable revision history for the plan document.
 *
 * The live plan stays exactly where it was — `plans/<session-id>.md` — because
 * that path is the one every existing command, export, archive and hand-edit
 * already knows. What this module adds beside it is the record of how the live
 * document got there:
 *
 *   plans/.revisions/<planId>/
 *     manifest.json                     which revision the live document is
 *     revisions/<n>.md                  the immutable snapshot of revision n
 *     revisions/pending-<n>-<id>.json   the preparation record for revision n
 *     revisions/pending-<n>-<id>.md     the candidate bytes for revision n
 *     proposals/<proposalId>.json       candidates awaiting the user's review
 *     external/<digest>.md              live bytes this package did not write
 *     manifest.lock                     the cross-process lock directory
 *
 * ## Publication ordering
 *
 * A revision is published in four steps, and the order is the whole contract:
 *
 *   1. reserve + prepare: `pending-<n>-<id>.json` records the identity, the
 *      revision, the base digest and the digest of the bytes;
 *      `pending-<n>-<id>.md` holds those bytes, fsynced.
 *   2. replace the live document, atomically.
 *   3. finalize: link the prepared bytes to `revisions/<n>.md`.
 *   4. finalize: rewrite `manifest.json` to name revision n and its digest.
 *
 * Step 1 happens before step 2 so that an interruption between them leaves a
 * reservation nobody published — recoverable by doing nothing, because the live
 * bytes still match the manifest. Steps 3 and 4 happen after step 2 so that an
 * interruption there is recoverable *on evidence*: the live document holds
 * exactly the bytes a preparation record claims for revision n, over exactly the
 * base the manifest still names, which only the step-2 rename can have produced.
 *
 * Anything else is a conflict. Bytes in the live document that no preparation
 * record and no manifest digest explains are never adopted as a revision and
 * never treated as approved: they are preserved under `external/` and reported,
 * so reconciling them is a decision somebody makes rather than something that
 * silently happens.
 *
 * Revision numbers are allocated past everything ever reserved, so a number is
 * never reused and gaps are normal. No snapshot is ever overwritten or renamed.
 *
 * ## What the locking is and is not
 *
 * `proper-lockfile` serialises *cooperating* writers (two Pi sessions revising
 * one plan) around the whole read-validate-write window, and the base digest is
 * rechecked under the lock immediately before the live document is replaced.
 * That is optimistic conflict detection, not a compare-and-swap: an editor that
 * rewrites the plan between the check and the rename wins, and nothing on a
 * POSIX filesystem prevents it. What this module promises is that such a write
 * is *detected* at the next read and that every revision it published is still
 * on disk under `revisions/`.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { MAX_PLAN_BYTES, plansDirectory, readPlanFile, writePlanFile } from "./plan-file.js";

const REVISIONS_ROOT_NAME = ".revisions";
const MANIFEST_NAME = "manifest.json";
const LOCK_NAME = "manifest.lock";
const SNAPSHOTS_DIRECTORY = "revisions";
const PROPOSALS_DIRECTORY = "proposals";
const EXTERNAL_DIRECTORY = "external";

export const PLAN_MANIFEST_SCHEMA_VERSION = 1;
export const PLAN_PROPOSAL_SCHEMA_VERSION = 1;

/** A manifest is a handful of fields plus a bounded history; bigger is broken. */
const MAX_MANIFEST_BYTES = 512 * 1024;
/** A preparation record is five fields. */
const MAX_RECORD_BYTES = 8 * 1024;
/** A proposal carries one plan plus its diff. */
const MAX_PROPOSAL_BYTES = 4 * 1024 * 1024;
/**
 * History is an index, not the archive: the snapshots under `revisions/` are
 * the record, and they are never trimmed. Keeping the newest entries bounds the
 * manifest so one long-lived plan cannot grow a file every read has to parse.
 */
export const MAX_HISTORY_RECORDS = 200;

/** Long enough for a cooperating session to finish one publication. */
const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = { retries: 8, factor: 1.6, minTimeout: 20, maxTimeout: 400 } as const;

const SNAPSHOT_RE = /^(\d+)\.md$/u;
/**
 * Anything beginning `pending-<digits>` reserves that number, however malformed
 * the rest of the name is. Reservations are read conservatively on purpose: a
 * number that might have been used must never be handed out again.
 */
const RESERVATION_RE = /^pending-(\d+)/u;
const MANAGED_ID_RE = /^[0-9a-f-]{36}$/u;
const DIGEST_RE = /^[0-9a-f]{64}$/u;

/** Plan, revision and proposal ids are all generated here, so all are uuids. */
export function newManagedId(): string {
	return randomUUID();
}

export function isSafeManagedId(value: string): boolean {
	return MANAGED_ID_RE.test(value);
}

export function digestOf(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The bytes an agent-authored plan will occupy once written, because
 * `writePlanFile` appends the trailing newline.
 *
 * For **new** content only — a proposed candidate on its way in. It must never be
 * applied to content that is already on disk: digesting normalized bytes and
 * comparing them with a file that ends without a newline reports a change nobody
 * made. Every comparison against accepted or live content digests the raw bytes.
 */
export function normalizePlanText(plan: string): string {
	return plan.endsWith("\n") ? plan : `${plan}\n`;
}

/** Hidden beside the live plans so a plans directory listing stays readable. */
export function planRevisionsRoot(): string {
	return join(plansDirectory(), REVISIONS_ROOT_NAME);
}

export function planRevisionDirectory(root: string, planId: string): string {
	if (!isSafeManagedId(planId)) throw new Error(`unsafe plan id: ${planId}`);
	return join(root, planId);
}

export function planManifestPath(root: string, planId: string): string {
	return join(planRevisionDirectory(root, planId), MANIFEST_NAME);
}

export function planSnapshotPath(root: string, planId: string, revision: number): string {
	if (!Number.isSafeInteger(revision) || revision < 1) {
		throw new Error(`unsafe plan revision: ${revision}`);
	}
	return join(planRevisionDirectory(root, planId), SNAPSHOTS_DIRECTORY, `${revision}.md`);
}

export function planProposalPath(root: string, planId: string, proposalId: string): string {
	if (!isSafeManagedId(proposalId)) throw new Error(`unsafe proposal id: ${proposalId}`);
	return join(planRevisionDirectory(root, planId), PROPOSALS_DIRECTORY, `${proposalId}.json`);
}

function snapshotsDirectory(root: string, planId: string): string {
	return join(planRevisionDirectory(root, planId), SNAPSHOTS_DIRECTORY);
}

function proposalsDirectory(root: string, planId: string): string {
	return join(planRevisionDirectory(root, planId), PROPOSALS_DIRECTORY);
}

function externalDirectory(root: string, planId: string): string {
	return join(planRevisionDirectory(root, planId), EXTERNAL_DIRECTORY);
}

/** One entry of the manifest's index. The snapshot beside it is the record. */
export interface PlanRevisionRecord {
	revision: number;
	digest: string;
	createdAt: string;
	/** The agent's description of the change. Never the thing the user approved. */
	changeSummary: string;
	/** What the user asked for, in their own terms. */
	instructions?: string;
	revisionId?: string;
	proposalId?: string;
	baseRevision?: number;
	baseDigest?: string;
	/**
	 * Set when the live bytes this revision replaced were not the ones the
	 * manifest named. Those bytes are kept under `external/<digest>.md`: the
	 * revision is still recorded honestly as having been published over an
	 * unexplained document rather than over revision `baseRevision`.
	 */
	replacedExternalDigest?: string;
}

export interface PlanManifest {
	schemaVersion: typeof PLAN_MANIFEST_SCHEMA_VERSION;
	planId: string;
	/** The live document this manifest indexes, for diagnostics and validation. */
	planPath: string;
	specRevision: number;
	currentDigest: string;
	updatedAt: string;
	history: PlanRevisionRecord[];
}

export type PlanManifestLoad =
	| { kind: "loaded"; manifest: PlanManifest }
	| { kind: "missing" }
	| { kind: "invalid"; reason: string };

/**
 * Read a bounded, symlink-free JSON file. The size check happens before
 * anything is read, because a check after `readFile` has already allocated.
 */
async function readBoundedJson(path: string, maxBytes: number): Promise<unknown | undefined> {
	let raw: string;
	try {
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stats = await handle.stat();
			if (!stats.isFile() || stats.size > maxBytes) return undefined;
			raw = await handle.readFile({ encoding: "utf8" });
		} finally {
			await handle.close().catch(() => undefined);
		}
	} catch {
		return undefined;
	}
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

export async function readPlanManifest(root: string, planId: string): Promise<PlanManifestLoad> {
	if (!isSafeManagedId(planId)) return { kind: "invalid", reason: `unsafe plan id: ${planId}` };
	const path = planManifestPath(root, planId);
	let exists = true;
	try {
		await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).then((handle) =>
			handle.close().catch(() => undefined),
		);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { kind: "missing" };
		exists = code !== "ENOENT";
		if (code === "ELOOP") return { kind: "invalid", reason: "the plan manifest is a symlink" };
	}
	const value = await readBoundedJson(path, MAX_MANIFEST_BYTES);
	if (value === undefined) {
		return exists
			? { kind: "invalid", reason: "the plan manifest is unreadable or malformed" }
			: { kind: "missing" };
	}
	const manifest = parseManifest(value, planId);
	return manifest
		? { kind: "loaded", manifest }
		: { kind: "invalid", reason: "the plan manifest does not match the expected shape" };
}

function parseManifest(value: unknown, planId: string): PlanManifest | undefined {
	if (!isRecord(value)) return undefined;
	if (value.schemaVersion !== PLAN_MANIFEST_SCHEMA_VERSION) return undefined;
	if (value.planId !== planId) return undefined;
	if (typeof value.planPath !== "string" || !value.planPath) return undefined;
	if (!Number.isSafeInteger(value.specRevision) || (value.specRevision as number) < 1) return undefined;
	if (typeof value.currentDigest !== "string" || !DIGEST_RE.test(value.currentDigest)) return undefined;
	return {
		schemaVersion: PLAN_MANIFEST_SCHEMA_VERSION,
		planId,
		planPath: value.planPath,
		specRevision: value.specRevision as number,
		currentDigest: value.currentDigest,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
		history: parseHistory(value.history),
	};
}

function parseHistory(value: unknown): PlanRevisionRecord[] {
	if (!Array.isArray(value)) return [];
	const records: PlanRevisionRecord[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		if (!Number.isSafeInteger(entry.revision) || (entry.revision as number) < 1) continue;
		if (typeof entry.digest !== "string" || !DIGEST_RE.test(entry.digest)) continue;
		records.push({
			revision: entry.revision as number,
			digest: entry.digest,
			createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
			changeSummary: typeof entry.changeSummary === "string" ? entry.changeSummary : "",
			...(typeof entry.instructions === "string" ? { instructions: entry.instructions } : {}),
			...(typeof entry.revisionId === "string" ? { revisionId: entry.revisionId } : {}),
			...(typeof entry.proposalId === "string" ? { proposalId: entry.proposalId } : {}),
			...(Number.isSafeInteger(entry.baseRevision) ? { baseRevision: entry.baseRevision as number } : {}),
			...(typeof entry.baseDigest === "string" ? { baseDigest: entry.baseDigest } : {}),
			...(typeof entry.replacedExternalDigest === "string"
				? { replacedExternalDigest: entry.replacedExternalDigest }
				: {}),
		});
	}
	return records.sort((left, right) => left.revision - right.revision);
}

/** Same-directory temp file, fsync, rename: the bytes are durable before the name is. */
async function writeAtomically(path: string, contents: string): Promise<void> {
	const directory = join(path, "..");
	await mkdir(directory, { recursive: true });
	const temporaryPath = join(directory, `.plan-revision.${process.pid}.${randomUUID()}.tmp`);
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

async function writeManifest(root: string, manifest: PlanManifest): Promise<void> {
	const trimmed: PlanManifest = {
		...manifest,
		history: manifest.history.slice(-MAX_HISTORY_RECORDS),
	};
	await writeAtomically(planManifestPath(root, manifest.planId), `${JSON.stringify(trimmed, null, 2)}\n`);
}

/** What this package durably recorded before it replaced the live document. */
interface PreparationRecord {
	schemaVersion: typeof PLAN_MANIFEST_SCHEMA_VERSION;
	planId: string;
	revision: number;
	digest: string;
	baseDigest: string;
	createdAt: string;
}

async function snapshotEntries(root: string, planId: string): Promise<string[]> {
	try {
		return await readdir(snapshotsDirectory(root, planId));
	} catch {
		return [];
	}
}

/**
 * The highest revision number this plan has ever *consumed*, counting finalized
 * snapshots and every reservation — including reservations whose bytes never
 * reached the live document, and names too malformed to parse beyond the number.
 *
 * Allocation reads this, never the manifest alone: a publication that crashed
 * before finalizing still consumed its number, and handing it out again is what
 * would put two contents on one revision.
 */
export async function highestReservedRevision(root: string, planId: string): Promise<number> {
	let highest = 0;
	for (const name of await snapshotEntries(root, planId)) {
		const match = SNAPSHOT_RE.exec(name) ?? RESERVATION_RE.exec(name);
		if (!match) continue;
		const revision = Number(match[1]);
		if (Number.isSafeInteger(revision) && revision > highest) highest = revision;
	}
	return highest;
}

async function readPreparationRecords(root: string, planId: string): Promise<PreparationRecord[]> {
	const directory = snapshotsDirectory(root, planId);
	const records: PreparationRecord[] = [];
	for (const name of await snapshotEntries(root, planId)) {
		if (!RESERVATION_RE.test(name) || !name.endsWith(".json")) continue;
		const value = await readBoundedJson(join(directory, name), MAX_RECORD_BYTES);
		if (!isRecord(value)) continue;
		if (value.schemaVersion !== PLAN_MANIFEST_SCHEMA_VERSION) continue;
		if (value.planId !== planId) continue;
		if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) continue;
		if (typeof value.digest !== "string" || !DIGEST_RE.test(value.digest)) continue;
		if (typeof value.baseDigest !== "string" || !DIGEST_RE.test(value.baseDigest)) continue;
		records.push({
			schemaVersion: PLAN_MANIFEST_SCHEMA_VERSION,
			planId,
			revision: value.revision as number,
			digest: value.digest,
			baseDigest: value.baseDigest,
			createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
			});
	}
	return records.sort((left, right) => left.revision - right.revision);
}

/**
 * Ownership of the cross-process lock, and whether it is still ours.
 *
 * `proper-lockfile`'s default compromise handler throws from inside its refresh
 * timer, which is an `uncaughtException`; Pi's interactive mode turns those into
 * `process.exit(1)`. A session that merely stalls past the stale window would
 * then kill the user's editor. Recording the loss instead is the point of
 * installing a handler — and because a publication that keeps writing after its
 * lease is gone is exactly the hazard the lock exists to prevent, the loss is
 * observable and rechecked after every await that could span the timer.
 *
 * This is not fencing: the check and the write are not atomic, and nothing here
 * stops a writer that never takes the lock.
 */
export interface LockLease {
	/** Passed straight to `proper-lockfile`; never throws. */
	onCompromised(error: Error): void;
	isLost(): boolean;
	lostReason(): string | undefined;
	/**
	 * Told which boundary the publication has just crossed. The real lease
	 * ignores it — a lock is lost when the filesystem says so — but it gives a
	 * test a stable place to lose the lease, so each refusal branch can be driven
	 * by where the publication is rather than by counting getter reads.
	 */
	observe?(phase: PublishPhase): void;
}

/** The boundaries a publication crosses, in order. */
export type PublishPhase = "acquired" | "validated" | "prepared" | "published";

export function createLockLease(): LockLease {
	let lost: string | undefined;
	return {
		onCompromised(error: Error) {
			lost ??= describe(error);
		},
		isLost: () => lost !== undefined,
		lostReason: () => lost,
	};
}

interface LockedWork<T> {
	root: string;
	planId: string;
	lease?: LockLease;
	run(lease: LockLease): Promise<T>;
	onLockFailure(reason: string): T;
}

async function withManifestLock<T>(work: LockedWork<T>): Promise<T> {
	const directory = planRevisionDirectory(work.root, work.planId);
	await mkdir(join(directory, SNAPSHOTS_DIRECTORY), { recursive: true });
	// Created before `lock()` so a compromise reported while the acquisition
	// promise is still settling is recorded rather than lost.
	const lease = work.lease ?? createLockLease();
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lock(join(directory, MANIFEST_NAME), {
			realpath: false,
			lockfilePath: join(directory, LOCK_NAME),
			stale: LOCK_STALE_MS,
			retries: LOCK_RETRIES,
			onCompromised: lease.onCompromised,
		});
	} catch (error: unknown) {
		return work.onLockFailure(
			`another process is holding the plan revision lock for ${work.planId} (${describe(error)})`,
		);
	}
	try {
		return await work.run(lease);
	} finally {
		await release?.().catch(() => undefined);
	}
}

export type InitializeResult =
	| { kind: "initialized"; manifest: PlanManifest; historyPending?: string }
	| { kind: "exists"; manifest: PlanManifest }
	| { kind: "conflict"; reason: string }
	| { kind: "failed"; reason: string };

/**
 * Give an existing plan a managed identity and a first revision.
 *
 * Called the first time a plan is revised or approved, never in bulk at session
 * start: a plan written by an earlier version stays exactly as it is until
 * somebody does something managed with it, and then its current bytes become
 * revision 1 rather than being rewritten.
 *
 * **The bytes are taken exactly as they are on disk.** No trailing newline is
 * added, no line ending is normalized. Normalizing here would digest something
 * the file does not contain, so a plan written by an editor that leaves off the
 * final newline would read as "changed outside Plan mode" from the moment it
 * gained an identity — on every turn, forever, with its first revision routed
 * through `external/` as if nobody could account for it. Candidates the agent
 * authors are normalized on their way *in* (see `publishPlanRevision`), which is
 * a choice about new content; every comparison against accepted or live content
 * is raw-byte.
 */
export async function initializePlanManifest(input: {
	root: string;
	planId: string;
	planPath: string;
	/** The exact bytes the plan file holds, as `readPlanFile` returned them. */
	plan: string;
	now: string;
	changeSummary: string;
	lease?: LockLease;
}): Promise<InitializeResult> {
	if (!isSafeManagedId(input.planId)) {
		return { kind: "failed", reason: `unsafe plan id: ${input.planId}` };
	}
	const contents = input.plan;
	if (Buffer.byteLength(contents, "utf8") > MAX_PLAN_BYTES) {
		return { kind: "failed", reason: `plan exceeds ${MAX_PLAN_BYTES} bytes` };
	}
	return withManifestLock<InitializeResult>({
		root: input.root,
		planId: input.planId,
		...(input.lease ? { lease: input.lease } : {}),
		onLockFailure: (reason) => ({ kind: "conflict", reason }),
		run: async () => {
			const existing = await readPlanManifest(input.root, input.planId);
			if (existing.kind === "loaded") return { kind: "exists", manifest: existing.manifest };
			if (existing.kind === "invalid") {
				return {
					kind: "conflict",
					reason: `${existing.reason}; the plan's recorded history must be accounted for before it can be extended`,
				};
			}
			const digest = digestOf(contents);
			const revision = (await highestReservedRevision(input.root, input.planId)) + 1;
			const prepared = await prepareRevision(input.root, input.planId, revision, contents, digest, digest, input.now);
			if (prepared.kind !== "ok") return { kind: "failed", reason: prepared.reason };
			const finalized = await finalizeSnapshot(input.root, input.planId, revision, prepared.candidatePath);
			const manifest: PlanManifest = {
				schemaVersion: PLAN_MANIFEST_SCHEMA_VERSION,
				planId: input.planId,
				planPath: input.planPath,
				specRevision: revision,
				currentDigest: digest,
				updatedAt: input.now,
				history: [
					{
						revision,
						digest,
						createdAt: input.now,
						changeSummary: input.changeSummary,
					},
				],
			};
			try {
				await writeManifest(input.root, manifest);
			} catch (error: unknown) {
				return { kind: "failed", reason: describe(error) };
			}
			// A missing snapshot is not a failed initialization: the manifest names
			// the revision and the preparation record proves the bytes, which is what
			// recovery repairs from.
			return {
				kind: "initialized",
				manifest,
				...(finalized
					? {}
					: {
							historyPending: `revision ${revision} is recorded, but its snapshot under revisions/ could not be written`,
						}),
			};
		},
	});
}

export type AdoptResult =
	| { kind: "adopted"; revision: number; digest: string; historyPending?: string }
	| { kind: "unchanged"; revision: number; digest: string }
	| { kind: "conflict"; reason: string }
	| { kind: "failed"; reason: string };

/**
 * Record the bytes that are already live as the next revision.
 *
 * The one operation that adds history without replacing anything, for the case
 * where a human says "this file, as it is now, is the plan": a hand-edit they
 * stand behind, or an implementation approving a plan whose document has moved
 * since the last recorded revision. The bytes are not rewritten — they are
 * already the live document — so there is no publication boundary here and
 * nothing to roll back.
 *
 * It is never reached automatically. Adopting unexplained bytes is exactly the
 * decision this package refuses to make on the user's behalf.
 */
export async function adoptLiveDocument(input: {
	root: string;
	planId: string;
	planPath: string;
	now: string;
	changeSummary: string;
	lease?: LockLease;
}): Promise<AdoptResult> {
	if (!isSafeManagedId(input.planId)) {
		return { kind: "failed", reason: `unsafe plan id: ${input.planId}` };
	}
	return withManifestLock<AdoptResult>({
		root: input.root,
		planId: input.planId,
		...(input.lease ? { lease: input.lease } : {}),
		onLockFailure: (reason) => ({ kind: "conflict", reason }),
		run: async () => {
			const loaded = await readPlanManifest(input.root, input.planId);
			if (loaded.kind !== "loaded") {
				return {
					kind: "conflict",
					reason:
						loaded.kind === "missing"
							? "this plan has no recorded revision history to extend"
							: loaded.reason,
				};
			}
			const manifest = loaded.manifest;
			const live = await readPlanFile(input.planPath);
			if (live === undefined) {
				return { kind: "conflict", reason: `the plan file at ${input.planPath} is gone` };
			}
			const digest = digestOf(live);
			if (digest === manifest.currentDigest) {
				return { kind: "unchanged", revision: manifest.specRevision, digest };
			}
			const revision =
				Math.max(manifest.specRevision, await highestReservedRevision(input.root, input.planId)) + 1;
			const prepared = await prepareRevision(
				input.root,
				input.planId,
				revision,
				live,
				digest,
				manifest.currentDigest,
				input.now,
			);
			if (prepared.kind !== "ok") return { kind: "failed", reason: prepared.reason };
			const historyPending = await finalizePublication(
				input.root,
				input.planId,
				revision,
				prepared.candidatePath,
				manifest,
				{
					revision,
					digest,
					createdAt: input.now,
					changeSummary: input.changeSummary,
					baseRevision: manifest.specRevision,
					baseDigest: manifest.currentDigest,
				},
				input.now,
			);
			return {
				kind: "adopted",
				revision,
				digest,
				...(historyPending ? { historyPending } : {}),
			};
		},
	});
}

export interface PublishInput {
	/** Combined task-only revision still needs a new plan spec revision. */
	allowUnchanged?: boolean;
	root: string;
	planId: string;
	planPath: string;
	/** The revision and digest the change was computed against. */
	baseRevision: number;
	baseDigest: string;
	plan: string;
	now: string;
	changeSummary: string;
	instructions?: string;
	revisionId?: string;
	proposalId?: string;
	/**
	 * Cancels the publication *before* anything is written. Checked once the lock
	 * is held and never again: past that point the publication has begun and
	 * there is no honest way to take it back.
	 */
	signal?: AbortSignal;
	lease?: LockLease;
}

export type PublishResult =
	| {
			kind: "published";
			revision: number;
			digest: string;
			/** Set when the revision is live but its snapshot or manifest is not. */
			historyPending?: string;
			/** Set when the bytes replaced could not be explained; they are kept. */
			replacedExternalDigest?: string;
			lockCompromised?: string;
	  }
	| { kind: "conflict"; reason: string }
	| { kind: "cancelled"; reason: string }
	| { kind: "failed"; reason: string };

/**
 * Publish one revision of the plan: reserve, prepare, replace, finalize.
 *
 * The only step that changes what the plan *is* is the live replacement in step
 * 2. Before it, nothing has happened and the call can still be cancelled or
 * refused. After it, the change is real — a later failure is reported as
 * published-with-history-pending, never as an ordinary failure that would invite
 * the caller to retry the same mutation.
 */
export async function publishPlanRevision(input: PublishInput): Promise<PublishResult> {
	if (!isSafeManagedId(input.planId)) {
		return { kind: "failed", reason: `unsafe plan id: ${input.planId}` };
	}
	const contents = normalizePlanText(input.plan);
	if (Buffer.byteLength(contents, "utf8") > MAX_PLAN_BYTES) {
		return { kind: "failed", reason: `plan exceeds ${MAX_PLAN_BYTES} bytes` };
	}
	const digest = digestOf(contents);
	return withManifestLock<PublishResult>({
		root: input.root,
		planId: input.planId,
		...(input.lease ? { lease: input.lease } : {}),
		onLockFailure: (reason) => ({ kind: "conflict", reason }),
		run: async (lease) => {
			const leaseLost = () =>
				`the plan revision lock for ${input.planId} was lost before the revision was published (${lease.lostReason()}); nothing was written`;
			try {
				// The one cancellation point: nothing has been written yet, so a turn
				// the user interrupted while queued behind the lock stops cleanly.
				if (input.signal?.aborted) {
					return {
						kind: "cancelled",
						reason: "the turn was interrupted before anything was written",
					};
				}
				lease.observe?.("acquired");
				if (lease.isLost()) return { kind: "conflict", reason: leaseLost() };

				const loaded = await readPlanManifest(input.root, input.planId);
				if (loaded.kind !== "loaded") {
					return {
						kind: "conflict",
						reason:
							loaded.kind === "missing"
								? "this plan has no recorded revision history, so there is nothing to revise"
								: loaded.reason,
					};
				}
				const manifest = loaded.manifest;
				const live = await readPlanFile(input.planPath);
				if (live === undefined) {
					return { kind: "conflict", reason: `the plan file at ${input.planPath} is gone` };
				}
				const liveDigest = digestOf(live);
				if (liveDigest !== input.baseDigest) {
					return {
						kind: "conflict",
						reason:
							"the plan file changed after the revision was computed, so the revision was not published",
					};
				}
				if (liveDigest === digest && !input.allowUnchanged) {
					return {
						kind: "conflict",
						reason: "the proposed plan is already what the plan file holds; nothing was published",
					};
				}
				// Bytes the manifest cannot account for are preserved before being
				// replaced. They are never counted as a revision — the revision record
				// says what was displaced instead.
				let replacedExternalDigest: string | undefined;
				if (manifest.currentDigest !== liveDigest) {
					const preserved = await preserveExternalBytes(input.root, input.planId, live, liveDigest);
					if (!preserved) {
						return {
							kind: "failed",
							reason: `the plan file no longer matches revision ${manifest.specRevision} and the unexplained bytes could not be preserved, so nothing was published`,
						};
					}
					replacedExternalDigest = liveDigest;
				}
				lease.observe?.("validated");
				if (lease.isLost()) return { kind: "conflict", reason: leaseLost() };

				const revision = Math.max(manifest.specRevision, await highestReservedRevision(input.root, input.planId)) + 1;
				const prepared = await prepareRevision(
					input.root,
					input.planId,
					revision,
					contents,
					digest,
					input.baseDigest,
					input.now,
				);
				if (prepared.kind !== "ok") return { kind: "failed", reason: prepared.reason };
				lease.observe?.("prepared");
				// Last check before the live replacement. Publishing on a lease already
				// known lost is the write this handler exists to prevent; the
				// reservation stays consumed, which is what reservations are for.
				if (lease.isLost()) return { kind: "conflict", reason: leaseLost() };

				// The publication boundary. Nothing below may report "not applied".
				await writePlanFile(input.planPath, contents);
				lease.observe?.("published");
				const lostAfterPublication = lease.isLost();

				const record: PlanRevisionRecord = {
					revision,
					digest,
					createdAt: input.now,
					changeSummary: input.changeSummary,
					...(input.instructions ? { instructions: input.instructions } : {}),
					...(input.revisionId ? { revisionId: input.revisionId } : {}),
					...(input.proposalId ? { proposalId: input.proposalId } : {}),
					baseRevision: input.baseRevision,
					baseDigest: input.baseDigest,
					...(replacedExternalDigest ? { replacedExternalDigest } : {}),
				};
				// Finalization is skipped rather than run without a lease: the
				// preparation record still matches the live bytes, so recovery repairs
				// the history entry on evidence.
				const historyPending = lostAfterPublication
					? `revision ${revision} is live, but the plan revision lock was lost before its history could be recorded; the next session recovers it`
					: await finalizePublication(input.root, input.planId, revision, prepared.candidatePath, manifest, record, input.now);
				return {
					kind: "published",
					revision,
					digest,
					...(historyPending ? { historyPending } : {}),
					...(replacedExternalDigest ? { replacedExternalDigest } : {}),
					...(lostAfterPublication
						? {
								lockCompromised: `the plan revision lock was lost after revision ${revision} was published (${lease.lostReason()}); the revision is live and must not be retried`,
							}
						: {}),
				};
			} catch (error: unknown) {
				return { kind: "failed", reason: describe(error) };
			}
		},
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
	planId: string,
	revision: number,
	contents: string,
	digest: string,
	baseDigest: string,
	now: string,
): Promise<{ kind: "ok"; candidatePath: string } | { kind: "failed"; reason: string }> {
	const directory = snapshotsDirectory(root, planId);
	const token = randomUUID();
	const record: PreparationRecord = {
		schemaVersion: PLAN_MANIFEST_SCHEMA_VERSION,
		planId,
		revision,
		digest,
		baseDigest,
		createdAt: now,
	};
	const recordPath = join(directory, `pending-${revision}-${token}.json`);
	const candidatePath = join(directory, `pending-${revision}-${token}.md`);
	try {
		await mkdir(directory, { recursive: true });
		// The record is fsynced, not merely written. It is the only thing that can
		// later prove these bytes were this package's to publish, so a record the
		// kernel had not flushed would leave an accepted revision looking like an
		// outside edit after a power loss — a conflict for something the user agreed
		// to. Same exclusive-create / write / sync discipline as the candidate below.
		await writeSynced(recordPath, `${JSON.stringify(record)}\n`);
		await writeSynced(candidatePath, contents);
	} catch (error: unknown) {
		// Nothing has been published: the live document is untouched and the caller
		// reports a plain failure. The reservation is cleaned up so a half-written
		// pair cannot later be mistaken for evidence; the number stays consumed only
		// when the record is durable.
		await rm(candidatePath, { force: true }).catch(() => undefined);
		await rm(recordPath, { force: true }).catch(() => undefined);
		return { kind: "failed", reason: describe(error) };
	}
	return { kind: "ok", candidatePath };
}

/**
 * Exclusive create, write, fsync, close.
 *
 * The directory entry itself is still not fsynced, so a power loss can lose the
 * *name* even though the bytes behind it were flushed. That limitation is
 * unchanged and deliberate here: what this buys is that a name which survives
 * never points at bytes that did not.
 */
async function writeSynced(path: string, contents: string): Promise<void> {
	const handle = await open(path, "wx", 0o600);
	try {
		await handle.writeFile(contents, { encoding: "utf8" });
		await handle.sync();
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Give the published bytes their permanent name.
 *
 * `link`, not `rename`: link fails when the target exists instead of replacing
 * it, so even a number that should be impossible to collide with cannot cost a
 * snapshot. Returns whether the snapshot was recorded.
 */
async function finalizeSnapshot(
	root: string,
	planId: string,
	revision: number,
	candidatePath: string,
): Promise<boolean> {
	try {
		await link(candidatePath, planSnapshotPath(root, planId, revision));
	} catch {
		return false;
	}
	// The bytes now live under their permanent name; the candidate copy is
	// redundant. The preparation record stays, so the number stays reserved.
	await rm(candidatePath, { force: true }).catch(() => undefined);
	return true;
}

/** Steps 3 and 4. Returns the pending-history note, or undefined on success. */
async function finalizePublication(
	root: string,
	planId: string,
	revision: number,
	candidatePath: string,
	manifest: PlanManifest,
	record: PlanRevisionRecord,
	now: string,
): Promise<string | undefined> {
	const snapshot = await finalizeSnapshot(root, planId, revision, candidatePath);
	try {
		await writeManifest(root, {
			...manifest,
			specRevision: revision,
			currentDigest: record.digest,
			updatedAt: now,
			history: [...manifest.history, record],
		});
	} catch (error: unknown) {
		return `revision ${revision} is live, but the manifest could not be updated (${describe(error)}); the next session recovers it`;
	}
	return snapshot
		? undefined
		: `revision ${revision} is live and recorded, but its snapshot under revisions/ could not be written`;
}

/**
 * Keep bytes the manifest cannot explain, under their own digest.
 *
 * Exclusive create, so the same unexplained document is stored once and a
 * second encounter is a no-op rather than a rewrite. Returns whether the bytes
 * are on disk — the caller refuses to replace a document it could not preserve.
 */
async function preserveExternalBytes(
	root: string,
	planId: string,
	contents: string,
	digest: string,
): Promise<boolean> {
	const path = join(externalDirectory(root, planId), `${digest}.md`);
	try {
		await mkdir(externalDirectory(root, planId), { recursive: true });
		await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
		return true;
	} catch (error: unknown) {
		return (error as NodeJS.ErrnoException).code === "EEXIST";
	}
}

export type PlanRecoveryResult =
	/** The live document is exactly the revision the manifest names. */
	| { kind: "ok"; manifest: PlanManifest }
	/** An interrupted publication was finished on evidence. */
	| { kind: "recovered"; manifest: PlanManifest; revision: number }
	/** The live bytes are explained by nothing on disk. */
	| { kind: "conflict"; reason: string; manifest: PlanManifest; liveDigest: string }
	/** This plan has no managed history: nothing to recover, nothing wrong. */
	| { kind: "unmanaged" }
	| { kind: "unreadable"; reason: string };

/**
 * Reconcile the live document with the recorded history, and finish an
 * interrupted publication when — and only when — the evidence says that is what
 * happened.
 *
 * The evidence is a preparation record naming this plan, a revision, the digest
 * the live document currently holds, and the base the manifest still names.
 * Those bytes can only have reached the live path through the publishing rename,
 * so the revision is real and its history entry is simply missing. Anything
 * less is a conflict: the bytes are left exactly where they are, nothing is
 * adopted, and the caller decides with the user.
 */
export async function recoverPlanRevisions(input: {
	root: string;
	planId: string;
	planPath: string;
	now: string;
	lease?: LockLease;
}): Promise<PlanRecoveryResult> {
	const loaded = await readPlanManifest(input.root, input.planId);
	if (loaded.kind === "missing") return { kind: "unmanaged" };
	if (loaded.kind === "invalid") return { kind: "unreadable", reason: loaded.reason };
	const live = await readPlanFile(input.planPath);
	if (live === undefined) {
		return {
			kind: "unreadable",
			reason: `the plan file at ${input.planPath} is gone, so its recorded history cannot be reconciled`,
		};
	}
	const liveDigest = digestOf(live);
	if (liveDigest === loaded.manifest.currentDigest) return { kind: "ok", manifest: loaded.manifest };

	return withManifestLock<PlanRecoveryResult>({
		root: input.root,
		planId: input.planId,
		...(input.lease ? { lease: input.lease } : {}),
		onLockFailure: (reason) => ({
			kind: "conflict",
			reason,
			manifest: loaded.manifest,
			liveDigest,
		}),
		run: async () => {
			// Re-read under the lock: a cooperating session may have finished the
			// very publication this one was about to recover.
			const fresh = await readPlanManifest(input.root, input.planId);
			if (fresh.kind !== "loaded") {
				return {
					kind: "unreadable",
					reason: fresh.kind === "missing" ? "the plan manifest disappeared" : fresh.reason,
				};
			}
			const current = await readPlanFile(input.planPath);
			if (current === undefined) {
				return {
					kind: "unreadable",
					reason: `the plan file at ${input.planPath} is gone, so its recorded history cannot be reconciled`,
				};
			}
			const digest = digestOf(current);
			if (digest === fresh.manifest.currentDigest) return { kind: "ok", manifest: fresh.manifest };

			const records = await readPreparationRecords(input.root, input.planId);
			// Evidence has to describe a publication that is genuinely *unfinished*, and
			// that is more than "a record with these bytes exists".
			//
			// Preparation records are never deleted — they are what keeps a revision
			// number consumed — so a record of a long-finished revision outlives it. With
			// only the digest and base compared, a plan revised D1 -> D2 and then rolled
			// back D2 -> D1 leaves revision 2's record matching any later reappearance of
			// D2: an outside edit would be reported as a recovered publication, the
			// manifest would be written *backwards* to revision 2, and a duplicate history
			// entry appended — losing the one conflict signal the whole layer rests on.
			//
			// So the record must name a revision above the one recorded and must not
			// already be in history. Both are monotonic: recovery can only ever finish a
			// revision the manifest has not reached, never revisit one it has.
			const recorded = new Set(fresh.manifest.history.map((entry) => entry.revision));
			const evidence = records.find(
				(record) =>
					record.revision > fresh.manifest.specRevision &&
					!recorded.has(record.revision) &&
					record.digest === digest &&
					record.baseDigest === fresh.manifest.currentDigest,
			);
			if (!evidence) {
				return {
					kind: "conflict",
					reason: `the plan file does not match recorded revision ${fresh.manifest.specRevision} and no prepared revision accounts for it, so it was changed outside Plan mode`,
					manifest: fresh.manifest,
					liveDigest: digest,
				};
			}
			// Published but unrecorded. The snapshot may already exist (the crash was
			// between the snapshot and the manifest), in which case the link fails
			// harmlessly and the manifest write is the repair.
			await linkSnapshotFromLive(input.root, input.planId, evidence.revision, current);
			const manifest: PlanManifest = {
				...fresh.manifest,
				specRevision: evidence.revision,
				currentDigest: digest,
				updatedAt: input.now,
				history: [
					...fresh.manifest.history,
					{
						revision: evidence.revision,
						digest,
						createdAt: evidence.createdAt || input.now,
						changeSummary: "recovered: the revision was published before its history was recorded",
						baseDigest: evidence.baseDigest,
					},
				],
			};
			try {
				await writeManifest(input.root, manifest);
			} catch (error: unknown) {
				return {
					kind: "conflict",
					reason: `revision ${evidence.revision} is live but its history could not be recorded (${describe(error)})`,
					manifest: fresh.manifest,
					liveDigest: digest,
				};
			}
			return { kind: "recovered", manifest, revision: evidence.revision };
		},
	});
}

async function linkSnapshotFromLive(
	root: string,
	planId: string,
	revision: number,
	contents: string,
): Promise<void> {
	const target = planSnapshotPath(root, planId, revision);
	try {
		const existing = await readFile(target, "utf8");
		if (digestOf(existing) === digestOf(contents)) return;
		// Two documents claim one revision. The snapshot is not touched: the number
		// is already reserved, so whatever publishes next is numbered above it.
		return;
	} catch {
		// No snapshot yet; write one from the live bytes, which the preparation
		// record has already been matched against.
	}
	await mkdir(snapshotsDirectory(root, planId), { recursive: true }).catch(() => undefined);
	await writeFile(target, contents, { encoding: "utf8", flag: "wx", mode: 0o600 }).catch(
		() => undefined,
	);
}

/** The snapshot bytes of one recorded revision, or undefined when it is gone. */
export async function readPlanSnapshot(
	root: string,
	planId: string,
	revision: number,
): Promise<string | undefined> {
	try {
		return await readPlanFile(planSnapshotPath(root, planId, revision));
	} catch {
		return undefined;
	}
}

export type PlanProposalStatus = "pending" | "accepted" | "cancelled" | "superseded";

const PLAN_PROPOSAL_STATUSES: readonly PlanProposalStatus[] = [
	"pending",
	"accepted",
	"cancelled",
	"superseded",
];

/**
 * A rewritten plan that has been computed but not accepted.
 *
 * It carries the base it was computed from (revision *and* digest), the exact
 * bytes it would publish, and the diff this package computed by comparing the
 * two documents. The model's own `changeSummary` is recorded and is never the
 * thing the user approves — a summary cannot be wrong about itself, a diff can.
 *
 * Nothing here ever deletes a proposal. Accepting one that no longer matches its
 * base fails and *keeps* the file, so the agent can refresh it instead of losing
 * the work; cancelling and superseding resolve it in place for the same reason.
 */
import { parseTaskSeed, type TaskSeed } from "./plan-contract.js";

export interface PlanProposal {
	tasks?: TaskSeed;
	taskDiff?: string;
	schemaVersion: typeof PLAN_PROPOSAL_SCHEMA_VERSION;
	proposalId: string;
	planId: string;
	/** The revision transaction this candidate belongs to. */
	revisionId: string;
	status: PlanProposalStatus;
	/** What the user asked for, in their own terms, from `update_plan(begin)`. */
	instructions: string;
	/** What the agent says it changed. */
	changeSummary: string;
	baseRevision: number;
	baseDigest: string;
	createdAt: string;
	resolvedAt?: string;
	supersededBy?: string;
	resolutionReason?: string;
	/** The complete proposed plan, ready to publish unchanged. */
	proposedPlan: string;
	/** Computed from the two documents. Not model-authored. */
	diff: string[];
}

export async function writePlanProposal(root: string, proposal: PlanProposal): Promise<string> {
	const path = planProposalPath(root, proposal.planId, proposal.proposalId);
	await mkdir(proposalsDirectory(root, proposal.planId), { recursive: true });
	await writeAtomically(path, `${JSON.stringify(proposal, null, 2)}\n`);
	return path;
}

export async function readPlanProposal(
	root: string,
	planId: string,
	proposalId: string,
): Promise<PlanProposal | undefined> {
	if (!isSafeManagedId(planId) || !isSafeManagedId(proposalId)) return undefined;
	const value = await readBoundedJson(planProposalPath(root, planId, proposalId), MAX_PROPOSAL_BYTES);
	const parsed = parseProposal(value);
	if (!parsed) return undefined;
	// Identity is checked on the way out: the record must agree with the filename
	// it was found under and with the plan that was asked for, or it could
	// otherwise redirect a publication into another plan.
	if (parsed.proposalId !== proposalId || parsed.planId !== planId) return undefined;
	return parsed;
}

function parseProposal(value: unknown): PlanProposal | undefined {
	if (!isRecord(value)) return undefined;
	if (value.schemaVersion !== PLAN_PROPOSAL_SCHEMA_VERSION) return undefined;
	const status = PLAN_PROPOSAL_STATUSES.find((candidate) => candidate === value.status);
	if (!status) return undefined;
	if (typeof value.proposalId !== "string" || !isSafeManagedId(value.proposalId)) return undefined;
	if (typeof value.planId !== "string" || !isSafeManagedId(value.planId)) return undefined;
	if (typeof value.revisionId !== "string" || !isSafeManagedId(value.revisionId)) return undefined;
	if (typeof value.proposedPlan !== "string" || !value.proposedPlan.trim()) return undefined;
	if (typeof value.baseDigest !== "string" || !DIGEST_RE.test(value.baseDigest)) return undefined;
	if (!Number.isSafeInteger(value.baseRevision)) return undefined;
	let tasks: TaskSeed | undefined;
	try { if (value.tasks !== undefined) tasks = parseTaskSeed(value.tasks); } catch { return undefined; }
	if (tasks && typeof value.taskDiff !== "string") return undefined;
	return {
		...(tasks ? { tasks, taskDiff: value.taskDiff as string } : {}),
		schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION,
		proposalId: value.proposalId,
		planId: value.planId,
		revisionId: value.revisionId,
		status,
		instructions: typeof value.instructions === "string" ? value.instructions : "",
		changeSummary: typeof value.changeSummary === "string" ? value.changeSummary : "",
		baseRevision: value.baseRevision as number,
		baseDigest: value.baseDigest,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
		...(typeof value.resolvedAt === "string" ? { resolvedAt: value.resolvedAt } : {}),
		...(typeof value.supersededBy === "string" ? { supersededBy: value.supersededBy } : {}),
		...(typeof value.resolutionReason === "string"
			? { resolutionReason: value.resolutionReason }
			: {}),
		proposedPlan: value.proposedPlan,
		diff: Array.isArray(value.diff)
			? value.diff.filter((entry): entry is string => typeof entry === "string")
			: [],
	};
}

export async function listPlanProposals(root: string, planId: string): Promise<PlanProposal[]> {
	let names: string[];
	try {
		names = await readdir(proposalsDirectory(root, planId));
	} catch {
		return [];
	}
	const proposals: PlanProposal[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const proposal = await readPlanProposal(root, planId, name.slice(0, -".json".length));
		if (proposal) proposals.push(proposal);
	}
	// A total, stable order so two processes reading one directory agree on which
	// pending candidate is newest.
	return proposals.sort(
		(left, right) =>
			left.createdAt.localeCompare(right.createdAt) ||
			left.proposalId.localeCompare(right.proposalId),
	);
}

export async function listPendingPlanProposals(
	root: string,
	planId: string,
): Promise<PlanProposal[]> {
	return (await listPlanProposals(root, planId)).filter(
		(proposal) => proposal.status === "pending",
	);
}

export async function resolvePlanProposal(
	root: string,
	proposal: PlanProposal,
	status: Exclude<PlanProposalStatus, "pending">,
	now: string,
	detail: { supersededBy?: string; resolutionReason?: string } = {},
): Promise<PlanProposal> {
	const resolved: PlanProposal = {
		...proposal,
		status,
		resolvedAt: now,
		...(detail.supersededBy ? { supersededBy: detail.supersededBy } : {}),
		...(detail.resolutionReason ? { resolutionReason: detail.resolutionReason } : {}),
	};
	await writePlanProposal(root, resolved);
	return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
