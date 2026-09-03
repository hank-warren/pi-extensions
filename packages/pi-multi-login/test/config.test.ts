import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import {
	aliasDisplayName,
	aliasProviderId,
	isValidAliasSuffix,
	loadMultiLoginConfig,
	parseMultiLoginConfig,
	saveMultiLoginConfig,
} from "../config.ts";

describe("alias ids and naming", () => {
	test("composes the provider id from base and suffix", () => {
		assert.equal(aliasProviderId("openai-codex", "auto-permissions"), "openai-codex-auto-permissions");
		assert.equal(aliasProviderId("anthropic", "work"), "anthropic-work");
	});

	test("accepts lowercase slugs and rejects everything else", () => {
		for (const suffix of ["alt", "auto-permissions", "work2", "a1-b2-c3"]) {
			assert.equal(isValidAliasSuffix(suffix), true, suffix);
		}
		for (const suffix of ["", "Alt", "-x", "x-", "a--b", "has space", "under_score", "dot.dot"]) {
			assert.equal(isValidAliasSuffix(suffix), false, JSON.stringify(suffix));
		}
		assert.equal(isValidAliasSuffix(undefined), false);
		assert.equal(isValidAliasSuffix(7), false);
	});

	test("defaults the display name to the base provider name plus the suffix", () => {
		assert.equal(aliasDisplayName({ base: "openai-codex", suffix: "alternate" }, "OpenAI Codex"), "OpenAI Codex (alternate)");
		assert.equal(
			aliasDisplayName({ base: "anthropic", suffix: "work", name: "Anthropic (work)" }, "Anthropic"),
			"Anthropic (work)",
		);
	});
});

describe("config parsing", () => {
	test("round-trips the documented example", () => {
		const value = {
			aliases: [
				{ base: "openai-codex", suffix: "auto-permissions" },
				{ base: "anthropic", suffix: "work", name: "Anthropic (work)" },
			],
		};
		assert.deepEqual(parseMultiLoginConfig(value), value);
	});

	test("treats a missing aliases key as no aliases", () => {
		assert.deepEqual(parseMultiLoginConfig({}), { aliases: [] });
	});

	test("ignores unknown keys so a newer config never breaks an older install", () => {
		assert.deepEqual(parseMultiLoginConfig({ aliases: [], futureOption: true }), { aliases: [] });
		assert.deepEqual(parseMultiLoginConfig({ aliases: [{ base: "anthropic", suffix: "work", extra: 1 }] }), {
			aliases: [{ base: "anthropic", suffix: "work" }],
		});
	});

	test("rejects malformed configs", () => {
		assert.throws(() => parseMultiLoginConfig(null), /must be an object/);
		assert.throws(() => parseMultiLoginConfig("aliases"), /must be an object/);
		assert.throws(() => parseMultiLoginConfig([]), /must be an object/);
		assert.throws(() => parseMultiLoginConfig({ aliases: {} }), /aliases must be an array/);
		assert.throws(() => parseMultiLoginConfig({ aliases: [{ suffix: "work" }] }), /aliases\[0\]\.base/);
		assert.throws(() => parseMultiLoginConfig({ aliases: [{ base: "anthropic" }] }), /aliases\[0\]\.suffix/);
		assert.throws(() => parseMultiLoginConfig({ aliases: [{ base: "anthropic", suffix: "Work" }] }), /lowercase slug/);
		assert.throws(
			() =>
				parseMultiLoginConfig({
					aliases: [
						{ base: "anthropic", suffix: "work" },
						{ base: "anthropic", suffix: "work" },
					],
				}),
			/duplicate provider id: anthropic-work/,
		);
	});
});

/**
 * `saveMultiLoginConfig` is the only settings writer in this repo that neither
 * merges nor writes atomically. Both matter here: `parseMultiLoginConfig`
 * documents that "unknown keys are ignored so a newer config never breaks an
 * older install", and a torn write leaves a config that `loadMultiLoginConfig`
 * rejects — which makes the extension drop *every* alias while
 * `multiLoginConfigExists` still returns true, so the one-time credential
 * adoption never re-runs to heal it.
 */
describe("saving the config", () => {
	function withConfig(run: (path: string) => void): void {
		const directory = mkdtempSync(join(tmpdir(), "pi-multi-login-save-"));
		try {
			run(join(directory, "pi-multi-login.json"));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}

	test("preserves keys it does not own", () => {
		withConfig((path) => {
			writeFileSync(
				path,
				`${JSON.stringify({
					aliases: [{ base: "anthropic", suffix: "work" }],
					defaultAlias: "anthropic-work",
					telemetry: { enabled: false },
				})}\n`,
				"utf8",
			);

			const loaded = loadMultiLoginConfig(path);
			saveMultiLoginConfig(
				{ aliases: [...loaded.aliases, { base: "openai", suffix: "alt" }] },
				path,
			);

			const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			assert.equal(written.defaultAlias, "anthropic-work", "an unowned scalar survives");
			assert.deepEqual(written.telemetry, { enabled: false }, "an unowned object survives");
			assert.deepEqual(loadMultiLoginConfig(path).aliases, [
				{ base: "anthropic", suffix: "work" },
				{ base: "openai", suffix: "alt" },
			]);
		});
	});

	test("publishes through a temp file and leaves none behind", () => {
		withConfig((path) => {
			saveMultiLoginConfig({ aliases: [{ base: "anthropic", suffix: "work" }] }, path);
			const directory = dirname(path);
			const leftovers = readdirSync(directory).filter((name) => name.includes(".tmp"));
			assert.deepEqual(leftovers, [], "no temp file survives a successful save");
			// The live file is only ever replaced by rename, so it is never observed
			// truncated: a failed write cannot destroy the aliases already on disk.
			assert.doesNotThrow(() => loadMultiLoginConfig(path));
		});
	});

	test("writes the file with owner-only permissions", () => {
		withConfig((path) => {
			saveMultiLoginConfig({ aliases: [{ base: "anthropic", suffix: "work" }] }, path);
			assert.equal(statSync(path).mode & 0o777, 0o600);
		});
	});
});
