// Converted from the vendored package's bun:test suite (config.test.ts) to
// node:test so the repo test suite needs no bun toolchain.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expandRules, loadAutoPermissionsConfig } from "../config.ts";
import { DEFAULT_RULES } from "../default-rules.ts";
import type { Gate } from "../gates.ts";

const PRUNING_DEFAULTS = {
	toolRecordMaxChars: 500,
	assistantRecordMaxChars: 1000,
	compactionRecordMaxChars: 4000,
	fullRebuildKeepToolRecords: 60,
} as const;

const tempDirs: string[] = [];

function configFile(value: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-auto-permissions-"));
	tempDirs.push(dir);
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify(value), "utf8");
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("auto permissions config", () => {
	test("uses the built-in ruleset when the config is missing", () => {
		const config = loadAutoPermissionsConfig(join(tmpdir(), "missing-auto-permissions-config.json"));
		assert.equal(config.enabled, true);
		assert.equal(config.reviewer, undefined);
		assert.deepEqual(config.rules, [...DEFAULT_RULES]);
		assert.ok(config.rules.length > 0, "a fresh install ships a live default policy");
		assert.deepEqual(config.reviewEvidence, {
			projectInstructions: false,
			userAnswerTools: [],
			userMessageTypes: ["loop-objective"],
			...PRUNING_DEFAULTS,
		});
		assert.deepEqual(config.evaluationLog, {
			enabled: false,
			path: join(tmpdir(), "review-evals.jsonl"),
		});
		assert.deepEqual(config.usageLog, {
			enabled: true,
			path: join(tmpdir(), "usage.jsonl"),
		});
		assert.deepEqual(config.standingApprovals, {
			enabled: true,
			path: join(tmpdir(), "standing-approvals.jsonl"),
		});
		assert.deepEqual(config.ui, { enabled: true, resultDisplayMs: 2500, placement: "widget" });
	});

	test("keeps the usage sidecar on by default and allows opting out or relocating it", () => {
		const defaults = configFile({});
		assert.deepEqual(loadAutoPermissionsConfig(defaults).usageLog, {
			enabled: true,
			path: join(dirname(defaults), "usage.jsonl"),
		});

		const disabled = configFile({ usageLog: { enabled: false } });
		assert.deepEqual(loadAutoPermissionsConfig(disabled).usageLog, {
			enabled: false,
			path: join(dirname(disabled), "usage.jsonl"),
		});

		const relocated = configFile({ usageLog: { path: "logs/guardian-usage.jsonl" } });
		assert.deepEqual(loadAutoPermissionsConfig(relocated).usageLog, {
			enabled: true,
			path: join(dirname(relocated), "logs", "guardian-usage.jsonl"),
		});
	});

	test("keeps the denial log on by default and allows opting out or relocating it", () => {
		const defaults = configFile({});
		assert.deepEqual(loadAutoPermissionsConfig(defaults).denialLog, {
			enabled: true,
			path: join(dirname(defaults), "denials.jsonl"),
		});

		const disabled = configFile({ denialLog: { enabled: false } });
		assert.equal(loadAutoPermissionsConfig(disabled).denialLog.enabled, false);

		const relocated = configFile({ denialLog: { path: "logs/denials.jsonl" } });
		assert.deepEqual(loadAutoPermissionsConfig(relocated).denialLog, {
			enabled: true,
			path: join(dirname(relocated), "logs", "denials.jsonl"),
		});
	});

	test("keeps standing approvals on by default and allows opting out or relocating them", () => {
		const defaults = configFile({});
		assert.deepEqual(loadAutoPermissionsConfig(defaults).standingApprovals, {
			enabled: true,
			path: join(dirname(defaults), "standing-approvals.jsonl"),
		});

		const disabled = configFile({ standingApprovals: { enabled: false } });
		assert.equal(loadAutoPermissionsConfig(disabled).standingApprovals.enabled, false);

		const relocated = configFile({ standingApprovals: { path: "logs/standing.jsonl" } });
		assert.deepEqual(loadAutoPermissionsConfig(relocated).standingApprovals, {
			enabled: true,
			path: join(dirname(relocated), "logs", "standing.jsonl"),
		});
	});

	test("rejects malformed standing approvals configuration", () => {
		for (const standingApprovals of [true, [], { enabled: "yes" }, { path: "" }]) {
			const path = configFile({ standingApprovals });
			assert.throws(() => loadAutoPermissionsConfig(path), /standingApprovals/);
		}
	});

	test("rejects malformed denial log configuration", () => {
		for (const denialLog of [true, [], { enabled: "yes" }, { path: "" }]) {
			const path = configFile({ denialLog });
			assert.throws(() => loadAutoPermissionsConfig(path), /denialLog/);
		}
	});

	test("rejects malformed usage sidecar configuration", () => {
		for (const usageLog of [true, [], { enabled: "yes" }, { path: "" }]) {
			const path = configFile({ usageLog });
			assert.throws(() => loadAutoPermissionsConfig(path), /usageLog/);
		}
	});

	test("selects a reviewer and loads rules", () => {
		const path = configFile({
			reviewer: {
				provider: "openai-codex",
				model: "gpt-5.4",
				reasoningEffort: "medium",
				timeoutMs: 12_000,
			},
			systemPrompt: "custom permission policy",
			reviewEvidence: { projectInstructions: true },
			ui: { enabled: true, resultDisplayMs: 5000, placement: "toolRow" },
			rules: [
				{
					pattern: "\\brm\\s+-rf\\b",
					level: "guarded",
					group: "filesystem",
					label: "Recursive delete",
				},
			],
		});

		const config = loadAutoPermissionsConfig(path);
		assert.deepEqual(config.reviewer, {
			provider: "openai-codex",
			model: "gpt-5.4",
			reasoningEffort: "medium",
			timeoutMs: 12_000,
			prefilter: false,
		});
		assert.equal(config.systemPrompt, "custom permission policy");
		assert.deepEqual(config.reviewEvidence, {
			projectInstructions: true,
			userAnswerTools: [],
			userMessageTypes: ["loop-objective"],
			...PRUNING_DEFAULTS,
		});
		assert.deepEqual(config.ui, { enabled: true, resultDisplayMs: 5000, placement: "toolRow" });
		assert.equal(config.rules.length, 1);
		assert.equal(config.rules[0].pattern.test("rm -rf build"), true);
	});

	test("accepts, trims, and deduplicates user answer tools", () => {
		const path = configFile({
			reviewEvidence: { userAnswerTools: [" ask_user_question ", "plan_review", "ask_user_question"] },
		});
		assert.deepEqual(loadAutoPermissionsConfig(path).reviewEvidence, {
			projectInstructions: false,
			userAnswerTools: ["ask_user_question", "plan_review"],
			userMessageTypes: ["loop-objective"],
			...PRUNING_DEFAULTS,
		});
	});

	test("trusts the loop objective by default, and lets an explicit list replace it", () => {
		// The default has to survive a reviewEvidence block that says nothing
		// about it: every existing config on disk is exactly that block.
		const inherited = configFile({ reviewEvidence: { projectInstructions: true } });
		assert.deepEqual(
			loadAutoPermissionsConfig(inherited).reviewEvidence.userMessageTypes,
			["loop-objective"],
		);

		const path = configFile({
			reviewEvidence: { userMessageTypes: [" loop-objective ", "plan-approved", "loop-objective"] },
		});
		assert.deepEqual(
			loadAutoPermissionsConfig(path).reviewEvidence.userMessageTypes,
			["loop-objective", "plan-approved"],
		);

		// An explicit empty list is opting out, not "unset" — a user who does not
		// want the objective in the envelope has no other way to say so.
		const none = configFile({ reviewEvidence: { userMessageTypes: [] } });
		assert.deepEqual(loadAutoPermissionsConfig(none).reviewEvidence.userMessageTypes, []);
	});

	test("rejects malformed user message types", () => {
		for (const userMessageTypes of ["loop-objective", [42], [""], ["  "], {}]) {
			const path = configFile({ reviewEvidence: { userMessageTypes } });
			assert.throws(
				() => loadAutoPermissionsConfig(path),
				(error: unknown) => error instanceof Error
					&& error.message.includes("reviewEvidence.userMessageTypes must be an array of non-empty strings"),
			);
		}
	});

	test("accepts custom evidence pruning knobs, including 0 to disable", () => {
		const path = configFile({
			reviewEvidence: { toolRecordMaxChars: 0, assistantRecordMaxChars: 2500, compactionRecordMaxChars: 8000, fullRebuildKeepToolRecords: 100 },
		});
		const evidence = loadAutoPermissionsConfig(path).reviewEvidence;
		assert.equal(evidence.toolRecordMaxChars, 0);
		assert.equal(evidence.assistantRecordMaxChars, 2500);
		assert.equal(evidence.compactionRecordMaxChars, 8000);
		assert.equal(evidence.fullRebuildKeepToolRecords, 100);
	});

	test("rejects malformed evidence pruning knobs", () => {
		for (const bad of [-1, 1.5, "500", true, 1_000_001]) {
			const path = configFile({ reviewEvidence: { toolRecordMaxChars: bad } });
			assert.throws(
				() => loadAutoPermissionsConfig(path),
				(error: unknown) => error instanceof Error
					&& error.message.includes("reviewEvidence.toolRecordMaxChars must be an integer between 0 and 1000000"),
			);
		}
	});

	test("rejects malformed user answer tools", () => {
		for (const userAnswerTools of ["ask_user_question", [42], [""], ["  "], {}]) {
			const path = configFile({ reviewEvidence: { userAnswerTools } });
			assert.throws(
				() => loadAutoPermissionsConfig(path),
				(error: unknown) => error instanceof Error
					&& error.message.includes("reviewEvidence.userAnswerTools must be an array of non-empty strings"),
			);
		}
	});

	test("resolves an enabled evaluation log relative to the config", () => {
		const path = configFile({ evaluationLog: { enabled: true, path: "logs/reviews.jsonl" } });
		assert.deepEqual(loadAutoPermissionsConfig(path).evaluationLog, {
			enabled: true,
			path: join(path, "..", "logs/reviews.jsonl"),
		});
	});

	test("uses a private adjacent evaluation log path by default", () => {
		const path = configFile({ evaluationLog: { enabled: true } });
		assert.deepEqual(loadAutoPermissionsConfig(path).evaluationLog, {
			enabled: true,
			path: join(path, "..", "review-evals.jsonl"),
		});
	});

	test("rejects malformed evaluation log configuration", () => {
		for (const evaluationLog of [true, [], { enabled: "yes" }, { path: "" }]) {
			const path = configFile({ evaluationLog });
			assert.throws(() => loadAutoPermissionsConfig(path));
		}
	});

	test("reviewAllShell defaults off, accepts true, and rejects non-booleans", () => {
		assert.equal(loadAutoPermissionsConfig(configFile({})).reviewAllShell, false);
		assert.equal(loadAutoPermissionsConfig(configFile({ reviewAllShell: true })).reviewAllShell, true);
		assert.equal(loadAutoPermissionsConfig(configFile({ reviewAllShell: false })).reviewAllShell, false);
		for (const reviewAllShell of ["yes", 1, [], {}]) {
			assert.throws(
				() => loadAutoPermissionsConfig(configFile({ reviewAllShell })),
				/reviewAllShell must be boolean/,
			);
		}
	});

	test("reviewer.prefilter defaults off, accepts true, and rejects non-booleans", () => {
		const reviewer = { provider: "p", model: "m" };
		assert.equal(loadAutoPermissionsConfig(configFile({ reviewer })).reviewer?.prefilter, false);
		assert.equal(
			loadAutoPermissionsConfig(configFile({ reviewer: { ...reviewer, prefilter: true } })).reviewer?.prefilter,
			true,
		);
		for (const prefilter of ["yes", 1, [], {}]) {
			assert.throws(
				() => loadAutoPermissionsConfig(configFile({ reviewer: { ...reviewer, prefilter } })),
				/reviewer\.prefilter must be boolean/,
			);
		}
	});

	test("guardianPolicy defaults to empty lists and accepts partial prose lists", () => {
		assert.deepEqual(loadAutoPermissionsConfig(configFile({})).guardianPolicy, {
			environment: [],
			allow: [],
			softDeny: [],
			hardDeny: [],
		});

		// Each list is independent: setting one leaves the others empty.
		const partial = loadAutoPermissionsConfig(configFile({
			guardianPolicy: {
				environment: [" Our GitHub orgs acme-corp and example-labs are trusted source control ", "Our GitHub orgs acme-corp and example-labs are trusted source control"],
			},
		}));
		assert.deepEqual(partial.guardianPolicy, {
			environment: ["Our GitHub orgs acme-corp and example-labs are trusted source control"],
			allow: [],
			softDeny: [],
			hardDeny: [],
		});

		const full = loadAutoPermissionsConfig(configFile({
			guardianPolicy: {
				environment: ["env entry"],
				allow: ["allow entry"],
				softDeny: ["soft entry"],
				hardDeny: ["hard entry"],
			},
		}));
		assert.deepEqual(full.guardianPolicy, {
			environment: ["env entry"],
			allow: ["allow entry"],
			softDeny: ["soft entry"],
			hardDeny: ["hard entry"],
		});
	});

	test("rejects malformed guardianPolicy shapes", () => {
		for (const guardianPolicy of [true, [], "prose"]) {
			assert.throws(
				() => loadAutoPermissionsConfig(configFile({ guardianPolicy })),
				/guardianPolicy must be an object/,
			);
		}
		assert.throws(
			() => loadAutoPermissionsConfig(configFile({ guardianPolicy: { hard_deny: ["x"] } })),
			/guardianPolicy\.hard_deny is not a recognized list/,
		);
		for (const bad of ["prose", [42], [""], ["  "], {}]) {
			assert.throws(
				() => loadAutoPermissionsConfig(configFile({ guardianPolicy: { softDeny: bad } })),
				/guardianPolicy\.softDeny must be an array of non-empty strings/,
			);
		}
	});

	test("compiles deny rules and requires their message", () => {
		const path = configFile({
			rules: [
				{
					pattern: "--dangerously-skip-permissions",
					level: "deny",
					group: "oversight",
					label: "Oversight bypass",
					message: "Never launch an agent with approvals disabled.",
				},
			],
		});
		const config = loadAutoPermissionsConfig(path);
		assert.equal(config.rules.length, 1);
		assert.equal(config.rules[0].level, "deny");
		assert.equal(config.rules[0].pattern.test("pi --dangerously-skip-permissions"), true);

		const missingMessage = configFile({
			rules: [{ pattern: "x", level: "deny", group: "g", label: "L" }],
		});
		assert.throws(
			() => loadAutoPermissionsConfig(missingMessage),
			/rules\[0\]\.message is required for deny rules/,
		);
	});

	test("rejects an unknown rule level", () => {
		const path = configFile({ rules: [{ pattern: "x", level: "hard", group: "g", label: "L" }] });
		assert.throws(
			() => loadAutoPermissionsConfig(path),
			/rules\[0\]\.level must be guarded, convention, or deny/,
		);
	});

	test("activates the built-in ruleset when the rules key is absent", () => {
		const config = loadAutoPermissionsConfig(configFile({}));
		assert.deepEqual(config.rules, [...DEFAULT_RULES]);
	});

	test("an explicit rules array is a full replacement, and [] gates nothing", () => {
		const replaced = loadAutoPermissionsConfig(configFile({
			rules: [{ pattern: "\\bgit\\s+push\\b", group: "git", label: "Push" }],
		}));
		assert.deepEqual(replaced.rules.map((rule) => rule.label), ["Push"]);

		const none = loadAutoPermissionsConfig(configFile({ rules: [] }));
		assert.deepEqual(none.rules, []);
	});

	test('splices the built-in ruleset in place of "$defaults"', () => {
		const defaults: Gate[] = [
			{ pattern: /a/i, level: "guarded", group: "g", label: "Default A", message: undefined },
			{ pattern: /b/i, level: "deny", group: "g", label: "Default B", message: "no" },
		];
		const rules = expandRules(
			[
				{ pattern: "before", group: "custom", label: "Before" },
				"$defaults",
				{ pattern: "after", group: "custom", label: "After" },
			],
			defaults,
		);
		assert.deepEqual(
			rules.map((rule) => rule.label),
			["Before", "Default A", "Default B", "After"],
		);
		// Spliced entries are the default Gate objects themselves, not recompiles.
		assert.equal(rules[1], defaults[0]);

		assert.throws(
			() => expandRules(["$defaults", "$defaults"], defaults),
			/rules may contain "\$defaults" at most once/,
		);
	});

	test('loads "$defaults" from a config file without recompiling it', () => {
		const path = configFile({
			rules: ["$defaults", { pattern: "custom", group: "custom", label: "Custom" }],
		});
		const config = loadAutoPermissionsConfig(path);
		assert.deepEqual(
			config.rules.map((rule) => rule.label),
			[...DEFAULT_RULES.map((rule) => rule.label), "Custom"],
		);
	});

	test("loads a prompt file relative to the config", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-auto-permissions-"));
		tempDirs.push(dir);
		writeFileSync(join(dir, "prompt.md"), "review carefully\n", "utf8");
		const path = join(dir, "config.json");
		writeFileSync(path, JSON.stringify({ systemPromptFile: "./prompt.md" }), "utf8");

		assert.equal(loadAutoPermissionsConfig(path).systemPrompt, "review carefully");
	});
});
