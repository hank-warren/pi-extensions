import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createLedger,
	criteriaFromDescriptions,
	CRITERIA_FILE,
	deriveCriteria,
	ledgerPaths,
	markCriterion,
	PROGRESS_FILE,
	readCriteria,
	writeProgressSection,
} from "../src/ledger.js";

function tempAgentDir(t: { after: (fn: () => void) => void }) {
	const directory = mkdtempSync(join(tmpdir(), "pi-loop-ledger-"));
	t.after(() => {
		try {
			chmodSync(directory, 0o755);
		} catch {
			// Best-effort: the permission test may have made it read-only.
		}
		rmSync(directory, { recursive: true, force: true });
	});
	return directory;
}

test("criteria derive from bullets, then sentences, then the implicit one", () => {
	const bullets = deriveCriteria("Ship the release:\n- tests pass\n- CI is green\n* docs updated");
	assert.deepEqual(
		bullets.map((criterion) => [criterion.id, criterion.description]),
		[
			["c1", "tests pass"],
			["c2", "CI is green"],
			["c3", "docs updated"],
		],
	);
	assert.ok(
		bullets.every((criterion) => criterion.passes === false && criterion.check === ""),
		"the extension writes them unmet, and never invents a check",
	);

	const sentences = deriveCriteria("Get CI green. Then cut a release.");
	assert.deepEqual(
		sentences.map((criterion) => criterion.description),
		["Get CI green.", "Then cut a release."],
	);

	// Nothing separable: one implicit criterion, so criteria.json is never
	// empty and loop_complete always has something to answer for.
	const implicit = deriveCriteria("keep the queue drained");
	assert.deepEqual(implicit, [
		{ id: "c1", description: "keep the queue drained", check: "", passes: false },
	]);
	assert.deepEqual(deriveCriteria("   ")[0]?.description, "objective met as stated");

	// A single bullet is not a list; it falls through to sentence splitting.
	assert.equal(deriveCriteria("- just one thing").length, 1);
	assert.ok(deriveCriteria(`${"x. ".repeat(40)}`).length <= 12, "bounded");
});

test("criteriaFromDescriptions numbers a proposed list on the extension's terms", () => {
	// Criteria supplied with an approved draft go through the same
	// numbering as a derived set: it writes the description, the extension
	// writes everything else, so nothing downstream can tell them apart.
	assert.deepEqual(criteriaFromDescriptions(["CI is green on main", "the fix is merged"]), [
		{ id: "c1", description: "CI is green on main", check: "", passes: false },
		{ id: "c2", description: "the fix is merged", check: "", passes: false },
	]);
	assert.equal(
		criteriaFromDescriptions(["  spaced   out  \n text "])[0]?.description,
		"spaced out text",
	);
	assert.equal(criteriaFromDescriptions(Array(20).fill("a thing")).length, 12, "bounded");
	assert.equal(criteriaFromDescriptions(["x".repeat(600)])[0]?.description.length, 500);
});

test("createLedger writes criteria and a schema'd progress file", (t) => {
	const agentDir = tempAgentDir(t);
	const paths = ledgerPaths("loop1234", agentDir);
	assert.equal(paths.dir, join(agentDir, "loop", "loop1234"));
	assert.equal(
		createLedger(paths, "get CI green", deriveCriteria("get CI green")),
		undefined,
		"success reports no failure reason",
	);

	assert.deepEqual(readCriteria(paths), [
		{ id: "c1", description: "get CI green", check: "", passes: false },
	]);
	const progress = readFileSync(paths.progress, "utf8");
	for (const heading of [
		"## Current status",
		"## Completed",
		"## Failed approaches and why",
		"## Next actions",
	]) {
		assert.ok(progress.includes(heading), `missing section: ${heading}`);
	}
	assert.ok(progress.includes("get CI green"));
});

test("a restored loop keeps its progress file but re-reads fresh criteria", (t) => {
	const agentDir = tempAgentDir(t);
	const paths = ledgerPaths("loop1234", agentDir);
	createLedger(paths, "get CI green", deriveCriteria("get CI green"));
	writeFileSync(paths.progress, "# days of work\n", "utf8");
	writeFileSync(
		paths.criteria,
		JSON.stringify([{ id: "c1", description: "get CI green", check: "", passes: true }]),
		"utf8",
	);

	// Session restart: same loop id, same objective.
	createLedger(paths, "get CI green", deriveCriteria("get CI green"));
	assert.equal(readFileSync(paths.progress, "utf8"), "# days of work\n", "never overwritten");
	assert.equal(readCriteria(paths)?.[0]?.passes, false, "criteria are the extension's file");
});

test("the ledger fails open: an unwritable dir reports, a corrupt file reads as none", (t) => {
	const agentDir = tempAgentDir(t);
	chmodSync(agentDir, 0o500);
	const failure = createLedger(
		ledgerPaths("loop1234", agentDir),
		"get CI green",
		deriveCriteria("get CI green"),
	);
	assert.ok(failure, "an unwritable ledger reports a reason instead of throwing");
	chmodSync(agentDir, 0o755);

	const paths = ledgerPaths("loop5678", agentDir);
	createLedger(paths, "get CI green", deriveCriteria("get CI green"));
	writeFileSync(paths.criteria, "{not json", "utf8");
	assert.equal(readCriteria(paths), undefined);
	writeFileSync(paths.criteria, JSON.stringify([{ id: "", description: "x" }]), "utf8");
	assert.equal(readCriteria(paths), undefined);
	writeFileSync(paths.criteria, JSON.stringify([]), "utf8");
	assert.equal(readCriteria(paths), undefined);
	assert.equal(readCriteria(ledgerPaths("never-created", agentDir)), undefined);
});

test("ledger file names are the ones the prompts name", () => {
	// The system append and the re-anchor tell the model to read these exact
	// names; a rename that misses one of them silently breaks the contract.
	const paths = ledgerPaths("loop1234", "/tmp/agent");
	assert.ok(paths.criteria.endsWith(CRITERIA_FILE));
	assert.ok(paths.progress.endsWith(PROGRESS_FILE));
});

test("a bullet that wraps across lines keeps its continuation lines", () => {
	// The regression that made this necessary: matching bullet markers and
	// discarding every other line truncated a wrapped bullet at its first line,
	// so a requirement left the gate with no signal that it had.
	const criteria = deriveCriteria(
		[
			"- Write docs/maturity-review.md listing at least 8 concrete gaps",
			"  between pi-loop and comparable agent-loop UX,",
			"  each with a source URL.",
			"- Rank those gaps into a prioritized plan,",
			"  top 3 marked \"implement now\".",
		].join("\n"),
	);
	assert.equal(criteria.length, 2);
	assert.equal(
		criteria[0].description,
		"Write docs/maturity-review.md listing at least 8 concrete gaps between pi-loop and comparable agent-loop UX, each with a source URL.",
	);
	assert.equal(
		criteria[1].description,
		'Rank those gaps into a prioritized plan, top 3 marked "implement now".',
	);
});

test("a blank line ends a bullet, and a preamble is still not a criterion", () => {
	const criteria = deriveCriteria(
		["Here is the plan:", "- first thing", "  still the first thing", "", "a trailing note"].join(
			"\n",
		),
	);
	// One bullet only, so the bullet path does not apply and sentences win;
	// what matters is that the trailing note was not glued onto the bullet.
	assert.ok(criteria.every((criterion) => !criterion.description.includes("a trailing note still")));
	const two = deriveCriteria(
		["- first thing", "  still the first thing", "", "- second thing"].join("\n"),
	);
	assert.deepEqual(
		two.map((criterion) => criterion.description),
		["first thing still the first thing", "second thing"],
	);
});

test("writeProgressSection edits one section and leaves the rest byte-identical", (t) => {
	const paths = ledgerPaths("loopwrite", tempAgentDir(t));
	assert.equal(createLedger(paths, "ship the thing", deriveCriteria("ship the thing")), undefined);
	const before = readFileSync(paths.progress, "utf8");

	// First write replaces the template placeholder rather than stacking under it.
	assert.equal(writeProgressSection(paths, "completed", "- landed the parser"), undefined);
	let contents = readFileSync(paths.progress, "utf8");
	assert.ok(contents.includes("- landed the parser"));
	assert.ok(!contents.includes("## Completed\n\n- (nothing yet)"));
	// Every other section survives untouched, including the objective line.
	assert.ok(contents.includes("Objective: ship the thing"));
	assert.ok(contents.includes("## Failed approaches and why\n\n- (nothing yet)"));
	assert.ok(contents.includes("## Next actions\n\n- (nothing yet)"));

	// Second write appends to the running list instead of replacing it.
	assert.equal(writeProgressSection(paths, "completed", "- landed the writer"), undefined);
	contents = readFileSync(paths.progress, "utf8");
	assert.ok(contents.includes("- landed the parser"));
	assert.ok(contents.includes("- landed the writer"));

	// "current status" is a single current value, so it replaces.
	assert.equal(writeProgressSection(paths, "current status", "halfway"), undefined);
	assert.equal(writeProgressSection(paths, "current status", "nearly done"), undefined);
	contents = readFileSync(paths.progress, "utf8");
	assert.ok(contents.includes("nearly done"));
	assert.ok(!contents.includes("halfway"));
	assert.ok(!contents.includes("Not started."));

	// The four headings are still the four headings.
	assert.deepEqual(
		contents.split("\n").filter((line) => line.startsWith("## ")),
		before.split("\n").filter((line) => line.startsWith("## ")),
	);

	assert.equal(writeProgressSection(paths, "completed", "   "), "the text to record was empty");
});

test("writeProgressSection reports a renamed section instead of recreating it", (t) => {
	const paths = ledgerPaths("loophand", tempAgentDir(t));
	createLedger(paths, "ship the thing", deriveCriteria("ship the thing"));
	writeFileSync(paths.progress, "# Loop progress ledger\n\n## Notes\n\nmine now\n", "utf8");
	const failure = writeProgressSection(paths, "completed", "- something");
	assert.match(failure ?? "", /no "## completed" section/);
	// The hand-edited file is left exactly as the user left it.
	assert.equal(readFileSync(paths.progress, "utf8"), "# Loop progress ledger\n\n## Notes\n\nmine now\n");
});

test("markCriterion flips one criterion with its citation and touches nothing else", (t) => {
	const paths = ledgerPaths("loopmark", tempAgentDir(t));
	const criteria = criteriaFromDescriptions(["add the flag", "test the flag", "document the flag"]);
	createLedger(paths, "add a --json flag", criteria);

	const result = markCriterion(paths, "c2", "npm test -> 214 passing, 0 failing", true, 1234);
	assert.equal(result.ok, true);
	assert.match(result.message, /c2 marked met \(1\/3 now passing\)/);

	const stored = readCriteria(paths);
	assert.equal(stored?.[1].passes, true);
	assert.equal(stored?.[1].evidence, "npm test -> 214 passing, 0 failing");
	assert.equal(stored?.[1].evidenceAt, 1234);
	// Descriptions, ids and checks are not a thing this path can rewrite.
	assert.deepEqual(
		stored?.map((criterion) => criterion.description),
		["add the flag", "test the flag", "document the flag"],
	);
	assert.deepEqual(stored?.map((criterion) => criterion.id), ["c1", "c2", "c3"]);
	assert.equal(stored?.[0].passes, false);
	assert.equal(stored?.[0].evidence, undefined);

	// Marking met requires a citation; an unknown id names the ones that exist.
	assert.deepEqual(markCriterion(paths, "c1", "  ", true, 1), {
		ok: false,
		message: "marking a criterion met requires evidence",
	});
	assert.match(markCriterion(paths, "c9", "x", true, 1).message, /no criterion c9; this loop has c1, c2, c3/);

	// A criterion can be un-marked without evidence: retracting is not a claim.
	assert.equal(markCriterion(paths, "c2", "", false, 2).ok, true);
	assert.equal(readCriteria(paths)?.[1].passes, false);
});
