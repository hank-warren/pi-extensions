import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyCommand, untrustedMatches } from "../classify.ts";
import type { AutoPermissionsConfig } from "../config.ts";
import type { Gate, GateLevel } from "../gates.ts";

function gate(level: GateLevel, group: string, label: string, pattern = "danger"): Gate {
	return {
		pattern: new RegExp(pattern, "i"),
		level,
		group,
		label,
		message: level === "guarded" ? undefined : `${label} message`,
	};
}

function config(rules: Gate[], reviewAllShell = false): AutoPermissionsConfig {
	return { rules, reviewAllShell } as AutoPermissionsConfig;
}

const NOTHING = new Set<string>();

describe("classifyCommand", () => {
	test("passes a command no rule matches", () => {
		assert.deepEqual(
			classifyCommand("echo hello", config([gate("deny", "fs", "Root delete")]), NOTHING, NOTHING),
			{ kind: "pass" },
		);
	});

	test("takes the most severe level, not the first match in config order", () => {
		const rules = [
			gate("guarded", "first", "Guarded first"),
			gate("convention", "second", "Convention second"),
			gate("deny", "third", "Deny last"),
		];
		const classified = classifyCommand("echo danger", config(rules), NOTHING, NOTHING);
		assert.equal(classified.kind, "deny");
		assert.equal(classified.kind === "deny" && classified.gate.label, "Deny last");
	});

	test("prefers convention over guarded when no deny rule matches", () => {
		const rules = [gate("guarded", "first", "Guarded first"), gate("convention", "second", "Convention second")];
		const classified = classifyCommand("echo danger", config(rules), NOTHING, NOTHING);
		assert.equal(classified.kind, "convention");
		assert.equal(classified.kind === "convention" && classified.gate.label, "Convention second");
	});

	test("a granted convention override falls through to the guarded match", () => {
		const rules = [gate("convention", "npm", "Package install"), gate("guarded", "net", "Network")];
		const allowed = new Set(["echo danger"]);
		const classified = classifyCommand("echo danger", config(rules), NOTHING, allowed);
		assert.equal(classified.kind, "review");
		assert.equal(classified.kind === "review" && classified.gate.label, "Network");
	});

	test("a trusted group lifts a guarded rule but never a deny rule", () => {
		const trusted = new Set(["git"]);
		assert.deepEqual(
			classifyCommand("echo danger", config([gate("guarded", "git", "Git push")]), trusted, NOTHING),
			{ kind: "pass" },
		);
		const denied = classifyCommand("echo danger", config([gate("deny", "git", "Git push")]), trusted, NOTHING);
		assert.equal(denied.kind, "deny");
	});

	test("reviewAllShell captures a command no rule names", () => {
		const classified = classifyCommand("echo hello", config([gate("guarded", "git", "Git push")], true), NOTHING, NOTHING);
		assert.equal(classified.kind, "review");
		assert.equal(classified.kind === "review" && classified.gate.group, "all-shell");
		assert.equal(classified.kind === "review" && classified.gate.label, "shell command");
	});

	test("reviewAllShell does not re-capture a command whose matching group the project trusts", () => {
		const rules = [gate("guarded", "git", "Git push")];
		assert.deepEqual(
			classifyCommand("echo danger", config(rules, true), new Set(["git"]), NOTHING),
			{ kind: "pass" },
			"a trusted match was waved through explicitly, not left unnamed",
		);
	});

	test("trusting the all-shell group itself opts out of blanket review", () => {
		assert.deepEqual(
			classifyCommand("echo hello", config([], true), new Set(["all-shell"]), NOTHING),
			{ kind: "pass" },
		);
	});
});

describe("untrustedMatches", () => {
	test("drops trusted guarded and convention matches, keeps deny", () => {
		const rules = [
			gate("guarded", "git", "Git push"),
			gate("convention", "npm", "Package install"),
			gate("deny", "npm", "Never"),
		];
		assert.deepEqual(
			untrustedMatches("echo danger", config(rules), new Set(["git", "npm"])).map((match) => match.label),
			["Never"],
		);
	});
});
