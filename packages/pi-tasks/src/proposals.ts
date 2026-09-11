/**
 * Proposals: a structural revision that has been computed but not accepted.
 *
 * A proposal carries the base it was computed from (revision *and* digest), the
 * exact bytes it would publish, and a diff this package computed by comparing
 * the two documents by id. The model's own description of what it changed is
 * recorded as `reason` and is never the thing the user approves — a summary
 * cannot be wrong about itself, and a diff can.
 *
 * Proposals are durable, and nothing here ever deletes one. Accepting one that
 * no longer matches its base fails and *keeps* the file, so the agent can
 * refresh it instead of losing the work; cancelling and superseding resolve it
 * in place, for the same reason.
 *
 * At most one proposal per task set is `pending`. A corrected proposal replaces
 * its predecessor by publishing itself first and then retiring the old one as
 * `superseded`, so a crash between the two leaves two pending records rather
 * than none — which is recoverable, where a lost replacement would not be.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseTaskDocument } from "./markdown.js";
import {
	allTasks,
	findTask,
	type Task,
	type TaskSet,
} from "./model.js";
import { proposalsDirectory, writeAtomically } from "./store.js";

export const PROPOSAL_SCHEMA_VERSION = 1;
const PROPOSAL_ID_RE = /^[0-9a-f-]{36}$/u;
const MAX_PROPOSAL_BYTES = 2 * 1024 * 1024;

/**
 * `superseded` is terminal like the other two: the content stays on disk and
 * stays inspectable, but it can never be published and never drives the review
 * state. It exists so that a corrected proposal, or an accepted revision that
 * moved the base, does not leave an obsolete candidate latched as "pending"
 * forever — which would put a review sentence in every system prompt.
 */
export type ProposalStatus = "pending" | "accepted" | "cancelled" | "superseded";

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
	"pending",
	"accepted",
	"cancelled",
	"superseded",
];

export interface TaskProposal {
	schemaVersion: typeof PROPOSAL_SCHEMA_VERSION;
	proposalId: string;
	taskSetId: string;
	status: ProposalStatus;
	/** Why the user asked for this change, in the agent's words. */
	reason: string;
	baseRevision: number;
	baseDigest: string;
	createdAt: string;
	resolvedAt?: string;
	/** Which proposal replaced this one, when `status === "superseded"`. */
	supersededBy?: string;
	/** Why it was retired, for the user reading a resolved candidate later. */
	resolutionReason?: string;
	/** The complete proposed document, ready to publish unchanged. */
	proposedDocument: string;
	/** Computed by comparing base and proposed sets by id. Not model-authored. */
	diff: string[];
	/** The batch as applied, one line per change. */
	applied: string[];
}

export function newProposalId(): string {
	return randomUUID();
}

export function proposalPath(root: string, taskSetId: string, proposalId: string): string {
	if (!PROPOSAL_ID_RE.test(proposalId)) throw new Error(`unsafe proposal id: ${proposalId}`);
	return join(proposalsDirectory(root, taskSetId), `${proposalId}.json`);
}

export async function writeProposal(root: string, proposal: TaskProposal): Promise<string> {
	const path = proposalPath(root, proposal.taskSetId, proposal.proposalId);
	await mkdir(proposalsDirectory(root, proposal.taskSetId), { recursive: true });
	await writeAtomically(path, `${JSON.stringify(proposal, null, 2)}\n`);
	return path;
}

/**
 * Read one proposal, bounding the read *before* it allocates.
 *
 * A size check after `readFile` is decorative: the bytes are already in memory
 * by then. The handle is opened `O_NOFOLLOW`, stat-ed for a regular file, and
 * refused on size before anything is read — the same discipline the task
 * document gets, for a file in the same user-writable directory.
 *
 * Identity is checked on the way out: the record must agree with the filename
 * it was found under, with the task set that was asked for, and with the task
 * set its own proposed document claims. A proposal that disagrees with any of
 * the three could otherwise redirect a publication into another set.
 */
export async function readProposal(
	root: string,
	taskSetId: string,
	proposalId: string,
): Promise<TaskProposal | undefined> {
	if (!PROPOSAL_ID_RE.test(proposalId)) return undefined;
	let raw: string;
	try {
		const handle = await open(
			proposalPath(root, taskSetId, proposalId),
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		try {
			const stats = await handle.stat();
			if (!stats.isFile() || stats.size > MAX_PROPOSAL_BYTES) return undefined;
			raw = await handle.readFile({ encoding: "utf8" });
		} finally {
			await handle.close().catch(() => undefined);
		}
	} catch {
		return undefined;
	}
	let parsed: TaskProposal | undefined;
	try {
		parsed = parseProposal(JSON.parse(raw));
	} catch {
		return undefined;
	}
	if (!parsed) return undefined;
	if (parsed.proposalId !== proposalId || parsed.taskSetId !== taskSetId) return undefined;
	const document = parseTaskDocument(parsed.proposedDocument);
	if (!document.ok || document.document.set.taskSetId !== taskSetId) return undefined;
	return parsed;
}

export async function listProposals(root: string, taskSetId: string): Promise<TaskProposal[]> {
	let names: string[];
	try {
		names = await readdir(proposalsDirectory(root, taskSetId));
	} catch {
		return [];
	}
	const proposals: TaskProposal[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const proposal = await readProposal(root, taskSetId, name.slice(0, -".json".length));
		if (proposal) proposals.push(proposal);
	}
	return proposals.sort(
		(left, right) =>
			left.createdAt.localeCompare(right.createdAt) ||
			left.proposalId.localeCompare(right.proposalId),
	);
}

/**
 * Pending candidates, oldest first.
 *
 * More than one can only exist after a crash between publishing a replacement
 * and retiring its predecessor, which the controller converges on read. The
 * order is total and stable (`createdAt`, then id) so two processes recovering
 * the same directory pick the same winner.
 */
export async function listPendingProposals(
	root: string,
	taskSetId: string,
): Promise<TaskProposal[]> {
	return (await listProposals(root, taskSetId)).filter(
		(proposal) => proposal.status === "pending",
	);
}

export async function resolveProposal(
	root: string,
	proposal: TaskProposal,
	status: Exclude<ProposalStatus, "pending">,
	now: string,
	detail: { supersededBy?: string; resolutionReason?: string } = {},
): Promise<TaskProposal> {
	const resolved: TaskProposal = {
		...proposal,
		status,
		resolvedAt: now,
		...(detail.supersededBy ? { supersededBy: detail.supersededBy } : {}),
		...(detail.resolutionReason ? { resolutionReason: detail.resolutionReason } : {}),
	};
	await writeProposal(root, resolved);
	return resolved;
}

function parseProposal(value: unknown): TaskProposal | undefined {
	if (!isRecord(value)) return undefined;
	if (value.schemaVersion !== PROPOSAL_SCHEMA_VERSION) return undefined;
	const status = PROPOSAL_STATUSES.find((candidate) => candidate === value.status);
	if (!status) return undefined;
	if (typeof value.proposalId !== "string" || !PROPOSAL_ID_RE.test(value.proposalId)) {
		return undefined;
	}
	if (typeof value.taskSetId !== "string" || !value.taskSetId) return undefined;
	if (typeof value.proposedDocument !== "string" || !value.proposedDocument) return undefined;
	if (typeof value.baseDigest !== "string" || !value.baseDigest) return undefined;
	if (!Number.isSafeInteger(value.baseRevision)) return undefined;
	return {
		schemaVersion: PROPOSAL_SCHEMA_VERSION,
		proposalId: value.proposalId,
		taskSetId: value.taskSetId,
		status,
		reason: typeof value.reason === "string" ? value.reason : "",
		baseRevision: value.baseRevision as number,
		baseDigest: value.baseDigest,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
		...(typeof value.resolvedAt === "string" ? { resolvedAt: value.resolvedAt } : {}),
		...(typeof value.supersededBy === "string" ? { supersededBy: value.supersededBy } : {}),
		...(typeof value.resolutionReason === "string"
			? { resolutionReason: value.resolutionReason }
			: {}),
		proposedDocument: value.proposedDocument,
		diff: stringArray(value.diff),
		applied: stringArray(value.applied),
	};
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * What actually changed between two task sets, matched by id.
 *
 * Matching by id rather than by text is the whole point: a reworded task is a
 * rename with its status and completion intact, not a removal plus an addition
 * that quietly discards both.
 */
export function diffTaskSets(base: TaskSet, next: TaskSet): string[] {
	const lines: string[] = [];
	const basePhases = new Map(base.phases.map((phase) => [phase.id, phase]));
	const nextPhases = new Map(next.phases.map((phase) => [phase.id, phase]));

	for (const phase of next.phases) {
		const previous = basePhases.get(phase.id);
		if (!previous) {
			lines.push(`+ phase ${phase.id} "${phase.name}" (${phase.tasks.length} task(s))`);
			continue;
		}
		if (previous.name !== phase.name) {
			lines.push(`~ phase ${phase.id} renamed: "${previous.name}" -> "${phase.name}"`);
		}
	}
	for (const phase of base.phases) {
		if (!nextPhases.has(phase.id)) lines.push(`- phase ${phase.id} "${phase.name}" removed`);
	}

	const basePhaseOf = new Map<string, string>();
	for (const phase of base.phases) {
		for (const task of phase.tasks) basePhaseOf.set(task.id, phase.id);
	}

	for (const phase of next.phases) {
		for (const task of phase.tasks) {
			const previous = findTask(base, task.id);
			if (!previous) {
				lines.push(`+ ${task.id} in ${phase.id}: "${task.content}"`);
				continue;
			}
			lines.push(...describeTaskChange(previous.task, task, basePhaseOf.get(task.id), phase.id));
		}
	}
	const nextIds = new Set(allTasks(next).map((task) => task.id));
	for (const task of allTasks(base)) {
		if (!nextIds.has(task.id)) {
			lines.push(
				`- ${task.id}: "${task.content}" removed (was ${task.status}${task.completion ? ", completion retained in history" : ""})`,
			);
		}
	}
	return lines;
}

function describeTaskChange(
	previous: Task,
	next: Task,
	previousPhaseId: string | undefined,
	nextPhaseId: string,
): string[] {
	const lines: string[] = [];
	if (previous.content !== next.content) {
		lines.push(`~ ${next.id} reworded: "${previous.content}" -> "${next.content}"`);
	}
	if (previous.status !== next.status) {
		const reopened = previous.status !== next.status && next.status === "pending" && !!previous.completion;
		lines.push(
			`~ ${next.id} ${previous.status} -> ${next.status}${reopened ? " (reopened; the recorded completion moved to history and no longer counts)" : ""}`,
		);
	}
	if (previousPhaseId && previousPhaseId !== nextPhaseId) {
		lines.push(`~ ${next.id} moved: ${previousPhaseId} -> ${nextPhaseId}`);
	}
	if ((previous.blocker ?? "") !== (next.blocker ?? "") && next.blocker) {
		lines.push(`~ ${next.id} blocker: ${next.blocker}`);
	}
	return lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
