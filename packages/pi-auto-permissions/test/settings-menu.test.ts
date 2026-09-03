import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	applyModelSelection,
	applySettingChange,
	applyTimeoutInput,
	buildModelItems,
	buildSettingItems,
	denialItem,
	RECENT_DENIALS_ID,
	STANDING_APPROVALS_ID,
	filterModelItems,
	formatTimeout,
	parseTimeoutInput,
	standingApprovalItem,
	systemPromptValue,
	type MenuModel,
	type ReviewerSettings,
} from "../settings-menu.ts";

const HOME = "/home/tester";

function settings(overrides: Partial<ReviewerSettings> = {}): ReviewerSettings {
	return {
		enabled: true,
		reviewer: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "medium", timeoutMs: 30_000 },
		systemPromptSource: { kind: "file", path: `${HOME}/.pi/agent/pi-auto-permissions/system-prompt.md` },
		...overrides,
	};
}

function values(items: ReturnType<typeof buildSettingItems>): Record<string, string> {
	return Object.fromEntries(items.map((item) => [item.id, item.currentValue]));
}

describe("settings rows", () => {
	test("shows every configured value", () => {
		const items = buildSettingItems(settings(), {}, HOME);
		assert.deepEqual(items.map((item) => item.id), [
			"enabled",
			"reviewerModel",
			"reasoningEffort",
			"timeoutMs",
			"systemPrompt",
		]);
		assert.deepEqual(values(items), {
			enabled: "on",
			reviewerModel: "openai-codex/gpt-5.6-luna",
			reasoningEffort: "medium",
			timeoutMs: "30s",
			systemPrompt: "~/.pi/agent/pi-auto-permissions/system-prompt.md",
		});
	});

	test("falls back to the loader defaults when no reviewer is configured", () => {
		const items = buildSettingItems(
			settings({ enabled: false, reviewer: undefined, systemPromptSource: { kind: "builtin" } }),
			{},
			HOME,
		);
		assert.deepEqual(values(items), {
			enabled: "off",
			reviewerModel: "(unset)",
			reasoningEffort: "low",
			timeoutMs: "30s",
			systemPrompt: "(built-in default)",
		});
	});

	test("the system prompt row is read-only", () => {
		const row = buildSettingItems(settings(), {}, HOME).find((item) => item.id === "systemPrompt");
		assert.ok(row);
		assert.equal(row.values, undefined);
		assert.equal(row.submenu, undefined);
	});

	test("reports where the active prompt came from", () => {
		assert.equal(systemPromptValue({ kind: "builtin" }, HOME), "(built-in default)");
		assert.equal(systemPromptValue({ kind: "inline" }, HOME), "(inline in config)");
		assert.equal(systemPromptValue({ kind: "file", path: `${HOME}/prompt.md` }, HOME), "~/prompt.md");
		assert.equal(systemPromptValue({ kind: "file", path: "/etc/prompt.md" }, HOME), "/etc/prompt.md");
	});
});

describe("enabled toggle", () => {
	test("turning it off updates the snapshot", () => {
		const change = applySettingChange(settings(), "enabled", "off");
		assert.equal(change.kind, "settings");
		assert.equal(change.kind === "settings" && change.settings.enabled, false);
	});

	test("re-selecting the current value is a no-op", () => {
		assert.equal(applySettingChange(settings(), "enabled", "on").kind, "ignored");
	});

	test("an unknown value is rejected", () => {
		assert.equal(applySettingChange(settings(), "enabled", "maybe").kind, "error");
	});
});

describe("thinking level", () => {
	const unsupported: MenuModel = {
		provider: "openai-codex",
		id: "gpt-5.6-luna",
		thinkingLevelMap: { xhigh: null, high: "high" },
	};

	test("saves with a warning when the model marks the level unsupported", () => {
		const change = applySettingChange(settings(), "reasoningEffort", "xhigh", unsupported);
		assert.equal(change.kind, "warn");
		assert.equal(change.kind === "warn" && change.settings.reviewer?.reasoningEffort, "xhigh");
		assert.match(change.kind === "warn" ? change.message : "", /does not support thinking level "xhigh"/);
	});

	test("saves quietly when the model supports the level", () => {
		const change = applySettingChange(settings(), "reasoningEffort", "high", unsupported);
		assert.equal(change.kind, "settings");
	});

	test("saves quietly when the model declares no level map", () => {
		const model: MenuModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
		assert.equal(applySettingChange(settings(), "reasoningEffort", "xhigh", model).kind, "settings");
	});

	test("rejects an unknown level", () => {
		assert.equal(applySettingChange(settings(), "reasoningEffort", "turbo").kind, "error");
	});

	test("requires a reviewer model first", () => {
		const change = applySettingChange(settings({ reviewer: undefined }), "reasoningEffort", "high");
		assert.equal(change.kind, "error");
		assert.equal(change.kind === "error" && change.message, "Select a reviewer model first");
	});
});

describe("timeout", () => {
	test("parses seconds, bare numbers and milliseconds", () => {
		assert.deepEqual(parseTimeoutInput("30"), { timeoutMs: 30_000 });
		assert.deepEqual(parseTimeoutInput("30s"), { timeoutMs: 30_000 });
		assert.deepEqual(parseTimeoutInput(" 2.5s "), { timeoutMs: 2_500 });
		assert.deepEqual(parseTimeoutInput("45000ms"), { timeoutMs: 45_000 });
		assert.deepEqual(parseTimeoutInput("30 S"), { timeoutMs: 30_000 });
	});

	test("rejects values outside the loader's window", () => {
		assert.ok("error" in parseTimeoutInput("0.5s"));
		assert.ok("error" in parseTimeoutInput("301s"));
		assert.ok("error" in parseTimeoutInput("999ms"));
	});

	test("rejects unparsable input", () => {
		for (const input of ["", "abc", "30 s x", "-30", "30sec"]) {
			assert.ok("error" in parseTimeoutInput(input), input);
		}
	});

	test("rejects a fractional millisecond value", () => {
		assert.ok("error" in parseTimeoutInput("2.0005s"));
	});

	test("formats for the value column", () => {
		assert.equal(formatTimeout(30_000), "30s");
		assert.equal(formatTimeout(2_500), "2.5s");
		assert.equal(formatTimeout(1_000), "1s");
		assert.equal(formatTimeout(90_000), "1m 30s");
		assert.equal(formatTimeout(120_000), "2m");
	});

	test("applies a valid edit and ignores an unchanged one", () => {
		const change = applyTimeoutInput(settings(), "45s");
		assert.equal(change.kind === "settings" && change.settings.reviewer?.timeoutMs, 45_000);
		assert.equal(applyTimeoutInput(settings(), "30s").kind, "ignored");
	});

	test("requires a reviewer model first", () => {
		const change = applyTimeoutInput(settings({ reviewer: undefined }), "45s");
		assert.equal(change.kind, "error");
		assert.equal(change.kind === "error" && change.message, "Select a reviewer model first");
	});
});

describe("model picker", () => {
	const available: MenuModel[] = [
		{ provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 272_000 },
		{ provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200_000 },
		{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000 },
	];

	test("sorts by provider then id", () => {
		const items = buildModelItems(available, settings());
		assert.deepEqual(items.map((item) => item.value), [
			"anthropic/claude-haiku-4-5",
			"anthropic/claude-sonnet-4-6",
			"openai-codex/gpt-5.6-luna",
		]);
		assert.match(items[0]?.description ?? "", /Claude Haiku 4\.5 · 200k ctx/);
	});

	test("does not duplicate an available configured reviewer", () => {
		const items = buildModelItems(available, settings());
		assert.equal(items.filter((item) => item.value === "openai-codex/gpt-5.6-luna").length, 1);
	});

	test("pins a configured reviewer the registry does not know", () => {
		const items = buildModelItems(
			available,
			settings({
				reviewer: { provider: "openai-codex-free", model: "gpt-5.6-luna", reasoningEffort: "low", timeoutMs: 30_000 },
			}),
		);
		assert.equal(items[0]?.value, "openai-codex-free/gpt-5.6-luna");
		assert.match(items[0]?.label ?? "", /\(configured, unavailable\)/);
		assert.equal(items.length, available.length + 1);
	});

	test("filters on any part of the row, not just a value prefix", () => {
		const items = buildModelItems(available, settings());
		assert.deepEqual(filterModelItems(items, "luna").map((item) => item.value), ["openai-codex/gpt-5.6-luna"]);
		assert.deepEqual(filterModelItems(items, "haiku").map((item) => item.value), ["anthropic/claude-haiku-4-5"]);
		assert.equal(filterModelItems(items, "").length, items.length);
		assert.equal(filterModelItems(items, "nope").length, 0);
	});

	test("selecting a model keeps the existing thinking level and timeout", () => {
		const change = applyModelSelection(settings(), "anthropic/claude-sonnet-4-6");
		assert.deepEqual(change.kind === "settings" ? change.settings.reviewer : undefined, {
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			reasoningEffort: "medium",
			timeoutMs: 30_000,
		});
	});

	test("selecting a model with no reviewer configured seeds the loader defaults", () => {
		const change = applyModelSelection(settings({ reviewer: undefined }), "anthropic/claude-sonnet-4-6");
		assert.deepEqual(change.kind === "settings" ? change.settings.reviewer : undefined, {
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			reasoningEffort: "low",
			timeoutMs: 30_000,
		});
	});

	test("re-selecting the configured model is a no-op", () => {
		assert.equal(applyModelSelection(settings(), "openai-codex/gpt-5.6-luna").kind, "ignored");
	});

	test("model ids containing a slash round-trip", () => {
		const change = applyModelSelection(settings(), "openrouter/meta/llama-4");
		assert.deepEqual(change.kind === "settings" ? change.settings.reviewer?.model : undefined, "meta/llama-4");
	});

	test("rejects a value that is not provider/model", () => {
		assert.equal(applyModelSelection(settings(), "bare-model").kind, "error");
	});
});

describe("submenu-owned rows", () => {
	test("the settings list change hook ignores ids the submenus commit themselves", () => {
		assert.equal(applySettingChange(settings(), "reviewerModel", "anthropic/claude-sonnet-4-6").kind, "ignored");
		assert.equal(applySettingChange(settings(), "timeoutMs", "45s").kind, "ignored");
		assert.equal(applySettingChange(settings(), "systemPrompt", "whatever").kind, "ignored");
	});
});

describe("standing approvals row", () => {
	const settings = { enabled: true, systemPromptSource: { kind: "builtin" } } as const;

	test("appears only when its submenu is wired, with the count as its value", () => {
		const submenu = (() => { throw new Error("unused"); }) as never;
		const withApprovals = buildSettingItems(settings, { standingApprovals: submenu }, "/home/u", undefined, 4);
		const row = withApprovals.find((item) => item.id === STANDING_APPROVALS_ID);
		assert.ok(row);
		assert.equal(row.currentValue, "4");
		assert.equal(row.label, "Standing approvals");

		const without = buildSettingItems(settings, {}, "/home/u");
		assert.equal(without.some((item) => item.id === STANDING_APPROVALS_ID), false);
	});

	test("standingApprovalItem identifies the gate, date, project, and bounded command", () => {
		const item = standingApprovalItem({
			id: "s1",
			record: {
				v: 1,
				ts: "2026-08-25T00:00:00Z",
				gate: { label: "Remote command", group: "ssh" },
				command: `ssh prod.example uptime ${"x".repeat(100)}`,
				scope: "comparable",
				project: "/work/acme",
				reason: "target was not authorized",
			},
		});
		assert.equal(item.value, "s1");
		assert.ok(item.label.length <= 70);
		assert.ok(item.label.endsWith("…"));
		assert.equal(item.description, "Remote command · granted 2026-08-25 · /work/acme");
	});
});

describe("recent denials row", () => {
	const settings = { enabled: true, systemPromptSource: { kind: "builtin" } } as const;

	test("appears only when the submenu is wired, with the count as its value", () => {
		const submenu = (() => { throw new Error("unused"); }) as never;
		const withDenials = buildSettingItems(settings, { recentDenials: submenu }, "/home/u", 7);
		const row = withDenials.find((item) => item.id === RECENT_DENIALS_ID);
		assert.ok(row, "row present when submenu provided");
		assert.equal(row.currentValue, "7");
		assert.equal(row.label, "Recent denials");

		const without = buildSettingItems(settings, {}, "/home/u");
		assert.equal(without.some((item) => item.id === RECENT_DENIALS_ID), false);
	});

	test("denialItem truncates long commands and names gate, verdict, and reason", () => {
		const item = denialItem({
			id: "d1",
			ts: "2026-08-25T00:00:00Z",
			gateLabel: "Force push",
			command: `git push --force origin main ${"x".repeat(100)}`,
			verdict: "block",
			reason: "history rewrite was not requested",
		});
		assert.equal(item.value, "d1");
		assert.ok(item.label.length <= 70);
		assert.ok(item.label.endsWith("…"));
		assert.equal(item.description, "Force push · block · history rewrite was not requested");
	});
});
