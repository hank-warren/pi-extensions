/**
 * What actually changed between two plans, computed here rather than taken from
 * the model.
 *
 * The review card shows this, not `changeSummary`: a summary cannot be wrong
 * about itself, and a diff can. A proposal whose summary says "only the
 * deployment section changed" and whose diff deletes the verification steps has
 * to read as the latter.
 *
 * A line diff, not a semantic one. There is deliberately no classifier deciding
 * which edits are "material": the user reads the change and decides.
 */

/** Beyond this, the quadratic table is not worth it; a coarse report is. */
const MAX_DIFF_LINES = 1500;
/** Beyond this, the card is unreadable anyway and the proposed plan is shown. */
const MAX_OUTPUT_LINES = 200;
const CONTEXT_LINES = 2;

export interface PlanDiff {
	/** Unified-style lines, `+`/`-`/` ` prefixed, with `@@` section markers. */
	lines: string[];
	added: number;
	removed: number;
	/** The output was capped, so `lines` is a prefix of the real change. */
	truncated: boolean;
	/**
	 * No textual change: the two documents have the same lines.
	 *
	 * Line endings and trailing newlines are normalized away before the comparison
	 * (`splitLines`), so this is emphatically *not* byte-identity — a candidate that
	 * differs only in CRLF or a final newline lands here. Callers must say "no
	 * textual change", never "byte-identical", or they claim a check nobody ran.
	 */
	identical: boolean;
}

function splitLines(text: string): string[] {
	const normalized = text.replace(/\r\n/gu, "\n").replace(/\n+$/u, "");
	return normalized === "" ? [] : normalized.split("\n");
}

export function diffPlanText(base: string, next: string): PlanDiff {
	const left = splitLines(base);
	const right = splitLines(next);
	if (left.length === right.length && left.every((line, index) => line === right[index])) {
		return { lines: [], added: 0, removed: 0, truncated: false, identical: true };
	}
	if (left.length > MAX_DIFF_LINES || right.length > MAX_DIFF_LINES) {
		return coarseDiff(left, right);
	}
	const operations = lineOperations(left, right);
	return render(operations);
}

type Operation = { kind: "same" | "add" | "remove"; line: string };

/**
 * Longest common subsequence over lines, with the table built as plain numbers.
 *
 * Both sides are bounded by `MAX_DIFF_LINES` before this runs, so the table is
 * at most 1500x1500 — large enough for any plan a human reads and small enough
 * that the cost never reaches a user.
 */
function lineOperations(left: string[], right: string[]): Operation[] {
	const rows = left.length;
	const columns = right.length;
	const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
	for (let row = rows - 1; row >= 0; row -= 1) {
		for (let column = columns - 1; column >= 0; column -= 1) {
			table[row][column] =
				left[row] === right[column]
					? table[row + 1][column + 1] + 1
					: Math.max(table[row + 1][column], table[row][column + 1]);
		}
	}
	const operations: Operation[] = [];
	let row = 0;
	let column = 0;
	while (row < rows && column < columns) {
		if (left[row] === right[column]) {
			operations.push({ kind: "same", line: left[row] });
			row += 1;
			column += 1;
			continue;
		}
		if (table[row + 1][column] >= table[row][column + 1]) {
			operations.push({ kind: "remove", line: left[row] });
			row += 1;
			continue;
		}
		operations.push({ kind: "add", line: right[column] });
		column += 1;
	}
	for (; row < rows; row += 1) operations.push({ kind: "remove", line: left[row] });
	for (; column < columns; column += 1) operations.push({ kind: "add", line: right[column] });
	return operations;
}

/** Unified output: changed runs with a little context, sections separated. */
function render(operations: Operation[]): PlanDiff {
	const changedAt = operations.map((operation) => operation.kind !== "same");
	const keep = new Array<boolean>(operations.length).fill(false);
	for (let index = 0; index < operations.length; index += 1) {
		if (!changedAt[index]) continue;
		for (
			let nearby = Math.max(0, index - CONTEXT_LINES);
			nearby <= Math.min(operations.length - 1, index + CONTEXT_LINES);
			nearby += 1
		) {
			keep[nearby] = true;
		}
	}
	const lines: string[] = [];
	let added = 0;
	let removed = 0;
	let truncated = false;
	let previousKept = -1;
	for (let index = 0; index < operations.length; index += 1) {
		const operation = operations[index];
		if (operation.kind === "add") added += 1;
		if (operation.kind === "remove") removed += 1;
		if (!keep[index]) continue;
		if (lines.length >= MAX_OUTPUT_LINES) {
			truncated = true;
			continue;
		}
		if (previousKept !== -1 && index > previousKept + 1) lines.push("@@");
		previousKept = index;
		lines.push(`${operation.kind === "add" ? "+" : operation.kind === "remove" ? "-" : " "}${operation.line}`);
	}
	if (truncated) lines.push("@@ diff truncated; choose “Show the proposed plan” to read all of it");
	return { lines, added, removed, truncated, identical: false };
}

/**
 * For a plan too long to diff line by line: say how much moved and which
 * headings appeared or disappeared, which is the part a reviewer scans first.
 */
function coarseDiff(left: string[], right: string[]): PlanDiff {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	const added = right.filter((line) => !leftSet.has(line)).length;
	const removed = left.filter((line) => !rightSet.has(line)).length;
	const heading = (line: string) => /^#{1,6}\s/u.test(line);
	const newHeadings = right.filter((line) => heading(line) && !leftSet.has(line));
	const goneHeadings = left.filter((line) => heading(line) && !rightSet.has(line));
	return {
		lines: [
			`@@ the plan is too long to diff line by line (${left.length} -> ${right.length} lines)`,
			`@@ ${added} line(s) added, ${removed} line(s) removed`,
			...goneHeadings.slice(0, 20).map((line) => `-${line}`),
			...newHeadings.slice(0, 20).map((line) => `+${line}`),
			"@@ choose “Show the proposed plan” to read the full text",
		],
		added,
		removed,
		truncated: true,
		identical: false,
	};
}

/** The one-line shape used in tool results and notifications. */
export function describePlanDiff(diff: PlanDiff): string {
	if (diff.identical) return "no change";
	return `${diff.added} line(s) added, ${diff.removed} line(s) removed`;
}
