import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { auditEvidence, LOOP_COMPLETE_TOOL, registerLoopCompleteTool } from "../src/complete-tool.js";
import { LOOP_CRAFT_DOC } from "../src/docs.js";
import type { LoopCriterion } from "../src/ledger.js";
import type { LoopController } from "../src/loop.js";
import type { LoopState } from "../src/state.js";

const STANDALONE: LoopState = {
	id: "loop1234",
	status: "active",
	objective: "get CI green, verified by a passing run",
	intervalMs: 300_000,
	maxTurns: 25,
	compactAt: 0.7,
	iteration: 3,
	automaticTurns: 5,
	startedAt: 0,
	expiresAt: 604_800_000,
};

const CRITERIA: LoopCriterion[] = [
	{ id: "c1", description: "get CI green", check: "", passes: false },
	{ id: "c2", description: "verified by a passing run", check: "", passes: false },
];

const EVIDENCE = {
	c1: "gh run list --branch main --limit 1 shows conclusion=success for run 32596775525",
	c2: "npm test printed 'tests 116 / pass 116 / fail 0' on the merge commit",
};

interface ToolLike {
	name: string;
	execute: (
		id: string,
		params: { loop_id: string; evidence?: Record<string, string>; summary?: string },
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function harness(state: LoopState | undefined, criteria: LoopCriterion[] | undefined = CRITERIA) {
	const completed: Array<string | undefined> = [];
	const tools: ToolLike[] = [];
	const pi = { registerTool: (tool: ToolLike) => tools.push(tool) } as unknown as ExtensionAPI;
	const controller = {
		get state() {
			return state;
		},
		completeLoop: (summary?: string) => completed.push(summary),
		criteria: () => criteria,
	} as unknown as LoopController;
	registerLoopCompleteTool(pi, controller);
	const tool = tools[0];
	assert.ok(tool);
	assert.equal(tool.name, LOOP_COMPLETE_TOOL);
	return { tool, completed };
}

const run = async (
	tool: ToolLike,
	params: { loop_id: string; evidence?: Record<string, string>; summary?: string },
) => tool.execute("call-1", { evidence: EVIDENCE, ...params });

test("a matching loop_id with evidence for every criterion stops the loop", async () => {
	const h = harness(STANDALONE);
	const result = await run(h.tool, { loop_id: "loop1234", summary: "412 passing, CI green" });
	assert.notEqual(result.isError, true);
	assert.deepEqual(h.completed, ["412 passing, CI green"]);
	assert.match(result.content[0]?.text ?? "", /every criterion answered with evidence/);
});

test("completion is refused until every criterion is answered", async () => {
	const h = harness(STANDALONE);
	const partial = await run(h.tool, { loop_id: "loop1234", evidence: { c1: EVIDENCE.c1 } });
	assert.equal(partial.isError, true);
	assert.deepEqual(h.completed, [], "an unanswered criterion is not completion");
	assert.match(partial.content[0]?.text ?? "", /1 of 2 criteria have no cited evidence/);
	assert.match(partial.content[0]?.text ?? "", /c2 \(still recorded as unmet\)/);
	assert.match(partial.content[0]?.text ?? "", /effort exhaustion is not completion/i);

	// Asserting completion is not citing it.
	const weak = await run(h.tool, {
		loop_id: "loop1234",
		evidence: { c1: "done", c2: "verified" },
	});
	assert.equal(weak.isError, true);
	assert.match(weak.content[0]?.text ?? "", /asserts completion instead of citing it/);

	// Inventing ids to satisfy the gate does not work either.
	const forged = await run(h.tool, {
		loop_id: "loop1234",
		evidence: { ...EVIDENCE, c9: "some other thing I did that took a while" },
	});
	assert.equal(forged.isError, true);
	assert.match(forged.content[0]?.text ?? "", /unknown criterion id\(s\) c9/);
	assert.deepEqual(h.completed, []);
});

test("terse but specific evidence is a citation; a claim is not", async () => {
	// The length floor used to be twelve characters, which refused "404 → 200"
	// — nine characters, and exactly the kind of citation the gate wants. The
	// blocklist is the rule now: a value is an assertion only when every word
	// in it is a claim word, punctuation and case ignored.
	for (const terse of ["404 → 200", "tests: 0 fail", "exit 0", "212/212", "HTTP 204"]) {
		const h = harness(STANDALONE);
		const result = await run(h.tool, {
			loop_id: "loop1234",
			evidence: { c1: terse, c2: terse },
		});
		assert.notEqual(result.isError, true, terse);
		assert.deepEqual(h.completed, [undefined], terse);
	}

	for (const assertion of [
		"done",
		"Done.",
		"verified, passed",
		"all done!",
		"it passes",
		"yes",
		"n/a",
		"✓",
		"   ",
	]) {
		const refusal = auditEvidence(CRITERIA, { c1: EVIDENCE.c1, c2: assertion });
		assert.match(
			refusal ?? "",
			/asserts completion instead of citing it|no cited evidence/,
			assertion,
		);
	}
});

test("auditEvidence degrades to one citation when the ledger is unreadable", () => {
	// The ledger is fail-open everywhere else; a missing criteria.json must not
	// make a finished loop uncompletable.
	assert.equal(auditEvidence(undefined, { anything: "npm test printed 116 passing" }), undefined);
	const refusal = auditEvidence(undefined, {});
	assert.match(refusal ?? "", /at least one specific citation/);
	assert.match(auditEvidence(undefined, { c1: "ok" }) ?? "", /at least one specific citation/);
});

test("a stale loop_id is refused so an old turn cannot stop a newer loop", async () => {
	const h = harness(STANDALONE);
	const result = await run(h.tool, { loop_id: "oldloop" });
	assert.equal(result.isError, true);
	assert.deepEqual(h.completed, [], "no stop");
	assert.match(result.content[0]?.text ?? "", /does not match/);
});

test("a pre-0.6.0 loop with no objective has nothing to complete", async () => {
	const { objective: _objective, ...objectiveless } = STANDALONE;
	const h = harness(objectiveless);
	const result = await run(h.tool, { loop_id: objectiveless.id });
	assert.equal(result.isError, true);
	assert.deepEqual(h.completed, []);
	assert.match(result.content[0]?.text ?? "", /No \/loop with an objective is active/);
});

test("the tool exists with no loop at all, and refuses", async () => {
	// It is registered unconditionally: mutating the tool set mid-session
	// would invalidate the cached request prefix.
	const h = harness(undefined);
	const result = await run(h.tool, { loop_id: "loop1234" });
	assert.equal(result.isError, true);
	assert.deepEqual(h.completed, []);
});

test("an already-stopped loop is not completed twice", async () => {
	const h = harness({ ...STANDALONE, status: "stopped" });
	const result = await run(h.tool, { loop_id: "loop1234" });
	assert.equal(result.isError, true);
	assert.deepEqual(h.completed, []);
	assert.match(result.content[0]?.text ?? "", /already stopped/);
});

test("a guideline points at the loop-craft doc by absolute path", () => {
	// The refusal rules are mechanical and live in the tool; what counts as a
	// citation is judgment, loaded on demand from the shipped doc. The tool
	// itself is staged — absent from a session that never runs a loop — so this
	// guidance costs nothing until there is a loop to complete. The path is
	// absolute and real so the model can `read` it from any cwd, and so a
	// renamed or unshipped doc fails here rather than in a live loop.
	const h = harness(STANDALONE);
	const guidelines = (h.tool as unknown as { promptGuidelines: string[] }).promptGuidelines;
	assert.ok(isAbsolute(LOOP_CRAFT_DOC));
	assert.ok(existsSync(LOOP_CRAFT_DOC), `${LOOP_CRAFT_DOC} is not shipped`);
	assert.ok(guidelines.some((line) => line.includes(`read ${LOOP_CRAFT_DOC}`)));
});
