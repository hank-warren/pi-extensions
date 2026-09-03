/**
 * The loop ledger: `~/.pi/agent/loop/<loop-id>/`.
 *
 * A multi-day loop cannot keep its state in the conversation — compaction is
 * lossy by construction, and every summary of a summary drifts further from
 * what actually happened. So the conversation stays the working memory and
 * two files on disk become the record:
 *
 * - `criteria.json` — the completion criteria, written by the extension. JSON
 *   deliberately, not Markdown: models rewrite prose they are asked to
 *   maintain far more readily than they rewrite a structured file, and the
 *   only edit this file may receive is flipping `passes`.
 * - `PROGRESS.md` — the agent-maintained ledger, created here with a fixed
 *   schema so "update the ledger" means the same thing on every turn.
 *
 * Keyed by **loop id**, not session id: session ids are not stably exposed to
 * extensions, and one session can run several loops in sequence.
 *
 * Every operation here is best-effort. A read-only home directory, a full
 * disk, or a file the user hand-edited into invalid JSON must degrade the
 * loop to "no ledger", never break it: the ledger is an anchor for the model,
 * not a dependency of the engine.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const LEDGER_DIR_NAME = "loop";
export const CRITERIA_FILE = "criteria.json";
export const PROGRESS_FILE = "PROGRESS.md";

/** Cap on a loop's criteria: an objective is a paragraph, not a backlog. */
const MAX_CRITERIA = 12;
const MAX_DESCRIPTION_LENGTH = 500;

export interface LoopCriterion {
	id: string;
	description: string;
	/**
	 * How the criterion is verified. Empty means "audit against authoritative
	 * current state"; the extension writes this field and the model may not
	 * change it.
	 */
	check: string;
	passes: boolean;
	/**
	 * The citation given when `passes` was flipped, recorded by the extension
	 * at flip time. Absent on a criterion still unmet, and on one flipped by a
	 * hand-edit rather than through `loop_progress`.
	 */
	evidence?: string;
	/** Epoch ms of the flip that recorded `evidence`. */
	evidenceAt?: number;
}

/**
 * The fixed headings of `PROGRESS.md`. The schema is the point: "update the
 * ledger" means the same thing on every turn only while the sections are the
 * same on every turn, so writes are section-scoped and a section that is not
 * one of these is refused rather than created.
 */
export const PROGRESS_SECTIONS = [
	"current status",
	"completed",
	"failed approaches and why",
	"next actions",
] as const;
export type ProgressSection = (typeof PROGRESS_SECTIONS)[number];

/** Cap on one ledger write: a progress note is a paragraph, not a transcript. */
export const MAX_PROGRESS_TEXT_LENGTH = 4000;
export const MAX_EVIDENCE_LENGTH = 4000;

/** The template's placeholders, replaced rather than appended to on first write. */
const PLACEHOLDERS = new Set(["not started.", "- (nothing yet)"]);

function loopLedgerDir(loopId: string, agentDir = getAgentDir()): string {
	return join(agentDir, LEDGER_DIR_NAME, loopId);
}

/**
 * Split an objective into checkable criteria.
 *
 * Deterministic and dumb on purpose: bullets first (a user who wrote a list
 * meant a list), otherwise sentences. An objective with no separable parts
 * yields the single implicit criterion, so `criteria.json` is never empty and
 * `loop_complete` always has something concrete to answer for.
 */
export function deriveCriteria(objective: string): LoopCriterion[] {
	const trimmed = objective.trim();
	if (!trimmed) return [implicitCriterion(objective)];
	const bullets = collectBullets(trimmed);
	const parts = bullets.length > 1 ? bullets : splitSentences(trimmed);
	if (parts.length < 2) return [implicitCriterion(trimmed)];
	return criteriaFromDescriptions(parts);
}

/**
 * Number a list of descriptions into criteria.
 *
 * Shared by the deterministic split and by any criteria supplied with an
 * approved draft, so nothing downstream — the echo at start, the evidence
 * gate, the immutability rule — can tell the two apart. The extension still
 * writes every field but the description: ids are positional, `check` is
 * empty (audit against authoritative state), and a criterion starts unmet.
 */
export function criteriaFromDescriptions(descriptions: readonly string[]): LoopCriterion[] {
	return descriptions.slice(0, MAX_CRITERIA).map((description, index) => ({
		id: `c${index + 1}`,
		description: truncate(description),
		check: "",
		passes: false,
	}));
}

const BULLET_MARKER = /^([-*+]|\d+[.)])\s+/;

/**
 * Bullets, each folded back together with the lines it wrapped onto.
 *
 * A bullet longer than the terminal width is typed — or pasted — across
 * several lines, and only the first carries the marker. Matching markers and
 * discarding everything else silently truncated such a bullet at its first
 * line, which is worse than mis-splitting it: the criterion still looked
 * well-formed, so a requirement could vanish out of the gate with no signal.
 * A non-blank line that starts no new bullet therefore continues the previous
 * one. Text before the first bullet is still ignored (it is a preamble, not a
 * requirement), and a blank line ends the bullet it follows so a trailing
 * paragraph cannot be glued onto the last item.
 */
function collectBullets(text: string): string[] {
	const bullets: string[] = [];
	let open = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) {
			open = false;
			continue;
		}
		if (BULLET_MARKER.test(line)) {
			const body = line.replace(BULLET_MARKER, "").trim();
			if (body) {
				bullets.push(body);
				open = true;
			} else {
				// A bare marker has no body to continue.
				open = false;
			}
			continue;
		}
		if (open) bullets[bullets.length - 1] += ` ${line}`;
	}
	return bullets;
}

function implicitCriterion(objective: string): LoopCriterion {
	return {
		id: "c1",
		description: truncate(objective.trim()) || "objective met as stated",
		check: "",
		passes: false,
	};
}

/**
 * Sentence split that survives how objectives are actually typed: mostly
 * lowercase, occasionally with an abbreviation in the middle. Splitting on
 * any letter after a full stop would turn "e.g. run the tests" into two
 * criteria, so a fragment following a known abbreviation is merged back.
 */
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|cf|approx|no|fig|dr|mr|ms|mrs|st)\.$/iu;

function splitSentences(text: string): string[] {
	const parts = text
		.split(/(?<=[.!?])\s+(?=[\p{L}\d])/u)
		.map((sentence) => sentence.trim().replace(/\s+/gu, " "))
		.filter((sentence) => sentence.length > 2);
	const merged: string[] = [];
	for (const part of parts) {
		const previous = merged.at(-1);
		if (previous !== undefined && ABBREVIATION.test(previous)) {
			merged[merged.length - 1] = `${previous} ${part}`;
			continue;
		}
		merged.push(part);
	}
	return merged;
}

function truncate(value: string): string {
	const collapsed = value.replace(/\s+/gu, " ").trim();
	return collapsed.length <= MAX_DESCRIPTION_LENGTH
		? collapsed
		: `${collapsed.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`;
}

export interface LedgerPaths {
	dir: string;
	criteria: string;
	progress: string;
}

export function ledgerPaths(loopId: string, agentDir?: string): LedgerPaths {
	const dir = loopLedgerDir(loopId, agentDir);
	return { dir, criteria: join(dir, CRITERIA_FILE), progress: join(dir, PROGRESS_FILE) };
}

/**
 * Create the ledger for a loop. Returns the failure reason, or undefined on
 * success — the caller warns once and carries on either way.
 *
 * `criteria.json` is authoritative and overwritten on start (a new loop has
 * new criteria). `PROGRESS.md` is only ever created, never overwritten: it is
 * the agent's file, and a session restart must not erase days of ledger.
 */
export function createLedger(
	paths: LedgerPaths,
	objective: string,
	criteria: LoopCriterion[],
): string | undefined {
	try {
		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.criteria, `${JSON.stringify(criteria, null, 2)}\n`, "utf8");
		try {
			writeFileSync(paths.progress, progressTemplate(objective), { encoding: "utf8", flag: "wx" });
		} catch (error) {
			// EEXIST is the normal case on restore: keep the existing ledger.
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		}
		return undefined;
	} catch (error) {
		return formatError(error);
	}
}

function progressTemplate(objective: string): string {
	return [
		"# Loop progress ledger",
		"",
		`Objective: ${objective.replace(/\s+/gu, " ").trim()}`,
		"",
		"Maintained by the agent. Keep these four sections; replace their contents.",
		"",
		"## Current status",
		"",
		"Not started.",
		"",
		"## Completed",
		"",
		"- (nothing yet)",
		"",
		"## Failed approaches and why",
		"",
		"- (nothing yet)",
		"",
		"## Next actions",
		"",
		"- (nothing yet)",
		"",
	].join("\n");
}

/**
 * Append to (or replace) one section of `PROGRESS.md`, leaving every other
 * section byte-identical.
 *
 * This exists because the alternative the model reaches for otherwise is a
 * whole-file overwrite, which takes out the objective line and the other
 * three sections along with it. `createLedger` already refuses to overwrite
 * this file for exactly that reason; the agent's write path has to honour the
 * same rule or the protection is decorative.
 *
 * Returns the failure reason, or undefined on success.
 */
export function writeProgressSection(
	paths: LedgerPaths,
	section: ProgressSection,
	text: string,
): string | undefined {
	const entry = text.trim();
	if (!entry) return "the text to record was empty";
	let contents: string;
	try {
		contents = readFileSync(paths.progress, "utf8");
	} catch (error) {
		return formatError(error);
	}
	const lines = contents.split(/\r?\n/);
	const start = lines.findIndex((line) => headingText(line) === section);
	if (start === -1) {
		return `PROGRESS.md has no "## ${section}" section (it was renamed or removed by hand)`;
	}
	let end = start + 1;
	while (end < lines.length && headingText(lines[end]) === undefined) end += 1;
	const body = lines.slice(start + 1, end);
	while (body.length > 0 && !body[0].trim()) body.shift();
	while (body.length > 0 && !body[body.length - 1].trim()) body.pop();
	const placeholder =
		body.length === 1 && PLACEHOLDERS.has(body[0].trim().toLowerCase()) ? true : body.length === 0;
	// Whether a write replaces or extends is a property of the section, not a
	// choice: "current status" is a single current value and the other three are
	// running lists. Deriving it keeps the decision out of the tool schema,
	// where the model could get it wrong on a file nothing else can repair.
	const next =
		section === "current status" || placeholder
			? entry.split("\n")
			: [...body, "", ...entry.split("\n")];
	const rebuilt = [...lines.slice(0, start + 1), "", ...next, "", ...lines.slice(end)];
	try {
		writeFileSync(paths.progress, `${rebuilt.join("\n").replace(/\n{3,}$/u, "\n")}`, "utf8");
		return undefined;
	} catch (error) {
		return formatError(error);
	}
}

function headingText(line: string | undefined): string | undefined {
	const match = /^##\s+(.+?)\s*$/u.exec(line ?? "");
	return match ? match[1].toLowerCase() : undefined;
}

interface MarkCriterionResult {
	ok: boolean;
	message: string;
	criteria?: LoopCriterion[];
}

/**
 * Flip one criterion's `passes` and record the citation that justified it.
 *
 * The only mutation `criteria.json` accepts. Descriptions, ids, checks and the
 * set of entries are rewritten by nothing here, so "a model may not rewrite
 * its own acceptance criteria" stops being a rule in a skill file and becomes
 * a property of the only available write path.
 */
export function markCriterion(
	paths: LedgerPaths,
	id: string,
	evidence: string,
	passes: boolean,
	now: number,
): MarkCriterionResult {
	const criteria = readCriteria(paths);
	if (!criteria) return { ok: false, message: "criteria.json is absent or unreadable" };
	const target = criteria.find((criterion) => criterion.id === id);
	if (!target) {
		return {
			ok: false,
			message: `no criterion ${id}; this loop has ${criteria.map((c) => c.id).join(", ")}`,
		};
	}
	const cited = evidence.trim();
	if (passes && !cited) return { ok: false, message: "marking a criterion met requires evidence" };
	const updated = criteria.map((criterion) =>
		criterion.id === id
			? {
					...criterion,
					passes,
					...(passes ? { evidence: cited, evidenceAt: now } : {}),
				}
			: criterion,
	);
	try {
		writeFileSync(paths.criteria, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
	} catch (error) {
		return { ok: false, message: formatError(error) };
	}
	const met = updated.filter((criterion) => criterion.passes).length;
	return {
		ok: true,
		message: `${id} marked ${passes ? "met" : "unmet"} (${met}/${updated.length} now passing)`,
		criteria: updated,
	};
}

/** Read the criteria back, fail-open: undefined when absent or unreadable. */
export function readCriteria(paths: LedgerPaths): LoopCriterion[] | undefined {
	let contents: string;
	try {
		contents = readFileSync(paths.criteria, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(contents);
		if (!Array.isArray(parsed)) return undefined;
		const criteria: LoopCriterion[] = [];
		for (const value of parsed) {
			const criterion = normalizeCriterion(value);
			if (!criterion) return undefined;
			criteria.push(criterion);
		}
		return criteria.length > 0 ? criteria : undefined;
	} catch {
		return undefined;
	}
}

function normalizeCriterion(value: unknown): LoopCriterion | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id.trim() : "";
	const description = typeof record.description === "string" ? record.description.trim() : "";
	if (!id || !description) return undefined;
	const evidence = typeof record.evidence === "string" ? record.evidence.trim() : "";
	const evidenceAt = record.evidenceAt;
	return {
		id,
		description,
		check: typeof record.check === "string" ? record.check : "",
		passes: record.passes === true,
		...(evidence ? { evidence } : {}),
		...(typeof evidenceAt === "number" && Number.isSafeInteger(evidenceAt) ? { evidenceAt } : {}),
	};
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
