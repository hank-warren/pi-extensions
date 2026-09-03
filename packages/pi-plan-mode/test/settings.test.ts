import assert from "node:assert/strict";
import {
	access,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	awaitPlanModeSettingsWrites,
	configuredPlanExportPath,
	normalizePlanModeSettings,
	readPlanModeSettings,
	updatePlanModeSettings,
} from "../src/settings.js";

/**
 * The hermetic preload's scratch agent dir (`test/support/hermetic.ts`). The one
 * case below that repoints `PI_CODING_AGENT_DIR` at a temp dir it then deletes
 * puts this back afterwards, so a later case never inherits a path that no
 * longer exists.
 */
const PRELOAD_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

/**
 * defaultPlanTools, bashPolicy, safeSubcommands, and implementationPlanRetention
 * were removed in the plan-file rewrite; thinkingLevel was removed when Plan
 * mode stopped mutating session-global state. They must all degrade to
 * tolerated unknown keys so an existing settings file keeps working after the
 * upgrade.
 */
test("settings removed over time are tolerated as unknown keys", async () => {
	assert.deepEqual(
		normalizePlanModeSettings({
			thinkingLevel: "medium",
			defaultPlanTools: ["read", "bash"],
			bashPolicy: "auto-permissions",
			implementationPlanRetention: "clear-on-start",
			safeSubcommands: { gh: ["pr view"] },
		}),
		{},
	);
	// Even values that were invalid under the old schema no longer fail the file.
	assert.deepEqual(normalizePlanModeSettings({ bashPolicy: "nonsense", defaultPlanTools: 42 }), {});

	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-legacy-keys-test-"));
	try {
		const path = join(directory, "pi-plan-mode.json");
		const legacy =
			'{"thinkingLevel":"high","defaultPlanTools":["read"],"bashPolicy":"auto-permissions"}';
		await writeFile(path, legacy);
		assert.deepEqual(await readPlanModeSettings(path), { kind: "loaded", settings: {} });

		// A save preserves the now-unknown keys rather than dropping them.
		await updatePlanModeSettings({ defaultPlanExportPath: "docs/PLAN.md" }, { settingsPath: path });
		const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		assert.equal(saved.defaultPlanExportPath, "docs/PLAN.md");
		assert.equal(saved.thinkingLevel, "high", "the removed key survives a save verbatim");
		assert.deepEqual(saved.defaultPlanTools, ["read"]);
		assert.equal(saved.bashPolicy, "auto-permissions");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

/**
 * Removed settings are ignored, never validated: a file whose thinkingLevel is
 * garbage must still load, where it used to fail the whole file closed.
 */
test("a settings file that still carries thinkingLevel loads", async () => {
	assert.deepEqual(normalizePlanModeSettings({ thinkingLevel: "high" }), {});
	assert.deepEqual(normalizePlanModeSettings({ thinkingLevel: "extreme" }), {});

	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-thinking-key-"));
	try {
		const path = join(directory, "pi-plan-mode.json");
		for (const contents of ['{"thinkingLevel":"high"}', '{"thinkingLevel":"bogus"}']) {
			await writeFile(path, contents);
			assert.deepEqual(await readPlanModeSettings(path), { kind: "loaded", settings: {} });
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan-mode settings validate export defaults", () => {
	assert.deepEqual(normalizePlanModeSettings({ defaultPlanExportPath: "docs/PLAN.md" }), {
		defaultPlanExportPath: "docs/PLAN.md",
	});
	const normalizedPath = normalizePlanModeSettings({
		defaultPlanExportPath: " docs/PLAN.md ",
	});
	assert.ok(normalizedPath);
	assert.equal(configuredPlanExportPath(normalizedPath), "docs/PLAN.md");
	const defaults = normalizePlanModeSettings({});
	assert.ok(defaults);
	assert.equal(configuredPlanExportPath(defaults), "PLAN.md");
	for (const defaultPlanExportPath of [
		"",
		"   ",
		"bad\0path",
		"bad\u001bpath",
		"x".repeat(4097),
		42,
	]) {
		assert.equal(normalizePlanModeSettings({ defaultPlanExportPath }), undefined);
	}
});

test("Plan-mode settings ignore unknown top-level fields", () => {
	assert.deepEqual(normalizePlanModeSettings({ futureOption: { enabled: true } }), {});
});


test("Plan-mode settings updates create only on explicit save and preserve unknown fields", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-settings-update-"));
	const settingsPath = join(directory, "nested", "pi-plan-mode.json");
	try {
		assert.deepEqual(await readPlanModeSettings(settingsPath), { kind: "missing" });
		await assert.rejects(access(settingsPath));

		await updatePlanModeSettings({ defaultPlanExportPath: "first.md" }, { settingsPath });
		await writeFile(
			settingsPath,
			'{"future":{"kept":true},"thinkingLevel":"high","safeSubcommands":{"gh":["pr view"]}}\n',
		);
		await updatePlanModeSettings({ defaultPlanExportPath: "docs/PLAN.md" }, { settingsPath });

		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			future: { kept: true },
			thinkingLevel: "high",
			safeSubcommands: { gh: ["pr view"] },
			defaultPlanExportPath: "docs/PLAN.md",
		});
		assert.deepEqual(await readPlanModeSettings(settingsPath), {
			kind: "loaded",
			settings: { defaultPlanExportPath: "docs/PLAN.md" },
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan-mode settings patch the export destination from the latest document", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-settings-new-fields-"));
	const settingsPath = join(directory, "pi-plan-mode.json");
	try {
		await writeFile(
			settingsPath,
			'{"thinkingLevel":"low","future":{"kept":true},"defaultPlanExportPath":"old.md"}\n',
		);
		await updatePlanModeSettings({ defaultPlanExportPath: "docs/PLAN.md" }, { settingsPath });
		assert.deepEqual(await readPlanModeSettings(settingsPath), {
			kind: "loaded",
			settings: { defaultPlanExportPath: "docs/PLAN.md" },
		});

		await updatePlanModeSettings({ defaultPlanExportPath: null }, { settingsPath });
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			thinkingLevel: "low",
			future: { kept: true },
		});
		assert.deepEqual(await readPlanModeSettings(settingsPath), { kind: "loaded", settings: {} });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan-mode settings refuse invalid documents and preserve atomic publication failures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-settings-invalid-"));
	const settingsPath = join(directory, "pi-plan-mode.json");
	try {
		for (const invalid of ["{mock-sensitive-token", '{"defaultPlanExportPath":42}\n']) {
			await writeFile(settingsPath, invalid);
			await assert.rejects(
				updatePlanModeSettings({ defaultPlanExportPath: "docs/PLAN.md" }, { settingsPath }),
				(error: unknown) => {
					assert.match(String(error), /invalid (?:JSON|settings shape)/i);
					assert.doesNotMatch(String(error), /mock-sensitive-token/);
					return true;
				},
			);
			assert.equal(await readFile(settingsPath, "utf8"), invalid);
		}

		const invalidUtf8 = Buffer.from([0x7b, 0xff, 0x7d]);
		await writeFile(settingsPath, invalidUtf8);
		const invalidUtf8Result = await readPlanModeSettings(settingsPath);
		assert.match(invalidUtf8Result.kind === "invalid" ? invalidUtf8Result.reason : "", /UTF-8/i);
		await assert.rejects(
			updatePlanModeSettings({ defaultPlanExportPath: "docs/PLAN.md" }, { settingsPath }),
			/UTF-8/i,
		);
		assert.deepEqual(await readFile(settingsPath), invalidUtf8);

		const oversized = Buffer.alloc(64 * 1024 + 1, 0x20);
		await writeFile(settingsPath, oversized);
		const oversizedResult = await readPlanModeSettings(settingsPath);
		assert.match(
			oversizedResult.kind === "invalid" ? oversizedResult.reason : "",
			/exceeds .* bytes/i,
		);
		await assert.rejects(
			updatePlanModeSettings({ defaultPlanExportPath: "docs/PLAN.md" }, { settingsPath }),
			/exceeds .* bytes/i,
		);
		assert.deepEqual(await readFile(settingsPath), oversized);

		await writeFile(settingsPath, '{"thinkingLevel":"low","future":true}\n');
		const before = await readFile(settingsPath, "utf8");
		await assert.rejects(
			updatePlanModeSettings(
				{ defaultPlanExportPath: "docs/PLAN.md" },
				{
					settingsPath,
					beforeRename: async () => {
						throw new Error("publication failed");
					},
				},
			),
			/publication failed/,
		);
		assert.equal(await readFile(settingsPath, "utf8"), before);
		assert.deepEqual(await readdir(directory), ["pi-plan-mode.json"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan-mode settings serialize updates, coordinate reads, and recover after failure", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-settings-order-"));
	const settingsPath = join(directory, "pi-plan-mode.json");
	let releaseFirst!: () => void;
	let markFirstReached!: () => void;
	const firstReached = new Promise<void>((resolve) => {
		markFirstReached = resolve;
	});
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	try {
		const first = updatePlanModeSettings(
			{ defaultPlanExportPath: "first/PLAN.md" },
			{
				settingsPath,
				beforeRename: async () => {
					markFirstReached();
					await firstGate;
				},
			},
		);
		const second = updatePlanModeSettings(
			{ defaultPlanExportPath: "second/PLAN.md" },
			{ settingsPath },
		);
		const third = updatePlanModeSettings(
			{ defaultPlanExportPath: "ordered/PLAN.md" },
			{ settingsPath },
		);
		const coordinatedRead = readPlanModeSettings(settingsPath);
		await firstReached;
		releaseFirst();
		await Promise.all([first, second, third]);
		assert.deepEqual(await coordinatedRead, {
			kind: "loaded",
			settings: { defaultPlanExportPath: "ordered/PLAN.md" },
		});

		await assert.rejects(
			updatePlanModeSettings(
				{ defaultPlanExportPath: "failed/PLAN.md" },
				{
					settingsPath,
					beforeRename: async () => Promise.reject(new Error("failed once")),
				},
			),
			/failed once/,
		);
		await updatePlanModeSettings({ defaultPlanExportPath: "last/PLAN.md" }, { settingsPath });
		await awaitPlanModeSettingsWrites(settingsPath);
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			defaultPlanExportPath: "last/PLAN.md",
		});
	} finally {
		releaseFirst();
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan-mode settings abort before publication without creating the canonical file", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-settings-abort-"));
	const settingsPath = join(directory, "pi-plan-mode.json");
	const controller = new AbortController();
	try {
		await assert.rejects(
			updatePlanModeSettings(
				{ defaultPlanExportPath: "docs/PLAN.md" },
				{
					settingsPath,
					signal: controller.signal,
					beforeRename: async () => controller.abort(new Error("settings disposed")),
				},
			),
			/settings disposed/,
		);
		await assert.rejects(access(settingsPath));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

/**
 * Pathless reads resolve one file and one only: `pi-plan-mode.json` in the
 * agent dir. `plan-mode.json` was the pre-1.3 name; it is no longer read, no
 * longer promoted on save, and never written to.
 */
test("Plan-mode settings read only pi-plan-mode.json from the agent dir", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-agent-dir-"));
	const formerName = join(directory, "plan-mode.json");
	const formerContents = '{"defaultPlanExportPath":"former.md"}';
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writeFile(formerName, formerContents);
		assert.deepEqual(await readPlanModeSettings(), { kind: "missing" });

		await updatePlanModeSettings({ defaultPlanExportPath: "docs/PLAN.md" });
		assert.deepEqual(await readPlanModeSettings(), {
			kind: "loaded",
			settings: { defaultPlanExportPath: "docs/PLAN.md" },
		});
		assert.deepEqual(JSON.parse(await readFile(join(directory, "pi-plan-mode.json"), "utf8")), {
			defaultPlanExportPath: "docs/PLAN.md",
		});

		await writeFile(join(directory, "pi-plan-mode.json"), "invalid");
		assert.equal((await readPlanModeSettings()).kind, "invalid");

		await unlink(join(directory, "pi-plan-mode.json"));
		await symlink("missing-target", join(directory, "pi-plan-mode.json"));
		const linked = await readPlanModeSettings();
		assert.equal(linked.kind, "invalid");
		assert.match(linked.kind === "invalid" ? linked.reason : "", /regular file/i);

		assert.equal(await readFile(formerName, "utf8"), formerContents, "the former file is untouched");
	} finally {
		process.env.PI_CODING_AGENT_DIR = PRELOAD_AGENT_DIR;
		await rm(directory, { recursive: true, force: true });
	}
});
