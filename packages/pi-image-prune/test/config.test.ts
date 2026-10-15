import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, matchRule, parseConfig } from "../config.ts";

test("parses a rule and defaults trimToBytes to 70%", () => {
	const config = parseConfig({ rules: [{ models: ["cpa/devin/*"], maxRequestBytes: 10_000_000 }] });
	assert.deepEqual(config.rules, [{ models: ["cpa/devin/*"], maxRequestBytes: 10_000_000, trimToBytes: 7_000_000 }]);
});

test("rejects unknown fields, bad numbers, and a target at or above the limit", () => {
	assert.throws(() => parseConfig({ rule: [] }), /unknown field/);
	assert.throws(() => parseConfig({ rules: [{ models: ["a/*"], maxRequestBytes: 10, maxBytes: 1 }] }), /unknown field/);
	assert.throws(() => parseConfig({ rules: [{ models: [], maxRequestBytes: 10 }] }), /models/);
	assert.throws(() => parseConfig({ rules: [{ models: ["a/*"], maxRequestBytes: -1 }] }), /positive integer/);
	assert.throws(() => parseConfig({ rules: [{ models: ["a/*"], maxRequestBytes: 10, trimToBytes: 10 }] }), /below/);
});

test("globs match provider/id with slashes inside the id, first rule wins", () => {
	const { rules } = parseConfig({
		rules: [
			{ models: ["cpa/devin/*", "cpa/claude-opus-5-5"], maxRequestBytes: 9_500_000 },
			{ models: ["cpa/*"], maxRequestBytes: 30_000_000 },
		],
	});
	assert.equal(matchRule(rules, "cpa", "devin/glm-5-3")?.maxRequestBytes, 9_500_000);
	assert.equal(matchRule(rules, "cpa", "claude-opus-5-5")?.maxRequestBytes, 9_500_000);
	assert.equal(matchRule(rules, "cpa", "claude-opus-5-5-x")?.maxRequestBytes, 30_000_000);
	assert.equal(matchRule(rules, "anthropic", "claude-opus-5-5"), undefined);
});

test("a missing file is empty and a malformed one reports its problem", () => {
	const dir = mkdtempSync(join(tmpdir(), "image-prune-"));
	assert.deepEqual(loadConfig(join(dir, "absent.json")), { rules: [] });
	const bad = join(dir, "bad.json");
	writeFileSync(bad, "{ not json");
	const config = loadConfig(bad);
	assert.deepEqual(config.rules, []);
	assert.match(config.problem ?? "", /bad\.json/);
});
