import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAutoPermissionsConfig } from "../config.ts";
import { detectIndent, patchAutoPermissionsConfig } from "../config-writer.ts";

const FIXTURE = {
	systemPromptFile: "system-prompt.md",
	reviewEvidence: { projectInstructions: true, userAnswerTools: ["ask_user_question"] },
	evaluationLog: { enabled: true, path: "./review-evals.jsonl" },
	reviewer: { provider: "openai-codex-free", model: "gpt-5.6-luna", reasoningEffort: "medium", timeoutMs: 30_000 },
	rules: [
		{ pattern: "\\brm\\s", level: "guarded", group: "delete", label: "rm" },
		{ pattern: "\\bshred\\b", level: "guarded", group: "delete", label: "shred" },
	],
	somethingAFutureVersionAdded: { keep: true },
} as const;

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-auto-permissions-writer-"));
	tempDirs.push(dir);
	return dir;
}

function fixtureFile(value: unknown = FIXTURE, indent: string | number = 2): string {
	const dir = tempDir();
	const path = join(dir, "config.json");
	const text = typeof value === "string" ? value : `${JSON.stringify(value, null, indent)}\n`;
	writeFileSync(path, text, "utf8");
	writeFileSync(join(dir, "system-prompt.md"), "Review commands.\n", "utf8");
	return path;
}

function read(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		chmodSync(dir, 0o700);
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("config writer", () => {
	test("patches only the reviewer block", () => {
		const path = fixtureFile();
		patchAutoPermissionsConfig(path, {
			reviewer: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "high", timeoutMs: 45_000 },
		});

		const written = read(path);
		assert.deepEqual(written.reviewer, {
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			reasoningEffort: "high",
			timeoutMs: 45_000,
		});
		assert.deepEqual(written.rules, FIXTURE.rules);
		assert.equal(written.systemPromptFile, FIXTURE.systemPromptFile);
		assert.deepEqual(written.reviewEvidence, FIXTURE.reviewEvidence);
		assert.deepEqual(written.evaluationLog, FIXTURE.evaluationLog);
		assert.deepEqual(written.somethingAFutureVersionAdded, FIXTURE.somethingAFutureVersionAdded);
	});

	test("keeps a concurrent edit to another key", () => {
		const path = fixtureFile();
		// Another session rewrites the file after this one loaded it.
		writeFileSync(path, `${JSON.stringify({ ...FIXTURE, ui: { placement: "toolRow" } }, null, 2)}\n`, "utf8");
		patchAutoPermissionsConfig(path, { enabled: false });
		assert.deepEqual(read(path).ui, { placement: "toolRow" });
	});

	test("writes enabled false and removes the key when switched back on", () => {
		const path = fixtureFile();
		patchAutoPermissionsConfig(path, { enabled: false });
		assert.equal(read(path).enabled, false);

		patchAutoPermissionsConfig(path, { enabled: true });
		assert.equal(Object.hasOwn(read(path), "enabled"), false);
	});

	test("preserves the file's indentation and trailing newline", () => {
		const spaces = fixtureFile(FIXTURE, 2);
		patchAutoPermissionsConfig(spaces, { enabled: false });
		const spacesText = readFileSync(spaces, "utf8");
		assert.match(spacesText, /\n {2}"systemPromptFile"/);
		assert.equal(spacesText.endsWith("}\n"), true);

		const tabs = fixtureFile(FIXTURE, "\t");
		patchAutoPermissionsConfig(tabs, { enabled: false });
		const tabsText = readFileSync(tabs, "utf8");
		assert.match(tabsText, /\n\t"systemPromptFile"/);
		assert.equal(tabsText.endsWith("}\n"), true);
	});

	test("detects the indent of a document, defaulting to two spaces", () => {
		assert.equal(detectIndent('{\n    "a": 1\n}\n'), "    ");
		assert.equal(detectIndent('{\n\t"a": 1\n}\n'), "\t");
		assert.equal(detectIndent("{}"), "  ");
		assert.equal(detectIndent(""), "  ");
	});

	test("creates a missing file and its parent directory", () => {
		const path = join(tempDir(), "nested", "config.json");
		patchAutoPermissionsConfig(path, {
			reviewer: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "low", timeoutMs: 30_000 },
		});

		assert.deepEqual(Object.keys(read(path)), ["reviewer"]);
		assert.equal(statSync(path).mode & 0o777, 0o600);
	});

	test("refuses to clobber a file that is not a JSON object", () => {
		for (const content of ["[]", '"nope"', "{ not json"]) {
			const path = fixtureFile(content);
			assert.throws(() => patchAutoPermissionsConfig(path, { enabled: false }));
			assert.equal(readFileSync(path, "utf8"), content);
			assert.deepEqual(readdirSync(join(path, "..")).filter((name) => name.endsWith(".tmp")), []);
		}
	});

	test("leaves no temp file behind when the write fails", () => {
		const path = fixtureFile();
		const dir = join(path, "..");
		chmodSync(dir, 0o500);
		assert.throws(() => patchAutoPermissionsConfig(path, { enabled: false }));
		chmodSync(dir, 0o700);
		assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
		assert.equal(existsSync(path), true);
	});

	test("a reviewer patch preserves the hand-written prefilter key", () => {
		const path = fixtureFile({
			...FIXTURE,
			reviewer: { ...FIXTURE.reviewer, prefilter: true },
		});
		patchAutoPermissionsConfig(path, {
			reviewer: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "high", timeoutMs: 45_000 },
		});

		const written = read(path);
		assert.deepEqual(written.reviewer, {
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			reasoningEffort: "high",
			timeoutMs: 45_000,
			prefilter: true,
		});
		assert.equal(loadAutoPermissionsConfig(path).reviewer?.prefilter, true);
	});

	test("appends environment and softDeny entries without touching the rest of guardianPolicy", () => {
		const path = fixtureFile({
			...FIXTURE,
			guardianPolicy: {
				environment: ["existing entry"],
				softDeny: ["existing production boundary"],
				hardDeny: ["never push outside our org"],
			},
		});
		patchAutoPermissionsConfig(path, {
			appendEnvironment: [" new entry ", "existing entry", "second new entry"],
			appendSoftDeny: [" new production boundary ", "existing production boundary"],
		});

		const written = read(path);
		assert.deepEqual(written.guardianPolicy, {
			environment: ["existing entry", "new entry", "second new entry"],
			softDeny: ["existing production boundary", "new production boundary"],
			hardDeny: ["never push outside our org"],
		});
		// Unrelated keys survive untouched.
		assert.deepEqual(written.somethingAFutureVersionAdded, { keep: true });

		// No guardianPolicy on disk: the block is created with only environment.
		const fresh = fixtureFile();
		patchAutoPermissionsConfig(fresh, {
			appendEnvironment: ["only entry"],
			appendSoftDeny: ["only boundary"],
		});
		assert.deepEqual(read(fresh).guardianPolicy, {
			environment: ["only entry"],
			softDeny: ["only boundary"],
		});
		const loaded = loadAutoPermissionsConfig(fresh).guardianPolicy;
		assert.deepEqual(loaded.environment, ["only entry"]);
		assert.deepEqual(loaded.softDeny, ["only boundary"]);
	});

	test("round-trips through the loader", () => {
		const path = fixtureFile();
		patchAutoPermissionsConfig(path, {
			enabled: false,
			reviewer: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "xhigh", timeoutMs: 120_000 },
		});

		const config = loadAutoPermissionsConfig(path);
		assert.equal(config.enabled, false);
		assert.deepEqual(config.reviewer, {
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			reasoningEffort: "xhigh",
			timeoutMs: 120_000,
			prefilter: false,
		});
		assert.equal(config.rules.length, FIXTURE.rules.length);
		assert.equal(config.rules[0]?.label, "rm");
		assert.deepEqual(config.systemPromptSource, { kind: "file", path: join(path, "..", "system-prompt.md") });
	});
});
