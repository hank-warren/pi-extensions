// Converted from the vendored package's bun:test suite (config.test.ts) to
// node:test so the repo test suite needs no bun toolchain.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expandRules, loadAutoPermissionsConfig } from "../config.ts";
import { DEFAULT_RULES } from "../default-rules.ts";
import type { Gate } from "../gates.ts";
import { scratchDir } from "./support/temp-dir.ts";

function configFile(value: unknown): string {
	const dir = scratchDir("pi-auto-permissions-");
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify(value), "utf8");
	return path;
}

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
			userMessageTypes: [],
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
		assert.deepEqual(config.ui, { enabled: true, resultDisplayMs: 2500 });
	});

	for (const [key, file, defaultEnabled] of [
		["usageLog", "usage.jsonl", true],
		["denialLog", "denials.jsonl", true],
		["evaluationLog", "review-evals.jsonl", false],
	] as const) {
		test(`resolves the ${key} sidecar block`, () => {
			const load = (value: unknown) => loadAutoPermissionsConfig(configFile(value))[key];
			const defaults = configFile({});
			assert.deepEqual(loadAutoPermissionsConfig(defaults)[key], {
				enabled: defaultEnabled,
				path: join(dirname(defaults), file),
			});

			const flipped = configFile({ [key]: { enabled: !defaultEnabled } });
			assert.deepEqual(loadAutoPermissionsConfig(flipped)[key], {
				enabled: !defaultEnabled,
				path: join(dirname(flipped), file),
			});

			const relocated = configFile({ [key]: { path: "logs/x.jsonl" } });
			assert.deepEqual(loadAutoPermissionsConfig(relocated)[key], {
				enabled: defaultEnabled,
				path: join(dirname(relocated), "logs", "x.jsonl"),
			});

			assert.deepEqual(load({ [key]: { path: "~/x.jsonl" } }), {
				enabled: defaultEnabled,
				path: join(homedir(), "x.jsonl"),
			});
			assert.deepEqual(load({ [key]: { path: "/abs/x.jsonl" } }), {
				enabled: defaultEnabled,
				path: "/abs/x.jsonl",
			});

			for (const bad of [true, [], null, { enabled: "yes" }, { enabled: null }, { path: "" }]) {
				assert.throws(() => load({ [key]: bad }), new RegExp(key));
			}
		});
	}

	test("a null config block is rejected, never treated as absent", () => {
		for (const key of ["reviewer", "ui", "reviewEvidence", "guardianPolicy"]) {
			const path = configFile({ [key]: null });
			assert.throws(() => loadAutoPermissionsConfig(path), new RegExp(`^Error: ${key} must be an object$`));
		}
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
			ui: { enabled: true, resultDisplayMs: 5000 },
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
		});
		assert.equal(config.systemPrompt, "custom permission policy");
		assert.deepEqual(config.reviewEvidence, {
			projectInstructions: true,
			userAnswerTools: [],
			userMessageTypes: [],
		});
		assert.deepEqual(config.ui, { enabled: true, resultDisplayMs: 5000 });
		assert.equal(config.rules.length, 1);
		assert.equal(config.rules[0].pattern.test("rm -rf build"), true);
	});

	test("ignores a legacy ui.placement of any value", () => {
		for (const placement of ["toolRow", "bogus", 42]) {
			const config = loadAutoPermissionsConfig(configFile({ ui: { placement } }));
			assert.deepEqual(config.ui, { enabled: true, resultDisplayMs: 2500 });
		}
	});

	test("accepts, trims, and deduplicates user answer tools", () => {
		const path = configFile({
			reviewEvidence: { userAnswerTools: [" ask_user_question ", "plan_review", "ask_user_question"] },
		});
		assert.deepEqual(loadAutoPermissionsConfig(path).reviewEvidence, {
			projectInstructions: false,
			userAnswerTools: ["ask_user_question", "plan_review"],
			userMessageTypes: [],
		});
	});

	test("trusts no injected message type by default, and accepts an explicit list", () => {
		const inherited = configFile({ reviewEvidence: { projectInstructions: true } });
		assert.deepEqual(loadAutoPermissionsConfig(inherited).reviewEvidence.userMessageTypes, []);

		const path = configFile({
			reviewEvidence: { userMessageTypes: [" task-objective ", "plan-approved", "task-objective"] },
		});
		assert.deepEqual(
			loadAutoPermissionsConfig(path).reviewEvidence.userMessageTypes,
			["task-objective", "plan-approved"],
		);
	});

	test("rejects malformed user message types", () => {
		for (const userMessageTypes of ["task-objective", [42], [""], ["  "], {}]) {
			const path = configFile({ reviewEvidence: { userMessageTypes } });
			assert.throws(
				() => loadAutoPermissionsConfig(path),
				(error: unknown) => error instanceof Error
					&& error.message.includes("reviewEvidence.userMessageTypes must be an array of non-empty strings"),
			);
		}
	});

	test("legacy pruning knobs in reviewEvidence are ignored, even malformed", () => {
		const path = configFile({
			reviewEvidence: {
				toolRecordMaxChars: 10,
				assistantRecordMaxChars: -1,
				compactionRecordMaxChars: "500",
				fullRebuildKeepToolRecords: "x",
			},
		});
		assert.deepEqual(loadAutoPermissionsConfig(path).reviewEvidence, {
			projectInstructions: false,
			userAnswerTools: [],
			userMessageTypes: [],
		});
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

	test("reviewer.prefilter is ignored, including non-booleans", () => {
		const reviewer = { provider: "p", model: "m" };
		for (const prefilter of [true, "yes", 1, []]) {
			const config = loadAutoPermissionsConfig(configFile({ reviewer: { ...reviewer, prefilter } }));
			assert.ok(config.reviewer);
			assert.equal(Object.hasOwn(config.reviewer, "prefilter"), false);
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
			/rules\[0\]\.level must be guarded or deny/,
		);
	});

	test("loads a legacy convention rule as a deny rule, still requiring its message", () => {
		const path = configFile({ rules: [{ pattern: "x", level: "convention", group: "g", label: "L", message: "m" }] });
		const config = loadAutoPermissionsConfig(path);
		assert.equal(config.rules[0].level, "deny");
		assert.equal(config.rules[0].message, "m");

		const missingMessage = configFile({ rules: [{ pattern: "x", level: "convention", group: "g", label: "L" }] });
		assert.throws(() => loadAutoPermissionsConfig(missingMessage), /message is required/);
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
		const dir = scratchDir("pi-auto-permissions-");
		writeFileSync(join(dir, "prompt.md"), "review carefully\n", "utf8");
		const path = join(dir, "config.json");
		writeFileSync(path, JSON.stringify({ systemPromptFile: "./prompt.md" }), "utf8");

		assert.equal(loadAutoPermissionsConfig(path).systemPrompt, "review carefully");
	});
});
