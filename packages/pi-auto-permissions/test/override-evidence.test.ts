import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	mergeOverrideEvidence,
	overrideEvidenceRecord,
	OVERRIDE_ANCHOR_START,
	type PermissionOverride,
} from "../override-evidence.ts";
import type { ReviewEvidenceRecord } from "../review.ts";

function record(key: string, source: ReviewEvidenceRecord["source"] = "tool", text = `text-${key}`): ReviewEvidenceRecord {
	return { key, source, text };
}

function override(seq: number, extra: Partial<PermissionOverride> = {}): PermissionOverride {
	return {
		seq,
		gateLabel: "SSH command",
		command: "ssh host 'echo hi'",
		reviewerReason: "embeds a sensitive key",
		choice: "allow_unnecessary",
		...extra,
	};
}

describe("override evidence records", () => {
	test("are user-source with an override key and quote command and concern as data", () => {
		const result = overrideEvidenceRecord(override(3));
		assert.equal(result.key, "override:3");
		assert.equal(result.source, "user");
		assert.ok(result.text.startsWith("USER (permission override): allowed gated command"));
		assert.ok(result.text.includes(JSON.stringify("ssh host 'echo hi'")));
		assert.ok(result.text.includes(JSON.stringify("embeds a sensitive key")));
	});

	test("wording scope depends on the choice", () => {
		assert.ok(overrideEvidenceRecord(override(0, { choice: "allow_unnecessary" })).text.includes("Treat comparable actions in this session as authorized"));
		assert.ok(overrideEvidenceRecord(override(0, { choice: "allow_appropriate" })).text.includes("authorizes exactly that action, not comparable ones"));
		assert.ok(overrideEvidenceRecord(override(0, { choice: "allow" })).text.includes("that exact action and closely similar retries"));
		const blocked = overrideEvidenceRecord(override(0, { choice: "block" })).text;
		assert.ok(blocked.startsWith("USER (permission override): blocked gated command"));
		assert.ok(blocked.includes("standing user constraint"));
	});

	test("later-user-statement precedence clause is present on generalizing records", () => {
		assert.ok(overrideEvidenceRecord(override(0, { choice: "allow_unnecessary" })).text.includes("unless a later user statement contradicts"));
		assert.ok(overrideEvidenceRecord(override(0, { choice: "block" })).text.includes("unless a later user statement contradicts"));
	});

	test("renders standing approvals with a distinct prefix and global comparable scope", () => {
		const result = overrideEvidenceRecord(override(9, {
			standing: {
				grantedAt: "2026-08-20T12:00:00.000Z",
				project: "/work/acme",
				gateGroup: "ssh",
			},
		}));
		assert.ok(result.text.startsWith('USER (standing permission override, granted 2026-08-20 in "/work/acme"):'));
		assert.match(result.text, /comparable actions in any project/);
		assert.match(result.text, /materially higher risk class/);
	});

	test("very long commands are truncated in the override text", () => {
		const long = "x".repeat(5000);
		const text = overrideEvidenceRecord(override(0, { command: long, reviewerReason: long })).text;
		assert.ok(text.length < 1500);
		assert.equal(text.match(/…\[truncated 4700 chars\]…/g)?.length, 2);
	});
});

describe("merge override evidence", () => {
	test("returns a copy when no overrides exist", () => {
		const records = [record("a"), record("b")];
		const merged = mergeOverrideEvidence(records, []);
		assert.notEqual(merged, records);
		assert.deepEqual(merged.map((r) => r.key), ["a", "b"]);
	});

	test("inserts overrides after their anchor record", () => {
		const merged = mergeOverrideEvidence(
			[record("a"), record("b"), record("c")],
			[override(0, { anchorKey: "b" })],
		);
		assert.deepEqual(merged.map((r) => r.key), ["a", "b", "override:0", "c"]);
	});

	test("locks unanchored overrides to the end and keeps the position stable as records grow", () => {
		const first = override(0);
		assert.equal(first.anchorKey, undefined);
		const merged1 = mergeOverrideEvidence([record("a"), record("b")], [first]);
		assert.deepEqual(merged1.map((r) => r.key), ["a", "b", "override:0"]);
		assert.equal(first.anchorKey, "b");

		// Prefix property: merging again with appended records must extend, not reorder.
		const merged2 = mergeOverrideEvidence([record("a"), record("b"), record("c"), record("d")], [first]);
		assert.deepEqual(merged2.map((r) => r.key), ["a", "b", "override:0", "c", "d"]);
		assert.deepEqual(merged2.slice(0, merged1.length).map((r) => r.key), merged1.map((r) => r.key));
	});

	test("supports overrides anchored to earlier overrides (chained lock)", () => {
		const first = override(0);
		const second = override(1);
		const merged1 = mergeOverrideEvidence([record("a")], [first]);
		assert.deepEqual(merged1.map((r) => r.key), ["a", "override:0"]);
		// Second override arrives with no new session records: locks after override:0.
		const merged2 = mergeOverrideEvidence([record("a")], [first, second]);
		assert.deepEqual(merged2.map((r) => r.key), ["a", "override:0", "override:1"]);
		assert.equal(second.anchorKey, "override:0");
		// Growth keeps both stable.
		const merged3 = mergeOverrideEvidence([record("a"), record("b")], [first, second]);
		assert.deepEqual(merged3.map((r) => r.key), ["a", "override:0", "override:1", "b"]);
	});

	test("multiple overrides on one anchor keep seq order", () => {
		const merged = mergeOverrideEvidence(
			[record("a")],
			[override(2, { anchorKey: "a" }), override(1, { anchorKey: "a" })],
		);
		assert.deepEqual(merged.map((r) => r.key), ["a", "override:1", "override:2"]);
	});

	test("empty record list locks the first override to the start anchor", () => {
		const first = override(0);
		const merged = mergeOverrideEvidence([], [first]);
		assert.deepEqual(merged.map((r) => r.key), ["override:0"]);
		assert.equal(first.anchorKey, OVERRIDE_ANCHOR_START);
		const merged2 = mergeOverrideEvidence([record("a")], [first]);
		assert.deepEqual(merged2.map((r) => r.key), ["override:0", "a"]);
	});

	test("missing anchor re-locks at the end instead of dropping the override", () => {
		const orphan = override(0, { anchorKey: "gone" });
		const merged = mergeOverrideEvidence([record("a")], [orphan]);
		assert.deepEqual(merged.map((r) => r.key), ["a", "override:0"]);
		assert.equal(orphan.anchorKey, "a");
	});
});
