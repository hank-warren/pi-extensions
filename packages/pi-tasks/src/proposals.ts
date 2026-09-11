/**
 * Proposals: a structural revision that has been computed but not accepted.
 *
 * A proposal carries the base it was computed from (revision *and* digest), the
 * exact bytes it would publish, and a diff this package computed by comparing
 * the two documents by id. The model's own description of what it changed is
 * recorded as `reason` and is never the thing the user approves — a summary
 * cannot be wrong about itself, and a diff can.
 *
 * Proposals are durable. Accepting one that no longer matches its base fails
 * and *keeps* the file, so the agent can refresh it instead of losing the work;
 * cancelling resolves it without deleting it, for the same reason.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
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

export type ProposalStatus = "pending" | "accepted" | "cancelled";

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

export async function readProposal(
	root: string,
	taskSetId: string,
	proposalId: string,
): Promise<TaskProposal | undefined> {
	if (!PROPOSAL_ID_RE.test(proposalId)) return undefined;
	try {
		const raw = await readFile(proposalPath(root, taskSetId, proposalId), "utf8");
		if (Buffer.byteLength(raw, "utf8") > MAX_PROPOSAL_BYTES) return undefined;
		return parseProposal(JSON.parse(raw));
	} catch {
		return undefined;
	}
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
	return proposals.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

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
): Promise<TaskProposal> {
	const resolved: TaskProposal = { ...proposal, status, resolvedAt: now };
	await writeProposal(root, resolved);
	return resolved;
}

export async function deleteProposal(
	root: string,
	taskSetId: string,
	proposalId: string,
): Promise<void> {
	try {
		await rm(proposalPath(root, taskSetId, proposalId), { force: true });
	} catch {
		// A proposal that cannot be removed is clutter, never a failed operation.
	}
}

function parseProposal(value: unknown): TaskProposal | undefined {
	if (!isRecord(value)) return undefined;
	if (value.schemaVersion !== PROPOSAL_SCHEMA_VERSION) return undefined;
	const status = value.status;
	if (status !== "pending" && status !== "accepted" && status !== "cancelled") return undefined;
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
