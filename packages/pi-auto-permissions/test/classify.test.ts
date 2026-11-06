import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyCommand } from "../classify.ts";
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
			classifyCommand("echo hello", config([gate("deny", "fs", "Root delete")]), NOTHING),
			{ kind: "pass" },
		);
	});

	test("takes the most severe level, not the first match in config order", () => {
		const rules = [
			gate("guarded", "first", "Guarded first"),
			gate("deny", "third", "Deny last"),
		];
		const classified = classifyCommand("echo danger", config(rules), NOTHING);
		assert.equal(classified.kind, "deny");
		assert.equal(classified.kind === "deny" && classified.gate.label, "Deny last");
	});

	test("a trusted group lifts a guarded rule but never a deny rule", () => {
		const trusted = new Set(["git"]);
		assert.deepEqual(
			classifyCommand("echo danger", config([gate("guarded", "git", "Git push")]), trusted),
			{ kind: "pass" },
		);
		const denied = classifyCommand("echo danger", config([gate("deny", "git", "Git push")]), trusted);
		assert.equal(denied.kind, "deny");
	});

	test("reviewAllShell captures a command no rule names", () => {
		const classified = classifyCommand("echo hello", config([gate("guarded", "git", "Git push")], true), NOTHING);
		assert.equal(classified.kind, "review");
		assert.equal(classified.kind === "review" && classified.gate.group, "all-shell");
		assert.equal(classified.kind === "review" && classified.gate.label, "shell command");
	});

	test("reviewAllShell does not re-capture a command whose matching group the project trusts", () => {
		const rules = [gate("guarded", "git", "Git push")];
		assert.deepEqual(
			classifyCommand("echo danger", config(rules, true), new Set(["git"])),
			{ kind: "pass" },
			"a trusted match was waved through explicitly, not left unnamed",
		);
	});

	test("trusting the all-shell group itself opts out of blanket review", () => {
		assert.deepEqual(
			classifyCommand("echo hello", config([], true), new Set(["all-shell"])),
			{ kind: "pass" },
		);
	});
});
