import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { createMockContext } from "../../../test/support/mock-pi.js";
import type { PlanModeSettings } from "../src/settings.js";
import { showPlanModeSettings } from "../src/settings-menu.js";

async function withSettingsMenu(
	run: (fixture: {
		settingsPath: string;
		tui: ReturnType<typeof createTuiHarness>;
		ctx: ReturnType<typeof createMockContext>["ctx"];
		notifications: ReturnType<typeof createMockContext>["notifications"];
		saved: PlanModeSettings[];
	}) => Promise<void>,
) {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-settings-menu-"));
	const settingsPath = join(directory, "pi-plan-mode.json");
	const tui = createTuiHarness({ width: 72, rows: 24 });
	const context = createMockContext({
		cwd: directory,
		mode: "tui",
		hasUI: true,
		custom: tui.custom,
	});
	const saved: PlanModeSettings[] = [];
	try {
		await run({ settingsPath, tui, ctx: context.ctx, notifications: context.notifications, saved });
	} finally {
		tui.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}

function menuOptions(
	settingsPath: string,
	saved: PlanModeSettings[],
	overrides: Partial<Parameters<typeof showPlanModeSettings>[1]> = {},
) {
	return {
		settingsPath,
		signal: new AbortController().signal,
		isCurrent: () => true,
		onSaved: (settings: PlanModeSettings) => saved.push(settings),
		...overrides,
	};
}

test("Plan settings show the export row without materializing a missing file", async () => {
	await withSettingsMenu(async ({ settingsPath, tui, ctx, saved }) => {
		const running = showPlanModeSettings(ctx, menuOptions(settingsPath, saved));
		await tui.waitForOpen();
		const frame = tui.render().join("\n");
		assert.match(frame, /Plan Mode Settings/);
		assert.match(frame, /Export destination\s+PLAN\.md/);
		// The tool, bash-policy, and retention rows are gone with their features,
		// and Plan thinking went with the setting that raised the session's level.
		assert.doesNotMatch(frame, /Plan thinking/);
		assert.doesNotMatch(frame, /Plan tools/);
		assert.doesNotMatch(frame, /Bash policy/);
		assert.doesNotMatch(frame, /After Implement/);
		assert.ok(tui.render(34).every((line) => visibleWidth(line) <= 34));
		await assert.rejects(access(settingsPath));

		tui.press("ctrl+c");
		await running;
		assert.deepEqual(saved, []);
		await assert.rejects(access(settingsPath));
	});
});

/**
 * A key this version no longer knows about (`thinkingLevel` is the one users
 * still have on disk) is neither explained nor acted on: the menu shows the
 * settings it owns, and opening it leaves the file byte-for-byte alone.
 */
test("a settings file carrying an unknown key opens unremarked and unmodified", async () => {
	await withSettingsMenu(async ({ settingsPath, tui, ctx, saved }) => {
		const contents = JSON.stringify({ thinkingLevel: "high" });
		await writeFile(settingsPath, contents);
		const running = showPlanModeSettings(ctx, menuOptions(settingsPath, saved));
		await tui.waitForOpen();
		const frame = tui.render(160).join("\n");
		assert.doesNotMatch(frame, /thinkingLevel/);
		assert.doesNotMatch(frame, /Plan thinking/);
		assert.match(frame, /Export destination\s+PLAN\.md/);
		tui.press("ctrl+c");
		await running;
		assert.equal(await readFile(settingsPath, "utf8"), contents);
	});
});

test("Export destination saves, previews, resets, and cancels", async () => {
	await withSettingsMenu(async ({ settingsPath, tui, ctx, saved }) => {
		const running = showPlanModeSettings(ctx, menuOptions(settingsPath, saved));
		await tui.waitForOpen();
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		const frame = tui.render().join("\n");
		assert.match(frame, /Export destination/i);
		assert.match(frame, /PLAN\.md/);
		assert.match(
			tui.render(240).join("\n"),
			new RegExp(
				settingsPath
					.replace("pi-plan-mode.json", "PLAN.md")
					.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
			),
		);
		tui.type("docs/PLAN.md");
		tui.press("tui.input.submit");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.equal(saved.at(-1)?.defaultPlanExportPath, "docs/PLAN.md");
		assert.match(tui.render().join("\n"), /Export destination\s+docs\/PLAN\.md/);

		// Returning from the input screen leaves the cursor on the export row.
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		tui.press("tui.input.submit");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.equal(saved.at(-1)?.defaultPlanExportPath, undefined);
		assert.match(tui.render().join("\n"), /Export destination\s+PLAN\.md/);

		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		tui.type("cancelled.md");
		tui.press("tui.select.cancel");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.equal(saved.at(-1)?.defaultPlanExportPath, undefined);
		tui.press("ctrl+c");
		await running;
	});
});

test("long export previews stay within narrow terminal widths", async () => {
	await withSettingsMenu(async ({ settingsPath, tui, ctx, saved }) => {
		const longPath = `plans/${"nested-".repeat(16)}PLAN.md`;
		await writeFile(settingsPath, JSON.stringify({ defaultPlanExportPath: longPath }));
		const running = showPlanModeSettings(ctx, menuOptions(settingsPath, saved));
		await tui.waitForOpen();
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /nested-/);
		assert.ok(tui.render(26).every((line) => visibleWidth(line) <= 26));
		tui.press("tui.select.cancel");
		await tui.waitForPending();
		await tui.waitForOpen();
		tui.press("ctrl+c");
		await running;
	});
});

test("Invalid Plan settings are read-only and save failures roll back displayed values", async () => {
	await withSettingsMenu(async ({ settingsPath, tui, ctx, notifications, saved }) => {
		await writeFile(settingsPath, "{mock-sensitive-token");
		let running = showPlanModeSettings(ctx, menuOptions(settingsPath, saved));
		await tui.waitForOpen();
		const invalid = tui.render().join("\n");
		assert.match(invalid, /Read only/);
		assert.doesNotMatch(invalid, /mock-sensitive-token/);
		tui.press("ctrl+c");
		await running;
		assert.equal(await readFile(settingsPath, "utf8"), "{mock-sensitive-token");

		await writeFile(settingsPath, '{"defaultPlanExportPath":"bad\\u001bpath"}');
		running = showPlanModeSettings(ctx, menuOptions(settingsPath, saved));
		await tui.waitForOpen();
		const controlInvalid = tui.render().join("\n");
		assert.match(controlInvalid, /Read only/);
		assert.doesNotMatch(controlInvalid, /bad.*path/is);
		tui.press("ctrl+c");
		await running;

		await rm(settingsPath);
		running = showPlanModeSettings(
			ctx,
			menuOptions(settingsPath, saved, {
				updateSettings: async () => {
					throw new Error("disk full\u001b]52;c;terminal-payload\u0007");
				},
			}),
		);
		await tui.waitForOpen();
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		tui.type("docs/PLAN.md");
		tui.press("tui.input.submit");
		await tui.waitForPending();
		await tui.waitForOpen();
		// A rejected save keeps the input screen open on the unchanged value.
		assert.match(tui.render().join("\n"), /Configured: PLAN\.md/);
		assert.deepEqual(saved, []);
		const message = notifications.at(-1)?.message ?? "";
		assert.match(message, /previous value remains/i);
		assert.equal(
			[...message].some((character) => {
				const code = character.charCodeAt(0);
				return code <= 31 || (code >= 127 && code <= 159);
			}),
			false,
		);
		tui.press("ctrl+c");
		await running;
	});
});

test("RPC Settings changes the export destination with the same flat navigation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-settings-rpc-"));
	const settingsPath = join(directory, "pi-plan-mode.json");
	try {
		const rpc = createRpcHarness([
			{
				kind: "select",
				options: ["Export destination (PLAN.md)", "Back"],
				response: undefined,
			},
		]);
		const rpcContext = createMockContext({ mode: "rpc", hasUI: true, ...rpc.ui });
		await showPlanModeSettings(rpcContext.ctx, menuOptions(settingsPath, []));
		rpc.assertConsumed();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan settings adapt to disposal aborting an in-flight save", async () => {
	await withSettingsMenu(async ({ settingsPath, tui, ctx, notifications, saved }) => {
		let started!: () => void;
		const saveStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const running = showPlanModeSettings(
			ctx,
			menuOptions(settingsPath, saved, {
				updateSettings: async (_patch, updateOptions) => {
					started();
					const signal = updateOptions?.signal;
					return new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				},
			}),
		);
		await tui.waitForOpen();
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		tui.type("docs/PLAN.md");
		tui.press("tui.input.submit");
		await saveStarted;
		tui.dispose();
		await running;
		assert.deepEqual(saved, []);
		assert.deepEqual(notifications, []);
	});
});
